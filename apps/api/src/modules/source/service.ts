import { and, asc, desc, eq, ne, sql, count, inArray, isNull } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { sources, sourceSegments, notes, noteVersions } from "@ailearn/shared/db-schema/note";
import {
  cardGenerationRunsV2,
  learningObjectiveOriginsV2,
  learningObjectivesV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import { visibleNotesCondition } from "../note/visibility.ts";
import { applyNoteDocUpdate } from "../note/document-state.ts";
import { writeFragmentBlocks } from "../note/doc-fragment.ts";
import { computeContentHash } from "../note/content-hash.ts";
import { ensureImageAssetsForBlocks } from "../note/service.ts";
import { jobs } from "@ailearn/shared/db-schema/job";
import { searchDocuments } from "@ailearn/shared/db-schema/search";
import {
  SourceStatus,
  JobStatus,
  JobType,
  MAX_PENDING_JOBS_PER_WORKSPACE,
} from "@ailearn/shared";
import { segmentsToBlocks, type ParsedSegment } from "@ailearn/shared/markdown-parser";
// 稳定 P1（2026-09-15 审计）：parse_source 的 payload 走共享精确契约——漏字段/
// 拼错字段在编译期报错，而不是运行期变成一条可重试的 "missing sourceId" 失败。
import type { ParseSourceJobPayload } from "@ailearn/shared/job-payload-contracts";
import type { SourceCreateInput, SourceUpdateInput } from "./schema.ts";
import { logger } from "../../lib/logger.ts";
import { encodeCursor, decodeCursor } from "../../lib/pagination.ts";
import { hookJourneyEntityCreated } from "../companion-journey/journey-hook.ts";

type SourceSearchDocument = {
  workspaceId: string;
  objectType: "source" | "note";
  objectId: string;
  title: string | null;
  body: string | null;
};

/** Keep best-effort projection writes on the request connection via a savepoint.
 *
 * QUAL-61 备注：此函数与 note/service.ts 中的 upsertSearchDocument 逻辑重复。
 * 理想情况下应提取到共享的 search-index.ts 模块中，但当前两个模块的
 * SearchDocument 类型定义不同（source 有自己的 SourceSearchDocument 类型），
 * 提取共享函数需要先统一类型定义，属于架构级改进，暂缓处理。
 */
async function upsertSearchDocument(
  executor: ApiTransaction,
  document: SourceSearchDocument,
): Promise<boolean> {
  try {
    await executor.transaction(async (savepoint) => {
      await savepoint
        .insert(searchDocuments)
        .values({ ...document, metadata: {}, indexedAt: new Date() })
        .onConflictDoUpdate({
          target: [searchDocuments.workspaceId, searchDocuments.objectType, searchDocuments.objectId],
          set: {
            title: document.title,
            body: document.body,
            metadata: {},
            indexedAt: new Date(),
          },
        });
    });
    return true;
  } catch (err) {
    logger.error(
      { err, ...document },
      "search index upsert failed — index may be stale, run reindex to compensate",
    );
    return false;
  }
}

async function deleteSearchDocument(
  executor: ApiTransaction,
  workspaceId: string,
  objectType: SourceSearchDocument["objectType"],
  objectId: string,
): Promise<void> {
  try {
    await executor.transaction(async (savepoint) => {
      await savepoint
        .delete(searchDocuments)
        .where(and(
          eq(searchDocuments.workspaceId, workspaceId),
          eq(searchDocuments.objectType, objectType),
          eq(searchDocuments.objectId, objectId),
        ));
    });
  } catch (err) {
    logger.error(
      { err, workspaceId, objectType, objectId },
      "search index delete failed — index may have ghost document, run reindex to compensate",
    );
  }
}

/** 自动标题的预算与收尾标点（审计 F34）。 */
const SOURCE_TITLE_BUDGET = 60;
const SENTENCE_END = "。！？；.!?;…)";
const SOFT_BREAK = "，,、：:）)】」』";

/**
 * 留空标题时的自动标题（审计 F34）。
 *
 * 病是这么来的：`content.split("\n")[0].slice(0, 60)` 会在一句话中间硬切，
 * 实测标题以连接词"而"收尾，而且没有省略号——同一串又被列表、详情与后续引用反复显示。
 *
 * 规则（越靠前越优先，都只在预算内找最后一个位置）：
 * 1. 句末标点收尾：整句最自然，不加省略号（读者看到的是完整一句话）；
 * 2. 次级停顿（逗号、顿号、冒号）收尾：远好过半个词，补省略号说明后面还有；
 * 3. 拉丁词边界：别把英文单词切成两半，补省略号；
 * 4. 都不满足就按预算硬切 + 省略号（中文长句没有标点的极端情况）。
 *
 * URL 不套这套：它本来就没有句读，按预算切 + 省略号即可。
 */
export function deriveSourceTitle(input: { url?: string | null; content?: string | null }): string {
  const contentLine = input.content?.trim().split("\n")[0]?.trim() ?? "";
  const url = input.url?.trim() ?? "";
  const candidate = url || contentLine;
  if (!candidate) return "未命名来源";
  if (candidate.length <= SOURCE_TITLE_BUDGET) return candidate;

  const window = candidate.slice(0, SOURCE_TITLE_BUDGET);
  if (!url) {
    const floor = Math.floor(SOURCE_TITLE_BUDGET / 3);
    const lastSentenceEnd = Math.max(...[...SENTENCE_END].map((ch) => window.lastIndexOf(ch)));
    if (lastSentenceEnd >= floor) return window.slice(0, lastSentenceEnd + 1);
    const lastSoftBreak = Math.max(...[...SOFT_BREAK].map((ch) => window.lastIndexOf(ch)));
    if (lastSoftBreak >= floor) return `${window.slice(0, lastSoftBreak + 1)}…`;
    const lastSpace = window.lastIndexOf(" ");
    if (lastSpace >= floor) return `${window.slice(0, lastSpace)}…`;
  }
  return `${window.trimEnd()}…`;
}

/**
 * 链接的规范化形式（审计 F33）。
 *
 * 同一个网址在两次采集里常常长得不一样：追踪参数（`spm_id_from`、`utm_*`、
 * `fbclid` …）、参数顺序、结尾斜杠、`#` 片段。演示库里就躺着两条 bilibili 链接，
 * 带与不带 `spm_id_from` 各一条，各自长成一篇笔记和一叠卡——用户没有机会知道。
 *
 * 只归一"语义上同一篇文章"的那些差异：保留路径与业务参数（`?p=2`、`?v=xxx` 这类
 * 是内容身份），丢掉跟踪参数、片段、大小写不同的主机名与结尾斜杠。
 */
const TRACKING_PARAM_PATTERN = /^(utm_.*|spm_.*|fbclid|gclid|msclkid|yclid|igshid|vd_source|share_source|share_medium|share_plat|share_tag|ref_src|ref_url|from_source|si)$/i;

export function normalizeSourceUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM_PATTERN.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    const query = url.searchParams.toString();
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host.toLowerCase()}${path}${query ? `?${query}` : ""}`;
  } catch {
    // 不是合法 URL 的字符串（比如粘贴的裸域名）按原样比较：宁可漏报，不可误判成"同一篇"。
    return trimmed;
  }
}

export interface DuplicateSourceHit {
  sourceId: string;
  title: string;
  createdAt: string;
  status: string;
}

/**
 * 这个工作区里有没有"同一篇文章"（审计 F33）。
 *
 * 网址存在 `metadata.url` 或 `origin` 里（表上没有独立列），所以按工作区把未归档的
 * 行读出来逐条比较规范化形式——个人空间的来源规模远在千条以内，一次批量读足够；
 * 用 SQL 里拼规范化规则会把这些规则复制成两份，反而更难对齐。
 * 归档的不算重复：那是用户已经放下的东西，重采一份是正常操作。
 */
export async function findDuplicateSource(
  executor: ApiTransaction,
  workspaceId: string,
  rawUrl: string,
): Promise<DuplicateSourceHit | null> {
  const target = normalizeSourceUrl(rawUrl);
  if (!target) return null;
  const rows = await executor
    .select({
      id: sources.id,
      title: sources.title,
      createdAt: sources.createdAt,
      status: sources.status,
      origin: sources.origin,
      metadata: sources.metadata,
    })
    .from(sources)
    .where(and(eq(sources.workspaceId, workspaceId), ne(sources.status, SourceStatus.ARCHIVED)))
    .limit(1000);
  for (const row of rows) {
    const metadata = (row.metadata ?? {}) as { url?: unknown };
    const candidate = [
      typeof metadata.url === "string" ? metadata.url : "",
      row.origin ?? "",
    ].find((value) => value.trim().length > 0);
    if (candidate && normalizeSourceUrl(candidate) === target) {
      return {
        sourceId: row.id,
        title: row.title,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
        status: row.status,
      };
    }
  }
  return null;
}

export async function createSource(
  executor: ApiTransaction,
  workspaceId: string,
  userId: string,
  input: SourceCreateInput,
) {
  // 如果未传 type，前端检测为初步值；Worker 会再次检测并修正
  const detectedType = input.type ?? detectSourceType(input.content ?? "", input.url);
  // 如果未传 title，使用临时占位标题；Worker 解析后会更新
  const title = input.title?.trim() || deriveSourceTitle({ url: input.url, content: input.content });

  const metadata: Record<string, unknown> = { ...input.metadata };
  // 关键：原代码用 input.type（必填）判断，改成 optional 后必须用 detectedType。
  const isUrlWithoutContent = detectedType === "url" && !input.content?.trim();
  if (input.content) metadata.rawContent = input.content;
  if (input.url) metadata.url = input.url;
  // 标记 type 来源，供 Worker 判断是否可修正
  metadata.typeSource = input.type ? "manual" : "auto";

  // 审计 F33：同一个网址的第二次采集默认**不建新条目**——先问用户要不要用原来那份。
  // 演示库里的两条 bilibili 链接（带与不带 `spm_id_from`）各自长成一篇笔记和一叠卡，
  // 用户没有任何机会知道它们其实是同一篇。命中时返回既有那份的详情并带 `duplicateOf`，
  // 由界面提示"已在 X 采过"；用户明确说"再采一次"时带 `force` 回来才真的新建。
  const captureUrl = input.url?.trim() || (detectedType === "url" ? input.content?.trim() : undefined);
  if (!input.force && captureUrl) {
    const duplicate = await findDuplicateSource(executor, workspaceId, captureUrl);
    if (duplicate) {
      const existing = await getSource(executor, duplicate.sourceId, workspaceId);
      if (existing) return { ...existing, duplicateOf: duplicate };
    }
  }

  // R-016: source 创建和 job 入队在同一事务内，避免入队失败留下永不解析的 DRAFT
  const source = await (async (tx: ApiTransaction) => {
    // 与 createJob 使用同一 workspace advisory lock，将配额计数和插入
    // 串行化；既保持 source/job 原子性，也避免并发突破配额。
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`job-quota:${workspaceId}`}, 0)
      )
    `);
    const pendingRows = await tx
      .select({ count: count() })
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, workspaceId),
          eq(jobs.status, JobStatus.PENDING),
        ),
      );
    const pendingCount = Number(pendingRows[0]?.count ?? 0);
    if (pendingCount >= MAX_PENDING_JOBS_PER_WORKSPACE) {
      const error = new Error(
        `workspace has ${pendingCount} pending jobs (max ${MAX_PENDING_JOBS_PER_WORKSPACE})`,
      );
      (error as Error & { statusCode: number }).statusCode = 429;
      throw error;
    }

    const [row] = await tx
      .insert(sources)
      .values({
        workspaceId,
        type: detectedType,
        title,
        origin: input.url ?? null,
        status: SourceStatus.DRAFT,
        metadata,
        createdBy: userId,
      })
      .returning();

    // P6 Journey：source 里程碑（同事务原子；无 active Journey 零开销）。
    await hookJourneyEntityCreated(tx, { workspaceId, userId }, {
      eventType: "source.created",
      entityId: row.id,
    });

    // 同一事务内创建 parse_source job。
    // payload 由共享契约约束（ParseSourceJobPayload）：字段名/类型与 worker 侧的
    // readParseSourceJobPayload 同源。历史字段 userId 已删除——worker 从不读它
    // （actor 归属走 jobs.requested_by），jobs 查询接口本来就把它脱敏掉（R-006）。
    const parseSourcePayload: ParseSourceJobPayload = isUrlWithoutContent
      ? { sourceId: row.id, fetchUrlContent: true }
      : { sourceId: row.id };
    await tx.insert(jobs).values({
      type: JobType.PARSE_SOURCE,
      workspaceId,
      requestedBy: userId,
      payload: parseSourcePayload,
      status: JobStatus.PENDING,
      priority: 70,
      resourceClass: "card_foreground",
    });

    return row;
  })(executor);

  const detail = await getSource(executor, source.id, workspaceId);
  return detail ? { ...detail, duplicateOf: null } : detail;
}

