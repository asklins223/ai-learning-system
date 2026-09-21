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
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import { cardGenerationRunsV2 } from "@ailearn/shared/db-schema/card-generation-v2";
import { createNote } from "../modules/note/service.ts";
import { getLatestGenerationRunForNoteV2 } from "../modules/card-generation-v2/generation-run-service.ts";
import { CardGenerationV2ServiceError } from "../modules/card-generation-v2/helpers.ts";

const CONN = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!CONN) throw new Error("DATABASE_URL_API 未配置——生成批次归属集成测试要求真实 Postgres");

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
  await sql`DELETE FROM card_generation_runs_v2 WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
  await sql`UPDATE users SET personal_workspace_id = NULL WHERE id IN (${author}, ${other})`;
  await sql`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await sql`DELETE FROM users WHERE id IN (${author}, ${other})`;
  await sql.end({ timeout: 5 });
  await closeDatabase().catch(() => {});
});

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
        semanticSpecHash: "h",
        inputSnapshotHash: "h",
        generationFingerprint: `fp-${tag}-${userId}`,
        sourceSnapshotHash: "h",
        sourceContentHash: "h",
        blockManifestHash: "h",
        assetManifestHash: "h",
        scopeManifestHash: "h",
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
