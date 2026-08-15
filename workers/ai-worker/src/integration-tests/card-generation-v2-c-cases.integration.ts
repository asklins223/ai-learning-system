/**
 * 方案 20 §28 — 确定性 C 项补集（R33）：C27 / C28 / C38（+ C37-lite 投影一致性）。
 *
 * - C27  presentation-only Card edit：旧 Run（frozen snapshot）仍可读；
 *   objective revision / mastery identity 不重置（不产生新 revision、0 Schedule）；
 * - C28  answer/rubric semantic change（semantic_replace）：新 Objective ID；
 *   旧 Objective/Card superseded；§15.3 objective lineage 完整（supersede 行）；
 *   0 Schedule（不迁移 mastery/schedule）；
 * - C38  PREPARE 后 target-equivalent 修订：旧 Run 仍读 frozen snapshot（rev 1）；
 *   新 Run 用新 revision（rev 2）；lineage edit 行；公共投影一致（C37-lite）。
 *
 * 与 card-generation-v2-e2e-subset.integration.ts 同约定：确定性模式候选必被
 * 门禁 hard fail，故测试代设 review_ready/passed（代表 LLM 模式审核完成态），
 * 其余全部走真实服务与真实表。
 *
 * 运行（从仓库根，**必须单文件执行**——worker outbox claim 全局）：
 *   DATABASE_URL_WORKER="postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn" \
 *   DATABASE_URL_API="postgres://ailearn:ailearn_dev@localhost:5432/ailearn" \
 *   node --import workers/ai-worker/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 \
 *     workers/ai-worker/src/integration-tests/card-generation-v2-c-cases.integration.ts
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
const NOTE_ID = randomUUID();

// 五个互不相同的主题（同 workspace 内 planner existing-objective 按
// 字符 bigram Jaccard>0.7 去重——每个 run 必须用全新主题防 0 卡）
const CONTENT_A =
  "复利效应：本金产生的利息在下一期加入本金继续生息，长期来看资产呈指数增长；越早开始积累，复利效果越明显。";
const CONTENT_D =
  "光合作用：植物利用光能，把二氧化碳和水转化为有机物并释放氧气；光反应与暗反应分别在类囊体和叶绿体基质中进行。";
const CONTENT_E =
  "冷战格局：二战后美苏两大阵营在政治、军事与意识形态上的长期对峙；柏林墙是冷战时期的重要象征。";
const CONTENT_F =
  "勾股定理：直角三角形两条直角边的平方和等于斜边的平方；在中国古代称为商高定理，是几何学的基本定理。";
//（R33：本主题含"交换"——回归验证 planner 不再把裸 `交` 子串当临时待办过滤）
const CONTENT_G =
  "血液循环：心脏泵血推动血液在血管中循环流动；体循环与肺循环同时进行，分别完成氧气输送与气体交换。";

let seedVersionCounter = 0;

async function seedNote(title: string, content: string): Promise<{ versionId: string }> {
  const versionId = randomUUID();
  const blockId = randomUUID();
  seedVersionCounter += 1;
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`v2-ccases-${USER_ID}@example.invalid`}, 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'V2 C-cases', 'v1', now(), ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by, card_generation_epoch)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, ${title}, ${USER_ID}, 1) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${versionId}, ${NOTE_ID}, ${WORKSPACE_ID}, ${seedVersionCounter}, ${JSON.stringify({ blocks: [{ type: "paragraph", content }] })}, 'v2-ccases-hash', ${USER_ID})
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
      clientRequestId: `ccases-${randomUUID()}`,
    },
    `ccases-key-${randomUUID()}`,
  );
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

/** 代设 review_ready/passed 后，返回 run/plan/候选行（真实 DB 数据）。 */
async function loadRunPlanCandidates(runId: string) {
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
  if (candidates.length === 0) {
    // 失败诊断：run 状态、全部候选质量态、outbox job 状态
    const runState = await admin`SELECT status FROM card_generation_runs_v2 WHERE id = ${runId}`;
    const allCands = await admin`
      SELECT quality_state, review_decision, count(*)::int AS n
      FROM card_generation_candidates_v2 WHERE run_id = ${runId} GROUP BY quality_state, review_decision`;
    const jobs = await admin`
      SELECT job_type, status, attempts, left(coalesce(last_error, ''), 140) AS err
      FROM card_generation_run_outbox_v2 WHERE run_id = ${runId}`;
    console.error("[ccases-dbg]", JSON.stringify({ runId, runState, allCands, jobs }));
  }
  assert.ok(candidates.length >= 1, "run must have a passed candidate");
  return { runRow: runRows[0], plan: planRows[0], candidates };
}

