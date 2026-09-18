/**
 * Page 14 「今日学习」重构合同：当天操作日志流 + 状态异常事务追溯。
 *
 * 设计意图（用户 2026-09-18 复述）：今日学习不是"首页推荐位"，而是一份
 * 操作日志 —— 按时间顺序展示用户当天的真实操作，让用户感知"今天做了什么"；
 * 同时能追溯状态异常的事务；并作为 AI 伴星的数据源。
 *
 * 数据来源全部是权威表（不建平行真相，遵守 02-9 决策）：
 * notes / sources / learning_objectives_v2 / learning_runs /
 * card_generation_runs_v2 / jobs / assistant_page_contexts。
 * 伴星日记（doc 22）读的就是同一批权威表，因此这条日志流天然可持续供
 * 伴星读取；本合同只定义"页面与伴星共读的投影形状"。
 */
import { z } from "zod";
import { isoTimestampSchema, uuidSchema } from "./desktop-ipc-contracts.ts";

/** 日志条目种类。page = 使用痕迹（assistant_page_contexts 聚合）。 */
export const activityEventKindSchema = z.enum([
  "note",
  "source",
  "objective",
  "learning_run",
  "card_generation",
  "job",
  "page",
]);
export type ActivityEventKindV1 = z.infer<typeof activityEventKindSchema>;

/**
 * 日志条目的跳转目标。renderer 把 kind 映射到 RoomIntent：
 * note → open-notebook, objective → open-objective,
 * card_generation → open-card-generation, source → open-source,
 * review → review。`null` 表示只展示、不可跳转。
 */
export const activityTargetV1Schema = z.strictObject({
  kind: z.enum(["note", "objective", "card_generation", "review", "source"]),
  id: uuidSchema,
  noteVersionId: uuidSchema.nullable(),
});
export type ActivityTargetV1 = z.infer<typeof activityTargetV1Schema>;

/** 服务端发布的稳定动词键，renderer 据此取中文文案。 */
export const activityEventVerbSchema = z.enum([
  "note.created",
  "note.updated",
  "source.created",
  "objective.created",
  "learning_run.started",
  "learning_run.completed",
  "card_generation.started",
  "card_generation.review_ready",
  "job.scheduled",
  "page.viewed",
]);
export type ActivityEventVerbV1 = z.infer<typeof activityEventVerbSchema>;

export const activityEventV1Schema = z.strictObject({
  /** 稳定 React key：`${verb}:${entityId}`。 */
  id: z.string().min(1).max(200),
  /** 事件发生时刻（ISO，带时区）。 */
  at: isoTimestampSchema,
  kind: activityEventKindSchema,
  verb: activityEventVerbSchema,
  title: z.string().min(1).max(300),
  detail: z.string().max(400).nullable(),
  target: activityTargetV1Schema.nullable(),
});
export type ActivityEventV1 = z.infer<typeof activityEventV1Schema>;

/**
 * 状态异常的事务：今天（或近期）需要用户追溯处理的失败/卡住记录。
 *
 * target **可以为空**：追溯的前提是"有个地方可去"。后台任务的载荷里解析不出
 * 来源 id 时，服务端不知道该把读者送到哪一页 —— 这时老实返回 null，让页面
 * 渲染"无法跳转"，而不是拿 job id 冒充 source id 把读者送进 404（这是 v1
 * 的真实缺陷：job 类异常的「查看」100% 落到来源详情的失败态）。
 */
export const activityAnomalyV1Schema = z.strictObject({
  id: z.string().min(1).max(200),
  kind: z.enum(["card_generation", "job", "learning_run"]),
  /** 服务端状态原词（needs_attention / failed / stale / job status / run phase）。 */
  status: z.string().min(1).max(40),
  title: z.string().min(1).max(300),
  detail: z.string().max(400).nullable(),
  occurredAt: isoTimestampSchema,
  target: activityTargetV1Schema.nullable(),
});
export type ActivityAnomalyV1 = z.infer<typeof activityAnomalyV1Schema>;

export const activityDayWindowV1Schema = z.strictObject({
  /** 客户端日历日的起点/终点（本地午夜锚点），服务端只按这个窗口查询。 */
  from: isoTimestampSchema,
  to: isoTimestampSchema,
});
export type ActivityDayWindowV1 = z.infer<typeof activityDayWindowV1Schema>;

export const todayActivityV1Schema = z.strictObject({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  windowStart: isoTimestampSchema,
  windowEnd: isoTimestampSchema,
  generatedAt: isoTimestampSchema,
  /** 按时间倒序（最新在前）。 */
  events: z.array(activityEventV1Schema),
  anomalies: z.array(activityAnomalyV1Schema),
  /** 任一事件源触到查询上限即为 true —— 日志不是完整账本时必须说出来。 */
  truncated: z.boolean(),
  /** 异常追溯触到总量上限。与 truncated 分开：这是"还有异常没列出"，不是"日志被截"。 */
  anomaliesTruncated: z.boolean(),
});
export type TodayActivityV1 = z.infer<typeof todayActivityV1Schema>;
