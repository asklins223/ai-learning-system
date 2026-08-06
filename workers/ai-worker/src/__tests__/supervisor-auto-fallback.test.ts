/**
 * P0-1 验收：Supervisor Auto-Fallback 场景矩阵单测。
 *
 * 覆盖每种注入路径（纯决策函数 computeSupervisorAutoFallback，无 DB 依赖）：
 *   A. 模型不调用工具（toolCalls.length === 0 && nextAction === "needs_attention"）
 *      - A1: 有 Draft 无 Quality Report → 注入 request_grounding_review
 *      - A2: Report passed + deterministic pending → 注入 validate_draft
 *      - A3: Report passed + deterministic passed → 注入 request_verification
 *      - A4: 管道无法纯调度推进 → needs_attention / protocol_error
 *   B. 模型过早请求 Verification（request_verification，含错误 draftHash，BUG-94）
 *      - B1: 有 Draft 无 Report → 替换为正确 draftHash 的 request_grounding_review
 *      - B2: 管道就绪 → 替换为正确 draftHash 的 request_verification
 *   C. 只读工具自旋（consecutiveReadOnlyTurns >= 3）
 *      - C1: 有 Draft 无 Report → 调度注入
 *      - C2: 无 Draft 有候选 → 机械组装 Draft（submit_deck_draft）
 *      - C3: 无 Draft 无候选 → needs_attention / protocol_error
 *   未触发:模型正常调用工具且非自旋 → 原样返回
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeSupervisorAutoFallback,
  type SupervisorAutoFallbackInput,
} from "../agent/supervisor-auto-fallback.ts";
import { CandidateLedger, type CandidateLedgerEntry } from "../agent/candidate-ledger.ts";
import { CoverageLedger } from "../agent/coverage-ledger.ts";

// ─── 测试工具 ────────────────────────────────────────────────────────────

type Outcome = {
  state: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  content: string | null;
  nextAction: string;
  error?: string | undefined;
};

function baseInput(overrides: Partial<SupervisorAutoFallbackInput> = {}): SupervisorAutoFallbackInput {
  return {
    payload: {
      generationRunId: "run-1",
      agentUnitId: "unit-1",
      turnNo: 3,
    } as never,
    workspaceId: "ws-1",
    candidateLedger: new CandidateLedger(),
    coverageLedger: new CoverageLedger(),
    latestDraft: null,
    latestReport: null,
    runDetail: { titleSnapshot: "标题", density: "standard" },
    outcome: {
      state: "running",
      toolCalls: [],
      content: null,
      nextAction: "continue",
    },
    ...overrides,
  } as SupervisorAutoFallbackInput;
}

/** 构造带候选的 ledger */
function ledgerWithCandidate(): CandidateLedger {
  const ledger = new CandidateLedger();
  const entry: CandidateLedgerEntry = {
    candidateId: "cand-1",
    candidateKind: "extracted",
    bundleId: "bundle-1",
    claim: "这是一个测试候选 claim 内容，用于机械组装验证",
    topic: "测试主题",
    cognitiveType: "concept",
    importance: "core",
    sectionKey: "sec-1",
    evidenceRefIds: ["ev-1"],
    validationStatus: "active",
    originUnitId: "unit-0",
    exclusionReason: null,
    groupKey: null,
    derivedCandidateIds: [],
  } as CandidateLedgerEntry;
  ledger.init([entry]);
  return ledger;
}

function noToolNeedsAttention(): Outcome {
  return { state: "running", toolCalls: [], content: null, nextAction: "needs_attention" };
}

function draftRow(contentHash: string) {
  return { id: "draft-1", contentHash, draftVersion: 1 };
}

function reportRow(criticStatus: string, deterministicStatus: string) {
  return { criticStatus, deterministicStatus };
}

// ─── 场景 A：模型未调用工具 ─────────────────────────────────────────────

