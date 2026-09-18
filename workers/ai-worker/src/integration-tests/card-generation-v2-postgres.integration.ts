/**
 * 方案 20 — Card Generation V2 纵切 DB 集成测试（真实 postgres）。
 *
 * 覆盖（审查 §4.1/§4.6 修复验证）：
 * - API 侧 createGenerationRunV2：source_sealing 事务内 Evidence seal
 *   （evidence_snapshots_v2 + evidence_eligibility_states_v2）+ outbox 入队；
 * - Worker 侧（ailearn_worker，NOBYPASSRLS）pollV2Outbox：0138 RLS worker
 *   豁免真实生效（被策略拦截时 claim 0 行、run 停留在 planning → 测试失败）；
 * - Planner → Author（确定性测试模式）→ Critics → Deck Gate → review_ready；
 * - 候选激活：Objective/Card/Publication/Receipt/Reminder 原子创建；
 *   激活后 0 Schedule（§16.7 activation 不创建 Schedule）。
 *
 * 运行（从仓库根，**必须单文件执行**——worker outbox claim 是全局的，
 * 多文件同进程会互相抢 job）：
 *   DATABASE_URL_WORKER="postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn" \
 *   DATABASE_URL_API="postgres://ailearn:ailearn_dev@localhost:5432/ailearn" \
 *   node --import tsx --test --test-concurrency=1 \
 *     workers/ai-worker/src/integration-tests/card-generation-v2-postgres.integration.ts
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR
  ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
// 测试体以 ailearn_worker 角色执行 pollV2Outbox（RLS NOBYPASSRLS 验证）。
// WORKER_URL 由 pollV2Outbox 内部通过 process.env.DATABASE_URL_WORKER 读取。
process.env.DATABASE_URL_WORKER ??= "postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn";

process.env.DATABASE_URL_API ??= ADMIN_URL;

const admin = postgres(ADMIN_URL, { max: 2 });

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const NOTE_ID = randomUUID();
const VERSION_ID = randomUUID();

const NOTE_CONTENT =
  "OSI 模型把网络通信分为七层：物理层负责比特流传输；数据链路层负责帧与纠错；网络层负责路由；传输层负责端到端传输；会话层负责会话管理；表示层负责数据格式转换；应用层提供应用接口。";

before(async () => {
  // 种子：user / workspace / member / note / note_version / note_blocks
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`v2-it-${USER_ID}@example.invalid`}, 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'V2 IT', 'v1', now(), ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, 'V2 IT note', ${USER_ID}) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${VERSION_ID}, ${NOTE_ID}, ${WORKSPACE_ID}, 1, ${tx.json({ blocks: [{ type: "paragraph", content: NOTE_CONTENT }] })}, 'v2-it-hash', ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal)
      VALUES (${randomUUID()}, ${VERSION_ID}, ${WORKSPACE_ID}, 'paragraph', ${NOTE_CONTENT}, 1)
      ON CONFLICT (id) DO NOTHING`;
  });
});

after(async () => {
  // 保留 runs/outbox 以便失败后读 last_error（调试期）
  if (process.env.V2_IT_KEEP_RUNS !== "1") {
    await admin`DELETE FROM card_generation_runs_v2 WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  }
  await admin`DELETE FROM note_blocks WHERE version_id = ${VERSION_ID}`.catch(() => undefined);
  await admin`DELETE FROM note_versions WHERE id = ${VERSION_ID}`.catch(() => undefined);
  await admin`DELETE FROM notes WHERE id = ${NOTE_ID}`.catch(() => undefined);
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM workspaces WHERE id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM users WHERE id = ${USER_ID}`.catch(() => undefined);
  await admin.end({ timeout: 5 });
  const { closeDatabase } = await import("../../../../apps/api/src/db/client.ts");
  await closeDatabase().catch(() => undefined);
  // worker 侧的连接池也必须关掉：测试体经 pollV2Outbox 走 worker 的 db.ts，
  // 只关 api 的池会留下一个打开的句柄 → 进程永不退出（`node --test` 一直等事件循环
  // 排空，表现为"测试通过了但整条命令挂住"，在 CI 里就是一个假超时）。
  // 与同目录 card-generation-v2-c-cases.integration.ts 的收尾保持一致。
  const { closeDatabase: closeWorkerDatabase } = await import("../db.ts");
  await closeWorkerDatabase().catch(() => undefined);
});

test("V2 纵切：seal → planner/author/critics → review_ready → activation（0 Schedule）", async () => {
  // ─── 1. API 侧创建生成运行（source_sealing 事务内 seal evidence + outbox） ──
  const { createGenerationRunV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/generation-run-service.ts"
  );
  const { activateCardCandidatesV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/activation-service.ts"
  );

  const createResult = await createGenerationRunV2(
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    VERSION_ID,
    {
      version: 2,
      noteVersionId: VERSION_ID,
      sourceScope: { kind: "whole_note" },
      learningGoal: "understand",
      detailThreshold: "balanced",
      quantity: { kind: "adaptive" },
      clientRequestId: `it-${randomUUID()}`,
    },
    `run-key-${randomUUID()}`,
  );
  const runId = createResult.runId;
  assert.equal(createResult.status, "planning");

  // Evidence seal 断言：snapshots + eligibility 已写入
  const sealCount = await admin`
    SELECT count(*)::int AS n FROM evidence_snapshots_v2
    WHERE workspace_id = ${WORKSPACE_ID}`;
  assert.ok(sealCount[0].n >= 1, "evidence snapshots must be sealed at source_sealing");
  const eligCount = await admin`
    SELECT count(*)::int AS n FROM evidence_eligibility_states_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND status = 'usable'`;
  assert.ok(eligCount[0].n >= 1, "evidence eligibility must be usable");

  // ─── 2. Worker 侧（ailearn_worker，NOBYPASSRLS）消费 outbox ───────────────
  const { pollV2Outbox } = await import("../handlers/card-generation-v2-handler.ts");
  const processed = await pollV2Outbox(5);
  assert.ok(processed >= 1, `worker must claim and process the outbox job (got ${processed})`);

  const runState = await admin`
    SELECT status FROM card_generation_runs_v2 WHERE id = ${runId} AND workspace_id = ${WORKSPACE_ID}`;
  assert.ok(
    ["review_ready", "needs_attention"].includes(runState[0]?.status ?? ""),
    `run must reach review_ready or needs_attention (got ${runState[0]?.status})`,
  );

  // 无论 review_ready 还是 needs_attention，候选行必须存在（authoring 已执行）
  const candidateCount = await admin`
    SELECT count(*)::int AS n FROM card_generation_candidates_v2
    WHERE run_id = ${runId} AND workspace_id = ${WORKSPACE_ID}`;
  assert.ok(candidateCount[0].n >= 1, "candidates must be authored");

  // ─── 3. 若 review_ready：激活（原子创建 Objective/Card/Receipt/Reminder） ──
  if (runState[0]?.status === "review_ready") {
    const { getGenerationRunCandidatesV2 } = await import(
      "../../../../apps/api/src/modules/card-generation-v2/generation-run-service.ts"
    );
    const { getGenerationRunPlanV2 } = await import(
      "../../../../apps/api/src/modules/card-generation-v2/generation-run-service.ts"
    );
    const candidates = await getGenerationRunCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID }, runId,
    );
    assert.ok(candidates && candidates.length >= 1, "review_ready must expose candidates");
    const kept = candidates.filter((c: { qualityState: string }) => c.qualityState === "passed");
    assert.ok(kept.length >= 1, "passed candidates must exist");

    const plan = await getGenerationRunPlanV2({ workspaceId: WORKSPACE_ID, userId: USER_ID }, runId);
    assert.ok(plan, "plan must be readable");

    const first = kept[0] as unknown as {
      candidateId: string; candidateRevisionId: string; revision: number;
      candidateRevisionHash: string; evidenceBindingPlanHash: string | null;
      runId: string; planRevisionId: string; planVersion: number;
    };
    const runRow = await admin`
      SELECT review_draft_revision, card_content_epoch, source_snapshot_hash,
             semantic_spec_hash, input_snapshot_hash
      FROM card_generation_runs_v2 WHERE id = ${runId}`;
    const reviewDraftRevision = runRow[0].review_draft_revision;
    const expectedCardContentEpoch = Number(runRow[0].card_content_epoch);

    // clientReviewHash 由服务端重建校验——传服务端等价值（review-ui-v1）
    const { computeClientReviewHashV2 } = await import(
      "../../../../packages/shared/src/card-generation-v2-hashing.ts"
    );
    const clientReviewHash = computeClientReviewHashV2({
      runId,
      expectedReviewDraftRevision: reviewDraftRevision,
      selected: [{ candidateId: first.candidateId, revision: first.revision, revisionHash: first.candidateRevisionHash }],
      reviewUiContractVersion: "review-ui-v1",
    });

    const receipt = await activateCardCandidatesV2(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      {
        version: 2,
        runId,
        sourceSnapshotHash: runRow[0].source_snapshot_hash,
        semanticSpecHash: runRow[0].semantic_spec_hash,
        inputSnapshotHash: runRow[0].input_snapshot_hash,
        expectedCardContentEpoch,
        planRevisionId: plan.planRevisionId,
        expectedPlanVersion: plan.planVersion,
        planHash: plan.planHash,
        selectedCandidates: [{
          candidateRevisionId: first.candidateRevisionId,
          candidateId: first.candidateId,
          revision: first.revision,
          revisionHash: first.candidateRevisionHash,
          candidateEvidenceBindingPlanHash: first.evidenceBindingPlanHash ?? "",
          qualityReportHashes: [],
          intent: { kind: "create_new" },
        }],
        existingLifecycleActions: [],
        expectedReviewDraftRevision: reviewDraftRevision,
        clientReviewHash,
      },
      `activate-key-${randomUUID()}`,
    );

    assert.equal(receipt.mappings.length, 1);
    assert.ok(receipt.mappings[0].objectiveId.length > 0);
    assert.ok(receipt.mappings[0].cardId.length > 0);

    // 激活后：Objective/Card/Publication/Reminder 存在；Schedule 必须为 0（§16.7）
    const objCount = await admin`
      SELECT count(*)::int AS n FROM learning_objectives_v2
      WHERE workspace_id = ${WORKSPACE_ID} AND lifecycle = 'active'`;
    assert.equal(objCount[0].n, 1, "exactly one active objective");

    const reminderCount = await admin`
      SELECT count(*)::int AS n FROM initial_validation_reminders_v2
      WHERE workspace_id = ${WORKSPACE_ID} AND user_id = ${USER_ID}`;
    assert.equal(reminderCount[0].n, 1, "initial validation reminder must be created");

    const scheduleCount = await admin`
      SELECT count(*)::int AS n FROM review_schedules
      WHERE workspace_id = ${WORKSPACE_ID}`;
    assert.equal(scheduleCount[0].n, 0, "activation must NOT create any schedule");
  }
});
