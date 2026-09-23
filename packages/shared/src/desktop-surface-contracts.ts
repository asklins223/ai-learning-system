/**
 * Renderer-safe read models for the desktop workspace surfaces.
 *
 * The API owns the source/note/objective/search/topology records. These
 * schemas intentionally keep the public fields needed by the desktop and
 * tolerate additive server fields so a surface can evolve without copying a
 * second, local data model into the renderer.
 */
import { z } from "zod";
import { noteBlockWriteV1Schema } from "./note-save-contracts.ts";

const isoTimestamp = z.string().datetime({ offset: true });
const uuid = z.string().uuid();

export const desktopSourceListItemSchema = z.object({
  id: uuid,
  workspaceId: uuid,
  type: z.enum(["text", "markdown", "code", "url"]),
  title: z.string().min(1).max(500),
  origin: z.string().nullable(),
  status: z.enum(["draft", "processing", "ready", "failed", "archived"]),
  createdBy: uuid,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  noteCount: z.number().int().min(0).default(0),
  /**
   * 学习卡进展（实走复盘 #18 后半）：来源行此前只能看出「有没有生成笔记」，
   * 看不出笔记有没有出卡。两个数都由服务端按 sourceId 批量聚合，界面不做推断。
   */
  cardProgress: z.object({
    /** 还在生成或等着审核的批次（含 review_ready）。 */
    pendingReviewRuns: z.number().int().min(0),
    /** 已经从这条来源出出来的、可作答的正式目标数。 */
    activeObjectives: z.number().int().min(0),
  }).default({ pendingReviewRuns: 0, activeObjectives: 0 }),
}).passthrough();
export type DesktopSourceListItem = z.infer<typeof desktopSourceListItemSchema>;

export const desktopSourceListPageSchema = z.object({
  items: z.array(desktopSourceListItemSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().min(0),
}).passthrough();
export type DesktopSourceListPage = z.infer<typeof desktopSourceListPageSchema>;

export const desktopSourceSegmentSchema = z.object({
  id: uuid,
  sourceId: uuid,
  workspaceId: uuid,
  ordinal: z.number().int().min(0),
  text: z.string(),
  charStart: z.number().int().min(0),
  charEnd: z.number().int().min(0),
  segmentType: z.string().min(1).max(80),
}).passthrough();
export type DesktopSourceSegment = z.infer<typeof desktopSourceSegmentSchema>;

export const desktopSourceDetailSchema = z.object({
  source: desktopSourceListItemSchema.extend({
    metadata: z.record(z.unknown()).nullable().optional(),
  }),
  segments: z.array(desktopSourceSegmentSchema),
}).passthrough();
export type DesktopSourceDetail = z.infer<typeof desktopSourceDetailSchema>;

/**
 * What the client sends to capture a new source.
 *
 * `type` and `title` are optional because the API detects both: an omitted type
 * is inferred from the payload and the parse job corrects it afterwards, and an
 * omitted title falls back to the URL or first line. Exactly one of `content`
 * and `url` has to carry the material.
 */
export const desktopSourceCreateRequestSchema = z
  .object({
    type: z.enum(["text", "markdown", "code", "url"]).optional(),
    title: z.string().max(500).optional(),
    content: z.string().optional(),
    url: z.string().url().optional(),
  })
  .refine(
    (value) => Boolean(value.url?.trim() || value.content?.trim()),
    { message: "url or content is required" },
  );
export type DesktopSourceCreateRequest = z.infer<typeof desktopSourceCreateRequestSchema>;

/**
 * Renaming a source is a title-only update: the status machine on the server
 * refuses client-set status, so a rename never changes parsing state.
 */
export const desktopSourceUpdateRequestSchema = z
  .object({ title: z.string().min(1).max(500) })
  .strict();
export type DesktopSourceUpdateRequest = z.infer<typeof desktopSourceUpdateRequestSchema>;

/**
 * The receipt for "start a note from this source".
 *
 * The API answers with the raw note and version rows, so the desktop keeps only
 * the two ids a surface needs to open the writer. A source that already produced
 * a note with identical content is not an error the reader has to decode: it is
 * the same receipt, marked as the existing note.
 */
export const desktopSourceNoteResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("created"),
    noteId: uuid,
    noteVersionId: uuid,
    title: z.string(),
  }),
  z.object({
    kind: z.literal("duplicate"),
    noteId: uuid,
    title: z.string(),
  }),
]);
export type DesktopSourceNoteResult = z.infer<typeof desktopSourceNoteResultSchema>;

