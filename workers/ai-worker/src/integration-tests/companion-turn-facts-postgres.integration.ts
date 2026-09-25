/**
 * 实体先行解析（39d W2-3）的**真实 SQL**：五类实体、超预算丢弃、归属边界。
 *
 * 为什么要有这一支：`companion-this-turn-facts` 的判据是 SQL（uuid 列表参数、LEFT JOIN
 * 排程、逐词 ILIKE 链、跨 5 张表），用桩 tx 测只能证明"我按我写的方式调用了自己"。
 * 这支用例自己造夹具、跑真 SQL。
 *
 * 角色纪律（doc 34 L37/L43）：**夹具写走超级用户（`DATABASE_URL`），被测读数走受限角色**
 * （`DATABASE_URL_WORKER`，dev 里 `ailearn_worker` 是 NOBYPASSRLS）。两条串混用会让
 * "读不到别人的私有笔记"这类断言变成假绿。
 *
 * 反向断言各配一条正向对照：只报"读不到"的话，判据把所有人全挡住时同样是绿的。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import type { LivePageView } from "../handlers/companion-live-view.ts";

const ADMIN_CONN = process.env.DATABASE_URL ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
// 必须在 import `../db.ts` **之前**设好：连接串在那个模块加载时求值（动态 import 见下）。
process.env.DATABASE_URL_WORKER ??= "postgres://ailearn_worker:ailearn_dev@127.0.0.1:5432/ailearn";

const sql = postgres(ADMIN_CONN, { max: 2 });

const { loadThisTurnFacts } = await import("../handlers/companion-this-turn-facts.ts");
const { findNearestNoteTitle } = await import("../handlers/companion-note-reads.ts");
const { loadHereAndNow, renderHereAndNow } = await import("../handlers/companion-here-and-now.ts");
const { withWorkerWorkspaceTransaction } = await import("../db.ts");

// 清理与收池只用一个 after：两个 hook 的注册顺序就是执行顺序，先关池会让清理
// 撞上 `write CONNECTION_ENDED`——而那只报在文件级 hookFailed 里，看着像用例挂了。
after(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${ownerId}, true)`;
    // 追加-only 表（迁移 0180 的触发器）在清理事务内受控放行。
    await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
    await tx`DELETE FROM learning_target_snapshots_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_objective_origins_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM review_schedules WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_runs WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_cards_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_objective_revisions_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_objectives_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM note_image_assets WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM note_blocks WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM companion_reminders WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM assistant_memory_items WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await tx`DELETE FROM users WHERE id IN (${ownerId}, ${memberId})`;
  });
  const { closeDatabase } = await import("../db.ts");
  await closeDatabase().catch(() => undefined);
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

const tag = randomUUID().slice(0, 8);
const workspaceId = randomUUID();
const ownerId = randomUUID();
const memberId = randomUUID();
const noteId = randomUUID();
const noteVersionId = randomUUID();
const nearestNoteId = randomUUID();
const nearestVersionId = randomUUID();
const objectiveId = randomUUID();
const objectiveRevisionId = randomUUID();
const cardId = randomUUID();
const runId = randomUUID();
const reminderId = randomUUID();
const memoryId = randomUUID();

const NOTE_TITLE = `数据库索引优化策略-${tag}`;
const NEAREST_TITLE = `数据库索引优化策略旧稿-${tag}`;

await sql.begin(async (tx) => {
  await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
  await tx`SELECT set_config('app.user_id', ${ownerId}, true)`;
  await tx`INSERT INTO users (id, email, password_hash, role) VALUES
    (${ownerId}, ${`tf-owner-${tag}@x.test`}, 'h', 'owner'),
    (${memberId}, ${`tf-member-${tag}@x.test`}, 'h', 'member')`;
  await tx`INSERT INTO workspaces (id, name, owner_id, workspace_type) VALUES
    (${workspaceId}, ${`tf-${tag}`}, ${ownerId}, 'collaborative')`;
  await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
    (${workspaceId}, ${ownerId}, 'owner'),
    (${workspaceId}, ${memberId}, 'member')`;

  // 作者的私有笔记（默认态）：成员不该解析到它。
  await tx`INSERT INTO notes (id, workspace_id, title, created_by, share_scope, current_version_id) VALUES
    (${noteId}, ${workspaceId}, ${NOTE_TITLE}, ${ownerId}, 'private', NULL),
    (${nearestNoteId}, ${workspaceId}, ${NEAREST_TITLE}, ${ownerId}, 'private', NULL)`;
  await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by) VALUES
    (${noteVersionId}, ${noteId}, ${workspaceId}, 1, '{}'::jsonb, ${`h-${tag}-a`}, ${ownerId}),
    (${nearestVersionId}, ${nearestNoteId}, ${workspaceId}, 1, '{}'::jsonb, ${`h-${tag}-b`}, ${ownerId})`;
  await tx`UPDATE notes SET current_version_id = ${noteVersionId} WHERE id = ${noteId}`;
  await tx`UPDATE notes SET current_version_id = ${nearestVersionId} WHERE id = ${nearestNoteId}`;
  await tx`INSERT INTO note_blocks (id, version_id, workspace_id, ordinal, type, content) VALUES
    (${randomUUID()}, ${noteVersionId}, ${workspaceId}, 0, 'paragraph', ${`正文一 ${tag}`}),
    (${randomUUID()}, ${noteVersionId}, ${workspaceId}, 1, 'paragraph', ${`正文二 ${tag}`})`;
  await tx`INSERT INTO note_image_assets
      (id, workspace_id, uploaded_for_note_id, object_key, sha256, mime_type, byte_size, width, height, created_by)
    VALUES (${randomUUID()}, ${workspaceId}, ${noteId}, ${`k-${tag}`}, ${"ab".repeat(32)}, 'image/png', 100, 10, 10, ${ownerId})`;

  // 一个挂着这张卡的 active 目标 + 一条到点的排程（"第 3 张"那条判据的落点）。
  await tx`INSERT INTO learning_objectives_v2
    (id, workspace_id, objective_id, semantic_identity_class_id, semantic_identity_policy_version,
     semantic_target_fingerprint, lifecycle, lifecycle_epoch, current_objective_revision_id, current_revision)
    VALUES (gen_random_uuid(), ${workspaceId}, ${objectiveId}, 'fixture:class', 'sem-id-v1',
            ${"f".repeat(64)}, 'active', 1, ${objectiveRevisionId}, 1)`;
  await tx`INSERT INTO learning_objective_revisions_v2
    (id, workspace_id, objective_revision_id, objective_id, revision, objective_statement, public_summary,
     knowledge_form, preferred_intents, canonical_answer, learning_support, scoring_rubric, relations,
     evidence_bindings, semantic_target_fingerprint, target_revision_hash, private_payload_hash)
    VALUES (gen_random_uuid(), ${workspaceId}, ${objectiveRevisionId}, ${objectiveId}, 1,
            ${"索引的选择性"}, ${"索引的选择性"}, 'definition', ARRAY['recall'],
            '{"kind":"text","unit":{"unitId":"u1","text":"选择性越高越适合建索引"}}'::jsonb,
            '{"explanation":"选择性=不同值数/总行数"}'::jsonb,
            '{"version":2,"units":[],"passingPolicy":{"requireAllRequiredUnits":false,"allowContradiction":false},"rubricHash":"9"}'::jsonb,
            '[]'::jsonb, '[]'::jsonb, ${"f".repeat(64)}, ${"e".repeat(64)}, ${"d".repeat(64)})`;
  await tx`INSERT INTO learning_cards_v2
    (id, workspace_id, card_id, objective_id, note_version_id, card_revision, current_publication_revision, lifecycle,
     front, public_summary, knowledge_form, strategy, presentation_hash)
    VALUES (gen_random_uuid(), ${workspaceId}, ${cardId}, ${objectiveId}, ${noteVersionId}, 1, 1, 'active',
            ${tx.json({ cue: "索引的选择性", prompt: "什么情况下该给一列建索引？" })},
            ${"索引的选择性"}, 'definition', 'recall', ${"c".repeat(64)})`;
  await tx`INSERT INTO review_schedules
    (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at,
     interval_days, generation, policy_version, reason_code, created_at, updated_at)
    VALUES (${randomUUID()}, ${workspaceId}, ${ownerId}, 'card', ${objectiveId}, 'pending',
            now() - interval '1 hour', 1, 1, 'tf-fixture', 'fixture', now(), now())`;

  // 这篇笔记有 1 轮学习在暂停中（"服务端回填"那句的来源）。
  // origin/return_target 的**真实形状**（照着 dev 库现存行抄，见 `learning_runs` 的 jsonb 列）。
  const runOrigin = { kind: "card", cardId, objectiveId };
  await tx`INSERT INTO learning_runs
    (id, workspace_id, user_id, origin, return_target, target_fingerprint, goal, phase)
    VALUES (${runId}, ${workspaceId}, ${ownerId}, ${tx.json(runOrigin)}, ${tx.json(runOrigin)},
            ${"a".repeat(64)}, 'stabilize', 'paused')`;
  await tx`INSERT INTO learning_target_snapshots_v2
    (workspace_id, snapshot_id, run_id, objective_id, objective_revision_id, objective_revision,
     semantic_target_fingerprint, target_revision_hash, semantic_identity_class_id,
     semantic_identity_policy_version, objective_lifecycle_epoch, card_content_epoch,
     canonical_answer, scoring_rubric, preferred_intents, snapshot_hash, target)
    VALUES (${workspaceId}, ${randomUUID()}, ${runId}, ${objectiveId}, ${objectiveRevisionId}, 1,
            ${"f".repeat(64)}, ${"e".repeat(64)}, 'fixture:class', 'sem-id-v1', 1, 1,
            ${tx.json({ kind: "text", unit: { unitId: "u1", text: "选择性越高越适合建索引" } })},
            ${tx.json({ version: 2, units: [] })}, ARRAY['recall'], ${"b".repeat(64)},
            ${tx.json({ objectiveId, cardId, objectiveRevision: 1 })})`;
  await tx`INSERT INTO learning_objective_origins_v2
    (workspace_id, origin_id, objective_id, objective_revision_id, origin_kind, note_id, note_version_id)
    VALUES (${workspaceId}, ${randomUUID()}, ${objectiveId}, ${objectiveRevisionId}, 'note', ${noteId}, ${noteVersionId})`;

  await tx`INSERT INTO companion_reminders (id, workspace_id, user_id, text, fire_at)
    VALUES (${reminderId}, ${workspaceId}, ${ownerId}, ${`复习索引的选择性-${tag}`}, now() + interval '2 hours')`;
  await tx`INSERT INTO assistant_memory_items (id, workspace_id, user_id, kind, content)
    VALUES (${memoryId}, ${workspaceId}, ${ownerId}, 'preference', ${`用户偏好先看例子再看定义-${tag}`})`;
});


/** 被测读数一律走这个入口：受限角色 + 产品自己的读事务（与对话链同一个）。 */
async function factsFor(userId: string, userText: string, liveView: Partial<LivePageView> | null) {
  // 这一组用例只关心"屏上那一项是谁"，屏上状态一律给非作答页的默认值；
  // 作答页那一屏的记账资格由 `companion-answer-exposure` 那两组判。
  // null = 渲染层没发布过任何一屏（她只能凭这句话本身指认）。
  const view: LivePageView | null = liveView === null ? null : {
    pageKind: "other", interactionState: "idle", learningRunId: null,
    title: null, statusLine: null, items: [], ...liveView,
  };
  return withWorkerWorkspaceTransaction(
    { workspaceId, userId },
    (tx) => loadThisTurnFacts(tx, { workspaceId, userId, conversationId: null, userText, liveView: view }),
  );
}

