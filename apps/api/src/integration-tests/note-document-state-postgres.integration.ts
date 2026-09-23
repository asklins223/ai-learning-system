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
import * as Y from "yjs";
import postgres from "postgres";
import { type ApiTransaction } from "../db/client.ts";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import { checkpointNote, createNote, restoreNoteVersion } from "../modules/note/service.ts";
import { applyNoteDocUpdate, loadNoteDoc, persistNoteDoc, resolveNoteDocFlushTarget } from "../modules/note/document-state.ts";
import { importMarkdownNotes, prepareMarkdownImport } from "../modules/import/markdown-import-service.ts";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import {
  editFragmentBlockText,
  projectFragmentBlocks,
  readNoteTitle,
  restoreFragmentBlocksFrom,
  snapshotOf,
  writeFragmentBlocks,
  docFromSnapshot,
  setNoteTitle,
  type NoteDocBlock,
} from "../modules/note/doc-fragment.ts";

/**
 * 夹具/管理连接优先用**超级用户**那条（`DATABASE_URL`），被测的应用连接仍然是生产形状。
 *
 * `db/client.ts` 自己优先读 `DATABASE_URL_API`，所以 HTTP 与 service 层的读写照旧跑在
 * `ailearn_api`（NOBYPASSRLS）上——被验的东西没变。变的是这份夹具：它对 `note_versions`
 * 的原生写在没有 `app.workspace_id` 的连接上会被 RESTRICTIVE 守卫**当场拒绝**（
 * `sec01_v1_note_versions_tenant_guard`），而它还需要故意写进"note 属于 A、workspace_id 写成 B"
 * 这种 RLS 本来就禁止的行，去证明**组合外键**在挡（不是策略在挡）。
 * 另外两处 `SET LOCAL ROLE ailearn_api` 也只有超级用户登录才做得到。
 * 同一形状的理由见 `workspace-collab-postgres` 与 doc 34 §1.2 ②④。
 */
const databaseUrl = process.env.DATABASE_URL ?? process.env.DATABASE_URL_API;
if (!databaseUrl) {
  throw new Error("DATABASE_URL 未配置——笔记文档状态集成测试要求真实 Postgres");
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

/**
 * 与协同落盘走完全相同的一条路：读文档 → 改 → 挑一个能写的版本 → 投影。
 * 用例因此测的是生产那个落盘口，而不是测试自己现编的一套写法。
 */
async function flushNoteDocLikeCollaboration(
  tx: ApiTransaction,
  mutate: (doc: Y.Doc) => void,
): Promise<string> {
  const scope = { workspaceId, noteId, userId };
  const { doc } = await loadNoteDoc(tx, scope);
  try {
    doc.transact(() => mutate(doc));
    const flushed = await resolveNoteDocFlushTarget(tx, scope, doc);
    await persistNoteDoc(tx, scope, doc, flushed);
    return flushed;
  } finally {
    doc.destroy();
  }
}

/** 从某个起点分叉出一份增量（模拟两扇窗口各自的那一次提交）。 */
function diffFrom(base: Uint8Array, mutate: (doc: Y.Doc) => void): Uint8Array {
  const fork = docFromSnapshot(base);
  const stateVector = Y.encodeStateVector(fork);
  fork.transact(() => mutate(fork));
  const update = Y.encodeStateAsUpdate(fork, stateVector);
  fork.destroy();
  return update;
}

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
  // 只看**本夹具**的那几篇：整张表空不空不由这个文件负责——现在每一条新建笔记都会
  // 写一份快照（4.1 之后 `createNoteTx` 就落快照），并发跑的别的用例必然在这张表里有行。
  // 断言"我删干净了"才是这条的本意。
  const leftover = await sql`SELECT count(*)::int AS n FROM note_document_states WHERE note_id = ANY(${allNoteIds})`;
  assert.equal(Number(leftover[0].n), 0, `夹具残留了 ${leftover[0].n} 行文档状态`);
  await sql.end();
  await closeDatabase();
});

