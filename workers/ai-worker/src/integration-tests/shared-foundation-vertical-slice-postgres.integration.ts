/**
 * 竖向样例：一条链跑在公共运行基础上（39c §9 第一步 / 39d W3-3）。
 *
 * 形状：**小笔记生成 → 独立综合检查 → 保存一张卡 → 开放回答 → 评估与观察**，
 * 再加一步**伴星在同一题上开口**（`tool_loop` 模式）——两种模式共用同一层外壳，
 * 这才是"公共基础"而不是"生成链的改名"。
 *
 * 三条硬约束在**这里被锁定**（39c §9 第一步原话"此时锁定 §5 的事务硬约束和最小身份合同"）：
 *
 *   1. **每个模型步骤都是三段**：短事务准备 → 事务外调用 → 短事务核对并保存。
 *      慢的那一段永远不在事务里，所以不持业务行锁（W3-2 的判据在这里复量）。
 *   2. **最小身份合同**：一步 = 一条 `jobs` 行 = 一个 `lease_token` + 一个幂等键。
 *      检查点、恢复、拒收旧结果三件事全部只用这一份身份，不另立第二套编号。
 *   3. **检查点的物理形状 = `jobs.payload`**（D5 §8 把这一项留给 W3-3 定）。
 *      选它而不是新表：样例阶段没有任何"必须按产物检索"的读点，为一件还没有读者的事
 *      加一张表就是加一次迁移 + 一份 journal 登记。**真链（W7-7）若要按目标/卡片查
 *      历史检查点，那时候再换表**，换的只是这个端口背后的一段 SQL。
 *
 * 失败分支按 39d 的出口判据一条条钉：慢检查（超时只重跑那一步）、评分失败
 * （提交失败**绝不**回头重跑模型）、单卡重生成（输入哈希变 ⇒ 不许默默复用旧检查点）、
 * 检查点前后杀 worker（只重试未完成步骤）、两 worker 接管（旧令牌提交被拒、库里一份）。
 *
 * 模型用 mock（**不花钱**）：这里要证的是运行基础的形状，不是模型质量。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { JobLeaseContext } from "../lib/job-lease.ts";
import type {
  AiTaskCheckpointPort,
  AiTaskDefinition,
  AiTaskReceipt,
} from "@ailearn/shared/ai-task-kernel";

const ADMIN_CONN = process.env.DATABASE_URL ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_WORKER ??= "postgres://ailearn_worker:ailearn_dev@127.0.0.1:5432/ailearn";
const admin = postgres(ADMIN_CONN, { max: 2 });

const { runAiTask, classifyThrownAsStepFailure } = await import("@ailearn/shared/ai-task-kernel");
const { withWorkerWorkspaceTransaction, closeDatabase, currentWorkerWorkspaceTransaction } = await import("../db.ts");
const { isJobLeaseActive, lockJobLease } = await import("../lib/job-lease.ts");
const { MockProvider } = await import("../lib/providers/mock.ts");
const { seedFormalAnswerRun } = await import("./helpers/formal-answer-fixture.ts");

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * `ai_artifacts.type` 是**枚举** `artifact_type`（`learning_card|summary|code_explanation|pitfall|question`），
 * 不是自由文本——样例链只能用它已有的词汇，不能为了好数另立一套。
 * 区分步骤靠 `prompt_version`（每步 `slice-<step>-v1`），那是自由文本、本来就是按步算的。
 */
const ARTIFACT_TYPE_BY_STEP: Record<string, "question" | "summary"> = {
  note_generate: "question",
  regenerate: "question",
  note_check: "summary",
  note_check_slow: "summary",
  crash_check: "summary",
};
const provider = new MockProvider();

let world: Awaited<ReturnType<typeof seedFormalAnswerRun>>;
/** 这一步用掉的那条 `jobs` 行；每步一条，身份就是它。 */
const stepJobs = new Map<string, JobLeaseContext>();
/** 一步一个幂等键：`jobs.idempotency_key` 与 `attempt.idempotencyKey` 必须同源。 */
const stepKeys = new Map<string, string>();
const artifactIds = new Map<string, string>();

