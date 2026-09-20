// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanionProposalUiState } from "../../app/companion-chat-session";
import { CompanionProposalChoice } from "./CompanionProposalChoice";

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
    expiresAt: "2026-09-21T00:00:00.000Z",
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
});