test("A1: 未调用工具 + 有 Draft 无 Report → 注入 request_grounding_review", () => {
  const decision = computeSupervisorAutoFallback(baseInput({
    latestDraft: draftRow("draft-hash-1"),
    latestReport: null,
    outcome: noToolNeedsAttention(),
  }));
  assert.equal(decision.triggered, true);
  assert.equal(decision.triggerReason, "supervisor_no_tool_calls_auto_progress");
  assert.equal(decision.injectedTools.length, 1);
  assert.equal(decision.injectedTools[0]!.name, "request_grounding_review");
  assert.deepEqual(decision.injectedTools[0]!.arguments, { draftHash: "draft-hash-1" });
  assert.equal(decision.outcome.nextAction, "wait_for_children");
  assert.equal(decision.outcome.state, "running");
});

test("A2: 未调用工具 + Report passed + deterministic pending → 注入 validate_draft", () => {
  const decision = computeSupervisorAutoFallback(baseInput({
    latestDraft: draftRow("draft-hash-1"),
    latestReport: reportRow("passed", "pending"),
    outcome: noToolNeedsAttention(),
  }));
  assert.equal(decision.triggered, true);
  assert.equal(decision.injectedTools[0]!.name, "validate_draft");
  assert.deepEqual(decision.injectedTools[0]!.arguments, { draftHash: "draft-hash-1" });
  assert.equal(decision.outcome.nextAction, "continue");
});

test("A3: 未调用工具 + Report passed + deterministic passed → 注入 request_verification", () => {
  const decision = computeSupervisorAutoFallback(baseInput({
    latestDraft: draftRow("draft-hash-1"),
    latestReport: reportRow("passed", "passed"),
    outcome: noToolNeedsAttention(),
  }));
  assert.equal(decision.triggered, true);
  assert.equal(decision.injectedTools[0]!.name, "request_verification");
  assert.deepEqual(decision.injectedTools[0]!.arguments, { draftHash: "draft-hash-1" });
  assert.equal(decision.outcome.nextAction, "complete");
});

test("A4: 未调用工具 + 无 Draft 无候选 → needs_attention / protocol_error", () => {
  const decision = computeSupervisorAutoFallback(baseInput({
    latestDraft: null,
    latestReport: null,
    outcome: noToolNeedsAttention(),
  }));
  assert.equal(decision.triggered, true);
  assert.equal(decision.injectedTools.length, 0);
  assert.equal(decision.outcome.state, "needs_attention");
  assert.match(decision.outcome.error ?? "", /protocol_error/);
});

test("A5: 未调用工具 + Report deterministic failed → 不注入 validate（防 BUG-94 循环）", () => {
  const decision = computeSupervisorAutoFallback(baseInput({
    latestDraft: draftRow("draft-hash-1"),
    latestReport: reportRow("failed", "failed"),
    outcome: noToolNeedsAttention(),
  }));
  assert.equal(decision.triggered, true);
  assert.equal(decision.injectedTools.length, 0);
  assert.equal(decision.outcome.state, "needs_attention");
});

// ─── 场景 B：模型过早请求 Verification（BUG-94） ───────────────────────

test("B1: 模型调用 request_verification（错误 hash）+ 有 Draft 无 Report → 替换为正确 draftHash 的 critic", () => {
  const decision = computeSupervisorAutoFallback(baseInput({
    latestDraft: draftRow("draft-hash-authoritative"),
    latestReport: null,
    outcome: {
      state: "running",
      toolCalls: [{ id: "tc-1", name: "request_verification", arguments: { draftHash: "mock_draft_hash" } }],
      content: null,
      nextAction: "continue",
    },
  }));
  assert.equal(decision.triggered, true);
  assert.equal(decision.triggerReason, "supervisor_model_verification_redirect");
  assert.equal(decision.injectedTools[0]!.name, "request_grounding_review");
  // 关键：必须使用 DB 权威 draftHash，而不是模型传入的错误 hash
  assert.deepEqual(decision.injectedTools[0]!.arguments, { draftHash: "draft-hash-authoritative" });
});

