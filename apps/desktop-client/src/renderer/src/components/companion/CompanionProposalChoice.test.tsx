// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanionProposalUiState } from "../../app/companion-chat-session";
import { CompanionProposalChoice, companionProposalExpired } from "./CompanionProposalChoice";

// 夹具的有效期必须**相对当下**：上一版写死 2026-09-21，于是日历一过，这张卡在
// 新判据（`companionProposalExpired`）眼里就是过期卡，"待选择"那两条用例红得毫无道理。
const FUTURE_EXPIRY = new Date(Date.now() + 3_600_000).toISOString();
const PAST_EXPIRY = new Date(Date.now() - 3_600_000).toISOString();

const PENDING_STATE = {
  phase: "ready",
  proposal: {
    version: 1,
    proposalId: "11111111-1111-4111-8111-111111111111",
    conversationId: "22222222-2222-4222-8222-222222222222",
    sourceMessageId: "33333333-3333-4333-8333-333333333333",
    sourceGeneration: 1,
    contextGrantId: null,
    payload: { kind: "set_pet_activeness", activeness: "moderate" },
    payloadSha256: "a".repeat(64),
    title: "把陪伴频率调整为适中",
    targetSummary: "伴星活跃度",
    impactSummary: "之后会在合适的时机主动提醒，但不会频繁打断。",
    requiresConfirmation: true,
    status: "pending",
    decision: null,
    expiresAt: FUTURE_EXPIRY,
    decidedAt: null,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  },
} satisfies CompanionProposalUiState;

afterEach(cleanup);

describe("CompanionProposalChoice", () => {
  it("在气泡与历史共用的待选择卡上调用真实决定回调", () => {
    const onDecide = vi.fn();
    render(
      <CompanionProposalChoice
        proposalId={PENDING_STATE.proposal.proposalId}
        state={PENDING_STATE}
        context="bubble"
        onDecide={onDecide}
      />,
    );

    expect(screen.getByText("需要你的选择")).toBeTruthy();
    expect(screen.getByText("伴星活跃度")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    fireEvent.click(screen.getByRole("button", { name: "暂不执行" }));
    expect(onDecide).toHaveBeenNthCalledWith(1, "confirm");
    expect(onDecide).toHaveBeenNthCalledWith(2, "reject");
  });

  it("决定提交期间锁住两个入口并给出进行中反馈", () => {
    render(
      <CompanionProposalChoice
        proposalId={PENDING_STATE.proposal.proposalId}
        state={{ ...PENDING_STATE, deciding: "confirm" }}
        context="history"
        onDecide={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "正在确认…" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "暂不执行" }).hasAttribute("disabled")).toBe(true);
  });

  it("历史中的终态保留结果但不再提供重复操作", () => {
    render(
      <CompanionProposalChoice
        proposalId={PENDING_STATE.proposal.proposalId}
        state={{
          phase: "ready",
          proposal: { ...PENDING_STATE.proposal, status: "succeeded", decision: "confirm" },
        }}
        context="history"
        onDecide={vi.fn()}
      />,
    );

    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("快照不可用时显示真实错误，不伪造选项", () => {
    render(
      <CompanionProposalChoice
        proposalId={PENDING_STATE.proposal.proposalId}
        state={{ phase: "error", message: "服务暂时不可用" }}
        context="history"
        onDecide={vi.fn()}
      />,
    );

    expect(screen.getByText("这个选择暂时无法读取")).toBeTruthy();
    expect(screen.getByText("服务暂时不可用")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("读不成时给了重试就能重试；没给就一个按钮都不画", () => {
    const onRetry = vi.fn();
    const { unmount } = render(
      <CompanionProposalChoice
        proposalId={PENDING_STATE.proposal.proposalId}
        state={{ phase: "error", message: "服务暂时不可用" }}
        context="bubble"
        onDecide={vi.fn()}
        onRetry={onRetry}
      />,
    );
    // 这一条同时是 F1 的判据：以前失败会永久挂着，因为会话层的守卫是
    // "这个 id 不在表里才去取"，而失败已经把 `{phase:"error"}` 写进表里了。
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();

    render(
      <CompanionProposalChoice
        proposalId={PENDING_STATE.proposal.proposalId}
        state={{ phase: "error", message: "服务暂时不可用" }}
        context="history"
        onDecide={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("`expiresAt` 一过就不再是待选择：只说已过期，两颗按钮都不给", () => {
    render(
      <CompanionProposalChoice
        proposalId={PENDING_STATE.proposal.proposalId}
        state={{ ...PENDING_STATE, proposal: { ...PENDING_STATE.proposal, expiresAt: PAST_EXPIRY } }}
        context="bubble"
        onDecide={vi.fn()}
      />,
    );

    expect(screen.getByText("已过期")).toBeTruthy();
    expect(screen.queryByText("需要你的选择")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("过期判定只认证据：没有到期时间或读不出时间都不算过期", () => {
    expect(companionProposalExpired(null)).toBe(false);
    expect(companionProposalExpired("不是时间")).toBe(false);
    expect(companionProposalExpired(PAST_EXPIRY)).toBe(true);
    expect(companionProposalExpired(FUTURE_EXPIRY)).toBe(false);
  });
});