/** 最小激活（无 binding plan 行；激活端退化为空集），返回 receipt。 */
async function activate(versionId: string, intent: { kind: "create_new" } | {
  kind: "semantic_replace";
  replacedCardId: string;
  replacedObjectiveId: string;
  expectedObjectiveLifecycleEpoch: number;
} | {
  kind: "target_equivalent_update";
  cardId: string;
  objectiveId: string;
  expectedPublicationRevision: number;
  expectedCardRevision: number;
  expectedPublicPayloadHash: string;
  expectedObjectiveRevision: number;
  expectedTargetRevisionHash: string;
  equivalenceReportHash: string;
  presentationChange: "unchanged" | "create_candidate_card_revision";
}) {
  const { runId } = await createRun(versionId);
  await runPipelineOnce();
  await forceReviewReady(runId);
  await forceCandidatesPassed(runId);
  const { runRow, plan, candidates } = await loadRunPlanCandidates(runId);
  const first = candidates[0];

  // R36 §5.4：target_equivalent_update 的服务端重算闭包——测试若传占位 hash
  //（"aaaa…"/"bbbb…" 等全同字符），按服务端同一逻辑重算，否则 409 mismatch。
  if (intent.kind === "target_equivalent_update" && /^([a-f0-9])\1{63}$/.test(intent.equivalenceReportHash)) {
    const { hashCanonicalV2 } = await import(
      "../../../../packages/shared/src/hash-canonical-v2.ts"
    );
    const {
      computeCanonicalAnswerHashV2,
      computeLearningSupportHashV2,
      computeRelationsHashV2,
    } = await import("../../../../packages/shared/src/card-generation-v2-hashing.ts");
    const candRow = await admin`
      SELECT objective_draft FROM card_generation_candidates_v2
      WHERE candidate_revision_id = ${first.candidate_revision_id} AND workspace_id = ${WORKSPACE_ID}`;
    const objectiveDraft = candRow[0].objective_draft as {
      objectiveStatement: string;
      publicSummary: string;
      knowledgeForm: string;
      canonicalAnswer: unknown;
      learningSupport: unknown;
      rubric: { rubricHash: string };
      relations?: unknown[];
    };
    const canonicalAnswerHash = computeCanonicalAnswerHashV2(objectiveDraft.canonicalAnswer);
    const learningSupportHash = computeLearningSupportHashV2(objectiveDraft.learningSupport);
    const rubricHash = objectiveDraft.rubric.rubricHash;
    const relationsHash = computeRelationsHashV2(objectiveDraft.relations ?? []);
    const proposedSemanticContentHash = hashCanonicalV2("objective-semantic-content-v2", {
      objectiveStatement: objectiveDraft.objectiveStatement,
      publicSummary: objectiveDraft.publicSummary,
      knowledgeForm: objectiveDraft.knowledgeForm,
      canonicalAnswerHash,
      learningSupportHash,
      rubricHash,
      relationsHash,
    });
    const proposedEvidenceBindingPlanHash = hashCanonicalV2("candidate-evidence-binding-plan-v2", {
      candidateRevisionId: first.candidate_revision_id,
    });
    // 服务端用当前 objective revision（DB 现值）作为 priorObjectiveRevisionId。
    const curObjRev = await admin`
      SELECT current_objective_revision_id FROM learning_objectives_v2
      WHERE objective_id = ${intent.objectiveId} AND workspace_id = ${WORKSPACE_ID}`;
    intent = {
      ...intent,
      equivalenceReportHash: hashCanonicalV2("objective-equivalence-report-v2", {
        objectiveId: intent.objectiveId,
        priorObjectiveRevisionId: String(curObjRev[0].current_objective_revision_id),
        priorTargetRevisionHash: intent.expectedTargetRevisionHash,
        proposedCandidateRevisionId: first.candidate_revision_id,
        proposedCandidateRevisionHash: first.candidate_revision_hash,
        proposedSemanticContentHash,
        proposedEvidenceBindingPlanHash,
        verdict: "equivalent",
        policyVersion: "equivalence-policy-v1",
        authorizedBy: "deterministic_policy_and_human",
      }),
    };
  }
  const { activateCardCandidatesV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/activation-service.ts"
  );
  const { computeClientReviewHashV2 } = await import(
    "../../../../packages/shared/src/card-generation-v2-hashing.ts"
  );
  const clientReviewHash = computeClientReviewHashV2({
    runId,
    expectedReviewDraftRevision: Number(runRow.review_draft_revision),
    selected: [{ candidateId: first.candidate_id, revision: first.revision, revisionHash: first.candidate_revision_hash }],
    reviewUiContractVersion: "review-ui-v1",
  });
  const receipt = await activateCardCandidatesV2(
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
        candidateEvidenceBindingPlanHash: "a".repeat(64),
        qualityReportHashes: [],
        intent,
      }],
      existingLifecycleActions: [],
      expectedReviewDraftRevision: Number(runRow.review_draft_revision),
      clientReviewHash,
    },
    `ccases-activate-${randomUUID()}`,
  );
  assert.equal(receipt.mappings.length, 1, "must produce exactly one mapping");
  return { receipt, runId, mapping: receipt.mappings[0], candidate: first };
}

