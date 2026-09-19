/**
 * 「今日学习」操作日志服务（页 14 重构，2026-09-18）。
 *
 * 页面从"固定三张票"改为按时间倒序的当天真实操作日志流 + 状态异常事务追溯。
 * 事件一律由权威表现查投影而来（不建平行真相，遵守决策 02-9），因此：
 * - 日志随权威数据持久存在，AI 伴星（伴星日记读同一批表，doc 22 §15.6）
 *   与本页面读到的永远是同一份操作事实；
 * - 每类事件各自封顶 LIMIT，触顶即置 truncated，页面必须如实说出"这不是完整账本"。
 *
 * 事件源与动词：
 * - notes        → note.created / note.updated（同日创建的笔记只记一次"新建"）
 * - sources      → source.created
 * - objectives   → objective.created（learning_objectives_v2）
 * - runs         → learning_run.started / learning_run.completed（learning_runs）
 * - generation   → card_generation.started / card_generation.review_ready
 * - jobs         → job.scheduled（仅用户触发的后台任务，requestedBy = user）
 *
 * 页面浏览痕迹（assistant_page_contexts）不进 v1 日志流：聚合行没有真实
 * 时间戳，放进时间序会制造伪时间；伴星日记（doc 22 §15.6）仍直接读该表。
 *
 * 异常追溯（status 异常的事务）：
 * - 卡片生成 runs：needs_attention / failed / stale（不限当天——需要处理的就该被看见）
 * - jobs：当天 failed
 * - learning runs：非 paused 但超过 24h 没有更新的活跃 run
 */
