/**
 * Electron main process for the AI Learn desktop app.
 *
 * Lifecycle (frontend-only):
 *  1. Start Next.js web server (utility process in packaged mode,
 *     child process in dev mode) on a dynamically-allocated port
 *  2. Wait for the web server to become healthy (with identity verification)
 *  3. Open the main BrowserWindow loading http://127.0.0.1:<port>
 *  4. On quit: stop the Next.js process
 *
 * The backend (Docker / API / Postgres / Worker) is managed externally.
 */

// Critical: ensure we run as Electron, not plain Node.
// This runs via esbuild banner before require("electron") — see esbuild.mjs.

import {
  app,
  BrowserWindow,
  dialog,
  Notification,
  powerMonitor,
  screen,
  session,
  shell,
  systemPreferences,
  type Tray,
} from "electron";
import { autoUpdater } from "electron-updater";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";
import {
  startWebServer,
  stopWebServer,
} from "./web-manager";
import { PET_IPC_CHANNELS } from "./ipc/contract";
import { registerPetIpc } from "./ipc/register-pet-ipc";
import { registerCompanionBridgeBroker } from "./ipc/companion-bridge-ipc";
import { registerAsrIpc } from "./ipc/register-asr-ipc";
import { asrManager } from "./voice/asr-manager";
import { PetHitTestController } from "./windows/pet-hit-test-controller";
import {
  createPetWindow,
} from "./windows/pet-window";
import { petRouteUrl } from "./windows/pet-window-contract";
import { PetWindowStateController } from "./windows/pet-window-state";
import { setupPetTray } from "./tray-runtime.ts";
import { DESKTOP_UPDATE_FEED_URL } from "./update-feed.ts";
import { isAllowedExternalUrl, isAllowedWindowNavigation } from "./windows/window-security";
import {
  displayFingerprint,
  getDefaultDevicePetPreferences,
  loadDevicePetPreferences,
  normalizeDevicePetPreferences,
  saveDevicePetPreferences,
  type DisplayGeometryV1,
} from "./persistence/device-pet-preferences";
import {
  desktopPetCapabilitiesV1Schema,
  desktopPetWindowStateV1Schema,
  type AllowedMainRouteV1,
  type DesktopLifecycleEventV1,
  type DesktopPetInteractionModeV1,
  type DesktopPetScaleV1,
  type PetBootstrapResultV1,
} from "@ailearn/shared";
import { createUpdateRuntime, type UpdateRuntimeV1 } from "./update-runtime.ts";
import { createSoakJsonlWriter, SoakRunner } from "./soak-runner.ts";
import { currentMainRoute } from "./main-route-path.ts";

// 2026-08-15（打包修复）：Electron 30+ 默认关闭 WebGPU。液态玻璃球语音视觉
//（LiquidOrb：桌宠语音岛 / 学习卡录音视觉）依赖 WebGPU；不加此开关时打包版
// 静默回退旧视觉（与 dev 浏览器不一致）。必须在 app ready 前调用。
app.commandLine.appendSwitch("enable-unsafe-webgpu");
// 部分驱动/环境还需显式启用 WebGPU feature（低风险，与上方开关配套）。
app.commandLine.appendSwitch("enable-features", "WebGPU");

// ─── Window management ──────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let petWindow: BrowserWindow | null = null;
let petState: PetWindowStateController | null = null;
let petHitTest: PetHitTestController | null = null;
let webBaseUrl: string | null = null;
let ipcCleanup: (() => void) | null = null;
let appQuitting = false;
let temporaryPetHidden = false;
const deviceSessionId = randomUUID();
let moveSaveTimer: ReturnType<typeof setTimeout> | null = null;
let updateRuntime: UpdateRuntimeV1 | null = null;
let soakRuntime: SoakRunner | null = null;
let petTray: ReturnType<typeof setupPetTray> = null;

const desktopPetSpikeEnabled = process.env.AILEARN_DESKTOP_PET_SPIKE === "true";

function schedulePetWindowPositionSave(delayMs = 250): void {
  if (moveSaveTimer) clearTimeout(moveSaveTimer);
  moveSaveTimer = setTimeout(() => {
    moveSaveTimer = null;
    if (!petState || !petWindow || petWindow.isDestroyed()) return;
    const bounds = petWindow.getContentBounds();
    petState.setWindowPosition(bounds.x, bounds.y);
    broadcastWindowState();
  }, delayMs);
}

function currentDisplayGeometry(display: Electron.Display): DisplayGeometryV1 {
  const value = {
    id: String(display.id),
    scaleFactor: display.scaleFactor,
    workArea: {
      x: display.workArea.x,
      y: display.workArea.y,
      width: display.workArea.width,
      height: display.workArea.height,
    },
  };
  return { ...value, fingerprint: displayFingerprint(value) };
}

function displayProvider() {
  return {
    getAllDisplays: () => screen.getAllDisplays().map(currentDisplayGeometry),
    getPrimaryDisplay: () => currentDisplayGeometry(screen.getPrimaryDisplay()),
  };
}

function shouldKeepMainWindow(): boolean {
  return desktopPetSpikeEnabled || petState?.petModeEnabled === true;
}

function broadcastWindowState(): void {
  if (!petState) return;
  const state = desktopPetWindowStateV1Schema.parse(petState.getState());
  for (const window of [mainWindow, petWindow]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send(PET_IPC_CHANNELS.windowStateChanged, state);
    }
  }
}

