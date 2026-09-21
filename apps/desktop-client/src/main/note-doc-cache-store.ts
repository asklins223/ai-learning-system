import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * 一篇笔记在这台电脑上的那一份文档（决定 7：断网也要能编辑）。
 *
 * 为什么必须有落盘：主进程那份 `Y.Doc` 与"还没交出去的增量"活在内存里，重启即归零。
 * 于是"断网可编辑"实际只在**这一次运行**里成立——合上盖子再打开，改的东西就没了，
 * 而界面上一句"已记在本机"说得理直气壮。这一层就是让那句话重新变成真的。
 *
 * **键里没有 epoch，这是与方案里那句「缓存键 (workspaceId, epoch, noteId)」的一处
 * 有意偏离**：`workspaceEpoch` 是主进程自己的计数（`desktop-gateway.ts` 里
 * `private workspaceEpoch = 1`，切空间 +1），重启就回到 1。拿它当持久身份有两个
 * 后果，两个都坏：① 上一次运行攒在 epoch 3 的东西，重启后按 epoch 1 永远读不到，
 * 这个功能等于没做；② 反过来，两个不同空间各自走到 epoch 1 时能互相撞上，
 * 那正是批次 1 立这条键要防的"跨空间正文缝合"。所以持久身份用
 * `(subjectId, workspaceId, noteId)` 三段 uuid——空间边界由 epoch 在**进程内**判
 * （IPC 那道 `assertEpoch` 一直在判），跨重启的边界由 uuid 判。
 *
 * **subjectId 必须在键里**：这台机器上可能登过好几个账号，而笔记的正文按归属判可见
 * （批次 4.5：新建默认「仅自己可见」）。少了这一段，另一个人就能从同一份文件里
 * 读到别人的私有笔记正文——边界画在服务器上，却从本机磁盘漏出去。
 *
 * 这里存的是**内容**，不是元数据，所以：文件权限 0600、有条数与字节上限、
 * 解析不上一律当空（宁缺不复活未经校验的内容）。
 */

const uuidSchema = z.string().uuid();
/** base64 必须是"编码回去一模一样"的那一种，和 `note-doc-state.ts` 同一个口径。 */
const base64Schema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);

/** 与 `desktop-gateway.ts` 里 `NOTE_DOC_PENDING_MAX` 同一个数：两侧不能各说一套。 */
export const NOTE_DOC_PENDING_LIMIT = 200;
const ENTRY_LIMIT = 48;
const SINGLE_ENTRY_MAX_BYTES = 2_000_000;
const FILE_MAX_BYTES = 12_000_000;

export const noteDocCacheEntryV1Schema = z.strictObject({
  // 尺寸不在这里判（超长要的是"这一份不收"，不是抛错），但编码必须判：
  // 读回来的一份非法 base64 会让 `seed` 静默应用半条更新。
  docState: base64Schema,
  pending: z.array(base64Schema).max(NOTE_DOC_PENDING_LIMIT),
  revision: z.number().int().min(0),
  savedAt: z.string(),
  /** 最后一次看到的归属。离线打开时要照它决定建不建长连接，不能猜。 */
  shareScope: z.enum(["private", "shared"]),
  /** 进程内的 epoch，只用于诊断"这份是上一次哪一轮留下的"，不参与判据。 */
  epochAtRest: z.number().int().min(0),
  updatedAt: z.string(),
});

export type NoteDocCacheEntryV1 = z.infer<typeof noteDocCacheEntryV1Schema>;

const storageEntrySchema = noteDocCacheEntryV1Schema.extend({
  subjectId: uuidSchema,
  workspaceId: uuidSchema,
  noteId: uuidSchema,
});

const storageSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(storageEntrySchema).max(ENTRY_LIMIT * 2),
});

type Storage = z.infer<typeof storageSchema>;

export type NoteDocCacheKey = { subjectId: string; workspaceId: string; noteId: string };

export interface NoteDocCacheStore {
  get(key: NoteDocCacheKey): Promise<NoteDocCacheEntryV1 | null>;
  /** 返回 false = 这一份大到不该占本机缓存（不静默截断正文，直接不收）。 */
  set(key: NoteDocCacheKey, entry: NoteDocCacheEntryV1): Promise<boolean>;
  clearNote(key: NoteDocCacheKey): Promise<void>;
  clearWorkspace(subjectId: string, workspaceId: string): Promise<void>;
  clearSubject(subjectId: string): Promise<void>;
}

