/**
 * Supervisor Agent v1 必测行为（计划 §17.4）
 *
 * 14 项必测行为的单元测试。
 * 测试不依赖数据库，验证纯逻辑函数的行为契约。
 *
 * 测试列表（§17.4）：
 * 1. Supervisor 短文直接组织
 * 2. 长文动态 fan-out
 * 3. 多模态选择 Vision Specialist
 * 4. child task duplicate/dead/retry/wait/resume
 * 5. child 尝试再 delegate 被拒绝
 * 6. Supervisor 跳过 bundle 无法 Verify
 * 7. Composer optional/failure fallback
 * 8. Critic mandatory、Supervisor 不能自签
 * 9. Repair 只能一次
 * 10. vector missing/stale/wrong profile fallback
 * 11. lease lost、cancel、stale epoch
 * 12. publish response lost
 * 13. tenant/ref/hash 攻击
 * 14. prompt injection
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planBundles,
  DEFAULT_BUNDLE_PLANNER_CONFIG,
  type PlannableEvidence,
} from "../agent/bundle-planner.ts";
import {
  validateDelegation,
  computeDelegationIdempotencyKey,
  buildChildTaskManifest,
  DelegationError,
} from "../agent/delegation.ts";
import {
  CoverageLedger,
  initLedgerFromBundlePlan,
  CoverageViolationError,
} from "../agent/coverage-ledger.ts";
import {
  toolRegistry,
  computeToolIdempotencyKey,
  computeArgsHash,
} from "../agent/tool-registry.ts";
import {
  BudgetTracker,
  BudgetExhaustedError,
} from "../agent/budget.ts";
import { executeVerify, type VerifyInput } from "../agent/verify.ts";
import {
  HybridSearchEngine,
  type SequentialSearchExecutor,
  type LexicalSearchExecutor,
  type VectorSearchExecutor,
  type EmbeddingProvider,
} from "../agent/hybrid-search.ts";
import {
  CandidateLedger,
  type CandidateLedgerEntry,
} from "../agent/candidate-ledger.ts";
import { buildSupervisorSystemPrompt } from "../agent/roles/supervisor-policy.ts";
import type { AgentRole, QualityReport, CriticIssue } from "@ailearn/shared";

// ─── 测试工具 ────────────────────────────────────────────────────────────

/** 构建测试用 evidence */
function makeEvidence(
  refId: string,
  ordinal: number,
  tokens: number,
  section: string[] = ["root"],
  isShort: boolean = false,
): PlannableEvidence {
  return {
    refId,
    kind: "text_span",
    blockId: `block-${ordinal}`,
    blockOrdinal: ordinal,
    sectionPath: section,
    tokenEstimate: tokens,
    sourceHash: `hash-${refId}`,
    isShort,
    text: `content-${refId}`,
    charStart: 0,
    charEnd: 100,
  };
}

/** 构建测试用 QualityReport */
function makeQualityReport(overrides: Partial<QualityReport> = {}): QualityReport {
return {
reportId: "report-1",
draftHash: "draft-hash-1",
candidatePoolHash: "pool-hash-1",
sourceLedgerHash: "ledger-hash-1",
criticStatus: "passed",
criticModelRevision: "test-model-v1",
// P0-03 修复：默认包含非空 verdict，使测试不再因空 verdict 而失败。
// 需要测试空 verdict 场景的测试用例可以显式覆盖 perClaimVerdicts: []。
perClaimVerdicts: [
  { candidateId: "cand-1", verdict: "supported", supportingEvidenceRefIds: ["ev-1"], reasonCode: "grounded" },
],
hardIssues: [],
softIssues: [],
deterministicStatus: "passed",
...overrides,
} as QualityReport;
}

// ─── 1. Supervisor 短文直接组织 ─────────────────────────────────────────

test("§17.4-1: 短文生成单个 bundle，Supervisor 可直接组织", () => {
  const shortEvidence = [
    makeEvidence("ev-1", 0, 200),
    makeEvidence("ev-2", 1, 150),
  ];

  const result = planBundles(shortEvidence, DEFAULT_BUNDLE_PLANNER_CONFIG);

  // 短文应该只产生一个 bundle
  assert.equal(result.bundles.length, 1, "短文应只产生一个 bundle");
  assert.equal(result.bundles[0].required, true);
  assert.equal(result.unassigned.length, 0, "所有 evidence 都应被分配");

  // 所有 evidence 都有 primary owner
  assert.ok(result.primaryOwnership.has("ev-1"));
  assert.ok(result.primaryOwnership.has("ev-2"));
});

// ─── 2. 长文动态 fan-out ─────────────────────────────────────────────────

test("§17.4-2: 长文生成多个 bundle，Supervisor 需要动态 fan-out", () => {
  // 模拟长文：多个 section，每个 section 有多个 evidence
  const longEvidence: PlannableEvidence[] = [];
  for (let section = 0; section < 5; section++) {
    for (let i = 0; i < 10; i++) {
      const ordinal = section * 10 + i;
      longEvidence.push(
        makeEvidence(
          `ev-${section}-${i}`,
          ordinal,
          800, // 每个 800 tokens，maxBundleTokens=8000 → 每个 bundle 约 10 个
          [`section-${section}`],
        ),
      );
    }
  }

  const result = planBundles(longEvidence, DEFAULT_BUNDLE_PLANNER_CONFIG);

  // 长文应该产生多个 bundle
  assert.ok(result.bundles.length > 1, "长文应产生多个 bundle");

  // 每个 bundle 都不应超过 maxBundleTokens
  for (const bundle of result.bundles) {
    assert.ok(
      bundle.tokenEstimate <= DEFAULT_BUNDLE_PLANNER_CONFIG.maxBundleTokens,
      `bundle ${bundle.bundleId} token 估算 ${bundle.tokenEstimate} 超过上限`,
    );
  }

  // 所有 evidence 都有 primary owner
  assert.equal(result.unassigned.length, 0, "所有 evidence 都应被分配");
  assert.equal(
    result.primaryOwnership.size,
    longEvidence.length,
    "primary ownership 数量应等于 evidence 数量",
  );
});

