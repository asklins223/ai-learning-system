/**
 * 方案 20 — LLM 自然态全用户旅程 E2E（零 force* 代设）。
 *
 * 确定性 E2E（card-generation-v2-e2e-subset.integration.ts）中 C23/C25/C5 由
 * 测试代设 review_ready/passed/keep 状态（注释明确"代表 LLM 模式下审核完成的
 * 自然状态"）；本文件补上真实 LLM 模式下的**自然用户旅程**，全部走真实服务与
 * 真实表：
 *
 *   真实四阶段 LLM 管道（planner/author/grounding/pedagogy 独立真实调用，
 *   平台 = config/ai-platforms.json capabilities.agent_turn，当前
 *   opencode-go/muse-spark-1.3-contributor）
 *     → run: review_ready（自然态：候选 qs=passed、review_decision=undecided、
 *       binding plan 行由 assembler 真实落库，无任何 UPDATE 代设）
 *     → §13.1 eligibility 复验实证：撤销一条绑定证据 → 激活被 409
 *       evidence_revoked 拒绝且 0 receipt 副作用；恢复 usable → 激活成功
 *     → 真实 keep 动作（handleCandidateActionV2，reviewDraftRevision CAS bump）
 *     → 真实激活（activateCardCandidatesV2：幂等重放同 receipt；重激活 409
 *       invalid_state）
 *     → 断言 receipt 恰一 canonical mapping / learning_cards_v2 active /
 *       learning_objective_revisions_v2.evidenceBindings（§14.3 机械映射保留
 *       证据身份，bindingHash 真实）/ learning_objective_evidence_bindings_v2 /
 *       Initial Validation Reminder ready / 0 review_schedules（C25）/
 *       card_v2_post_activation outbox 恰一 / run=activated
 *     → C5 自然态：PREPARE 冻结 LearningTargetSnapshotV2（subject=objectiveId），
 *       幂等重放同 run+snapshot，0 排程（trusted Commit 才创建）
 *
 * 运行（从仓库根，**必须单文件执行**——worker outbox claim 是全局的，
 * 多文件同进程会互相抢 job；且 config/ai-platforms.json 按 CWD 解析）：
 *   node --import tsx --test --test-concurrency=1 \
 *     workers/ai-worker/src/integration-tests/card-generation-v2-llm-natural-activation.integration.ts
 *
 * 说明：
 * - 本文件在模块顶层加载仓库根 .env（worker 不自动加载真实 provider key）并把
 *   CARD_GENERATION_V2_LLM 置为 "true"。
 * - 需要真实网络 + 配置平台可用（当前 opencode-go/muse-spark-1.3-contributor）。
 * - 整个 LLM 管道是分钟级（单 job 30min 租约，poll 超时同租约时长），
 *   等待终态上限 20 分钟；平台 503/空输出按 retryable 重试（attempts<3）。
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// ─── 环境准备（模块顶层，先于任何 handler/service 动态 import）─────────────

/** 加载仓库根 .env（仅补齐缺失键；worker 自身不加载 .env）。 */
function loadRepoEnv(): void {
  const candidates = [
    new URL("../../../../.env", import.meta.url),
    new URL("../../../.env", import.meta.url),
    new URL(".env", import.meta.url),
  ];
  for (const url of candidates) {
    let text: string;
    try {
      text = readFileSync(url, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      // 跳过 DATABASE_URL_*：仓库 .env 的数据库键指向 docker 网络内部主机名
      // `postgres`，从宿主机不可达；测试数据库连接必须由命令行 env 或本文件
      // 默认值显式给出（localhost），否则 admin 池会在连接上挂死。
      if (key.startsWith("DATABASE_URL_")) continue;
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
    return;
  }
  throw new Error("repo-root .env not found (needed for real provider keys)");
}
loadRepoEnv();

// LLM 模式 + 单次模型调用超时放宽（默认 300s；tokenrhythm 偶发慢响应）。
process.env.CARD_GENERATION_V2_LLM = "true";
process.env.AI_ENDPOINT_RESPONSE_TIMEOUT_MS ??= "600000";

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR
  ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
// worker 侧以 ailearn_worker 角色消费 outbox（RLS NOBYPASSRLS 验证）。
process.env.DATABASE_URL_WORKER ??= "postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn";
// api service 层（keep/activate/PREPARE）以 ailearn 角色执行。
process.env.DATABASE_URL_API ??= ADMIN_URL;

const admin = postgres(ADMIN_URL, { max: 2 });

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const NOTE_ID = randomUUID();

// R31 实证内容：真实四阶段 LLM 可产出 grounding_passed 的自然候选
//（cue: 什么是机会成本？——正面零泄题、教学转换成立）。
const CONTENT =
  "机会成本是指为了得到某种东西而必须放弃的其他东西的价值；在决策中，选择某方案就意味着放弃次优方案所能带来的收益。";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let seedVersionCounter = 0;

async function seedNote(title: string, content: string): Promise<{ versionId: string }> {
  const versionId = randomUUID();
  const blockId = randomUUID();
  seedVersionCounter += 1;
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`v2-llm-e2e-${USER_ID}@example.invalid`}, 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'V2 LLM E2E')
      ON CONFLICT (id) DO NOTHING`;
    // 同意自迁移 0237 起住在 `user_ai_settings`（按 user_id 键），`workspaces` 上那三列
    // 已被 DROP —— 原来这句 INSERT 从 0237 起就 42703，整份文件自那以后没跑起来过。
    await tx`INSERT INTO user_ai_settings (user_id, consent_version, consent_at)
      VALUES (${USER_ID}, 'v1', now())
      ON CONFLICT (user_id) DO UPDATE SET consent_version = 'v1', consent_at = now()`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, ${title}, ${USER_ID}) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${versionId}, ${NOTE_ID}, ${WORKSPACE_ID}, ${seedVersionCounter}, ${tx.json({ blocks: [{ type: "paragraph", content }] })}, 'v2-llm-e2e-hash', ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal)
      VALUES (${blockId}, ${versionId}, ${WORKSPACE_ID}, 'paragraph', ${content}, 1)
      ON CONFLICT (id) DO NOTHING`;
  });
  return { versionId };
}