after(async () => {
  await admin`DELETE FROM ai_artifacts WHERE workspace_id = ${world.workspaceId}`.catch(() => undefined);
  await admin`DELETE FROM learning_assessments WHERE workspace_id = ${world.workspaceId}`.catch(() => undefined);
  await admin`DELETE FROM learning_artifacts WHERE workspace_id = ${world.workspaceId}`.catch(() => undefined);
  await admin`DELETE FROM jobs WHERE workspace_id = ${world.workspaceId}`.catch(() => undefined);
  await world.cleanup().catch(() => undefined);
  await closeDatabase().catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
});

/** 一步的驱动 job：`jobs.payload` 同时是它的检查点存处（约束 3）。 */
async function seedStepJob(taskId: string, idempotencyKey: string): Promise<JobLeaseContext> {
  const id = randomUUID();
  const leaseToken = `lease-${taskId}-${randomUUID().slice(0, 8)}`;
  await admin`
    INSERT INTO jobs (id, type, workspace_id, payload, status, attempts, lease_token, requested_by,
                      priority, resource_class, idempotency_key, started_at)
    VALUES (${id}, ${`vertical_slice_${taskId}`}, ${world.workspaceId}, ${admin.json({ checkpoints: {} })}::jsonb,
            'running', 1, ${leaseToken}, ${world.userId}, 100, 'card_foreground', ${idempotencyKey}, now())
  `;
  const job: JobLeaseContext = { id, workspaceId: world.workspaceId, requestedBy: world.userId, leaseToken };
  stepJobs.set(taskId, job);
  stepKeys.set(taskId, idempotencyKey);
  return job;
}

/** 检查点在 `jobs.payload.checkpoints` 里的键（三条判据一起当键用，D5 §4.2）。 */
const checkpointKey = (key: {
  taskId: string; taskVersion: number; inputSnapshotHash: string;
}): string => `${key.taskId}@${key.taskVersion}:${key.inputSnapshotHash}`;

function jobPayloadCheckpoint(taskId: string): AiTaskCheckpointPort<string> {
  return {
    // 读的是**这一条 job 自己的** payload：检查点天然按尝试所在的 job 隔离，不需要
    // 再引一张表来存"哪一步算过了"。查的是键本身而不是"当前检查点"——所以
    // taskVersion 或输入哈希变了就读不到（"不默默复用"就是这么落的）。
    //
    // 写走夹具那条超级用户连接：内核是在**提交之后**才回写检查点的（提交段自己
    // 在受限角色事务里，见各步的 commit）。这里刻意不装作"检查点与业务写在同一事务"
    // ——真链要在同一事务里写检查点的话，改的是这个端口背后的一段 SQL，不是判据。
    load: async (key) => {
      const rows = await admin`
        SELECT payload -> 'checkpoints' -> ${checkpointKey(key)} AS entry
        FROM jobs WHERE id = ${currentJobIdFor(taskId)} AND workspace_id = ${world.workspaceId}
      `;
      const entry = rows[0]?.entry as { output?: unknown; promptTokens?: number; completionTokens?: number } | null;
      if (!entry || typeof entry.output !== "string") return null;
      return {
        output: entry.output,
        promptTokens: entry.promptTokens ?? 0,
        completionTokens: entry.completionTokens ?? 0,
      };
    },
    save: async (key, entry) => {
      await admin`
        UPDATE jobs
        SET payload = jsonb_set(
          payload,
          ${[`checkpoints`, checkpointKey(key)]}::text[],
          ${admin.json({ ...entry })}::jsonb,
          true)
        WHERE id = ${currentJobIdFor(key.taskId)} AND workspace_id = ${world.workspaceId}
      `;
    },
  };
}

function currentJobIdFor(taskId: string): string {
  const job = stepJobs.get(taskId);
  if (!job) throw new Error(`step ${taskId} 没有驱动 job（先 seedStepJob 再跑）`);
  return job.id;
}

/**
 * 一个样例任务：三段都接真的东西，但**执行体可以按用例换**（超时、提交失败等）。
 *
 * `resourceClass` 走 `card_foreground` 而不是 `interactive_ai`——这正是 D5 §3 第 2 条
 * 要的那条隔离（作答反馈不能被批量制卡耗尽），`ailearn_claim_jobs` 早就按这两档分名额。
 */
