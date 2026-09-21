/**
 * `note_document_states` + 写入口的真实 Postgres 契约（批次 4.1）。
 *
 * 为什么必须是集成测试而不是单测：这个模块的每条承诺都由 DB 机制决定——补齐要读
 * 当前版本的 `note_blocks` 行、快照落盘要走 `ON CONFLICT` upsert、revision 要真的
 * 单调、跨空间不可见靠 RLS 而不是靠调用方记得带 WHERE、"note 属于 A 而 workspace_id
 * 写成 B"靠组合外键挡。这些在 mock 事务里全都不会发生。
 *
 * 用 `createNote` 造笔记而不是手写 INSERT：那能同时证明新写入口与现存写路径**当前**
 * 是兼容的（补齐必须读出真行），不是我单方面假设的形状。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import { createNote, restoreNoteVersion, updateNote } from "../modules/note/service.ts";
import { applyNoteDocUpdate, loadNoteDoc } from "../modules/note/document-state.ts";
import { importMarkdownNotes, prepareMarkdownImport } from "../modules/import/markdown-import-service.ts";
import {
  projectNoteBlocks,
  restoreNoteBlocksFrom,
  snapshotOf,
  writeNoteBlocks,
  type NoteDocBlock,
} from "../modules/note/doc.ts";

const databaseUrl = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL_API 未配置——笔记文档状态集成测试要求真实 Postgres");
}

const sql = postgres(databaseUrl, { max: 4 });
const tag = randomUUID().slice(0, 8);
const userId = randomUUID();
const otherUserId = randomUUID();
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();

let noteId = "";
let versionId = "";
/** 导入用例新建的笔记，teardown 要一起清。 */
const importedNoteIds: string[] = [];
/** 本用例开始时的 revision，用来断言"每次写都 +1"而不是猜绝对值。 */
let revisionAtStart = 0;

const original = [
  { type: "heading" as const, content: `补齐测试标题 ${tag}` },
  { type: "paragraph" as const, content: `第一段 ${tag}` },
  { type: "code" as const, content: `SELECT 1;\nSELECT 2; -- ${tag}` },
  { type: "paragraph" as const, content: `尾段 ${tag}` },
];

function contentsOf(blocks: Array<{ content: string }>): string[] {
  return blocks.map((block) => block.content);
}

async function blocksOfCurrentVersion(): Promise<Array<{ ordinal: number; type: string; content: string }>> {
  return sql`
    SELECT nb.ordinal, nb.type, nb.content
    FROM note_blocks nb
    JOIN note_versions nv ON nv.id = nb.version_id
    WHERE nv.note_id = ${noteId} AND nv.id = ${versionId}
    ORDER BY nb.ordinal
  `.then((rows) => rows.map((row) => ({
    ordinal: Number(row.ordinal),
    type: String(row.type),
    content: String(row.content),
  })));
}

before(async () => {
  await sql`
    INSERT INTO users (id, email, password_hash, role)
    VALUES
      (${userId}, ${`doc-state-owner-${tag}@example.test`}, 'test-hash', 'owner'),
      (${otherUserId}, ${`doc-state-other-${tag}@example.test`}, 'test-hash', 'owner')
  `;
  await sql`
    INSERT INTO workspaces (id, name, owner_id, workspace_type)
    VALUES
      (${workspaceId}, ${`doc-state-${tag}`}, ${userId}, 'personal'),
      (${otherWorkspaceId}, ${`doc-state-other-${tag}`}, ${otherUserId}, 'personal')
  `;
  await sql`
    INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
      (${workspaceId}, ${userId}, 'owner'),
      (${otherWorkspaceId}, ${otherUserId}, 'owner')
  `;

  const created = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    createNote(tx, workspaceId, userId, { title: `补齐测试标题 ${tag}`, blocks: original }),
  );
  if (!created) throw new Error("createNote 返回 null：笔记没有当前版本");
  noteId = created.note.id;
  versionId = created.version.id;
});

