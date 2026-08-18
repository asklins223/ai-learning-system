/**
 * commit_requested outbox 全链路集成测试（真实 Postgres）。
 *
 * 链路：评估已完成（learning_assessment_reports 落库 + episode
 * processing_phase='assessment_complete'）→ outbox 入队 commit_requested
 * → API claim（0109 SECURITY DEFINER 函数）→ processCommitOutboxJob
 * （stabilizeEpisode：Pg repo + Pg Commit executor）→ commit 应用
 * （learning_outbox_events canonical + review_schedules + episode 终态
 * completed/committed）→ committed_change_display proactive 触发
 * （companion_action_ledger 记录）。
 *
 * 环境：DATABASE_URL_API（容器内 postgres）；无 DB 时 skip。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL_API 未配置——commit-outbox 集成测试要求真实 Postgres");
}
const sql = postgres(databaseUrl, { max: 2 });

after(async () => {
  await sql.end().catch(() => undefined);
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase().catch(() => undefined);
});

import { seedV2Fixture } from "./helpers/v2-card-fixture.ts";
import {
  claimCommitRequested,
  markCommitOutboxProcessed,
  processCommitOutboxJob,
} from "../modules/learning-sessions/commit-outbox.ts";

async function seedCommitFixture() {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "claim",
    publicSummary: "遗忘曲线",
    front: { cue: "遗忘曲线", prompt: "什么是遗忘曲线？" },
  });
  return {
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    cardId: fixture.cardId,
    keyPointId: fixture.objectiveId,
    episodeId: fixture.noteId, // episodeId uses noteId as proxy for test scope
    artifactId: fixture.noteVersionId, // artifactId uses noteVersionId as proxy
    cleanup: fixture.cleanup,
  };
}

test("commit_requested 全链路：claim → stabilize → commit 应用 → episode 终态 → proactive 触发", async () => {
  const fixture = await seedCommitFixture();
  try {
    // 1. claim（SECURITY DEFINER 跨 workspace）
    const job = await claimCommitRequested("it-worker", 60_000, new Date());
    assert.ok(job, "claim 应拿到 commit_requested 行");
    assert.equal(job?.episodeId, fixture.episodeId);
    assert.equal(job?.artifactId, fixture.artifactId);

    // 2. 消费编排
    const outcome = await processCommitOutboxJob(job!);
    assert.equal(outcome, "committed", "评估完成的 voice episode 应提交成功");

    // 3. episode 终态（0098：completed ⇒ committed）
    const epRows = await sql`SELECT status, processing_phase FROM learning_episodes WHERE id = ${fixture.episodeId}`;
    assert.equal(epRows[0]?.status, "completed");
    assert.equal(epRows[0]?.processing_phase, "committed");

    // 4. canonical outbox event 落库（voice → validation.event；review → reviewed）
    const outboxRows = await sql`SELECT event_type FROM learning_outbox_events WHERE workspace_id = ${fixture.workspaceId}`;
    assert.ok(outboxRows.length > 0, "commit 应写 canonical learning_outbox_events");
    const eventTypes = outboxRows.map((r) => String(r.event_type));
    assert.ok(
      eventTypes.some((e) => e.includes("reviewed") || e.includes("validation")),
      `含 canonical 事件，实际: ${eventTypes.join(",")}`,
    );

    // 5. schedule 生效（create_initial）
    const scheduleRows = await sql`SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${fixture.workspaceId} AND status = 'pending'`;
    assert.equal(Number(scheduleRows[0]?.n), 1, "create_initial 应产生恰好一条 pending schedule");

    // 6. committed_change_display proactive 触发（ledger 生效）
    const ledgerRows = await sql`SELECT count(*)::int AS n FROM companion_invitation_ledger WHERE user_id = ${fixture.userId}`;
    assert.ok(Number(ledgerRows[0]?.n) >= 1, "commit 应用后应产生 proactive ledger 记录");

    // 7. markProcessed（幂等闭环）
    await markCommitOutboxProcessed(job!.id, "it-worker");
    const outboxState = await sql`SELECT processed_at IS NOT NULL AS done FROM learning_session_processing_outbox WHERE id = ${job!.id}`;
    assert.equal(outboxState[0]?.done, true);
  } finally {
    await fixture.cleanup().catch(() => undefined);
  }
});

test("commit_requested：claim 无候选 → null（不炸）", async () => {
  const job = await claimCommitRequested("it-worker", 60_000, new Date());
  assert.ok(job === null || typeof job.episodeId === "string");
});