// ─── 3. 多模态选择 Vision Specialist ─────────────────────────────────────

test("§17.4-3: 多模态内容选择 Vision Specialist，delegation 接受 vision_specialist 角色", () => {
  const request = {
    runId: "run-1",
    parentUnitId: "unit-supervisor-1",
    workspaceId: "ws-1",
    noteVersionId: "nv-1",
    requestedBy: "user-1",
    role: "vision_specialist" as AgentRole,
    bundleIds: ["bundle-img-1"],
    taskSpec: { imageEvidenceIds: ["img-ev-1"] },
    toolCallId: "tc-1",
    turnNo: 1,
  };

  // 不应抛出异常
  assert.doesNotThrow(() => validateDelegation(request));

  // manifest 应正确构建
  const manifest = buildChildTaskManifest(request);
  assert.equal(manifest.agentRole, "vision_specialist");
  assert.equal(manifest.depth, 1);
  assert.deepEqual(manifest.bundleIds, ["bundle-img-1"]);
});

// ─── 4. child task duplicate/dead/retry/wait/resume ──────────────────────

test("§17.4-4a: 重复 delegate toolCallId 产生相同幂等键（duplicate 安全）", () => {
  const base = {
    runId: "run-1",
    parentUnitId: "unit-sup-1",
    toolCallId: "tc-delegate-1",
  };

  const key1 = computeDelegationIdempotencyKey(base);
  const key2 = computeDelegationIdempotencyKey(base);

  assert.equal(key1, key2, "相同参数应产生相同幂等键");

  // 不同 toolCallId 应产生不同幂等键
  const key3 = computeDelegationIdempotencyKey({
    ...base,
    toolCallId: "tc-delegate-2",
  });
  assert.notEqual(key1, key3, "不同 toolCallId 应产生不同幂等键");
});

test("§17.4-4b: 工具幂等键确保 side effect exactly-once", () => {
  const base = {
    runId: "run-1",
    agentUnitId: "unit-1",
    turnNo: 1,
    toolCallId: "tc-1",
    toolName: "submit_deck_draft",
    argsHash: computeArgsHash({ draft: { cards: [] } }),
  };

  const key1 = computeToolIdempotencyKey(base);
  const key2 = computeToolIdempotencyKey(base);

  assert.equal(key1, key2, "相同参数应产生相同幂等键");

  // 不同参数应产生不同幂等键
  const key3 = computeToolIdempotencyKey({
    ...base,
    toolCallId: "tc-2",
  });
  assert.notEqual(key1, key3, "不同 toolCallId 应产生不同幂等键");
});

test("§17.4-4c: computeArgsHash 对嵌套对象 key 顺序不敏感", () => {
  const hash1 = computeArgsHash({ a: 1, b: { x: 1, y: 2 } });
  const hash2 = computeArgsHash({ b: { y: 2, x: 1 }, a: 1 });

  assert.equal(hash1, hash2, "嵌套对象 key 顺序不同应产生相同 hash");
});

// ─── 5. child 尝试再 delegate 被拒绝 ─────────────────────────────────────

test("§17.4-5: 只有 Supervisor 可以 delegate，specialist 角色不能 delegate", () => {
  // specialist 角色不能使用 delegate_specialist 工具
  const specialistRoles: AgentRole[] = [
    "text_extractor",
    "code_extractor",
    "vision_specialist",
    "deck_composer",
    "grounding_critic",
    "repairer",
  ];

  for (const role of specialistRoles) {
    assert.equal(
      toolRegistry.isToolAllowed(role, "delegate_specialist"),
      false,
      `角色 ${role} 不应能使用 delegate_specialist`,
    );
  }

  // 只有 Supervisor 可以使用 delegate_specialist
  assert.equal(
    toolRegistry.isToolAllowed("generation_supervisor", "delegate_specialist"),
    true,
    "Supervisor 应能使用 delegate_specialist",
  );
});

test("§17.4-5b: specialist 角色的工具集中不包含 delegate_specialist", () => {
  const specialistRoles: AgentRole[] = [
    "text_extractor",
    "code_extractor",
    "vision_specialist",
    "deck_composer",
    "grounding_critic",
    "repairer",
  ];

  for (const role of specialistRoles) {
    const tools = toolRegistry.getAllowedToolNames(role);
    assert.ok(
      !tools.includes("delegate_specialist"),
      `角色 ${role} 的工具列表不应包含 delegate_specialist`,
    );
  }
});

test("§17.4-5c: delegation 验证拒绝非 specialist 角色", () => {
  const invalidRequest = {
    runId: "run-1",
    parentUnitId: "unit-1",
    workspaceId: "ws-1",
    noteVersionId: "nv-1",
    requestedBy: "user-1",
    role: "generation_supervisor" as AgentRole, // Supervisor 不能被委派
    bundleIds: ["bundle-1"],
    taskSpec: {},
    toolCallId: "tc-1",
    turnNo: 1,
  };

  assert.throws(
    () => validateDelegation(invalidRequest),
    (err: Error) => {
      assert.ok(err instanceof DelegationError);
      assert.equal(err.code, "invalid_role");
      return true;
    },
  );
});