test("第 N 张 → 屏上那一项对应的学习卡（含排程状态）", async () => {
  const facts = await factsFor(ownerId, "第三张到点了吗", {
    pageKind: "review",
    title: null,
    statusLine: null,
    items: [{ ordinal: 3, label: "索引的选择性", state: "到期待复习" }],
  });
  assert.ok(facts?.block, "第 3 张没有解析出卡——序数指代的核心用例");
  assert.match(facts.block, /学习卡《索引的选择性》/);
  assert.match(facts.block, new RegExp(cardId));
  assert.match(facts.block, /到期待复习/, "排程状态没带出来，她只能猜到没到点");
});

test("裸标题命中笔记：id、正文块数、图数、以及「这篇有 N 轮在暂停中」的回填", async () => {
  const facts = await factsFor(ownerId, `${NOTE_TITLE} 讲的是什么`, null);
  assert.ok(facts?.block);
  assert.match(facts.block, new RegExp(noteId));
  assert.match(facts.block, /正文 2 块/);
  assert.match(facts.block, /1 张图/);
  assert.match(facts.block, /1 轮学习在暂停中/);
  assert.match(facts.block, new RegExp(runId), "回填没带 runId 的话，start/resume 仍然只能靠服务端猜");
});

test("当前这一屏的对象对不上时给「最接近的一篇」，而不是把「没有」交给她", async () => {
  // 代词指到的是**这一屏**上的对象；那一屏的名字库里对不上时（改过名/被删/是卡的标题），
  // 服务端要给出"没有匹配 + 最接近的一篇"，否则她会把"我没查到"说成"库里没有"。
  const facts = await factsFor(ownerId, "这篇讲了什么", {
    pageKind: "note",
    title: "数据库索引优化策略旧", // 屏上那篇已经改过名：库里精确匹配不上，但有一篇最像
    statusLine: null,
    items: [],
  });
  assert.ok(facts?.block);
  assert.match(facts.block, /最接近的是《/, "没有最接近的一篇——这一行的价值就在这半句");
  assert.match(facts.block, new RegExp(NEAREST_TITLE), "最接近的应当是标题最像的那一篇");
});