const entryKey = (key: NoteDocCacheKey): string =>
  `${uuidSchema.parse(key.subjectId)}:${uuidSchema.parse(key.workspaceId)}:${uuidSchema.parse(key.noteId)}`;

export class MemoryNoteDocCacheStore implements NoteDocCacheStore {
  private readonly entries = new Map<string, { key: NoteDocCacheKey; entry: NoteDocCacheEntryV1 }>();

  snapshot(): Storage["entries"] {
    return [...this.entries.values()].map(({ key, entry }) => ({ ...key, ...entry }));
  }

  load(entries: Storage["entries"]): void {
    for (const item of entries) {
      const { subjectId, workspaceId, noteId, ...entry } = item;
      this.entries.set(entryKey({ subjectId, workspaceId, noteId }), {
        key: { subjectId, workspaceId, noteId },
        entry,
      });
    }
  }

  async get(key: NoteDocCacheKey): Promise<NoteDocCacheEntryV1 | null> {
    return this.entries.get(entryKey(key))?.entry ?? null;
  }

  async set(key: NoteDocCacheKey, entry: NoteDocCacheEntryV1): Promise<boolean> {
    const parsed = noteDocCacheEntryV1Schema.parse(entry);
    const bytes = JSON.stringify(parsed).length;
    if (bytes > SINGLE_ENTRY_MAX_BYTES) return false;
    const id = entryKey(key);
    this.entries.set(id, { key, entry: parsed });
    // 超出条数就先放下最旧的那一份：常用的那几篇才会不断被刷新 `updatedAt`。
    if (this.entries.size > ENTRY_LIMIT) {
      const oldest = [...this.entries.entries()].sort((a, b) =>
        a[1].entry.updatedAt.localeCompare(b[1].entry.updatedAt))[0];
      if (oldest && oldest[0] !== id) this.entries.delete(oldest[0]);
    }
    return true;
  }

  async clearNote(key: NoteDocCacheKey): Promise<void> {
    this.entries.delete(entryKey(key));
  }

  async clearWorkspace(subjectId: string, workspaceId: string): Promise<void> {
    for (const [id, value] of [...this.entries]) {
      if (value.key.subjectId === subjectId && value.key.workspaceId === workspaceId) this.entries.delete(id);
    }
  }

  async clearSubject(subjectId: string): Promise<void> {
    for (const [id, value] of [...this.entries]) {
      if (value.key.subjectId === subjectId) this.entries.delete(id);
    }
  }
}

export class FileNoteDocCacheStore implements NoteDocCacheStore {
  private readonly memory = new MemoryNoteDocCacheStore();
  private loaded: Promise<void> | null = null;
  private flushQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          const raw = await readFile(this.filePath, "utf8");
          if (raw.length > FILE_MAX_BYTES) return;
          const parsed = storageSchema.safeParse(JSON.parse(raw) as unknown);
          // 解析不上就是"本机没有这一份"。不逐条挑、不部分恢复：那等于把一份没经过
          // 整体校验的正文接回编辑器。
          if (parsed.success) this.memory.load(parsed.data.entries);
        } catch {
          // 缺文件、坏 JSON 都走同一条：本机没有缓存。
        }
      })();
    }
    await this.loaded;
  }

  private flush(): Promise<void> {
    // 写入、清理、切空间可能并发；把"整份快照 + 改名"排队，旧的临时文件永远
    // 赢不了最后一次改名。
    const write = this.flushQueue.then(async () => {
      const payload = storageSchema.parse({ version: 1, entries: this.memory.snapshot() });
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(payload), { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    this.flushQueue = write.then(() => undefined, () => undefined);
    return write;
  }

  async get(key: NoteDocCacheKey): Promise<NoteDocCacheEntryV1 | null> {
    await this.ensureLoaded();
    return this.memory.get(key);
  }

  async set(key: NoteDocCacheKey, entry: NoteDocCacheEntryV1): Promise<boolean> {
    await this.ensureLoaded();
    const written = await this.memory.set(key, entry);
    if (written) await this.flush();
    return written;
  }

  async clearNote(key: NoteDocCacheKey): Promise<void> {
    await this.ensureLoaded();
    await this.memory.clearNote(key);
    await this.flush();
  }

  async clearWorkspace(subjectId: string, workspaceId: string): Promise<void> {
    await this.ensureLoaded();
    await this.memory.clearWorkspace(subjectId, workspaceId);
    await this.flush();
  }

  async clearSubject(subjectId: string): Promise<void> {
    await this.ensureLoaded();
    await this.memory.clearSubject(subjectId);
    await this.flush();
  }
}