test("§17.4-5d: delegation 验证拒绝空 bundleIds", () => {
  const emptyBundlesRequest = {
    runId: "run-1",
    parentUnitId: "unit-1",
    workspaceId: "ws-1",
    noteVersionId: "nv-1",
    requestedBy: "user-1",
    role: "text_extractor" as AgentRole,
    bundleIds: [],
    taskSpec: {},
    toolCallId: "tc-1",
    turnNo: 1,
  };

  assert.throws(
    () => validateDelegation(emptyBundlesRequest),
    (err: Error) => {
      assert.ok(err instanceof DelegationError);
      assert.equal(err.code, "empty_bundles");
      return true;
    },
  );
});

// ─── 6. Supervisor 跳过 bundle 无法 Verify ───────────────────────────────

test("§17.4-6a: 有未分配的 required bundle 时 verifyFullResultPrerequisites 失败", () => {
  const ledger = new CoverageLedger();
  initLedgerFromBundlePlan(ledger, [
    { bundleId: "b-1", ordinal: 0, required: true },
    { bundleId: "b-2", ordinal: 1, required: true },
    { bundleId: "b-3", ordinal: 2, required: true },
  ]);

  // 只分配和决策了 b-1，b-2 和 b-3 未处理
  ledger.updateAssignment("b-1", "assigned", "unit-1");
  ledger.updateDecision("b-1", "candidate_emitted");

  assert.throws(
    () => ledger.verifyFullResultPrerequisites(),
    (err: Error) => {
      assert.ok(err instanceof CoverageViolationError);
      assert.equal(err.code, "assignment_coverage_incomplete");
      return true;
    },
  );
});

test("§17.4-6b: 有已分配但未决策的 bundle 时 verifyFullResultPrerequisites 失败", () => {
  const ledger = new CoverageLedger();
  initLedgerFromBundlePlan(ledger, [
    { bundleId: "b-1", ordinal: 0, required: true },
    { bundleId: "b-2", ordinal: 1, required: true },
  ]);

  // b-1 完整处理，b-2 已分配但未决策
  ledger.updateAssignment("b-1", "assigned", "unit-1");
  ledger.updateDecision("b-1", "candidate_emitted");
  ledger.updateAssignment("b-2", "assigned", "unit-2");
  // b-2 的 decisionStatus 仍为 "pending"

  assert.throws(
    () => ledger.verifyFullResultPrerequisites(),
    (err: Error) => {
      assert.ok(err instanceof CoverageViolationError);
      assert.equal(err.code, "decision_coverage_incomplete");
      return true;
    },
  );
});

test("§17.4-6c: 所有 required bundle 都有明确决策时 verifyFullResultPrerequisites 通过", () => {
  const ledger = new CoverageLedger();
  initLedgerFromBundlePlan(ledger, [
    { bundleId: "b-1", ordinal: 0, required: true },
    { bundleId: "b-2", ordinal: 1, required: true },
  ]);

  ledger.updateAssignment("b-1", "assigned", "unit-1");
  ledger.updateDecision("b-1", "candidate_emitted");
  // P1-09: candidate_emitted 的 bundle 必须有存活候选（candidateCount > 0）
  ledger.updateCandidateCount("b-1", 1);
  ledger.updateAssignment("b-2", "assigned", "unit-2");
  ledger.updateDecision("b-2", "no_learnable_fact", "no learnable content");

  assert.doesNotThrow(() => ledger.verifyFullResultPrerequisites());
});

test("§17.4-6d: model_omitted 状态阻断 verify", () => {
  const ledger = new CoverageLedger();
  initLedgerFromBundlePlan(ledger, [
    { bundleId: "b-1", ordinal: 0, required: true },
  ]);

  ledger.updateAssignment("b-1", "assigned", "unit-1");
  ledger.updateDecision("b-1", "model_omitted");

  assert.throws(
    () => ledger.verifyFullResultPrerequisites(),
    (err: Error) => {
      assert.ok(err instanceof CoverageViolationError);
      assert.equal(err.code, "blocking_decision_exists");
      return true;
    },
  );
});

test("§17.4-6e: model_omitted 不得自动改写为 no_learnable_fact", () => {
  const ledger = new CoverageLedger();
  initLedgerFromBundlePlan(ledger, [
    { bundleId: "b-1", ordinal: 0, required: true },
  ]);

  ledger.updateAssignment("b-1", "assigned", "unit-1");
  ledger.updateDecision("b-1", "model_omitted");

  // 尝试将 model_omitted 改写为 no_learnable_fact 应失败
  assert.throws(
    () => ledger.updateDecision("b-1", "no_learnable_fact"),
    (err: Error) => {
      assert.ok(err instanceof CoverageViolationError);
      assert.equal(err.code, "forbidden_omitted_rewrite");
      return true;
    },
  );
});

// ─── 7. Composer optional/failure fallback ───────────────────────────────

