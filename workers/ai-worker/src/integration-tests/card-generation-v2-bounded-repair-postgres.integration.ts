/**
 * 有界修复（bounded repair）尾段 —— 真 Postgres、零 AI 调用。
 *
 * 为什么现在有测试可以钉它（方案 §40）：这条分支过去只能靠"运气遇到一次真判 rewrite"，
 * 因为门是 `allowBoundedRepair && useLLM && providers && …`，而确定性 pedagogy 恒 pass。
 * 但真正需要的注入点产品里早就有——`boundedRepairCandidate` 的 author provider 是入参，
 * 计划目标也是从真计划里取的（`plannedObjectiveForCandidateV2`，§34 那次崩溃就是因为
 * 这里曾经塞了三字段替身）。所以这里不新开任何缝：直接拿一条真跑出来的候选，
 * 配一个脚本 author，把修复这一段跑完。
 *
 * 钉住的六件事，每条都是这段代码的真实承诺（不是"函数跑过了"）：
 * 1. 作者收到的是**真计划目标**（strategy / practiceForm / sourceAtomIds 都在），
 *    不是替身——替身会让提示构建在 `spec.label` 上 TypeError；
 * 2. 新 revision = 旧 + 1，且是一条**新的 candidate_revision_id**（旧行不动，immutable）；
 * 3. `derived_from` 里带着旧 revision 的哈希——修复链可追，不是一行无源的新候选；
 * 4. 新行落在库里且状态是 `authored`（等着被 recheck，而不是冒充已通过门禁）；
 * 5. 内容真的变了，且哈希也变了。注意**哈希单独不足以证明修了什么**：身份字段
 *    （revision / candidateRevisionId / derivedFrom）本身就在哈希闭包里，
 *    原样重写一样换哈希——所以两条断言都要，缺一不可；
 * 6. 对同一目标重复修复会被 0253 那条唯一索引挡住（幂等），而不是悄悄多出第三行。
 *
 * 运行：
 *   DATABASE_URL_MIGRATOR=postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn \
 *   node --import tsx --test --test-timeout=180000 \
 *     workers/ai-worker/src/integration-tests/card-generation-v2-bounded-repair-postgres.integration.ts
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import type {
  AuthoringProvider,
  AuthoringProviderInput,
  AuthoringProviderOutput,
} from "@ailearn/shared/card-generation-v2-pipeline";

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR
  ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_WORKER ??= "postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_API ??= ADMIN_URL;
// 确定性管道：不出网、不花钱（`assertDeterministicProvidersAllowed` 要求的就是这个）。
delete process.env.CARD_GENERATION_V2_LLM;

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
      VALUES (${USER_ID}, ${`bounded-repair-${USER_ID}@example.invalid`}, 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'Bounded Repair IT') ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, 'Bounded repair note', ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${VERSION_ID}, ${NOTE_ID}, ${WORKSPACE_ID}, 1,
              ${tx.json({ blocks: [{ type: "paragraph", content: NOTE_CONTENT }] })},
              'bounded-repair-hash', ${USER_ID}) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal)
      VALUES (${randomUUID()}, ${VERSION_ID}, ${WORKSPACE_ID}, 'paragraph', ${NOTE_CONTENT}, 1)
      ON CONFLICT (id) DO NOTHING`;
  });
});

after(async () => {
  const wipe = async (sql: string) => {
    await admin.unsafe(sql.replace(/\?/g, () => `'${WORKSPACE_ID}'`)).catch(() => undefined);
  };
  await wipe("DELETE FROM card_generation_run_progress_v2 WHERE workspace_id = ?");
  await wipe("DELETE FROM card_generation_events_v2 WHERE workspace_id = ?");
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

/** 跑一遍确定性管道，留下一条真 run（含已提交的计划与候选）。 */
test("先用确定性管道跑出一条真 run（后面所有断言都要站在它上面）", async () => {
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
      clientRequestId: `bounded-repair-${randomUUID()}`,
    },
    `bounded-repair-${randomUUID()}`,
  );
  runId = created.runId;

  const leaseToken = randomUUID();
  const claimed = await admin`
    UPDATE card_generation_run_outbox_v2
    SET status = 'processing', started_at = now(), lease_expires_at = now() + interval '30 minutes',
        lease_token = ${leaseToken}
    WHERE run_id = ${runId} AND job_type = 'card_generation_plan' AND status = 'pending'
    RETURNING id, workspace_id, run_id, job_type, payload
  `;
  assert.equal(claimed.length, 1, "dev 容器的 worker 抢走了这条 job（重跑即可）");
  const row = claimed[0] as { id: string; workspace_id: string; run_id: string;
    job_type: string; payload: Record<string, unknown> };

  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  await processV2OutboxJob({
    id: row.id, workspaceId: row.workspace_id, runId: row.run_id,
    jobType: row.job_type, payload: row.payload, leaseToken,
  });
  const [jobState] = (await admin`SELECT status, last_error FROM card_generation_run_outbox_v2 WHERE id = ${row.id}`) as unknown as Array<{ status: string; last_error: string | null }>;
  assert.equal(jobState.status, "completed", `管道没跑完：${jobState.status} ${jobState.last_error}`);

  const stored = (await admin`
    SELECT count(*)::int AS n FROM card_generation_candidates_v2 WHERE run_id = ${runId}
  `) as unknown as Array<{ n: number }>;
  assert.ok((stored[0] as { n: number }).n >= 1, "确定性管道没写出候选");
});

