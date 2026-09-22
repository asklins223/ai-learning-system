/**
 * A1 · B1：计划先进库，重投接着跑 —— 真 Postgres、零 AI 调用。
 *
 * 为什么要有这一份（§39）：A1 不是"把 INSERT 挪早一点"。今天四阶段全在**一个**事务里，
 * 计划行、候选行、终态要么一起出现要么一起消失；于是"崩在作者中途"= 整批作废，
 * 而入口守卫只能看 `run.status`——状态一旦提前提交，守卫就把重投变成**静默空转**
 * （run 永远停在 authoring，这篇笔记此后每次生成都吃 409，§21 的原始担忧）。
 * B1 要同时兑现三件事，缺一件就是换了个死法：
 *
 * 1. **计划行属于它自己那次提交**（断言方式不是"跑过了"，而是留下字符事实）：
 *    事件行的 `created_at` 是**事务时间**，所以 `plan_completed` 与第一张
 *    `card_candidate.authored` 的时间一旦**不相等**，两者就不可能来自同一个事务。
 * 2. **重投读回已提交的那一版计划，不再规划一次**：`planRevisionId` 每次执行现造
 *    （`planner-service.ts:373` 的 randomUUID），所以"计划行还是那一条、
 *    plan_revision_id 没变"就是"没重新付费"的直接证据；同时候选必须**重新长出来**，
 *    否则就是 §21 说的那种空转。
 * 3. **判活看租约，不看状态**：租约已经不是我的一条 job，一个字的写都不许留下；
 *    终态则安静让路（今天的行为，留着当回归）。
 *
 * 运行：
 *   DATABASE_URL_MIGRATOR=postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn \
 *   node --import tsx --test --test-timeout=180000 \
 *     workers/ai-worker/src/integration-tests/card-generation-v2-plan-commit-postgres.integration.ts
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR
  ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_WORKER ??= "postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_API ??= ADMIN_URL;
delete process.env.CARD_GENERATION_V2_LLM;

const admin = postgres(ADMIN_URL, { max: 2 });

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const NOTE_ID = randomUUID();
const VERSION_ID = randomUUID();

const NOTE_BLOCKS = [
  "TCP 建立连接时双方各自确认一次序号，确认完成之后才开始传数据。",
  "HTTP 是无状态协议，服务端默认不记得上一个请求发生过什么。",
  "对称加密的密钥必须事先约定好，非对称加密用公钥加密、私钥解密。",
  "DNS 解析先把域名换成 IP 地址，之后才向目标服务器发起连接。",
  "TLS 握手在应用层数据之前完成，它协商的是加密套件和会话密钥。",
  "TCP 的重传由超时或重复确认触发，不由应用层自己决定何时重发。",
];

let runId = "";

before(async () => {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`plan-commit-${USER_ID}@example.invalid`}, 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'Plan Commit IT') ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, 'Plan commit note', ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${VERSION_ID}, ${NOTE_ID}, ${WORKSPACE_ID}, 1,
              ${tx.json({ blocks: NOTE_BLOCKS.map((content) => ({ type: "paragraph", content })) })},
              'plan-commit-hash', ${USER_ID}) ON CONFLICT (id) DO NOTHING`;
    for (const [ordinal, content] of NOTE_BLOCKS.entries()) {
      await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal)
        VALUES (${randomUUID()}, ${VERSION_ID}, ${WORKSPACE_ID}, 'paragraph', ${content}, ${ordinal + 1})
        ON CONFLICT (id) DO NOTHING`;
    }
  });

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
      clientRequestId: `plan-commit-${randomUUID()}`,
    },
    `plan-commit-${randomUUID()}`,
  );
  runId = created.runId;
});

after(async () => {
  const wipe = async (statement: string) => {
    await admin.unsafe(statement.replace(/\?/g, () => `'${WORKSPACE_ID}'`)).catch(() => undefined);
  };
  await wipe("DELETE FROM card_generation_run_progress_v2 WHERE workspace_id = ?");
  await wipe("DELETE FROM card_generation_events_v2 WHERE workspace_id = ?");
  await wipe("DELETE FROM card_candidate_quality_reports_v2 WHERE workspace_id = ?");
  await wipe("DELETE FROM candidate_evidence_binding_plans_v2 WHERE workspace_id = ?");
  await wipe("DELETE FROM card_generation_candidates_v2 WHERE workspace_id = ?");
  await wipe("DELETE FROM card_generation_run_outbox_v2 WHERE workspace_id = ?");
  await wipe("DELETE FROM card_generation_plans_v2 WHERE workspace_id = ?");
  await wipe("DELETE FROM card_generation_runs_v2 WHERE workspace_id = ?");
  await admin`DELETE FROM note_blocks WHERE version_id = ${VERSION_ID}`.catch(() => undefined);
  await admin`DELETE FROM note_versions WHERE id = ${VERSION_ID}`.catch(() => undefined);
  await admin`DELETE FROM notes WHERE id = ${NOTE_ID}`.catch(() => undefined);
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM workspaces WHERE id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM users WHERE id = ${USER_ID}`.catch(() => undefined);
  await admin.end({ timeout: 5 });
  const { closeDatabase: closeWorkerDatabase } = await import("../db.ts");
  await closeWorkerDatabase().catch(() => undefined);
  const { closeDatabase } = await import("../../../../apps/api/src/db/client.ts");
  await closeDatabase().catch(() => undefined);
});

interface PlanJob {
  id: string; workspaceId: string; runId: string; jobType: string;
  payload: Record<string, unknown>; leaseToken: string;
}

/**
 * 把 plan job 认领下来。
 *
 * `replay: true` 时先把行退回 pending 再认领（生产里这一步是回收器干的：租约过期 →
 * attempts+1 → 重投）；测试要验的是"重投"这个**结果**，所以直接造成结果，不模拟墙钟。
 *
 * 两种写法都必须**退回到 pending 与认领写在同一个事务里**：dev 容器的 worker 每秒轮询
 * 同一张 outbox 表，两条语句之间只要留出一个往返，它就可能抢走（实测真发生过），而它
 * 抢走之后是**真跑一遍 LLM**，这条测试的断言对象就成了别人跑出来的批次。事务未提交前
 * 那几行对别的 poller 不可见，所以窗口为 0。
 */
