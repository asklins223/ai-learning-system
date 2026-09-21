/**
 * 0249 实时进度读数（方案 §21 A2）——真 Postgres、零 AI 调用。
 *
 * 这批要钉住的不是"进度好看"，而是三条会静默骗人的性质：
 * 1. 读数在**整批提交之前**就能被 API 读到（这是 #2 的全部诉求：以前 authoring
 *    期间候选行还没提交，`progress.authored` 恒为 0）；
 * 2. 租约被抢走之后，旧 worker 写不进读数（fence）；
 * 3. 读数一旦出自一条**已死**的租约，读取端就不再看它——否则 worker 崩在半路会把
 *    界面永远停在"已写 7 张"，而那 7 张其实根本不存在。
 *
 * 运行：
 *   DATABASE_URL_MIGRATOR=postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn \
 *   node --import tsx --test workers/ai-worker/src/integration-tests/card-generation-v2-live-progress-postgres.integration.ts
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR
  ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
// 以 ailearn_worker（NOBYPASSRLS）跑写入方：RLS 策略与授权清单都要被真正走一遍。
process.env.DATABASE_URL_WORKER ??= "postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_API ??= ADMIN_URL;

const admin = postgres(ADMIN_URL, { max: 2 });

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const NOTE_ID = randomUUID();
const VERSION_ID = randomUUID();

const NOTE_CONTENT =
  "OSI 模型把网络通信分为七层：物理层负责比特流传输；数据链路层负责帧与纠错；网络层负责路由；传输层负责端到端传输；会话层负责会话管理；表示层负责数据格式转换；应用层提供应用接口。";

let runId = "";

before(async () => {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`live-progress-${USER_ID}@example.invalid`}, 'unused')
      ON CONFLICT (id) DO NOTHING`;
    // 同意三列自 0237 起在 `user_ai_settings`，不在 workspaces 上——
    // 同目录那份 v2-postgres 集成测试还按旧列写种子，抄它会直接报错。
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'Live Progress IT')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, 'Live progress note', ${USER_ID}) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${VERSION_ID}, ${NOTE_ID}, ${WORKSPACE_ID}, 1,
              ${tx.json({ blocks: [{ type: "paragraph", content: NOTE_CONTENT }] })},
              'live-progress-hash', ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal)
      VALUES (${randomUUID()}, ${VERSION_ID}, ${WORKSPACE_ID}, 'paragraph', ${NOTE_CONTENT}, 1)
      ON CONFLICT (id) DO NOTHING`;
  });

  // run 与 outbox 直接落 SQL，不走 `createGenerationRunV2`：那条服务在
  // `generation-run-service.ts:160` 读 `notes` 的**全列**，而工作区里的 drizzle
  // schema 已经带上尚未应用的 `notes.share_scope`（在途迁移 0248）——照它建 run 会
  // 先把这条测试变成别人进度的受害者。这里要的只是一行 run + 一条待认领的 job。
  runId = randomUUID();
  const hash = "a".repeat(64);
  await admin`
    INSERT INTO card_generation_runs_v2
      (id, workspace_id, user_id, note_id, note_version_id, idempotency_key,
       status, semantic_spec_hash, input_snapshot_hash, generation_fingerprint,
       source_snapshot_hash, source_content_hash, block_manifest_hash,
       asset_manifest_hash, scope_manifest_hash)
    VALUES
      (${runId}, ${WORKSPACE_ID}, ${USER_ID}, ${NOTE_ID}, ${VERSION_ID},
       ${`live-progress-${runId}`}, 'planning', ${hash}, ${hash}, ${hash},
       ${hash}, ${hash}, ${hash}, ${hash}, ${hash})
  `;
  await admin`
    INSERT INTO card_generation_run_outbox_v2 (workspace_id, run_id, job_type, payload)
    VALUES (${WORKSPACE_ID}, ${runId}, 'card_generation_plan', '{}'::jsonb)
  `;
});

after(async () => {
  await admin`DELETE FROM card_generation_run_progress_v2 WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM card_generation_run_outbox_v2 WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM card_generation_runs_v2 WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM note_blocks WHERE version_id = ${VERSION_ID}`.catch(() => undefined);
  await admin`DELETE FROM note_versions WHERE id = ${VERSION_ID}`.catch(() => undefined);
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

/**
 * 认领本 run 的 plan job，返回 handler 那一份 job 对象（含 leaseToken）。
 * 先把 job 退回 pending 再认领：每条用例都要一把**新**租约，否则第二条起
 * `claimV2OutboxJobs`（只吃 pending）会认领不到东西，测试就变成在测 claim。
 */
