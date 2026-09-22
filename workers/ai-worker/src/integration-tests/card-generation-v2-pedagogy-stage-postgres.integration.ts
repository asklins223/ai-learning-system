/**
 * 评审尾段（grounding → pedagogy → 有界修复 → 牌堆 → 终态）—— 真 Postgres、零 AI 调用。
 *
 * 为什么现在测得了（方案 §40 的 B 组 / §56）：这段的三种结局（留、修、丢）过去只能靠
 * 运气遇到——确定性 pedagogy 恒 `keep`，真模型什么时候判 `rewrite` 没人知道。而门本身
 * 早就敞着：`critiqueAndFinalizeCandidates` 的 `providers` 与 `allowBoundedRepair` 都是
 * 入参，计划目标取自真计划（§34 那次崩溃就是因为曾经塞过三字段替身）。这里不新开任何
 * 逻辑缝，只把那个函数导出，让它吃一对脚本 provider。
 *
 * 批次是**真跑出来的**：先用确定性管道落一条真 run（真计划、真候选、真事件），再把同一批
 * 候选送进评审尾段第二次，pedagogy 按"留 / 修两张 / 丢一张"裁决。被断言的是真数据上的
 * 真结算，不是 fixture 的形状。
 *
 * 钉住的东西（每条都是这段代码的承诺）：
 * 1. `rewrite`：作者被叫到、且**每张只叫一次**（有界）；新 revision 落库为 `authored`、
 *    题面真的变了，且**不在**这一批的 review_ready 名单里（它没重过门禁，混进牌堆必然
 *    candidate_revision_mismatch → 整批 needs_attention）；同时真的入队了一条
 *    `card_generation_recheck_candidate`，指向那条新 revision。
 * 2. `drop`：`quality_state` 回写成 `dropped` 并留下 `card_candidate.dropped` 事件——
 *    不回写它就永远停在 `passed`，审核页会把它算进"可保留"和配额（§52）。
 * 3. `keep`：照常 `passed` + review_ready 事件。
 * 4. 等式（#38）：审核页头部读到的配额 == 管道落的 `practice_quota_short` 事件；头部判
 *    「可保留」的张数 == 这一批的 `card_candidate.review_ready` 事件数。两边都从服务端算，
 *    界面不再自己数——这里红了就是屏幕上的数与后台结算不一致。
 *
 * 为什么要"种"练习件：确定性作者只交 `kind:"text"` 的答案，
 * `derivePracticeItemFromCanonicalAnswer` 对它返回 undefined，于是确定性批次的配额恒为
 * met=0，等式两边同是 0 什么也测不出。这里按真作者交的形状（真跑 4938cf7f 即此形状）给
 * 两张卡补上练习件并重算 revision 哈希，让"交上了"这件事真的存在。
 *
 * 运行：
 *   DATABASE_URL_MIGRATOR=postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn \
 *   node --import tsx --test --test-timeout=180000 \
 *     workers/ai-worker/src/integration-tests/card-generation-v2-pedagogy-stage-postgres.integration.ts
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import type {
  AuthoringProvider,
  AuthoringProviderInput,
  AuthoringProviderOutput,
  GroundingCriticProvider,
  GroundingCriticInput,
  PedagogyCriticProvider,
  PedagogyCriticInput,
  AtomExtractionProvider,
} from "@ailearn/shared/card-generation-v2-pipeline";
import type {
  GroundingCriticReportV2,
  PedagogyCriticReportV2,
} from "@ailearn/shared/card-quality-v2-contracts";
import type {
  LearningCardCandidateRevisionV2,
  PracticeItemFormV2,
  PracticeItemV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import { computeCandidateEvidenceSetHashV2, computeCandidateRevisionHashV2 } from "@ailearn/shared/card-generation-v2-hashing";
import {
  budgetedPlanObjectives,
  enumerateCandidateTargetUnits,
  summarizePracticeQuotaV2,
} from "@ailearn/shared/card-generation-v2-pipeline";

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR
  ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_WORKER ??= "postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_API ??= ADMIN_URL;
// 零 AI 调用：`assertDeterministicProvidersAllowed` 要求 LLM 开关关着。
delete process.env.CARD_GENERATION_V2_LLM;

const admin = postgres(ADMIN_URL, { max: 2 });

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const NOTE_ID = randomUUID();
const VERSION_ID = randomUUID();

/** 每段一句、彼此不重复：确定性提取按句子出原子，8 段 → 8 个计划目标。 */
const NOTE_BLOCKS = [
  "TCP 建立连接时双方各自确认一次序号，确认完成之后才开始传数据。",
  "HTTP 是无状态协议，服务端默认不记得上一个请求发生过什么。",
  "对称加密的密钥必须事先约定好，非对称加密用公钥加密、私钥解密。",
  "DNS 解析先把域名换成 IP 地址，之后才向目标服务器发起连接。",
  "TLS 握手在应用层数据之前完成，它协商的是加密套件和会话密钥。",
  "TCP 的重传由超时或重复确认触发，不由应用层自己决定何时重发。",
  "数据库索引加快读取，代价是写入时要同步维护一份额外结构。",
  "幂等性指的是同一个请求执行多次与执行一次的效果相同。",
];