export async function listSources(
  executor: ApiTransaction,
  workspaceId: string,
  opts: { userId: string; status?: string; cursor?: string; limit?: number },
) {
  // §2.6: 支持 cursor/limit 分页
  const limit = Math.max(1, Math.min(100, opts.limit ?? 100));
  let where = and(
    eq(sources.workspaceId, workspaceId),
    ne(sources.status, SourceStatus.ARCHIVED), // 默认排除已归档来源
  );
  if (opts.status) {
    where = and(eq(sources.workspaceId, workspaceId), eq(sources.status, opts.status as SourceStatus));
  }
  // R-019: 使用 cursor 分页。排序键是 (updatedAt, id)：索引页每一行展示的是
  // updatedAt，按 createdAt 排会让「刚更新但很久前采集」的材料沉到列表末尾，
  // 与行内时间自相矛盾（2026-09-16 来源库复查）。
  const conditions = [where];
  if (opts.cursor) {
    const decoded = decodeCursor(opts.cursor);
    if (decoded) {
      const cursorTs = decoded.timestamp;
      const cursorId = decoded.id;
      conditions.push(
        sql`(${sources.updatedAt}, ${sources.id}) < (${cursorTs}::timestamptz, ${cursorId}::uuid)`,
      );
    }
  }
  // PERF: The total count and the note-count GROUP BY are both independent of
  // each other once the page rows (and their source ids) are known, so run them
  // concurrently — reducing the source list from 3 sequential DB round-trips to
  // 2. The page query runs first so a malformed page row (missing cursor) still
  // fails closed before any count query issues.
  const sourceRows = await executor.query.sources.findMany({
    where: and(...conditions),
    orderBy: [desc(sources.updatedAt), desc(sources.id)],
    limit: limit + 1,
    // PERF-B11 修复：列表排除大 jsonb metadata（rawContent 可达数百 KB），
    // 仅详情接口返回。
    columns: { metadata: false },
    extras: {
      cursorTimestamp: sql<string>`to_char(${sources.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as("cursor_timestamp"),
    },
  });
  const hasMore = sourceRows.length > limit;
  const itemsWithCursor = sourceRows.slice(0, limit);
  const items = itemsWithCursor.map(({ cursorTimestamp, ...source }) => {
    if (!cursorTimestamp) throw new Error("source cursor timestamp is missing");
    return source;
  });

  // 批量查询每条来源的关联笔记数量，避免 N+1 —— 与总数查询并行（2 RTT 而非 3）。
  const sourceIds = items.map((s) => s.id);
  const [countRows, noteCountRows, cardProgressRows] = await Promise.all([
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(sources)
      .where(where),
    sourceIds.length > 0
      ? executor
          .select({
            sourceId: notes.sourceId,
            count: sql<number>`count(*)::int`,
          })
          .from(notes)
          .where(and(
            inArray(notes.sourceId, sourceIds),
            eq(notes.workspaceId, workspaceId),
            visibleNotesCondition(opts.userId),
            isNull(notes.deletedAt),
          ))
          .groupBy(notes.sourceId)
      : Promise.resolve([]),
    /**
     * 学习卡进展（实走复盘 #18 后半）：来源 → 笔记 → 生成批次 / 正式目标。
     * 仍然是一次批量聚合（不按行发请求）：批次按 note_id 直接连，正式目标经
     * `learning_objective_origins_v2.note_id` 连——目标本身没有 sourceId，
     * 它的来路记在 origins 上。
     */
    sourceIds.length > 0
      ? executor
          .select({
            sourceId: notes.sourceId,
            pendingReviewRuns: sql<number>`count(DISTINCT ${cardGenerationRunsV2.id}) FILTER (WHERE ${cardGenerationRunsV2.status} IN ('queued','source_sealing','planning','authoring','checking','review_ready'))::int`,
            activeObjectives: sql<number>`count(DISTINCT ${learningObjectivesV2.objectiveId}) FILTER (WHERE ${learningObjectivesV2.lifecycle} = 'active')::int`,
          })
          .from(notes)
          .leftJoin(cardGenerationRunsV2, eq(cardGenerationRunsV2.noteId, notes.id))
          .leftJoin(learningObjectiveOriginsV2, eq(learningObjectiveOriginsV2.noteId, notes.id))
          .leftJoin(learningObjectivesV2, eq(learningObjectivesV2.objectiveId, learningObjectiveOriginsV2.objectiveId))
          .where(and(
            inArray(notes.sourceId, sourceIds),
            eq(notes.workspaceId, workspaceId),
            visibleNotesCondition(opts.userId),
            isNull(notes.deletedAt),
          ))
          .groupBy(notes.sourceId)
      : Promise.resolve([]),
  ]);
  const total = countRows[0]?.count ?? 0;
  const noteCountMap = new Map(noteCountRows.map((r) => [r.sourceId!, r.count]));
  const cardProgressMap = new Map(cardProgressRows.map((r) => [r.sourceId!, r]));
  const itemsWithCounts = items.map((s) => ({
    ...s,
    noteCount: noteCountMap.get(s.id) ?? 0,
    cardProgress: {
      pendingReviewRuns: cardProgressMap.get(s.id)?.pendingReviewRuns ?? 0,
      activeObjectives: cardProgressMap.get(s.id)?.activeObjectives ?? 0,
    },
  }));

  // R-019: 使用最后一条记录的 (updatedAt, id) 作为下一页 cursor
  const lastItem = itemsWithCursor[itemsWithCursor.length - 1];
  const nextCursor = hasMore && lastItem
    ? encodeCursor(lastItem.cursorTimestamp, lastItem.id)
    : null;
  return { items: itemsWithCounts, nextCursor, total };
}

export async function getSource(
  executor: ApiTransaction,
  sourceId: string,
  workspaceId: string,
) {
  const source = await executor.query.sources.findFirst({
    where: and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)),
  });
  if (!source) return null;

  const segments = await executor.query.sourceSegments.findMany({
    where: eq(sourceSegments.sourceId, sourceId),
    orderBy: [asc(sourceSegments.ordinal)],
  });

  return { source, segments };
}

export async function updateSource(
  executor: ApiTransaction,
  sourceId: string,
  workspaceId: string,
  input: SourceUpdateInput,
) {
  // F13（round-4）：metadata read-modify-write 无并发保护——并发 PATCH 读到同一
  // base 会互相覆盖字段（lost update）。执行器为事务（ApiTransaction），用
  // SELECT ... FOR UPDATE 锁定行后再读，串行化同一 source 的并发更新（最简，
  // 无新增 CAS 列）。sources.id 为固定主键排序，避免死锁。
  const sourceRows = await executor
    .select()
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .limit(1)
    .for("update");
  const source = sourceRows[0] ?? null;
  if (!source) return null;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.title !== undefined) updates.title = input.title;
  // F-021: status 不再由客户端直接设置，只能通过服务端状态机改变
  if (input.metadata !== undefined) {
    updates.metadata = { ...source.metadata, ...input.metadata };
  }

  await executor
    .update(sources)
    .set(updates)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)));
  return getSource(executor, sourceId, workspaceId);
}

/**
 * 重新解析一条来源（doc 34 L7）。
 *
 * 之前的事实是：`parse_source` 的 job 被判 `dead` 之后，只碰 `jobs` 那张表，
 * `sources.status` 永远停在 `processing`（`SourceStatus.PROCESSING` 全仓唯一的写入点
 * 在 worker 的 handler 里，它失败时又要求租约仍有效），而界面写着"打开来源后可以重新解析"
 * ——**那句话没有对应的端点**。这条就是那句文案的落地。
 *
 * 判据只有一条：**没有在跑的 job 就允许再跑一次**。
 * - 有 `pending`/`running` 的 job → `already_queued`。重复入队是同一份外部调用付两遍钱，
 *   也让两个 worker 抢同一篇来源。回收（`dead`）与终态（`succeeded`）都不算在跑，
 *   所以卡住的 `processing` 正好能从这条路走出去。
 * - `archived` → `archived`，与删除一条边界：归档的东西不该被后台任务复活。
 *
 * 与入队同事务：状态改回去了却没排上队，界面就 again 永远等着一个不会来的 worker。
 */
export type SourceReparseResult =
  | { ok: true; status: typeof SourceStatus.DRAFT }
  | { ok: false; error: "not_found" | "already_queued" | "archived" };

export async function reparseSource(
  executor: ApiTransaction,
  sourceId: string,
  workspaceId: string,
  userId: string,
): Promise<SourceReparseResult> {
  const [source] = await executor
    .select({ id: sources.id, status: sources.status, metadata: sources.metadata })
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .for("update");
  if (!source) return { ok: false, error: "not_found" };
  if (source.status === SourceStatus.ARCHIVED) return { ok: false, error: "archived" };

  const live = await executor
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(
      eq(jobs.workspaceId, workspaceId),
      eq(jobs.type, JobType.PARSE_SOURCE),
      inArray(jobs.status, [JobStatus.PENDING, JobStatus.RUNNING]),
      // payload 里的 sourceId 才是"这一篇"的身份；job 表没有指向 sources 的列。
      sql`${jobs.payload} ->> 'sourceId' = ${sourceId}`,
    ))
    .limit(1);
  if (live.length > 0) return { ok: false, error: "already_queued" };

  await executor
    .update(sources)
    .set({ status: SourceStatus.DRAFT, updatedAt: new Date() })
    .where(eq(sources.id, sourceId));

  // payload 与 createSource 那一支同源：URL 型来源要带 `fetchUrlContent`，
  // 否则 worker 会去读一份从来没落库的正文，把这次重新解析变成一次必然失败。
  const metadata = (source.metadata ?? {}) as { url?: string; content?: string };
  const isUrlWithoutContent = Boolean(metadata.url) && !metadata.content;
  const payload: ParseSourceJobPayload = isUrlWithoutContent
    ? { sourceId, fetchUrlContent: true }
    : { sourceId };
  await executor.insert(jobs).values({
    type: JobType.PARSE_SOURCE,
    workspaceId,
    requestedBy: userId,
    payload,
    status: JobStatus.PENDING,
    priority: 70,
    resourceClass: "card_foreground",
  });

  return { ok: true, status: SourceStatus.DRAFT };
}

/**
 * 把一条已归档的来源恢复到可用状态（审计 F08）。
 *
 * 「归档」这条路写的提示语是"可在已归档页签找到"，而此前**没有回去的路**：数据还在
 * （只是 `status=archived`），界面上唯一的后果却是"再也不能从它开始笔记"。
 * 「归档」是日常词里可撤销的那一类，所以这里补上撤销。
 *
 * 回到哪一档不由用户挑，由事实决定：
 * - 有片段行 → `ready`（正文还在，立刻可读、可起稿）；
 * - 没有片段行 → `draft`（只剩元数据，走既有的"重新解析"那条路）。
 * 这样"恢复到某个中间态"不会把一条没有正文的来源标成可读。
 *
 * 幂等：不是 archived 的来源原样返回（重复点、并发点都是同一个结果）。
 * 索引与 `deleteSource` 对称：归档时删掉了搜索文档，恢复时按 reindex 的同一口径补回
 * （有片段用片段正文，否则用 origin/rawContent/url 拼的兜底正文）。
 */
export type SourceRestoreResult =
  | { ok: true; status: string; alreadyActive: boolean }
  | { ok: false; error: "not_found" };

export async function restoreSource(
  executor: ApiTransaction,
  sourceId: string,
  workspaceId: string,
): Promise<SourceRestoreResult> {
  const [source] = await executor
    .select({
      id: sources.id,
      status: sources.status,
      title: sources.title,
      origin: sources.origin,
      metadata: sources.metadata,
    })
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .for("update");
  if (!source) return { ok: false, error: "not_found" };
  if (source.status !== SourceStatus.ARCHIVED) {
    return { ok: true, status: source.status, alreadyActive: true };
  }

  const segments = await executor
    .select({ text: sourceSegments.text })
    .from(sourceSegments)
    .where(and(eq(sourceSegments.sourceId, sourceId), eq(sourceSegments.workspaceId, workspaceId)))
    .orderBy(asc(sourceSegments.ordinal));
  const nextStatus = segments.length > 0 ? SourceStatus.READY : SourceStatus.DRAFT;

  await executor
    .update(sources)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)));

  // 与 `search/service.ts` 的 reindex 同一口径：有片段用片段正文，否则用元数据兜底。
  const metadata = (source.metadata ?? {}) as { rawContent?: unknown; url?: unknown };
  const body = segments.length > 0
    ? segments.map((segment) => segment.text).join("\n")
    : [
        source.origin,
        typeof metadata.rawContent === "string" ? metadata.rawContent : "",
        typeof metadata.url === "string" ? metadata.url : "",
      ].filter(Boolean).join("\n");
  await upsertSearchDocument(executor, {
    workspaceId,
    objectType: "source",
    objectId: sourceId,
    title: source.title,
    body,
  });

  return { ok: true, status: nextStatus, alreadyActive: false };
}

export async function deleteSource(
  executor: ApiTransaction,
  sourceId: string,
  workspaceId: string,
) {
  const source = await executor.query.sources.findFirst({
    where: and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)),
  });
  if (!source) return null;

  // 软删除：status → archived
  await executor
    .update(sources)
    .set({ status: SourceStatus.ARCHIVED, updatedAt: new Date() })
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)));

  // 清理搜索索引（P1-3）
  await deleteSearchDocument(executor, workspaceId, "source", sourceId);

  return { ok: true };
}

/**
 * 根据内容特征初步检测来源类型（快速粗粒度判断）。
 * Worker 端 correctSourceType 会做更细粒度的修正。
 * 已与 detectCaptureType（today/page.tsx）取并集统一。
 */
export function detectSourceType(content: string, url?: string): "text" | "markdown" | "code" | "url" {
  // URL 检测：有 url 参数且无 content，或 content 本身就是 URL
  if (url && /^https?:\/\//.test(url) && !content.trim()) return "url";
  const text = content.trim();
  if (/^https?:\/\/\S+$/i.test(text)) return "url";

  // 代码检测：合并 detectCaptureType 和原 detectSourceType 的所有关键字（并集）
  // 注意：from 已移除——在英文文本中过于常见（"from the beginning" 等），
  // 且 ES module 导入中 from 总是与 import/export 同时出现，两者已在关键字列表中。
  // public/private/protected 已移除——作为独立关键字在英文文本中过于常见
  //（"public transport"、"private matter"、"protected species"），
  // 会导致 detectSourceType 误判为 code，且 correctSourceType 的 code→text 回退
  //（codeScore === 0 条件）被这些关键字在 codeIndicators 中的匹配所阻断。
  // 改用 "public class" 两词模式替代独立 public 关键字。
  // type 已移除——与 from/public/private/protected 同类问题，是常见英文单词
  //（"type of music"、"type your name"、"type a letter"），作为独立关键字
  // 会导致英文文本被误判为 code。TypeScript 的 type 定义通常伴随 const/import
  // 等其他关键字出现，移除 type 不影响多行代码文件的检测。
  if (
    /^(?:function|const|let|var|class|interface|enum|import|export|def|#include|package|public class|if __name__)\b/m.test(text) ||
    /^[a-zA-Z_$][\w$]*\s*[({]/m.test(text) // 函数调用或定义模式
  ) {
    return "code";
  }

  // ``` 含代码块按 markdown 处理（保留代码块结构，而非 code 整段）
  if (/```/.test(text)) return "markdown";

  // Markdown 检测：标题、列表、引用等语法
  // 正则与 today/page.tsx 的 detectCaptureType 对齐，要求标记后有空格，
  // 避免 "-5 度" 等以 - 开头的纯文本被误判为 markdown。
  if (/^(#{1,6}\s|>|[-*+]\s|\d+\.\s)/m.test(text) || /\[.+?\]\(.+?\)/.test(text)) return "markdown";
  return "text";
}

/**
 * §2.7: 查询从此来源创建的笔记列表。
 *
 * `items` 只返回最近 50 篇，`total` 是该来源的真实总数——详情页要能说
 * 「共 N 篇，这里列出最近 M 篇」，而不是把一页的长度当成来源的规模。
 */
export async function listNotesBySource(
  executor: ApiTransaction,
  sourceId: string,
  workspaceId: string,
  userId: string,
) {
  const source = await executor.query.sources.findFirst({
    where: and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)),
  });
  if (!source) return null;

  // 列表与 total 共用这一个 where：那个数字在界面上写的是"共 N 篇"，
  // 只筛列表不筛数字就会自相矛盾。
  const where = [
    eq(notes.sourceId, sourceId),
    eq(notes.workspaceId, workspaceId),
    isNull(notes.deletedAt),
  ];
  const [noteRows, countRows] = await Promise.all([
    executor
      .select({
        id: notes.id,
        title: notes.title,
        titleSource: notes.titleSource,
        createdAt: notes.createdAt,
        updatedAt: notes.updatedAt,
        currentVersionId: notes.currentVersionId,
      })
      .from(notes)
      .where(and(visibleNotesCondition(userId), ...where))
      .orderBy(desc(notes.updatedAt))
      .limit(50),
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(notes)
      // 列表与 total 同一条判据：那个数字在界面上写的是「共 N 篇」。
      .where(and(visibleNotesCondition(userId), ...where)),
  ]);

  return { items: noteRows, total: countRows[0]?.count ?? 0 };
}

/**
 * 从 Source 创建笔记草稿。
 * 1. 读取 source_segments
 * 2. （可选）内容去重：若已有笔记当前版本的内容哈希一致，返回 duplicate_content
 * 3. 创建 note（title 从 source.title 继承，写入 sourceId）
 * 4. 创建 note_version + note_blocks（每个 segment 映射为一个 block）
 * 5. block 的 source_ref 指向 source_segment
 */
export async function createNoteFromSource(
  executor: ApiTransaction,
  sourceId: string,
  workspaceId: string,
  userId: string,
  opts?: { force?: boolean },
) {
  const source = await executor.query.sources.findFirst({
    where: and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)),
  });
  if (!source) return null;

  // 只有 ready 状态才能转笔记
  if (source.status !== SourceStatus.READY) {
    return { error: "source_not_ready" as const };
  }

  const segments = await executor.query.sourceSegments.findMany({
    where: eq(sourceSegments.sourceId, sourceId),
    orderBy: [asc(sourceSegments.ordinal)],
  });

  // 如果没有 segments（如 url 无正文），不允许创建笔记
  if (segments.length === 0) {
    return { error: "no_segments" as const };
  }

  // 将 segments 转为 blocks
  const parsedSegments: ParsedSegment[] = segments.map((s) => ({
    text: s.text,
    segmentType: (s.segmentType as ParsedSegment["segmentType"]) ?? "paragraph",
    charStart: s.charStart,
    charEnd: s.charEnd,
  }));

  const blocks = segmentsToBlocks(parsedSegments, source.type as "text" | "markdown" | "code" | "url");
  const newContentHash = computeContentHash({ blocks: blocks.map((b) => ({ type: b.type, content: b.content })) });

  // 内容去重：如果该来源已有笔记的当前版本内容哈希与新内容一致，
  // 说明来源内容未变，重复创建会生成完全相同的笔记。
  // force=true 时跳过此检查（用户明确确认要再创建一篇）。
  if (!opts?.force) {
    // PERF: push the content-hash match into SQL with LIMIT 1 so we never load
    // every non-deleted note of a source into memory just to find one hash match.
    const [duplicate] = await executor
      .select({
        noteId: notes.id,
        noteTitle: notes.title,
      })
      .from(notes)
      .innerJoin(noteVersions, eq(notes.currentVersionId, noteVersions.id))
      .where(and(
        eq(notes.sourceId, sourceId),
        eq(notes.workspaceId, workspaceId),
        visibleNotesCondition(userId),
        isNull(notes.deletedAt),
        eq(noteVersions.contentHash, newContentHash),
      ))
      .limit(1);

    if (duplicate) {
      return {
        error: "duplicate_content" as const,
        existingNoteId: duplicate.noteId,
        existingNoteTitle: duplicate.noteTitle,
      };
    }
  }

  const result = await (async (tx: ApiTransaction) => {
    // 创建 note，写入 sourceId
    const [note] = await tx
      .insert(notes)
      .values({
        workspaceId,
        title: source.title,
        titleSource: "auto",
        sourceId: source.id,
        createdBy: userId,
      })
      .returning();

    // 创建 note_version
    const [version] = await tx
      .insert(noteVersions)
      .values({
        noteId: note.id,
        workspaceId,
        versionNo: 1,
        contentJson: { blocks: blocks.map((b) => ({ type: b.type, content: b.content })) },
        contentHash: newContentHash,
        createdBy: userId,
      })
      .returning();

    // 创建 note_blocks，每个 block 的 source_ref 指向 source_segment。
    // 批次 4.1：来源转笔记是"整篇由这一次动作拥有"的路径，所以走文档入口——
    // 快照先落，行由文档派生；块级 sourceRef 必须进文档，否则恢复历史版本时
    // 第一个丢的就是证据链回指。
    const blocksWithAssets = await ensureImageAssetsForBlocks(tx, workspaceId, blocks, userId, note.id);
    await applyNoteDocUpdate(tx, { workspaceId, noteId: note.id, userId }, version.id, (doc) => {
      writeFragmentBlocks(
        doc,
        blocksWithAssets.map((b, idx) => ({
          type: b.type,
          content: b.content,
          ...(b.imageAssetId ? { imageAssetId: b.imageAssetId } : {}),
          sourceRef: { sourceId: source.id, segmentId: segments[idx]?.id },
        })),
      );
    });

    // 更新 note.currentVersionId
    await tx
      .update(notes)
      .set({ currentVersionId: version.id, updatedAt: new Date() })
      .where(eq(notes.id, note.id));

    return { note, version };
  })(executor);

  // B-NEW-1: 同步搜索索引（与 createNote / importMarkdown 保持一致）
  // BUG-69 修复：过滤 image 类型 block，与 note service 保持一致，避免 drift 检测误报
  const bodyText = blocks.filter((b) => b.type !== "image").map((b) => b.content).join("\n");
  await upsertSearchDocument(executor, {
    workspaceId,
    objectType: "note",
    objectId: result.note.id,
    title: result.note.title,
    body: bodyText,
  });

  return result;
}