test("§17.4-7: Deck Composer 是可选专家，Supervisor 有自己的组织工具", () => {
  // Supervisor 有 submit_deck_draft 工具，可以直接组织
  assert.equal(
    toolRegistry.isToolAllowed("generation_supervisor", "submit_deck_draft"),
    true,
    "Supervisor 应能直接使用 submit_deck_draft",
  );

  // Deck Composer 也有 submit_deck_draft 工具（可选委派）
  assert.equal(
    toolRegistry.isToolAllowed("deck_composer", "submit_deck_draft"),
    true,
    "Deck Composer 应能使用 submit_deck_draft",
  );

  // Supervisor 不依赖 Deck Composer 也能完成基本流程
  const supervisorTools = toolRegistry.getAllowedToolNames("generation_supervisor");
  assert.ok(
    supervisorTools.includes("submit_deck_draft"),
    "Supervisor 工具列表应包含 submit_deck_draft",
  );
  assert.ok(
    supervisorTools.includes("validate_draft"),
    "Supervisor 工具列表应包含 validate_draft",
  );
  assert.ok(
    supervisorTools.includes("request_verification"),
    "Supervisor 工具列表应包含 request_verification",
  );
});

// ─── 8. Critic mandatory、Supervisor 不能自签 ────────────────────────────

test("§17.4-8a: Supervisor 不能使用 submit_quality_report 工具", () => {
  // submit_quality_report 只属于 grounding_critic
  assert.equal(
    toolRegistry.isToolAllowed("generation_supervisor", "submit_quality_report"),
    false,
    "Supervisor 不应能使用 submit_quality_report（不能自签）",
  );

  // 只有 grounding_critic 可以提交 quality report
  assert.equal(
    toolRegistry.isToolAllowed("grounding_critic", "submit_quality_report"),
    true,
    "Critic 应能使用 submit_quality_report",
  );
});

test("§17.4-8b: Critic 的工具集是只读 + submit_quality_report", () => {
  const criticTools = toolRegistry.getAllowedToolNames("grounding_critic");

  // Critic 有只读工具
  assert.ok(criticTools.includes("read_draft"), "Critic 应有 read_draft");
  assert.ok(criticTools.includes("read_candidates"), "Critic 应有 read_candidates");
  assert.ok(criticTools.includes("read_evidence"), "Critic 应有 read_evidence");

  // Critic 不能修改候选或草稿
  assert.ok(
    !criticTools.includes("apply_candidate_operations"),
    "Critic 不应有 apply_candidate_operations",
  );
  assert.ok(
    !criticTools.includes("submit_deck_draft"),
    "Critic 不应有 submit_deck_draft",
  );
  assert.ok(
    !criticTools.includes("apply_draft_patch"),
    "Critic 不应有 apply_draft_patch",
  );
});

test("§17.4-8c: VERIFY 阶段检查 Critic verdict，未通过时不允许发布", () => {
  const ledger = new CoverageLedger();
  initLedgerFromBundlePlan(ledger, [
    { bundleId: "b-1", ordinal: 0, required: true },
  ]);
  ledger.updateAssignment("b-1", "assigned", "unit-1");
  ledger.updateDecision("b-1", "candidate_emitted");

  const budget = new BudgetTracker();

  // Critic 未通过的 report
  const failedReport = makeQualityReport({
    criticStatus: "failed",
    hardIssues: [{
      code: "unsupported_claim",
      severity: "hard",
      candidateId: "cand-1",
      evidenceRefIds: [],
      verdict: "unsupported",
      patchable: true,
    } as CriticIssue],
    deterministicStatus: "pending",
  });

  const verifyInput: VerifyInput = {
    runId: "run-1",
    draftHash: "draft-hash-1",
    qualityReport: failedReport,
    coverageLedger: ledger,
    budgetTracker: budget,
    currentEpoch: 1,
    draftEpoch: 1,
    candidatePoolHash: "pool-hash-1",
    sourceLedgerHash: "ledger-hash-1",
  };

  const result = executeVerify(verifyInput);

  assert.equal(result.passed, false, "Critic 未通过时 VERIFY 应失败");

  // 应该有 critic_verdict 检查失败
  const criticCheck = result.checks.find((c) => c.name === "critic_verdict");
  assert.ok(criticCheck, "应有 critic_verdict 检查项");
  assert.equal(criticCheck!.passed, false);

  // 也应该有 deterministic_status 检查失败
  const detStatusCheck = result.checks.find((c) => c.name === "deterministic_status");
  assert.ok(detStatusCheck, "应有 deterministic_status 检查项");
  assert.equal(detStatusCheck!.passed, false);
});

// ─── 9. Repair 只能一次 ──────────────────────────────────────────────────

test("§17.4-9a: request_repair 工具只属于 Supervisor（Repairer 不能自己请求修复）", () => {
  assert.equal(
    toolRegistry.isToolAllowed("generation_supervisor", "request_repair"),
    true,
    "Supervisor 应能使用 request_repair",
  );

  assert.equal(
    toolRegistry.isToolAllowed("repairer", "request_repair"),
    false,
    "Repairer 不应能使用 request_repair",
  );
});

test("§17.4-9b: Repairer 只能提交 patch，不能创建新的 Repair 任务", () => {
  const repairerTools = toolRegistry.getAllowedToolNames("repairer");

  assert.ok(repairerTools.includes("submit_draft_patch"), "Repairer 应有 submit_draft_patch");
  assert.ok(
    !repairerTools.includes("request_repair"),
    "Repairer 不应有 request_repair（防止无限修复）",
  );
  assert.ok(
    !repairerTools.includes("delegate_specialist"),
    "Repairer 不应有 delegate_specialist",
  );
});