let runId = "";
/** 第一遍（确定性管道）写完后的事件水位：本批次的断言只看它之后的事件。 */
let baselineSeq = 0;
/** 本批次的脚本裁决：第二条测试算出来、第三条测试要用。 */
const batch = {
  keepIds: [] as string[],
  rewriteIds: [] as string[],
  droppedId: "",
  metKeptObjective: "",
  metDroppedObjective: "",
};

before(async () => {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`pedagogy-stage-${USER_ID}@example.invalid`}, 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'Pedagogy Stage IT') ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, 'Pedagogy stage note', ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${VERSION_ID}, ${NOTE_ID}, ${WORKSPACE_ID}, 1,
              ${tx.json({ blocks: NOTE_BLOCKS.map((content) => ({ type: "paragraph", content })) })},
              'pedagogy-stage-hash', ${USER_ID}) ON CONFLICT (id) DO NOTHING`;
    for (const [ordinal, content] of NOTE_BLOCKS.entries()) {
      await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal)
        VALUES (${randomUUID()}, ${VERSION_ID}, ${WORKSPACE_ID}, 'paragraph', ${content}, ${ordinal + 1})
        ON CONFLICT (id) DO NOTHING`;
    }
  });
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

type CandidateRow = Record<string, unknown>;

/**
 * 这一批 author 写出来的候选（每个候选的最新 revision）。
 *
 * 不按 `quality_state` 过滤：确定性模式下 author 不填 evidenceRefIds，grounding 会把
 * 它们全判 failed（handler 里 R30 那句"确定性模式无 passed 候选"说的就是这件事），
 * 过滤就剩不下东西。主管线送给评审尾段的也正是"它刚 author 出来的那一批"，
 * 状态由这一遍重写。
 */