async function createRun(versionId: string) {
  const { createGenerationRunV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/generation-run-service.ts"
  );
  return createGenerationRunV2(
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    versionId,
    {
      version: 2,
      noteVersionId: versionId,
      sourceScope: { kind: "whole_note" },
      learningGoal: "understand",
      detailThreshold: "balanced",
      quantity: { kind: "adaptive" },
      clientRequestId: `llm-e2e-${randomUUID()}`,
    },
    `llm-e2e-run-key-${randomUUID()}`,
  );
}

const TERMINAL_STATUSES = new Set([
  "review_ready", "no_cards_recommended", "needs_attention",
  "activated", "closed_without_activation", "failed", "cancelled", "stale",
]);

/** 轮询：claim+处理 outbox job（含 retryable 重试），直到 run 进入终态。 */
async function waitForV2RunTerminal(runId: string, timeoutMs = 20 * 60_000): Promise<string> {
  const { pollV2Outbox } = await import("../handlers/card-generation-v2-handler.ts");
  const startedAt = Date.now();
  let lastLog = "";
  for (;;) {
    await pollV2Outbox(5).catch((err: unknown) => {
      console.error("[llm-e2e] pollV2Outbox error", String(err));
      return 0;
    });
    const rows = await admin`SELECT status FROM card_generation_runs_v2 WHERE id = ${runId}`;
    const status = rows[0]?.status as string | undefined;
    if (status && TERMINAL_STATUSES.has(status)) return status;
    if (Date.now() - startedAt > timeoutMs) break;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const log = `[llm-e2e] ${elapsed}s run=${status ?? "?"}`;
    if (log !== lastLog) {
      console.error(log);
      lastLog = log;
    }
    await sleep(5000);
  }
  const jobRows = await admin`
    SELECT status, attempts, last_error FROM card_generation_run_outbox_v2
    WHERE run_id = ${runId}`;
  console.error("[llm-e2e] timeout; outbox jobs:", JSON.stringify(jobRows));
  throw new Error(`LLM pipeline did not reach a terminal state within ${timeoutMs / 60000} min`);
}