after(async () => {
  // 按外键依赖顺序删，且删完断言无残留：静默失败的 teardown 就是脏数据的来源。
  const allNoteIds = [noteId, ...importedNoteIds];
  await sql`DELETE FROM note_document_states WHERE note_id = ANY(${allNoteIds})`;
  await sql`DELETE FROM note_blocks WHERE version_id IN (SELECT id FROM note_versions WHERE note_id = ANY(${allNoteIds}))`;
  await sql`DELETE FROM note_versions WHERE note_id = ANY(${allNoteIds})`;
  await sql`DELETE FROM search_documents WHERE object_id = ANY(${allNoteIds})`;
  await sql`DELETE FROM notes WHERE id = ANY(${allNoteIds})`;
  await sql`UPDATE users SET personal_workspace_id = NULL WHERE id IN (${userId}, ${otherUserId})`;
  await sql`DELETE FROM workspace_members WHERE workspace_id IN (${workspaceId}, ${otherWorkspaceId})`;
  await sql`DELETE FROM workspaces WHERE id IN (${workspaceId}, ${otherWorkspaceId})`;
  await sql`DELETE FROM users WHERE id IN (${userId}, ${otherUserId})`;
  const leftover = await sql`SELECT count(*)::int AS n FROM note_document_states`;
  assert.equal(leftover[0].n, 0, `夹具残留了 ${leftover[0].n} 行文档状态`);
  await sql.end();
  await closeDatabase();
});

test("补齐无损：0244 之前建的笔记仍能从行里读出原文（迁移接缝）", async () => {
  // 4.1 之后新建的笔记一开始就有快照（createNoteTx 走文档入口），所以"没有快照"
  // 这个状态只能由历史数据构成：删掉快照行来代表 0244 之前建的笔记。
  await sql`DELETE FROM note_document_states WHERE note_id = ${noteId}`;
  const { doc, backfilled } = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    loadNoteDoc(tx, { workspaceId, noteId }),
  );
  assert.equal(backfilled, true, "没有快照时必须从关系表补齐（新建笔记也一样，先删快照模拟历史数据）");
  assert.deepEqual(
    projectNoteBlocks(doc).map(({ ordinal: _o, ...block }) => block),
    original.map((block) => ({ ...block })),
    "补齐丢块或改序，就等于在第一次读时悄悄改了用户的笔记",
  );
  doc.destroy();
});

test("写一次即成为事实源：快照落盘、投影回 note_blocks、revision 递增", async () => {
  const next: NoteDocBlock[] = [
    ...original.slice(0, 2).map((block) => ({ ...block })),
    { type: "paragraph", content: `新插入的一段 ${tag}` },
    ...original.slice(2).map((block) => ({ ...block })),
  ];

  await withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    await applyNoteDocUpdate(tx, { workspaceId, noteId }, versionId, (doc) => {
      writeNoteBlocks(doc, next);
    });
  });

  const stored = await sql`SELECT revision FROM note_document_states WHERE note_id = ${noteId}`;
  assert.equal(stored.length, 1, "写入后必须有快照行");
  revisionAtStart = Number(stored[0].revision);
  assert.deepEqual(contentsOf(await blocksOfCurrentVersion()), contentsOf(next), "note_blocks 没跟上文档");

  // 必须在事务**提交之后**再读 revision：在同一个 withWorkspaceTransaction 里用另一个
  // 连接读，读到的是旧值（未提交），会假报"revision 没递增"。
  await withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    await applyNoteDocUpdate(tx, { workspaceId, noteId }, versionId, (doc) => {
      writeNoteBlocks(doc, [...next, { type: "paragraph", content: `又加一段 ${tag}` }]);
    });
  });
  const second = await sql`SELECT revision FROM note_document_states WHERE note_id = ${noteId}`;
  assert.equal(
    Number(second[0].revision),
    revisionAtStart + 1,
    `第二次写必须把 revision 从 ${revisionAtStart} 推到 ${revisionAtStart + 1}，实际 ${second[0].revision}`,
  );

  // 重开一篇文档必须读到快照而不是关系表（backfilled=false 才是"事实源已切换"的证据）。
  const reloaded = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    loadNoteDoc(tx, { workspaceId, noteId }),
  );
  assert.equal(reloaded.backfilled, false, "已有快照却仍从关系表补齐=两套事实源");
  assert.equal(projectNoteBlocks(reloaded.doc).length, next.length + 1);
  reloaded.doc.destroy();
});

