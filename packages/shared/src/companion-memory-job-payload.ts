/**
 * 伴星记忆类 job 的 payload 契约（设计 P1-8，2026-09-15 审计）。
 *
 * 背景：这些 job 的 payload 落在 `jobs.payload`（jsonb），没有 schema 约束。
 * 写入侧（apps/api/src/modules/job/service.ts）与 4 个 worker handler
 * （companion-daily-summary / memory-embedding / memory-extractor / summarizer）
 * 此前各自用**字符串字面量**读写 `userId` / `runId` / `conversationId` /
 * `date` / `timezone`：字段改名时编译器不报错，只会在运行时以"payload 缺 X"暴露，
 * 且 5 处必须同步改。
 *
 * 这里把字段名与读取形式上收到唯一入口——字段名只有一份，键名由类型约束，
 * 改名后编译器会在所有调用点报错（而不是等到运行时）。
 */

/** 伴星记忆类 job payload 的字段名常量（写入侧与读取侧共用）。 */
export const COMPANION_MEMORY_JOB_PAYLOAD_FIELDS = {
  /** 可信 actor：API 侧由会话写入（job/service.ts 的 requestedBy）。 */
  userId: "userId",
  runId: "runId",
  conversationId: "conversationId",
  date: "date",
  timezone: "timezone",
  /**
   * 跨进程关联 id（设计 P1-15，2026-09-15 审计）：API 在请求上下文里取
   * `request.id` 写入，worker 处理该 job 时打进日志，两端可用同一 id 串起来。
   */
  traceId: "traceId",
} as const;

/** 伴星记忆类 job payload 的已知字段（其余字段由各 job 自行约定）。 */
export interface CompanionMemoryJobPayload {
  userId?: string;
  runId?: string;
  conversationId?: string;
  date?: string;
  timezone?: string;
  traceId?: string;
}

export type CompanionMemoryJobPayloadKey = keyof typeof COMPANION_MEMORY_JOB_PAYLOAD_FIELDS;

/**
 * 从 jsonb payload（形状不可信）中读取一个非空字符串字段。
 *
 * 返回 undefined 表示"缺失或类型不对"——调用方按各自契约决定是抛错还是降级
 * （既有 4 个 handler 都是抛错，语义不变）。
 */
export function readJobPayloadString(
  payload: unknown,
  key: CompanionMemoryJobPayloadKey,
): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[COMPANION_MEMORY_JOB_PAYLOAD_FIELDS[key]];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 写入侧：把可信 actor 注入 payload（字段名取自上面的常量，避免两侧漂移）。
 * actor 为 null 时仍然写入 null（保持既有行为：`{ ...payload, userId: null }`）。
 */
export function withCompanionActor<T extends Record<string, unknown>>(
  payload: T,
  actorUserId: string | null,
): T & { userId: string | null } {
  return { ...payload, [COMPANION_MEMORY_JOB_PAYLOAD_FIELDS.userId]: actorUserId };
}
