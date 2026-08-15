/**
 * Main ↔ Pet Companion Bridge V2 channel 常量（文档 16 §14.1）。
 *
 * Electron main process 是唯一 broker。四条通道严格分离：
 * 1. UI Context/Event：Main renderer → broker → Pet（本文件 invoke/send 通道）；
 * 2. Domain Event：业务 outbox → Orchestrator（不经过 renderer）；
 * 3. Assistant Command：Pet → broker → Main（§14.4 表面命令）；
 * 4. Assistant Delivery：Orchestrator → durable inbox/SSE → Pet（不经过本 IPC）。
 */

export const COMPANION_BRIDGE_CHANNELS = {
  // Main renderer → broker（invoke）
  mainPublishContext: "bridge:main:publish-context",
  mainRenewContext: "bridge:main:renew-context",
  mainRevokeContext: "bridge:main:revoke-context",
  mainPublishUiEvent: "bridge:main:publish-ui-event",
  mainReportCommandResult: "bridge:main:report-command-result",
  // Pet renderer → broker（invoke）
  petDispatchCommand: "bridge:pet:dispatch-command",
  // broker → Pet renderer（send）
  petPageContext: "bridge:pet:page-context",
  petUiEvent: "bridge:pet:ui-event",
  // broker → Main renderer（send）
  mainCommand: "bridge:main:command",
} as const;