function sampleTask(overrides: Partial<AiTaskDefinition<string, string>> & { id: string }): AiTaskDefinition<string, string> {
  const base: AiTaskDefinition<string, string> = {
    id: overrides.id,
    version: 1,
    mode: "structured",
    resourceClass: "card_foreground",
    budget: { maxModelCalls: 4, stepTimeoutMs: 1_500, taskDeadlineMs: 6_000, maxAutoRetries: 1 },
    completion: { kind: "structured_parsed" },
    usageContext: { modelId: provider.modelId, promptVersion: `slice-${overrides.id}-v1`, resourceClass: "card_foreground" },
    prepare: async () => `input:${overrides.id}`,
    execute: async (input) => {
      const answer = await provider.chatCompletion(
        [{ role: "user", content: input }],
        { maxTokens: 64, temperature: 0 },
      );
      // 严格解析这一步就在这里：解析不出来回 `output_shape`（可重试那一类），
      // 而不是把半截 JSON 交给提交段。
      if (!answer.content.includes("status")) {
        return { ok: false, class: "output_shape", message: "答复里没有那个字段" };
      }
      return { ok: true as const, output: `${overrides.id}|${answer.content}`, promptTokens: 5, completionTokens: 3 };
    },
    commit: async (_ctx, _attempt, output) => {
      await withWorkerWorkspaceTransaction(
        { workspaceId: world.workspaceId, userId: world.userId },
        async (tx) => {
          await lockJobLease(tx, stepJobs.get(overrides.id)!);
          const id = randomUUID();
          artifactIds.set(overrides.id, id);
          // output 与 input_refs 都是 jsonb：文本要先成 JSON 再显式 cast。裸文本会让整条
          // insert 以 invalid input syntax for type json 失败，而 drizzle 会把驱动原文
          // 包成 "Failed query:"——成因看不见的报法。（注释也不能写进 SQL 模板串里：
          // 那里出现反引号就当场截断字面量。）
          await tx.execute(drizzleSql`
            INSERT INTO ai_artifacts (id, workspace_id, type, input_refs, output, model_id, prompt_version, input_hash)
             VALUES (${id}, ${world.workspaceId}, ${ARTIFACT_TYPE_BY_STEP[overrides.id] ?? "question"}, ${JSON.stringify([])}::jsonb,
                     ${JSON.stringify({ text: output })}::jsonb,
                     ${provider.modelId}, ${`slice-${overrides.id}-v1`}, ${hash(output)})
          `);
        },
      );
      return committed(output);
    },
  };
  return { ...base, ...overrides };
}

function committed(output: string): AiTaskReceipt<string> {
  return {
    outcome: "committed", output,
    usage: { modelCalls: 1, promptTokens: 0, completionTokens: 0, elapsedMs: 0, autoRetriesUsed: 0 },
    failure: null, preservedValidResult: false, resumedFromCheckpoint: false, modelCalls: 1,
  };
}

function optionsFor(taskId: string) {
  const job = stepJobs.get(taskId)!;
  return {
    ctx: {
      workspaceId: world.workspaceId,
      userId: world.userId,
      inputSnapshotRef: { kind: "task" as const, id: taskId, hash: hash(`input:${taskId}`) },
      permissionLevel: "guided",
    },
    attempt: {
      taskId,
      taskVersion: 1,
      attemptId: randomUUID(),
      leaseToken: job.leaseToken,
      idempotencyKey: stepKeys.get(taskId) ?? `slice-${taskId}`,
      workspaceId: world.workspaceId,
      userId: world.userId,
    },
    currentActiveTransaction: currentWorkerWorkspaceTransaction,
    checkpoint: jobPayloadCheckpoint(taskId),
    verifyAttempt: (attempt: { leaseToken: string }) =>
      isJobLeaseActive({ ...job, leaseToken: attempt.leaseToken }),
  };
}

world = await seedFormalAnswerRun(admin as never, {});
await seedStepJob("note_generate", "k1");
await seedStepJob("note_check", "k2");

