/**
 * Learning Tool Gateway 单测（阶段 03 / W2 任务 03-4）
 *
 * 覆盖（node:test + assert）：
 * - actor 越权工具调用全部被网关拒绝（6 个 LLM 角色 + 2 个 deterministic 角色）；
 * - forbidden product actions（enter-practice / confirm-and-lock / submit / commit）
 *   对任意 actor 拒绝；
 * - 各 actor 允许工具可通过（isToolAllowed true / executeTool 走到 not_implemented）；
 * - epoch 重比较：失配与缺失（provider 缺失 / 字段为 null）→ epoch_mismatch；
 * - public DTO serializer：显式 allowlist 输出、零 private 字段、缺失即省略；
 * - prompt-injection 对抗：伪造 ID（../etc / <script>）与 javascript:/data:text/html
 *   参数被 validateToolArguments 拒绝。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { LearningAgentRole } from "../types.ts";
import {
  LearningToolGateway,
  learningToolGateway,
  filterAllowedToolCalls,
  type LearningEpochProvider,
  type LearningToolExecutionRequest,
  sanitizePublicPayload,
  serializePublicSceneContract,
  serializePublicSessionView,
  PUBLIC_DTO_FORBIDDEN_FIELDS,
  PUBLIC_SCENE_CONTRACT_KEYS,
  PUBLIC_SESSION_VIEW_KEYS,
  validateToolArguments,
} from "./gateway.ts";

// ─── fixtures ─────────────────────────────────────────────────────────────

const RUNTIME_EPOCH = 7;
const EPISODE_EPOCH = 3;

/** epoch 与请求携带值匹配的 provider */
function matchingEpochProvider(): LearningEpochProvider {
  return () => ({ runtimeEpoch: RUNTIME_EPOCH, episodeEpoch: EPISODE_EPOCH });
}

function makeRequest(
  overrides: Partial<LearningToolExecutionRequest> = {},
): LearningToolExecutionRequest {
  return {
    actor: LearningAgentRole.SESSION_SUPERVISOR,
    toolId: "propose_bounded_route",
    args: {},
    idempotencyKey: "idem-1",
    runId: "run-1",
    sessionId: "ses-1",
    episodeId: "ep-1",
    turnNo: 1,
    runtimeEpochSnapshot: RUNTIME_EPOCH,
    episodeEpoch: EPISODE_EPOCH,
    ...overrides,
  };
}

// ─── 1. actor 越权调用全部被网关拒绝 ─────────────────────────────────────