async function claimPlanJob(options: { replay?: boolean } = {}): Promise<PlanJob> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const leaseToken = randomUUID();
    const outcome = await admin.begin(async (tx) => {
      const states = await tx`
        SELECT status, (lease_token IS NOT NULL AND lease_expires_at > now()) AS live_lease
        FROM card_generation_run_outbox_v2
        WHERE run_id = ${runId} AND job_type = 'card_generation_plan' FOR UPDATE
      ` as unknown as Array<{ status: string; live_lease: boolean }>;
      const status = states[0]?.status;
      if (status === "completed" && !options.replay) return { blocked: true as const };
      // 只让路给**还活着的**持有者（token 在、没过期）——这正是回收器的判据。
      if (status === "processing" && states[0]?.live_lease) return { blocked: false as const };
      await tx`
        UPDATE card_generation_run_outbox_v2
        SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
            started_at = NULL, processed_at = NULL, next_attempt_at = NULL
        WHERE run_id = ${runId} AND job_type = 'card_generation_plan'
      `;
      const claimed = await tx`
        UPDATE card_generation_run_outbox_v2
        SET status = 'processing', started_at = now(),
            lease_expires_at = now() + interval '30 minutes', lease_token = ${leaseToken}
        WHERE run_id = ${runId} AND job_type = 'card_generation_plan' AND status = 'pending'
        RETURNING id, workspace_id, run_id, job_type, payload
      ` as unknown as Array<{ id: string; workspace_id: string; run_id: string;
        job_type: string; payload: Record<string, unknown> }>;
      return { blocked: false as const, claimed };
    });
    const row = "claimed" in outcome ? outcome.claimed?.[0] : undefined;
    if (row) {
      return {
        id: row.id, workspaceId: row.workspace_id, runId: row.run_id,
        jobType: row.job_type, payload: row.payload, leaseToken,
      };
    }
    if (outcome.blocked) {
      assert.fail("这条 job 在第一遍认领之前就已经是 completed：dev 容器抢跑了，本测试只认自己跑出来的批次");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("40 次尝试内没能认领到本 run 的 plan job");
}