test("有界修复：真计划目标交给作者、多出一行 revision=2、链回旧行、状态停在 authored", async () => {
  const handler = await import("../handlers/card-generation-v2-handler.ts");
  const { withWorkerWorkspaceTransaction } = await import("../db.ts");
  const repaired = await withWorkerWorkspaceTransaction(
    { workspaceId: WORKSPACE_ID, userId: null },
    async (tx) => {
      const ctx = await handler.loadV2RunInputs(tx, WORKSPACE_ID, runId);
      assert.ok(ctx.plan, "确定性管道没落下计划行");
      const rows = await tx.execute(`
        SELECT * FROM public.card_generation_candidates_v2
        WHERE workspace_id = '${WORKSPACE_ID}' AND run_id = '${runId}'
        ORDER BY plan_objective_local_id, revision LIMIT 1`) as unknown as Array<Record<string, unknown>>;
      assert.equal(rows.length, 1, "读不到候选行");
      const original = rows[0];
      const candidate = handler.candidateRowToObject(original, runId);

      // 脚本作者：改掉题面（内容真的变了），并原样回传 evidenceSetHash
      // （契约要求 provider 不得自报，否则 revision hash 与下游重算永久不一致）。
      const authorCalls: Array<Record<string, unknown>> = [];
      const authoringProvider: AuthoringProvider = {
        authorCandidate: async (input: AuthoringProviderInput) => {
          authorCalls.push(input as unknown as Record<string, unknown>);
          return {
            objective: { ...candidate.objective },
            presentation: {
              ...candidate.presentation,
              front: { ...candidate.presentation.front, prompt: `${candidate.presentation.front.prompt}（重写过的题面）` },
            },
            evidenceSetHash: ctx.sealed.evidenceSetHash,
            hints: original.hints,
          } as unknown as AuthoringProviderOutput;
          // jsonb 列回来是 unknown、候选与计划的合同类型又经两条解析路径各自成一份声明，
          // 这里跨的是类型身份不是数据（同 `candidateRowToObject` 的写法）。
        },
      };

      const final = await handler.boundedRepairCandidate(tx, {
        runId,
        workspaceId: WORKSPACE_ID,
        // 同一个 CardPlanV2 经两条解析路径（worker 的 paths 与 api 服务那份声明）
        // 会被 TS 当成两个不相关的类型；这里跨的是解析身份，不是数据。
        plan: ctx.plan as unknown as Parameters<typeof handler.boundedRepairCandidate>[1]["plan"],
        candidate,
        sourceContent: ctx.sourceContent,
        sealed: ctx.sealed,
        authoringProvider,
        semanticSpecHash: ctx.run.semantic_spec_hash as string,
      });

      return { original, final, planObjective: authorCalls[0]?.planObjective as Record<string, unknown> | undefined };
    },
  );

  const { original, final, planObjective } = repaired;

  // 1. 作者拿到的是真计划目标，不是三字段替身（§34 的崩溃点：替身没有 strategy，
  //    author 提示在 `spec.label` 上直接 TypeError）。
  assert.ok(planObjective, "作者压根没被调用");
  assert.equal(typeof planObjective.strategy, "string",
    "计划目标里没有 strategy → 又被换成替身了，提示构建会当场炸");
  assert.equal("practiceForm" in planObjective, true, "计划目标里没有 practiceForm → D6 的点名读不到");
  assert.ok((planObjective.sourceAtomIds as string[]).length >= 1);

  // 2. 新 revision = 旧 + 1，且是一条新的 candidate_revision_id。
  assert.equal(final.revision, Number(original.revision) + 1);
  assert.notEqual(final.candidateRevisionId, original.candidate_revision_id);

  // 3. 修复链可追：derived_from 带着旧 revision 的哈希。
  const derived = final.derivedFromCandidateRevisions as Array<{ candidateRevisionId: string; revisionHash: string }>;
  assert.equal(derived.length, 1);
  assert.equal(derived[0].candidateRevisionId, original.candidate_revision_id);
  assert.equal(derived[0].revisionHash, original.candidate_revision_hash);

  // 4. 落库的是新行，状态 authored（等 recheck，不冒充过了门禁）；旧行原样留着。
  const stored = (await admin`
    SELECT revision, quality_state, candidate_revision_hash, presentation_draft, publish_state
    FROM card_generation_candidates_v2
    WHERE run_id = ${runId} AND candidate_id = ${final.candidateId}
    ORDER BY revision`) as unknown as Array<{
      revision: number; quality_state: string; candidate_revision_hash: string;
      presentation_draft: { front: { prompt: string } }; publish_state: string;
    }>;
  assert.equal(stored.length, 2, "修复不该覆盖旧 revision——它必须是一条新行");
  assert.equal(stored[0].revision, Number(original.revision));
  assert.equal(stored[1].quality_state, "authored");
  assert.equal(stored[1].publish_state, "unpublished");

  // 5. 内容确实变了，哈希也变了。两条都要：身份字段（revision / 新 revisionId /
  //    derivedFrom）本身就在哈希闭包里，"原样重写"照样换哈希，只看哈希会被骗。
  assert.notEqual(
    stored[1].presentation_draft.front.prompt,
    (original.presentation_draft as { front: { prompt: string } }).front.prompt,
    "题面没变——哈希变了也可能什么都没修",
  );
  assert.notEqual(stored[1].candidate_revision_hash, original.candidate_revision_hash);
});

