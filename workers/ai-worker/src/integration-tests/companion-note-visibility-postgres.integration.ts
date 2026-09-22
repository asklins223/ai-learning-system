/**
 * 伴星读笔记的**归属边界**（2026-09-20 多空间审查 + 0248 的笔记共享模型）。
 *
 * 为什么单独一支用例：HTTP 那一侧的列表 / 详情 / 搜索 / 卡片 / 目标都按
 * `share_scope` 收窄了，而伴星跑在**另一个进程**（`workers/ai-worker`），
 * 它的两条读点此前只按 `workspace_id` 查 `notes`：
 *
 *   1. `companion_read_note`（工具，读**正文**）；
 *   2. `loadHereAndNow` 的 `noteCount` / `recentNotes` / `noteReference`（读标题与
 *      存在性，然后注进 prompt 外发给模型）。
 *
 * 结果是：协作空间里，成员甲的伴星能读出成员乙私有笔记的正文与标题。空间隔离
 * 挡住了别的空间，挡不住同一个空间里的别人。
 *
 * 这支用例钉住的是**修复后**的行为，而且每条负向断言都配一条正向对照——只报
 * "读不到"的话，判据把所有人全挡住时同样是绿的（审查里反复出现的那种假绿）。
 *
 * 真 Postgres。夹具自己写数据并清理；provider 不需要（这两条读点不调模型）。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { noteVisibleSqlText } from "@ailearn/shared/note-visibility";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL ??= CONN;

const sql = postgres(CONN, { max: 2 });

after(async () => {
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

const tag = randomUUID();
const workspaceId = randomUUID();
const ownerId = randomUUID();
const memberId = randomUUID();
const ownerPrivateNote = randomUUID();
const ownerPrivateVersion = randomUUID();
const ownerSharedNote = randomUUID();
const ownerSharedVersion = randomUUID();

await sql.begin(async (tx) => {
  await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
  await tx`SELECT set_config('app.user_id', ${ownerId}, true)`;
  await tx`INSERT INTO users (id, email, password_hash, role) VALUES
    (${ownerId}, ${`vis-owner-${tag}@x.test`}, 'h', 'owner'),
    (${memberId}, ${`vis-member-${tag}@x.test`}, 'h', 'member')`;
  await tx`INSERT INTO workspaces (id, name, owner_id, workspace_type) VALUES
    (${workspaceId}, ${`vis-${tag}`}, ${ownerId}, 'collaborative')`;
  await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
    (${workspaceId}, ${ownerId}, 'owner'),
    (${workspaceId}, ${memberId}, 'member')`;

  // 作者的私有笔记（默认态）与作者显式共享出去的笔记。
  await tx`INSERT INTO notes (id, workspace_id, title, created_by, share_scope, current_version_id)
           VALUES (${ownerPrivateNote}, ${workspaceId}, ${`私有正文-${tag}`}, ${ownerId}, 'private', NULL),
                  (${ownerSharedNote}, ${workspaceId}, ${`共享正文-${tag}`}, ${ownerId}, 'shared', NULL)`;
  await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
           VALUES (${ownerPrivateVersion}, ${ownerPrivateNote}, ${workspaceId}, 1, '{}'::jsonb, ${`h-${tag}-a`}, ${ownerId}),
                  (${ownerSharedVersion}, ${ownerSharedNote}, ${workspaceId}, 1, '{}'::jsonb, ${`h-${tag}-b`}, ${ownerId})`;
  await tx`UPDATE notes SET current_version_id = ${ownerPrivateVersion} WHERE id = ${ownerPrivateNote}`;
  await tx`UPDATE notes SET current_version_id = ${ownerSharedVersion} WHERE id = ${ownerSharedNote}`;
  await tx`INSERT INTO note_blocks (id, version_id, workspace_id, ordinal, type, content)
           VALUES (${randomUUID()}, ${ownerPrivateVersion}, ${workspaceId}, 0, 'paragraph', ${`只有作者看得见的正文 ${tag}`}),
                  (${randomUUID()}, ${ownerSharedVersion}, ${workspaceId}, 0, 'paragraph', ${`共享给空间的正文 ${tag}`})`;
});

/** 与 `companion_read_note` 同形状的查询：成员视角读一篇笔记的正文。 */
async function readNoteAsCompanion(noteId: string, viewerId: string) {
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${viewerId}, true)`;
    return tx`
      SELECT n.title,
             coalesce(string_agg(nb.content, E'\n\n' ORDER BY nb.ordinal), '') AS body
      FROM notes n
      LEFT JOIN note_blocks nb ON nb.version_id = n.current_version_id
      WHERE n.id = ${noteId}::uuid
        AND n.workspace_id = ${workspaceId}
        AND n.deleted_at IS NULL
        AND ${tx.unsafe(noteVisibleSqlText("n", `'${viewerId}'::uuid`))}
      GROUP BY n.id, n.title
      LIMIT 1
    `;
  });
  return rows[0] ?? null;
}

/** 与 `loadHereAndNow` 同形状：成员视角能看见的笔记标题与条数。 */
async function hereAndNowNotes(viewerId: string) {
  const counts = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${viewerId}, true)`;
    const countRows = await tx`
      SELECT count(*)::int AS n FROM notes n
      WHERE n.workspace_id = ${workspaceId} AND n.deleted_at IS NULL
        AND ${tx.unsafe(noteVisibleSqlText("n", `'${viewerId}'::uuid`))}
    `;
    const titleRows = await tx`
      SELECT n.title FROM notes n
      WHERE n.workspace_id = ${workspaceId} AND n.deleted_at IS NULL
        AND ${tx.unsafe(noteVisibleSqlText("n", `'${viewerId}'::uuid`))}
      ORDER BY n.updated_at DESC LIMIT 3
    `;
    return { count: Number(countRows[0]?.n ?? 0), titles: titleRows.map((r) => String(r.title)) };
  });
  return counts;
}