test("补齐无损：0244 之前建的笔记仍能从行里读出原文（迁移接缝）", async () => {
  // 4.1 之后新建的笔记一开始就有快照（createNoteTx 走文档入口），所以"没有快照"
  // 这个状态只能由历史数据构成：删掉快照行来代表 0244 之前建的笔记。
  await sql`DELETE FROM note_document_states WHERE note_id = ${noteId}`;
  const { doc, backfilled } = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    loadNoteDoc(tx, { workspaceId, noteId, userId }),
  );
  assert.equal(backfilled, true, "没有快照时必须从关系表补齐（新建笔记也一样，先删快照模拟历史数据）");
  assert.deepEqual(
    projectFragmentBlocks(doc).map(({ ordinal: _o, ...block }) => block),
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
    await applyNoteDocUpdate(tx, { workspaceId, noteId, userId }, versionId, (doc) => {
      writeFragmentBlocks(doc, next);
    });
  });

  const stored = await sql`SELECT revision FROM note_document_states WHERE note_id = ${noteId}`;
  assert.equal(stored.length, 1, "写入后必须有快照行");
  revisionAtStart = Number(stored[0].revision);
  assert.deepEqual(contentsOf(await blocksOfCurrentVersion()), contentsOf(next), "note_blocks 没跟上文档");

  // 必须在事务**提交之后**再读 revision：在同一个 withWorkspaceTransaction 里用另一个
  // 连接读，读到的是旧值（未提交），会假报"revision 没递增"。
  await withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    await applyNoteDocUpdate(tx, { workspaceId, noteId, userId }, versionId, (doc) => {
      writeFragmentBlocks(doc, [...next, { type: "paragraph", content: `又加一段 ${tag}` }]);
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
    loadNoteDoc(tx, { workspaceId, noteId, userId }),
  );
  assert.equal(reloaded.backfilled, false, "已有快照却仍从关系表补齐=两套事实源");
  assert.equal(projectFragmentBlocks(reloaded.doc).length, next.length + 1);
  reloaded.doc.destroy();
});

test("增量落盘之后：行、版本快照、标题与更新时间必须一起跟上", async () => {
  // 这条守的是自动保存改走文档增量之后的那一组投影。以前它们是 `updateNote` 按行写时
  // 顺手做的：那条路一停，任何一样没跟上都是一个**不报错**的错位——最狠的是版本快照
  // （恢复会退回改动之前），最显眼的是标题与列表排序。
  const current = await blocksOfCurrentVersion();
  const submitted = current.map((row, index) => ({
    type: row.type,
    content: index === 0 ? `${row.content}（这次是增量改的）` : row.content,
  }));
  const noteRow = async (): Promise<{ updatedAt: Date; title: string }> => {
    const rows = await sql`SELECT updated_at, title FROM notes WHERE id = ${noteId}`;
    // 不要 `new Date(String(date))`：那是秒级精度，两次落盘在同一年内根本比不出高低。
    return { updatedAt: rows[0].updated_at as Date, title: String(rows[0].title) };
  };
  const before = await noteRow();

  await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    flushNoteDocLikeCollaboration(tx, (doc) => editFragmentBlockText(doc, 0, submitted[0]!.content)),
  );

  const { doc, backfilled } = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    loadNoteDoc(tx, { workspaceId, noteId, userId }),
  );
  const fromDoc = projectFragmentBlocks(doc).map((block) => block.content);
  doc.destroy();
  assert.equal(backfilled, false, "已有快照却仍从关系表补齐=两套事实源");
  assert.deepEqual(fromDoc, submitted.map((block) => block.content), "文档没跟上这次提交（两套正文）");
  assert.deepEqual(
    (await blocksOfCurrentVersion()).map((row) => row.content),
    submitted.map((block) => block.content),
    "投影与文档分叉",
  );

  const after = await noteRow();
  assert.ok(
    after.updatedAt.getTime() > before.updatedAt.getTime(),
    "notes.updated_at 没跟着落盘走：改过的笔记不会排到列表前面，游标也停在旧位置",
  );

  // 版本的快照**不**跟着落盘走：那是它被提交当时的样子，也是「提交并确认」判断
  // "要不要再建一版"的依据。刷了它，历史就再也长不出来。
  const snapshot = await sql`SELECT content_json FROM note_versions WHERE id = ${versionId}`;
  const snapshotted = (snapshot[0].content_json as { blocks: Array<{ content: string }> }).blocks
    .map((block) => block.content);
  assert.notDeepEqual(
    snapshotted,
    submitted.map((block) => block.content),
    "落盘改了已有版本的快照：这一版不再是它自己被提交时的样子了",
  );
});