/**
 * Archiving a source is the API's soft delete (status → archived) and answers
 * 204, so the receipt is built client-side: which source left the ready index.
 * The record stays reachable under the index's 全部 tab — there is no inverse.
 */
export const desktopSourceArchiveResultSchema = z.object({
  sourceId: uuid,
  status: z.literal("archived"),
}).passthrough();
export type DesktopSourceArchiveResult = z.infer<typeof desktopSourceArchiveResultSchema>;

/**
 * 恢复已归档来源的回执（审计 F08）。
 *
 * `status` 是服务端按事实算出来的那一档，不是客户端挑的：有片段回到 `ready`
 * （正文还在，立刻可读可起稿），没有片段回到 `draft`（只剩元数据，走"重新解析"）。
 * `alreadyActive` 用于幂等：重复点、并发点都返回同一个结果，界面照实说"它本来就没归档"。
 */
export const desktopSourceRestoreResultSchema = z.object({
  sourceId: uuid,
  status: z.enum(["draft", "processing", "ready", "failed", "archived"]),
  alreadyActive: z.boolean(),
}).passthrough();
export type DesktopSourceRestoreResult = z.infer<typeof desktopSourceRestoreResultSchema>;

/**
 * 重新解析的回执（doc 34 L7）。服务端返回 202 + 新状态，`draft` 意思是
 * "已排去解析、还没开始"，不是"已经解析完"——界面上要说的下一句是"排上了"。
 */
export const desktopSourceReparseResultSchema = z.object({
  sourceId: uuid,
  status: z.literal("draft"),
}).passthrough();
export type DesktopSourceReparseResult = z.infer<typeof desktopSourceReparseResultSchema>;

/**
 * AI 外发审计的一页（设置 → 隐私那条「记录 AI 审计日志，供你回看」的读端，doc 34 L3 另一半）。
 *
 * 字段逐条对着服务端的 `ai_audit_log` 列与 `listAIAuditLog` 的 select 写，
 * 不是界面想要什么就声明什么：
 * - `createdAt` 是 JSON 化的 timestamp，所以是字符串不是 Date；
 * - `modelId`/`provider`/`operation`/`status` 在服务端都是 notNull，这里不放宽成可空；
 * - `operator` 是 `userId+email` 都在才有值，历史行里用户被删掉了会留 null
 *   （服务端刻意保留 null 而不是丢行，这里跟着保留同一语义）。
 *
 * 只有 Owner 读得到：那条路由挂着 `requireOwner`，所以这条通道的门在主进程那一侧，
 * 不在界面"是不是显示"这一侧。
 */
export const desktopAiAuditItemV1Schema = z.object({
  id: uuid,
  provider: z.string().min(1),
  modelId: z.string().min(1),
  operation: z.string().min(1),
  dataCategories: z.array(z.string()),
  dataSizeBytes: z.number().int().nullable(),
  costTokens: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  status: z.enum(["success", "failed", "blocked"]),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
  operator: z.object({ userId: uuid, email: z.string().min(1) }).nullable(),
}).passthrough();
export type DesktopAiAuditItemV1 = z.infer<typeof desktopAiAuditItemV1Schema>;

export const desktopAiAuditPageV1Schema = z.object({
  items: z.array(desktopAiAuditItemV1Schema).max(100),
  /** 这个空间的审计总行数（不是本页条数）：界面要说"还有多少"，只能拿服务端这个数。 */
  total: z.number().int().min(0),
}).passthrough();
export type DesktopAiAuditPageV1 = z.infer<typeof desktopAiAuditPageV1Schema>;

/**
 * One page of the notes a source produced.
 *
 * `items` is capped by the API (newest first), so `total` is the workspace's real
 * count for that source: a source with more notes than one page can say so
 * instead of reporting the page length as its own size.
 */