test("一条链跑通：生成 → 检查 → 保存一张卡 → 开放回答 → 评估，全在同一个外壳上", async () => {
  const generated = await runAiTask(sampleTask({ id: "note_generate" }), optionsFor("note_generate"));
  assert.equal(generated.outcome, "committed", JSON.stringify(generated.failure));

  // 检查步的输入是上一步的产物：链是真的连着的，不是五个孤立任务并排跑。
  const checked = await runAiTask(
    sampleTask({
      id: "note_check",
      prepare: async () => `check:${artifactIds.get("note_generate") ?? "none"}`,
      completion: { kind: "custom", satisfied: (output) => output.includes("note_check"), unmetReason: "检查没有给出结论" },
    }),
    optionsFor("note_check"),
  );
  assert.equal(checked.outcome, "committed", JSON.stringify(checked.failure));

  const artifacts = await admin`
    SELECT prompt_version, type, input_hash FROM ai_artifacts
    WHERE workspace_id = ${world.workspaceId} ORDER BY prompt_version`;
  assert.deepEqual(artifacts.map((row) => row.prompt_version), ["slice-note_check-v1", "slice-note_generate-v1"]);
  // 落库的 type 是枚举里的值，不是样例自己造的词
  assert.deepEqual(artifacts.map((row) => row.type), ["summary", "question"]);
  // 每步的产物都带输入哈希：恢复与"这份结果是对哪一版输入"的判据靠它，不靠时间戳。
  assert.ok(artifacts.every((row) => /^[0-9a-f]{64}$/.test(String(row.input_hash))));

  // ── 保存一张卡：业务回执，不花钱、不进模型 ──
  // `lc_v2_ws_obj_active_idx` 是 (workspace, objective) 上**只允许一张活跃卡**，
  // 而夹具那篇已经占着它自己的目标。生成这一步的语义本来就是"长出一个新目标 +
  // 一张卡"，所以这里新写一个 objective 与它的修订，而不是去动夹具那一行。
  const noteVersion = (await admin`SELECT id FROM note_versions WHERE workspace_id = ${world.workspaceId} LIMIT 1`)[0].id;
  const savedCardId = randomUUID();
  const generatedObjectiveId = randomUUID();
  const generatedRevisionId = randomUUID();
  await admin.begin(async (tx) => {
    await tx`INSERT INTO learning_objectives_v2
      (id, workspace_id, objective_id, semantic_identity_class_id, semantic_identity_policy_version,
       semantic_target_fingerprint, lifecycle, lifecycle_epoch, current_objective_revision_id, current_revision)
      VALUES (gen_random_uuid(), ${world.workspaceId}, ${generatedObjectiveId}, 'slice:class', 'sem-id-v1',
              ${"f".repeat(64)}, 'active', 1, ${generatedRevisionId}, 1)`;
    await tx`INSERT INTO learning_objective_revisions_v2
      (id, workspace_id, objective_revision_id, objective_id, revision, objective_statement, public_summary,
       knowledge_form, preferred_intents, canonical_answer, learning_support, scoring_rubric, relations,
       evidence_bindings, semantic_target_fingerprint, target_revision_hash, private_payload_hash)
      VALUES (gen_random_uuid(), ${world.workspaceId}, ${generatedRevisionId}, ${generatedObjectiveId}, 1,
              ${"样例目标"}, ${"样例公开摘要"}, 'definition', ARRAY['recall'],
              ${tx.json({ kind: "text", unit: { unitId: "u1", text: "样例答案" } })},
              ${tx.json({ explanation: "样例补充" })},
              ${tx.json({ version: 2, units: [] })}, '[]'::jsonb, '[]'::jsonb,
              ${"f".repeat(64)}, ${"e".repeat(64)}, ${"d".repeat(64)})`;
  });
  await admin`
    INSERT INTO learning_cards_v2
      (id, workspace_id, card_id, objective_id, note_version_id, card_revision, current_publication_revision,
       lifecycle, front, public_summary, knowledge_form, strategy, presentation_hash)
    VALUES (gen_random_uuid(), ${world.workspaceId}, ${savedCardId}, ${generatedObjectiveId}, ${noteVersion}, 1, 1,
            'active', ${admin.json({ cue: "样例正面", prompt: "样例问句" })}::jsonb,
            '样例公开摘要', 'definition', 'recall', ${"c".repeat(64)})
  `;
  const cards = await admin`SELECT card_id FROM learning_cards_v2 WHERE workspace_id = ${world.workspaceId} AND card_id = ${savedCardId}`;
  assert.equal(cards.length, 1, "样例链的保存步骤要落到真的卡片表，否则'保存一张卡'只是句比喻");

  // ── 开放回答 → 评估与观察：作答侧同样是公共基础上的一个任务 ──
  const variantId = (await admin`SELECT id FROM learning_task_variants WHERE workspace_id = ${world.workspaceId} LIMIT 1`)[0].id;
  const learnerArtifactId = randomUUID();
  // `learning_artifacts` 的三件套（状态 CHECK、locked 要 locked_at、一任务只允许一条 locked）
  await admin`
    INSERT INTO learning_artifacts
      (id, run_id, task_id, variant_id, workspace_id, user_id, payload, payload_hash, public_payload_hash,
       input_schema_hash, private_solution_hash, safety_report_hash, disclosure_profile_hash,
       assistance_snapshot_hash, status, locked_at)
    VALUES (${learnerArtifactId}, ${world.runId}, ${world.taskId}, ${variantId}, ${world.workspaceId}, ${world.userId},
            ${admin.json({ text: "我的开放回答" })}::jsonb, ${"1".repeat(64)}, ${"2".repeat(64)},
            ${"3".repeat(64)}, ${"4".repeat(64)}, ${"5".repeat(64)}, ${"6".repeat(64)}, ${"7".repeat(64)},
            'locked', now())
  `;
  await seedStepJob("assess_open", "k3");
  const assessed = await runAiTask(
    sampleTask({
      id: "assess_open",
      prepare: async () => `assess:${learnerArtifactId}`,
      // 评估行的**归属**在这一步暴露出来：`learning_assessments` 对 `ailearn_worker`
      // 没有 INSERT 权限（生产里它是 API 侧 `run-processing-tick` 写的）。所以样例的
      // 这一步只能交出**AI 产物**，"观察"落库由 API 侧承接——这条边界交回 W3-5
      // （作答 AI 迁入）：迁的是执行，不是把领域写入挪进 worker。
      commit: async (_c, _a, output) => {
        await withWorkerWorkspaceTransaction(
          { workspaceId: world.workspaceId, userId: world.userId },
          async (tx) => {
            await lockJobLease(tx, stepJobs.get("assess_open")!);
            await tx.execute(drizzleSql`
              INSERT INTO ai_artifacts (id, workspace_id, type, input_refs, output, model_id, prompt_version, input_hash)
              VALUES (${randomUUID()}, ${world.workspaceId}, 'pitfall', ${JSON.stringify([learnerArtifactId])}::jsonb,
                      ${JSON.stringify({ text: output })}::jsonb,
                      ${provider.modelId}, 'slice-assess_open-v1', ${hash(output)})
            `);
          },
        );
        return committed(output);
      },
    }),
    optionsFor("assess_open"),
  );
  assert.equal(assessed.outcome, "committed", JSON.stringify(assessed.failure));
  const observations = await admin`
    SELECT type, input_refs FROM ai_artifacts
    WHERE workspace_id = ${world.workspaceId} AND prompt_version = 'slice-assess_open-v1'`;
  assert.equal(observations.length, 1);
  assert.equal(observations[0].type, "pitfall");
  // 评估这一步的产物里带着被评的那份作答的 id（input_refs），链是连着的。
  assert.deepEqual(observations[0].input_refs, [learnerArtifactId]);
});