async function claimPlanJob() {
  await admin`
    UPDATE card_generation_run_outbox_v2
    SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
        started_at = NULL, processed_at = NULL, next_attempt_at = NULL
    WHERE run_id = ${runId} AND job_type = 'card_generation_plan'
  `;
  const { claimV2OutboxJobs } = await import("../handlers/card-generation-v2-handler.ts");
  const jobs = await claimV2OutboxJobs(20);
  const job = jobs.find((candidate) => candidate.runId === runId);
  assert.ok(job, `未认领到本 run 的 outbox job（认领到 ${jobs.length} 条）`);
  return job;
}

async function readProgressRow() {
  const rows = await admin`
    SELECT lease_token, progress FROM card_generation_run_progress_v2 WHERE run_id = ${runId}
  `;
  return rows[0] as { lease_token: string; progress: Record<string, number> } | undefined;
}

async function readRunView() {
  const { getGenerationRunV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/generation-run-service.ts"
  );
  return getGenerationRunV2({ workspaceId: WORKSPACE_ID, userId: USER_ID }, runId);
}

test("读数在提交前就可见：写一次 → 行在、数字在、API 视图也带上了", async () => {
  const { writeCardGenerationLiveProgress } = await import("../handlers/card-generation-v2-handler.ts");
  const job = await claimPlanJob();

  // 界面上"第几步"看的是 run.status，这里把它推到 authoring（管道真实会推的值）。
  await admin`UPDATE card_generation_runs_v2 SET status = 'authoring' WHERE id = ${runId}`;

  const written = await writeCardGenerationLiveProgress(job, {
    plannedCards: 8, authored: 3, gatePassed: 0, gateFailed: 0,
  });
  assert.equal(written, true);

  const stored = await readProgressRow();
  assert.ok(stored, "读数行没落库");
  assert.equal(stored.progress.authored, 3);
  assert.equal(stored.progress.plannedCards, 8);

  // 候选表此刻一张都没有——这正是旧读数恒 0 的原因；换源之后视图必须报 3/8。
  const candidateRows = await admin`SELECT 1 FROM card_generation_candidates_v2 WHERE run_id = ${runId}`;
  assert.equal(candidateRows.length, 0);
  const view = await readRunView();
  assert.equal(view?.progress?.authored, 3);
  assert.equal(view?.progress?.plannedCards, 8);
});

test("fence：租约被抢走后，旧 worker 的写入 0 影响、内容不变", async () => {
  const { writeCardGenerationLiveProgress } = await import("../handlers/card-generation-v2-handler.ts");
  const job = await claimPlanJob();
  assert.equal(await writeCardGenerationLiveProgress(job, {
    plannedCards: 8, authored: 4, gatePassed: 0, gateFailed: 0,
  }), true);
  const before = await readProgressRow();
  assert.equal(before?.lease_token, job.leaseToken);

  // reaper 抢走租约（换 token 并仍标 processing，等价于"另一个 worker 接管了"）。
  await admin`
    UPDATE card_generation_run_outbox_v2
    SET lease_token = gen_random_uuid(), lease_expires_at = now() + interval '30 minutes'
    WHERE run_id = ${runId} AND job_type = 'card_generation_plan'
  `;

  assert.equal(await writeCardGenerationLiveProgress(job, {
    plannedCards: 8, authored: 7, gatePassed: 0, gateFailed: 0,
  }), false);
  const after = await readProgressRow();
  assert.equal(after?.progress.authored, 4, "过期租约把读数改掉了");
  assert.equal(after?.lease_token, job.leaseToken);
});

test("租约一死，读取端就不再信这条读数（回到候选表的真 0）", async () => {
  const { writeCardGenerationLiveProgress } = await import("../handlers/card-generation-v2-handler.ts");
  const job = await claimPlanJob();
  await admin`UPDATE card_generation_runs_v2 SET status = 'authoring' WHERE id = ${runId}`;
  assert.equal(await writeCardGenerationLiveProgress(job, {
    plannedCards: 8, authored: 5, gatePassed: 0, gateFailed: 0,
  }), true);
  assert.equal((await readRunView())?.progress?.authored, 5);

  // worker 崩了：租约过期，还没人接管。半路的读数不能变成界面上的既成事实。
  await admin`
    UPDATE card_generation_run_outbox_v2
    SET lease_expires_at = now() - interval '1 minute'
    WHERE run_id = ${runId} AND job_type = 'card_generation_plan'
  `;
  assert.equal((await readRunView())?.progress?.authored, 0);
});