test("两个人各自改一块：两次增量都留下，块数不涨", async () => {
  // 这就是审查里那个缺陷的最终形态：原来两扇窗口拿着同一个版本指针各提交一次整篇，
  // 两边都过得检查，后写的把前写的原地覆盖掉且无从恢复。现在交的是**增量**，
  // 判据从"谁后写"变成"文档合成了什么"——覆盖这个动作在这条路上不存在。
  const { doc: baseDoc } = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    loadNoteDoc(tx, { workspaceId, noteId, userId }),
  );
  const base = snapshotOf(baseDoc);
  const blockCount = projectFragmentBlocks(baseDoc).length;
  baseDoc.destroy();

  const aText = `甲窗口这句 ${tag}`;
  const bText = `乙窗口这句 ${tag}`;
  const first = diffFrom(base, (doc) => editFragmentBlockText(doc, 0, aText));
  const second = diffFrom(base, (doc) => editFragmentBlockText(doc, 1, bText));
  assert.ok(first.byteLength > 0 && second.byteLength > 0, "分叉没产生增量，这条用例什么都没测");

  for (const update of [first, second]) {
    await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
      flushNoteDocLikeCollaboration(tx, (doc) => Y.applyUpdate(doc, update)),
    );
  }

  const contents = (await blocksOfCurrentVersion()).map((row) => row.content);
  assert.ok(contents.some((content) => content.includes(aText)), "甲的改动被覆盖了");
  assert.ok(contents.some((content) => content.includes(bText)), "乙的改动被覆盖了");
  assert.equal(contents.length, blockCount, "块数因为两次并发提交而增殖");
});

test("来源过期守卫：版本指针没变、正文改了，也要被判成过时", async () => {
  // `checkSourceOutdated` 原来只比版本指针。自动保存是原地改写版本行的（批次 4.1），
  // 指针一点不动，于是卡片明明是从改之前的正文生成的，却永远报告"来源没变"。
  const { checkSourceOutdated } = await import("../modules/card-generation-v2/helpers.ts");
  const pointer = await sql`SELECT current_version_id FROM notes WHERE id = ${noteId}`;
  const versionIdNow = String(pointer[0].current_version_id);
  const rows = await sql`
    SELECT content FROM note_blocks WHERE version_id = ${versionIdNow} ORDER BY ordinal
  `;
  const hashNow = hashCanonicalV2("card-generation-v2/source-content", {
    blockContents: rows.map((row) => String(row.content)).join("\n"),
  });

  const same = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    checkSourceOutdated(tx, workspaceId, userId, noteId, versionIdNow, hashNow),
  );
  assert.equal(same, false, "内容没改却说过时（正向对照，否则下面的断言毫无意义）");

  const changed = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    checkSourceOutdated(tx, workspaceId, userId, noteId, versionIdNow, "一个来自旧正文的 hash"),
  );
  assert.equal(changed, true, "版本 id 没变但正文变了，守卫必须看出来——这正是原地自动保存那条路");
});

test("恢复历史版本走同一入口：内容回到旧版且投影与文档一致", async () => {
  const before = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    loadNoteDoc(tx, { workspaceId, noteId, userId }),
  );
  const oldSnapshot = snapshotOf(before.doc);
  before.doc.destroy();

  await withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    await applyNoteDocUpdate(tx, { workspaceId, noteId, userId }, versionId, (doc) => {
      writeFragmentBlocks(doc, [{ type: "paragraph", content: `改得面目全非 ${tag}` }]);
    });
  });

  await withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    await applyNoteDocUpdate(tx, { workspaceId, noteId, userId }, versionId, (doc) => {
      restoreFragmentBlocksFrom(doc, oldSnapshot);
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
    loadNoteDoc(tx, { workspaceId, noteId, userId }),
  );
  const ownCount = projectFragmentBlocks(own.doc).length;
  own.doc.destroy();
  assert.ok(ownCount >= 5, `正向对照失败：owner 作用域只读到 ${ownCount} 块`);

  // 批次 4.5 之后加载器是"读不到就拒"，不是"读不到就给你一篇空的"：后者会让一次跨空间
  // 的写入悄悄落到别人的笔记上，而页面看上去一切正常。
  await assert.rejects(
    () => withWorkspaceTransaction({ workspaceId: otherWorkspaceId, userId: otherUserId }, (tx) =>
      loadNoteDoc(tx, { workspaceId: otherWorkspaceId, noteId, userId: otherUserId }),
    ),
    /note_doc_not_visible/,
    "跨空间补齐读到了别人的正文",
  );
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
      loadNoteDoc(tx, { workspaceId, noteId: item.note.id, userId }),
    );
    const projected = projectFragmentBlocks(doc);
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
    loadNoteDoc(tx, { workspaceId, noteId, userId }),
  );
  const contents = projectFragmentBlocks(doc).map((block) => block.content);
  doc.destroy();
  assert.deepEqual(contents, [historyContent], "指针切到旧版了，文档还是恢复前的正文（两套事实源）");
});