test("慢检查：那一步超时 ⇒ 只重跑检查，生成那一步走检查点、一次模型都不调", async () => {
  const generated = await runAiTask(sampleTask({ id: "note_generate" }), optionsFor("note_generate"));
  // 本文件按声明顺序跑，测试 1 已经把这一步提交过一次，所以这里两种结果都算"这一步有产出"：
  // 首次提交，或命中检查点的复用。**这条测试真正要判的是下面两条**（超时那一步重跑了几次、
  // 已完成那一步还调不调模型），把这里写死成 committed 只会让用例顺序变成前提。
  assert.ok(
    ["committed", "resumed_and_committed"].includes(generated.outcome),
    JSON.stringify({ outcome: generated.outcome, failure: generated.failure }),
  );
  assert.ok(generated.modelCalls <= 1, "这一步要么复用、要么最多调一次，不许两次");

  // 独立的一步（自己的 job 与输入哈希）：复用 note_check 会直接命中测试 1 留下的
  // 检查点，那这一步一次模型都不会调，"超时重跑"就测不到了。
  await seedStepJob("note_check_slow", "k2b");
  const attempts: number[] = [];
  const slowCheck = sampleTask({
    id: "note_check_slow",
    execute: async () => {
      attempts.push(attempts.length + 1);
      // 第一次：一个不合作（不看 signal）的慢调用，靠内核的单步超时兜住。
      if (attempts.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        return { ok: false, class: "transport", message: "太慢了" };
      }
      return { ok: true as const, output: `note_check|补上了`, promptTokens: 2, completionTokens: 2 };
    },
  });
  const checked = await runAiTask(slowCheck, optionsFor("note_check_slow"));
  assert.equal(checked.outcome, "committed", JSON.stringify({ failure: checked.failure, resumed: checked.resumedFromCheckpoint, calls: checked.modelCalls }));
  assert.equal(attempts.length, 2, "超时的那一步该重来一次");

  // **这一条才是"不重付已完成步骤"的证明**：把生成再跑一遍，它一次模型都不该调。
  const again = await runAiTask(sampleTask({ id: "note_generate" }), optionsFor("note_generate"));
  assert.equal(again.resumedFromCheckpoint, true, "生成已提交过，却又一次付费调用");
  assert.equal(again.modelCalls, 0);
  assert.ok(again.output?.startsWith("note_generate|"));
});

