/**
 * Main ↔ Pet Companion Bridge V2 前端全局声明（文档 16 §14.2）。
 *
 * Electron preload 把窄接口挂到 window.companionBridge（main-preload /
 * pet-preload 各自只暴露对应角色方法）；浏览器里不存在 → 可选链 fail closed。
 * 类型与 apps/desktop/src/companion-bridge-api.ts 的工厂返回形状对齐。
 */

import type {
  InPageCommandEnvelopeV2,
  MainCommandResultV2,
  MainPageContextInputV2,
  NavigationCommandEnvelopeV2,
} from "@ailearn/shared";

export interface MainCompanionBridgeApi {
  publishPageContext(input: MainPageContextInputV2, contextId?: string): Promise<{
    accepted: boolean;
    contextId?: string;
    pageInstanceId?: string;
    revision?: string;
    expiresAt?: string;
    reasonCode?: string;
  }>;
  renewPageContext(input: { contextId: string; expectedRevision: string }): Promise<{
    accepted: boolean;
    revision?: string;
    expiresAt?: string;
    reasonCode?: string;
  }>;
  revokePageContext(input: { contextId: string; expectedRevision: string }): Promise<{ revoked: boolean }>;
  publishUiEvent(input: {
    pageInstanceId: string;
    contextRevision: string;
    type: string;
    safeRefs?: unknown[];
    commandId?: string;
  }): Promise<{ accepted: boolean; eventId?: string; pageSequence?: number; reasonCode?: string }>;
  reportMainCommandResult(result: MainCommandResultV2): Promise<{ accepted: boolean }>;
  onMainCommand(handler: (command: NavigationCommandEnvelopeV2 | InPageCommandEnvelopeV2) => void): () => void;
}

export interface PetBridgePageContext {
  contextId: string;
  pageInstanceId: string;
  revision: string;
  expiresAt: string;
  page: MainPageContextInputV2;
  revoked?: boolean;
}

export interface PetCompanionBridgeApi {
  onPageContext(handler: (context: PetBridgePageContext) => void): () => void;
  onUiEvent(handler: (event: unknown) => void): () => void;
  dispatchMainCommand(command: NavigationCommandEnvelopeV2 | InPageCommandEnvelopeV2): Promise<{
    accepted: boolean;
    reasonCode?: string;
  }>;
}

export type CompanionBridgeApi = MainCompanionBridgeApi | PetCompanionBridgeApi;

declare global {
  interface Window {
    companionBridge?: CompanionBridgeApi;
  }
}

/** Main 窗口角色判断：有 publishPageContext 即 Main preload。 */
export function isMainBridge(api: CompanionBridgeApi | undefined): api is MainCompanionBridgeApi {
  return Boolean(api && "publishPageContext" in api);
}

export function isPetBridge(api: CompanionBridgeApi | undefined): api is PetCompanionBridgeApi {
  return Boolean(api && "onPageContext" in api);
}
