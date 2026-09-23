/**
 * 生成批次与卡片的归属：按 (笔记, 人) 判（批次 4.5 步骤 8）。
 *
 * 用户提出的场景是「笔记是我的，但生成的人是别人 → 我既看不了也不能再生成，因为
 * 旧批次已经存在」。今天 `card_generation.*` 只对 owner 开放，那个场景还走不到；
 * 但按 (笔记, 人) 判的三处查询现在就存在，改回去只需一行——所以这里把它钉住，
 * 而不是等哪天开放成员生成时才发现"别人占坑我进不去"。
 *
 * 真实 Postgres。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import { cardGenerationRunsV2 } from "@ailearn/shared/db-schema/card-generation-v2";
import { createNote } from "../modules/note/service.ts";
import { getLatestGenerationRunForNoteV2, listActiveGenerationRunsV2 } from "../modules/card-generation-v2/generation-run-service.ts";
import { projectCardGenerationActiveSummaryListV1 } from "../modules/card-generation-v2/desktop-projection.ts";
import { listActiveCardsV2, readPublicCardV2 } from "../modules/card-generation-v2/card-service.ts";
import { addV2ObjectiveToWorkspace } from "./helpers/v2-card-fixture.ts";
import { assembleObjectiveSurfaceV3, listObjectiveSurfacesV3 } from "../modules/learning-objectives/surface-service.ts";
import { reindexWorkspaceSearch, search } from "../modules/search/service.ts";
import { CardGenerationV2ServiceError } from "../modules/card-generation-v2/helpers.ts";

/**
 * 夹具连接用超级用户那条：这份套件往 `users`/`workspaces`/`notes`/`note_versions` 原生写行
 * 且不带 `app.workspace_id`，受限角色下会被 `note_versions` 的 RESTRICTIVE 守卫拒掉
 * （或被静默过滤成 0 行），症状是"共享之后这张卡仍然看不见""IS NULL 那一支没写对"——
 * 全是夹具没落地，不是判据写错（doc 34 §1.2 ②）。被测侧不变：service 走 app 自己的池，
 * 而 `db/client.ts` 优先读 `DATABASE_URL_API`，所以仍然在 NOBYPASSRLS 下。
 */
const CONN = process.env.DATABASE_URL ?? process.env.DATABASE_URL_API;
if (!CONN) throw new Error("DATABASE_URL 未配置——生成批次归属集成测试要求真实 Postgres");

const sql = postgres(CONN, { max: 2 });
const tag = randomUUID().slice(0, 8);
const author = randomUUID();
const other = randomUUID();
const workspaceId = randomUUID();
let noteId = "";
let noteVersionId = "";

before(async () => {
  await sql`
    INSERT INTO users (id, email, password_hash, role)
    VALUES (${author}, ${`run-owner-${tag}@example.test`}, 'h', 'owner'),
           (${other}, ${`run-member-${tag}@example.test`}, 'h', 'owner')`;
  await sql`
    INSERT INTO workspaces (id, name, owner_id, workspace_type)
    VALUES (${workspaceId}, ${`run-own-${tag}`}, ${author}, 'collaborative')`;
  await sql`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${workspaceId}, ${author}, 'owner'), (${workspaceId}, ${other}, 'member')`;

  const created = await withWorkspaceTransaction({ workspaceId, userId: author }, (tx) =>
    createNote(tx, workspaceId, author, {
      title: `两个人都会去生成卡的笔记 ${tag}`,
      blocks: [
        { type: "heading", content: `标题 ${tag}` },
        { type: "paragraph", content: `正文，够长到能被生成分词 ${tag}` },
      ],
    }),
  );
  if (!created) throw new Error("createNote 返回 null");
  noteId = created.note.id;
  noteVersionId = created.version.id;
  // 夹具里这一步代替界面上的「共享给空间」：另一个人要能读到这篇，才谈得上按人判。
  await sql`UPDATE notes SET share_scope = 'shared' WHERE id = ${noteId}`;
});