test("自动保存不再另起一套正文：写完行之后文档必须与投影一致", async () => {
  // 这条守的是本轮之前的状态：`updateVersionInPlace` 按行 UPDATE、绕开 Y.Doc。于是自动
  // 保存写完的那一刻快照还是旧内容，下一次按文档读（协同落盘、doc-state 取起点）就把
  // 刚保存的正文顶回去，而且不报错。
  const current = await blocksOfCurrentVersion();
  const submitted = current.map((row, index) => ({
    type: row.type as "paragraph" | "heading" | "code",
    content: index === 0 ? `${row.content}（自动保存改过）` : row.content,
  }));
  assert.equal(submitted.length, current.length, "块数没变才走得到自动保存那条逐块改写的路");

  await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    updateNote(tx, noteId, workspaceId, userId, {
      blocks: submitted,
      baseVersionId: versionId,
      isAutosave: true,
    }),
  );

  const { doc, backfilled } = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    loadNoteDoc(tx, { workspaceId, noteId }),
  );
  const fromDoc = projectNoteBlocks(doc).map((block) => block.content);
  doc.destroy();
  assert.equal(backfilled, false, "自动保存必须写快照，不该退回从行补齐");
  assert.deepEqual(fromDoc, submitted.map((block) => block.content), "文档没跟上自动保存（两套正文）");
  assert.deepEqual(
    (await blocksOfCurrentVersion()).map((row) => row.content),
    submitted.map((block) => block.content),
    "投影与文档分叉",
  );
});

test("恢复历史版本走同一入口：内容回到旧版且投影与文档一致", async () => {
  const before = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    loadNoteDoc(tx, { workspaceId, noteId }),
  );
  const oldSnapshot = snapshotOf(before.doc);
  before.doc.destroy();

  await withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    await applyNoteDocUpdate(tx, { workspaceId, noteId }, versionId, (doc) => {
      writeNoteBlocks(doc, [{ type: "paragraph", content: `改得面目全非 ${tag}` }]);
    });
  });

  await withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    await applyNoteDocUpdate(tx, { workspaceId, noteId }, versionId, (doc) => {
      restoreNoteBlocksFrom(doc, oldSnapshot);
    });
  });

  const rows = await blocksOfCurrentVersion();
  assert.ok(rows.some((row) => row.content.includes("新插入的一段")), "恢复没把旧内容带回来");
  assert.ok(!rows.some((row) => row.content.includes("面目全非")), "恢复后还留着被丢弃的内容");
});

/**
 * 两条互补的断言，缺一不可：
 *
 * A. **加载器必须自己带 workspace_id**。`notes` / `note_blocks` 的 RLS 还关着（本次
 *    审查的既有事实），所以跨空间不可见只能靠 WHERE；不写就是真漏，写错也是真漏。
 * B. **新表的 RLS 生效**。这条必须换角色跑：dev 连的是 `ailearn`（superuser +
 *    BYPASSRLS），策略对它形同不存在——同一个坑在 review_schedules 那条断言上踩过。
 */
test("加载器按空间收窄：陌生作用域读不到别人的正文", async () => {
  const own = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    loadNoteDoc(tx, { workspaceId, noteId }),
  );
  const ownCount = projectNoteBlocks(own.doc).length;
  own.doc.destroy();
  assert.ok(ownCount >= 5, `正向对照失败：owner 作用域只读到 ${ownCount} 块`);

  const foreign = await withWorkspaceTransaction({ workspaceId: otherWorkspaceId, userId: otherUserId }, (tx) =>
    loadNoteDoc(tx, { workspaceId: otherWorkspaceId, noteId }),
  );
  assert.equal(projectNoteBlocks(foreign.doc).length, 0, "跨空间补齐读到了别人的正文");
  foreign.doc.destroy();
});

test("note_document_states 的 RLS 真的在挡（换角色才测得出来）", async () => {
  const asOwner = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE ailearn_api`;
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return tx`SELECT state FROM note_document_states WHERE note_id = ${noteId}`;
  });
  assert.equal(asOwner.length, 1, "owner 作用域该读到自己那行快照");

  const asForeign = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE ailearn_api`;
    await tx`SELECT set_config('app.workspace_id', ${otherWorkspaceId}, true)`;
    return tx`SELECT state FROM note_document_states WHERE note_id = ${noteId}`;
  });
  assert.equal(asForeign.length, 0, "陌生作用域读到了别人的文档快照");

  // 用"改挂到陌生空间"而不是"再插一行"：这条笔记已经有快照了，插第二行会先撞主键，
  // 测不到组合外键。
  await assert.rejects(
    sql`
      UPDATE note_document_states SET workspace_id = ${otherWorkspaceId} WHERE note_id = ${noteId}
    `,
    /note_document_states_note_workspace_fk/,
    "组合外键必须挡住『note 属于 A、workspace_id 写成 B』的行",
  );
});

/**
 * 批次 4.1 的导入侧验收。
 *
 * 起因：`markdown-import-service` 的三个导出函数在本仓 **0 个测试**（`grep` 过
 * `src/__tests__` 与 `src/integration-tests` 都是 0 处调用），我把它的写行改成走
 * 文档之后，等于改了一条没人测过的路。这条用例就是补上那层——它同时是"导入确实
 * 拥有整篇"这个判断的证据：一次导入产出的块，必须与文档投影逐行相等。
 */
