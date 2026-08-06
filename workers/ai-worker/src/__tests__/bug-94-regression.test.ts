/**
 * BUG-94 回归测试：推进路径不信任模型传入的 draftHash。
 *
 * 根因：模型（如 DashScope deepseek-v4-flash）调用 request_verification 时
 * 经常传入错误 draftHash（如 "mock_draft_hash"），工具找不到 draft 而失败，
 * R19 覆盖 nextAction="continue"，形成死循环。
 *
 * 修复后的三层防护（P0-3 验收）：
 *   1. 注入层：supervisor-auto-fallback 场景 B 将模型 request_verification
 *      替换为使用 DB 权威 draftHash（latestDraft.contentHash）的版本——
 *      注入的工具绝不携带模型传入的错误 hash；
 *   2. 工具层：handleRequestVerification 按 draftHash 查 DB 校验存在性，
 *      查不到即失败（R19 覆盖 nextAction="continue"）；
 *   3. VERIFY 层：executeVerify 的 draft_hash_binding 检查拒绝
 *      report.draftHash ≠ input.draftHash，错误 hash 无法通过。
 *
 * 本文件聚焦"错误 hash 无法推进"的不变量（注入替换 + VERIFY 拒绝），
 * 均为纯逻辑测试，不依赖数据库。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { computeSupervisorAutoFallback } from "../agent/supervisor-auto-fallback.ts";
import { CandidateLedger } from "../agent/candidate-ledger.ts";
import { CoverageLedger, initLedgerFromBundlePlan } from "../agent/coverage-ledger.ts";
import { BudgetTracker } from "../agent/budget.ts";
import { executeVerify, type VerifyInput } from "../agent/verify.ts";
import type { QualityReport } from "@ailearn/shared";

// ─── 测试工具 ────────────────────────────────────────────────────────────

const AUTHORITATIVE_HASH = "draft-hash-authoritative";
const MODEL_FORGED_HASH = "mock_draft_hash";

function supervisorInput(overrides: Record<string, unknown> = {}) {
  return {
    payload: { generationRunId: "run-1", agentUnitId: "unit-1", turnNo: 3 } as never,
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
  };
}

function forgedVerificationOutcome() {
  return {
    state: "running",
    toolCalls: [
      { id: "tc-1", name: "request_verification", arguments: { draftHash: MODEL_FORGED_HASH } },
    ],
    content: null,
    nextAction: "continue",
  };
}

// ─── 1. 注入层：错误 hash 被替换为 DB 权威 hash ────────────────────────

test("BUG-94: 模型伪造 hash + 管道就绪 → 注入 request_verification 使用权威 hash", () => {
  const decision = computeSupervisorAutoFallback(supervisorInput({
    latestDraft: { id: "draft-1", contentHash: AUTHORITATIVE_HASH, draftVersion: 1 },
    latestReport: { criticStatus: "passed", deterministicStatus: "passed" },
    outcome: forgedVerificationOutcome(),
  }));

  assert.equal(decision.triggered, true);
  assert.equal(decision.triggerReason, "supervisor_model_verification_redirect");
  assert.equal(decision.injectedTools.length, 1);
  // 核心断言：注入的工具使用 DB 权威 hash，而不是模型传入的伪造 hash
  const injected = decision.injectedTools[0]!;
  assert.equal(injected.name, "request_verification");
  assert.notEqual(
    (injected.arguments as { draftHash: string }).draftHash,
    MODEL_FORGED_HASH,
    "注入工具不得携带模型传入的错误 hash",
  );
  assert.equal((injected.arguments as { draftHash: string }).draftHash, AUTHORITATIVE_HASH);
});

test("BUG-94: 模型伪造 hash + 管道未就绪 → 替换为权威 hash 的 critic 调度", () => {
  const decision = computeSupervisorAutoFallback(supervisorInput({
    latestDraft: { id: "draft-1", contentHash: AUTHORITATIVE_HASH, draftVersion: 1 },
    latestReport: null,
    outcome: forgedVerificationOutcome(),
  }));

  assert.equal(decision.triggered, true);
  assert.equal(decision.injectedTools.length, 1);
  const injected = decision.injectedTools[0]!;
  assert.equal(injected.name, "request_grounding_review");
  assert.equal((injected.arguments as { draftHash: string }).draftHash, AUTHORITATIVE_HASH);
});

// ─── 2. VERIFY 层：错误 hash 无法通过 draft_hash_binding ───────────────

function verifyInputWith(reportDraftHash: string, inputDraftHash: string): VerifyInput {
  const ledger = new CoverageLedger();
  initLedgerFromBundlePlan(ledger, [{ bundleId: "b-1", ordinal: 0, required: true }]);
  ledger.updateAssignment("b-1", "assigned", "unit-1");
  ledger.updateDecision("b-1", "candidate_emitted");

  const report = {
    reportId: "report-1",
    draftHash: reportDraftHash,
    candidatePoolHash: "pool-hash-1",
    sourceLedgerHash: "ledger-hash-1",
    criticStatus: "passed",
    criticModelRevision: "test-model-v1",
    criticVersion: "critic-v1",
    verifierVersion: "verifier-v1",
    perClaimVerdicts: [
      { candidateId: "cand-1", verdict: "supported", supportingEvidenceRefIds: ["ev-1"], reasonCode: "grounded" },
    ],
    hardIssues: [],
    softIssues: [],
    deterministicStatus: "passed",
    metrics: {},
  } as QualityReport;

  return {
    runId: "run-1",
    draftHash: inputDraftHash,
    qualityReport: report,
    coverageLedger: ledger,
    budgetTracker: new BudgetTracker(),
    currentEpoch: 1,
    draftEpoch: 1,
    candidatePoolHash: "pool-hash-1",
    sourceLedgerHash: "ledger-hash-1",
  };
}

test("BUG-94: 错误 hash 到达 VERIFY → draft_hash_binding 拒绝，无法推进", () => {
  const result = executeVerify(verifyInputWith(MODEL_FORGED_HASH, AUTHORITATIVE_HASH));
  assert.equal(result.passed, false, "模型伪造 hash 不得通过 VERIFY");

  const bindingCheck = result.checks.find((c) => c.name === "draft_hash_binding");
  assert.ok(bindingCheck, "应有 draft_hash_binding 检查项");
  assert.equal(bindingCheck!.passed, false);
});

test("BUG-94: 对照组——权威 hash 一致时 draft_hash_binding 通过", () => {
  const result = executeVerify(verifyInputWith(AUTHORITATIVE_HASH, AUTHORITATIVE_HASH));
  const bindingCheck = result.checks.find((c) => c.name === "draft_hash_binding");
  assert.ok(bindingCheck);
  assert.equal(bindingCheck!.passed, true);
});