export const desktopSourceNotesPageSchema = z.object({
  items: z.array(z.object({
    id: uuid,
    title: z.string().min(1).max(500),
    titleSource: z.string().min(1).max(80),
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    currentVersionId: uuid.nullable(),
  }).passthrough()),
  total: z.number().int().min(0).default(0),
}).passthrough();
export type DesktopSourceNotesPage = z.infer<typeof desktopSourceNotesPageSchema>;

export const desktopNoteListItemSchema = z.object({
  id: uuid,
  title: z.string().min(1).max(500),
  titleSource: z.string().min(1).max(80),
  currentVersionId: uuid.nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  /**
   * 正文里第一个图片块的原文（`![alt](url)`），没有图就是 null。列表页要能
   * 一眼看出哪篇有图，而按行 `note.get` 取正文是被否决的方案（复盘 #17）。
   * 解析规则只有渲染层一份（`note-blocks.parseImageBlock`），所以这里刻意
   * 不带结构化的 url/alt。
   */
  firstImageBlock: z.string().max(4000).nullable(),
  /** `private` = 「仅自己可见」，`shared` = 「已共享给空间」。 */
  shareScope: z.enum(["private", "shared"]).default("private"),
  /** 只有作者能点那个动作；不是作者时入口要禁用并说明原因，而不是点下去吃一个 404。 */
  canShare: z.boolean().default(false),
}).passthrough();
export type DesktopNoteListItem = z.infer<typeof desktopNoteListItemSchema>;

export const desktopNoteListPageSchema = z.object({
  items: z.array(desktopNoteListItemSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().min(0),
}).passthrough();
export type DesktopNoteListPage = z.infer<typeof desktopNoteListPageSchema>;

/**
 * A new note is committed with its first version in the same call, so the
 * request only carries what the writer already has: a title, a body, or both.
 * The service derives the title from the first block when it is omitted.
 */
export const desktopNoteCreateRequestSchema = z.object({
  title: z.string().max(200).optional(),
  blocks: z.array(noteBlockWriteV1Schema).max(10_000).optional(),
}).passthrough();
export type DesktopNoteCreateRequest = z.infer<typeof desktopNoteCreateRequestSchema>;

/**
 * Deleting a note is a soft delete and restoring it is its inverse, so both
 * answer with the same receipt: which note changed and which way.
 */
export const desktopNoteMutationResultSchema = z.object({
  noteId: uuid,
  status: z.enum(["deleted", "restored"]),
}).passthrough();
export type DesktopNoteMutationResult = z.infer<typeof desktopNoteMutationResultSchema>;

/**
 * One entry of a note's immutable version history. The list deliberately carries
 * no blocks: a version is read by making it current again, not by shipping every
 * historical body across IPC. `current` is the version the note points at now,
 * so the page can mark where the reader is without a second read.
 */
export const desktopNoteVersionItemSchema = z.object({
  versionId: uuid,
  versionNo: z.number().int().min(1),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  current: z.boolean(),
}).passthrough();
export type DesktopNoteVersionItem = z.infer<typeof desktopNoteVersionItemSchema>;

export const desktopNoteVersionListSchema = z.object({
  noteId: uuid,
  items: z.array(desktopNoteVersionItemSchema).max(200),
  total: z.number().int().min(0),
}).passthrough();
export type DesktopNoteVersionList = z.infer<typeof desktopNoteVersionListSchema>;

export const desktopSearchItemSchema = z.object({
  objectType: z.enum(["note", "source", "objective"]),
  objectId: uuid,
  title: z.string().nullable(),
  snippet: z.string(),
  indexedAt: isoTimestamp,
  href: z.string(),
  matchCount: z.number().int().min(0).optional(),
}).passthrough();
export type DesktopSearchItem = z.infer<typeof desktopSearchItemSchema>;

export const desktopSearchPageSchema = z.object({
  items: z.array(desktopSearchItemSchema),
  total: z.number().int().min(0),
  /**
   * 不透明的 keyset 游标：服务端返回什么就原样回传，客户端不解释它。
   * 之前这里是 OFFSET 数字，遇到实体在翻页期间被编辑会静默漏行。
   */
  nextCursor: z.string().min(1).max(512).nullable(),
}).passthrough();
export type DesktopSearchPage = z.infer<typeof desktopSearchPageSchema>;