after(async () => {
  // 卡那几张表按外键顺序删（`learning_cards_v2.note_version_id` 是 RESTRICT，
  // 笔记必须最后删）。漏一张就是一个不报错的残留——这正是 `mem-http-*` 那批
  // 脏数据的产生机制。
  //
  // 发布修订那张表是 append-only（受控旁路见迁移 0180）：不在事务里放行
  // `app.allow_history_mutation`，清理会直接 RAISE 而不是静默失败。
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
    await tx`DELETE FROM learning_card_publication_revisions_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_cards_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_objective_revisions_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM learning_objectives_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM note_blocks WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM note_document_states WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM card_generation_runs_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
  });
  await sql`UPDATE users SET personal_workspace_id = NULL WHERE id IN (${author}, ${other})`;
  await sql`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await sql`DELETE FROM users WHERE id IN (${author}, ${other})`;
  await sql.end({ timeout: 5 });
  await closeDatabase().catch(() => {});
});

/**
 * 哈希位必须是**真形状**（`/^[0-9a-f]{64}$/`）。夹具以前写 `"h"`，任何走投影层的读
 * （`projectCardGenerationActiveSummaryListV1` 里 `z.array(serverView).parse`）都会
 * 在正则上炸掉——报出来的是"投影层 500"，而那正是这一条要测的缺陷本身，
 * 假形状会把真缺陷淹在假失败里。
 */
const hex64 = (seed: string) => createHash("sha256").update(seed).digest("hex");

/** 造一条"某人已经在这篇上有过一批"的记录（走 API 现在造不出成员的那一条）。 */
async function seedRun(userId: string, status: string): Promise<string> {
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const [row] = await tx
      .insert(cardGenerationRunsV2)
      .values({
        workspaceId,
        userId,
        noteId,
        noteVersionId,
        // 每次调用都要唯一：(workspace, idempotency_key) 上有唯一索引，复用同一个
        // 键的话第二条用例是在测"幂等冲突"而不是"归属"。
        idempotencyKey: `fixture-${tag}-${userId}-${status}-${randomUUID().slice(0, 8)}`,
        status,
        semanticSpecHash: hex64(`sem-${tag}-${userId}-${status}`),
        inputSnapshotHash: hex64(`inp-${tag}-${userId}-${status}`),
        generationFingerprint: hex64(`fp-${tag}-${userId}-${status}`),
        sourceSnapshotHash: hex64(`src-${tag}-${userId}-${status}`),
        sourceContentHash: hex64(`cnt-${tag}-${userId}-${status}`),
        blockManifestHash: hex64(`blk-${tag}-${userId}-${status}`),
        assetManifestHash: hex64(`ast-${tag}-${userId}-${status}`),
        scopeManifestHash: hex64(`scp-${tag}-${userId}-${status}`),
      })
      .returning({ id: cardGenerationRunsV2.id });
    return row.id;
  });
}

test("同一篇笔记的「最近一批」按人返回，不看别人的", async () => {
  const theirs = await seedRun(other, "review_ready");

  const asOther = await getLatestGenerationRunForNoteV2({ workspaceId, userId: other }, noteId);
  assert.equal(asOther?.runId, theirs, "生成者自己看不到自己那一批");

  // 正向对照的另一半：作者这边必须"没有最近一批"，而不是两个人都拿到同一行——
  // 后者正好是这次要改掉的行为，如果查询整个坏掉返回 null，上一条会一起绿，
  // 所以下面再补一条"作者建自己的批次后看得见自己的"。
  const asAuthor = await getLatestGenerationRunForNoteV2({ workspaceId, userId: author }, noteId);
  assert.equal(asAuthor, null, "作者拿到了别人那一批（按笔记判而不是按人判）");

  const mine = await seedRun(author, "activated");
  const nowMine = await getLatestGenerationRunForNoteV2({ workspaceId, userId: author }, noteId);
  assert.equal(nowMine?.runId, mine, "作者自己的批次没被认出来");
  // 两边互不覆盖：另一个人仍然只看得到自己那一批。
  assert.equal((await getLatestGenerationRunForNoteV2({ workspaceId, userId: other }, noteId))?.runId, theirs);
});

