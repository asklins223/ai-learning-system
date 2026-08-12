import { UpdateStateMachine, type UpdateState } from "./update-state.ts";

const UPDATE_EVENTS = [
  "checking-for-update",
  "update-available",
  "update-not-available",
  "download-progress",
  "update-downloaded",
  "error",
] as const;

type UpdaterEventName = (typeof UPDATE_EVENTS)[number];

/** Minimal adapter so the state/rollback contract is testable without Electron. */
export interface UpdateDriverV1 {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  setFeedURL(feedUrl: string): void;
  on(event: UpdaterEventName, listener: (...args: never[]) => void): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateLoggerV1 {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface UpdateRuntimeOptionsV1 {
  feedUrl: string | null;
  runningVersion: string;
  driver: UpdateDriverV1;
  logger?: UpdateLoggerV1;
  /** Only enabled by local tests; production feeds must be HTTPS. */
  allowInsecureLocalFeed?: boolean;
  /** 状态推进回调（托盘/UI 据此刷新：ready 后展示“安装更新”入口）。 */
  onStateChange?: (state: UpdateState) => void;
}

export interface UpdateRuntimeV1 {
  readonly machine: UpdateStateMachine;
  readonly enabled: boolean;
  state(): UpdateState;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): UpdateState;
}

function asVersion(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const version = (value as { version?: unknown }).version;
  return typeof version === "string" && version.length <= 64 ? version : undefined;
}

function asErrorCode(value: unknown): string {
  if (value && typeof value === "object") {
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) return code;
  }
  return "UPDATE_ERROR";
}

function validFeedUrl(feedUrl: string, allowInsecureLocalFeed: boolean): boolean {
  try {
    const url = new URL(feedUrl);
    if (url.protocol === "https:") return true;
    return allowInsecureLocalFeed
      && url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

/**
 * Electron updater lifecycle with fail-closed configuration and rollback
 * observability.  A failed download/install never changes runningVersion;
 * callers must not call quitAndInstall until the ready phase is observed.
 */
export function createUpdateRuntime(options: UpdateRuntimeOptionsV1): UpdateRuntimeV1 {
  const machine = new UpdateStateMachine(options.feedUrl, options.runningVersion);
  const logger = options.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const feedUrl = options.feedUrl?.trim() || null;
  const notify = () => options.onStateChange?.(machine.snapshot());

  if (!feedUrl) {
    machine.startCheck();
    return {
      machine,
      enabled: false,
      state: () => machine.snapshot(),
      check: async () => machine.snapshot(),
      download: async () => machine.snapshot(),
      install: () => machine.snapshot(),
    };
  }

  if (!validFeedUrl(feedUrl, options.allowInsecureLocalFeed === true)) {
    machine.disable("UPDATE_FEED_INVALID");
    logger.warn("[updater] invalid update feed; updater disabled");
    return {
      machine,
      enabled: false,
      state: () => machine.snapshot(),
      check: async () => machine.snapshot(),
      download: async () => machine.snapshot(),
      install: () => machine.snapshot(),
    };
  }

  options.driver.autoDownload = false;
  options.driver.autoInstallOnAppQuit = false;
  options.driver.allowDowngrade = false;
  options.driver.setFeedURL(feedUrl);

  options.driver.on("checking-for-update", () => {
    machine.onEvent({ type: "checking" });
    notify();
  });
  options.driver.on("update-available", (info) => {
    machine.onEvent({ type: "update-available", version: asVersion(info) });
    notify();
    // 2026-08-12（更新闭环修复）：driver.autoDownload=false 时 electron-updater
    // 发现新版本后不会自动下载——此前 update-available 后永远停在 downloading。
    // 改为 runtime 侧自动触发下载；安装保持手动（ready 后由 UI 调 install()）。
    void options.driver.downloadUpdate().catch((error) => {
      machine.onEvent({ type: "error", code: asErrorCode(error) });
      notify();
      logger.error(`[updater] auto download failed: ${asErrorCode(error)}`);
    });
  });
  options.driver.on("update-not-available", () => {
    machine.onEvent({ type: "update-not-available" });
    notify();
  });
  options.driver.on("download-progress", () => {
    machine.onEvent({ type: "download-progress" });
    notify();
  });
  options.driver.on("update-downloaded", (info) => {
    machine.onEvent({ type: "update-downloaded", version: asVersion(info) });
    notify();
  });
  options.driver.on("error", (error) => {
    const code = asErrorCode(error);
    machine.onEvent({ type: "error", code });
    notify();
    // Do not log provider messages, URLs, response bodies, or credentials.
    logger.error(`[updater] update failed: ${code}`);
  });

  return {
    machine,
    enabled: true,
    state: () => machine.snapshot(),
    check: async () => {
      machine.startCheck();
      notify();
      try {
        await options.driver.checkForUpdates();
      } catch (error) {
        machine.onEvent({ type: "error", code: asErrorCode(error) });
        notify();
      }
      return machine.snapshot();
    },
    download: async () => {
      // 2026-08-12 review 备注：生产无显式调用方（update-available 后自动
      // 下载）。保留为公共 API 供未来手动重试路径；当前失败重试链路 =
      // error 态下用户再点托盘"检查更新" → check() → update-available →
      // 自动下载重试。
      if (machine.snapshot().phase !== "downloading") return machine.snapshot();
      try {
        await options.driver.downloadUpdate();
      } catch (error) {
        machine.onEvent({ type: "error", code: asErrorCode(error) });
        notify();
      }
      return machine.snapshot();
    },
    install: () => {
      const state = machine.snapshot();
      if (state.phase !== "ready") return state;
      options.driver.quitAndInstall(false, true);
      return state;
    },
  };
}
