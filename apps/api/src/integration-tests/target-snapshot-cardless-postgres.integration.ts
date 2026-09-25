/**
 * 无卡目标的冻结链集成测试（39d W3-4 / D1 §4.3 的三分支）。
 *
 * 判据原文（`docs/plans/learning-companion/39d-w01-d1-round-and-run-contract-2026-09-24.md` §4.3）：
 * active Objective 仍是硬前置；**Card 从必备降为可选**——
 * 有卡 ⇒ 照旧；无卡且有该修订的笔记依据 ⇒ 冻结，卡身份五列全 NULL；
 * 无卡也无依据 ⇒ fail closed `target_evidence_missing`（不许"既没卡也没依据"的空快照）。
 *
 * 这一份只测 `freezeTargetSnapshotV2` 本身（不经 PREPARE 服务）：要钉的是
 * "哪种输入冻结得出来、冻结出来的行长什么样"，不是端点接线。
 *
 * 运行（apps/api 下，夹具走超级用户、被测路径走受限角色）：
 *   DATABASE_URL="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn" \
 *   DATABASE_URL_API="postgres://ailearn_api:ailearn_dev@127.0.0.1:5432/ailearn" \
 *   node --import tsx --test --test-concurrency=1 \
 *     src/integration-tests/target-snapshot-cardless-postgres.integration.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { seedV2Fixture, seedV2ObjectiveOnly, seedObjectiveNoteEvidence } from "./helpers/v2-card-fixture.ts";

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
// 被测那一侧（`withWorkspaceTransaction`）读的是 API 角色：夹具写用 ADMIN，
// 判据跑用受限角色——同一个池跑到底会让"绿"失去隔离意义（见项目记忆 dev RLS 眼罩）。
process.env.DATABASE_URL_API ??= "postgres://ailearn_api:ailearn_dev@127.0.0.1:5432/ailearn";
const admin = postgres(ADMIN_URL, { max: 2 });

// 与 learning-runs-postgres 同口径：run 创建会写加密的私有解与 draft。
delete process.env.ASSESSMENT_CRITIC_URL;
delete process.env.ASSESSMENT_CRITIC_KEY;
process.env.LEARNING_RUN_ENABLED ??= "true";
process.env.LEARNING_DRAFT_ENC_KEY ??= "a".repeat(64);

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const { createRunV2, submitArtifact, getRunPublicView, revealRunTargetV2 } = await import(
  "../modules/learning-runs/run-service.ts"
);
const { runLearningRunProcessingTick } = await import("../modules/learning-runs/run-processing-tick.ts");
const { freezeTargetSnapshotV2, TargetSnapshotError } = await import(
  "../modules/card-generation-v2/target-snapshot-adapter.ts"
);

interface Seeded {
  workspaceId: string;
  userId: string;
  noteId: string;
  noteVersionId: string;
  objectiveId: string;
  objectiveRevisionId: string;
  runId: string;
  cleanup: () => Promise<void>;
}

/**
 * 一条 learning_runs 行（快照表的 run_id 有 RESTRICT 外键）。
 * origin 这里给 `note_round` 形状是不行的（合同里没这一档，W4 才加），
 * 但本文件不读 origin——只借这一行满足外键。
 */