// ─── 10. vector missing/stale/wrong profile fallback ─────────────────────

test("§17.4-10a: 向量不可用时降级到词法搜索", async () => {
  const sequentialExecutor: SequentialSearchExecutor = {
    search: async () => ({
      results: [
        { evidenceRefId: "ev-seq-1", score: 0.8, sectionPath: ["root"] },
      ],
    }),
  };

  const lexicalExecutor: LexicalSearchExecutor = {
    search: async () => ({
      results: [
        { evidenceRefId: "ev-lex-1", score: 0.7, sectionPath: ["root"] },
      ],
    }),
  };

  // 没有 vectorExecutor 和 embeddingProvider
  const engine = new HybridSearchEngine({
    vectorExecutor: null,
    lexicalExecutor,
    sequentialExecutor,
    preferredMode: "hybrid",
  });

  const result = await engine.search({
    workspaceId: "ws-1",
    noteVersionId: "nv-1",
    query: "test query",
    topK: 5,
  });

  assert.equal(result.degraded, true, "应标记为降级");
  assert.ok(
    result.retrievalMode === "trigram" || result.retrievalMode === "sequential",
    `检索模式应为 trigram 或 sequential，实际为 ${result.retrievalMode}`,
  );
  assert.ok(result.results.length > 0, "降级后仍应返回结果");
});

test("§17.4-10b: EmbeddingProvider 返回 null 时降级", async () => {
  const sequentialExecutor: SequentialSearchExecutor = {
    search: async () => ({
      results: [
        { evidenceRefId: "ev-seq-1", score: 0.8, sectionPath: ["root"] },
      ],
    }),
  };

  const lexicalExecutor: LexicalSearchExecutor = {
    search: async () => ({
      results: [
        { evidenceRefId: "ev-lex-1", score: 0.7, sectionPath: ["root"] },
      ],
    }),
  };

  // embeddingProvider 返回 null
  const embeddingProvider: EmbeddingProvider = {
    id: "test-embed",
    modelId: "test-model",
    modelRevision: "v1",
    embed: async () => null,
  };

  const engine = new HybridSearchEngine({
    vectorExecutor: null,
    lexicalExecutor,
    sequentialExecutor,
    embeddingProvider,
    preferredMode: "hybrid",
  });

  const result = await engine.search({
    workspaceId: "ws-1",
    noteVersionId: "nv-1",
    query: "test query",
    topK: 5,
  });

  assert.equal(result.degraded, true, "EmbeddingProvider 返回 null 时应降级");
  assert.ok(result.results.length > 0, "降级后仍应返回结果");
});

test("§17.4-10c: 向量搜索成功时不降级", async () => {
  const sequentialExecutor: SequentialSearchExecutor = {
    search: async () => ({
      results: [
        { evidenceRefId: "ev-seq-1", score: 0.8, sectionPath: ["root"] },
      ],
    }),
  };

  const lexicalExecutor: LexicalSearchExecutor = {
    search: async () => ({
      results: [
        { evidenceRefId: "ev-lex-1", score: 0.7, sectionPath: ["root"] },
      ],
    }),
  };

  const vectorExecutor: VectorSearchExecutor = {
    search: async () => ({
      results: [
        { evidenceRefId: "ev-vec-1", score: 0.9, sectionPath: ["root"] },
      ],
      indexCoverage: 1.0,
    }),
  };

  const embeddingProvider: EmbeddingProvider = {
    id: "test-embed",
    modelId: "test-model",
    modelRevision: "v1",
    embed: async () => {
      // 返回有效维度的向量（EMBEDDING_DIMENSIONS = 1024）
      return new Array(1024).fill(0.1);
    },
  };

  const engine = new HybridSearchEngine({
    vectorExecutor,
    lexicalExecutor,
    sequentialExecutor,
    embeddingProvider,
    preferredMode: "hybrid",
  });

  const result = await engine.search({
    workspaceId: "ws-1",
    noteVersionId: "nv-1",
    query: "test query",
    topK: 5,
  });

  assert.equal(result.degraded, false, "向量可用时不应降级");
  assert.equal(result.retrievalMode, "hybrid", "应使用 hybrid 模式");
});

// ─── 11. lease lost、cancel、stale epoch ─────────────────────────────────

test("§17.4-11a: VERIFY 阶段检查 epoch 一致性，stale epoch 被拒绝", () => {
  const ledger = new CoverageLedger();
  initLedgerFromBundlePlan(ledger, [
    { bundleId: "b-1", ordinal: 0, required: true },
  ]);
  ledger.updateAssignment("b-1", "assigned", "unit-1");
  ledger.updateDecision("b-1", "candidate_emitted");

  const budget = new BudgetTracker();
  const report = makeQualityReport();

  // epoch 不匹配
  const verifyInput: VerifyInput = {
    runId: "run-1",
    draftHash: "draft-hash-1",
    qualityReport: report,
    coverageLedger: ledger,
    budgetTracker: budget,
    currentEpoch: 2, // 当前 epoch 是 2
    draftEpoch: 1,   // draft 创建时 epoch 是 1
    candidatePoolHash: "pool-hash-1",
    sourceLedgerHash: "ledger-hash-1",
  };

  const result = executeVerify(verifyInput);

  assert.equal(result.passed, false, "stale epoch 时 VERIFY 应失败");

  const epochCheck = result.checks.find((c) => c.name === "epoch");
  assert.ok(epochCheck, "应有 epoch 检查项");
  assert.equal(epochCheck!.passed, false, "epoch 不匹配时应失败");
});

