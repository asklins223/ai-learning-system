/**
 * 方案 20 R34 — Evidence Redaction（§15.7/C31 redaction 侧）+ V2 生成配额
 * （§22.6 abuse/resource 防护）集成测试。
 *
 * Redaction 覆盖：
 * 1. tombstone 写入（revision 单调、tombstoneHash 64-hex 闭包）；
 * 2. eligibility 前移（usable → revoked、epoch+1）；
 * 3. 幂等重放（同输入 → 同 tombstoneHash、不新增行）；
 * 4. redaction 后激活被 §13.1 evidence_revoked 拒绝（0 receipt 副作用）；
 * 5. redaction 后 PREPARE 被 §16.2 evidence_not_usable 拒绝（fail closed）。
 *
 * 配额覆盖（§22.6）：
 * 1. workspace 在途并发上限 → 409 generation_concurrency_limit（advisory
 *    lock 串行化，防并发绕过）；
 * 2. 24h 速率上限 → 409 generation_daily_limit；
 * 3. 幂等重放不受配额限制（同 key 返回同 run）。
 *
 * 运行（从仓库根，**必须单文件执行**——worker outbox claim 全局）：
 *   DATABASE_URL_WORKER="postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn" \
 *   DATABASE_URL_API="postgres://ailearn:ailearn_dev@localhost:5432/ailearn" \
 *   node --import ./workers/ai-worker/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 \
 *     workers/ai-worker/src/integration-tests/card-generation-v2-redaction-quota.integration.ts
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR
  ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_WORKER ??= "postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_API ??= ADMIN_URL;

const admin = postgres(ADMIN_URL, { max: 2 });

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
/**
 * 每个用例一篇自己的笔记（2026-09-25，与 `card-generation-v2-e2e-subset` 同一处修法）。
 * 原来整份文件共用一个 `NOTE_ID`，而"这篇笔记已有在制/待审批次"那道守卫按
 * **(笔记, 人)** 判 —— 于是 §15.7 留下的活批次会直接挡住 §22.6 的第一次创建。
 */
const createdNoteIds: string[] = [];

const CONTENT =
  "边际效用递减：在其他条件不变时，随着某种商品消费量的增加，每增加一单位消费所带来的额外满足感（边际效用）逐渐减少。";

let seedVersionCounter = 0;

async function seedNote(title: string, content: string): Promise<{ versionId: string; noteId: string }> {
  const versionId = randomUUID();
  const blockId = randomUUID();
  const noteId = randomUUID();
  createdNoteIds.push(noteId);
  seedVersionCounter += 1;
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`rq-${USER_ID}@example.invalid`}, 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'R34 redaction/quota')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${noteId}, ${WORKSPACE_ID}, ${title}, ${USER_ID})`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${versionId}, ${noteId}, ${WORKSPACE_ID}, ${seedVersionCounter}, ${tx.json({ blocks: [{ type: "paragraph", content }] })}, 'rq-hash', ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal)
      VALUES (${blockId}, ${versionId}, ${WORKSPACE_ID}, 'paragraph', ${content}, 1)
      ON CONFLICT (id) DO NOTHING`;
  });
  return { versionId, noteId };
}

/**
 * 创建一次生成运行，并把**用过的请求体**一并返回。
 *
 * 返回 body 是必需的：§17.1 的幂等语义是"同一 key **且同一 payload** 才 replay"，
 * 而 payload 里含 `clientRequestId`。要构造一次真正的幂等重放，就必须拿回上次那个
 * 请求体；每次现造一个（旧写法）会让服务端正确地判为 `idempotency_conflict`——
 * 那是契约在生效，不是 bug。
 */
async function createRun(versionId: string) {
  const { createGenerationRunV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/generation-run-service.ts"
  );
  const body = {
    version: 2 as const,
    noteVersionId: versionId,
    sourceScope: { kind: "whole_note" as const },
    learningGoal: "understand" as const,
    detailThreshold: "balanced" as const,
    quantity: { kind: "adaptive" as const },
    clientRequestId: `rq-${randomUUID()}`,
  };
  const result = await createGenerationRunV2(
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    versionId,
    body,
    `rq-key-${randomUUID()}`,
  );
  return { ...result, body };
}