async function runPlanJob(options: { replay?: boolean } = {}): Promise<PlanJob> {
  const job = await claimPlanJob(options);
  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  await processV2OutboxJob(job);
  return job;
}

async function countRows(table: "card_generation_plans_v2" | "card_generation_candidates_v2"): Promise<number> {
  const rows = await admin`
    SELECT count(*)::int AS n FROM ${admin(table)}
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId}
  `;
  return Number((rows as Array<Record<string, unknown>>)[0]?.n ?? 0);
}

const planCount = () => countRows("card_generation_plans_v2");
const candidateCount = () => countRows("card_generation_candidates_v2");

async function eventTimes(eventType: string): Promise<string[]> {
  const rows = await admin`
    SELECT created_at FROM card_generation_events_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId} AND event_type = ${eventType}
    ORDER BY event_seq
  `;
  return rows.map((r) => String((r as { created_at: Date }).created_at));
}

async function runStatus(): Promise<string> {
  const rows: Array<{ status: string }> = await admin`
    SELECT status FROM card_generation_runs_v2 WHERE id = ${runId}
  `;
  return rows[0].status;
}

async function committedPlanRevisionId(): Promise<string> {
  const rows: Array<{ plan_revision_id: string }> = await admin`
    SELECT plan_revision_id FROM card_generation_plans_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId} ORDER BY plan_version LIMIT 1
  `;
  return rows[0]?.plan_revision_id ?? "";
}

test("计划行不在作者那一次提交里：两条事件来自两个不同的事务", async () => {
  await runPlanJob();

  assert.equal(await planCount(), 1, "计划行没落库");
  assert.ok(await candidateCount() > 0, "候选一行都没有，无法比较两次提交");

  // 判据用 `xmin`（写下这行的事务号），不用 `created_at`：后者走 `now()`，是**事务**
  // 时间，同事务里写的所有行必然一模一样——但毫秒精度会撞，拿它当"是不是同一个事务"
  // 的证据会时红时绿。事务号没有这种运气问题：同事务 = 同一个号，不同事务 = 不同号。
  const rows: Array<{ event_type: string; xact: string }> = await admin`
    SELECT event_type, xmin::text AS xact FROM card_generation_events_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId}
      AND event_type IN ('card_generation.plan_completed', 'card_candidate.authored')
    ORDER BY event_seq
  `;
  const planRow = rows.find((r) => r.event_type === "card_generation.plan_completed");
  const firstAuthored = rows.find((r) => r.event_type === "card_candidate.authored");
  assert.ok(planRow && firstAuthored, "两段事件缺一段：规划或作者没留下事件");
  assert.notEqual(planRow.xact, firstAuthored.xact,
    `plan_completed 与第一张 authored 出自同一个事务（xmin ${planRow.xact}）—— 计划还和作者捆在一个大事务里，崩在中途会连计划一起回滚`);
});