async function seedRun(sql: postgres.Sql, workspaceId: string, userId: string, objectiveId: string) {
  const runId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO learning_runs (id, workspace_id, user_id, origin, return_target,
                                        target_fingerprint, goal, phase)
      VALUES (${runId}, ${workspaceId}, ${userId},
              ${tx.json({ kind: "card", cardId: randomUUID(), keyPointId: objectiveId })},
              ${tx.json({ kind: "card", cardId: randomUUID(), keyPointId: objectiveId })},
              ${"a".repeat(64)}, 'stabilize', 'preparing')`;
  });
  return runId;
}

/**
 * 该修订的一条笔记依据：evidence snapshot（usable）＋ binding ＋（可选）笔记版本锚。
 * 形状本体已搬到 `helpers/v2-card-fixture.ts` 的 `seedObjectiveNoteEvidence`（桥接侧
 * 也要造"真的开得出轮次"的无卡目标，两份各抄一遍五表 INSERT 迟早只对上一半）；
 * 这里只留这份文件用得上的三个开关，语义与原来逐字一致。
 */
async function seedNoteEvidence(
  s: Omit<Seeded, "runId">,
  opts: { noteId?: string; withOrigin?: boolean; withEvidence?: boolean } = {},
): Promise<string> {
  return seedObjectiveNoteEvidence(admin, s, opts);
}

async function freeze(s: Seeded) {
  return withWorkspaceTransaction(
    { workspaceId: s.workspaceId, userId: s.userId },
    (tx) => freezeTargetSnapshotV2(tx, {
      workspaceId: s.workspaceId,
      userId: s.userId,
      runId: s.runId,
      objectiveId: s.objectiveId,
      // PREPARE 传进来的"卡内容能力 epoch"。无卡那一条不许沿用它（见 §4.3）。
      cardContentEpoch: 7,
    }),
  );
}

async function seedObjectiveOnly(sql: postgres.Sql): Promise<Seeded> {
  const seeded = await seedV2ObjectiveOnly(sql);
  const runId = await seedRun(admin, seeded.workspaceId, seeded.userId, seeded.objectiveId);
  return { ...seeded, runId };
}

after(async () => {
  await closeDatabase().catch(() => undefined);
  await admin.end({ timeout: 5 });
});

test("无卡＋该修订有笔记依据 ⇒ 冻结成功，卡身份五列全 NULL，内容 epoch 取目标自己的代次", async () => {
  const s = await seedObjectiveOnly(admin);
  try {
    await seedNoteEvidence(s);
    const frozen = await freeze(s);
    assert.equal(frozen.snapshot.target.cardId, null, "无卡冻结不许伪造卡身份");
    assert.equal(frozen.snapshot.target.cardRevision, null);
    assert.equal(frozen.snapshot.target.publicationRevision, null);
    assert.equal(frozen.snapshot.target.publicPayloadHash, null);
    assert.equal(frozen.snapshot.target.revealPayloadHash, null);
    assert.equal(frozen.snapshot.target.objectiveId, s.objectiveId, "目标身份仍然是判据");
    // §4.3：cardContentEpoch 是 notNull，无卡时不许拿 0 或"卡内容 epoch"蒙混。
    assert.equal(frozen.snapshot.cardContentEpoch, 1);
    assert.equal(frozen.publicTarget.cardId, null, "公共投影也要能表达无卡");

    const rows = await admin`
      SELECT card_id, card_revision, publication_revision, public_payload_hash, reveal_payload_hash,
             card_content_epoch, snapshot_hash, target
      FROM learning_target_snapshots_v2 WHERE run_id = ${s.runId} AND workspace_id = ${s.workspaceId}`;
    assert.equal(rows.length, 1, "无卡冻结必须真落一行");
    assert.equal(rows[0].card_id, null);
    assert.equal(rows[0].card_revision, null);
    assert.equal(rows[0].publication_revision, null);
    assert.equal(rows[0].public_payload_hash, null);
    assert.equal(rows[0].reveal_payload_hash, null);
    assert.equal(Number(rows[0].card_content_epoch), 1);
    assert.match(String(rows[0].snapshot_hash), /^[0-9a-f]{64}$/, "哈希必须照样算得出来");
    // 落库的 target 里这五个键必须**存在且为 null**：`canonicalJsonV2` 会跳过
    // undefined，条件展开（"没卡就不写这个键"）会算出第三个摘要，而这里看不出来。
    const storedTarget = rows[0].target as Record<string, unknown>;
    for (const key of ["cardId", "publicationRevision", "cardRevision", "publicPayloadHash", "revealPayloadHash"]) {
      assert.ok(key in storedTarget, `target 里省掉了键 ${key}（应当写显式 null）`);
      assert.equal(storedTarget[key], null, `target.${key} 不是 null`);
    }
  } finally {
    await s.cleanup();
  }
});

test("无卡且一条依据都没有 ⇒ fail closed target_evidence_missing（不许空快照）", async () => {
  const s = await seedObjectiveOnly(admin);
  try {
    // 有版本锚、零依据：这样"零依据"这一判才是被单独测到的（删掉它这条会红，
    // 而不是由"没有锚"那一条替它挡下来）。
    await seedNoteEvidence(s, { withEvidence: false });
    await assert.rejects(() => freeze(s), (err: unknown) => {
      assert.ok(err instanceof TargetSnapshotError, `期望 TargetSnapshotError，实际 ${String(err)}`);
      assert.equal(err.code, "target_evidence_missing");
      return true;
    });
    const rows = await admin`
      SELECT 1 FROM learning_target_snapshots_v2 WHERE run_id = ${s.runId} AND workspace_id = ${s.workspaceId}`;
    assert.equal(rows.length, 0, "拒了却还是把快照写进去了");
  } finally {
    await s.cleanup();
  }
});

test("无卡、有依据但没有笔记版本锚 ⇒ 同样 fail closed（版本只存在 origins 上）", async () => {
  const s = await seedObjectiveOnly(admin);
  try {
    await seedNoteEvidence(s, { withOrigin: false });
    await assert.rejects(() => freeze(s), TargetSnapshotError);
  } finally {
    await s.cleanup();
  }
});

test("无卡、依据出自另一篇笔记 ⇒ fail closed（'指向该修订的笔记内容'不许放宽成'有依据就行'）", async () => {
  const s = await seedObjectiveOnly(admin);
  try {
    await seedNoteEvidence(s, { noteId: randomUUID() });
    await assert.rejects(() => freeze(s), (err: unknown) => {
      assert.ok(err instanceof TargetSnapshotError, `期望 TargetSnapshotError，实际 ${String(err)}`);
      assert.match(err.message, /另一篇笔记/);
      return true;
    });
  } finally {
    await s.cleanup();
  }
});

test("目标本身不是 active ⇒ 仍然先按 objective 那一档拒（放宽只放宽卡，不放宽目标）", async () => {  const s = await seedObjectiveOnly(admin);
  try {
    await seedNoteEvidence(s);
    await admin`UPDATE learning_objectives_v2 SET lifecycle = 'archived'
      WHERE workspace_id = ${s.workspaceId} AND objective_id = ${s.objectiveId}`;
    await assert.rejects(() => freeze(s), (err: unknown) => {
      assert.ok(err instanceof TargetSnapshotError, `期望 TargetSnapshotError，实际 ${String(err)}`);
      assert.equal(err.code, "objective_not_found_or_inactive");
      return true;
    });
  } finally {
    await s.cleanup();
  }
});

test("有卡那一条一字未动：卡身份与 publication 哈希照旧写入，epoch 沿用 PREPARE 给的值", async () => {
  // 这条是改序（evidence closure 提到卡判定之前）的回归控制：
  // 断的不是新功能，而是"有卡时的行为没被顺手改掉"。
  const seeded = await seedV2Fixture(admin);
  const runId = await seedRun(admin, seeded.workspaceId, seeded.userId, seeded.objectiveId);
  try {
    const frozen = await withWorkspaceTransaction(
      { workspaceId: seeded.workspaceId, userId: seeded.userId },
      (tx) => freezeTargetSnapshotV2(tx, {
        workspaceId: seeded.workspaceId,
        userId: seeded.userId,
        runId,
        objectiveId: seeded.objectiveId,
        cardContentEpoch: 7,
      }),
    );
    assert.equal(frozen.snapshot.target.cardId, seeded.cardId);
    assert.match(String(frozen.snapshot.target.publicPayloadHash), /^[0-9a-f]{64}$/);
    assert.match(String(frozen.snapshot.target.revealPayloadHash), /^[0-9a-f]{64}$/);
    assert.equal(frozen.snapshot.cardContentEpoch, 7, "有卡时必须用 PREPARE 传进来的内容 epoch");
    assert.equal(frozen.publicTarget.cardId, seeded.cardId);
  } finally {
    await seeded.cleanup();
  }
});

// ─── 无卡目标开一场：API 边界那一头到不到得了 ────────────────────────────

/**
 * 这两条回答的是"冻结链之外还有没有卡依赖"。上一轮的读点清单说：
 * 题面、Variant、判分依据、结构化题解全部来自目标修订与证据（`run-planner.ts`
 * 的 recall 题面甚至是全仓一条常量串），卡只喂 publication 的两个哈希。
 * 那就必须真的跑一次 `createRunV2` 来证实/推翻，而不是停在"看起来不需要卡"。
 */
async function startRun(seeded: Omit<Seeded, "runId">) {
  return withWorkspaceTransaction(
    { workspaceId: seeded.workspaceId, userId: seeded.userId },
    (tx) => createRunV2(tx, {
      workspaceId: seeded.workspaceId,
      userId: seeded.userId,
      request: {
        originV2: { kind: "today", objectiveId: seeded.objectiveId },
        goal: "stabilize",
        idempotencyKey: `w34-${randomUUID()}`,
      },
    }),
  );
}

test("无卡目标从 API 边界开得起来：run＋task＋variant 都建得出来，快照没有卡身份", async () => {
  const seeded = await seedV2ObjectiveOnly(admin);
  try {
    await seedNoteEvidence(seeded);
    const created = await startRun(seeded);
    assert.ok(created.runId, "无卡目标的 run 没建出来");
    assert.equal(created.frozen.snapshot.target.cardId, null);

    const tasks = await admin`
      SELECT prompt, target_summary, intent FROM learning_tasks
      WHERE run_id = ${created.runId} AND workspace_id = ${seeded.workspaceId}`;
    assert.ok(tasks.length >= 1, "无卡目标的 run 没有题");
    assert.ok(String(tasks[0].prompt).length > 0, "题面是空的");
    // variant 挂在 task 上（这张表没有 run_id 列），所以按题去 join。
    const variants = await admin`
      SELECT v.purpose, v.interaction FROM learning_task_variants v
      JOIN learning_tasks t ON t.id = v.task_id
      WHERE t.run_id = ${created.runId} AND v.workspace_id = ${seeded.workspaceId}`;
    assert.ok(variants.length >= 1, "无卡目标的题没有 Variant（作答界面开不出来）");
    const snaps = await admin`
      SELECT card_id FROM learning_target_snapshots_v2
      WHERE run_id = ${created.runId} AND workspace_id = ${seeded.workspaceId}`;
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].card_id, null);
  } finally {
    await seeded.cleanup();
  }
});

test("开不了的时候要说真因：无依据的目标报「原稿内容不足」，不再让人去刷新学习卡", async () => {
  const seeded = await seedV2ObjectiveOnly(admin);
  try {
    let thrown: unknown = null;
    try {
      await startRun(seeded);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown !== null, "无依据的无卡目标竟然开得起来");
    const err = thrown as { code?: string; message?: string; statusCode?: number };
    assert.equal(err.code, "context_stale", "状态码语汇不该被文案改动带跑");
    assert.equal(err.statusCode, 409);
    assert.match(String(err.message), /原稿内容/);
    assert.ok(!String(err.message).includes("卡"),
      `文案还在把没有卡的情况说成卡的问题：${err.message}`);
  } finally {
    await seeded.cleanup();
  }
});

test("无卡快照走完提交→评估→结算，并在结果页揭示时记下没有卡的 exposure", async () => {
  const seeded = await seedV2ObjectiveOnly(admin);
  const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
  try {
    await seedNoteEvidence(seeded);
    const created = await startRun(seeded);
    // 这条整段的前提就是"这一场跑的快照没有卡"——前提本身也要断言，
    // 否则后面全绿的读数可能来自一张悄悄带上卡的快照。
    assert.equal(created.frozen.snapshot.target.cardId, null);
    const view = await withWorkspaceTransaction(scope, (tx) => getRunPublicView(tx, { ...scope, runId: created.runId }));
    const task = view.activeTask!;
    const variant = task.activeVariant;

    // 走确定性那一档（declared_unable）：这一段要测的是"无卡能不能走完全链"，
    // 不是 Critic 判分——Critic 的输入侧已实测与卡无关（prompt 里没有卡这一行）。
    const receipt = await withWorkspaceTransaction(scope, (tx) => submitArtifact(tx, {
      ...scope,
      runId: created.runId,
      taskId: view.activeTaskId!,
      request: {
        version: 1,
        variantId: variant.variantId,
        variantRevision: variant.revision,
        runRevision: view.revision,
        taskRevision: task.revision,
        inputSchemaHash: variant.inputSchemaHash,
        payload: { kind: "declared_unable", reasonCode: "cannot_recall" },
        idempotencyKey: `w34-submit-${randomUUID()}`,
      },
    })) as { artifactStatus: string; assessment: { status: string } };
    assert.equal(receipt.artifactStatus, "locked");
    assert.equal(receipt.assessment.status, "queued");

    let phase = "";
    for (let round = 0; round < 8; round += 1) {
      const tick = await runLearningRunProcessingTick(`w34-${randomUUID()}`, 10);
      assert.equal(tick.failed, 0, `tick 报 failed=${tick.failed}（无卡链在某处断了，不是文案问题）`);
      const probe = await withWorkspaceTransaction(scope, (tx) => getRunPublicView(tx, { ...scope, runId: created.runId }));
      phase = probe.phase;
      if (phase === "completed" || phase === "checkpoint") break;
    }
    assert.equal(phase, "completed", "无卡目标的 run 走不到终态");

    const settled = await admin`
      SELECT status, source, report_hash FROM learning_assessments
      WHERE run_id = ${created.runId} AND workspace_id = ${seeded.workspaceId}`;
    assert.equal(settled.length, 1);
    assert.equal(settled[0].source, "deterministic_declared_unable");
    assert.ok(["completed", "not_assessable"].includes(String(settled[0].status)),
      `评估没收尾：${settled[0].status}`);

    // 结果页揭示目标：这一步写 learning_exposures_v2，卡的两个键必须为空、
    // 目标的两个键必须有值（D7：帮助/暴露的记账归到目标修订，不归卡）。
    await withWorkspaceTransaction(scope, (tx) => revealRunTargetV2(tx, { ...scope, runId: created.runId }));
    const exposures = await admin`
      SELECT card_id, card_revision, objective_id, objective_revision, exposure_kind
      FROM learning_exposures_v2
      WHERE workspace_id = ${seeded.workspaceId} AND objective_id = ${seeded.objectiveId}`;
    assert.equal(exposures.length, 1, "无卡目标的揭示没有记账（漏记就等于泄题不留痕）");
    assert.equal(exposures[0].card_id, null);
    assert.equal(exposures[0].card_revision, null);
    assert.equal(String(exposures[0].objective_id), seeded.objectiveId);
    assert.ok(Number(exposures[0].objective_revision) >= 1, "暴露记账必须归到某一版目标");
  } finally {
    await seeded.cleanup();
  }
});