async function runPipelineOnce() {
  const { pollV2Outbox } = await import("../handlers/card-generation-v2-handler.ts");
  const processed = await pollV2Outbox(20);
  assert.ok(processed >= 1, `worker must process outbox jobs (got ${processed})`);
  return processed;
}

async function forceReviewReady(runId: string) {
  await admin`
    UPDATE card_generation_runs_v2 SET status = 'review_ready', updated_at = now()
    WHERE id = ${runId} AND workspace_id = ${WORKSPACE_ID}`;
}

async function forceCandidatesPassed(runId: string) {
  await admin`
    UPDATE card_generation_candidates_v2
    SET quality_state = 'passed', review_decision = 'keep', updated_at = now()
    WHERE run_id = ${runId} AND workspace_id = ${WORKSPACE_ID}`;
}

/** 激活首个候选（最小激活，含手动 binding plan 行引用真实 sealed snapshot）。 */
async function activateFirstCandidate(runId: string, snapshotId: string, snapshotHash: string) {
  const { runRow, plan, first } = await loadRunPlan(runId);
  const { computeCandidateEvidenceBindingPlanHashV2, computeClientReviewHashV2 } = await import(
    "../../../../packages/shared/src/card-generation-v2-hashing.ts"
  );
  const bindings = [{
    targetUnit: { kind: "rubric", rubricUnitId: "u1" },
    evidenceSnapshotId: snapshotId,
    evidenceSnapshotHash: snapshotHash,
    relation: "entails",
    supportStrength: "direct",
    semanticSupportReportId: randomUUID(),
    semanticSupportReportHash: "a".repeat(64),
  }];
  const bindingPlanHash = computeCandidateEvidenceBindingPlanHashV2({
    candidateRevisionId: first.candidate_revision_id,
    bindings,
  });
  await admin`
    INSERT INTO candidate_evidence_binding_plans_v2
      (id, workspace_id, binding_plan_id, run_id, candidate_revision_id,
       candidate_revision_hash, plan_revision_id, plan_version, plan_hash,
       target_unit_bindings, binding_plan_hash, evidence_eligibility_vector_hash)
    VALUES (${randomUUID()}, ${WORKSPACE_ID}, ${randomUUID()}, ${runId},
            ${first.candidate_revision_id}, ${first.candidate_revision_hash},
            ${plan.plan_revision_id}, ${plan.plan_version}, ${plan.plan_hash},
            ${JSON.stringify(bindings)}, ${bindingPlanHash}, ${"a".repeat(64)})`;
  const { activateCardCandidatesV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/activation-service.ts"
  );
  const clientReviewHash = computeClientReviewHashV2({
    runId,
    expectedReviewDraftRevision: Number(runRow.review_draft_revision),
    selected: [{ candidateId: first.candidate_id, revision: first.revision, revisionHash: first.candidate_revision_hash }],
    reviewUiContractVersion: "review-ui-v1",
  });
  return activateCardCandidatesV2(
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    {
      version: 2,
      runId,
      sourceSnapshotHash: runRow.source_snapshot_hash,
      semanticSpecHash: runRow.semantic_spec_hash,
      inputSnapshotHash: runRow.input_snapshot_hash,
      expectedCardContentEpoch: Number(runRow.card_content_epoch),
      planRevisionId: plan.plan_revision_id,
      expectedPlanVersion: Number(plan.plan_version),
      planHash: plan.plan_hash,
      selectedCandidates: [{
        candidateRevisionId: first.candidate_revision_id,
        candidateId: first.candidate_id,
        revision: first.revision,
        revisionHash: first.candidate_revision_hash,
        candidateEvidenceBindingPlanHash: bindingPlanHash,
        qualityReportHashes: [],
        intent: { kind: "create_new" } as const,
      }],
      existingLifecycleActions: [],
      expectedReviewDraftRevision: Number(runRow.review_draft_revision),
      clientReviewHash,
    },
    `rq-activate-${randomUUID()}`,
  );
}