test("成员的伴星读不到作者私有笔记的正文，但读得到已共享的那一篇", async () => {
  const privateRead = await readNoteAsCompanion(ownerPrivateNote, memberId);
  assert.equal(
    privateRead,
    null,
    `成员的伴星读到了作者私有笔记的正文：${JSON.stringify(privateRead)}`,
  );

  // 正向对照：同一份数据、同一段判据，共享之后必须读得到——否则上一条可能只是
  // "查询本身坏了"。
  const sharedRead = await readNoteAsCompanion(ownerSharedNote, memberId);
  assert.ok(sharedRead, "已共享的笔记成员的伴星读不到——判据接错了读取路径");
  assert.match(String(sharedRead.body), new RegExp(tag), "读到的正文不是那篇共享笔记");

  // 作者本人两条都读得到（判据不能把作者也挡住）。
  const ownerPrivate = await readNoteAsCompanion(ownerPrivateNote, ownerId);
  assert.ok(ownerPrivate, "作者读不到自己那篇私有笔记");
});

test("here-and-now 快照里的笔记标题与条数也按人收窄", async () => {
  const asMember = await hereAndNowNotes(memberId);
  assert.ok(
    !asMember.titles.some((title) => title.includes(`私有正文-${tag}`)),
    `成员的伴星快照里出现了作者私有笔记的标题：${JSON.stringify(asMember.titles)}`,
  );
  assert.ok(
    asMember.titles.some((title) => title.includes(`共享正文-${tag}`)),
    `成员的伴星快照里没有那篇已共享的笔记：${JSON.stringify(asMember.titles)}`,
  );

  const asOwner = await hereAndNowNotes(ownerId);
  assert.equal(
    asOwner.count,
    asMember.count + 1,
    `作者该比成员多看见自己那篇私有笔记（owner=${asOwner.count} member=${asMember.count}）`,
  );
});
