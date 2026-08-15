/**
 * §11.4 第 9 步：Pet 端 delta 回执表达（DeltaReceiptNotice）。
 * - graph.delta_applied 事件 → 查服务端 delta → 按 change kind 表达；
 * - canonical → 庆祝文案；practice_only → 明示练习；查询失败 → 中性；
 * - journey 可见时抑制；同事件只表达一次；6s 自动消失。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { DeltaReceiptNotice } from "./DeltaReceiptNotice";
import type { MainUiEventV2 } from "@ailearn/shared";

const uiEvent = (eventId: string, type: MainUiEventV2["type"] = "graph.delta_applied"): MainUiEventV2 => ({
  version: 2,
  eventId,
  pageInstanceId: "page-1",
  pageSequence: 1,
  contextRevision: "r1",
  type,
  occurredAt: new Date().toISOString(),
  safeRefs: [{ kind: "change_set", changeSetId: "cs-1" }],
});

const mockGetProjectionDelta = vi.fn<typeof import("../../../lib/api").api.getProjectionDelta>();

vi.mock("../../../lib/api", () => ({
  api: {
    getProjectionDelta: (...args: Parameters<typeof mockGetProjectionDelta>) =>
      mockGetProjectionDelta(...args),
  },
}));

// DeltaReceiptNotice 现读取 Pet 语音状态（§10.2 录音/播报期间抑制）。
vi.mock("../runtime/PetRuntimeProvider", () => ({
  usePetRuntime: () => ({ state: { voice: { kind: "idle" } } }),
}));

beforeEach(() => {
  mockGetProjectionDelta.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DeltaReceiptNotice（§11.4 回执表达）", () => {
  it("canonical delta → 庆祝文案", async () => {
    mockGetProjectionDelta.mockResolvedValue({ kind: "canonical" } as never);
    render(<DeltaReceiptNotice uiEvent={uiEvent("e1")} journeyVisible={false} />);
    await waitFor(() =>
      expect(screen.getByText("星图已更新：本次学习形成了正式变化")).toBeTruthy(),
    );
    expect(mockGetProjectionDelta).toHaveBeenCalledWith("cs-1");
  });

  it("practice_only delta → 明示练习未形成正式变化", async () => {
    mockGetProjectionDelta.mockResolvedValue({ kind: "practice_only" } as never);
    render(<DeltaReceiptNotice uiEvent={uiEvent("e2")} journeyVisible={false} />);
    await waitFor(() =>
      expect(screen.getByText("练习已记录，未形成正式变化")).toBeTruthy(),
    );
  });

  it("查询失败 → 中性说明（不庆祝、不编造）", async () => {
    mockGetProjectionDelta.mockRejectedValue(new Error("delta not found"));
    render(<DeltaReceiptNotice uiEvent={uiEvent("e3")} journeyVisible={false} />);
    await waitFor(() => expect(screen.getByText("本次学习已结束")).toBeTruthy());
  });

  it("journey 可见时抑制；同事件只表达一次；6s 自动消失", async () => {
    vi.useFakeTimers();
    mockGetProjectionDelta.mockResolvedValue({ kind: "canonical" } as never);
    const { rerender } = render(
      <DeltaReceiptNotice uiEvent={uiEvent("e4")} journeyVisible={true} />,
    );
    // journey 可见：不查询、不显示
    expect(mockGetProjectionDelta).not.toHaveBeenCalled();
    rerender(<DeltaReceiptNotice uiEvent={uiEvent("e4")} journeyVisible={false} />);
    await act(async () => {});
    expect(mockGetProjectionDelta).toHaveBeenCalledWith("cs-1");
    expect(screen.getByText("星图已更新：本次学习形成了正式变化")).toBeTruthy();
    // 同事件重放：不重复查询
    rerender(<DeltaReceiptNotice uiEvent={uiEvent("e4")} journeyVisible={false} />);
    await act(async () => {});
    expect(mockGetProjectionDelta).toHaveBeenCalledTimes(1);
    // 6s 后消失
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(screen.queryByText("星图已更新：本次学习形成了正式变化")).toBeNull();
  });
});