function broadcastLifecycle(event: DesktopLifecycleEventV1): void {
  for (const window of [mainWindow, petWindow]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send(PET_IPC_CHANNELS.lifecycleEvent, event);
    }
  }
}

function metricForWindow(metrics: Electron.ProcessMetric[], window: BrowserWindow | null): Electron.ProcessMetric | undefined {
  if (!window || window.isDestroyed()) return undefined;
  const pid = window.webContents.getOSProcessId();
  return metrics.find((metric) => metric.pid === pid);
}

interface RendererSoakMetricsV1 {
  mediaTrackCount?: number;
  audioContextCount?: number;
  sseConnectionCount?: number;
  timerCount?: number;
  recentErrorCount?: number;
}

async function rendererSoakMetrics(window: BrowserWindow | null): Promise<RendererSoakMetricsV1> {
  if (!window || window.isDestroyed()) return {};
  try {
    return await window.webContents.executeJavaScript(`(() => {
      const value = globalThis.__AILEARN_SOAK_METRICS__;
      if (!value || typeof value !== "object") return {};
      const result = {};
      for (const key of ["mediaTrackCount", "audioContextCount", "sseConnectionCount", "timerCount", "recentErrorCount"]) {
        const number = value[key];
        if (typeof number === "number" && Number.isFinite(number) && number >= 0) result[key] = number;
      }
      return result;
    })()`, true) as RendererSoakMetricsV1;
  } catch {
    return {};
  }
}

function createSoakRuntimeIfConfigured(): SoakRunner | null {
  const logPath = process.env.AILEARN_SOAK_LOG_PATH?.trim();
  if (!logPath) return null;
  const rawInterval = process.env.AILEARN_SOAK_INTERVAL_MS?.trim();
  const configuredInterval = rawInterval ? Number(rawInterval) : Number.NaN;
  const intervalMs = Number.isSafeInteger(configuredInterval) && configuredInterval > 0
    ? configuredInterval
    : undefined;
  const writer = createSoakJsonlWriter(logPath);
  const runner = new SoakRunner({
    intervalMs,
    collect: async () => {
      const metrics = app.getAppMetrics();
      const browser = metrics.find((metric) => metric.type === "Browser");
      const mainRenderer = metricForWindow(metrics, mainWindow);
      const petRenderer = metricForWindow(metrics, petWindow);
      const [mainRuntime, petRuntime] = await Promise.all([
        rendererSoakMetrics(mainWindow),
        rendererSoakMetrics(petWindow),
      ]);
      const gpuCount = metrics.filter((metric) => metric.type === "GPU").length;
      const petPosition = petWindow && !petWindow.isDestroyed() ? petWindow.getPosition() : undefined;
      return {
        electron_main_cpu: browser?.cpu.percentCPUUsage,
        main_renderer_cpu: mainRenderer?.cpu.percentCPUUsage,
        pet_renderer_cpu: petRenderer?.cpu.percentCPUUsage,
        electron_main_memory: process.memoryUsage().rss,
        gpu_process: gpuCount,
        window_count: BrowserWindow.getAllWindows().length,
        media_track_count: Math.max(mainRuntime.mediaTrackCount ?? 0, petRuntime.mediaTrackCount ?? 0),
        audio_context_count: Math.max(mainRuntime.audioContextCount ?? 0, petRuntime.audioContextCount ?? 0),
        sse_connection_count: Math.max(mainRuntime.sseConnectionCount ?? 0, petRuntime.sseConnectionCount ?? 0),
        timer_count: Math.max(mainRuntime.timerCount ?? 0, petRuntime.timerCount ?? 0),
        recent_error_count: Math.max(mainRuntime.recentErrorCount ?? 0, petRuntime.recentErrorCount ?? 0),
        pet_position_x: petPosition?.[0],
        pet_position_y: petPosition?.[1],
        display_fingerprint: petState?.getDisplayFingerprint(),
        click_through: petHitTest?.isClickThrough ? "click_through_on" : "click_through_off",
        // API/Worker/DB counters are intentionally left absent unless a
        // companion health collector is configured; never infer them from a
        // stale process list.
        api_restart_count: undefined,
        worker_restart_count: undefined,
        db_connection_count: undefined,
        job_backlog: undefined,
      };
    },
    write: writer,
  });
  runner.start();
  logger.info("[soak] enabled; redacted snapshots are written to the configured soak path");
  return runner;
}