async function loadRunPlan(runId: string) {
  const runRows = await admin`
    SELECT review_draft_revision, card_content_epoch, source_snapshot_hash,
           semantic_spec_hash, input_snapshot_hash
    FROM card_generation_runs_v2 WHERE id = ${runId} AND workspace_id = ${WORKSPACE_ID}`;
  const planRows = await admin`
    SELECT plan_revision_id, plan_version, plan_hash FROM card_generation_plans_v2
    WHERE run_id = ${runId} AND workspace_id = ${WORKSPACE_ID}
    ORDER BY plan_version DESC LIMIT 1`;
  const candidates = await admin`
    SELECT candidate_id, candidate_revision_id, revision, candidate_revision_hash
    FROM card_generation_candidates_v2
    WHERE run_id = ${runId} AND workspace_id = ${WORKSPACE_ID} AND quality_state = 'passed'
    ORDER BY revision`;
  assert.ok(candidates.length >= 1, "run must have a passed candidate");
  return { runRow: runRows[0], plan: planRows[0], first: candidates[0] };
}

before(async () => {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`rq-${USER_ID}@example.invalid`}, 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'R34 redaction/quota')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
  });
});

after(async () => {
  await admin`DELETE FROM card_generation_runs_v2 WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  for (const id of createdNoteIds) {
    await admin`DELETE FROM notes WHERE id = ${id}`.catch(() => undefined);
  }
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM workspaces WHERE id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM users WHERE id = ${USER_ID}`.catch(() => undefined);
  await admin.end({ timeout: 5 });
  const { closeDatabase } = await import("../../../../apps/api/src/db/client.ts");
  await closeDatabase().catch(() => undefined);
  const { closeDatabase: closeWorkerDatabase } = await import("../db.ts");
  await closeWorkerDatabase().catch(() => undefined);
});