test("相似度是双向的：不像的时候不硬凑一个「最接近」", async () => {
  const best = await withWorkerWorkspaceTransaction(
    { workspaceId, userId: ownerId },
    (tx) => findNearestNoteTitle(tx, { workspaceId, userId: ownerId }, NEAREST_TITLE),
  );
  assert.equal(best?.title, NEAREST_TITLE, "完全相同（或最像）时没有选出正确的那一篇");

  const unrelated = await withWorkerWorkspaceTransaction(
    { workspaceId, userId: ownerId },
    (tx) => findNearestNoteTitle(tx, { workspaceId, userId: ownerId }, "量子纠缠与相对论"),
  );
  assert.equal(unrelated, null, `毫不相干的指称也硬凑出了一篇：${JSON.stringify(unrelated)}`);
});

test("提醒与记忆也是解析的落点（五类里的两类）", async () => {
  const reminder = await factsFor(ownerId, `复习索引的选择性-${tag}`, null);
  assert.ok(reminder?.block);
  assert.match(reminder.block, /待提醒/);
  assert.match(reminder.block, new RegExp(reminderId));

  const memory = await factsFor(ownerId, `用户偏好先看例子再看定义-${tag}`, null);
  assert.ok(memory?.block);
  assert.match(memory.block, /记忆里有一条相关记录/);
  // 记忆行**不给 id**：它没有对应的"打开"动作，给了只会诱她照着念一串 uuid。
  assert.ok(!memory.block.includes(memoryId), "记忆行把内部 id 递给了她");
  assert.match(memory.block, new RegExp(`用户偏好先看例子再看定义-${tag}`));
});