before(async () => {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`v2-llm-e2e-${USER_ID}@example.invalid`}, 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'V2 LLM E2E')
      ON CONFLICT (id) DO NOTHING`;
    // 同意自迁移 0237 起住在 `user_ai_settings`（按 user_id 键），`workspaces` 上那三列
    // 已被 DROP —— 原来这句 INSERT 从 0237 起就 42703，整份文件自那以后没跑起来过。
    await tx`INSERT INTO user_ai_settings (user_id, consent_version, consent_at)
      VALUES (${USER_ID}, 'v1', now())
      ON CONFLICT (user_id) DO UPDATE SET consent_version = 'v1', consent_at = now()`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
  });
});

after(async () => {
  await admin`DELETE FROM card_generation_runs_v2 WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM notes WHERE id = ${NOTE_ID}`.catch(() => undefined);
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM workspaces WHERE id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM users WHERE id = ${USER_ID}`.catch(() => undefined);
  await admin.end({ timeout: 5 });
  const { closeDatabase } = await import("../../../../apps/api/src/db/client.ts");
  await closeDatabase().catch(() => undefined);
  const { closeDatabase: closeWorkerDatabase } = await import("../db.ts");
  await closeWorkerDatabase().catch(() => undefined);
});

const HEX64 = /^[0-9a-f]{64}$/;