function focusMainWindow(route?: AllowedMainRouteV1): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (route && webBaseUrl) {
    const target = new URL(currentMainRoute(route), webBaseUrl).toString();
    void mainWindow.loadURL(target).catch((error: unknown) => {
      logger.error("[pet] Failed to navigate Main Window:", error);
    });
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function focusMainLogin(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (webBaseUrl) {
    void mainWindow.loadURL(new URL("/login", webBaseUrl).toString()).catch((error: unknown) => {
      logger.error("[pet] Failed to navigate Main Window to login:", error);
    });
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function refreshPetTrayMenu(): void {
  if (petTray && typeof (petTray as Tray & { refreshPetTrayMenu?: () => void }).refreshPetTrayMenu === "function") {
    (petTray as Tray & { refreshPetTrayMenu: () => void }).refreshPetTrayMenu();
  }
}

/** 恢复被“暂时隐藏”的桌宠（托盘菜单与隐藏通知点击共用）。 */
function showTemporarilyHiddenPet(): void {
  temporaryPetHidden = false;
  petState?.setTemporaryHidden(false);
  petWindow?.showInactive();
  petHitTest?.start();
  broadcastLifecycle({ version: 1, kind: "system_resumed" });
  broadcastWindowState();
  refreshPetTrayMenu();
}

/**
 * 暂时隐藏后发系统通知，告知恢复途径（菜单栏桌宠图标）。
 * 通知不可用/无权限时静默失败——隐藏本身不受影响。
 */
function notifyPetTemporarilyHidden(): void {
  if (!Notification.isSupported()) return;
  try {
    const notice = new Notification({
      title: "桌宠已暂时隐藏",
      body: "点击菜单栏的桌宠图标即可恢复显示。",
    });
    notice.on("click", () => showTemporarilyHiddenPet());
    notice.show();
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, "pet hide notification failed");
  }
}

function destroyPetWindow(): void {
  // 2026-08-12：记录销毁调用栈（排查"登录后 pet 窗口消失"）。
  logger.warn("[app] destroyPetWindow called from:", new Error().stack?.split("\n").slice(2, 5).join(" | "));
  petHitTest?.stop();
  petHitTest = null;
  petState = null;
  temporaryPetHidden = false;
  if (petWindow && !petWindow.isDestroyed()) petWindow.destroy();
  petWindow = null;
  broadcastWindowState();
  refreshPetTrayMenu();
}

function persistPetMode(enabled: boolean): void {
  const primary = displayProvider().getPrimaryDisplay();
  const existing = loadDevicePetPreferences(app.getPath("userData"));
  const preferences = normalizeDevicePetPreferences(existing ?? getDefaultDevicePetPreferences(primary), primary);
  saveDevicePetPreferences(app.getPath("userData"), { ...preferences, petModeEnabled: enabled });
}

function createPetWindowForCurrentServer(): void {
  if (petWindow || !webBaseUrl) return;

  const preloadPath = path.join(__dirname, "pet-preload.cjs");
  // §11：renderer crash 后 reload 一次恢复；导航重新建立后重置允许再次 reload。
  let rendererCrashReloaded = false;
  const created = createPetWindow({
    baseUrl: webBaseUrl,
    preload: preloadPath,
    alwaysOnTop: true,
    onClosed: () => {
      petHitTest?.stop();
      petWindow = null;
      petHitTest = null;
      petState = null;
    },
  });
  petWindow = created;
  petState = new PetWindowStateController({
    userDataPath: app.getPath("userData"),
    displays: displayProvider(),
    window: created,
    spikeEnabled: desktopPetSpikeEnabled,
  });
  petState.applySavedPosition();
  petHitTest = new PetHitTestController(
    created,
    () => screen.getCursorScreenPoint(),
    // §9.2：Linux 不假设 forward:true 可用，由光标轮询恢复交互。
    { forward: process.platform !== "linux" },
  );
  petHitTest.start();

  // §11：renderer reload/crash 后组件内存 revision 从 1 重新计数，旧几何
  // 必须复位，否则 registerGeometry 会永久拒绝新几何（点击穿透错位）。
  created.webContents.on("did-start-navigation", () => {
    petHitTest?.resetGeometry();
    rendererCrashReloaded = false;
  });
  // 2026-08-13（Live2D 调试）：渲染进程 console/异常转发到主进程日志——
  // 桌宠窗口的 [Live2D]/WebGL 错误可在此查看（打包版无法直连 CDP 时）。
  created.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      logger.warn(`[pet:renderer] ${message} (${sourceId}:${line})`);
    }
  });
  created.webContents.on("render-process-gone", (_event, details) => {
    petHitTest?.resetGeometry();
    // §11：crash/oom/异常退出后 reload 一次恢复（避免崩溃循环）；
    // clean-exit 是正常关闭，不 reload。
    if (details.reason !== "clean-exit" && !rendererCrashReloaded) {
      rendererCrashReloaded = true;
      created.webContents.reload();
    }
  });

  created.on("move", () => {
    if (!petState || petState.currentPreferences.locked) return;
    // Custom drag emits many move events. Persisting JSON and broadcasting on
    // every frame causes visible hitching, so commit once after drag settles.
    if (petState.getState().interactionMode === "dragging") return;
    schedulePetWindowPositionSave();
  });
  created.on("show", broadcastWindowState);
  created.on("hide", broadcastWindowState);
  // 2026-08-11（性能专项）：窗口被完全遮挡（全屏/切桌面等）时暂停 pet 渲染
  //（renderer 侧 rAF/PIXI ticker 停转），避免 60fps 空转 GPU/CPU；解除遮挡恢复。
  // Electron 'occluded' 事件 macOS/Windows 支持，Linux 无该事件（不影响其他平台）。
  // 注意：electron.d.ts 类型缺 occluded（运行时存在），用显式签名绕开。
  (created as unknown as {
    on(event: "occluded", listener: (occluded: boolean) => void): unknown;
  }).on("occluded", (occluded) => {
    broadcastLifecycle(occluded ? { version: 1, kind: "occluded" } : { version: 1, kind: "unoccluded" });
  });
}