test("评分失败（提交被拒）：模型不重跑，已保存的卡与作答不受影响", async () => {
  await seedStepJob("assess_submit_fails", "k4");
  let modelCalls = 0;
  const task = sampleTask({
    id: "assess_submit_fails",
    execute: async (input) => {
      modelCalls += 1;
      return { ok: true as const, output: `verdict:${input}`, promptTokens: 1, completionTokens: 1 };
    },
    commit: async () => {
      throw new Error("业务提交被拒（例如内容版本已前移）");
    },
  });
  const receipt = await runAiTask(task, optionsFor("assess_submit_fails"));
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.failure?.class, "submission_failed");
  assert.equal(modelCalls, 1, "提交失败回头又调了一次模型：两条轴又被合成一条");
  assert.equal(receipt.preservedValidResult, true, "已经拿到的判定结果不许因为一次提交失败被丢掉");
  // 前一步保存的卡还在：评分失败不该波及已提交的业务写入。
  const cards = await admin`SELECT 1 FROM learning_cards_v2 WHERE workspace_id = ${world.workspaceId}`;
  assert.ok(cards.length >= 1);
});

test("单卡重生成：输入变了就不许复用旧检查点（版本或哈希任一不同即重跑）", async () => {
  await seedStepJob("regenerate", "k5");
  const first = await runAiTask(sampleTask({ id: "regenerate" }), optionsFor("regenerate"));
  assert.equal(first.modelCalls, 1);
  const replayed = await runAiTask(sampleTask({ id: "regenerate" }), optionsFor("regenerate"));
  assert.equal(replayed.resumedFromCheckpoint, true, "同输入重放该走检查点");
  assert.equal(replayed.modelCalls, 0);

  // 换任务版本（提示词或输出合同变了）⇒ 既不能默默复用旧产物，也不能默默重跑已完成步
  const bumped = sampleTask({ id: "regenerate", version: 2 });
  const opts = { ...optionsFor("regenerate"), attempt: { ...optionsFor("regenerate").attempt, taskVersion: 2 } };
  const rejudged = await runAiTask(bumped, opts);
  assert.equal(rejudged.resumedFromCheckpoint, false, "换了版本还复用旧检查点＝拿旧提示词的产物交新合同");
  assert.equal(rejudged.modelCalls, 1);
});

