/**
 * A1 · B2：候选逐张落盘，重放不再付作者的钱 —— 真 Postgres、零 AI 调用。
 *
 * B1 把计划交出去了，但候选仍然要等整批 author + grounding 全部完成才一次性落库——
 * 也就是说"第 1 张就能看见"这件事其实还没发生，而"崩在中途"赔的还是整批作者调用。
 * 这一份钉的就是 B2 的两条承诺：
 *
 * 1. **每张候选各一次提交**。判据用 `card_candidate.authored` 事件行的 `xmin`
 *    （写下这行的事务号）而不是候选行：候选行之后会被评审段的批量 UPDATE 重写，
 *    那时它们共享同一个 xmin，看不出是谁先落的地；事件行只追加、不改，
 *    所以"每张一个事务"就写在事件上。今天一次多行 INSERT → 全部相等。
 * 2. **重放按目标复用已提交的候选**：不再调作者（这一遍省的是最贵的那一段付费），
 *    行数与 `candidate_revision_id` 一字不动，且**跳过这件事在数据上有证人**——
 *    每张被复用的候选留一条 `card_candidate.authored_reused`。
 *    没有这条事件的话，"没再付费"只能靠推理（库里复用与"重写了又被唯一索引挡下"同形）。
 *
 * 运行：
 *   DATABASE_URL_MIGRATOR=postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn \
 *   node --import tsx --test --test-timeout=180000 \
 *     workers/ai-worker/src/integration-tests/card-generation-v2-per-candidate-commit-postgres.integration.ts
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

interface PlanJob {
  id: string; workspaceId: string; runId: string; jobType: string;
  payload: Record<string, unknown>; leaseToken: string;
}

before(async () => {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`per-candidate-${USER_ID}@example.invalid`}, 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'Per Candidate Commit IT') ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, 'Per candidate note', ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${VERSION_ID}, ${NOTE_ID}, ${WORKSPACE_ID}, 1,
              ${tx.json({ blocks: NOTE_BLOCKS.map((content) => ({ type: "paragraph", content })) })},
              'per-candidate-hash', ${USER_ID}) ON CONFLICT (id) DO NOTHING`;
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
      clientRequestId: `per-candidate-${randomUUID()}`,
    },
    `per-candidate-${randomUUID()}`,
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

/** 认领（必要时先退回 pending）本 run 的 plan job——两步必须在同一个事务里。 */
async function claimPlanJob(options: { replay?: boolean; jobType?: string; optional?: boolean } = {}): Promise<PlanJob | null> {
  const jobType = options.jobType ?? "card_generation_plan";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const leaseToken = randomUUID();
    const outcome = await admin.begin(async (tx) => {
      const states = await tx`
        SELECT status, (lease_token IS NOT NULL AND lease_expires_at > now()) AS live_lease
        FROM card_generation_run_outbox_v2
        WHERE run_id = ${runId} AND job_type = ${jobType} FOR UPDATE
      ` as unknown as Array<{ status: string; live_lease: boolean }>;
      const status = states[0]?.status;
      if (status === "completed" && !options.replay) return { blocked: true as const };
      if (status === "processing" && states[0]?.live_lease) return { blocked: false as const };
      await tx`
        UPDATE card_generation_run_outbox_v2
        SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
            started_at = NULL, processed_at = NULL, next_attempt_at = NULL
        WHERE run_id = ${runId} AND job_type = ${jobType}
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
      assert.fail("第一遍认领之前这条 job 就 completed 了：dev 容器抢跑了，本测试只认自己跑出来的批次");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (options.optional) return null;
  assert.fail(`40 次尝试内没能认领到本 run 的 ${options.jobType ?? "card_generation_plan"} job`);
}

async function runPlanJob(options: { replay?: boolean } = {}): Promise<void> {
  const job = await claimPlanJob(options);
  assert.ok(job, "认领不该返回空");
  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  await processV2OutboxJob(job);
}

/**
 * 造一条**已经被本进程认领**的 replan job（一条 INSERT，不经过 pending 状态）。
 *
 * 为什么不叫 api 的 `retryGenerationRunV2` 再认领：它插的是 pending 行，而 dev 容器的
 * poller 每秒扫一次这条表——实测就是被它抢先领走并用真 LLM 跑掉的（成本记在这次测试头上
 * 不合理，也不该由测试来决定何时花钱）。入口守卫（必须 needs_attention +
 * quality_gate_failed、双击 409）是 api 侧的事，已由
 * `apps/api/src/__tests__/card-generation-v2-run-service.test.ts` 覆盖；
 * 本用例要验的是 worker 那条**批量写候选**的路径还活着。
 */
async function insertClaimedReplanJob(): Promise<PlanJob> {
  const leaseToken = randomUUID();
  const rows: Array<{ id: string }> = await admin`
    INSERT INTO card_generation_run_outbox_v2
      (workspace_id, run_id, job_type, payload, status, started_at, lease_token, lease_expires_at)
    VALUES (
      ${WORKSPACE_ID}, ${runId}, 'card_generation_replan_set',
      ${admin.json({ runId, workspaceId: WORKSPACE_ID })},
      'processing', now(), ${leaseToken}, now() + interval '30 minutes'
    )
    RETURNING id
  `;
  return {
    id: rows[0].id, workspaceId: WORKSPACE_ID, runId,
    jobType: "card_generation_replan_set",
    payload: { runId, workspaceId: WORKSPACE_ID }, leaseToken,
  };
}

/** authored 事件出自哪些事务（事件行只追加不改，所以 xmin 就是"谁写下的它"）。 */
async function authoredTransactionIds(): Promise<string[]> {
  const rows: Array<{ xact: string }> = await admin`
    SELECT xmin::text AS xact FROM card_generation_events_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId}
      AND event_type = 'card_candidate.authored'
    ORDER BY event_seq
  `;
  return rows.map((r) => r.xact);
}

async function countEvent(eventType: string): Promise<number> {
  const rows: Array<{ n: number }> = await admin`
    SELECT count(*)::int AS n FROM card_generation_events_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId} AND event_type = ${eventType}
  `;
  return rows[0].n;
}

async function reusedCandidateIds(): Promise<string[]> {
  const rows: Array<{ candidate_id: string }> = await admin`
    SELECT payload ->> 'candidateId' AS candidate_id FROM card_generation_events_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId}
      AND event_type = 'card_candidate.authored_reused'
  `;
  return rows.map((r) => r.candidate_id);
}

async function runStatus(): Promise<string> {
  const rows: Array<{ status: string }> = await admin`
    SELECT status FROM card_generation_runs_v2 WHERE id = ${runId} AND workspace_id = ${WORKSPACE_ID}
  `;
  return rows[0]?.status ?? "";
}

async function candidateRows(): Promise<Array<{ candidate_revision_id: string; quality_state: string; revision: number }>> {
  return await admin`
    SELECT candidate_revision_id, quality_state, revision FROM card_generation_candidates_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId}
    ORDER BY plan_objective_local_id, revision
  ` as unknown as Array<{ candidate_revision_id: string; quality_state: string; revision: number }>;
}

test("每张候选各一次提交：authored 事件的事务号两两不同", async () => {
  await runPlanJob();

  // 先把 job 的终态与它自己的报错摆出来：逐张提交是**新加**的写路径，它一旦失败，
  // 症状是"库里什么都没有"，只断言事件数会把一条数据库错误读成"测试没素材"。
  const jobs: Array<{ status: string; last_error: string | null }> = await admin`
    SELECT status, last_error FROM card_generation_run_outbox_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId} AND job_type = 'card_generation_plan'
  `;
  assert.equal(jobs[0].status, "completed", `管道没跑完：${jobs[0].status} ${jobs[0].last_error}`);

  const transactions = await authoredTransactionIds();
  assert.ok(transactions.length >= 2, `authored 事件只有 ${transactions.length} 条，测不出"逐张"`);
  const distinct = new Set(transactions);
  assert.equal(distinct.size, transactions.length,
    `${transactions.length} 张候选的 authored 事件只出自 ${distinct.size} 个事务——`
    + "候选仍是一次多行 INSERT 批量落的地，第 1 张要等整批 author 跑完才看得见");
});

test("重放不再调作者：行数与身份一字不动，跳过这件事留下可审计的事件", async () => {
  // 站在第一条用例那一批**已经逐张落好**的候选上（它已经跑完一遍完整管道）。
  const rowsBefore = await candidateRows();
  assert.ok(rowsBefore.length >= 2, "第一批候选太少，复用测不出东西");
  const authoredBefore = await countEvent("card_candidate.authored");

  // 崩在作者中途的形状：计划与部分候选已在库里，run 还停在 authoring，评审段什么都没写。
  await admin`
    UPDATE card_generation_runs_v2 SET status = 'authoring', updated_at = now()
    WHERE id = ${runId} AND workspace_id = ${WORKSPACE_ID}
  `;
  await admin`
    UPDATE card_generation_candidates_v2 SET quality_state = 'authored', updated_at = now()
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId} AND revision = 1
  `;

  await runPlanJob({ replay: true });

  const rowsAfter = await candidateRows();
  assert.equal(rowsAfter.length, rowsBefore.length,
    "重放多出了候选行：作者又被叫了一遍（五列唯一索引只会把重复写入挡在库外，挡不住白付的钱）");
  assert.deepEqual(
    rowsAfter.map((r) => r.candidate_revision_id).sort(),
    rowsBefore.map((r) => r.candidate_revision_id).sort(),
    "重放换了候选身份：复用读回的不是那一版已提交的 revision",
  );
  assert.equal(await countEvent("card_candidate.authored"), authoredBefore,
    "重放重新发了 authored 事件：这张卡并不是这一遍作者产出的");
  const reused = await reusedCandidateIds();
  assert.equal(new Set(reused).size, rowsBefore.length,
    "复用没有留下可审计的事件：库里\"跳过\"与\"重写后被索引挡下\"至今同形");
  // 复用不等于空转：评审段照样得把每张的状态从 authored 往前推。
  assert.ok(rowsAfter.some((r) => r.quality_state !== "authored"),
    "重放复用之后评审段一步没走（quality_state 还停在 authored）");
});

/**
 * replan 走的是**另一条**候选写入路径（`insertAuthoredCandidatesBatched` 的批量形态，
 * 不带 skipExisting）。A1·B2 改了那支 helper 的签名与列清单来源，所以这条路径必须由
 * 自己的用例覆盖——否则"逐张提交没弄坏批量提交"这句话只是推断。
 *
 * 入口守卫（必须 needs_attention + quality_gate_failed、双击 409）是 api 侧的事，已由
 * `apps/api/src/__tests__/card-generation-v2-run-service.test.ts` 覆盖；这里要让 worker
 * 拿到一条**自己持有的租约**的 job，否则 dev 容器的 poller 会先领走并用真 LLM 跑一遍
 * （实测发生过，成本不该由测试来决定）。确定性批次正好落在 needs_attention 上——
 * 作者不写证据引用 → 全体 grounding 失败 → 牌堆空 → 需要处理。
 */
test("replan 那条批量写路径照样能写：新计划版本有候选、旧版本被 supersede 但行还在", async () => {
  const status = await runStatus();
  assert.equal(status, "needs_attention",
    `这一批不在「需要处理」上（${status}），replan 的状态门闩会拒绝，用例前提不成立`);

  const job = await insertClaimedReplanJob();
  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  await processV2OutboxJob(job);

  const plans: Array<{ plan_version: number }> = await admin`
    SELECT plan_version FROM card_generation_plans_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId} ORDER BY plan_version
  `;
  assert.ok(plans.some((plan) => plan.plan_version === 2),
    `replan 之后只有计划版本 ${plans.map((plan) => plan.plan_version).join(",")}`);

  const byVersion: Array<{ plan_version: number; n: number }> = await admin`
    SELECT plan_version, count(*)::int AS n FROM card_generation_candidates_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId} AND revision = 1
    GROUP BY 1 ORDER BY 1
  `;
  const v2 = byVersion.find((row) => row.plan_version === 2);
  assert.ok(v2 && v2.n > 0,
    "replan 没有写出新版本的候选：A1·B2 改过的批量写入路径（不带 skipExisting）被弄坏了");
  assert.ok((byVersion.find((row) => row.plan_version === 1)?.n ?? 0) > 0,
    "旧版本的候选行不见了：replan 应该 supersede 而不是删除（revision 不可变）");

  const superseded: Array<{ n: number }> = await admin`
    SELECT count(*)::int AS n FROM card_generation_candidates_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId}
      AND plan_version = 1 AND publish_state = 'superseded'
  `;
  assert.ok(superseded[0].n > 0, "旧版本候选没有被标 superseded，审核页会同时看到两批");
});