test("§17.4-11b: 预算耗尽时 BudgetTracker 抛出 BudgetExhaustedError", () => {
  const budget = new BudgetTracker();

  // 耗尽 provider calls
  const maxCalls = budget.getBudget().maxProviderCalls;
  for (let i = 0; i < maxCalls; i++) {
    budget.reserveProviderCall("generation_supervisor");
    budget.settleProviderCall("generation_supervisor", null);
  }

  // 下一次应该抛出异常
  assert.throws(
    () => budget.reserveProviderCall("generation_supervisor"),
    (err: Error) => {
      assert.ok(err instanceof BudgetExhaustedError);
      assert.equal(err.limit, "maxProviderCalls");
      return true;
    },
  );
});

test("§17.4-11b2: reserveTurn + reserveProviderCall 不再受角色级 maxTurns 限制（2026-08-04 设计变更）", () => {
  const budget = new BudgetTracker();
  const maxTurns = budget.getBudget().roles["generation_supervisor"]!.maxTurns;

  // 设计变更：角色级 maxTurns/maxToolCalls 已移除。
  // 角色可无限重试直到成功，防失控由 run 级 maxProviderCalls / runDeadline 兜底。
  // 因此即使 turns 远超原 maxTurns，reserveTurn 也不再抛错。
  for (let i = 0; i < maxTurns * 2; i++) {
    budget.reserveTurn("generation_supervisor");
    budget.reserveProviderCall("generation_supervisor");
    budget.settleProviderCall("generation_supervisor", null);
  }

  // turns 已远超原 maxTurns，但不应再抛 BudgetExhaustedError（角色级上限已移除）
  assert.doesNotThrow(() => budget.reserveTurn("generation_supervisor"));

  // isRoleTurnsExhausted 恒为 false（角色可一直重试）
  assert.equal(
    budget.isRoleTurnsExhausted("generation_supervisor"),
    false,
    "isRoleTurnsExhausted 恒为 false（角色级 maxTurns 已移除）",
  );
});

test("§17.4-11c: 预算恢复后保守 reservation 保持（不因重启消失）", () => {
  const budget = new BudgetTracker();

  // 模拟已经使用了一些预算
  budget.reserveProviderCall("generation_supervisor");
  budget.settleProviderCall("generation_supervisor", {
    promptTokens: 1000,
    completionTokens: 500,
  });

  // 序列化使用量
  const usage = budget.serializeUsage();

  // 创建新的 BudgetTracker 并恢复
  const restored = new BudgetTracker();
  restored.restoreUsage(usage as any);

  // 恢复后的使用量应与之前一致
  const restoredUsage = restored.getUsage();
  assert.equal(restoredUsage.providerCalls, 1, "provider calls 应恢复为 1");
  assert.equal(restoredUsage.inputTokens, 1000, "input tokens 应恢复为 1000");
  assert.equal(restoredUsage.outputTokens, 500, "output tokens 应恢复为 500");
});

// ─── 12. publish response lost ───────────────────────────────────────────

test("§17.4-12a: 工具幂等键确保 publish retry 不重复执行副作用", () => {
  const args = { draftHash: "draft-1", baseLedgerHash: "ledger-1" };

  const key1 = computeToolIdempotencyKey({
    runId: "run-1",
    agentUnitId: "unit-1",
    turnNo: 1,
    toolCallId: "tc-publish-1",
    toolName: "request_verification",
    argsHash: computeArgsHash(args),
  });

  const key2 = computeToolIdempotencyKey({
    runId: "run-1",
    agentUnitId: "unit-1",
    turnNo: 1,
    toolCallId: "tc-publish-1",
    toolName: "request_verification",
    argsHash: computeArgsHash(args),
  });

  // 相同参数应产生相同幂等键 → retry 不会重复执行
  assert.equal(key1, key2, "相同参数的幂等键应一致");
});

test("§17.4-12b: VERIFY 检查 draft hash 绑定，防止 publish 后篡改", () => {
  const ledger = new CoverageLedger();
  initLedgerFromBundlePlan(ledger, [
    { bundleId: "b-1", ordinal: 0, required: true },
  ]);
  ledger.updateAssignment("b-1", "assigned", "unit-1");
  ledger.updateDecision("b-1", "candidate_emitted");

  const budget = new BudgetTracker();
  const report = makeQualityReport({
    draftHash: "different-hash", // 不匹配
  });

  const verifyInput: VerifyInput = {
    runId: "run-1",
    draftHash: "expected-draft-hash",
    qualityReport: report,
    coverageLedger: ledger,
    budgetTracker: budget,
    currentEpoch: 1,
    draftEpoch: 1,
    candidatePoolHash: "pool-hash-1",
    sourceLedgerHash: "ledger-hash-1",
  };

  const result = executeVerify(verifyInput);

  assert.equal(result.passed, false, "draft hash 不匹配时 VERIFY 应失败");

  const hashCheck = result.checks.find((c) => c.name === "draft_hash_binding");
  assert.ok(hashCheck, "应有 draft_hash_binding 检查项");
  assert.equal(hashCheck!.passed, false);
});

// ─── 13. tenant/ref/hash 攻击 ────────────────────────────────────────────