import { and, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { notes, sources } from "@ailearn/shared/db-schema/note";
import { jobs } from "@ailearn/shared/db-schema/job";
import { learningRuns } from "@ailearn/shared/db-schema/learning-runs";
import {
  cardGenerationRunsV2,
  learningObjectiveRevisionsV2,
  learningObjectivesV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import { JobType } from "@ailearn/shared";
import { readParseSourceJobPayload } from "@ailearn/shared/job-payload-contracts";
import {
  todayActivityV1Schema,
  type ActivityAnomalyV1,
  type ActivityEventV1,
  type ActivityTargetV1,
  type TodayActivityV1,
} from "@ailearn/shared/activity-surface-contracts";

/** 单类事件源的查询上限；与 IPC 侧"列表窗口封顶 100"的口径一致。 */
const SOURCE_LIMIT = 100;
/** 汇总后日志流的最终条数上限（倒序截断，最旧的被截掉并置 truncated）。 */
const EVENTS_MAX = 200;
/** 异常追溯**总量**上限（三个来源各查 20，合并后必须再封一次顶）。 */
const ANOMALY_SOURCE_LIMIT = 20;
const ANOMALY_MAX = 12;
/** 学习旅程超过这么久没有更新（且不是 paused）即视为卡住。 */
const STUCK_RUN_MS = 24 * 60 * 60 * 1000;

const RUN_GOAL_LABELS: Record<string, string> = {
  stabilize: "巩固",
  clarify: "澄清",
  repair: "修复",
  transfer: "迁移",
  explore: "探索",
};

/**
 * 机器 token 一律在服务端翻译成中文，绝不带进用户可见文案。
 *
 * v1 的缺陷：异常标题直接拼 `停在 ${row.status}`，页面上出现「…停在 needs_attention」
 * 这种中英混排；后台任务行把 `row.type`（parse_source）和 `row.status`（failed）
 * 原样当标题/副标题显示。渲染层有中文映射表，但标题里的那一份它够不着 —— 所以
 * 翻译的责任在**产出文案的那一侧**，这里一次做完后，契约上的 status 仍保留机器
 * 原词供渲染层选图标与配色。
 */
const JOB_TYPE_LABELS: Record<string, string> = {
  parse_source: "来源解析",
  companion_agent: "伴星对话",
  companion_memory_extract: "伴星记忆提取",
  companion_summarizer: "伴星会话摘要",
  companion_daily_summary: "伴星每日总结",
  companion_memory_embedding_rebuild: "伴星记忆重建",
};

const JOB_STATUS_LABELS: Record<string, string> = {
  pending: "等待中",
  running: "进行中",
  succeeded: "已完成",
  failed: "失败",
  dead: "多次重试失败",
};

const RUN_PHASE_LABELS: Record<string, string> = {
  preparing: "准备中",
  active: "进行中",
  assessing: "评估中",
  checkpoint: "检查点",
  committing: "写入中",
  completed: "已完成",
  paused: "已暂停",
  abandoned: "已放弃",
};

const label = (table: Record<string, string>, key: string): string => table[key] ?? key;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 失败作业的追溯目标：解析作业载荷里的**真实来源 id**。
 *
 * v1 直接把 `job.id` 塞进 `kind: "source"` —— 读者点「查看」后拿 job uuid 去查来源，
 * 必然 404，job 类异常的追溯 100% 是死路。这里改成从精确契约里读 sourceId；读不到
 * （companion_* 作业没有来源、历史脏载荷）就返回 null，让页面老实地不给跳转。
 */
function sourceIdFromJobPayload(jobType: string, payload: unknown): ActivityTargetV1 | null {
  if (jobType !== JobType.PARSE_SOURCE) return null;
  try {
    const { sourceId } = readParseSourceJobPayload(payload as Record<string, unknown> | null);
    if (!UUID_RE.test(sourceId)) return null;
    return { kind: "source", id: sourceId, noteVersionId: null };
  } catch {
    return null;
  }
}

export type TodayActivityContext = {
  readonly workspaceId: string;
  readonly userId: string;
};

function dayKeyOf(instant: Date): string {
  const month = `${instant.getMonth() + 1}`.padStart(2, "0");
  const date = `${instant.getDate()}`.padStart(2, "0");
  return `${instant.getFullYear()}-${month}-${date}`;
}

/**
 * 服务端入口。窗口由客户端的本地日历日决定（ISO 带时区），服务端不做时区
 * 猜测；缺省时按服务器当前时刻所在的 UTC 日兜底。
 */
export async function getTodayActivity(
  tx: ApiTransaction,
  ctx: TodayActivityContext,
  window?: { readonly from: string; readonly to: string },
): Promise<TodayActivityV1> {
  const now = new Date();
  const from = window ? new Date(window.from) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = window ? new Date(window.to) : new Date(from.valueOf() + 86_400_000);
  if (!Number.isFinite(from.valueOf()) || !Number.isFinite(to.valueOf()) || to.valueOf() <= from.valueOf()) {
    throw new Error("activity_window_invalid");
  }

  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const [
    noteRows,
    sourceRows,
    objectiveRows,
    runRows,
    generationRows,
    jobRows,
    anomalyGenerationRows,
    anomalyJobRows,
    stuckRunRows,
  ] = await Promise.all([
    // 笔记：当天创建，或当天更新（且创建不在当天 —— 避免一篇笔记占两行）。
    tx
      .select({ id: notes.id, title: notes.title, currentVersionId: notes.currentVersionId, createdAt: notes.createdAt, updatedAt: notes.updatedAt })
      .from(notes)
      .where(and(
        eq(notes.workspaceId, ctx.workspaceId),
        isNull(notes.deletedAt),
        or(
          and(gte(notes.createdAt, from), lt(notes.createdAt, to)),
          and(gte(notes.updatedAt, from), lt(notes.updatedAt, to), lt(notes.createdAt, from)),
        ),
      ))
      .limit(SOURCE_LIMIT),
    tx
      .select({ id: sources.id, title: sources.title, type: sources.type, createdAt: sources.createdAt })
      .from(sources)
      .where(and(eq(sources.workspaceId, ctx.workspaceId), gte(sources.createdAt, from), lt(sources.createdAt, to)))
      .limit(SOURCE_LIMIT),
    // 理解目标：active 目标当天建立；概念名来自当前修订。
    tx
      .select({ objectiveId: learningObjectivesV2.objectiveId, createdAt: learningObjectivesV2.createdAt, conceptLabel: learningObjectiveRevisionsV2.conceptLabel, statement: learningObjectiveRevisionsV2.objectiveStatement })
      .from(learningObjectivesV2)
      .leftJoin(
        learningObjectiveRevisionsV2,
        and(
          eq(learningObjectivesV2.workspaceId, learningObjectiveRevisionsV2.workspaceId),
          eq(learningObjectivesV2.currentObjectiveRevisionId, learningObjectiveRevisionsV2.objectiveRevisionId),
        ),
      )
      .where(and(
        eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
        eq(learningObjectivesV2.lifecycle, "active"),
        gte(learningObjectivesV2.createdAt, from),
        lt(learningObjectivesV2.createdAt, to),
      ))
      .limit(SOURCE_LIMIT),
    tx
      .select({ id: learningRuns.id, goal: learningRuns.goal, phase: learningRuns.phase, createdAt: learningRuns.createdAt, updatedAt: learningRuns.updatedAt })
      .from(learningRuns)
      .where(and(
        eq(learningRuns.workspaceId, ctx.workspaceId),
        eq(learningRuns.userId, ctx.userId),
        or(
          and(gte(learningRuns.createdAt, from), lt(learningRuns.createdAt, to)),
          and(eq(learningRuns.phase, "completed"), gte(learningRuns.updatedAt, from), lt(learningRuns.updatedAt, to)),
        ),
      ))
      .limit(SOURCE_LIMIT),
    tx
      .select({ id: cardGenerationRunsV2.id, status: cardGenerationRunsV2.status, createdAt: cardGenerationRunsV2.createdAt, updatedAt: cardGenerationRunsV2.updatedAt, noteTitle: notes.title })
      .from(cardGenerationRunsV2)
      .innerJoin(notes, and(eq(cardGenerationRunsV2.workspaceId, notes.workspaceId), eq(cardGenerationRunsV2.noteId, notes.id)))
      .where(and(
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationRunsV2.userId, ctx.userId),
        or(
          and(gte(cardGenerationRunsV2.createdAt, from), lt(cardGenerationRunsV2.createdAt, to)),
          and(eq(cardGenerationRunsV2.status, "review_ready"), gte(cardGenerationRunsV2.updatedAt, from), lt(cardGenerationRunsV2.updatedAt, to)),
        ),
      ))
      .limit(SOURCE_LIMIT),
    // 只记用户触发的后台任务；系统任务（requestedBy 为空）不属于"用户做了什么"。
    tx
      .select({ id: jobs.id, type: jobs.type, status: jobs.status, scheduledAt: jobs.scheduledAt, finishedAt: jobs.finishedAt })
      .from(jobs)
      .where(and(
        eq(jobs.workspaceId, ctx.workspaceId),
        eq(jobs.requestedBy, ctx.userId),
        gte(jobs.scheduledAt, from),
        lt(jobs.scheduledAt, to),
      ))
      .limit(SOURCE_LIMIT),
    // ── 异常追溯 ──────────────────────────────────────────────────────────
    // 生成任务停在需要人处理的状态：不限当天，需要处理的就该被看见。
    tx
      .select({ id: cardGenerationRunsV2.id, status: cardGenerationRunsV2.status, updatedAt: cardGenerationRunsV2.updatedAt, noteTitle: notes.title })
      .from(cardGenerationRunsV2)
      .innerJoin(notes, and(eq(cardGenerationRunsV2.workspaceId, notes.workspaceId), eq(cardGenerationRunsV2.noteId, notes.id)))
      .where(and(
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationRunsV2.userId, ctx.userId),
        inArray(cardGenerationRunsV2.status, ["needs_attention", "failed", "stale"]),
      ))
      .orderBy(sql`${cardGenerationRunsV2.updatedAt} desc`)
      .limit(ANOMALY_SOURCE_LIMIT),
    tx
      .select({ id: jobs.id, type: jobs.type, status: jobs.status, scheduledAt: jobs.scheduledAt, finishedAt: jobs.finishedAt, lastError: jobs.lastError, payload: jobs.payload })
      .from(jobs)
      .where(and(
        eq(jobs.workspaceId, ctx.workspaceId),
        eq(jobs.requestedBy, ctx.userId),
        inArray(jobs.status, ["failed", "dead"]),
        gte(jobs.finishedAt, from),
        lt(jobs.finishedAt, to),
      ))
      .limit(ANOMALY_SOURCE_LIMIT),
    tx
      .select({ id: learningRuns.id, goal: learningRuns.goal, phase: learningRuns.phase, updatedAt: learningRuns.updatedAt })
      .from(learningRuns)
      .where(and(
        eq(learningRuns.workspaceId, ctx.workspaceId),
        eq(learningRuns.userId, ctx.userId),
        ne(learningRuns.phase, "paused"),
        inArray(learningRuns.phase, ["preparing", "active", "assessing", "checkpoint", "committing"]),
        lt(learningRuns.updatedAt, new Date(now.valueOf() - STUCK_RUN_MS)),
      ))
      .orderBy(sql`${learningRuns.updatedAt} desc`)
      .limit(ANOMALY_SOURCE_LIMIT),
  ]);

  const truncated = noteRows.length >= SOURCE_LIMIT
    || sourceRows.length >= SOURCE_LIMIT
    || objectiveRows.length >= SOURCE_LIMIT
    || runRows.length >= SOURCE_LIMIT
    || generationRows.length >= SOURCE_LIMIT
    || jobRows.length >= SOURCE_LIMIT;

  const events: ActivityEventV1[] = [];
  for (const row of noteRows) {
    if (row.createdAt >= from && row.createdAt < to) {
      events.push({
        id: `note.created:${row.id}`,
        at: row.createdAt.toISOString(),
        kind: "note",
        verb: "note.created",
        title: row.title,
        detail: null,
        target: { kind: "note", id: row.id, noteVersionId: row.currentVersionId },
      });
    } else {
      events.push({
        id: `note.updated:${row.id}`,
        at: row.updatedAt.toISOString(),
        kind: "note",
        verb: "note.updated",
        title: row.title,
        detail: null,
        target: { kind: "note", id: row.id, noteVersionId: row.currentVersionId },
      });
    }
  }
  for (const row of sourceRows) {
    events.push({
      id: `source.created:${row.id}`,
      at: row.createdAt.toISOString(),
      kind: "source",
      verb: "source.created",
      title: row.title,
      detail: row.type,
      target: { kind: "source", id: row.id, noteVersionId: null },
    });
  }
  for (const row of objectiveRows) {
    events.push({
      id: `objective.created:${row.objectiveId}`,
      at: row.createdAt.toISOString(),
      kind: "objective",
      verb: "objective.created",
      title: row.conceptLabel ?? row.statement ?? "未命名理解目标",
      detail: null,
      target: { kind: "objective", id: row.objectiveId, noteVersionId: null },
    });
  }
  for (const row of runRows) {
    const goalLabel = RUN_GOAL_LABELS[row.goal] ?? row.goal;
    if (row.createdAt >= from && row.createdAt < to && row.phase !== "completed") {
      events.push({
        id: `learning_run.started:${row.id}`,
        at: row.createdAt.toISOString(),
        kind: "learning_run",
        verb: "learning_run.started",
        title: `开始${goalLabel}学习旅程`,
        detail: null,
        target: null,
      });
    }
    if (row.phase === "completed" && row.updatedAt >= from && row.updatedAt < to) {
      events.push({
        id: `learning_run.completed:${row.id}`,
        at: row.updatedAt.toISOString(),
        kind: "learning_run",
        verb: "learning_run.completed",
        title: `完成${goalLabel}学习旅程`,
        detail: null,
        target: null,
      });
    }
  }
  for (const row of generationRows) {
    if (row.createdAt >= from && row.createdAt < to) {
      events.push({
        id: `card_generation.started:${row.id}`,
        at: row.createdAt.toISOString(),
        kind: "card_generation",
        verb: "card_generation.started",
        title: `为《${row.noteTitle}》发起卡片生成`,
        detail: null,
        target: { kind: "card_generation", id: row.id, noteVersionId: null },
      });
    }
    if (row.status === "review_ready" && row.updatedAt >= from && row.updatedAt < to) {
      events.push({
        id: `card_generation.review_ready:${row.id}`,
        at: row.updatedAt.toISOString(),
        kind: "card_generation",
        verb: "card_generation.review_ready",
        title: `《${row.noteTitle}》的候选卡等待审核`,
        detail: null,
        target: { kind: "card_generation", id: row.id, noteVersionId: null },
      });
    }
  }
  for (const row of jobRows) {
    events.push({
      id: `job.scheduled:${row.id}`,
      at: row.scheduledAt.toISOString(),
      kind: "job",
      verb: "job.scheduled",
      title: label(JOB_TYPE_LABELS, row.type),
      detail: label(JOB_STATUS_LABELS, row.status),
      target: null,
    });
  }

  // ISO 串同格式（UTC、`Z` 结尾）→ 字典序即时间序，localeCompare 是白花的开销
  // 且受 locale 排序规则影响；id 兜底保证同一时刻的行序在刷新间稳定。
  events.sort((left, right) => (right.at < left.at ? -1 : right.at > left.at ? 1 : left.id.localeCompare(right.id)));
  const overflow = events.length > EVENTS_MAX;

  const anomalies: ActivityAnomalyV1[] = [];
  for (const row of anomalyGenerationRows) {
    const detail = row.status === "failed"
      ? "这次生成没有产出可用候选卡，可以重新发起"
      : row.status === "stale"
        ? "笔记内容已经变化，候选卡需要重新对齐证据"
        : "等你确认之后，这次生成才能继续";
    anomalies.push({
      id: `anomaly.card_generation:${row.id}`,
      kind: "card_generation",
      status: row.status,
      // 标题里不带机器 status：中文句子里嵌 needs_attention 是给读者添乱，
      // 状态词由渲染层按 status 映射后另起一行显示。
      title: `《${row.noteTitle}》的卡片生成`,
      detail,
      occurredAt: row.updatedAt.toISOString(),
      target: { kind: "card_generation", id: row.id, noteVersionId: null },
    });
  }
  for (const row of anomalyJobRows) {
    const target = sourceIdFromJobPayload(row.type, row.payload);
    anomalies.push({
      id: `anomaly.job:${row.id}`,
      kind: "job",
      status: row.status,
      // 状态已由 `status` 单独表达，标题只负责说明“哪一种处理”。把“失败”
      // 再拼进标题会在客户端读成“伴星对话多次重试失败 / 多次重试失败 · …”。
      title: label(JOB_TYPE_LABELS, row.type),
      detail: row.lastError?.slice(0, 200) ?? (target ? "打开来源可以重新解析或换一份材料。" : null),
      // 用真实的调度时刻兜底，而不是拿窗口起点造一个时间戳。
      occurredAt: (row.finishedAt ?? row.scheduledAt).toISOString(),
      target,
    });
  }
  for (const row of stuckRunRows) {
    anomalies.push({
      id: `anomaly.learning_run:${row.id}`,
      kind: "learning_run",
      status: row.phase,
      title: `${RUN_GOAL_LABELS[row.goal] ?? row.goal}学习旅程超过 24 小时没有进展`,
      detail: `停在${label(RUN_PHASE_LABELS, row.phase)}阶段，可以放弃后重新发起`,
      occurredAt: row.updatedAt.toISOString(),
      // 这是一次学习旅程，不是某张到期复习卡。传真实 run id，
      // renderer 才能回到这一次旅程；伪装成 review 只会打开无关的通用队列。
      target: { kind: "learning_run", id: row.id, noteVersionId: null },
    });
  }
  anomalies.sort((left, right) =>
    right.occurredAt < left.occurredAt ? -1 : right.occurredAt > left.occurredAt ? 1 : left.id.localeCompare(right.id),
  );
  const anomaliesOverflow = anomalies.length > ANOMALY_MAX;

  return todayActivityV1Schema.parse({
    // 窗口起点是"客户端本地午夜"这个瞬间；用服务器本地钟去读它的年月日会整体
    // 偏移一天（UTC+8 用户的午夜在 UTC 上还是前一天）。取窗口中点（+12h）后
    // 任何 ±12h 内的时区都能落回读者自己的那一天。
    day: dayKeyOf(new Date(from.valueOf() + 12 * 60 * 60 * 1000)),
    windowStart: fromIso,
    windowEnd: toIso,
    generatedAt: now.toISOString(),
    events: overflow ? events.slice(0, EVENTS_MAX) : events,
    anomalies: anomaliesOverflow ? anomalies.slice(0, ANOMALY_MAX) : anomalies,
    truncated: truncated || overflow,
    anomaliesTruncated: anomaliesOverflow,
  });
}