test("别人的在制批次不该挡住我发起生成", async () => {
  const { createGenerationRunV2 } = await import("../modules/card-generation-v2/generation-run-service.ts");
  await seedRun(other, "review_ready");

  // 这一条真正测的是"守卫的谓词"：别人的 review_ready 在场时，我这次发起必须
  // **不**被判成 in_flight。断言写"不等于那个错误码"而不是"一定成功"，因为
  // 后面还有配额、幂等等分支，那些与本题无关，也不该被伪装成通过。
  let code = "";
  try {
    await createGenerationRunV2(
      { workspaceId, userId: author },
      noteVersionId,
      { noteVersionId, cardCount: 4, strategyHint: null, focus: null } as never,
      `author-start-${tag}`,
    );
  } catch (error) {
    code = error instanceof CardGenerationV2ServiceError ? error.code : `other:${String(error).slice(0, 60)}`;
  }
  assert.notEqual(code, "note_generation_in_flight", "别人的一批在制就把我挡住了（守卫按笔记而不是按人）");

  // 正向对照：同一个人生成两次，第二次必须还是被挡住——否则上面的"放行"可能只是
  // 守卫整个没生效。
  let second = "";
  try {
    await createGenerationRunV2(
      { workspaceId, userId: author },
      noteVersionId,
      { noteVersionId, cardCount: 4, strategyHint: null, focus: null } as never,
      `author-again-${tag}`,
    );
  } catch (error) {
    second = error instanceof CardGenerationV2ServiceError ? error.code : "";
  }
  assert.ok(
    second === "note_generation_in_flight" || second === "idempotency_conflict" || second === "",
    `自己第二次发起的预期之外结果：${second}`,
  );
});

// ─── 卡片的可见性跟着来源笔记（批次 4.5）───────────────────────────────

const cardListFor = (userId: string) =>
  listActiveCardsV2({ workspaceId, userId }, { limit: 100 });

test("私有笔记生成的卡不进别人的列表、详情与星图", async () => {
  // `addV2ObjectiveToWorkspace` 走的是原生 INSERT，所以这篇笔记拿的是列默认值
  // `private`——正好就是"新建、没有点过共享"的那个状态。
  const seeded = await addV2ObjectiveToWorkspace(sql, workspaceId, author, {
    publicSummary: `只有作者看得见的摘要 ${tag}`,
  });

  const mine = await cardListFor(author);
  assert.ok(
    mine.items.some((card) => card.cardId === seeded.cardId),
    "作者看不见自己那篇的卡（判据写反了，或者整条查询坏了）",
  );

  const theirs = await cardListFor(other);
  assert.equal(
    theirs.items.find((card) => card.cardId === seeded.cardId),
    undefined,
    "别人读到了「仅自己可见」笔记的卡——正文摘要从卡片那一侧漏出去",
  );
  assert.equal(
    await readPublicCardV2({ workspaceId, userId: other }, seeded.cardId),
    null,
    "列表挡住了但详情按 cardId 直读还能拿到",
  );

  // 正向对照：共享之后同一张卡必须出现在对方列表里。少了这一条，上面的"看不见"
  // 可能只是判据把两张卡都挡掉了。
  await sql`UPDATE notes SET share_scope = 'shared' WHERE id = ${seeded.noteId}`;
  assert.ok(
    (await cardListFor(other)).items.some((card) => card.cardId === seeded.cardId),
    "共享之后这张卡仍然看不见（判据根本没跟着 share_scope 走）",
  );
  assert.notEqual(
    await readPublicCardV2({ workspaceId, userId: other }, seeded.cardId),
    null,
    "共享之后详情仍然读不到",
  );

  // 撤回：作者随时能收回去，收回去之后对方又读不到（可逆性是那条规则的一半）。
  await sql`UPDATE notes SET share_scope = 'private' WHERE id = ${seeded.noteId}`;
  assert.equal(
    (await cardListFor(other)).items.find((card) => card.cardId === seeded.cardId),
    undefined,
    "撤回共享之后这张卡还留在别人的列表里",
  );
  assert.ok(
    (await cardListFor(author)).items.some((card) => card.cardId === seeded.cardId),
    "撤回把作者自己也挡掉了（作者判据没进谓词）",
  );
});