/**
 * 0253 那条唯一索引在这里兑现：重复修复同一目标会生成另一条 revision=2，
 * 索引必须当场拒绝，而不是让库里长出第三行。
 */
test("同一条候选修两遍：唯一索引当场挡住，不多出一行", async () => {
  const handler = await import("../handlers/card-generation-v2-handler.ts");
  const { withWorkerWorkspaceTransaction } = await import("../db.ts");
  const beforeCount = (await admin`
    SELECT count(*)::int AS n FROM card_generation_candidates_v2 WHERE run_id = ${runId}
  `)[0] as unknown as { n: number };

  // 不用 assert.rejects(fn, /…/)：drizzle 把底层报错包成 `Failed query: …`，
  // Postgres 的约束名只出现在 cause 里，只看 message 会把"被索引挡下"读成"没匹配上"。
  let caught: unknown = null;
  try {
    await withWorkerWorkspaceTransaction({ workspaceId: WORKSPACE_ID, userId: null }, async (tx) => {
      const ctx = await handler.loadV2RunInputs(tx, WORKSPACE_ID, runId);
      // 拿**最初那条 revision**再修一次：第二次修复同样会产出 revision=2，
      // 撞的就是 0253 那条索引（"同一次崩溃的管道被重投、修了两遍"的形状）。
      // 若改成对 max(revision) 再修，产出的是 revision=3，键不同，测试会假绿。
      const rows = await tx.execute(`
        SELECT * FROM public.card_generation_candidates_v2
        WHERE workspace_id = '${WORKSPACE_ID}' AND run_id = '${runId}'
          AND plan_objective_local_id = (
            SELECT plan_objective_local_id FROM public.card_generation_candidates_v2
            WHERE workspace_id = '${WORKSPACE_ID}' AND run_id = '${runId}'
            ORDER BY plan_objective_local_id LIMIT 1)
          AND revision = 1
        LIMIT 1`) as unknown as Array<Record<string, unknown>>;
      const candidate = handler.candidateRowToObject(rows[0] as Record<string, unknown>, runId);
      await handler.boundedRepairCandidate(tx, {
        runId,
        workspaceId: WORKSPACE_ID,
        // 同一个 CardPlanV2 经两条解析路径（worker 的 paths 与 api 服务那份声明）
        // 会被 TS 当成两个不相关的类型；这里跨的是解析身份，不是数据。
        plan: ctx.plan as unknown as Parameters<typeof handler.boundedRepairCandidate>[1]["plan"],
        candidate,
        sourceContent: ctx.sourceContent,
        sealed: ctx.sealed,
        authoringProvider: {
          authorCandidate: async () => ({
            objective: { ...candidate.objective },
            presentation: { ...candidate.presentation, front: { ...candidate.presentation.front, prompt: "再改一次" } },
            evidenceSetHash: ctx.sealed.evidenceSetHash,
            hints: rows[0].hints,
          } as unknown as AuthoringProviderOutput),
        },
        semanticSpecHash: ctx.run.semantic_spec_hash as string,
      });
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "第二次修复没有被挡下来——那这条索引就没在管这件事");
  const chain = `${String(caught)} ${String((caught as { cause?: unknown }).cause ?? "")}`;
  assert.match(chain, /cg_v2_cand_plan_objective_revision_idx|duplicate key/,
    "挡下写入的不是那条唯一索引，而是别的东西（测试就白跑了）");

  const afterCount = (await admin`
    SELECT count(*)::int AS n FROM card_generation_candidates_v2 WHERE run_id = ${runId}
  `)[0] as { n: number };
  assert.equal(afterCount.n, beforeCount.n, "被拒绝的写入还是留下了行（外层事务没回滚）");
});