test("到终态之后读数退役：候选表才是真相，读数不得反超", async () => {
  const { writeCardGenerationLiveProgress } = await import("../handlers/card-generation-v2-handler.ts");
  const job = await claimPlanJob();
  assert.equal(await writeCardGenerationLiveProgress(job, {
    plannedCards: 8, authored: 8, gatePassed: 0, gateFailed: 0,
  }), true);
  await admin`UPDATE card_generation_runs_v2 SET status = 'review_ready' WHERE id = ${runId}`;
  // review_ready 却没有候选行 = 这条 run 是测试造出来的终态；重点是"读数不再参与"。
  assert.equal((await readRunView())?.progress?.authored, 0);
});

/**
 * 最后一条要钉的是**tick 点落在活路径上**：前四条只证明"有人调用写入函数时它是对的"，
 * 而调用点在 `mapWithConcurrency` 的循环体里——如果那个位置其实在死支上，前四条照样全绿。
 * 所以这里用**确定性 provider**（不出网、不花钱）把整条真管道跑一遍，再要求读数表里
 * 留下的正是最后一次 tick 的数字。
 */
test("真跑一遍确定性管道：作者循环里的 tick 确实落了盘", async () => {
  // 前四条用例把那条手搓 run 停在 authoring/review_ready 上，而 in-flight 守卫是按
  // 笔记判的——不收尾就再也建不了新 run（这正是 §21 里 A1 会撞上的同一道守卫）。
  await admin`UPDATE card_generation_runs_v2 SET status = 'cancelled' WHERE id = ${runId}`;
  const { createGenerationRunV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/generation-run-service.ts"
  );
  const created = await createGenerationRunV2(
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    VERSION_ID,
    {
      version: 2,
      noteVersionId: VERSION_ID,
      sourceScope: { kind: "whole_note" },
      learningGoal: "understand",
      detailThreshold: "balanced",
      quantity: { kind: "adaptive" },
      clientRequestId: `live-progress-pipeline-${randomUUID()}`,
    },
    `live-progress-pipeline-${randomUUID()}`,
  );
  const pipelineRunId = created.runId;

  // 只从 pending 认领：dev 容器里的 worker 也在轮询同一张库，被它抢走时这条断言
  // 会明确喊出来（而不是把"谁的租约"当成测试前提）。
  const leaseToken = randomUUID();
  const claimed = await admin`
    UPDATE card_generation_run_outbox_v2
    SET status = 'processing', started_at = now(), lease_expires_at = now() + interval '30 minutes',
        lease_token = ${leaseToken}
    WHERE run_id = ${pipelineRunId} AND job_type = 'card_generation_plan' AND status = 'pending'
    RETURNING id, workspace_id, run_id, job_type, payload
  `;
  assert.equal(claimed.length, 1, "dev 容器的 worker 抢走了这条 job（重跑即可）");
  const row = claimed[0] as { id: string; workspace_id: string; run_id: string; job_type: string; payload: Record<string, unknown> };

  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  await processV2OutboxJob({
    id: row.id, workspaceId: row.workspace_id, runId: row.run_id,
    jobType: row.job_type, payload: row.payload as Record<string, unknown>, leaseToken,
  });

  const [jobState] = await admin`
    SELECT status, last_error FROM card_generation_run_outbox_v2 WHERE id = ${row.id}
  ` as unknown as Array<{ status: string; last_error: string | null }>;
  assert.equal(jobState.status, "completed",
    `管道没跑完：job=${jobState.status} last_error=${jobState.last_error}`);

  const committed = await admin`
    SELECT COUNT(DISTINCT candidate_id)::int AS n FROM card_generation_candidates_v2
    WHERE run_id = ${pipelineRunId}
  `;
  const authoredCards = (committed[0] as { n: number }).n;
  const stored = await admin`
    SELECT lease_token, progress FROM card_generation_run_progress_v2 WHERE run_id = ${pipelineRunId}
  `;
  const live = stored[0] as { lease_token: string; progress: Record<string, number> } | undefined;
  assert.ok(live, "整条管道跑完，读数表里一行都没有 → tick 点不在活路径上");
  assert.equal(live.lease_token, leaseToken);
  // 循环里那张卡一张卡地 tick 过：最后一次必须等于**真正写进候选表的张数**。
  assert.ok(authoredCards >= 1, `确定性管道没写出任何候选（${authoredCards}），这条断言就无从判断`);
  assert.equal(live.progress.authored, authoredCards);
  assert.equal(live.progress.plannedCards >= authoredCards, true);
});