test("LLM 自然态全用户旅程：真实四阶段 → review_ready → §13.1 复验 → keep → 激活 → C5 PREPARE",
  { timeout: 25 * 60_000 },
  async () => {
    // ── 1. 真实 LLM 管道 → 自然 review_ready ─────────────────────────────
    // 平台抖动容错：tokenrhythm 偶发 503/空输出/超时（R26–R31 已实证），
    // grounding 单次失败即 fail-closed（候选 failed → needs_attention，管道
    // 行为正确）。E2E 在 run 未达 review_ready 时换新 note/run 重试（≤3 次），
    // 每次重试前打印事件与候选诊断；needs_attention/no_cards_recommended 的
    // 失败路径本身已有确定性套件 C02/C03/C07/C12/C13/C36 覆盖。
    let runId = "";
    let terminal = "";
    let versionId = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const seeded = await seedNote("LLM自然激活", CONTENT);
      versionId = seeded.versionId;
      runId = (await createRun(versionId)).runId;
      terminal = await waitForV2RunTerminal(runId);
      if (terminal === "review_ready") break;
      const ev = await admin`
        SELECT event_type, left(payload::text, 160) AS payload
        FROM card_generation_events_v2
        WHERE run_id = ${runId} AND workspace_id = ${WORKSPACE_ID} ORDER BY event_seq`;
      const cands = await admin`
        SELECT count(*)::int AS n, quality_state FROM card_generation_candidates_v2
        WHERE run_id = ${runId} AND workspace_id = ${WORKSPACE_ID} GROUP BY quality_state`;
      console.error(`[llm-e2e] attempt ${attempt}/3 terminal=${terminal} (平台抖动或 fail-closed；重试)`,
        JSON.stringify({ events: ev, candidates: cands }));
      if (attempt === 3) {
        assert.equal(terminal, "review_ready",
          `LLM 管道 3 次尝试均未自然到达 review_ready（最后 ${terminal}）——平台不可用或候选持续 fail-closed`);
      }
    }

    const outboxJob = await admin`
      SELECT status, attempts, last_error FROM card_generation_run_outbox_v2
      WHERE run_id = ${runId} ORDER BY created_at LIMIT 1`;
    assert.equal(outboxJob[0]?.status, "completed", "LLM 管道 job 必须 completed");

    // ── 2. 自然候选状态（零代设）─────────────────────────────────────────
    const passed = await admin`
      SELECT candidate_id, candidate_revision_id, revision, candidate_revision_hash,
             quality_state, review_decision, publish_state, evidence_set_hash,
             evidence_binding_plan_hash
      FROM card_generation_candidates_v2
      WHERE run_id = ${runId} AND workspace_id = ${WORKSPACE_ID} AND quality_state = 'passed'
      ORDER BY revision`;
    assert.ok(passed.length >= 1, "LLM 自然态必须至少 1 个 passed 候选");
    for (const c of passed) {
      assert.equal(c.quality_state, "passed", "候选必须自然通过门禁");
      assert.equal(c.review_decision, "undecided", "自然态 review_decision 必须为 undecided（未代设 keep）");
      assert.equal(c.publish_state, "unpublished", "自然态候选必须未发布");
      assert.ok(HEX64.test(c.evidence_set_hash), "evidence_set_hash 必须为 64-hex");
      assert.ok(HEX64.test(c.evidence_binding_plan_hash), "自然态候选必须携带 binding plan hash");
    }

    // ── 3. 自然 binding plan（assembler 真实落库，§14.3 完整闭包）──────────
    const revIds = passed.map((c) => c.candidate_revision_id);
    const planRows = await admin`
      SELECT candidate_revision_id, binding_plan_id, binding_plan_hash, target_unit_bindings
      FROM candidate_evidence_binding_plans_v2
      WHERE workspace_id = ${WORKSPACE_ID} AND candidate_revision_id IN ${admin(revIds)}`;
    assert.equal(planRows.length, passed.length, "每个 passed 候选必须恰一 binding plan 行");
    const planByRev = new Map(planRows.map((r) => [r.candidate_revision_id, r]));
    const boundSnapshotIds = new Set<string>();
    for (const c of passed) {
      const plan = planByRev.get(c.candidate_revision_id);
      assert.ok(plan, "passed 候选必须有 binding plan");
      assert.equal(plan.binding_plan_hash, c.evidence_binding_plan_hash,
        "plan 行 hash 必须与候选 evidence_binding_plan_hash 一致");
      const bindings = plan.target_unit_bindings as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(bindings) && bindings.length >= 1,
        "binding plan 必须含至少 1 条绑定");
      for (const b of bindings) {
        // R32 修复实证：assembler 必须持久化完整 binding 条目（含证据身份），
        // 不能只落 targetUnit——否则激活端 §14.3 机械映射丢失 evidenceSnapshotId。
        const unit = b.targetUnit as { kind: string } | undefined;
        assert.ok(unit && typeof unit.kind === "string", "条目必须含 targetUnit.kind");
        assert.ok(typeof b.evidenceSnapshotId === "string" && b.evidenceSnapshotId,
          "R32：条目必须含 evidenceSnapshotId（证据身份不得丢失）");
        assert.ok(typeof b.evidenceSnapshotHash === "string" && HEX64.test(b.evidenceSnapshotHash),
          "条目必须含 64-hex evidenceSnapshotHash");
        assert.ok(typeof b.relation === "string", "条目必须含 relation");
        assert.ok(typeof b.supportStrength === "string", "条目必须含 supportStrength");
        assert.ok(typeof b.semanticSupportReportId === "string", "条目必须含 semanticSupportReportId");
        assert.ok(typeof b.semanticSupportReportHash === "string" && HEX64.test(b.semanticSupportReportHash),
          "条目必须含 64-hex semanticSupportReportHash");
        boundSnapshotIds.add(b.evidenceSnapshotId as string);
      }
    }
    const uniqueSnapshots = [...boundSnapshotIds];
    assert.ok(uniqueSnapshots.length >= 1, "绑定证据集非空");

    // ── 4. §13.1 eligibility：绑定证据必须全部 usable ────────────────────
    const eligRows = await admin`
      SELECT evidence_snapshot_id, status FROM evidence_eligibility_states_v2
      WHERE workspace_id = ${WORKSPACE_ID} AND evidence_snapshot_id IN ${admin(uniqueSnapshots)}`;
    assert.equal(eligRows.length, uniqueSnapshots.length, "每个绑定证据都应有 eligibility 行");
    for (const e of eligRows) {
      assert.equal(e.status, "usable", `绑定证据 ${e.evidence_snapshot_id} 必须 usable`);
    }

    // ── 5. run/plan 行（激活请求素材）─────────────────────────────────────
    const runRows = await admin`
      SELECT review_draft_revision, card_content_epoch, source_snapshot_hash,
             semantic_spec_hash, input_snapshot_hash
      FROM card_generation_runs_v2 WHERE id = ${runId} AND workspace_id = ${WORKSPACE_ID}`;
    const runRow = runRows[0];
    const planRowsLatest = await admin`
      SELECT plan_revision_id, plan_version, plan_hash FROM card_generation_plans_v2
      WHERE run_id = ${runId} AND workspace_id = ${WORKSPACE_ID}
      ORDER BY plan_version DESC LIMIT 1`;
    const plan = planRowsLatest[0];
    assert.ok(plan, "激活需要 plan 行");
    const runEpoch = Number(runRow.card_content_epoch);
    const planVersion = Number(plan.plan_version);

    // ── 6. §13.1 复验实证：撤销证据 → evidence_revoked；恢复 → 可激活 ──────
    const probeSnapshot = uniqueSnapshots[0];
    const { activateCardCandidatesV2 } = await import(
      "../../../../apps/api/src/modules/card-generation-v2/activation-service.ts"
    );
    const { computeClientReviewHashV2 } = await import(
      "../../../../packages/shared/src/card-generation-v2-hashing.ts"
    );

    async function buildActivationRequest(selected: typeof passed, expectedRev: number) {
      const { parseActivateCardCandidatesRequestV2 } = await import(
        "../../../../packages/shared/src/card-generation-v2-contracts.ts"
      );
      const reportRows = await admin`
        SELECT candidate_revision_id, report_hash FROM card_candidate_quality_reports_v2
        WHERE run_id = ${runId} AND workspace_id = ${WORKSPACE_ID}
          AND candidate_revision_id IN ${admin(revIds)}`;
      const hashesByRev = new Map<string, string[]>();
      for (const r of reportRows) {
        const list = hashesByRev.get(r.candidate_revision_id) ?? [];
        if (HEX64.test(r.report_hash) && !list.includes(r.report_hash)) list.push(r.report_hash);
        hashesByRev.set(r.candidate_revision_id, list);
      }
      const clientReviewHash = computeClientReviewHashV2({
        runId,
        expectedReviewDraftRevision: expectedRev,
        selected: selected.map((c) => ({
          candidateId: c.candidate_id,
          revision: Number(c.revision),
          revisionHash: c.candidate_revision_hash,
        })),
        reviewUiContractVersion: "review-ui-v1",
      });
      return parseActivateCardCandidatesRequestV2({
        version: 2,
        runId,
        sourceSnapshotHash: runRow.source_snapshot_hash,
        semanticSpecHash: runRow.semantic_spec_hash,
        inputSnapshotHash: runRow.input_snapshot_hash,
        expectedCardContentEpoch: runEpoch,
        planRevisionId: plan.plan_revision_id,
        expectedPlanVersion: planVersion,
        planHash: plan.plan_hash,
        selectedCandidates: selected.map((c) => ({
          candidateRevisionId: c.candidate_revision_id,
          candidateId: c.candidate_id,
          revision: Number(c.revision),
          revisionHash: c.candidate_revision_hash,
          candidateEvidenceBindingPlanHash: c.evidence_binding_plan_hash,
          qualityReportHashes: hashesByRev.get(c.candidate_revision_id) ?? [],
          intent: { kind: "create_new" },
        })),
        existingLifecycleActions: [],
        expectedReviewDraftRevision: expectedRev,
        clientReviewHash,
      });
    }

    const probeRev = Number(runRow.review_draft_revision);
    const probeRequest = await buildActivationRequest(passed, probeRev);
    const probeKey = `llm-e2e-revoke-probe-${randomUUID()}`;
    await admin`
      UPDATE evidence_eligibility_states_v2 SET status = 'revoked', updated_at = now()
      WHERE workspace_id = ${WORKSPACE_ID} AND evidence_snapshot_id = ${probeSnapshot}`;
    await assert.rejects(
      activateCardCandidatesV2({ workspaceId: WORKSPACE_ID, userId: USER_ID }, probeRequest, probeKey),
      (err: unknown) => (err as { code?: string }).code === "evidence_revoked",
      "§13.1：撤销绑定证据后激活必须被 evidence_revoked 拒绝",
    );
    const probeReceipts = await admin`
      SELECT count(*)::int AS n FROM card_activation_receipts_v2
      WHERE workspace_id = ${WORKSPACE_ID} AND idempotency_key = ${probeKey}`;
    assert.equal(probeReceipts[0].n, 0, "被拒激活不得产生 receipt 副作用");
    const runAfterProbe = await admin`SELECT status FROM card_generation_runs_v2 WHERE id = ${runId}`;
    assert.equal(runAfterProbe[0].status, "review_ready", "被拒激活不得改变 run 状态");
    await admin`
      UPDATE evidence_eligibility_states_v2 SET status = 'usable', updated_at = now()
      WHERE workspace_id = ${WORKSPACE_ID} AND evidence_snapshot_id = ${probeSnapshot}`;

    // ── 7. 真实 keep（用户审核通过，reviewDraftRevision CAS bump）─────────
    const { handleCandidateActionV2 } = await import(
      "../../../../apps/api/src/modules/card-generation-v2/candidate-review-service.ts"
    );
    for (const c of passed) {
      const cur = await admin`
        SELECT review_draft_revision FROM card_generation_runs_v2 WHERE id = ${runId}`;
      await handleCandidateActionV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        {
          version: 2,
          runId,
          expectedCardContentEpoch: runEpoch,
          expectedPlanVersion: planVersion,
          expectedPlanHash: plan.plan_hash,
          expectedReviewDraftRevision: Number(cur[0].review_draft_revision),
          action: {
            type: "keep",
            candidateId: c.candidate_id,
            expectedRevision: Number(c.revision),
            expectedRevisionHash: c.candidate_revision_hash,
          },
        },
        `llm-e2e-keep-${randomUUID()}`,
      );
    }
    const kept = await admin`
      SELECT count(*)::int AS n FROM card_generation_candidates_v2
      WHERE run_id = ${runId} AND workspace_id = ${WORKSPACE_ID} AND review_decision = 'keep'`;
    assert.equal(kept[0].n, passed.length, "keep 后全部 passed 候选必须为 keep");
    const runAfterKeep = await admin`
      SELECT review_draft_revision FROM card_generation_runs_v2 WHERE id = ${runId}`;
    const finalReviewDraftRevision = Number(runAfterKeep[0].review_draft_revision);
    assert.equal(finalReviewDraftRevision, probeRev + passed.length,
      "每个 keep 必须 bump reviewDraftRevision");

    // ── 8. 真实激活 ───────────────────────────────────────────────────────
    const request = await buildActivationRequest(passed, finalReviewDraftRevision);
    const activateKey = `llm-e2e-activate-${randomUUID()}`;
    const receipt = await activateCardCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      request,
      activateKey,
    );
    assert.equal(receipt.mappings.length, passed.length,
      "激活必须为每个选中候选产生恰一 canonical mapping");
    const mappingByRev = new Map(
      receipt.mappings.map((m) => [m.candidateRevisionId, m]),
    );
    for (const c of passed) {
      const m = mappingByRev.get(c.candidate_revision_id);
      assert.ok(m, "每个 passed 候选必须有 mapping");
      assert.ok(m.cardId && m.objectiveId && m.objectiveRevisionId, "mapping 必须携带 card+objective");
      assert.equal(m.publicationRevision, 1, "新卡 publicationRevision 必须为 1");
      assert.equal(m.candidateEvidenceBindingPlanHash, c.evidence_binding_plan_hash,
        "receipt 必须携带真实 binding plan hash");
    }

    // 幂等重放：同 Idempotency-Key → 同 receipt，不新建
    const replay = await activateCardCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      request,
      activateKey,
    );
    assert.equal(replay.receiptId, receipt.receiptId, "同 key 重放必须返回同 receipt");
    const receiptRows = await admin`
      SELECT count(*)::int AS n FROM card_activation_receipts_v2
      WHERE workspace_id = ${WORKSPACE_ID} AND idempotency_key = ${activateKey}`;
    assert.equal(receiptRows[0].n, 1, "每个 idempotency key 恰一 receipt");

    // 重激活（不同 key）→ 409 invalid_state（run 已 activated）
    await assert.rejects(
      activateCardCandidatesV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        request,
        `llm-e2e-second-activate-${randomUUID()}`,
      ),
      (err: unknown) => (err as { code?: string }).code === "invalid_state",
      "已 activated 的 run 不得再次激活",
    );

    // ── 9. 激活副作用断言 ────────────────────────────────────────────────
    const runState = await admin`SELECT status FROM card_generation_runs_v2 WHERE id = ${runId}`;
    assert.equal(runState[0].status, "activated", "run 必须终态 activated");

    const cardRows = await admin`
      SELECT card_id, objective_id, lifecycle, presentation_hash, public_summary, front
      FROM learning_cards_v2
      WHERE workspace_id = ${WORKSPACE_ID} AND card_id IN ${admin(receipt.mappings.map((m) => m.cardId))}`;
    assert.equal(cardRows.length, receipt.mappings.length, "每张卡必须有 learning_cards_v2 行");
    for (const row of cardRows) {
      assert.equal(row.lifecycle, "active", "激活卡 lifecycle 必须 active");
      assert.ok(HEX64.test(row.presentation_hash), "卡必须携带 presentation_hash");
      assert.ok(String(row.public_summary ?? "").length > 0, "卡必须携带 public_summary");
      const front = row.front as { cue?: string; prompt?: string };
      assert.ok(String(front.cue ?? "").length > 0 && String(front.prompt ?? "").length > 0,
        "卡 front 必须含 cue/prompt（真实教学转换内容）");
    }

    const pubRows = await admin`
      SELECT card_id, publication_revision, public_payload_hash, reveal_payload_hash
      FROM learning_card_publication_revisions_v2
      WHERE workspace_id = ${WORKSPACE_ID} AND card_id IN ${admin(receipt.mappings.map((m) => m.cardId))}`;
    assert.equal(pubRows.length, receipt.mappings.length, "每张卡必须恰一 publication revision");
    for (const p of pubRows) {
      assert.equal(Number(p.publication_revision), 1, "publication revision 必须为 1");
      assert.ok(HEX64.test(p.public_payload_hash) && HEX64.test(p.reveal_payload_hash),
        "public/reveal payload hash 必须为 64-hex");
    }

    const objRows = await admin`
      SELECT objective_id, lifecycle, current_revision FROM learning_objectives_v2
      WHERE workspace_id = ${WORKSPACE_ID} AND objective_id IN ${admin(receipt.mappings.map((m) => m.objectiveId))}`;
    assert.equal(objRows.length, receipt.mappings.length, "每个目标必须有 learning_objectives_v2 行");
    for (const o of objRows) {
      assert.equal(o.lifecycle, "active", "objective lifecycle 必须 active");
      assert.equal(Number(o.current_revision), 1, "objective 当前 revision 必须为 1");
    }

    // §14.3 机械映射实证（R32）：revision.evidenceBindings 保留证据身份
    const objRevRows = await admin`
      SELECT objective_id, objective_revision_id, revision, target_revision_hash, private_payload_hash, evidence_bindings
      FROM learning_objective_revisions_v2
      WHERE workspace_id = ${WORKSPACE_ID} AND objective_id IN ${admin(receipt.mappings.map((m) => m.objectiveId))}`;
    assert.equal(objRevRows.length, receipt.mappings.length, "每个目标必须恰一 revision 行");
    for (const r of objRevRows) {
      assert.equal(Number(r.revision), 1, "objective revision 必须为 1");
      assert.ok(HEX64.test(r.target_revision_hash) && HEX64.test(r.private_payload_hash),
        "target/private payload hash 必须为 64-hex");
      const bindings = r.evidence_bindings as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(bindings) && bindings.length >= 1,
        "objective revision 必须含 evidenceBindings（§14.3 机械映射）");
      for (const b of bindings) {
        assert.ok(boundSnapshotIds.has(b.evidenceSnapshotId as string),
          "R32：canonical binding 必须引用真实 sealed evidence snapshot（证据身份不得丢失）");
        assert.ok(HEX64.test(b.bindingHash as string), "bindingHash 必须为 64-hex");
        assert.ok((b.targetUnit as { kind?: string })?.kind, "binding 必须含 targetUnit.kind");
      }
    }

    const bindingRows = await admin`
      SELECT objective_revision_id, evidence_snapshot_id, binding_hash
      FROM learning_objective_evidence_bindings_v2
      WHERE workspace_id = ${WORKSPACE_ID}
        AND objective_revision_id IN ${admin(objRevRows.map((r) => r.objective_revision_id))}`;
    assert.ok(bindingRows.length >= 1, "正式 binding 行必须存在");
    for (const b of bindingRows) {
      assert.ok(boundSnapshotIds.has(b.evidence_snapshot_id),
        "正式 binding 行必须引用真实 sealed evidence snapshot");
      assert.ok(HEX64.test(b.binding_hash), "正式 binding 行必须携带 64-hex binding_hash");
    }

    // Initial Validation Reminder：每目标恰一，ready（无 reveal exposure）
    const ivrRows = await admin`
      SELECT objective_id, user_id, status FROM initial_validation_reminders_v2
      WHERE workspace_id = ${WORKSPACE_ID}
        AND objective_id IN ${admin(receipt.mappings.map((m) => m.objectiveId))}`;
    assert.equal(ivrRows.length, receipt.mappings.length, "每个新 objective 必须恰一 IVR");
    for (const ivr of ivrRows) {
      assert.equal(ivr.user_id, USER_ID, "IVR 必须属于激活用户");
      assert.equal(ivr.status, "ready", "无 reveal exposure 时 IVR 必须 ready");
    }

    // C25：activation 0 Schedule（不伪造排程）
    const scheduleCount = await admin`
      SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${WORKSPACE_ID}`;
    assert.equal(scheduleCount[0].n, 0, "C25：activation 必须创建 0 schedules");

    // outbox 投递：card_v2_post_activation 恰一
    const outboxAfter = await admin`
      SELECT count(*)::int AS n FROM card_generation_run_outbox_v2
      WHERE run_id = ${runId} AND job_type = 'card_v2_post_activation'`;
    assert.equal(outboxAfter[0].n, 1, "激活必须投递恰一 post-activation job");

    // 领域事件
    const events = await admin`
      SELECT DISTINCT event_type FROM card_generation_events_v2
      WHERE run_id = ${runId} AND workspace_id = ${WORKSPACE_ID}`;
    const eventTypes = new Set(events.map((e) => e.event_type as string));
    for (const expected of ["card_candidate.activation_requested", "learning_objective.activated", "learning_card.activated"]) {
      assert.ok(eventTypes.has(expected), `缺少事件 ${expected}`);
    }

    // 选中候选 publish_state → activated
    const activatedCands = await admin`
      SELECT count(*)::int AS n FROM card_generation_candidates_v2
      WHERE run_id = ${runId} AND workspace_id = ${WORKSPACE_ID} AND publish_state = 'activated'`;
    assert.equal(activatedCands[0].n, passed.length, "选中候选必须 publish_state=activated");

    // ── 10. C5 自然态：PREPARE 冻结 LearningTargetSnapshotV2 ─────────────
    const firstMapping = receipt.mappings[0];
    // 历史卡片桥接数据已不需要；
    // V2 createRunV2 直接使用 objectiveId。

    const { createRunV2 } = await import(
      "../../../../apps/api/src/modules/learning-runs/run-service.ts"
    );
    const { withWorkspaceTransaction } = await import(
      "../../../../apps/api/src/db/client.ts"
    );
    const prepareKey = `llm-e2e-prepare-${randomUUID()}`;
    const prepare = await withWorkspaceTransaction(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      (tx) => createRunV2(tx, {
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        request: {
          originV2: { kind: "card", cardId: firstMapping.cardId, objectiveId: firstMapping.objectiveId },
          goal: "stabilize",
          requestedTimeBudgetSeconds: 300,
          idempotencyKey: prepareKey,
        },
      }),
    );
    assert.ok(prepare.runId && prepare.snapshotId, "PREPARE 必须返回 run+snapshot");

    const snapRows = await admin`
      SELECT run_id, objective_id, target_revision_hash FROM learning_target_snapshots_v2
      WHERE snapshot_id = ${prepare.snapshotId} AND workspace_id = ${WORKSPACE_ID}`;
    assert.equal(snapRows.length, 1, "必须恰一 snapshot 行");
    assert.equal(snapRows[0].run_id, prepare.runId, "snapshot 必须绑定 run");
    assert.equal(snapRows[0].objective_id, firstMapping.objectiveId, "snapshot 必须绑定 objective");
    assert.ok(HEX64.test(String(snapRows[0].target_revision_hash)), "snapshot 必须携带 target hash");

    const publicTarget = prepare.frozen.publicTarget as Record<string, unknown>;
    const serialized = JSON.stringify(publicTarget);
    assert.ok(String(publicTarget.publicSummary ?? "").length > 0, "公共投影必须含 public summary");
    assert.ok(!serialized.includes("canonicalAnswer") && !serialized.includes("scoringRubric")
      && !serialized.includes("evidence") && !serialized.includes("learningSupport"),
      "公共投影不得泄漏答案/证据/教学支持");

    // 幂等重放：同 idempotencyKey → 同 run + 同 snapshot
    const replayPrepare = await withWorkspaceTransaction(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      (tx) => createRunV2(tx, {
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        request: {
          originV2: { kind: "card", cardId: firstMapping.cardId, objectiveId: firstMapping.objectiveId },
          goal: "stabilize",
          requestedTimeBudgetSeconds: 300,
          idempotencyKey: prepareKey,
        },
      }),
    );
    assert.equal(replayPrepare.runId, prepare.runId, "幂等重放必须返回同 run");
    const snapCount = await admin`
      SELECT count(*)::int AS n FROM learning_target_snapshots_v2
      WHERE run_id = ${prepare.runId} AND workspace_id = ${WORKSPACE_ID}`;
    assert.equal(snapCount[0].n, 1, "重放不得重复 snapshot");

    // PREPARE 不创建 Schedule（trusted Commit 才创建）
    const prepareSchedules = await admin`
      SELECT count(*)::int AS n FROM review_schedules
      WHERE workspace_id = ${WORKSPACE_ID}
        AND subject_type = 'card' AND subject_id = ${firstMapping.objectiveId}`;
    assert.equal(prepareSchedules[0].n, 0, "PREPARE 不得创建 schedule（trusted Commit 才创建）");
  },
);
