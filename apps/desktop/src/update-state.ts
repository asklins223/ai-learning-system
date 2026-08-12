/**
 * Desktop updater 状态机（fail-closed 配置 + 回滚可观测性契约）。
 *
 * 本文件于 2026-08-11 误删后按接口契约重建：构造/事件/断言契约
 * 100% 对齐 update-runtime.ts 的调用点与 tray-menu.test.ts 的 4 个用例
 * （空源 not-supported、checking→downloading→ready、error 保留版本、
 * update-not-available→idle / disabled→not-supported）。
 */

export type UpdatePhase =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "error"
  | "not-supported";

export type UpdateEvent =
  | { type: "checking" }
  | { type: "update-available"; version?: string }
  | { type: "update-not-available" }
  | { type: "download-progress" }
  | { type: "update-downloaded"; version?: string }
  | { type: "error"; code: string }
  | { type: "disabled" };

export interface UpdateState {
  phase: UpdatePhase;
  /** 当前运行版本（不可变：失败的下载/安装绝不改写运行版本，回滚语义） */
  runningVersion?: string;
  /** 可用的新版本（update-downloaded 后） */
  version?: string;
  /** 失败/禁用原因码 */
  errorCode?: string;
}

export class UpdateStateMachine {
  private readonly feedUrl: string | null;
  private state: UpdateState;

  constructor(feedUrl: string | null, runningVersion?: string) {
    this.feedUrl = feedUrl?.trim() || null;
    this.state = { phase: "idle", runningVersion };
  }

  snapshot(): UpdateState {
    return { ...this.state };
  }

  /** 发起检查：空/未配置源 → not-supported（不自动检查，fail-closed）。 */
  startCheck(): UpdateState {
    if (!this.feedUrl) {
      this.state = {
        phase: "not-supported",
        errorCode: "UPDATE_FEED_NOT_CONFIGURED",
        runningVersion: this.state.runningVersion,
      };
      return this.snapshot();
    }
    this.state = { ...this.state, phase: "checking" };
    return this.snapshot();
  }

  /** 显式禁用（如 feed 非法）：状态机进入 not-supported，调用方 enabled=false。 */
  disable(reason: string): void {
    this.state = {
      phase: "not-supported",
      errorCode: reason,
      runningVersion: this.state.runningVersion,
    };
  }

  /** 驱动事件推进；返回推进后的快照（调用方据此决定 check/download/install）。 */
  onEvent(event: UpdateEvent): UpdateState {
    switch (event.type) {
      case "checking":
        this.state = { ...this.state, phase: "checking" };
        break;
      case "update-available":
        this.state = {
          ...this.state,
          phase: "downloading",
          version: event.version ?? this.state.version,
        };
        break;
      case "download-progress":
        this.state = { ...this.state, phase: "downloading" };
        break;
      case "update-downloaded":
        this.state = {
          ...this.state,
          phase: "ready",
          version: event.version ?? this.state.version,
        };
        break;
      case "update-not-available":
        this.state = { ...this.state, phase: "idle", version: undefined };
        break;
      case "error":
        // 失败保持当前版本信息（旧版仍可运行）；errorCode 记录原因码。
        this.state = { ...this.state, phase: "error", errorCode: event.code };
        break;
      case "disabled":
        this.state = { ...this.state, phase: "not-supported" };
        break;
    }
    return this.snapshot();
  }
}