test("检查点前后杀 worker：恢复只重试未完成的那一步", async () => {
  await seedStepJob("crash_generate", "k6");
  await seedStepJob("crash_check", "k7");

  // 生成步已经提交完，检查步在**付费调用之后、提交之前**被打断（模拟 worker 被杀）。
  const gen = await runAiTask(sampleTask({ id: "crash_generate" }), optionsFor("crash_generate"));
  assert.equal(gen.outcome, "committed");

  let checkCalls = 0;
  const killed = sampleTask({
    id: "crash_check",
    execute: async () => {
      checkCalls += 1;
      throw new Error("worker was killed while waiting for the model");
    },
    budget: { maxModelCalls: 4, stepTimeoutMs: 1_500, taskDeadlineMs: 6_000, maxAutoRetries: 0 },
  });
  const crashed = await runAiTask(killed, optionsFor("crash_check"));
  assert.equal(crashed.outcome, "failed");
  assert.equal(checkCalls, 1, "检查步该只被尝试一次（本例额度 0 次重试）");

  // 换一个尝试令牌（reaper 已把 job 放回、另一个 worker 领到）：生成走检查点、只补检查。
  // 换键：`jobs_workspace_idempotency_unique_idx` 是 (workspace_id, idempotency_key)——
  // 同一步被另一个 worker 重新领取时，新的是**尝试**，不是新的一条幂等批次。
  const replacement = await seedStepJob("crash_check", "k7-retry");
  const resumed = await runAiTask(sampleTask({ id: "crash_check" }), {
    ...optionsFor("crash_check"),
    attempt: { ...optionsFor("crash_check").attempt, attemptId: randomUUID(), leaseToken: replacement.leaseToken },
  });
  assert.equal(resumed.outcome, "committed", JSON.stringify(resumed.failure));
  const stillThere = await runAiTask(sampleTask({ id: "crash_generate" }), optionsFor("crash_generate"));
  assert.equal(stillThere.modelCalls, 0, "恢复时把已完成的生成步又付了一次钱");
  assert.equal(stillThere.resumedFromCheckpoint, true);
});

test("两个 worker 抢同一步：旧令牌那份晚到的结果提交不出去，产物只有一份", async () => {
  await seedStepJob("race", "k8");
  const job = stepJobs.get("race")!;
  const slow = sampleTask({
    id: "race",
    execute: async (input) => {
      // 她还在算的时候，reaper 把租约给了另一个 worker。
      await admin`UPDATE jobs SET lease_token = ${"lease-taken-by-other-worker"} WHERE id = ${job.id}`;
      return { ok: true as const, output: `旧 worker 的晚到结果:${input}`, promptTokens: 1, completionTokens: 1 };
    },
  });
  const stale = await runAiTask(slow, optionsFor("race"));
  assert.equal(stale.outcome, "failed");
  assert.equal(stale.failure?.class, "lease_lost");
  const rows = await admin`SELECT id FROM ai_artifacts WHERE workspace_id = ${world.workspaceId} AND prompt_version = 'slice-race-v1'`;
  assert.equal(rows.length, 0, "旧尝试往产物表写了一行");

  // 新令牌那份照常交得出去：拒收的是身份，不是"这一步永远做不完"。
  const fresh = await seedStepJob("race", "k8-retry");
  const winner = await runAiTask(sampleTask({ id: "race" }), {
    ...optionsFor("race"),
    attempt: { ...optionsFor("race").attempt, leaseToken: fresh.leaseToken },
  });
  assert.equal(winner.outcome, "committed", JSON.stringify(winner.failure));
  const after = await admin`SELECT id FROM ai_artifacts WHERE workspace_id = ${world.workspaceId} AND prompt_version = 'slice-race-v1'`;
  assert.equal(after.length, 1, "同一幂等键的同一步最后交出了不止一份产物");
});