async function readLatestAuthoredRows(): Promise<CandidateRow[]> {
  const rows: CandidateRow[] = await admin`
    SELECT * FROM card_generation_candidates_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId}
    ORDER BY plan_objective_local_id, revision DESC
  `;
  const seen = new Set<string>();
  // 只看每个候选的最新 revision：修过一次的候选，牌堆里那个位置归新 revision。
  return rows.filter((r) => {
    const id = String(r.candidate_id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

interface PlanObjectiveRow { objectiveLocalId: string; practiceForm: PracticeItemFormV2 | null }

async function readPlanObjectives(): Promise<PlanObjectiveRow[]> {
  const planRows: Array<{ result: { kind: string; objectives?: PlanObjectiveRow[] } }> = await admin`
    SELECT result FROM card_generation_plans_v2 WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId} LIMIT 1
  `;
  return budgetedPlanObjectives({ result: planRows[0].result } as never);
}

async function maxEventSeq(): Promise<number> {
  const rows: Array<{ seq: number }> = await admin`
    SELECT COALESCE(MAX(event_seq), 0)::int AS seq FROM card_generation_events_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId}
  `;
  return rows[0].seq;
}

interface BatchEvent { event_seq: number; event_type: string; payload: Record<string, unknown> }

/**
 * 认领本 run 的 plan job，且不给 dev 容器留可乘之机。
 *
 * 本机容器里的 worker 每秒轮询同一张 outbox 表：从 `createGenerationRunV2` 提交到
 * 我发出认领 UPDATE 之间哪怕只有几毫秒，它也可能先把这行领走（然后因为没有 key 立刻
 * 失败，留下一批没有计划的 run 让后面的用例连环红）。
 * 退回到 pending 与认领写在**同一个事务**里：事务未提交前这行对别的 poller 不可见，
 * 于是没有竞争窗口。若对手已经把它置为 completed（真跑了），这里宁可判失败也不接受
 * 别人跑出来的批次——那等于把断言的对象换掉了。
 */
async function claimOwnPlanJob(): Promise<{
  id: string; workspaceId: string; runId: string; jobType: string;
  payload: Record<string, unknown>; leaseToken: string;
}> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const leaseToken = randomUUID();
    const claimed = await admin.begin(async (tx) => {
      await tx`
        UPDATE card_generation_run_outbox_v2
        SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
            started_at = NULL, processed_at = NULL, next_attempt_at = NULL
        WHERE run_id = ${runId} AND job_type = 'card_generation_plan'
          AND status <> 'processing'
      `;
      return await tx`
        UPDATE card_generation_run_outbox_v2
        SET status = 'processing', started_at = now(),
            lease_expires_at = now() + interval '30 minutes', lease_token = ${leaseToken}
        WHERE run_id = ${runId} AND job_type = 'card_generation_plan' AND status = 'pending'
        RETURNING id, workspace_id, run_id, job_type, payload, status
      ` as unknown as Array<{ id: string; workspace_id: string; run_id: string;
        job_type: string; payload: Record<string, unknown>; status: string }>;
    });
    const row = claimed[0];
    if (row) {
      return {
        id: row.id, workspaceId: row.workspace_id, runId: row.run_id,
        jobType: row.job_type, payload: row.payload, leaseToken,
      };
    }
    const states: Array<{ status: string }> = await admin`
      SELECT status FROM card_generation_run_outbox_v2
      WHERE run_id = ${runId} AND job_type = 'card_generation_plan' LIMIT 1
    `;
    if (states[0]?.status === "completed") {
      assert.fail("这条 job 被 dev 容器的 worker 跑完了：本测试只认自己这一遍跑出来的批次");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("40 次尝试内没能认领到本 run 的 plan job");
}

async function batchEvents(): Promise<BatchEvent[]> {
  return (await admin`
    SELECT event_seq, event_type, payload FROM card_generation_events_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId} AND event_seq > ${baselineSeq}
    ORDER BY event_seq
  `) as BatchEvent[];
}

/** 这一批候选所依据的 sealed 证据（真作者写进 objective/rubric 的就是这些 ID）。 */
async function readSealedEvidenceIds(): Promise<string[]> {
  const rows: Array<{ evidence_snapshot_id: string; status: string }> = await admin`
    SELECT es.evidence_snapshot_id, ees.status
    FROM evidence_snapshots_v2 es
    JOIN card_generation_runs_v2 r
      ON r.workspace_id = es.workspace_id
     AND es.source_snapshot_id = (r.input_snapshot -> 'sourceSnapshot' ->> 'sourceSnapshotId')::uuid
    LEFT JOIN evidence_eligibility_states_v2 ees ON ees.evidence_snapshot_id = es.evidence_snapshot_id
    WHERE r.id = ${runId}
    ORDER BY es.block_id, es.start_offset
  `;
  return rows.filter((r) => r.status === "usable").map((r) => r.evidence_snapshot_id);
}

/**
 * 把一张候选补成"真作者交出来的样子"：证据引用 + （被点名时）一份练习件，
 * 然后重算 revision 哈希。
 *
 * 为什么必须补证据引用：确定性作者留空 `evidenceRefIds`，确定性门禁第一道
 * `no_evidence_reference` 就把候选判死，于是整批在**进入评审之前**就全灭了（R30
 * 那句"确定性模式无 passed 候选"）。要测评审尾段，就得站在一个有证据闭包的批次上。
 *
 * 为什么哈希要一起改：`computeCandidateRevisionHashV2` 的闭包输入含整个 objective，
 * 只改 jsonb 不改哈希，落库行就成了"内容与哈希对不上"的假数据。
 */
async function seedCandidateForReview(
  row: CandidateRow,
  evidenceIds: string[],
  practiceForm?: PracticeItemFormV2,
): Promise<void> {
  const candidateRevisionId = String(row.candidate_revision_id);
  const objective = row.objective_draft as Record<string, unknown>;
  const answerUnitId = (objective.canonicalAnswer as { unit?: { unitId?: string } }).unit?.unitId ?? "ans-seeded";
  const statement = String(objective.objectiveStatement);
  const rubric = objective.rubric as { units: Array<Record<string, unknown>> };
  const nextObjective: Record<string, unknown> = {
    ...objective,
    evidenceRefIds: evidenceIds,
    rubric: {
      ...rubric,
      units: rubric.units.map((unit) => ({ ...unit, evidenceRefIds: evidenceIds })),
    },
  };
  // 正面换成真作者的写法。确定性作者把整条笔记当答案，题面里的概念标签于是
  // 逐字出现在答案里 —— `front_leaks_answer` 这条 hard 会在进评审之前就把候选杀死
  // （2026-09-18 复盘的"题面即答案"）。这里不改它就没得评审。
  const presentation = row.presentation_draft as Record<string, unknown>;
  const nextPresentation = {
    ...presentation,
    front: {
      ...((presentation.front ?? {}) as Record<string, unknown>),
      cue: "要点",
      prompt: "这条结论说的是什么？",
    },
  };
  if (practiceForm) {
    const practiceItem: PracticeItemV2 = practiceForm === "true_false"
      ? { kind: "true_false", proposition: statement.slice(0, 300), expected: true }
      : practiceForm === "matching"
        ? {
          kind: "matching",
          pairs: [
            { leftId: "left-1", leftText: "加密套件", rightId: "right-1", rightText: "握手时协商" },
            { leftId: "left-2", leftText: "重传", rightId: "right-2", rightText: "超时或重复确认触发" },
          ],
        }
        : practiceForm === "ordering"
          ? {
            kind: "ordering",
            units: [
              { unitId: "step-1", text: "先确认序号" },
              { unitId: "step-2", text: "再开始传数据" },
            ],
            correctUnitOrder: ["step-1", "step-2"],
          }
          : {
            kind: "single_choice",
            // 三个选项：两个选项的"选择题"就是换了壳的判断题，配额不该认它（§44）。
            options: [
              { unitId: answerUnitId, text: statement.slice(0, 80) },
              { unitId: "opt-b", text: "与本条无关的另一种说法" },
              { unitId: "opt-c", text: "同样不相关的第三种说法" },
            ],
            correctUnitId: answerUnitId,
          };
    nextObjective.practiceItem = practiceItem;
  }
  // 闭包输入**不含** candidateRevisionHash（它就是被算出来的那个字段）。
  const withoutHash = {
    version: 2 as const,
    candidateRevisionId,
    candidateId: String(row.candidate_id),
    revision: Number(row.revision),
    runId,
    planRevisionId: String(row.plan_revision_id),
    planVersion: Number(row.plan_version),
    planHash: String(row.plan_hash),
    cardContentEpoch: Number(row.card_content_epoch),
    planObjectiveLocalId: String(row.plan_objective_local_id),
    recommendation: row.recommendation,
    derivedFromCandidateRevisions: row.derived_from,
    objective: nextObjective,
    presentation: nextPresentation,
    evidenceSetHash: String(row.evidence_set_hash),
  };
  const newHash = computeCandidateRevisionHashV2(withoutHash as never);
  // `admin.json(...)` 而不是 `JSON.stringify(...)::jsonb`：postgres.js 会把**字符串**
  // 参数再序列化一次，于是列里留下的是一个 JSON 字符串而不是对象（drizzle 那条路径
  // 才用 ::jsonb 的写法）。这里的候选随后要被读回来当对象用。
  await admin`
    UPDATE card_generation_candidates_v2
    SET objective_draft = ${admin.json(nextObjective as never)},
        presentation_draft = ${admin.json(nextPresentation as never)},
        candidate_revision_hash = ${newHash}, updated_at = now()
    WHERE workspace_id = ${WORKSPACE_ID} AND candidate_revision_id = ${candidateRevisionId}
  `;
  const storedDraft: Array<{ kind: string }> = await admin`
    SELECT jsonb_typeof(objective_draft) AS kind FROM card_generation_candidates_v2
    WHERE candidate_revision_id = ${candidateRevisionId}
  `;
  assert.equal(storedDraft[0].kind, "object", "补写把 objective_draft 写成了标量");
}

test("确定性管道先跑出一条真 run：6 张以上过了门禁的候选、计划点名了练习件", async () => {
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
      clientRequestId: `pedagogy-stage-${randomUUID()}`,
    },
    `pedagogy-stage-${randomUUID()}`,
  );
  runId = created.runId;

  const job = await claimOwnPlanJob();
  const { processV2OutboxJob } = await import("../handlers/card-generation-v2-handler.ts");
  await processV2OutboxJob(job);
  const jobStates: Array<{ status: string; last_error: string | null }> =
    await admin`SELECT status, last_error FROM card_generation_run_outbox_v2 WHERE id = ${job.id}`;
  const [jobState] = jobStates;
  assert.equal(jobState.status, "completed", `管道没跑完：${jobState.status} ${jobState.last_error}`);

  // 6 张是"留 3 / 修 2 / 丢 1"的下限；不足 3 个目标时配额本身为 0（§49 小批豁免），
  // 配额等式就无从谈起。只数真进了牌堆的（passed），被去重判 failed 的不算素材。
  const deckRows = await readLatestAuthoredRows();
  assert.ok(deckRows.length >= 6, `进了牌堆的候选只有 ${deckRows.length} 张，撑不起三种裁决`);

  const planObjectives = await readPlanObjectives();
  const named = planObjectives.filter((o) => o.practiceForm !== null);
  assert.ok(named.length >= 3,
    `计划只点名了 ${named.length} 张练习件（共 ${planObjectives.length} 个目标：`
    + `${planObjectives.map((o) => o.practiceForm ?? "-").join(",")}），配额测不出东西`);

  baselineSeq = await maxEventSeq();
});

test("脚本 pedagogy 三种裁决各来一次：修好的不进牌堆、recheck 真的入队、丢的落成 dropped", async () => {
  const handler = await import("../handlers/card-generation-v2-handler.ts");
  const { withWorkerWorkspaceTransaction } = await import("../db.ts");

  // ── 裁决素材（在第一遍事务之外准备：脚本 provider 得先知道要判谁） ──
  const rows = await readLatestAuthoredRows();
  const evidenceIds = await readSealedEvidenceIds();
  assert.ok(evidenceIds.length > 0, "这条 run 没有可引用的 sealed 证据，评审尾段无从起步");
  const candidates = rows.map((r) => handler.candidateRowToObject(r, runId));
  const objectives = await readPlanObjectives();
  const formByObjective = new Map(objectives.map((o) => [o.objectiveLocalId, o.practiceForm]));
  const namedCandidates = candidates.filter((c) => formByObjective.get(c.planObjectiveLocalId));
  assert.ok(namedCandidates.length >= 2, "被点名的候选不足两张，配额等式没有素材");
  const keepTarget = namedCandidates[0];
  const dropTarget = namedCandidates[namedCandidates.length - 1];
  const rowOf = (candidateId: string) =>
    rows.find((r) => String(r.candidate_id) === candidateId) as CandidateRow;
  const formOf = (target: typeof keepTarget) =>
    formByObjective.get(target.planObjectiveLocalId) as PracticeItemFormV2;
  // 每张都要有证据引用（否则确定性门禁第一道就把整批判死），被点名的两张再各配一道题。
  await seedCandidateForReview(rowOf(keepTarget.candidateId), evidenceIds, formOf(keepTarget));
  await seedCandidateForReview(rowOf(dropTarget.candidateId), evidenceIds, formOf(dropTarget));
  for (const c of candidates) {
    if (c.candidateId === keepTarget.candidateId || c.candidateId === dropTarget.candidateId) continue;
    await seedCandidateForReview(rowOf(c.candidateId), evidenceIds);
  }
  // 种子写完再读一遍：下面的 candidates 必须与库里的哈希一致，否则评审阶段拿到的
  // 就是另一份内容。
  const seededRows = await readLatestAuthoredRows();
  const seeded = seededRows.map((r) => handler.candidateRowToObject(r, runId));
  const rewriteTargets = seeded
    .filter((c) => c.candidateId !== keepTarget.candidateId && c.candidateId !== dropTarget.candidateId)
    .slice(0, 2);
  const rewriteIds = new Set(rewriteTargets.map((c) => c.candidateId));
  const dropCandidateId = dropTarget.candidateId;
  batch.keepIds = seeded.map((c) => c.candidateId)
    .filter((id) => id !== dropCandidateId && !rewriteIds.has(id));
  batch.rewriteIds = [...rewriteIds];
  batch.droppedId = dropCandidateId;
  batch.metKeptObjective = keepTarget.planObjectiveLocalId;
  batch.metDroppedObjective = dropTarget.planObjectiveLocalId;
  assert.ok(batch.keepIds.length >= 1, "没有候选留在牌堆里，review_ready 那条腿测不到");

  const hintsByCandidateId = new Map(
    seededRows.map((r) => [String(r.candidate_id), r.hints]),
  );
  const candidateById = new Map(seeded.map((c) => [c.candidateId, c]));

  const stageResult = await withWorkerWorkspaceTransaction(
    { workspaceId: WORKSPACE_ID, userId: null },
    async (tx) => {
      const ctx = await handler.loadV2RunInputs(tx, WORKSPACE_ID, runId);
      assert.ok(ctx.plan, "确定性管道没落下计划行");
      const deckRows = seeded.map((c) => ({ ...c }));

      // 脚本 grounding 交的是**完整**的逐项报告：binding plan 组装对每个 answer unit /
      // 教学支撑字段 / 关系 / rubric unit 都要求一条 entailed/supported 且引用真证据，
      // 缺一项就 fail-closed（确定性支路交空数组，所以那边一张也进不了牌堆）。
      const grounding: GroundingCriticProvider = {
        evaluate: async (input: GroundingCriticInput) => {
          const candidate = input.candidate;
          const evidenceIds = (input.evidenceManifest?.evidence ?? [])
            .map((e) => e.evidenceSnapshotId);
          assert.ok(evidenceIds.length > 0, "sealed 清单没有证据，牌堆无从绑定");
          const targets = enumerateCandidateTargetUnits(candidate);
          const evidenceSetHash = computeCandidateEvidenceSetHashV2(
            (input.evidenceManifest?.evidence ?? []).map((e) => ({
              evidenceSnapshotId: e.evidenceSnapshotId,
              evidenceSnapshotHash: e.evidenceSnapshotHash,
            })),
          );
          return {
            version: 2,
            reportId: randomUUID(),
            candidateRevisionId: candidate.candidateRevisionId,
            candidateRevisionHash: candidate.candidateRevisionHash,
            evidenceSetHash,
            evidenceEligibilityVectorHash: candidate.evidenceSetHash,
            inputHash: candidate.evidenceSetHash,
            verdict: "pass",
            answerUnits: targets.answerUnits.map((u) => ({
              answerUnitId: u.answerUnitId, verdict: "entailed", evidenceSnapshotIds: evidenceIds,
            })),
            learningSupport: targets.learningSupport.map((f) => ({
              field: f.field, verdict: "entailed", evidenceSnapshotIds: evidenceIds,
            })),
            relationSupport: targets.relations.map((r) => ({
              relationId: r.relationId, verdict: "entailed", evidenceSnapshotIds: evidenceIds,
            })),
            rubricSupport: targets.rubricUnits.map((u) => ({
              rubricUnitId: u.rubricUnitId, verdict: "supported", evidenceSnapshotIds: evidenceIds,
            })),
            hardIssues: [],
            criticVersion: "scripted-grounding-v1",
            reportHash: "d".repeat(64),
          } as unknown as GroundingCriticReportV2;
        },
      };
      let pedagogyCalls = 0;
      const pedagogy: PedagogyCriticProvider = {
        evaluate: async (input: PedagogyCriticInput) => {
          pedagogyCalls += 1;
          return {
            version: 2,
            runId,
            candidateRevisionHashes: input.candidates.map((c) => c.candidateRevisionHash),
            candidateEvidenceBindingPlanHashes: input.candidateEvidenceBindingPlanHashes,
            planRevisionId: input.plan?.planRevisionId ?? randomUUID(),
            planVersion: input.plan?.planVersion ?? 1,
            planHash: input.plan?.planHash ?? "",
            inputHash: input.inputHash,
            verdict: "repair",
            perCandidate: input.candidates.map((c) => ({
              candidateId: c.candidateId,
              verdict: c.candidateId === dropCandidateId
                ? "drop"
                : rewriteIds.has(c.candidateId) ? "rewrite" : "keep",
              hardIssues: [],
            })),
            setIssues: [],
            recommendedFinalCount: input.candidates.length,
            criticVersion: "scripted-pedagogy-v1",
            reportHash: "e".repeat(64),
          } as unknown as PedagogyCriticReportV2;
        },
      };
      const authorCalls: AuthoringProviderInput[] = [];
      const author: AuthoringProvider = {
        authorCandidate: async (input: AuthoringProviderInput) => {
          authorCalls.push(input);
          const rewritten = candidateById.get(
            // 作者只拿到计划目标，找回它修的是哪张：与真路径一致（真 provider 也只看 planObjective）。
            seeded.find((c) => c.planObjectiveLocalId === input.planObjective.objectiveLocalId)?.candidateId ?? "",
          ) as LearningCardCandidateRevisionV2;
          return {
            objective: { ...rewritten.objective },
            presentation: {
              ...rewritten.presentation,
              front: {
                ...rewritten.presentation.front,
                prompt: `${rewritten.presentation.front.prompt}（重写过的题面）`,
              },
            },
            evidenceSetHash: ctx.sealed.evidenceSetHash,
            hints: hintsByCandidateId.get(rewritten.candidateId),
          } as unknown as AuthoringProviderOutput;
        },
      };
      const providers = {
        plannerExtraction: {
          extractAtoms: async () => {
            throw new Error("评审阶段不该重新规划：这里必须一个原子都不提取");
          },
        } as unknown as AtomExtractionProvider,
        author,
        grounding,
        pedagogy,
        usageTotals: () => ({
          calls: 0, attempts: 0, promptTokens: 0, completionTokens: 0,
          totalTokens: 0, cacheHitTokens: 0, callsWithoutUsage: 0,
        }),
      };

      await handler.critiqueAndFinalizeCandidates(tx, {
        runId,
        workspaceId: WORKSPACE_ID,
        run: ctx.run as unknown as { input_snapshot_hash: string; semantic_spec_hash: string },
        plan: ctx.plan,
        candidates: deckRows,
        sealed: ctx.sealed,
        sourceContent: ctx.sourceContent,
        existingObjectives: ctx.existingObjectives,
        providers: providers as unknown as Parameters<typeof handler.critiqueAndFinalizeCandidates>[1]["providers"],
        allowBoundedRepair: true,
        generationRequest: ctx.semanticSpec.semanticRequest,
      });
      return { authorCalls, pedagogyCalls };
    },
  );

  // 本批事件（一次读，两处用）。若一条候选都没过门禁，pedagogy 根本不会被调用——
  // 那时"0 !== 1"本身没有诊断价值，所以把失败原因一起带进断言消息。
  const events = await batchEvents();
  const groundingFailures = events
    .filter((e) => e.event_type === "card_candidate.grounding_failed")
    .map((e) => `${(e.payload as { issues?: Array<{ code: string }> }).issues?.[0]?.code ?? "?"}`);
  assert.equal(stageResult.pedagogyCalls, 1,
    "pedagogy 是集合级调用，一批只该叫一次"
    + (groundingFailures.length > 0 ? `；这批没有候选过门禁：${groundingFailures.join(",")}` : ""));
  // 有界：两张 rewrite 各修一次，不会连锁重生成。
  assert.equal(stageResult.authorCalls.length, 2,
    `作者被叫了 ${stageResult.authorCalls.length} 次：每张 rewrite 只该修一次`);
  for (const call of stageResult.authorCalls) {
    assert.equal(typeof call.planObjective.strategy, "string",
      "计划目标又被换成替身了（author 提示会在 spec.label 上炸）");
  }

  interface StoredRow {
    candidate_id: string; candidate_revision_id: string; revision: number; quality_state: string;
    presentation_draft: { front: { prompt: string } };
  }
  const stored: StoredRow[] = await admin`
    SELECT candidate_id, candidate_revision_id, revision, quality_state, presentation_draft
    FROM card_generation_candidates_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId}
    ORDER BY candidate_id, revision
  `;

  // 1. rewrite：多出一条 revision=2、状态 authored、题面真的变了；原 revision 不动。
  for (const rewrittenId of batch.rewriteIds) {
    const revisions = stored.filter((r) => r.candidate_id === rewrittenId);
    assert.equal(revisions.length, 2, `rewrite 候选应有 1→2 两条 revision，实到 ${revisions.length}`);
    assert.equal(revisions[0].revision, 1);
    assert.equal(revisions[0].quality_state, "passed", "原 revision 不该被改动（不可变）");
    assert.equal(revisions[1].revision, 2);
    assert.equal(revisions[1].quality_state, "authored", "修好的 revision 不能自称过了门禁");
    assert.notEqual(revisions[1].presentation_draft.front.prompt, revisions[0].presentation_draft.front.prompt,
      "题面没变——状态换了也可能什么都没修");
  }

  // 2. drop：回写成 dropped（不回写它就永远停在 passed，审核页会把它算进可保留那一档）。
  const droppedRow = stored.find((r) => r.candidate_id === batch.droppedId);
  assert.ok(droppedRow);
  assert.equal(droppedRow.quality_state, "dropped",
    "被 pedagogy 丢掉的候选还停在 passed——§52 的那个缺陷没修");

  // 3. keep：照常留在牌堆。
  for (const keptId of batch.keepIds) {
    assert.equal(stored.find((r) => r.candidate_id === keptId)?.quality_state, "passed");
  }

  const reviewReadyIds = new Set(events
    .filter((e) => e.event_type === "card_candidate.review_ready")
    .map((e) => String((e.payload as { candidateId?: string }).candidateId)));
  for (const keptId of batch.keepIds) {
    assert.ok(reviewReadyIds.has(keptId), `留卡的 review_ready 事件没落：${keptId}`);
  }
  // 修好的那张不在牌堆名单里（它没重过门禁，混进去整批烧掉）。
  for (const rewrittenId of batch.rewriteIds) {
    assert.ok(!reviewReadyIds.has(rewrittenId), `修好的 revision 混进了牌堆名单：${rewrittenId}`);
  }
  assert.ok(!reviewReadyIds.has(batch.droppedId), "被丢弃的候选拿到了 review_ready");

  const dropEvents = events.filter((e) => e.event_type === "card_candidate.dropped"
    && (e.payload as { candidateId?: string }).candidateId === batch.droppedId);
  assert.equal(dropEvents.length, 1, "丢弃没有留下可审计的事件");
  assert.equal((dropEvents[0].payload as { relation?: string }).relation, "pedagogy_drop");

  // 4. 修复的新 revision 必须真的被送去复核，否则审核页永远停在"重新检查中"。
  const recheckJobs: Array<{ payload: Record<string, unknown> }> = await admin`
    SELECT payload FROM card_generation_run_outbox_v2
    WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId}
      AND job_type = 'card_generation_recheck_candidate'
  `;
  assert.equal(recheckJobs.length, 2, `recheck job 入队了 ${recheckJobs.length} 条，应为 2`);
  const recheckRevisions = new Set(recheckJobs.map((j) => String(j.payload.candidateRevisionId)));
  for (const rewrittenId of batch.rewriteIds) {
    const newRow = stored.find((r) => r.candidate_id === rewrittenId && r.revision === 2);
    assert.ok(newRow && recheckRevisions.has(newRow.candidate_revision_id),
      "recheck 指向的不是那条新 revision，复核永远收不了口");
  }

  const runRows: Array<{ status: string }> = await admin`SELECT status FROM card_generation_runs_v2 WHERE id = ${runId}`;
  assert.equal(runRows[0].status, "review_ready",
    "还剩若干张 keep，却没能把批次收成 review_ready");
});

test("等式：头部配额 == 事件里的结算；头部「可保留」张数 == 本批 review_ready 事件数", async () => {
  const { getGenerationRunCandidatesV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/generation-run-service.ts"
  );
  const { summarizePlanPracticeQuotaV2 } = await import(
    "../../../../apps/api/src/modules/card-generation-v2/helpers.ts"
  );

  const list = await getGenerationRunCandidatesV2(
    { workspaceId: WORKSPACE_ID, userId: USER_ID }, runId,
  );
  assert.ok(list, "候选列表读不出来");
  const events = await batchEvents();
  const quotaEvent = events.find((e) => e.event_type === "card_generation.practice_quota_short");
  assert.ok(quotaEvent, "缺额事件没落：等式的一边根本不存在");
  const settled = quotaEvent.payload as unknown as {
    requiredCount: number; metCount: number;
    misses: Array<{ objectiveLocalId: string; missReason: string }>;
  };

  assert.equal(list.practiceQuota.requiredCount, settled.requiredCount,
    "头部点名的张数与管道结算不一致");
  assert.equal(list.practiceQuota.metCount, settled.metCount,
    "头部算出的兑现张数与管道结算不一致（丢掉的卡又被算进去了）");
  // 别让 0==0 把这条断言变成空测试：这批确实点名了，也确实一张兑现、一张被丢掉。
  assert.ok(settled.requiredCount >= 3, `这批只点名了 ${settled.requiredCount} 张，素材不足`);
  const droppedMiss = settled.misses.find((m) => m.objectiveLocalId === batch.metDroppedObjective);
  assert.ok(droppedMiss, "被丢掉的那张没进缺额清单——它其实还占着兑现");
  assert.equal(droppedMiss.missReason, "nothing_delivered");
  assert.equal(
    settled.misses.some((m) => m.objectiveLocalId === batch.metKeptObjective), false,
    "留在牌堆里、真的交上了练习件的那张被记成了缺额",
  );
  assert.equal(settled.metCount, settled.requiredCount - settled.misses.length);
  assert.ok(settled.metCount >= 1, "一张都没兑现，等式两边同是 0，这条测试是空的");

  const reviewReadyCount = list.candidates.filter((c) => c.isReviewReady).length;
  const reviewReadyEvents = events.filter((e) => e.event_type === "card_candidate.review_ready").length;
  assert.equal(reviewReadyCount, reviewReadyEvents,
    `界面判可保留 ${reviewReadyCount} 张，这一批的 review_ready 事件是 ${reviewReadyEvents} 条`);
  assert.equal(reviewReadyCount, batch.keepIds.length);

  // 头部读数必须由服务端这一支算出来，不是界面自己数：与读路径同输入再算一遍应当全等。
  const planRow = (await admin`
    SELECT result FROM card_generation_plans_v2 WHERE workspace_id = ${WORKSPACE_ID} AND run_id = ${runId} LIMIT 1`
  )[0] as unknown as { result: unknown };
  const recomputed = summarizePlanPracticeQuotaV2(
    planRow.result,
    list.candidates.map((c) => ({
      planObjectiveLocalId: c.planObjectiveLocalId,
      qualityState: c.qualityState,
      practiceItem: c.practiceItem,
    })),
  );
  assert.deepEqual(recomputed, list.practiceQuota, "服务端的配额结算有两个来源");
  // 上面那两条等式不是空测试的凭证在这里：若像 #38 之前那样"不分状态一律数进来"，
  // 头部就会多算丢掉的那张——同一支函数、同一批行，数出来的数必须比现在**大**。
  const ignoringState = summarizePracticeQuotaV2(
    await readPlanObjectives(),
    new Map(list.candidates.map((c) => [c.planObjectiveLocalId, {
      form: c.practiceItem?.kind ?? null,
      optionCount: c.practiceItem?.optionCount ?? 0,
    }])),
  );
  assert.equal(ignoringState.metCount, list.practiceQuota.metCount + 1,
    "不分状态数进来与按状态数进来一模一样——说明丢卡没有真的改变任何读数");
});
