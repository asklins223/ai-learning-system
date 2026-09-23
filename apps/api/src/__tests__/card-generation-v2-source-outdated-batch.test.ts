import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeSourceOutdatedForRunsV2 } from "../modules/card-generation-v2/helpers.ts";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";

/**
 * `computeSourceOutdatedForRunsV2` 是 0269/H5 那批改动的核心：列表端点以前逐行调
 * `checkSourceOutdated`，每行都要把源笔记的**全部正文**搬回来重算一次 hash，而一批 run
 * 常常共用同一篇笔记。这里锁两件事：
 *
 *   ① 判据与逐行版一致（版本变了 / 正文变了 / 没变 / 笔记看不见）；
 *   ② 往返次数不再随行数增长——这才是这次改的目的。少了 ② 的断言，"改成批量"这件事
 *      在这个文件里没有任何东西会因为它退化而变红。
 */

const WS = "11111111-1111-1111-1111-111111111111";
const NOTE = "22222222-2222-2222-2222-222222222222";

type RunRow = {
  id: string;
  workspaceId: string;
  userId: string;
  noteId: string;
  noteVersionId: string;
  sourceContentHash: string;
};

function makeFixture(args: {
  notes: ReadonlyArray<{ id: string; workspaceId: string; currentVersionId: string | null; visibleTo: string }>;
  blocks: ReadonlyArray<{ versionId: string; ordinal: number; content: string }>;
}) {
  const calls = { notes: 0, blocks: 0, noteReads: new Set<string>(), blockVersions: new Set<string>() };
  const tx = {
    query: {
      notes: {
        findMany: async ({ where }: { where: unknown }) => {
          calls.notes += 1;
          // 这里不解释 SQL：可见性由 `visibleNotesCondition(userId)` 决定，测试用
          // `visibleTo` 模拟它的结果——每次读只返回"这次读的用户看得见"的那些行。
          const userId = readUserIdFromWhere(where);
          return args.notes
            .filter((note) => note.visibleTo === userId)
            .map((note) => {
              calls.noteReads.add(`${note.workspaceId}|${userId}|${note.id}`);
              return { id: note.id, currentVersionId: note.currentVersionId };
            });
        },
      },
      noteBlocks: {
        findMany: async () => {
          calls.blocks += 1;
          return [...args.blocks]
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((block) => {
              calls.blockVersions.add(block.versionId);
              return { versionId: block.versionId, content: block.content };
            });
        },
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { tx: tx as any, calls };
}

/** 从 Drizzle 的 `and(...)` 片段里捞出本次读的 actor（`visibleNotesCondition` 带的 userId）。 */
function readUserIdFromWhere(node: unknown, depth = 0): string | null {
  if (node === null || node === undefined || depth > 14) return null;
  if (typeof node === "object" && "value" in node) {
    const value = (node as { value: unknown }).value;
    if (typeof value === "string" && /^u-\d+$/.test(value)) return value;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = readUserIdFromWhere(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === "object" && "queryChunks" in node) {
    return readUserIdFromWhere((node as { queryChunks: unknown }).queryChunks, depth + 1);
  }
  return null;
}

function run(overrides: Partial<RunRow>): RunRow {
  return {
    id: "run-1",
    workspaceId: WS,
    userId: "u-1",
    noteId: NOTE,
    noteVersionId: "v-1",
    sourceContentHash: hashCanonicalV2("card-generation-v2/source-content", { blockContents: "a\nb\nc" }),
    ...overrides,
  };
}

describe("computeSourceOutdatedForRunsV2", () => {
  it("版本没变、正文一致时判成不过时", async () => {
    const { tx } = makeFixture({
      notes: [{ id: NOTE, workspaceId: WS, currentVersionId: "v-1", visibleTo: "u-1" }],
      blocks: [
        { versionId: "v-1", ordinal: 0, content: "a" },
        { versionId: "v-1", ordinal: 1, content: "b" },
        { versionId: "v-1", ordinal: 2, content: "c" },
      ],
    });
    const result = await computeSourceOutdatedForRunsV2(tx, [run({})]);
    assert.equal(result.get("run-1"), false);
  });

  it("版本 id 变了直接判过时，不必再读正文", async () => {
    const { tx, calls } = makeFixture({
      notes: [{ id: NOTE, workspaceId: WS, currentVersionId: "v-9", visibleTo: "u-1" }],
      blocks: [],
    });
    const result = await computeSourceOutdatedForRunsV2(tx, [run({ noteVersionId: "v-1" })]);
    assert.equal(result.get("run-1"), true);
    assert.equal(calls.blocks, 0, "版本已变，没必要再搬正文");
  });

  it("版本 id 没变但正文被原地改写时判过时（自动保存就是原地改写）", async () => {
    const { tx } = makeFixture({
      notes: [{ id: NOTE, workspaceId: WS, currentVersionId: "v-1", visibleTo: "u-1" }],
      blocks: [
        { versionId: "v-1", ordinal: 0, content: "a" },
        { versionId: "v-1", ordinal: 1, content: "改写后的第二段" },
        { versionId: "v-1", ordinal: 2, content: "c" },
      ],
    });
    const result = await computeSourceOutdatedForRunsV2(tx, [run({})]);
    assert.equal(result.get("run-1"), true);
  });

  it("笔记对这一位不可见时判成不过时（不能借列表身份探别人私有笔记的编辑节奏）", async () => {
    const { tx } = makeFixture({
      // visibleTo 是别人 → 本次读返回空行
      notes: [{ id: NOTE, workspaceId: WS, currentVersionId: "v-9", visibleTo: "u-2" }],
      blocks: [],
    });
    const result = await computeSourceOutdatedForRunsV2(tx, [run({})]);
    assert.equal(result.get("run-1"), false);
  });

  it("一批共用同一篇笔记的 run 只读一次正文，不再逐行搬整篇", async () => {
    const { tx, calls } = makeFixture({
      notes: [{ id: NOTE, workspaceId: WS, currentVersionId: "v-1", visibleTo: "u-1" }],
      blocks: [
        { versionId: "v-1", ordinal: 0, content: "a" },
        { versionId: "v-1", ordinal: 1, content: "b" },
        { versionId: "v-1", ordinal: 2, content: "c" },
      ],
    });
    const rows = Array.from({ length: 20 }, (_, index) => run({
      id: `run-${index}`,
      noteVersionId: index % 2 === 0 ? "v-1" : "v-0",
    }));
    const result = await computeSourceOutdatedForRunsV2(tx, rows);

    assert.equal(calls.notes, 1, "20 行只该有一次笔记读");
    assert.equal(calls.blocks, 1, "20 行只该有一次正文读（逐行版是 20 次）");
    assert.equal(result.size, 20);
    // v-0 的那一半：当前版本是 v-1，与 run 记的版本不同 → 过时。
    assert.equal(result.get("run-1"), true);
    assert.equal(result.get("run-0"), false);
  });

  it("同一篇笔记被两个用户各跑过一批时，按各自身份分别判可见性", async () => {
    const { tx, calls } = makeFixture({
      notes: [
        { id: NOTE, workspaceId: WS, currentVersionId: "v-9", visibleTo: "u-1" },
        { id: NOTE, workspaceId: WS, currentVersionId: "v-9", visibleTo: "u-2" },
      ],
      blocks: [],
    });
    const result = await computeSourceOutdatedForRunsV2(tx, [
      run({ id: "run-a", userId: "u-1" }),
      run({ id: "run-b", userId: "u-2" }),
      run({ id: "run-c", userId: "u-3" }), // 第三个人看不见这篇
    ]);

    assert.equal(calls.notes, 3, "每个 (空间,用户) 各一次读，不能合成一次放开可见性");
    assert.equal(result.get("run-a"), true);
    assert.equal(result.get("run-b"), true);
    assert.equal(result.get("run-c"), false);
  });
});
