/**
 * §14.3/§11.4：主窗口 UI 事件发射链路（useMainPageContext）。
 * - publish 成功后发一次 page.ready（带 broker 返回的 pageInstance/revision）；
 * - publishUiEvent 用最近 pageInstance + revision 发射（broker freshness 校验）；
 * - 浏览器无 bridge / 未发布成功 → fail closed（不调用、返回 false）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useMainPageContext } from "./useMainPageContext";

type PublishPageContextResult = {
  accepted: boolean;
  contextId?: string;
  pageInstanceId?: string;
  revision?: string;
  expiresAt?: string;
  reasonCode?: string;
};

function installBridge(overrides?: {
  publishPageContext?: () => Promise<PublishPageContextResult>;
  publishUiEvent?: () => Promise<{ accepted: boolean }>;
  renewPageContext?: () => Promise<{ accepted: boolean; revision?: string }>;
  revokePageContext?: () => Promise<{ revoked: boolean }>;
}): {
  publishPageContext: ReturnType<typeof vi.fn>;
  publishUiEvent: ReturnType<typeof vi.fn>;
  renewPageContext: ReturnType<typeof vi.fn>;
  revokePageContext: ReturnType<typeof vi.fn>;
} {
  const publishPageContext = vi.fn(overrides?.publishPageContext ?? (async () => ({
    accepted: true,
    contextId: "ctx-1",
    pageInstanceId: "page-1",
    revision: "r1",
  })));
  const publishUiEvent = vi.fn(overrides?.publishUiEvent ?? (async () => ({ accepted: true })));
  const renewPageContext = vi.fn(overrides?.renewPageContext ?? (async () => ({ accepted: true, revision: "r1" })));
  const revokePageContext = vi.fn(overrides?.revokePageContext ?? (async () => ({ revoked: true })));
  (window as unknown as { companionBridge?: unknown }).companionBridge = {
    publishPageContext,
    publishUiEvent,
    renewPageContext,
    revokePageContext,
    onMainCommand: () => () => {},
  };
  return { publishPageContext, publishUiEvent, renewPageContext, revokePageContext };
}

import type { MainPageContextInputV2 } from "@ailearn/shared";

const INPUT: MainPageContextInputV2 = {
  routeRef: { kind: "today" },
  pageKind: "today",
  entityRefs: [],
  interactionState: "idle",
  capabilityHints: [],
  sensitivity: "normal",
};

beforeEach(() => {
  delete (window as unknown as { companionBridge?: unknown }).companionBridge;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useMainPageContext UI 事件发射（§14.3）", () => {
  it("publish 成功后发射一次 page.ready（pageInstance + revision 来自 broker）", async () => {
    const { publishPageContext, publishUiEvent } = installBridge();
    renderHook(() => useMainPageContext(INPUT));
    await waitFor(() => expect(publishPageContext).toHaveBeenCalled());
    await waitFor(() => expect(publishUiEvent).toHaveBeenCalled());
    const call = publishUiEvent.mock.calls[0][0] as { pageInstanceId: string; contextRevision: string; type: string };
    expect(call.type).toBe("page.ready");
    expect(call.pageInstanceId).toBe("page-1");
    expect(call.contextRevision).toBe("r1");
  });

  it("publishUiEvent 用最近 pageInstance/revision 发射（graph.delta_applied 回执）", async () => {
    const { publishUiEvent } = installBridge();
    const { result } = renderHook(() => useMainPageContext(INPUT));
    await waitFor(() => expect(publishUiEvent).toHaveBeenCalled());
    publishUiEvent.mockClear();
    const accepted = await result.current.publishUiEvent(
      "graph.delta_applied",
      [{ kind: "change_set", changeSetId: "cs-1" }],
    );
    expect(accepted).toBe(true);
    const call = publishUiEvent.mock.calls[0][0] as {
      pageInstanceId: string;
      contextRevision: string;
      type: string;
      safeRefs: Array<{ kind: string; changeSetId: string }>;
    };
    expect(call.type).toBe("graph.delta_applied");
    expect(call.pageInstanceId).toBe("page-1");
    expect(call.contextRevision).toBe("r1");
    expect(call.safeRefs[0].changeSetId).toBe("cs-1");
  });

  it("未发布成功（broker 拒绝）→ publishUiEvent 返回 false 且不调用", async () => {
    const { publishPageContext, publishUiEvent } = installBridge({
      publishPageContext: async () => ({ accepted: false }),
    });
    const { result } = renderHook(() => useMainPageContext(INPUT));
    await waitFor(() => expect(publishPageContext).toHaveBeenCalled());
    publishUiEvent.mockClear();
    const accepted = await result.current.publishUiEvent("page.ready");
    expect(accepted).toBe(false);
    expect(publishUiEvent).not.toHaveBeenCalled();
  });

  it("浏览器无 bridge → fail closed（零调用）", async () => {
    const { result } = renderHook(() => useMainPageContext(INPUT));
    expect(await result.current.publishUiEvent("page.ready")).toBe(false);
  });
});