/**
 * 「提交并确认」= `checkpointNote`。它现在**不收正文**，内容取自文档。
 *
 * 这一条同时守两件事：
 *  - 版本确实按确认建立（不是每次自动保存都建一版）；
 *  - 建立时抄的是文档此刻，所以两个人各自改过的内容都会进那个快照——
 *    原来那种"提交方手里的整篇才是结果"的语义已经不存在。
 * 标题也一起看：它落在文档的 meta 与 `notes.title` 两处，只写一处就会分叉。
 */
test('「提交并确认」从文档抄快照：两人都改过的内容都在那一版里', async () => {
  const pointer = async (): Promise<string> =>
    String((await sql`SELECT current_version_id FROM notes WHERE id = ${noteId}`)[0].current_version_id);
  const rowsOf = async (vid: string): Promise<string[]> =>
    (await sql`SELECT content FROM note_blocks WHERE version_id = ${vid} ORDER BY ordinal`)
      .map((row) => String(row.content));

  const before = await pointer();
  const aText = `甲写的这一句 ${tag}`;
  const bText = `乙写的这一句 ${tag}`;
  const { doc: baseDoc } = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    loadNoteDoc(tx, { workspaceId, noteId, userId }),
  );
  const base = snapshotOf(baseDoc);
  const baseCount0 = projectFragmentBlocks(baseDoc).length;
  baseDoc.destroy();
  // 两个分叉故意做**不同形状**的动作：甲就地改第一块，乙在末尾加一块。
  // 只测"各改一块"的话，前面几条用例里的恢复会把块数改掉，索引就不存在了
  // （这条一开始就是这么假失败的）。
  const editInPlace = (text: string): Uint8Array => diffFrom(base, (doc) => {
    editFragmentBlockText(doc, 0, text);
  });
  const editAppend = (text: string): Uint8Array => diffFrom(base, (doc) => {
    writeFragmentBlocks(doc, [
      ...projectFragmentBlocks(doc).map(({ ordinal: _ordinal, ...block }) => ({
        type: block.type,
        content: block.content,
      })),
      { type: "paragraph", content: text },
    ]);
  });
  const baseCount = baseCount0;
  await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    flushNoteDocLikeCollaboration(tx, (doc) => Y.applyUpdate(doc, editInPlace(aText))));
  await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    flushNoteDocLikeCollaboration(tx, (doc) => Y.applyUpdate(doc, editAppend(bText))));

  const renamed = `确认时改的名 ${tag}`;
  const receipt = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    checkpointNote(tx, noteId, workspaceId, userId, { title: renamed, baseVersionId: before }),
  );
  assert.ok(receipt, "checkpoint 没有回执");
  const saved = await pointer();
  assert.notEqual(saved, before, "「提交并确认」应当建立一个新版本");

  const contents = await rowsOf(saved);
  assert.ok(contents.some((content) => content.includes(aText)), "确认的版本里没有甲的改动");
  assert.ok(contents.some((content) => content.includes(bText)), "确认的版本里没有乙的改动");
  assert.equal(contents.length, baseCount + 1, "确认的版本应当带上两人各自的改动");
  const snapshotted = (await sql`SELECT content_json FROM note_versions WHERE id = ${saved}`)[0]
    .content_json as { blocks: Array<{ content: string }> };
  assert.deepEqual(
    snapshotted.blocks.map((block) => block.content),
    contents,
    "版本快照与它自己的行不一致（恢复会给出另一份内容）",
  );

  const noteTitle = await sql`SELECT title, title_source FROM notes WHERE id = ${noteId}`;
  assert.equal(String(noteTitle[0].title), renamed, "回执里的标题没落到 notes.title");
  assert.equal(String(noteTitle[0].title_source), "manual");
  const { doc: afterDoc } = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    loadNoteDoc(tx, { workspaceId, noteId, userId }),
  );
  assert.equal(readNoteTitle(afterDoc)?.title, renamed, "标题没进文档 meta（下次按文档读会顶回去）");
  afterDoc.destroy();
});

test("只改标题不动正文：正文一个字都不许变", async () => {
  // 界面那一侧 `blocks` 是**缺省**而不是空数组：空数组的意思是"作者把正文删光了"。
  // 两者混成一个的话，改名就会清空整篇笔记——正是这一批要消灭的那类静默销毁。
  const before = await blocksOfCurrentVersion();
  await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    flushNoteDocLikeCollaboration(tx, (doc) => setNoteTitle(doc, "只改了名字", "manual")),
  );
  assert.deepEqual(
    (await blocksOfCurrentVersion()).map((row) => row.content),
    before.map((row) => row.content),
    "只改标题的提交动了正文",
  );
});
