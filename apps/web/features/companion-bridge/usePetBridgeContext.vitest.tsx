/**
 * §14.4：Pet 端页内命令（dispatchInPageCommand）与导航（dispatchOpenRoute）。
 * - 有 page context → envelope 携带 targetPageInstanceId/expectedContextRevision
 *   （broker freshness 校验所需）；返回 commandId 供回执匹配；
 * - 无 page context（未发布/已 revoke）→ fail closed（不发射）；
 * - 浏览器无 bridge → fail closed。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePetBridgeContext } from "./usePetBridgeContext";
import type { PetBridgePageContext } from "./bridge-global";

function installPetBridge() {
  const dispatchMainCommand = vi.fn(async (_envelope: unknown) => ({ accepted: true }));
  (window as unknown as { companionBridge?: unknown }).companionBridge = {
    onPageContext: () => () => {},
    onUiEvent: () => () => {},
    dispatchMainCommand,
  };
  return { dispatchMainCommand };
}

const PAGE_CONTEXT: PetBridgePageContext = {
  contextId: "ctx-1",
  pageInstanceId: "page-1",
  revision: "r1",
  expiresAt: new Date(Date.now() + 30_000).toISOString(),
  page: {
    routeRef: { kind: "star_map", keyPointId: "223e4567-e89b-12d3-a456-426614174000" },
    pageKind: "star_map",
    entityRefs: [],
    interactionState: "idle",
    capabilityHints: [],
    sensitivity: "normal",
  },
};

beforeEach(() => {
  delete (window as unknown as { companionBridge?: unknown }).companionBridge;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usePetBridgeContext 页内命令（§14.4）", () => {
  it("有 page context → graph.restore envelope 带 freshness 定位并返回 commandId", async () => {
    const { dispatchMainCommand } = installPetBridge();
    // 推送 page context
    let pushContext: ((ctx: PetBridgePageContext) => void) | null = null;
    (window as unknown as { companionBridge?: unknown }).companionBridge = {
      onPageContext: (handler: (ctx: PetBridgePageContext) => void) => {
        pushContext = handler;
        return () => {};
      },
      onUiEvent: () => () => {},
      dispatchMainCommand,
    };
    const { result } = renderHook(() => usePetBridgeContext());
    act(() => {
      pushContext?.(PAGE_CONTEXT);
    });
    const outcome = await result.current.dispatchInPageCommand({ kind: "graph.restore", runId: "323e4567-e89b-12d3-a456-426614174000" });
    expect(outcome.accepted).toBe(true);
    expect(outcome.commandId).toBeTruthy();
    const envelope = (dispatchMainCommand.mock.calls[0]?.[0] ?? {}) as unknown as {
      version: 2;
      scope: string;
      targetPageInstanceId: string;
      expectedContextRevision: string;
      command: { kind: string; runId: string };
    };
    expect(envelope.version).toBe(2);
    expect(envelope.scope).toBe("in_page");
    expect(envelope.targetPageInstanceId).toBe("page-1");
    expect(envelope.expectedContextRevision).toBe("r1");
    expect(envelope.command.kind).toBe("graph.restore");
  });

  it("无 page context → fail closed（不发射、commandId null）", async () => {
    const { dispatchMainCommand } = installPetBridge();
    const { result } = renderHook(() => usePetBridgeContext());
    const outcome = await result.current.dispatchInPageCommand({ kind: "graph.focus", keyPointId: "423e4567-e89b-12d3-a456-426614174000" });
    expect(outcome.accepted).toBe(false);
    expect(outcome.commandId).toBeNull();
    expect(dispatchMainCommand).not.toHaveBeenCalled();
  });

  it("浏览器无 bridge → fail closed", async () => {
    const { result } = renderHook(() => usePetBridgeContext());
    expect(await result.current.dispatchInPageCommand({ kind: "graph.focus", keyPointId: "523e4567-e89b-12d3-a456-426614174000" })).toEqual({
      accepted: false,
      commandId: null,
    });
    expect(await result.current.dispatchOpenRoute({ kind: "learning_run", runId: "623e4567-e89b-12d3-a456-426614174000" })).toEqual({
      accepted: false,
      commandId: null,
    });
  });
});