/** §29.4 迁移期 stable objective ID = legacy keyPoint UUID alias。 */
async function insertObjectiveAlias(objectiveId: string, versionId: string) {
  const legacyCardId = randomUUID();
  await admin.begin(async (tx) => {
    await tx`INSERT INTO learning_cards (id, note_version_id, workspace_id, status, schema_json)
      VALUES (${legacyCardId}, ${versionId}, ${WORKSPACE_ID}, 'active', '{}'::jsonb)
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text, segment_ref)
      VALUES (${objectiveId}, ${legacyCardId}, ${WORKSPACE_ID}, 1, 'CC', 'CC', '{"type":"text"}'::jsonb)
      ON CONFLICT (id) DO NOTHING`;
  });
}

/** PREPARE：冻结 LearningTargetSnapshotV2（真实 createRunV2）。 */
async function prepare(objectiveId: string, cardId: string, idempotencyKey: string) {
  const { createRunV2 } = await import(
    "../../../../apps/api/src/modules/learning-runs/run-service.ts"
  );
  const { withWorkspaceTransaction } = await import(
    "../../../../apps/api/src/db/client.ts"
  );
  return withWorkspaceTransaction(
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    (tx) => createRunV2(tx, {
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      request: {
        originV2: { kind: "card", cardId, objectiveId },
        goal: "stabilize",
        requestedTimeBudgetSeconds: 300,
        idempotencyKey,
      },
    }),
  );
}