function handlePetBootstrap(result: PetBootstrapResultV1): void {
  if (result.kind === "ready") {
    if (!temporaryPetHidden && petWindow && !petWindow.isDestroyed()) {
      petWindow.showInactive();
      petHitTest?.tick();
      broadcastWindowState();
    }
    return;
  }
  if (result.kind === "auth_required") {
    petWindow?.hide();
    focusMainLogin();
    return;
  }
  if (result.kind === "global_off") {
    // §3.3/§13.3：账号 global_off → 销毁 Pet Window，并把本机 petModeEnabled
    // 写回 false，避免每次启动重复创建 hidden Pet → bootstrap → 销毁。
    petState?.setPetModeEnabled(false);
    destroyPetWindow();
    return;
  }
  petWindow?.hide();
  focusMainWindow();
}

function createMainWindow(baseUrl: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    // Treat the configured bounds as renderer bounds. The web shell has
    // viewport-locked workbenches, so subtracting native chrome from these
    // dimensions would create a different layout in the packaged app.
    useContentSize: true,
    show: false,
    title: "AI Learn",
    // Keep the native macOS traffic lights while letting the existing web
    // headers become the title bar. titleBarOverlay exposes the
    // env(titlebar-area-*) safe-area variables used by the renderer.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          titleBarOverlay: { height: 56 },
        }
      : {}),
    // Match the web app's canvas color so there's no flash of dark
    // before the CSS variables load.
    backgroundColor: "#f5f3ee",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // §7.2：打包后两窗都关闭 DevTools（Pet 窗在 pet-window-contract 已关）。
      devTools: !app.isPackaged,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });

  const expectedOrigin = new URL(baseUrl).origin;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    try {
      if (!isAllowedWindowNavigation(url, expectedOrigin, "main")) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  // 与 pet 窗口一致：HTTP 302 跨 origin 重定向同样受导航限制（§8）。
  win.webContents.on("will-redirect", (event, url) => {
    try {
      if (!isAllowedWindowNavigation(url, expectedOrigin, "main")) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  // 2026-08-12（登录页小窗口修复配套）：主窗口从 /login 进入工作区（登录
  // 成功或会话恢复）时，pet 窗口可能仍停在 /login 隐藏态（见 pet-window
  // ready-to-show：非 pet 路由不显示）。此时把 pet 窗口重新加载到 pet 路由，
  // 登录完成后桌宠自动出现，无需手动导航。
  // 注意：Next App Router 登录后是 SPA 客户端跳转（router.replace("/")），
  // 不触发 did-navigate（新文档导航），必须同时监听 did-navigate-in-page。
  const reloadPetAfterMainLogin = (_event: Electron.Event, url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== expectedOrigin || parsed.pathname === "/login") return;
      // P1（文档 16 §8.1.1）：注册/重新登录后 Pet 窗口不存在则主动创建——
      // 全新安装默认偏好下桌宠自动出现；用户显式关闭过 Pet
      // （petModeEnabled=false）则不强制创建。
      if (!petWindow || petWindow.isDestroyed()) {
        const preferences = loadDevicePetPreferences(app.getPath("userData"));
        if (preferences?.petModeEnabled !== false) {
          createPetWindowForCurrentServer();
        }
        return;
      }
      if (petWindow.isVisible()) return;
      void petWindow.loadURL(petRouteUrl(baseUrl)).catch((error: unknown) => {
        logger.warn("[pet] failed to reload pet window after login:", error);
      });
    } catch {
      // 忽略非法 URL。
    }
  };
  win.webContents.on("did-navigate", reloadPetAfterMainLogin);
  win.webContents.on("did-navigate-in-page", reloadPetAfterMainLogin);

  win.on("close", (event) => {
    if (!appQuitting && shouldKeepMainWindow()) {
      event.preventDefault();
      win.hide();
    }
  });

  return win;
}

// ─── Startup sequence ───────────────────────────────────────────────

async function startupSequence(): Promise<void> {
  try {
    // 1. Start the Next.js web server.
    //    Returns the dynamically-allocated port (avoids Docker conflicts
    //    on 3000). Uses utilityProcess in packaged mode (no Dock icon).
    logger.info("[startup] Starting Next.js web server…");
    const port = await startWebServer((line) => {
      logger.info(`[web] ${line.trimEnd()}`);
    });
    if (port === null) {
      showWebError();
      return;
    }

    // 2. Open the main window. Main and Pet share this exact dynamic origin
    // and Electron's default session partition.
    logger.info(`[startup] Web ready on port ${port} — opening main window.`);
    // 2026-08-12 修复：必须与 Next dev server 的资源 origin 同源。此前用
    // 127.0.0.1，而 Next dev 的 /_next/*（CSS/JS）origin 是 localhost →
    // Pet/Main 页面 HTML 加载成功但静态资源被 "Cross origin request
    // detected" 拦截 → 页面裸渲染（无样式）+ JS 不执行（角色不渲染）。
    webBaseUrl = `http://localhost:${port}`;
    // P3：点按切换式半双工语音的麦克风权限（Owner 2026-08-11 批准 P3）。
    // 只允许 trusted origin（本地 web 服务）的 media 权限；renderer 的
    // voice.toggle_requested → requesting_permission 作为 active-gesture 门，
    // 主进程按 permission 类型 + origin 白名单 fail closed。
    const trustedOrigin = new URL(webBaseUrl).origin;
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      let originMatches = false;
      let isPetRoute = false;
      try {
        const url = new URL(wc.getURL());
        originMatches = url.origin === trustedOrigin;
        // §7.2：media 权限只允许本地可信 Pet route 发起（同 origin 的 Main
        // 任意页面不得静默获得麦克风），且必须带 surface=electron 标识。
        isPetRoute = url.pathname === "/companion/pet"
          && url.searchParams.get("surface") === "electron";
      } catch {
        originMatches = false;
        isPetRoute = false;
      }
      // §7.2：只授权 microphone，拒绝 camera——Electron 的 media 权限涵盖
      // 音视频，用 details.mediaTypes（仅 MediaAccessPermissionRequest 有）
      // 收窄（含 video 即拒绝）。
      const mediaTypes =
        details && "mediaTypes" in details
          ? (details as { mediaTypes?: Array<"video" | "audio" | "unknown"> }).mediaTypes ?? []
          : [];
      const isMicrophoneOnly = permission === "media" && !mediaTypes.includes("video");
      const allowed = isMicrophoneOnly && originMatches && isPetRoute;
      callback(allowed);
    });
    mainWindow = createMainWindow(webBaseUrl);
    // 冷启动修复：ready 前到达的深链在此补投（主窗口已就绪）。
    flushPendingDeepLink();
    const petIpcCleanup = registerPetIpc({
      origin: new URL(webBaseUrl).origin,
      getPetWindow: () => petWindow,
      getMainWindow: () => mainWindow,
      getCapabilities: () => desktopPetCapabilitiesV1Schema.parse({
        version: 1,
        platform: process.platform === "darwin" || process.platform === "win32" || process.platform === "linux"
          ? process.platform
          : "linux",
        transparentWindow: true,
        forwardedClickThrough: process.platform !== "linux",
        showInactive: true,
        contentProtection: false,
      }),
      getDeviceSessionId: () => deviceSessionId,
      getWindowState: () => {
        if (!petState) throw new Error("PET_WINDOW_NOT_READY");
        return petState.getState();
      },
      onHitGeometry: (input) => petHitTest?.registerGeometry(input),
      onInteractionMode: (mode: DesktopPetInteractionModeV1) => {
        const wasDragging = petState?.getState().interactionMode === "dragging";
        if (mode === "dragging" && moveSaveTimer) {
          clearTimeout(moveSaveTimer);
          moveSaveTimer = null;
        }
        const changed = petState?.setInteractionMode(mode) ?? false;
        petHitTest?.setInteractionMode(mode);
        if (wasDragging && mode !== "dragging") schedulePetWindowPositionSave(0);
        // 相同 mode 重复上报不广播（避免无意义的窗口状态事件风暴）。
        if (changed) broadcastWindowState();
      },
      onDragBy: (deltaX: number, deltaY: number) => {
        if (!petWindow || petWindow.isDestroyed() || !petState) return;
        // 拖动路径每帧触发：getState() 会执行 getContentBounds + 两遍
        // getAllDisplays，直接用偏好快照读 locked 避免拖动卡顿。
        if (petState.currentPreferences.locked) return;
        const [x, y] = petWindow.getPosition();
        const nextX = Math.round(x + deltaX);
        const nextY = Math.round(y + deltaY);
        petWindow.setPosition(nextX, nextY, false);
      },
      requestTextInputFocus: () => {
        petWindow?.setFocusable(true);
        // 2026-08-12+（15a-D）：去掉冗余 show()——requestTextInputFocus 只发生
        // 在用户已与可见桌宠窗口交互时，窗口必然 visible；对已显示窗口再调
        // show() 与 showInactive 同类，可能触发 transparent 窗口 GPU 合成重置
        // （闪烁）。focus() 已足够把键盘焦点带进 pet 窗口。
        petWindow?.focus();
        petState?.setInteractionMode("text_input");
        petHitTest?.setInteractionMode("text_input");
        broadcastWindowState();
      },
      // §10.1：composer 关闭后释放焦点（blur + showInactive），避免后续键盘
      // 输入误入 pet 窗口；窗口保持可见不隐藏。
      // 2026-08-12（窗口闪烁修复）：去掉 showInactive——窗口本就可见未
      // 隐藏，transparent 窗口上对已显示窗口再调 showInactive 会触发 GPU
      // 合成重置，表现为"整个窗口消失再出现"的闪烁。
      // 2026-08-12+（15a-D 修正 2）：**去掉 blur()**——macOS 上 pet 窗口失焦
      // 后系统把焦点回落到最近激活的窗口（主应用窗口），导致关闭输入面板时
      // 主窗口被前置聚焦（用户反馈），且焦点切换本身触发 transparent 窗口
      // 合成重排（闪烁同源）。关闭面板后 pet 页面无聚焦输入元素，保持焦点
      // 无害；用户点击其他窗口时焦点自然切换。
      releaseTextInputFocus: () => {
        logger.info({ channel: PET_IPC_CHANNELS.releaseTextInputFocus }, "pet ipc: composer closed, keep pet focus");
        broadcastWindowState();
      },
      setPetModeEnabled: (enabled) => {
        persistPetMode(enabled);
        if (enabled) {
          temporaryPetHidden = false;
          createPetWindowForCurrentServer();
        } else {
          destroyPetWindow();
          focusMainWindow();
        }
        broadcastWindowState();
      },
      getPetModeEnabled: () => {
        const primary = displayProvider().getPrimaryDisplay();
        const existing = loadDevicePetPreferences(app.getPath("userData"));
        const preferences = normalizeDevicePetPreferences(existing ?? getDefaultDevicePetPreferences(primary), primary);
        return preferences.petModeEnabled;
      },
      setAlwaysOnTop: (enabled) => {
        petState?.setAlwaysOnTop(enabled);
        broadcastWindowState();
      },
      setLocked: (locked) => {
        petState?.setLocked(locked);
        broadcastWindowState();
      },
      setPetScale: (scale: DesktopPetScaleV1) => {
        petState?.setPetScale(scale);
        broadcastWindowState();
      },
      setPrivacyMode: (enabled) => {
        petState?.setPrivacyMode(enabled);
        broadcastWindowState();
      },
      moveToSafePosition: () => {
        petState?.moveToSafePosition();
        broadcastWindowState();
      },
      openMainRoute: (route) => focusMainWindow(route),
      reportBootstrap: handlePetBootstrap,
      hidePet: () => {
        temporaryPetHidden = true;
        petState?.setTemporaryHidden(true);
        petWindow?.hide();
        // 暂时隐藏后停止 hit-test 轮询，避免 33ms 定时器空转。
        petHitTest?.stop();
        focusMainWindow();
        broadcastLifecycle({ version: 1, kind: "temporary_hidden" });
        broadcastWindowState();
        refreshPetTrayMenu();
        // 2026-08-12：隐藏后发系统通知，避免用户找不到恢复入口。
        notifyPetTemporarilyHidden();
      },
      openExternal: (url) => {
        try {
          const parsed = new URL(url);
          if (isAllowedExternalUrl(parsed.toString())) void shell.openExternal(parsed.toString());
        } catch {
          // Ignore invalid/untrusted external URLs.
        }
      },
      quit: () => {
        logger.warn("[navguard] renderer requested quit — quitting");
        app.quit();
      },
    });
    // P6 §13：本地 SenseVoice ASR utility process IPC（模型路径由
    // ASR_SENSEVOICE_MODEL_DIR env 或未来受信配置解析，renderer 不可指定）。
    const asrCleanup = registerAsrIpc({
      origin: new URL(webBaseUrl).origin,
      getPetWindow: () => petWindow,
      getMainWindow: () => mainWindow,
      getModelConfig: () => null, // 仅 env 解析；未来可接设置存储
    });
    // P5：Main ↔ Pet Bridge V2 broker（context/event/command relay；sender 校验）。
    const bridgeCleanup = registerCompanionBridgeBroker({
      origin: new URL(webBaseUrl).origin,
      getMainWindow: () => mainWindow,
      getPetWindow: () => petWindow,
    });
    ipcCleanup = () => {
      petIpcCleanup();
      asrCleanup();
      bridgeCleanup();
      void asrManager.dispose();
    };
    // BUG-49 修复：单独处理 loadURL 失败，区分页面加载错误和其他启动错误。
    try {
      await mainWindow.loadURL(webBaseUrl);
    } catch (loadErr) {
      logger.error("[startup] Failed to load web page:", loadErr);
      showWebError(
        `前端页面加载失败: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}\n` +
        "Web 服务已启动但页面无法加载，可能是 SSR 编译错误或运行时异常。"
      );
      return;
    }

    const persisted = loadDevicePetPreferences(app.getPath("userData"));
    if (desktopPetSpikeEnabled || persisted?.petModeEnabled === true) {
      createPetWindowForCurrentServer();
    }

  } catch (err) {
    logger.error("[startup] Unexpected error:", err);
    showWebError(err instanceof Error ? err.message : String(err));
  }
}