test("§17.4-13a: 候选账本 CAS 机制防止并发修改", () => {
  const ledger = new CandidateLedger();

  const entry: CandidateLedgerEntry = {
    candidateId: "cand-1",
    candidateKind: "extracted",
    bundleId: "bundle-1",
    claim: "Test claim",
    topic: "topic-1",
    cognitiveType: "concept",
    importance: "core",
    sectionKey: "section-1",
    evidenceRefIds: ["ev-1"],
    validationStatus: "pending",
    originUnitId: "unit-1",
    exclusionReason: null,
    groupKey: null,
    derivedCandidateIds: [],
  };

  ledger.addCandidate(entry);
  const currentHash = ledger.getHash();

  // 使用正确的 baseHash 应成功
  assert.doesNotThrow(() => {
    ledger.applyOperation(
      {
        type: "exclude",
        candidateIds: ["cand-1"],
        reasonCode: "duplicate",
        excludeReason: "duplicate content",
      },
      currentHash,
    );
  });

  // 使用错误的 baseHash 应失败（CAS 检查）
  assert.throws(
    () => {
      ledger.applyOperation(
        {
          type: "exclude",
          candidateIds: ["cand-1"],
          reasonCode: "duplicate",
          excludeReason: "duplicate content",
        },
        "wrong-hash",
      );
    },
    /hash|ledger|cas|mismatch/i,
    "错误的 baseHash 应被 CAS 拒绝",
  );
});

test("§17.4-13b: 候选账本合并且保留全部 evidence refIds（证据 union 保护）", () => {
  const ledger = new CandidateLedger();

  const entry1: CandidateLedgerEntry = {
    candidateId: "cand-1",
    candidateKind: "extracted",
    bundleId: "bundle-1",
    claim: "Claim A",
    topic: "topic-1",
    cognitiveType: "concept",
    importance: "core",
    sectionKey: "section-1",
    evidenceRefIds: ["ev-1", "ev-2"],
    validationStatus: "pending",
    originUnitId: "unit-1",
    exclusionReason: null,
    groupKey: null,
    derivedCandidateIds: [],
  };

  const entry2: CandidateLedgerEntry = {
    candidateId: "cand-2",
    candidateKind: "extracted",
    bundleId: "bundle-1",
    claim: "Claim A (duplicate)",
    topic: "topic-1",
    cognitiveType: "concept",
    importance: "core",
    sectionKey: "section-1",
    evidenceRefIds: ["ev-2", "ev-3"],
    validationStatus: "pending",
    originUnitId: "unit-2",
    exclusionReason: null,
    groupKey: null,
    derivedCandidateIds: [],
  };

  ledger.addCandidate(entry1);
  ledger.addCandidate(entry2);
  const hash2 = ledger.getHash();

  // 合并操作应保留所有 evidence refIds
  const result = ledger.applyOperation(
    {
      type: "merge",
      candidateIds: ["cand-1", "cand-2"],
      reasonCode: "semantic_duplicate",
      mergedClaim: "Claim A",
    },
    hash2,
  );

  // 获取合并后的候选
  const merged = ledger.getCandidate(result.resultCandidateId);
  assert.ok(merged, "合并后的候选应存在");

  // 证据 union：应包含 ev-1, ev-2, ev-3
  assert.ok(
    merged!.evidenceRefIds.includes("ev-1"),
    "合并后应保留 ev-1",
  );
  assert.ok(
    merged!.evidenceRefIds.includes("ev-2"),
    "合并后应保留 ev-2",
  );
  assert.ok(
    merged!.evidenceRefIds.includes("ev-3"),
    "合并后应保留 ev-3",
  );
});

test("§17.4-13c: 覆盖率账本拒绝更新不存在的 bundle", () => {
  const ledger = new CoverageLedger();
  initLedgerFromBundlePlan(ledger, [
    { bundleId: "b-1", ordinal: 0, required: true },
  ]);

  // 尝试更新不存在的 bundle
  assert.throws(
    () => ledger.updateAssignment("b-nonexistent", "assigned"),
    /不存在/,
    "应拒绝更新不存在的 bundle",
  );

  assert.throws(
    () => ledger.updateDecision("b-nonexistent", "candidate_emitted"),
    /不存在/,
    "应拒绝更新不存在的 bundle",
  );
});

// ─── 14. prompt injection ────────────────────────────────────────────────

test("§17.4-14a: Supervisor 系统提示标记正文为 untrusted source data", () => {
  const prompt = buildSupervisorSystemPrompt({
    density: "standard",
    noteTitle: "Test Note",
    budgetSummary: "turns=20, tokens=100000",
  });

  // 检查关键安全策略是否在 prompt 中
  assert.ok(
    prompt.includes("untrusted") || prompt.includes("不可信"),
    "系统 prompt 应标记正文为 untrusted source data",
  );

  // 检查不输出思考链
  assert.ok(
    prompt.includes("不输出思考链") || prompt.includes("chain-of-thought"),
    "系统 prompt 应禁止输出 chain-of-thought",
  );

  // 检查只使用工具返回的 evidence ID
  assert.ok(
    prompt.includes("opaque evidence ID") || prompt.includes("证据引用"),
    "系统 prompt 应强调只使用 opaque evidence ID",
  );
});

test("§17.4-14b: Supervisor 系统提示包含核心安全约束", () => {
  const prompt = buildSupervisorSystemPrompt({
    density: "complete",
    noteTitle: "Security Test",
    budgetSummary: "turns=10, tokens=50000",
  });

  // 检查核心约束
  const constraints = [
    "独立 Critic",          // G7: Critic 独立且强制
    "一次修复",             // Repair 最多一次
    "不可变草稿",           // Draft 不可变
    "顺序领取",             // 不能跳过 bundle
  ];

  for (const constraint of constraints) {
    assert.ok(
      prompt.includes(constraint),
      `系统 prompt 应包含安全约束: ${constraint}`,
    );
  }
});