before(async () => {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`v2-ccases-${USER_ID}@example.invalid`}, 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'V2 C-cases', 'v1', now(), ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
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

test("C27：presentation-only Card edit → 旧 Run 可读、objective/mastery identity 不重置", async () => {
  const { versionId } = await seedNote("C27", CONTENT_A);
  const { mapping } = await activate(versionId, { kind: "create_new" });

  // 旧 Run 冻结：激活后先 PREPARE（alias 后）
  await insertObjectiveAlias(mapping.objectiveId, versionId);
  const prepareKey = `c27-prepare-${randomUUID()}`;
  const oldRun = await prepare(mapping.objectiveId, mapping.cardId, prepareKey);
  const oldSnap = await admin`
    SELECT objective_revision, target_revision_hash FROM learning_target_snapshots_v2
    WHERE snapshot_id = ${oldRun.snapshotId} AND workspace_id = ${WORKSPACE_ID}`;
  assert.equal(Number(oldSnap[0].objective_revision), 1, "C27 old run must freeze revision 1");
  const frozenHash = String(oldSnap[0].target_revision_hash);

  // presentation-only edit（真实服务）
  const pubRows = await admin`
    SELECT publication_revision, public_payload_hash FROM learning_card_publication_revisions_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND card_id = ${mapping.cardId} ORDER BY publication_revision DESC LIMIT 1`;
  const { updateCardPresentationV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/card-service.ts"
  );
  const updated = await updateCardPresentationV2(
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    mapping.cardId,
    Number(pubRows[0].publication_revision),
    pubRows[0].public_payload_hash,
    { front: { cue: "复利积累的关键机制？", prompt: "请解释复利如何让资产随时间加速增长。" } },
  );
  assert.equal(updated.publicationRevision, Number(pubRows[0].publication_revision) + 1,
    "C27 presentation edit must bump publication revision");
  assert.equal(updated.cardRevision, 2, "C27 presentation edit must bump card revision");

  // objective identity 不重置：仍同一 objective、revision 仍 1、lineage 无 edit 行
  const objRows = await admin`
    SELECT current_revision FROM learning_objectives_v2 WHERE objective_id = ${mapping.objectiveId}`;
  assert.equal(Number(objRows[0].current_revision), 1, "C27 must not create a new objective revision");
  const revCount = await admin`
    SELECT count(*)::int AS n FROM learning_objective_revisions_v2
    WHERE objective_id = ${mapping.objectiveId} AND workspace_id = ${WORKSPACE_ID}`;
  assert.equal(revCount[0].n, 1, "C27 must not add objective revisions");
  const lineageEdit = await admin`
    SELECT count(*)::int AS n FROM learning_objective_lineage_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND relation = 'edit' AND successor_revision_id IN (
      SELECT objective_revision_id FROM learning_objective_revisions_v2 WHERE objective_id = ${mapping.objectiveId})`;
  assert.equal(lineageEdit[0].n, 0, "C27 presentation-only edit must not write edit lineage");

  // 旧 Run 仍可读：snapshot 内容不变（frozen revision 1 + target hash 未变）
  const oldSnapAfter = await admin`
    SELECT objective_revision, target_revision_hash FROM learning_target_snapshots_v2
    WHERE snapshot_id = ${oldRun.snapshotId} AND workspace_id = ${WORKSPACE_ID}`;
  assert.equal(Number(oldSnapAfter[0].objective_revision), 1, "C27 old run must still read frozen revision 1");
  assert.equal(String(oldSnapAfter[0].target_revision_hash), frozenHash,
    "C27 old run frozen target hash must be unchanged");

  // 0 Schedule（不伪造排程、不重置 mastery/schedule identity）
  const schedules = await admin`
    SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${WORKSPACE_ID}`;
  assert.equal(schedules[0].n, 0, "C27 edit must create 0 schedules");
});

test("C28：answer/rubric semantic change → 新 Objective ID；旧对象 supersede；lineage 完整；0 Schedule", async () => {
  const { versionId: v1 } = await seedNote("C28-D", CONTENT_D);
  const { mapping: m1 } = await activate(v1, { kind: "create_new" });

  const oldObjLifecycle = await admin`
    SELECT lifecycle, lifecycle_epoch, current_objective_revision_id FROM learning_objectives_v2
    WHERE objective_id = ${m1.objectiveId} AND workspace_id = ${WORKSPACE_ID}`;
  assert.equal(oldObjLifecycle[0].lifecycle, "active");

  // 语义替换：新 run（新内容 B）→ semantic_replace intent
  const { versionId: v2 } = await seedNote("C28-E", CONTENT_E);
  const { mapping: m2 } = await activate(v2, {
    kind: "semantic_replace",
    replacedCardId: m1.cardId,
    replacedObjectiveId: m1.objectiveId,
    expectedObjectiveLifecycleEpoch: Number(oldObjLifecycle[0].lifecycle_epoch),
  });

  // 新 Objective ID ≠ 旧；新卡 active
  assert.notEqual(m2.objectiveId, m1.objectiveId, "C28 semantic change must create a new objective ID");
  const newCard = await admin`
    SELECT lifecycle FROM learning_cards_v2 WHERE card_id = ${m2.cardId} AND workspace_id = ${WORKSPACE_ID}`;
  assert.equal(newCard[0].lifecycle, "active", "C28 new card must be active");

  // 旧对象 supersede（不迁移 mastery/schedule）
  const oldObjAfter = await admin`
    SELECT lifecycle, lifecycle_epoch FROM learning_objectives_v2
    WHERE objective_id = ${m1.objectiveId} AND workspace_id = ${WORKSPACE_ID}`;
  assert.equal(oldObjAfter[0].lifecycle, "superseded", "C28 old objective must be superseded");
  assert.equal(Number(oldObjAfter[0].lifecycle_epoch), Number(oldObjLifecycle[0].lifecycle_epoch) + 1,
    "C28 supersede must bump lifecycle epoch");
  const oldCardAfter = await admin`
    SELECT lifecycle FROM learning_cards_v2 WHERE card_id = ${m1.cardId} AND workspace_id = ${WORKSPACE_ID}`;
  assert.equal(oldCardAfter[0].lifecycle, "superseded", "C28 old card must be superseded");

  // §15.3 lineage 完整：supersede 行（pred=旧 rev，succ=新 rev1）
  const lineageRows = await admin`
    SELECT predecessor_revision_id, successor_revision_id, relation, reason
    FROM learning_objective_lineage_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND relation = 'supersede'`;
  assert.equal(lineageRows.length, 1, "C28 must record exactly one supersede lineage row");
  assert.equal(lineageRows[0].predecessor_revision_id, oldObjLifecycle[0].current_objective_revision_id,
    "C28 lineage predecessor must be the old objective revision");
  assert.equal(lineageRows[0].successor_revision_id, m2.objectiveRevisionId,
    "C28 lineage successor must be the new objective revision");
  assert.equal(lineageRows[0].reason, "semantic_replace");

  // C37-lite：同一 Objective 在所有读视图一致（card 行 ↔ objective 行 ↔ 公共投影）
  const { readPublicCardV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/legacy-read-adapter.ts"
  );
  const { withWorkspaceTransaction } = await import(
    "../../../../apps/api/src/db/client.ts"
  );
  const pub = await withWorkspaceTransaction(
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    (tx) => readPublicCardV2(tx, WORKSPACE_ID, m2.objectiveId),
  );
  assert.ok(pub, "C37 read view must resolve the new objective");
  assert.equal(String(pub.objectiveId), m2.objectiveId, "C37 read view objectiveId must match");
  const rev2Row = await admin`
    SELECT public_summary FROM learning_objective_revisions_v2
    WHERE objective_revision_id = ${m2.objectiveRevisionId} AND workspace_id = ${WORKSPACE_ID}`;
  assert.equal(String(pub.publicSummary), String(rev2Row[0].public_summary),
    "C37 read view publicSummary must match objective revision");

  // 0 Schedule（旧 mastery/schedule 不迁移）
  const schedules = await admin`
    SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${WORKSPACE_ID}`;
  assert.equal(schedules[0].n, 0, "C28 semantic replace must create 0 schedules");
});

test("C38：PREPARE 后 target-equivalent 修订 → 旧 Run 读 frozen rev1；新 Run 用 rev2；lineage edit", async () => {
  const { versionId: v1 } = await seedNote("C38-F", CONTENT_F);
  const { mapping: m1 } = await activate(v1, { kind: "create_new" });
  await insertObjectiveAlias(m1.objectiveId, v1);

  // 1. 首次 PREPARE → rev1 冻结
  const oldRun = await prepare(m1.objectiveId, m1.cardId, `c38-prepare-1-${randomUUID()}`);
  const oldSnap = await admin`
    SELECT objective_revision, target_revision_hash FROM learning_target_snapshots_v2
    WHERE snapshot_id = ${oldRun.snapshotId} AND workspace_id = ${WORKSPACE_ID}`;
  assert.equal(Number(oldSnap[0].objective_revision), 1, "C38 first PREPARE must freeze rev 1");
  const frozenHash = String(oldSnap[0].target_revision_hash);

  // 2. target-equivalent 修订：新 run（内容 C）→ target_equivalent_update（unchanged）
  const curObj = await admin`
    SELECT current_revision, current_objective_revision_id FROM learning_objectives_v2
    WHERE objective_id = ${m1.objectiveId} AND workspace_id = ${WORKSPACE_ID}`;
  const curRevHash = await admin`
    SELECT target_revision_hash FROM learning_objective_revisions_v2
    WHERE objective_revision_id = ${curObj[0].current_objective_revision_id} AND workspace_id = ${WORKSPACE_ID}`;
  const curPub = await admin`
    SELECT publication_revision, public_payload_hash FROM learning_card_publication_revisions_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND card_id = ${m1.cardId}
    ORDER BY publication_revision DESC LIMIT 1`;

  const cardDbg = await admin`
    SELECT card_id, card_revision, current_publication_revision FROM learning_cards_v2
    WHERE card_id = ${m1.cardId} AND workspace_id = ${WORKSPACE_ID}`;
  const pubRowsDbg = await admin`
    SELECT count(*)::int AS n FROM learning_card_publication_revisions_v2
    WHERE card_id = ${m1.cardId} AND workspace_id = ${WORKSPACE_ID}`;
  console.error("[ccases-dbg] c38 m1.cardId:", m1.cardId, "pubs:", JSON.stringify(pubRowsDbg));
  console.error("[ccases-dbg] c38 card state:", JSON.stringify(cardDbg),
    "expectedPub:", Number(curPub[0].publication_revision),
    "expectedCardRev:", 1, "expectedObjRev:", Number(curObj[0].current_revision));
  const { versionId: v2 } = await seedNote("C38-G", CONTENT_G);
  const { mapping: m2 } = await activate(v2, {
    kind: "target_equivalent_update",
    cardId: m1.cardId,
    objectiveId: m1.objectiveId,
    expectedPublicationRevision: Number(curPub[0].publication_revision),
    expectedCardRevision: 1,
    expectedPublicPayloadHash: curPub[0].public_payload_hash,
    expectedObjectiveRevision: Number(curObj[0].current_revision),
    expectedTargetRevisionHash: curRevHash[0].target_revision_hash,
    equivalenceReportHash: "b".repeat(64),
    presentationChange: "unchanged",
  });
  assert.equal(m2.objectiveId, m1.objectiveId, "C38 target-equivalent must keep the same objective ID");
  assert.notEqual(m2.objectiveRevisionId, curObj[0].current_objective_revision_id,
    "C38 must create a new objective revision");
  assert.equal(m2.publicationRevision, Number(curPub[0].publication_revision) + 1,
    "C38 must create a new publication revision");

  const objAfter = await admin`
    SELECT current_revision FROM learning_objectives_v2
    WHERE objective_id = ${m1.objectiveId} AND workspace_id = ${WORKSPACE_ID}`;
  assert.equal(Number(objAfter[0].current_revision), 2, "C38 objective must advance to rev 2");

  // lineage edit 行
  const editLineage = await admin`
    SELECT predecessor_revision_id, successor_revision_id FROM learning_objective_lineage_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND relation = 'edit' AND reason = 'target_equivalent_update'`;
  assert.equal(editLineage.length, 1, "C38 must record one edit lineage row");
  assert.equal(editLineage[0].predecessor_revision_id, curObj[0].current_objective_revision_id,
    "C38 lineage predecessor must be rev 1");
  assert.equal(editLineage[0].successor_revision_id, m2.objectiveRevisionId,
    "C38 lineage successor must be rev 2");

  // 3. 旧 Run 仍读 frozen rev1（内容不换）；新 PREPARE → rev2
  const oldSnapAfter = await admin`
    SELECT objective_revision, target_revision_hash FROM learning_target_snapshots_v2
    WHERE snapshot_id = ${oldRun.snapshotId} AND workspace_id = ${WORKSPACE_ID}`;
  assert.equal(Number(oldSnapAfter[0].objective_revision), 1, "C38 old run must still read frozen rev 1");
  assert.equal(String(oldSnapAfter[0].target_revision_hash), frozenHash,
    "C38 old run frozen target hash must be unchanged");

  const newRun = await prepare(m1.objectiveId, m1.cardId, `c38-prepare-2-${randomUUID()}`);
  const newSnap = await admin`
    SELECT objective_revision FROM learning_target_snapshots_v2
    WHERE snapshot_id = ${newRun.snapshotId} AND workspace_id = ${WORKSPACE_ID}`;
  assert.equal(Number(newSnap[0].objective_revision), 2, "C38 new PREPARE must freeze rev 2");
  assert.notEqual(newRun.snapshotId, oldRun.snapshotId, "C38 new run must have its own snapshot");

  // C37-lite：公共投影一致性（读视图 objectiveRevision=2 且 publicSummary 匹配 rev2）
  const { readPublicCardV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/legacy-read-adapter.ts"
  );
  const { withWorkspaceTransaction } = await import(
    "../../../../apps/api/src/db/client.ts"
  );
  const pub = await withWorkspaceTransaction(
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    (tx) => readPublicCardV2(tx, WORKSPACE_ID, m1.objectiveId),
  );
  assert.ok(pub, "C37 read view must resolve the objective");
  assert.equal(Number(pub.objectiveRevision), 2, "C37 read view must expose the current objective revision");
  const rev2Summary = await admin`
    SELECT public_summary FROM learning_objective_revisions_v2
    WHERE objective_revision_id = ${m2.objectiveRevisionId} AND workspace_id = ${WORKSPACE_ID}`;
  const revAllDbg = await admin`
    SELECT revision, left(public_summary, 40) AS s FROM learning_objective_revisions_v2
    WHERE objective_id = ${m1.objectiveId} AND workspace_id = ${WORKSPACE_ID} ORDER BY revision`;
  console.error("[ccases-dbg] c38 revisions:", JSON.stringify(revAllDbg),
    "| readView summary:", String(pub.publicSummary).slice(0, 40));
  assert.equal(String(pub.publicSummary), String(rev2Summary[0].public_summary),
    "C37 read view publicSummary must match rev2");
});