test("§15.7/C31：Evidence Redaction — tombstone + eligibility 前移 + 幂等 + 激活/PREPARE fail-closed", async () => {
  const { versionId } = await seedNote("redaction", CONTENT);
  const { runId } = await createRun(versionId);
  await runPipelineOnce();

  // 取本 run seal 的真实 evidence snapshot
  const snaps = await admin`
    SELECT evidence_snapshot_id, evidence_snapshot_hash FROM evidence_snapshots_v2
    WHERE workspace_id = ${WORKSPACE_ID}
    ORDER BY created_at DESC LIMIT 1`;
  assert.ok(snaps.length >= 1, "sealed evidence snapshot must exist");
  const snapshotId = snaps[0].evidence_snapshot_id;
  const snapshotHash = snaps[0].evidence_snapshot_hash;

  // 激活（binding 引用该 snapshot）——baseline usable 路径
  await forceReviewReady(runId);
  await forceCandidatesPassed(runId);
  const receipt = await activateFirstCandidate(runId, snapshotId, snapshotHash);
  const mapping = receipt.mappings[0];
  assert.ok(mapping.cardId && mapping.objectiveId, "baseline activation must produce card+objective");

  // 激活后 PREPARE 成功（baseline eligible）
  // 历史卡片桥接数据已不需要——
  // 迁移 0176 后 key_point_id FK 直接引用 learning_objectives_v2(objective_id)，
  // V2 createRunV2 直接使用 objectiveId，不再需要历史 alias 行。
  const { createRunV2 } = await import(
    "../../../../apps/api/src/modules/learning-runs/run-service.ts"
  );
  const { withWorkspaceTransaction } = await import(
    "../../../../apps/api/src/db/client.ts"
  );
  const baseline = await withWorkspaceTransaction(
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    (tx) => createRunV2(tx, {
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      request: {
        originV2: { kind: "card", cardId: mapping.cardId, objectiveId: mapping.objectiveId },
        goal: "stabilize",
        requestedTimeBudgetSeconds: 300,
        idempotencyKey: `rq-prepare-baseline-${randomUUID()}`,
      },
    }),
  );
  assert.ok(baseline.snapshotId, "baseline PREPARE must succeed before redaction");

  // ── redaction ──────────────────────────────────────────────────────────
  const { recordEvidenceRedactionV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/evidence-redaction-service.ts"
  );
  const result = await recordEvidenceRedactionV2(
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    { evidenceSnapshotId: snapshotId, scope: "all_content", reasonCode: "user_request" },
    `rq-redact-${randomUUID()}`,
  );
  assert.equal(result.evidenceSnapshotId, snapshotId);
  assert.equal(result.redactionRevision, 1, "first redaction revision must be 1");
  assert.equal(result.eligibilityStatus, "revoked");
  assert.equal(result.eligibilityEpoch, 2, "eligibility epoch must advance");
  assert.ok(/^[0-9a-f]{64}$/.test(result.tombstoneHash), "tombstone hash must be 64-hex");

  const redactionRows = await admin`
    SELECT redaction_revision, tombstone_hash FROM evidence_redactions_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND evidence_snapshot_id = ${snapshotId}`;
  assert.equal(redactionRows.length, 1, "exactly one tombstone row");
  assert.equal(Number(redactionRows[0].redaction_revision), 1);
  assert.equal(redactionRows[0].tombstone_hash, result.tombstoneHash);

  const eligAfter = await admin`
    SELECT status, eligibility_epoch FROM evidence_eligibility_states_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND evidence_snapshot_id = ${snapshotId}`;
  assert.equal(eligAfter[0].status, "revoked", "eligibility must be revoked");
  assert.equal(Number(eligAfter[0].eligibility_epoch), 2, "eligibility epoch must be 2");

  // 幂等重放：同输入 → replayed、同 tombstoneHash、无新增行
  const replay = await recordEvidenceRedactionV2(
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    { evidenceSnapshotId: snapshotId, scope: "all_content", reasonCode: "user_request" },
    `rq-redact-replay-${randomUUID()}`,
  );
  assert.equal(replay.replayed, true, "replay must be idempotent");
  assert.equal(replay.tombstoneHash, result.tombstoneHash, "replay must return same tombstone");
  const redactionCount = await admin`
    SELECT count(*)::int AS n FROM evidence_redactions_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND evidence_snapshot_id = ${snapshotId}`;
  assert.equal(redactionCount[0].n, 1, "replay must not add tombstone rows");

  // 跨租户防护：他 workspace 请求同 snapshotId → 404
  const { recordEvidenceRedactionV2: redactOther } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/evidence-redaction-service.ts"
  );
  await assert.rejects(
    redactOther(
      { workspaceId: randomUUID(), userId: randomUUID() },
      { evidenceSnapshotId: snapshotId, scope: "all_content", reasonCode: "user_request" },
      `rq-redact-other-${randomUUID()}`,
    ),
    (err: unknown) => (err as { code?: string }).code === "evidence_snapshot_not_found",
    "cross-workspace redaction must be rejected",
  );

  // ── redaction 后：新 run 激活被 §13.1 evidence_revoked 拒绝（0 副作用）──
  // 内容须为全新主题（同 workspace 内 planner existing-objective 去重防 0 卡）
  const CONTENT_AFTER =
    "需求价格弹性：需求量变动百分比与价格变动百分比之比；弹性大于 1 时降价会增加总收益，小于 1 时涨价会增加总收益。";
  const { versionId: v2 } = await seedNote("redaction-after", CONTENT_AFTER);
  const { runId: run2 } = await createRun(v2);
  await runPipelineOnce();
  await forceReviewReady(run2);
  await forceCandidatesPassed(run2);
  const { activateCardCandidatesV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/activation-service.ts"
  );
  const { runRow, plan, first } = await loadRunPlan(run2);
  const { computeCandidateEvidenceBindingPlanHashV2, computeClientReviewHashV2 } = await import(
    "../../../../packages/shared/src/card-generation-v2-hashing.ts"
  );
  const bindings = [{
    targetUnit: { kind: "rubric", rubricUnitId: "u1" },
    evidenceSnapshotId: snapshotId,
    evidenceSnapshotHash: snapshotHash,
    relation: "entails",
    supportStrength: "direct",
    semanticSupportReportId: randomUUID(),
    semanticSupportReportHash: "a".repeat(64),
  }];
  const bindingPlanHash = computeCandidateEvidenceBindingPlanHashV2({
    candidateRevisionId: first.candidate_revision_id,
    bindings,
  });
  await admin`
    INSERT INTO candidate_evidence_binding_plans_v2
      (id, workspace_id, binding_plan_id, run_id, candidate_revision_id,
       candidate_revision_hash, plan_revision_id, plan_version, plan_hash,
       target_unit_bindings, binding_plan_hash, evidence_eligibility_vector_hash)
    VALUES (${randomUUID()}, ${WORKSPACE_ID}, ${randomUUID()}, ${run2},
            ${first.candidate_revision_id}, ${first.candidate_revision_hash},
            ${plan.plan_revision_id}, ${plan.plan_version}, ${plan.plan_hash},
            ${JSON.stringify(bindings)}, ${bindingPlanHash}, ${"a".repeat(64)})`;
  const clientReviewHash = computeClientReviewHashV2({
    runId: run2,
    expectedReviewDraftRevision: Number(runRow.review_draft_revision),
    selected: [{ candidateId: first.candidate_id, revision: first.revision, revisionHash: first.candidate_revision_hash }],
    reviewUiContractVersion: "review-ui-v1",
  });
  const key2 = `rq-activate-after-redact-${randomUUID()}`;
  await assert.rejects(
    activateCardCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      {
        version: 2,
        runId: run2,
        sourceSnapshotHash: runRow.source_snapshot_hash,
        semanticSpecHash: runRow.semantic_spec_hash,
        inputSnapshotHash: runRow.input_snapshot_hash,
        expectedCardContentEpoch: Number(runRow.card_content_epoch),
        planRevisionId: plan.plan_revision_id,
        expectedPlanVersion: Number(plan.plan_version),
        planHash: plan.plan_hash,
        selectedCandidates: [{
          candidateRevisionId: first.candidate_revision_id,
          candidateId: first.candidate_id,
          revision: first.revision,
          revisionHash: first.candidate_revision_hash,
          candidateEvidenceBindingPlanHash: bindingPlanHash,
          qualityReportHashes: [],
          intent: { kind: "create_new" } as const,
        }],
        existingLifecycleActions: [],
        expectedReviewDraftRevision: Number(runRow.review_draft_revision),
        clientReviewHash,
      },
      key2,
    ),
    (err: unknown) => (err as { code?: string }).code === "evidence_revoked",
    "C31: activation must be rejected after redaction (evidence_revoked)",
  );
  const receiptsAfter = await admin`
    SELECT count(*)::int AS n FROM card_activation_receipts_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND idempotency_key = ${key2}`;
  assert.equal(receiptsAfter[0].n, 0, "rejected activation must leave 0 receipts");

  // ── redaction 后：PREPARE 必须 fail closed（§16.2）──
  //
  // 这里断言的是**安全性质**（必须被拒绝、且不留下任何快照），而不是某一个具体错误码。
  // 原因：redaction 做了两件事——把 eligibility 置为 `revoked`，**并**把 epoch 前移
  // （fencing 在途消费，见 evidence-redaction-service 第 4 步）。因此基于 redaction 前
  // 绑定构造的 PREPARE 会**先**撞到"绑定已失效"（`context_stale`），而状态检查
  // （`evidence_not_usable`）在它之后。两个码都是 fail-closed 的正确拒绝，先命中哪一个
  // 取决于守卫顺序，把测试钉在其中一个上会在无关重构时误报。
  let c31Outcome = "no_error_thrown";
  try {
    await withWorkspaceTransaction(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      (tx) => createRunV2(tx, {
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        request: {
          originV2: { kind: "card", cardId: mapping.cardId, objectiveId: mapping.objectiveId },
          goal: "stabilize",
          requestedTimeBudgetSeconds: 300,
          idempotencyKey: `rq-prepare-after-redact-${randomUUID()}`,
        },
      }),
    );
  } catch (error) {
    c31Outcome = String((error as { code?: string }).code ?? (error as Error).message);
  }
  assert.ok(
    ["context_stale", "evidence_not_usable", "evidence_eligibility_missing"].includes(c31Outcome),
    `C31: PREPARE must fail closed after redaction (got ${c31Outcome})`,
  );
  const snapshotsAfter = await admin`
    SELECT count(*)::int AS n FROM learning_target_snapshots_v2
    WHERE workspace_id = ${WORKSPACE_ID}`;
  assert.equal(snapshotsAfter[0].n, 1, "failed PREPARE must not create a snapshot");
});