test("伴星作为真实调用方：tool_loop 模式走同一层外壳，取消不撤销已提交的动作", async () => {
  await seedStepJob("companion_turn", "k9");
  const task = sampleTask({
    id: "companion_turn",
    mode: "tool_loop",
    completion: { kind: "tool_loop_settled" },
    execute: async () => {
      // 真的走一次 provider 的工具循环（mock 的实现），不是把 structured 换个名字。
      const turn = await provider.executeAgentTurn({
        role: "companion_agent",
        systemPrompt: "样例 system",
        messages: [{ role: "user", content: "帮我把这一题的条件读一遍" }],
        tools: [{ name: "companion_read_context", description: "读当前上下文", parameters: {} }],
        toolChoice: "required",
        maxTokens: 64,
        temperature: 0.4,
      });
      assert.equal(turn.toolCalls.length, 1, "required 那一档必须真的拿到一个工具调用");
      return { ok: true as const, output: `settled|${turn.toolCalls[0].name}`, promptTokens: 4, completionTokens: 2 };
    },
  });
  const receipt = await runAiTask(task, optionsFor("companion_turn"));
  assert.equal(receipt.outcome, "committed", JSON.stringify(receipt.failure));
  assert.match(receipt.output ?? "", /^settled\|companion_read_context$/);

  // 取消落在提交之后：已提交的业务动作不撤销（39b §5 末段），回执仍是 committed。
  const controller = new AbortController();
  const afterCommit = sampleTask({
    id: "companion_turn",
    commit: async (_c, _a, output) => {
      controller.abort();
      return committed(output);
    },
  });
  const opts = optionsFor("companion_turn");
  const second = await runAiTask(afterCommit, {
    ...opts,
    ctx: { ...opts.ctx, signal: controller.signal },
    attempt: { ...opts.attempt, attemptId: randomUUID() },
  });
  assert.equal(second.outcome, "resumed_and_committed", "检查点命中 + 提交后取消：该报告已提交而不是失败");
});

test("外部调用不落在事务里：内核被要求在真 worker 事务内跑 ⇒ 当场拒绝", async () => {
  // 这条是 W3-2 的判据在**样例链**上的复量：样例的形状如果没有真的把慢调用挪到事务外，
  // 这里就会红。
  await seedStepJob("misuse", "k10");
  const reported: string[] = [];
  await assert.rejects(
    () => withWorkerWorkspaceTransaction(
      { workspaceId: world.workspaceId, userId: world.userId },
      async (tx) => {
        await tx.execute(drizzleSql`SELECT 1`);
        return runAiTask(sampleTask({ id: "misuse" }), {
          ...optionsFor("misuse"),
          reportDevelopmentError: (message) => reported.push(message),
        });
      },
    ),
    /外部调用被拒/,
  );
  assert.equal(reported.length, 1);
  const rows = await admin`SELECT id FROM ai_artifacts WHERE workspace_id = ${world.workspaceId} AND prompt_version = 'slice-misuse-v1'`;
  assert.equal(rows.length, 0);
});

test("身份合同：一步 = 一条 jobs 行 = 一个租约 + 一个幂等键（不另立编号）", async () => {
  const job = await seedStepJob("identity", "k11");
  const opts = optionsFor("identity");
  assert.equal(opts.attempt.leaseToken, job.leaseToken, "尝试令牌与 job 的租约不是同一个来源");
  assert.equal(opts.attempt.workspaceId, job.workspaceId);
  assert.equal(opts.attempt.userId, job.requestedBy);
  const rows = await admin`
    SELECT idempotency_key, lease_token, resource_class FROM jobs
    WHERE id = ${job.id} AND workspace_id = ${world.workspaceId}`;
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].idempotency_key), opts.attempt.idempotencyKey);
  assert.equal(rows[0].resource_class, "card_foreground", "样例任务必须指名资源档；作答反馈与批量制卡不串同一名额");
});

test("样例的失败分类不自己发明：抛出来的异常按同一张表归类", () => {
  assert.equal(classifyThrownAsStepFailure(new Error("read ETIMEDOUT")).class, "timeout");
  assert.equal(classifyThrownAsStepFailure(new Error("ECONNREFUSED")).class, "transport");
});
