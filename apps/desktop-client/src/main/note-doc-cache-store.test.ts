import { mkdtemp, rm, stat as statFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  FileNoteDocCacheStore,
  MemoryNoteDocCacheStore,
  NOTE_DOC_PENDING_LIMIT,
  type NoteDocCacheEntryV1,
  type NoteDocCacheKey,
} from "./note-doc-cache-store.ts";

const SUBJECT = randomUUID();
const WORKSPACE = randomUUID();
const NOTE = randomUUID();
const OTHER_SUBJECT = randomUUID();
const OTHER_WORKSPACE = randomUUID();

const key = (over: Partial<NoteDocCacheKey> = {}): NoteDocCacheKey => ({
  subjectId: SUBJECT,
  workspaceId: WORKSPACE,
  noteId: NOTE,
  ...over,
});

const entry = (over: Partial<NoteDocCacheEntryV1> = {}): NoteDocCacheEntryV1 => ({
  docState: "GIVERAIAggISAEugEIggEiuAQ=",
  pending: ["kQQBoAEKYAAAAAAAAAAAAAA="],
  revision: 4,
  savedAt: "2026-09-21T00:00:00.000Z",
  shareScope: "private",
  epochAtRest: 2,
  updatedAt: "2026-09-21T00:00:00.000Z",
  ...over,
});

describe("本机笔记文档缓存", () => {
  let dir = "";
  let filePath = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "note-doc-cache-"));
    filePath = join(dir, "note-doc-cache.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("跨重启回得来：写进去的那一份，换个实例读得到同一份", async () => {
    const store = new FileNoteDocCacheStore(filePath);
    expect(await store.set(key(), entry({ revision: 9 }))).toBe(true);

    const reopened = new FileNoteDocCacheStore(filePath);
    expect(await reopened.get(key())).toMatchObject({ revision: 9, pending: entry().pending });
  });

  it("内容是敏感的那一类：落盘文件必须是本人可读", async () => {
    const store = new FileNoteDocCacheStore(filePath);
    await store.set(key(), entry());
    const stat = await statFile(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("同一台机器上的另一个人拿不到别人的那一份", async () => {
    const store = new FileNoteDocCacheStore(filePath);
    await store.set(key(), entry({ savedAt: "A 的那一份" }));
    // 这条不是"设计上应该如此"的推演，是判据本身：subjectId 少一段，
    // 另一个账号就能把别人的私有笔记正文接回编辑器。
    expect(await store.get(key({ subjectId: OTHER_SUBJECT }))).toBeNull();
    expect(await store.get(key({ workspaceId: OTHER_WORKSPACE }))).toBeNull();
    expect((await store.get(key()))?.savedAt).toBe("A 的那一份");
  });

  it("坏文件等于本机没有这一份，不部分恢复", async () => {
    await writeFile(
      filePath,
      JSON.stringify({ version: 2, entries: [{ ...key(), ...entry(), docState: "不是 base64 !!!" }] }),
    );
    const store = new FileNoteDocCacheStore(filePath);
    expect(await store.get(key())).toBeNull();
  });

  it("上一版（数组形状）的那一份整机不接回来，哪怕它自己完全合法", async () => {
    // 这条管的是换形状留下的一次性风险：数组形状的 `docState` 是新内核眼里的**空正文**，
    // 接回编辑器 → 用户接着打字 → 服务端按 fragment 投影 → 那一版的 `note_blocks` 行被清空。
    // 所以判据必须是版本，不能是"能不能解"——下面这份是合法 base64、字段齐全的一份旧数据。
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, entries: [{ ...key(), ...entry({ savedAt: "数组形状那一份" }) }] }),
    );
    const store = new FileNoteDocCacheStore(filePath);
    expect(await store.get(key())).toBeNull();
    // 同一个文件位置一旦被新版本写过，旧的那一份就再也回不来（不是"读到一半混着用"）。
    expect(await store.set(key(), entry({ savedAt: "新形状那一份" }))).toBe(true);
    const reopened = new FileNoteDocCacheStore(filePath);
    expect((await reopened.get(key()))?.savedAt).toBe("新形状那一份");
  });

  it("一份大到不该占缓存时明说不收，而不是截断正文", async () => {
    const store = new MemoryNoteDocCacheStore();
    const huge = "A".repeat(2_100_000);
    expect(await store.set(key(), entry({ docState: huge }))).toBe(false);
    expect(await store.get(key())).toBeNull();
  });

  it("超出条数先放下最旧的那一篇，常用的留在原地", async () => {
    const store = new MemoryNoteDocCacheStore();
    for (let i = 0; i <= 48; i += 1) {
      await store.set(key({ noteId: randomUUID() }), entry({
        updatedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        savedAt: `#${i}`,
      }));
    }
    const snapshot = store.snapshot();
    expect(snapshot.length).toBeLessThanOrEqual(48);
    expect(snapshot.some((row) => row.savedAt === "#48")).toBe(true);
    expect(snapshot.some((row) => row.savedAt === "#0")).toBe(false);
  });

  it("退出这个空间 / 换账号时那一段一起清掉", async () => {
    const store = new FileNoteDocCacheStore(filePath);
    const otherNote = randomUUID();
    await store.set(key(), entry());
    await store.set(key({ workspaceId: OTHER_WORKSPACE, noteId: otherNote }), entry());
    await store.clearWorkspace(SUBJECT, WORKSPACE);
    expect(await store.get(key())).toBeNull();
    expect(await store.get(key({ workspaceId: OTHER_WORKSPACE, noteId: otherNote }))).not.toBeNull();

    await store.clearSubject(SUBJECT);
    expect(await store.get(key({ workspaceId: OTHER_WORKSPACE, noteId: otherNote }))).toBeNull();
  });

  it("待发改量的上限与主进程那道同一个数", async () => {
    const store = new MemoryNoteDocCacheStore();
    expect(await store.set(key(), entry({ pending: Array.from({ length: NOTE_DOC_PENDING_LIMIT }, () => "kQBo") }))).toBe(true);
    await expect(store.set(key(), entry({
      pending: Array.from({ length: NOTE_DOC_PENDING_LIMIT + 1 }, () => "kQBo"),
    }))).rejects.toThrow();
  });
});