test("§22.6：V2 生成配额 — 在途并发上限 + 24h 速率上限 + 幂等重放豁免", async () => {
  const prevInflight = process.env.CARD_GENERATION_V2_MAX_INFLIGHT_RUNS;
  const prevDaily = process.env.CARD_GENERATION_V2_DAILY_RUN_LIMIT;
  try {
    process.env.CARD_GENERATION_V2_MAX_INFLIGHT_RUNS = "1";
    process.env.CARD_GENERATION_V2_DAILY_RUN_LIMIT = "50";
    // 三篇各管一件事。**"在制那一行"必须挂在另一篇笔记上**：不然先挡住请求的是
    // "这篇笔记已有在制批次"那道同篇守卫，配额（空间/人级）那条断言根本没被执行到——
    // 看着像在测配额，其实在测另一道闸。
    const forFirst = await seedNote("quota-首个批次", CONTENT);
    const forInflight = await seedNote("quota-在制占位（另一篇）", CONTENT);
    const forRequest = await seedNote("quota-被请求的那篇", CONTENT);

    // 1. 正常创建（在途 0）→ 成功
    const first = await createRun(forFirst.versionId);
    assert.ok(first.runId, "first run must be created");

    // 2. 在途 1（planning）→ 再创建 → 409 concurrency
    const inflightRunId = randomUUID();
    await admin`
      INSERT INTO card_generation_runs_v2
        (id, workspace_id, user_id, note_id, note_version_id, status, idempotency_key,
         semantic_spec_hash, input_snapshot_hash, generation_fingerprint,
         source_snapshot_hash, source_content_hash, block_manifest_hash,
         asset_manifest_hash, scope_manifest_hash, card_content_epoch,
         review_draft_revision, current_plan_version)
      VALUES (${inflightRunId}, ${WORKSPACE_ID}, ${USER_ID}, ${forInflight.noteId}, ${forInflight.versionId}, 'planning', ${`inflight-${randomUUID()}`},
              ${"a".repeat(64)}, ${"b".repeat(64)}, ${"f".repeat(64)},
              ${"c".repeat(64)}, ${"d".repeat(64)}, ${"e".repeat(64)},
              ${"f".repeat(64)}, ${"g".repeat(64)}, 1, 1, 1)`;
    const { createGenerationRunV2 } = await import(
      "../../../../apps/api/src/modules/card-generation-v2/generation-run-service.ts"
    );
    await assert.rejects(
      createGenerationRunV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        forRequest.versionId,
        {
          version: 2,
          noteVersionId: forRequest.versionId,
          sourceScope: { kind: "whole_note" },
          learningGoal: "understand",
          detailThreshold: "balanced",
          quantity: { kind: "adaptive" },
          clientRequestId: `rq-quota-${randomUUID()}`,
        },
        `rq-quota-key-${randomUUID()}`,
      ),
      (err: unknown) => (err as { code?: string }).code === "generation_concurrency_limit",
      "in-flight limit must reject with generation_concurrency_limit",
    );

    // 3. 幂等重放豁免：first 的 key + **first 的请求体**重放 → 同 run（不受配额影响）
    const replay = await createGenerationRunV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      forFirst.versionId,
      first.body,
      (await admin`SELECT idempotency_key FROM card_generation_runs_v2 WHERE id = ${first.runId}`)[0].idempotency_key,
    );
    assert.equal(replay.runId, first.runId, "idempotent replay must return same run despite quota");

    // 4. 24h 速率上限：移除手动 inflight run 并放宽并发上限（让 daily 先触发），
    // DAILY=1（已有 1 个真实 run）→ 429 daily
    await admin`DELETE FROM card_generation_runs_v2 WHERE id = ${inflightRunId}`;
    process.env.CARD_GENERATION_V2_MAX_INFLIGHT_RUNS = "10";
    process.env.CARD_GENERATION_V2_DAILY_RUN_LIMIT = "1";
    await assert.rejects(
      createGenerationRunV2(
        { workspaceId: WORKSPACE_ID, userId: USER_ID },
        forRequest.versionId,
        {
          version: 2,
          noteVersionId: forRequest.versionId,
          sourceScope: { kind: "whole_note" },
          learningGoal: "understand",
          detailThreshold: "balanced",
          quantity: { kind: "adaptive" },
          clientRequestId: `rq-quota-daily-${randomUUID()}`,
        },
        `rq-quota-daily-key-${randomUUID()}`,
      ),
      (err: unknown) => (err as { code?: string }).code === "generation_daily_limit",
      "daily limit must reject with generation_daily_limit",
    );
  } finally {
    if (prevInflight === undefined) delete process.env.CARD_GENERATION_V2_MAX_INFLIGHT_RUNS;
    else process.env.CARD_GENERATION_V2_MAX_INFLIGHT_RUNS = prevInflight;
    if (prevDaily === undefined) delete process.env.CARD_GENERATION_V2_DAILY_RUN_LIMIT;
    else process.env.CARD_GENERATION_V2_DAILY_RUN_LIMIT = prevDaily;
  }
});