test("B2: 模型调用 request_verification（错误 hash）+ 管道就绪 → 替换为正确 draftHash 的 verification", () => {
  const decision = computeSupervisorAutoFallback(baseInput({
    latestDraft: draftRow("draft-hash-authoritative"),
    latestReport: reportRow("passed", "passed"),
    outcome: {
      state: "running",
      toolCalls: [{ id: "tc-1", name: "request_verification", arguments: { draftHash: "mock_draft_hash" } }],
      content: null,
      nextAction: "continue",
    },
  }));
  assert.equal(decision.triggered, true);
  assert.equal(decision.injectedTools[0]!.name, "request_verification");
  assert.deepEqual(decision.injectedTools[0]!.arguments, { draftHash: "draft-hash-authoritative" });
  assert.equal(decision.outcome.nextAction, "complete");
});

// ─── 场景 C：只读工具自旋 ───────────────────────────────────────────────

test("C1: 自旋（≥3）+ 有 Draft 无 Report → 调度注入 request_grounding_review", () => {
  const decision = computeSupervisorAutoFallback(baseInput({
    latestDraft: draftRow("draft-hash-1"),
    latestReport: null,
    spinInfo: { consecutiveReadOnlyTurns: 3 },
    outcome: {
      state: "running",
      toolCalls: [{ id: "tc-1", name: "read_candidate_ledger", arguments: {} }],
      content: null,
      nextAction: "continue",
    },
  }));
  assert.equal(decision.triggered, true);
  assert.equal(decision.triggerReason, "supervisor_read_only_spin_detected");
  assert.equal(decision.injectedTools[0]!.name, "request_grounding_review");
});

test("C2: 自旋 + 无 Draft 有候选 → 机械组装 submit_deck_draft", () => {
  const decision = computeSupervisorAutoFallback(baseInput({
    latestDraft: null,
    latestReport: null,
    candidateLedger: ledgerWithCandidate(),
    spinInfo: { consecutiveReadOnlyTurns: 3 },
    outcome: {
      state: "running",
      toolCalls: [{ id: "tc-1", name: "read_candidate_ledger", arguments: {} }],
      content: null,
      nextAction: "continue",
    },
  }));
  assert.equal(decision.triggered, true);
  assert.equal(decision.injectedTools[0]!.name, "submit_deck_draft");
  const args = decision.injectedTools[0]!.arguments as Record<string, unknown>;
  const draft = args.draft as { deckTitle: string; cards: unknown[] };
  assert.equal(draft.deckTitle, "标题");
  assert.equal(draft.cards.length, 1);
  assert.equal(decision.outcome.nextAction, "continue");
});

test("C3: 自旋 + 无 Draft 无候选 → needs_attention / protocol_error", () => {
  const decision = computeSupervisorAutoFallback(baseInput({
    latestDraft: null,
    latestReport: null,
    spinInfo: { consecutiveReadOnlyTurns: 3 },
    outcome: {
      state: "running",
      toolCalls: [{ id: "tc-1", name: "read_candidate_ledger", arguments: {} }],
      content: null,
      nextAction: "continue",
    },
  }));
  assert.equal(decision.triggered, true);
  assert.equal(decision.injectedTools.length, 0);
  assert.equal(decision.outcome.state, "needs_attention");
});

// ─── 未触发 ─────────────────────────────────────────────────────────────

test("未触发:模型正常调用非 verification 工具且未自旋 → 原样返回", () => {
  const outcome: Outcome = {
    state: "running",
    toolCalls: [{ id: "tc-1", name: "delegate_specialist", arguments: {} }],
    content: null,
    nextAction: "continue",
  };
  const decision = computeSupervisorAutoFallback(baseInput({ outcome }));
  assert.equal(decision.triggered, false);
  assert.equal(decision.triggerReason, null);
  assert.equal(decision.injectedTools.length, 0);
  assert.equal(decision.outcome, outcome);
});