test("崩在作者中途后重投：读回已提交的那一版计划，不再规划一次、也不空转", async () => {
  const firstPlanRevisionId = await committedPlanRevisionId();
  assert.ok(firstPlanRevisionId, "第一条用例没留下计划");

  // 造出 B1 之后才会存在的那个状态：计划已提交、作者跑到一半进程没了。
  await admin`DELETE FROM card_generation_candidates_v2 WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId}`;
  await admin`
    UPDATE card_generation_runs_v2 SET status = 'authoring', updated_at = now()
    WHERE id = ${runId} AND workspace_id = ${WORKSPACE_ID}
  `;
  const beforeAuthored = (await eventTimes("card_candidate.authored")).length;

  await runPlanJob({ replay: true });

  assert.equal(await planCount(), 1,
    "重投又写了一条计划——等于把 planner 那一遍付费调用重放了一次");
  assert.equal(await committedPlanRevisionId(), firstPlanRevisionId,
    "计划身份变了：重放没有读回已提交的那一版，而是重新规划");
  assert.ok(await candidateCount() > 0,
    "重投什么也没补：守卫还是只看 run.status，把接着跑的机会直接 return 掉了");
  assert.ok((await eventTimes("card_candidate.authored")).length > beforeAuthored,
    "候选补出来了却没留事件（审核页读不到这次重投干了什么）");
  assert.notEqual(await runStatus(), "authoring", "重投之后 run 仍停在 authoring：静默空转");
});

test("租约不是我的：一个字的写都不许留下", async () => {
  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  // 先把 run 摆回"还有活可干"的状态：门闩要挡的是**真去干活**的过期租约，
  // 一个已经终态的 run 本来就会被让路分支挡下，那种绿不算数。
  await admin`
    UPDATE card_generation_runs_v2 SET status = 'planning', error_code = NULL, updated_at = now()
    WHERE id = ${runId} AND workspace_id = ${WORKSPACE_ID}
  `;
  const held = await claimPlanJob({ replay: true });
  // 另一把租约的持有者正在跑（这里不真跑它，只把状态摆出来）。
  const plansBefore = await planCount();
  const candidatesBefore = await candidateCount();

  const impostorToken = randomUUID();
  await processV2OutboxJob({ ...held, leaseToken: impostorToken }).catch(() => undefined);

  assert.equal(await planCount(), plansBefore, "过期租约把计划又写了一遍");
  assert.equal(await candidateCount(), candidatesBefore, "过期租约把候选又写了一遍");
  const jobs: Array<{ lease_token: string; status: string }> = await admin`
    SELECT lease_token, status FROM card_generation_run_outbox_v2 WHERE id = ${held.id}
  `;
  assert.equal(String(jobs[0].lease_token), held.leaseToken,
    "不是我的租约却把别人的 job 行改掉了（失败回写也必须过同一道 token 门闩）");

  // 真持有者交还租约（生产里是停机/退出时干的），后面几条用例才不会被一个
  // 没人认领的活租约挡住——顺带让 `releaseV2OutboxLease` 也有一条真库用例。
  const { releaseV2OutboxLease } = await import("../handlers/card-generation-v2-handler.ts");
  assert.equal(await releaseV2OutboxLease(held.id, held.leaseToken), true,
    "持有者交还自己的租约没生效");
});

test("已经出结果的批次：重投安静让路，不重写计划也不改终态", async () => {
  // 自己跑出一个终态批次，不蹭上一条用例留下的状态（上一条会把 run 摆回 planning）。
  await admin`DELETE FROM card_generation_candidates_v2 WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId}`;
  await admin`DELETE FROM card_generation_plans_v2 WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId}`;
  await admin`
    UPDATE card_generation_runs_v2 SET status = 'planning', updated_at = now()
    WHERE id = ${runId} AND workspace_id = ${WORKSPACE_ID}
  `;
  await runPlanJob({ replay: true });
  const statusBefore = await runStatus();
  assert.ok(
    ["review_ready", "needs_attention", "no_cards_recommended"].includes(statusBefore),
    `上一遍没走到终态（${statusBefore}），这条用例的前提不成立`,
  );
  const plansBefore = await planCount();
  const candidatesBefore = await candidateCount();

  await runPlanJob({ replay: true });

  assert.equal(await planCount(), plansBefore, "终态批次被重投又规划了一遍");
  assert.equal(await candidateCount(), candidatesBefore, "终态批次被重投又补了候选");
  assert.equal(await runStatus(), statusBefore, "终态被重投改掉了");
});
