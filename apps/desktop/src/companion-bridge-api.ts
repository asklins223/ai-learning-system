/**
 * Companion Bridge V2 preload 窄接口工厂（文档 16 §14.2）。
 *
 * 两个 renderer 只拿到固定方法，不暴露原始 ipcRenderer、channel 名或任意
 * listener。类型对齐 @ailearn/shared 的 §14 合同（MainWindowCompanionBridgeV2 /
 * PetWindowCompanionBridgeV2 语义）。
 */

import type { IpcRenderer } from "electron";
import type {
  MainCommandResultV2,
  MainPageContextInputV2,
  NavigationCommandEnvelopeV2,
  InPageCommandEnvelopeV2,
} from "@ailearn/shared";
import { COMPANION_BRIDGE_CHANNELS } from "./ipc/companion-bridge-channels";

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

export interface PetCompanionBridgeApi {
  onPageContext(handler: (context: {
    contextId: string;
    pageInstanceId: string;
    revision: string;
    expiresAt: string;
    page: MainPageContextInputV2;
    revoked?: boolean;
  }) => void): () => void;
  onUiEvent(handler: (event: unknown) => void): () => void;
  dispatchMainCommand(command: NavigationCommandEnvelopeV2 | InPageCommandEnvelopeV2): Promise<{
    accepted: boolean;
    reasonCode?: string;
  }>;
}

export function createMainCompanionBridgeApi(ipcRenderer: Pick<IpcRenderer, "invoke" | "on" | "removeListener">): MainCompanionBridgeApi {
  return {
    publishPageContext: (input, contextId) =>
      ipcRenderer.invoke(COMPANION_BRIDGE_CHANNELS.mainPublishContext, input, contextId),
    renewPageContext: (input) =>
      ipcRenderer.invoke(COMPANION_BRIDGE_CHANNELS.mainRenewContext, input),
    revokePageContext: (input) =>
      ipcRenderer.invoke(COMPANION_BRIDGE_CHANNELS.mainRevokeContext, input),
    publishUiEvent: (input) =>
      ipcRenderer.invoke(COMPANION_BRIDGE_CHANNELS.mainPublishUiEvent, input),
    reportMainCommandResult: (result) =>
      ipcRenderer.invoke(COMPANION_BRIDGE_CHANNELS.mainReportCommandResult, result),
    onMainCommand: (handler) => {
      const listener = (_event: unknown, value: unknown) => {
        // 只透传受控 envelope（broker 已校验 sender 与 schema）。
        handler(value as NavigationCommandEnvelopeV2 | InPageCommandEnvelopeV2);
      };
      ipcRenderer.on(COMPANION_BRIDGE_CHANNELS.mainCommand, listener);
      return () => ipcRenderer.removeListener(COMPANION_BRIDGE_CHANNELS.mainCommand, listener);
    },
  };
}

export function createPetCompanionBridgeApi(ipcRenderer: Pick<IpcRenderer, "invoke" | "on" | "removeListener">): PetCompanionBridgeApi {
  return {
    onPageContext: (handler) => {
      const listener = (_event: unknown, value: unknown) => {
        handler(value as {
          contextId: string;
          pageInstanceId: string;
          revision: string;
          expiresAt: string;
          page: MainPageContextInputV2;
          revoked?: boolean;
        });
      };
      ipcRenderer.on(COMPANION_BRIDGE_CHANNELS.petPageContext, listener);
      return () => ipcRenderer.removeListener(COMPANION_BRIDGE_CHANNELS.petPageContext, listener);
    },
    onUiEvent: (handler) => {
      const listener = (_event: unknown, value: unknown) => handler(value);
      ipcRenderer.on(COMPANION_BRIDGE_CHANNELS.petUiEvent, listener);
      return () => ipcRenderer.removeListener(COMPANION_BRIDGE_CHANNELS.petUiEvent, listener);
    },
    dispatchMainCommand: (command) =>
      ipcRenderer.invoke(COMPANION_BRIDGE_CHANNELS.petDispatchCommand, command),
  };
}