// ─── Error dialogs ──────────────────────────────────────────────────

function showWebError(detail?: string): void {
  void dialog.showMessageBox({
    type: "error",
    title: "前端启动失败",
    message: "无法启动 Next.js 前端服务",
    detail:
      (detail ? `${detail}\n\n` : "") +
      "可能原因:\n" +
      "• apps/web 目录下未安装依赖 (npm install)\n" +
      "• 端口 3000–3019 均被其他程序占用\n" +
      "• Node.js 运行时不可用\n\n" +
      "请查看日志文件获取详细信息，然后重试。",
    buttons: ["退出"],
  }).then(() => {
    logger.warn("[app] web-startup-failed dialog dismissed — quitting");
    app.quit();
  });
}

// ─── App lifecycle ──────────────────────────────────────────────────

// 冷启动深链缓存（模块级：ready 前到达的 ailearn:// URL 先存这里，
// 主窗口就绪后由 flushPendingDeepLink 补投——见 handleDeepLink）。
let pendingDeepLink: string | null = null;

// ailearn:// 深链处理（模块级：open-url 事件在 ready 前注册，处理函数
// 不能被 else 块局部作用域困住——startupSequence 在窗口就绪后补投）。
const MAX_DEEP_LINK_LENGTH = 4096;
const handleDeepLink = (url: string): void => {
  try {
    // 2026-08-12：超长深链拒绝（防巨型日志行/后续路由跳转的注入面）
    if (typeof url !== "string" || url.length > MAX_DEEP_LINK_LENGTH) {
      logger.warn({ deepLink: String(url).slice(0, 80) }, "deep link too long; ignored");
      return;
    }
    const parsed = new URL(url);
    if (parsed.protocol !== "ailearn:") return;
    logger.info({ deepLink: `${parsed.protocol}//${parsed.host}${parsed.pathname}` }, "deep link received");
    if (!mainWindow || mainWindow.isDestroyed()) {
      // 冷启动修复：主窗口未就绪时缓存，startupSequence 创建窗口后补投。
      pendingDeepLink = url;
      return;
    }
    focusMainWindow();
  } catch {
    logger.warn({ deepLink: String(url).slice(0, 80) }, "invalid deep link");
  }
};