test("代词取不到当前对象时给的是「没解析出来」的回执，不是替她挑一个", async () => {
  const facts = await factsFor(ownerId, "这篇讲了什么", { pageKind: "note", title: null, statusLine: null, items: [] });
  assert.ok(facts?.block);
  assert.match(facts.block, /没法确定/);
  assert.match(facts.block, /别猜/);
});

test("没有指称时整块不发（主动链/闲聊轮一次查询都不加）", async () => {
  assert.equal(await factsFor(ownerId, "今天好累啊", null), null);
});

test("超预算整块丢弃：不留半块事实，也不抛错", async () => {
  const realNow = Date.now;
  let ticks = 0;
  // 让预算在这一轮必然超时。不然这条分支只能靠真正的慢查询碰上——等于没有测试，
  // 而它的判据是"宁可这一轮不说，也不拖慢回合"。
  Date.now = () => realNow() + (ticks += 1) * 1_000;
  try {
    const facts = await factsFor(ownerId, `${NOTE_TITLE} 讲的是什么`, null);
    assert.ok(facts, "超预算时应当仍然返回读数对象（要能看出丢了）");
    assert.equal(facts.dropped, true);
    assert.equal(facts.block, null);
  } finally {
    Date.now = realNow;
  }
});

/**
 * 规则① 那一支（《X》）走的是环境块，不是事实块——但"这篇有 N 轮没结束"这句回填
 * 两支都要有：用户最自然的说法就是"继续学《X》"，而 start/resume 要用的 runId 只能
 * 从这里来（39b §9.8 的 C1）。
 */