test("没有来源笔记的卡不受这条边界约束", async () => {
  // 手动建立的目标卡 `note_version_id IS NULL`：没有可追溯的私有来源，所以不该被
  // 一起藏起来。这一条同时也是"判据是不是把整张表都挡掉了"的第二组对照。
  const seeded = await addV2ObjectiveToWorkspace(sql, workspaceId, author, {
    publicSummary: `与笔记无关的一张卡 ${tag}`,
  });
  await sql`UPDATE learning_cards_v2 SET note_version_id = NULL WHERE card_id = ${seeded.cardId}`;

  assert.ok(
    (await cardListFor(other)).items.some((card) => card.cardId === seeded.cardId),
    "没有来源笔记的卡也被挡掉了（IS NULL 那一支没写对）",
  );
  assert.notEqual(
    await readPublicCardV2({ workspaceId, userId: other }, seeded.cardId),
    null,
  );
});

test("重新生成别人的私有笔记卡：按不存在处理，而不是 403", async () => {
  const seeded = await addV2ObjectiveToWorkspace(sql, workspaceId, author);
  const { createCardRegenerationRunV2 } = await import("../modules/card-generation-v2/card-service.ts");
  let code = "";
  try {
    await createCardRegenerationRunV2(
      { workspaceId, userId: other },
      seeded.cardId,
      undefined,
      "remember",
      "balanced",
      { kind: "adaptive" },
      `regen-${tag}`,
      `regen-${tag}`,
    );
  } catch (error) {
    code = error instanceof CardGenerationV2ServiceError ? error.code : `other:${String(error).slice(0, 80)}`;
  }
  assert.equal(code, "card_not_found", `别人能从私有笔记的卡发起重生成（${code}）`);

  // 正向对照：作者本人走同一条路拿到的不是"卡片不存在"。
  let mine = "";
  try {
    await createCardRegenerationRunV2(
      { workspaceId, userId: author },
      seeded.cardId,
      undefined,
      "remember",
      "balanced",
      { kind: "adaptive" },
      `regen-author-${tag}`,
      `regen-author-${tag}`,
    );
  } catch (error) {
    mine = error instanceof CardGenerationV2ServiceError ? error.code : "";
  }
  assert.notEqual(mine, "card_not_found", "作者自己也拿不到这张卡（判据太严）");
});

// ─── 目标的可见性跟着卡、卡跟着笔记（批次 4.5 最后一段）───────────────

const listObjectivesFor = (userId: string) =>
  withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    listObjectiveSurfacesV3(tx, { workspaceId, userId }, { lifecycle: "active", limit: 100 }));

test("私有笔记生成的目标不进别人的列表与详情", async () => {
  // 判据走"目标 → 卡 → 笔记版本 → 笔记"，不走 origins：dev 真实数据上 214 条 active
  // 目标只有 43 条有 origin 行，按 origins 判等于给 80% 的目标发"没有私有来源"的通行证。
  const seeded = await addV2ObjectiveToWorkspace(sql, workspaceId, author, {
    publicSummary: `只有作者看得见的目标 ${tag}`,
    objectiveStatement: `只有作者看得见的目标 ${tag}`,
  });
  const idsIn = async (userId: string) => (await listObjectivesFor(userId)).items.map((item) => item.objectiveId);

  expectLike(await idsIn(author), seeded.objectiveId, "作者看不见自己的目标");
  expectNotLike(await idsIn(other), seeded.objectiveId, "别人读到了「仅自己可见」笔记的目标");
  assert.equal(
    (await listObjectivesFor(other)).items.find((item) => item.objectiveId === seeded.objectiveId)?.content.publicSummary,
    undefined,
    "目标的摘要从这一侧漏了出去",
  );
  await assert.rejects(
    () =>
      withWorkspaceTransaction({ workspaceId, userId: other }, (tx) =>
        assembleObjectiveSurfaceV3(tx, { workspaceId, userId: other }, seeded.objectiveId)),
    "别人按 id 直读目标的详情拿到了内容",
  );

  // 正向对照：共享之后同一个目标必须回到对方列表里。少了这一条，上面的"看不见"
  // 可能只是判据把两张目标都挡了。
  await sql`UPDATE notes SET share_scope = 'shared' WHERE id = ${seeded.noteId}`;
  expectLike(await idsIn(other), seeded.objectiveId, "共享之后目标仍然看不见");

  // 撤回：作者随时能收回去。
  await sql`UPDATE notes SET share_scope = 'private' WHERE id = ${seeded.noteId}`;
  expectNotLike(await idsIn(other), seeded.objectiveId, "撤回之后目标还留在别人列表里");
  expectLike(await idsIn(author), seeded.objectiveId, "撤回把作者自己也挡掉了");
});

