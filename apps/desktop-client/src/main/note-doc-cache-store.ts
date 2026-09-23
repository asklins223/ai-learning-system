import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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

/**
 * 界面手里那一份**还没交给主进程**的草稿（刷新/崩溃不丢字）。
 *
 * 为什么另存一格而不是"反正 `docState` 里都有"：`docState` 是主进程那份影子文档的编码，
 * 而界面到主进程之间的那一段（编辑器里刚敲、自动保存的 1.2 秒还没到）从来不在它里面——
 * 渲染进程一刷新，那一段就没了。这一格装的就是那一段：一条合并过的 yjs 增量
 * （不是整份正文，也不是每次按键一条），界面重挂载时并回自己的文档。
 *
 * 只有**增量**才装得下这件事：正文存成文本就要在恢复时覆盖，而覆盖会抹掉对端在这期间
 * 写进来的字；增量是 CRDT 合并，对端写的部分一个字不动。
 */
export const noteDocDraftV1Schema = z.strictObject({
  update: base64Schema,
  /** 写这一份的时刻（本机钟）。只用于界面那句"什么时候的草稿"，不参与判据。 */
  savedAt: z.string(),
});

export type NoteDocDraftV1 = z.infer<typeof noteDocDraftV1Schema>;

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
  /**
   * 可选，而且**故意不进位格式版本**：`NOTE_DOC_CACHE_VERSION` 管的是既有字段换了
   * 含义（那一类必须整份作废，见下面那段注释），这里只是多一格，老文件没有它也照样
   * 解得出。反过来进位到 3 会把这台机器上攒着、还没交出去的离线编辑一起丢掉——为了
   * 一个可选字段付这个代价没有道理。
   */
  draft: noteDocDraftV1Schema.optional(),
});

export type NoteDocCacheEntryV1 = z.infer<typeof noteDocCacheEntryV1Schema>;

const storageEntrySchema = noteDocCacheEntryV1Schema.extend({
  subjectId: uuidSchema,
  workspaceId: uuidSchema,
  noteId: uuidSchema,
});

/**
 * 本机那份缓存的**格式版本，只此一处**：读的那道 schema 与写出去的那次 `parse` 都用它。
 *
 * `2` = `docState` / `pending` 里是 `Y.XmlFragment` 那份形状的编码（批次 C）。
 * 为什么必须进位而不是"能解就算"：数组形状的那一份解出来是 `blocks` 这个 Y.Array，
 * 新内核读 `content` 这个 XmlFragment 得到**空正文**。接回编辑器的后果不是显示为空，
 * 是用户接着打字之后，主进程把这份文档交出去、服务端按 fragment 投影，把那一版的
 * `note_blocks` 行**清空**。所以旧的那一份在这里必须当"本机没有"，不能逐条兼容。
 * 代价照实说：换形状之前攒在这台机器上、还没交出去的编辑会丢——而那些增量本来也
 * 不能安全地交出去。
 *
 * 文件名里原来还嵌着一个 `v1`（`note-doc-cache-v1.json`），与这个数是两处说法、迟早打架；
 * 去掉之后还发现读与写各有一份字面量（进位时只改了一处，结果写出去的文件自己读不回来，
 * 五条用例当场红）。所以：**进位只改这一行**。
 */
export const NOTE_DOC_CACHE_VERSION = 2;

const storageSchema = z.strictObject({
  version: z.literal(NOTE_DOC_CACHE_VERSION),
  entries: z.array(storageEntrySchema).max(ENTRY_LIMIT * 2),
});

type Storage = z.infer<typeof storageSchema>;

export type NoteDocCacheKey = { subjectId: string; workspaceId: string; noteId: string };