test("§17.4-14c: Supervisor 不能修改 coverage、tool allowlist、budget 等规则", () => {
  // 通过工具注册表验证 Supervisor 没有修改规则的工具
  const supervisorTools = toolRegistry.getAllowedToolNames("generation_supervisor");

  // Supervisor 不应有修改 coverage 规则的工具
  assert.ok(
    !supervisorTools.includes("modify_coverage_rules"),
    "Supervisor 不应有修改 coverage 规则的工具",
  );

  // Supervisor 不应有修改 tool allowlist 的工具
  assert.ok(
    !supervisorTools.includes("modify_tool_allowlist"),
    "Supervisor 不应有修改 tool allowlist 的工具",
  );

  // Supervisor 不应有修改 budget 的工具
  assert.ok(
    !supervisorTools.includes("modify_budget"),
    "Supervisor 不应有修改 budget 的工具",
  );

  // Supervisor 不应有直接发布（绕过 VERIFY）的工具
  assert.ok(
    !supervisorTools.includes("publish_card_set"),
    "Supervisor 不应有直接发布 Card Set 的工具（G9: Agent 只写 staging）",
  );
});

// ─── 额外: VERIFY 完整性检查 ─────────────────────────────────────────────

test("VERIFY 所有 14 项检查都执行", () => {
  const ledger = new CoverageLedger();
  initLedgerFromBundlePlan(ledger, [
    { bundleId: "b-1", ordinal: 0, required: true },
  ]);
  ledger.updateAssignment("b-1", "assigned", "unit-1");
  ledger.updateDecision("b-1", "candidate_emitted");
  // P1-09: candidate_emitted 的 bundle 必须有存活候选（candidateCount > 0）
  ledger.updateCandidateCount("b-1", 1);

  const budget = new BudgetTracker();
  const report = makeQualityReport();

  const verifyInput: VerifyInput = {
    runId: "run-1",
    draftHash: "draft-hash-1",
    qualityReport: report,
    coverageLedger: ledger,
    budgetTracker: budget,
    currentEpoch: 1,
    draftEpoch: 1,
    candidatePoolHash: "pool-hash-1",
    sourceLedgerHash: "ledger-hash-1",
    draftCandidateIds: ["cand-1"],
  };

  const result = executeVerify(verifyInput);

  // P0-03 修复：应有 14 项检查（原 10 项 + 新增 4 项 fail-closed 检查）
  const expectedChecks = [
    "coverage",
    "draft_hash_binding",
    "critic_verdict",
    "candidate_pool_hash",
    "source_ledger_hash",
    "budget",
    "epoch",
    "bundle_coverage",
    "no_unsupported_claims",
    "deterministic_status",
    // P0-03 新增检查
    "non_empty_verdicts",
    "no_auto_verified",
    "verdict_candidate_coverage",
    "no_partial_verdicts",
  ];

  assert.equal(
    result.checks.length,
    expectedChecks.length,
    `应有 ${expectedChecks.length} 项检查，实际有 ${result.checks.length} 项`,
  );

  for (const name of expectedChecks) {
    const check = result.checks.find((c) => c.name === name);
    assert.ok(check, `应有检查项: ${name}`);
  }

  // 所有检查都应通过
  assert.equal(result.passed, true, "所有检查通过时 VERIFY 应通过");
});

// ─── 额外: bundle planner 不变量验证 ─────────────────────────────────────

test("bundle planner: 每个 primary evidence 恰好属于一个 owning bundle (G3)", () => {
  const evidence = [
    makeEvidence("ev-1", 0, 500, ["section-a"]),
    makeEvidence("ev-2", 1, 500, ["section-a"]),
    makeEvidence("ev-3", 2, 500, ["section-b"]),
    makeEvidence("ev-4", 3, 500, ["section-b"]),
  ];

  const result = planBundles(evidence, DEFAULT_BUNDLE_PLANNER_CONFIG);

  // 每个 evidence 恰好属于一个 bundle
  for (const ev of evidence) {
    const owningBundles = result.bundles.filter(
      (b) => b.memberEvidenceIds.includes(ev.refId),
    );
    assert.equal(
      owningBundles.length,
      1,
      `evidence ${ev.refId} 应恰好属于一个 bundle，实际属于 ${owningBundles.length} 个`,
    );
  }

  // primaryOwnership 映射应一致
  for (const ev of evidence) {
    assert.ok(
      result.primaryOwnership.has(ev.refId),
      `evidence ${ev.refId} 应在 primaryOwnership 中`,
    );
  }
});

test("bundle planner: 短内容不被单独排除", () => {
  const evidence = [
    makeEvidence("ev-1", 0, 500, ["section-a"], false),
    makeEvidence("ev-2", 1, 50, ["section-a"], true),  // 短内容
    makeEvidence("ev-3", 2, 500, ["section-a"], false),
  ];

  const result = planBundles(evidence, DEFAULT_BUNDLE_PLANNER_CONFIG);

  // 短内容应被包含在 bundle 中
  assert.ok(
    result.primaryOwnership.has("ev-2"),
    "短内容 ev-2 应被分配到 bundle",
  );
  assert.equal(result.unassigned.length, 0, "不应有未分配的 evidence");
});