test("批量 Markdown 导入：每个新建笔记都有快照，且投影与解析出的块逐行相等", async () => {
  const items = [
    { title: `导入一 ${tag}`, content: `# 导入一 ${tag}\n\n正文段落\n\n\`\`\`ts\nconst a = 1;\nconst b = 2;\n\`\`\`\n` },
    { title: `导入二 ${tag}`, content: `第二段导入的开头\n\n- 列表项甲\n- 列表项乙\n` },
  ];

  // 走真实流程：prepare 在业务事务外解析 blocks（导入合同就是这么分的），
  // 直接塞 {title, content} 会绕过 prepared 形状、测到一条生产不走的路。
  const prepared = await prepareMarkdownImport({ workspaceId, userId }, items);
  const outcome = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    importMarkdownNotes(tx, { workspaceId, userId }, { items: prepared, importId: null }),
  );

  const notes = outcome.response.notes;
  assert.equal(notes.length, 2, `导入应产出 2 篇笔记，实际 ${notes.length}`);
  importedNoteIds.push(...notes.map((item) => item.note.id));

  for (const item of notes) {
    const stored = await sql`SELECT revision FROM note_document_states WHERE note_id = ${item.note.id}`;
    assert.equal(stored.length, 1, `笔记 ${item.note.id} 没有文档快照——写入没走文档入口`);
    assert.equal(Number(stored[0].revision), 1);

    const rows = await sql`
      SELECT nb.ordinal, nb.type, nb.content
      FROM note_blocks nb
      WHERE nb.version_id = ${item.version.id}
      ORDER BY nb.ordinal
    `;
    const { doc } = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
      loadNoteDoc(tx, { workspaceId, noteId: item.note.id }),
    );
    const projected = projectNoteBlocks(doc);
    doc.destroy();

    // 先确认不是"两边都空所以相等"这种假绿：这两篇每篇都该有多块。
    assert.ok(rows.length >= 2, `笔记 ${item.note.id} 只投影出 ${rows.length} 块，断言会变得空洞`);
    assert.equal(rows.length, projected.length, "投影行数与文档块数不一致");
    assert.deepEqual(
      rows.map((row) => String(row.content)),
      projected.map((block) => block.content),
      "note_blocks 与文档内容分叉：下一次读会看到两套正文",
    );
    // 代码块里的换行必须原样存在——导入路最容易在序列化时被压成一行。
    if (item.note.id === notes[0]!.note.id) {
      assert.ok(
        projected.some((block) => block.content.includes("const a = 1;\nconst b = 2;")),
        "代码块内的换行在文档往返中被吃掉",
      );
    }
  }
});

/**
 * 恢复历史版本的"文档要跟指针一起走"守卫。
 *
 * `restoreNoteVersion` 不重写块，它把 `currentVersionId` 指回旧版本——所以只要文档
 * 没跟着改，快照就还是恢复前的正文，而下一次读优先用快照，界面会拿到两套内容里的
 * 另一套。这条断言测的就是那个分叉。
 */
test("恢复历史版本后，文档快照与新的当前版本一致", async () => {
  const historyContent = `旧版正文 ${tag}`;
  const [older] = await sql`
    INSERT INTO note_versions (note_id, workspace_id, version_no, content_json, content_hash, created_by)
    VALUES (${noteId}, ${workspaceId}, 99, ${sql.json({ blocks: [{ type: "paragraph", content: historyContent }] })}, 'older-hash', ${userId})
    RETURNING id
  `;
  const olderId = String(older.id);
  await sql`
    INSERT INTO note_blocks (version_id, workspace_id, ordinal, type, content)
    VALUES (${olderId}, ${workspaceId}, 0, 'paragraph', ${historyContent})
  `;

  const current = await sql`SELECT current_version_id FROM notes WHERE id = ${noteId}`;
  await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    restoreNoteVersion(tx, noteId, olderId, workspaceId, userId, String(current[0].current_version_id)),
  );

  const after = await sql`SELECT current_version_id FROM notes WHERE id = ${noteId}`;
  assert.equal(String(after[0].current_version_id), olderId, "指针没切过去");

  const { doc } = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    loadNoteDoc(tx, { workspaceId, noteId }),
  );
  const contents = projectNoteBlocks(doc).map((block) => block.content);
  doc.destroy();
  assert.deepEqual(contents, [historyContent], "指针切到旧版了，文档还是恢复前的正文（两套事实源）");
});