const flushPendingDeepLink = (): void => {
  if (pendingDeepLink) {
    const url = pendingDeepLink;
    pendingDeepLink = null;
    handleDeepLink(url);
  }
};

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  logger.warn("[app] single-instance lock denied — another instance is running, quitting");
  app.quit();
} else {
  // 2026-08-11：ailearn:// 深链——打开/唤醒应用（未来可扩展对话/路由跳转）。
  // macOS 走 open-url 事件；Windows/Linux 二次启动时深链在 second-instance argv。
  app.on("second-instance", (_event, argv) => {
    const deepLink = argv.find((arg) => typeof arg === "string" && arg.startsWith("ailearn://"));
    if (deepLink) handleDeepLink(deepLink);
    focusMainWindow();
  });
  // macOS：open-url 在 ready 前触发，需提前注册。
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  // 2026-08-13（调试通道）：开发/联调时开放 CDP（9222）。生产关闭——
  // 仅当环境变量 AILEARN_DEV_CDP=1 时启用，避免默认暴露调试端口。
  if (process.env.AILEARN_DEV_CDP === "1") {
    app.commandLine.appendSwitch("remote-debugging-port", "9222");
  }

  app.whenReady().then(async () => {
    // 2026-08-11：打包后注册 ailearn:// 默认协议客户端（dev 不注册，避免
    // 污染系统协议绑定；dev 验证深链用 `open -a Electron "ailearn://open"`）。
    if (app.isPackaged) {
      try {
        app.setAsDefaultProtocolClient("ailearn");
      } catch (error) {
        logger.warn({ err: error }, "failed to register ailearn:// protocol");
      }
    }
    logger.info(`[app] AI Learn Desktop v${app.getVersion()} starting…`);
    // 2026-08-12（麦克风权限）：只打印状态，**不在启动时 askForMediaAccess**
    // ——app 未激活（后台）时请求会静默返回 false，并把 TCC 状态标记成
    // denied，导致之后前台请求也不再弹窗。权限由 renderer 点语音按钮时经
    // ensurePermission IPC 触发（见 register-asr-ipc.ts）。
    try {
      const micStatus = systemPreferences.getMediaAccessStatus("microphone");
      logger.info(`[app] microphone permission status: ${micStatus}`);
    } catch (error) {
      logger.warn("[app] failed to read microphone permission status:", error);
    }
    const configuredUpdateFeed = process.env.AILEARN_UPDATE_FEED?.trim() || DESKTOP_UPDATE_FEED_URL;
    updateRuntime = createUpdateRuntime({
      feedUrl: configuredUpdateFeed,
      runningVersion: app.getVersion(),
      driver: autoUpdater,
      logger: {
        info: (message) => logger.info(message),
        warn: (message) => logger.warn(message),
        error: (message) => logger.error(message),
      },
      allowInsecureLocalFeed: process.env.NODE_ENV === "development"
        && process.env.AILEARN_ALLOW_INSECURE_UPDATE_FEED === "true",
      // 2026-08-12：状态推进时刷新托盘（ready 后“检查更新”变为“安装更新 vX”）
      onStateChange: () => refreshPetTrayMenu(),
    });
    // 2026-08-11 修复：此前需 AILEARN_AUTO_UPDATE_CHECK === "true" 才检查——
    // 生产未设置该 env 时永不检查更新。改为默认开启，仅显式 "false" 关闭
    //（dev 本地 feed 需 AILEARN_ALLOW_INSECURE_UPDATE_FEED=true 且检查失败静默）。
    if (updateRuntime.enabled && process.env.AILEARN_AUTO_UPDATE_CHECK !== "false") {
      void updateRuntime.check();
    }
    soakRuntime = createSoakRuntimeIfConfigured();
    // P6 顺序 8：tray/menu bar（失败安全；无头环境返回 null 不阻塞启动）
    petTray = setupPetTray({
      getPetVisible: () => Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible()),
      // 2026-08-12：托盘菜单随更新状态切换（downloading 时菜单同步）
      getUpdateState: () => (updateRuntime?.enabled ? updateRuntime.state() : undefined),
      onTogglePet: () => {
        if (!petWindow || petWindow.isDestroyed()) {
          // Tray is the first-run activation path when no preference exists.
          // Persist the choice so the Pet is available after restart.
          persistPetMode(true);
          createPetWindowForCurrentServer();
          return;
        }
        if (petWindow.isVisible()) {
          temporaryPetHidden = true;
          petState?.setTemporaryHidden(true);
          petWindow.hide();
          petHitTest?.stop();
          broadcastLifecycle({ version: 1, kind: "temporary_hidden" });
        } else {
          showTemporarilyHiddenPet();
        }
        broadcastWindowState();
        refreshPetTrayMenu();
      },
      onOpenMain: () => focusMainWindow(),
      // 2026-08-11：托盘"检查更新"入口；2026-08-12：ready 后同一入口执行安装
      onCheckUpdate: () => {
        if (!updateRuntime?.enabled) {
          // 2026-08-12：禁用/失败时不再静默——日志说明原因，托盘菜单可读状态
          logger.warn(
            { errorCode: updateRuntime?.state().errorCode },
            "update check ignored: updater disabled (feed not configured or invalid)",
          );
          return;
        }
        const st = updateRuntime.state();
        if (st.phase === "ready") {
          updateRuntime.install();
        } else {
          void updateRuntime.check();
        }
      },
      // 打包后图标在 resources/trayTemplate.png（extraResources）；dev 用仓库 build 目录。
      // 2026-08-13：状态栏专用 16px Template 图标（此前用 1024px 应用图标 → 巨大贴图）。
      iconPath: require("node:path").join(
        app.isPackaged ? process.resourcesPath : require("node:path").resolve(__dirname, "../../build"),
        "trayTemplate.png",
      ),
    });
    startupSequence().catch((err) => {
      logger.error("[app] Startup sequence crashed:", err);
    });
  });

  app.on("window-all-closed", () => {
    // 2026-08-11：macOS 关闭所有窗口不退出（常驻惯例，dock/菜单可重开）
    if (process.platform === "darwin") {
      logger.info("[app] window-all-closed on darwin — keep running (petWindow=" + !!petWindow + ")");
      return;
    }
    if (!appQuitting && (!petWindow || petWindow.isDestroyed())) app.quit();
  });

  app.on("activate", () => {
    focusMainWindow();
  });

  app.whenReady().then(() => {
    const sendDisplayChange = () => {
      petState?.applySavedPosition();
      broadcastLifecycle({ version: 1, kind: "displays_changed" });
      broadcastWindowState();
    };
    // display-metrics-changed 在缩放/分辨率连续变化时会高频触发，防抖合并；
    // 显示器增删必须立即响应。
    let displayChangeTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleDisplayChange = () => {
      if (displayChangeTimer) return;
      displayChangeTimer = setTimeout(() => {
        displayChangeTimer = null;
        sendDisplayChange();
      }, 250);
    };
    screen.on("display-added", sendDisplayChange);
    screen.on("display-removed", sendDisplayChange);
    screen.on("display-metrics-changed", scheduleDisplayChange);
    powerMonitor.on("suspend", () => {
      petWindow?.hide();
      petHitTest?.stop();
      broadcastLifecycle({ version: 1, kind: "system_suspended", reason: "sleep" });
    });
    powerMonitor.on("lock-screen", () => {
      petWindow?.hide();
      petHitTest?.stop();
      broadcastLifecycle({ version: 1, kind: "system_suspended", reason: "screen_locked" });
    });
    powerMonitor.on("resume", () => {
      broadcastLifecycle({ version: 1, kind: "system_resumed" });
      if (petWindow && !temporaryPetHidden) {
        petHitTest?.start();
        petWindow.showInactive();
        broadcastWindowState();
      }
    });
    powerMonitor.on("unlock-screen", () => {
      broadcastLifecycle({ version: 1, kind: "system_resumed" });
      if (petWindow && !temporaryPetHidden) {
        petHitTest?.start();
        petWindow.showInactive();
        broadcastWindowState();
      }
    });
  });

  // BUG-06 修复：添加 shuttingDown 标志防止重复执行退出逻辑
  let shuttingDown = false;
  app.on("before-quit", async (event) => {
    // 2026-08-12：记录 quit 来源（调试"启动后自动退出"）。event 无 reason 字段，
    // 靠各触发点日志定位；此处补 SIGTERM/SIGINT 与 uncaughtException 追踪。
    logger.info("[app] before-quit fired (appQuitting=" + appQuitting + ", shuttingDown=" + shuttingDown + ")");
    // 2026-08-13（登录态修复）：退出前强制刷盘——Chromium 的 cookie/存储
    // 刷盘有延迟，退出后立即重启会丢持久登录态（表现为每次都要重新登录）。
    try {
      session.defaultSession.flushStorageData();
    } catch (error) {
      logger.warn({ err: error }, "[app] flushStorageData failed");
    }
    // 2026-08-12：追踪外部信号与未捕获异常（排除"无人操作却退出"的可能来源）。
    process.on("SIGTERM", () => logger.warn("[app] received SIGTERM"));
    process.on("SIGINT", () => logger.warn("[app] received SIGINT"));
    process.on("uncaughtException", (err) => logger.error("[app] uncaughtException:", err));
    process.on("unhandledRejection", (err) => logger.error("[app] unhandledRejection:", err));
    // 防止快连退出导致重复执行清理逻辑
    if (shuttingDown) {
      event.preventDefault();
      return;
    }
    shuttingDown = true;
    appQuitting = true;
    event.preventDefault();
    broadcastLifecycle({ version: 1, kind: "app_quitting" });
    petTray?.destroy();
    petTray = null;
    // 2026-08-12+（15a 新反馈）：先销毁 pet 窗口、再清理 IPC handler——
    // 原顺序（先 ipcCleanup 后 destroyPetWindow）会让窗口销毁瞬间 renderer
    // 仍在发出的 pet:* invoke（如 pet:set-interaction-mode）落在已移除的
    // handler 上 → "No handler registered for 'pet:set-interaction-mode'"。
    destroyPetWindow();
    ipcCleanup?.();
    ipcCleanup = null;
    logger.info("[app] Stopping web server before quit…");
    // SEC-04: Await stopWebServer to give the Next.js process time to
    // shut down gracefully before app.exit(0). Without this, the child
    // process could become an orphan occupying the port.
    // SEC-06 修复：添加 5 秒超时保护，防止 Next.js 进程挂起导致应用无法退出
    try {
      await Promise.race([
        stopWebServer(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("stopWebServer timeout")), 5_000),
        ),
      ]);
    } catch (err) {
      logger.error("[app] Error stopping web server:", err);
    }
    await soakRuntime?.stop();
    soakRuntime = null;
    app.exit(0);
  });
}