test("越权：session_supervisor 调 submit_scene_staging（Scene Author 专属）被拒", async () => {
  const result = await learningToolGateway.executeTool(
    makeRequest({ toolId: "submit_scene_staging", idempotencyKey: "idem-x" }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "tool_not_allowed");
});

test("越权：scene_author 调 activate_scene_contract（唯一激活权限属 Scene Activation）被拒", async () => {
  const result = await learningToolGateway.executeTool(
    makeRequest({ actor: LearningAgentRole.SCENE_AUTHOR, toolId: "activate_scene_contract" }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "tool_not_allowed");
});

test("越权：rubric_scene_critic 调 render_evidence_card（Grounded Tutor 专属）被拒", async () => {
  const result = await learningToolGateway.executeTool(
    makeRequest({
      actor: LearningAgentRole.RUBRIC_SCENE_CRITIC,
      toolId: "render_evidence_card",
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "tool_not_allowed");
});

test("越权：assessment_critic 调 submit_support_verdict（Answer Critic 专属）被拒", async () => {
  const result = await learningToolGateway.executeTool(
    makeRequest({
      actor: LearningAgentRole.ASSESSMENT_CRITIC,
      toolId: "submit_support_verdict",
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "tool_not_allowed");
});

test("越权：grounded_tutor 调 submit_assessment_verdict（Assessment Critic 专属）被拒", async () => {
  const result = await learningToolGateway.executeTool(
    makeRequest({
      actor: LearningAgentRole.GROUNDED_TUTOR,
      toolId: "submit_assessment_verdict",
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "tool_not_allowed");
});

test("越权：grounded_answer_critic 调 submit_scene_critic_verdict（Rubric/Scene Critic 专属）被拒", async () => {
  const result = await learningToolGateway.executeTool(
    makeRequest({
      actor: LearningAgentRole.GROUNDED_ANSWER_CRITIC,
      toolId: "submit_scene_critic_verdict",
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "tool_not_allowed");
});

test("越权：scene_activation（deterministic）调 existing_domain_commit 被拒", async () => {
  const result = await learningToolGateway.executeTool(
    makeRequest({ actor: LearningAgentRole.SCENE_ACTIVATION, toolId: "existing_domain_commit" }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "tool_not_allowed");
});

test("越权：deterministic_core 调 activate_scene_contract 被拒", async () => {
  const result = await learningToolGateway.executeTool(
    makeRequest({ actor: LearningAgentRole.DETERMINISTIC_CORE, toolId: "activate_scene_contract" }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "tool_not_allowed");
});

test("越权：epoch 匹配时仍先按 allowlist 拒绝（越权优先级最高）", async () => {
  const gateway = new LearningToolGateway(undefined, matchingEpochProvider());
  const result = await gateway.executeTool(
    makeRequest({ actor: LearningAgentRole.SCENE_AUTHOR, toolId: "propose_bounded_route" }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "tool_not_allowed");
});

// ─── 2. forbidden product actions 对任意 actor 拒绝 ──────────────────────

const FORBIDDEN_PRODUCT_ACTIONS = [
  "enter-practice",
  "confirm-and-lock",
  "submit",
  "commit",
] as const;

test("forbidden product actions 对任意 actor 一律拒绝", async () => {
  const actors: readonly LearningAgentRole[] = [
    LearningAgentRole.SESSION_SUPERVISOR,
    LearningAgentRole.SCENE_AUTHOR,
    LearningAgentRole.GROUNDED_TUTOR,
    LearningAgentRole.DETERMINISTIC_CORE,
  ];
  for (const actor of actors) {
    for (const toolId of FORBIDDEN_PRODUCT_ACTIONS) {
      assert.equal(
        learningToolGateway.isToolAllowed(actor, toolId),
        false,
        `${actor} 应被禁止调用 ${toolId}`,
      );
      const result = await learningToolGateway.executeTool(
        makeRequest({ actor, toolId, idempotencyKey: "idem-f" }),
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "tool_not_allowed", `${actor} 调 ${toolId}`);
    }
  }
});

// ─── 3. 允许工具可通过 ────────────────────────────────────────────────────

const ALLOWED_BY_ROLE: Readonly<Record<LearningAgentRole, readonly string[]>> = {
  session_supervisor: ["read_purified_contract_summary", "propose_bounded_route", "propose_probe", "propose_episode_ready", "propose_end", "focus_nodes", "draw_route", "stage_scene"],
  scene_author: ["read_published_claim_evidence", "read_private_rubric_staging", "submit_scene_staging"],
  rubric_scene_critic: ["read_private_scene_staging", "submit_scene_critic_verdict"],
  assessment_critic: ["read_locked_artifact", "read_rubric_target", "read_evidence_refs", "submit_assessment_verdict"],
  grounded_tutor: ["read_current_target_evidence", "render_evidence_card", "render_current_target_scene", "offer_short_explanation"],
  grounded_answer_critic: ["read_tutor_segment", "read_allowlisted_evidence_premises", "read_support_mode", "submit_support_verdict"],
  scene_activation: ["activate_scene_contract"],
  deterministic_core: ["dispatch_independent_assess", "lock_response_artifact", "run_rubric_reducer", "existing_domain_commit", "record_outbox", "consume_schedule"],
};

test("isToolAllowed：每个 actor 的 allowlist 工具全部可通过", () => {
  const actors = Object.keys(ALLOWED_BY_ROLE) as LearningAgentRole[];
  for (const actor of actors) {
    for (const toolId of ALLOWED_BY_ROLE[actor]) {
      assert.equal(learningToolGateway.isToolAllowed(actor, toolId), true, `${actor} 应允许 ${toolId}`);
    }
  }
});

test("isToolAllowed：manifest 之外/未知工具默认拒绝", () => {
  assert.equal(
    learningToolGateway.isToolAllowed(LearningAgentRole.SESSION_SUPERVISOR, "SELECT * FROM users"),
    false,
  );
  assert.equal(learningToolGateway.isToolAllowed(LearningAgentRole.SESSION_SUPERVISOR, "rm -rf /"), false);
  assert.equal(learningToolGateway.isToolAllowed(LearningAgentRole.SCENE_AUTHOR, "http://evil.example/steal"), false);
});

test("允许工具：epoch 匹配 + 幂等键齐全时走到 not_implemented（非越权、非 epoch 拦截）", async () => {
  const gateway = new LearningToolGateway(undefined, matchingEpochProvider());
  for (const actor of Object.keys(ALLOWED_BY_ROLE) as LearningAgentRole[]) {
    for (const toolId of ALLOWED_BY_ROLE[actor]) {
      const result = await gateway.executeTool(
        makeRequest({ actor, toolId, idempotencyKey: "idem-ok" }),
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "not_implemented", `${actor} 调 ${toolId}`);
    }
  }
});

test("允许工具：read_purified_contract_summary 可无幂等键（纯读净化）", async () => {
  const gateway = new LearningToolGateway(undefined, matchingEpochProvider());
  const result = await gateway.executeTool(
    makeRequest({
      actor: LearningAgentRole.SESSION_SUPERVISOR,
      toolId: "read_purified_contract_summary",
      idempotencyKey: null,
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "not_implemented");
});

test("缺少幂等键：合法工具 + epoch 匹配仍被拒（missing_idempotency_key）", async () => {
  const gateway = new LearningToolGateway(undefined, matchingEpochProvider());
  const result = await gateway.executeTool(
    makeRequest({ toolId: "propose_bounded_route", idempotencyKey: null }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "missing_idempotency_key");
});

// ─── 4. epoch 重比较 ──────────────────────────────────────────────────────

test("epoch 失配 → epoch_mismatch（runtimeEpoch 不同）", async () => {
  const gateway = new LearningToolGateway(undefined, () => ({
    runtimeEpoch: RUNTIME_EPOCH + 1,
    episodeEpoch: EPISODE_EPOCH,
  }));
  const result = await gateway.executeTool(makeRequest());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "epoch_mismatch");
});

test("epoch 失配 → epoch_mismatch（episodeEpoch 不同）", async () => {
  const gateway = new LearningToolGateway(undefined, () => ({
    runtimeEpoch: RUNTIME_EPOCH,
    episodeEpoch: EPISODE_EPOCH + 1,
  }));
  const result = await gateway.executeTool(makeRequest());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "epoch_mismatch");
});

test("epoch 缺失：provider 返回 null → epoch_mismatch（fail-closed，默认网关）", async () => {
  // 默认网关未注入 epoch provider，任何合法工具都按缺失拒绝
  const result = await learningToolGateway.executeTool(makeRequest());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "epoch_mismatch");
});

test("epoch 缺失：provider 返回含 null 字段 → epoch_mismatch", async () => {
  const gateway = new LearningToolGateway(undefined, () => ({
    runtimeEpoch: null,
    episodeEpoch: EPISODE_EPOCH,
  }));
  const result = await gateway.executeTool(makeRequest());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "epoch_mismatch");
});

// ─── 5. public DTO serializer（零 private 字段） ──────────────────────────

test("serializePublicSessionView：输出不含 expectedTargetRef/privateSolutionHash/rubricTargets/schedulingDecision/assistanceSnapshot", () => {
  const view = serializePublicSessionView({
    sessionId: "ses-1",
    status: "active",
    currentPhase: "session_agent",
    routeSummary: "route-1",
    episodeIds: ["ep-1", "ep-2"],
    completedEpisodeCount: 1,
    lastActiveAt: "2026-08-08T10:00:00Z",
    // 私有字段：绝不输出
    expectedTargetRef: "ref://expected/rt-1",
    privateSolutionHash: "h-solution-1",
    rubricTargets: [{ id: "rt-1" }],
    schedulingDecision: { strategy: "official" },
    assistanceSnapshot: { provided: true },
  });
  const serialized = JSON.stringify(view);
  for (const field of PUBLIC_DTO_FORBIDDEN_FIELDS) {
    assert.equal(serialized.includes(field), false, `public view 不应包含 ${field}`);
  }
  assert.equal(view.sessionId, "ses-1");
  assert.deepEqual(Object.keys(view).sort(), [...PUBLIC_SESSION_VIEW_KEYS].sort());
  assert.deepEqual(view.episodeIds, ["ep-1", "ep-2"]);
  assert.equal(view.completedEpisodeCount, 1);
});

test("serializePublicSceneContract：输出不含 privateSolutionHash/rubricTargets/expectedTargetRef", () => {
  const view = serializePublicSceneContract({
    sceneId: "scene-1",
    probeId: "probe-1",
    sceneTemplate: "relation_canvas_v1",
    sceneVersion: "1.0.0",
    publicPayloadHash: "h-public-1",
    disclosureProfileHash: "h-disclosure-1",
    templateTrustCeiling: "facet_eligible",
    privateSolutionHash: "h-solution-1",
    rubricTargets: [{ id: "rt-1" }],
    expectedTargetRef: "ref://expected/rt-1",
  });
  const serialized = JSON.stringify(view);
  for (const field of PUBLIC_DTO_FORBIDDEN_FIELDS) {
    assert.equal(serialized.includes(field), false, `scene view 不应包含 ${field}`);
  }
  assert.deepEqual(Object.keys(view).sort(), [...PUBLIC_SCENE_CONTRACT_KEYS].sort());
  assert.equal(view.publicPayloadHash, "h-public-1");
});

test("sanitizePublicPayload：非 allowlist / 私有 / 缺失字段一律不进输出", () => {
  const out = sanitizePublicPayload(
    {
      sessionId: "ses-1",
      status: "active",
      episodeIds: ["ep-1"],
      // 私有字段（即使 allowlist 未包含也不输出）
      schedulingDecision: { x: 1 },
      // 非 allowlist 字段
      extraInternalNote: "secret",
      // 缺失即省略
      routeSummary: undefined,
    },
    ["sessionId", "status", "episodeIds", "schedulingDecision", "routeSummary"],
  );
  assert.deepEqual(out, { sessionId: "ses-1", status: "active", episodeIds: ["ep-1"] });
});

test("sanitizePublicPayload：allowlistKeys 误含私有字段名也不输出（防御）", () => {
  const out = sanitizePublicPayload(
    { sessionId: "ses-1", privateSolutionHash: "h-solution-1" },
    ["sessionId", "privateSolutionHash"],
  );
  assert.deepEqual(out, { sessionId: "ses-1" });
});

test("serializePublicSessionView：必需字段缺失 → 抛错（fail-closed）", () => {
  assert.throws(() => serializePublicSessionView({ status: "active" }), TypeError);
});

// ─── 6. prompt-injection 对抗（validateToolArguments） ────────────────────

test("validateToolArguments：合法 ID（allowlist 内）通过", () => {
  const result = validateToolArguments(
    "submit_scene_staging",
    { probeId: "probe-1", sceneTemplate: "relation_canvas_v1" },
    ["probe-1"],
  );
  assert.deepEqual(result, { ok: true });
});

test("validateToolArguments：伪造 ID（../etc，路径穿越形态）被拒", () => {
  const result = validateToolArguments("propose_probe", { probeId: "../etc" }, ["probe-1"]);
  assert.equal(result.ok, false);
});

test("validateToolArguments：脚本形态 ID（<script>）被拒", () => {
  const result = validateToolArguments(
    "propose_probe",
    { probeId: "<script>alert(1)</script>" },
    ["probe-1"],
  );
  assert.equal(result.ok, false);
});

test("validateToolArguments：javascript: 参数被拒", () => {
  const result = validateToolArguments("render_evidence_card", {
    content: "javascript:alert(1)",
  });
  assert.equal(result.ok, false);
});

test("validateToolArguments：data:text/html 参数被拒", () => {
  const result = validateToolArguments("render_evidence_card", {
    content: "data:text/html,<svg onload=alert(1)>",
  });
  assert.equal(result.ok, false);
});

test("validateToolArguments：大小写不敏感（JaVaScRiPt:）被拒", () => {
  const result = validateToolArguments("render_evidence_card", {
    content: "JaVaScRiPt:alert(document.cookie)",
  });
  assert.equal(result.ok, false);
});

test("validateToolArguments：ID 数组逐元素校验（evidenceRefIds 含非法元素被拒）", () => {
  const ok = validateToolArguments(
    "submit_scene_staging",
    { probeId: "probe-1", rubricEvidenceBindings: { evidenceRefIds: ["ev-1", "ev-2"] } },
    ["probe-1", "ev-1", "ev-2"],
  );
  assert.deepEqual(ok, { ok: true });
  const bad = validateToolArguments(
    "submit_scene_staging",
    { probeId: "probe-1", rubricEvidenceBindings: { evidenceRefIds: ["ev-1", "../../etc/passwd"] } },
    ["probe-1", "ev-1", "ev-2"],
  );
  assert.equal(bad.ok, false);
});

test("validateToolArguments：嵌套对象递归检查", () => {
  const result = validateToolArguments(
    "propose_bounded_route",
    { route: { nodes: [{ id: "node-1", label: "javascript:alert(1)" }] } },
    ["node-1"],
  );
  assert.equal(result.ok, false);
});

test("validateToolArguments：未提供 ID allowlist 时任何 ID 一律拒绝（fail-closed）", () => {
  const result = validateToolArguments("propose_probe", { probeId: "probe-1" });
  assert.equal(result.ok, false);
});

// ─── 7. filterAllowedToolCalls 辅助 ───────────────────────────────────────

test("filterAllowedToolCalls：越权与未知工具调用被剔除，允许的保留", () => {
  const calls = [
    { id: "call-1", name: "propose_bounded_route", arguments: {} },
    { id: "call-2", name: "submit_scene_staging", arguments: {} },
    { id: "call-3", name: "commit", arguments: {} },
    { id: "call-4", name: "SELECT * FROM users", arguments: {} },
  ];
  const allowed = filterAllowedToolCalls(
    learningToolGateway,
    LearningAgentRole.SESSION_SUPERVISOR,
    calls,
  );
  assert.deepEqual(
    allowed.map((c) => c.name),
    ["propose_bounded_route"],
  );
});