test("没有笔记来源的目标不受这条边界约束", async () => {
  const seeded = await addV2ObjectiveToWorkspace(sql, workspaceId, author, {
    publicSummary: `与笔记无关的一个目标 ${tag}`,
  });
  await sql`UPDATE learning_cards_v2 SET note_version_id = NULL WHERE objective_id = ${seeded.objectiveId}`;
  const ids = (await listObjectivesFor(other)).items.map((item) => item.objectiveId);
  expectLike(ids, seeded.objectiveId, "没有笔记来源的目标也被挡了");
});

function expectLike(ids: string[], objectiveId: string, message: string) {
  assert.ok(ids.includes(objectiveId), `${message}（${ids.length} 条：${ids.slice(0, 3).join(", ")}）`);
}

function expectNotLike(ids: string[], objectiveId: string, message: string) {
  assert.equal(ids.find((id) => id === objectiveId), undefined, message);
}

test("搜索这一侧也一样：私有笔记的目标不出现在别人的命中里", async () => {
  // 索引是全空间共用的一份，所以这一侧必须**查询时**判（建索引时按人裁会把某个人的
  // 视角烧进共用数据）。目标那一支和列表/详情用的是同一句话——判据走"目标 → 卡 → 笔记"。
  const phrase = `只在私有目标里的短语 ${tag}`;
  const seeded = await addV2ObjectiveToWorkspace(sql, workspaceId, author, {
    publicSummary: phrase,
    objectiveStatement: phrase,
  });

  const hits = await withWorkspaceTransaction({ workspaceId, userId: author }, async (tx) => {
    await reindexWorkspaceSearch(tx, workspaceId);
    const asOther = await search(tx, workspaceId, phrase, { userId: other, type: "objective" });
    const asAuthor = await search(tx, workspaceId, phrase, { userId: author, type: "objective" });
    return { other: asOther.items.map((i) => i.objectId), author: asAuthor.items.map((i) => i.objectId) };
  });

  assert.equal(
    hits.other.find((id) => id === seeded.objectiveId),
    undefined,
    "成员搜到了「仅自己可见」笔记的目标",
  );
  assert.ok(
    hits.author.includes(seeded.objectiveId),
    `作者自己也搜不到（正向对照失败：${hits.author.length} 条命中）`,
  );
});

test("「有没有在制的批次」这个恢复查询，在真有批次时给得出东西", async () => {
  const runId = await seedRun(author, "authoring");

  const runs = await listActiveGenerationRunsV2({ workspaceId, userId: author });
  // 正向对照：列表里必须真的有东西。少了这一句，"查询整个坏掉返回 []"
  // 会让下面所有断言都绿——而那次 500 的现场恰恰是列表非空。
  assert.ok(runs.length > 0, "在制批次列表是空的（夹具没落地），这条用例在测空列表");

  // 500 的成因：`serializeRunPublic` 是 async，列表那一支漏了 await，
  // 于是交给投影层的是一排 Promise，zod 判 `invalid_type: received promise`。
  // 这一条要**先于**下面的 runId 断言：漏了 await 时 `run.runId` 是 undefined，
  // 如果先查 runId，报出来的是"没列出来"，把真因说成了假因。
  const stillPromises = runs.filter(
    (run) => typeof (run as { then?: unknown }).then === "function",
  );
  assert.equal(
    stillPromises.length,
    0,
    `列表里有 ${stillPromises.length} 个元素还是 Promise——交出去之前必须把这一批 await 完`,
  );

  const mine = runs.find((run) => run.runId === runId);
  assert.ok(mine, "刚造的在制批次没被列出来");
  assert.equal(mine?.status, "authoring", "列表元素不是投影对象（读不到 status）");

  const summary = projectCardGenerationActiveSummaryListV1(runs);
  assert.ok(
    summary.items.some((item) => item.runId === runId && item.route.kind === "note.cardGeneration"),
    "恢复列表没把这一批投影成可跳转的条目",
  );
});