export interface NoteDocCacheStore {
  get(key: NoteDocCacheKey): Promise<NoteDocCacheEntryV1 | null>;
  /** 返回 false = 这一份大到不该占本机缓存（不静默截断正文，直接不收）。 */
  set(key: NoteDocCacheKey, entry: NoteDocCacheEntryV1): Promise<boolean>;
  getDraft(key: NoteDocCacheKey): Promise<NoteDocDraftV1 | null>;
  /**
   * 写草稿。返回 false = 没有可挂的那一条（本机还没有这一篇的文档）或这一份太大。
   *
   * **不凭空造条目**：草稿是"本机那一份文档里还没交出去的部分"，而那一份必须有一个
   * 来自服务端的祖先（见 `desktop-gateway.ts` 的 `restoreNoteDocLocal`）。没有祖先的
   * 一份草稿接回编辑器，就是拿一棵没有共同历史的文档树去改服务端那篇——一改就复制块。
   */
  setDraft(key: NoteDocCacheKey, draft: NoteDocDraftV1): Promise<boolean>;
  /** 返回 true = 本来有、这次清掉了。**确认交出去之后**每一次都会调它，所以"本来就没有" */
  /** 这条要能廉价地回答（落盘那一层据此跳过整份重写）。 */
  clearDraft(key: NoteDocCacheKey): Promise<boolean>;
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
    // 落盘本机文档那一次**不顺手抹掉草稿**：草稿是"界面还没交给主进程的那几个操作"，
    // 与 `docState` 是两条时间线。打开一篇笔记时先读起点、再读草稿，两次 IPC 谁先到
    // 不确定；这里若把草稿一起换掉，抢在前面到的那一次就把要恢复的东西删了。
    // 清草稿只有一条路：`clearDraft`（确认交出去之后）。
    const draft = this.entries.get(id)?.entry.draft;
    const next = draft && parsed.draft === undefined ? { ...parsed, draft } : parsed;
    this.entries.set(id, { key, entry: next });
    // 超出条数就先放下最旧的那一份：常用的那几篇才会不断被刷新 `updatedAt`。
    if (this.entries.size > ENTRY_LIMIT) {
      const oldest = [...this.entries.entries()].sort((a, b) =>
        a[1].entry.updatedAt.localeCompare(b[1].entry.updatedAt))[0];
      if (oldest && oldest[0] !== id) this.entries.delete(oldest[0]);
    }
    return true;
  }

  async getDraft(key: NoteDocCacheKey): Promise<NoteDocDraftV1 | null> {
    return this.entries.get(entryKey(key))?.entry.draft ?? null;
  }

  async setDraft(key: NoteDocCacheKey, draft: NoteDocDraftV1): Promise<boolean> {
    const id = entryKey(key);
    const existing = this.entries.get(id);
    if (!existing) return false;
    const parsed = noteDocDraftV1Schema.parse(draft);
    const entry: NoteDocCacheEntryV1 = { ...existing.entry, draft: parsed, updatedAt: draft.savedAt };
    if (JSON.stringify(entry).length > SINGLE_ENTRY_MAX_BYTES) return false;
    this.entries.set(id, { key: existing.key, entry });
    return true;
  }

  async clearDraft(key: NoteDocCacheKey): Promise<boolean> {
    const id = entryKey(key);
    const existing = this.entries.get(id);
    if (!existing || existing.entry.draft === undefined) return false;
    const { draft: _dropped, ...entry } = existing.entry;
    this.entries.set(id, { key: existing.key, entry });
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
        await this.pruneStaleTempFiles();
      })();
    }
    await this.loaded;
  }

  /**
   * 收掉历史上带 uuid 的孤儿临时文件（`<file>.<uuid>.tmp`）。固定名之后新流程不会
   * 再造孤儿，但改法之前留下的那些每人最多 12 MB，没人清就永远躺在 userData 里。
   * 清失败不影响任何读写路径，所以只吞异常、不打日志刷屏。
   */
  private async pruneStaleTempFiles(): Promise<void> {
    try {
      const dir = dirname(this.filePath);
      const base = basename(this.filePath);
      const names = await readdir(dir);
      await Promise.all(
        names
          .filter((name) => name.startsWith(`${base}.`) && name.endsWith(".tmp") && name !== `${base}.tmp`)
          .map((name) => rm(join(dir, name), { force: true })),
      );
    } catch {
      // 目录还不存在 = 从来没写过缓存，本来就没得清。
    }
  }

  private flush(): Promise<void> {
    // 写入、清理、切空间可能并发；把"整份快照 + 改名"排队，旧的临时文件永远
    // 赢不了最后一次改名。
    const write = this.flushQueue.then(async () => {
      const entries = this.memory.snapshot();
      /**
       * 这里以前是 `storageSchema.parse({version, entries})`——把**全部**条目再深度校验
       * 一遍（含每条的 base64 正则）。但每一条都是走过 `MemoryNoteDocCacheStore.set` 的
       * `noteDocCacheEntryV1Schema.parse`（:160）或 `load` 的整份校验（:234）才进到内存的，
       * 所以这一次是纯粹的重复劳动，而它按"每次自动保存一遍整库"计费（草稿 600ms、
       * 自动保存 1200ms 各戳一次，额度是 48 条 × 2 MB）。
       * 深度校验摘掉，只留这条 O(1) 的上界守卫——原来那个 `.max()` 挡的就是这个数。
       */
      if (entries.length > ENTRY_LIMIT * 2) {
        throw new Error(`note-doc cache holds ${entries.length} entries, over the ${ENTRY_LIMIT * 2} bound`);
      }
      const payload: Storage = { version: NOTE_DOC_CACHE_VERSION, entries };
      await mkdir(dirname(this.filePath), { recursive: true });
      /**
       * 固定名（0269 轮 L8）：以前带 `randomUUID()`，进程在 writeFile 与 rename 之间被杀
       * 就留下一个孤儿 `.tmp`，最大可到 `FILE_MAX_BYTES`，而**没有任何地方**回收它们。
       * 固定名下最坏情况只有这一个文件、且下一次 flush 直接覆盖它；`ensureLoaded` 顺手
       * 清掉升级前那些带 uuid 的旧残留。
       */
      const temporaryPath = `${this.filePath}.tmp`;
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

  async getDraft(key: NoteDocCacheKey): Promise<NoteDocDraftV1 | null> {
    await this.ensureLoaded();
    return this.memory.getDraft(key);
  }

  async setDraft(key: NoteDocCacheKey, draft: NoteDocDraftV1): Promise<boolean> {
    await this.ensureLoaded();
    const written = await this.memory.setDraft(key, draft);
    if (written) await this.flush();
    return written;
  }

  async clearDraft(key: NoteDocCacheKey): Promise<boolean> {
    await this.ensureLoaded();
    const cleared = await this.memory.clearDraft(key);
    // 本来就没有的那一次不重写整份文件：确认提交之后每一次都会走到这里。
    if (cleared) await this.flush();
    return cleared;
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