test("「继续学《标题》」：环境块里带上这一篇的未结束轮次与 runId", async () => {
  const snapshot = await withWorkerWorkspaceTransaction(
    { workspaceId, userId: ownerId },
    (tx) => loadHereAndNow(tx, {
      workspaceId,
      userId: ownerId,
      conversationId: null,
      userText: `继续学《${NOTE_TITLE}》`,
      pageContext: null,
    }),
  );
  const block = renderHereAndNow(snapshot) ?? "";
  assert.ok(snapshot.noteReference?.found, "点名的笔记没有命中（夹具的标题对不上？）");
  assert.match(block, /1 轮学习在暂停中/);
  assert.match(block, new RegExp(runId), "没带 runId，start/resume 只能靠服务端猜");
});

/**
 * 她**读不到**这笔账（D7 §11：`<this_turn_facts>` 的键集里不含 exposure 相关键）。
 *
 * 为什么钉在数据上而不是扫源码：这条要求管的是"送进 prompt 的那段文字"，扫字符串
 * 会绿得毫无意义（改个措辞就绕过）。所以这里真的写一行暴露账目，再让她把这一屏
 * 与这一轮的指称都算一遍，看那两段文字里有没有冒出"暴露/借助/exposure"。
 */
test("暴露账目对她不可见：写了也读不到（不许她拿它解释用户的表现）", async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${ownerId}, true)`;
    await tx`INSERT INTO learning_exposures_v2
      (id, workspace_id, exposure_id, user_id, objective_id, objective_revision,
       card_id, card_revision, exposure_kind, context_hash, idempotency_key, exposed_at)
      VALUES (${randomUUID()}, ${workspaceId}, ${randomUUID()}, ${ownerId}, ${objectiveId}, 1,
              ${cardId}, 1, 'answer_reveal', 'probe', ${`probe-${randomUUID()}`}, now())`;
  });
  const blocks = await withWorkerWorkspaceTransaction(
    { workspaceId, userId: ownerId },
    async (tx) => {
      const snapshot = await loadHereAndNow(tx, {
        workspaceId, userId: ownerId, conversationId: null,
        userText: `${NOTE_TITLE} 讲的是什么`, pageContext: null,
      });
      const facts = await loadThisTurnFacts(tx, {
        workspaceId, userId: ownerId, conversationId: null,
        userText: `${NOTE_TITLE} 讲的是什么`, liveView: snapshot.livePageView,
      });
      return [renderHereAndNow(snapshot) ?? "", facts?.block ?? ""].join("\n");
    },
  );
  assert.match(blocks, /笔记《/, "夹具失效：环境块/事实块本来就是空的，这条断言什么也没读");
  assert.doesNotMatch(blocks, /exposure|暴露|借助/, `这笔记账漏进了她的感知里：${blocks}`);

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${ownerId}, true)`;
    await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
    await tx`DELETE FROM learning_exposures_v2 WHERE workspace_id = ${workspaceId}`;
  });
});

test("别人的私有笔记解析不到——哪怕标题一模一样", async () => {
  const asMember = await factsFor(memberId, `${NOTE_TITLE} 讲的是什么`, null);
  assert.equal(asMember, null, `成员解析到了作者的私有笔记：${asMember?.block}`);

  // 正向对照：同一个标题，作者自己解析得到——否则上一条可能只是"查询本身坏了"。
  const asOwner = await factsFor(ownerId, `${NOTE_TITLE} 讲的是什么`, null);
  assert.ok(asOwner?.block, "作者解析不到自己的笔记——判据接错了读取路径");
});
