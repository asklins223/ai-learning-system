/**
 * 作业 payload 契约（按作业类型分型）。
 *
 * 审计事实（稳定 P1，2026-09-15）：`jobs.payload` 是 `jsonb NOT NULL`，drizzle 侧
 * 只标注为 `$type<Record<string, unknown>>`；生产端手写对象字面量（见
 * `apps/api/src/modules/source/service.ts` 的 parse_source 裸插入），消费端用
 * `job.payload.sourceId as string | undefined` 取值。后果是字段改名/漏传**没有任何
 * 编译期反馈**，只在运行期表现为 "missing sourceId in payload"，而且那条是**可重试**
 * 失败——重试三次才 dead letter，期间每次都在消耗租约。
 *
 * 本文件把**非 companion** 作业的 payload 收敛成精确契约（companion_* 的载荷由各自
 * 的契约模块负责，见 companion-memory-job-payload.ts，不在这里重复定义）：
 *
 *   - 生产端：`const payload: ParseSourceJobPayload = {...}` —— 漏字段、拼错字段、
 *     类型不对都直接编译失败；
 *   - 消费端：`readParseSourceJobPayload()` 校验 + 归一化，非法载荷抛
 *     `JobPayloadContractError`（**确定性失败**，worker 归类为不可重试，直接 dead）；
 *   - 新增非 companion 作业类型：登记进 `TypedJobPayloadByType` 即自动获得同样强度的
 *     约束；`JobPayloadFor<T>` 对未登记的类型（含 companion_*）回退为不透明 JSON，
 *     所以这份文件不会替 companion 侧做决定。
 *
 * 纯类型 + 常量 + 一个纯函数，无 node: 依赖，可从 index.ts 与子路径同时导入。
 */
import { JobType } from "./enums.ts";

export const PARSE_SOURCE_JOB_PAYLOAD_FIELDS = {
  sourceId: "sourceId",
  fetchUrlContent: "fetchUrlContent",
} as const;

/**
 * parse_source 的 payload。
 *
 * 刻意用 `type` 而不是 `interface`：interface 没有隐式索引签名，无法赋给
 * `Record<string, unknown>`（jobs.payload 的列类型），会让生产端插入处报类型错误。
 *
 * 历史字段 `userId` 已删除——生产端写、**无人读**：worker 只读 sourceId 与
 * fetchUrlContent（租户与 actor 归属一律走 `jobs.workspace_id` / `jobs.requested_by`，
 * 见 parse-source.ts），而 jobs 查询接口本来就把它从响应里脱敏掉（R-006）。
 * 契约只保留真实被消费的字段，避免"看着像有约定、其实没人看"的假契约。
 */
export type ParseSourceJobPayload = {
  sourceId: string;
  /** URL 类型来源且尚无正文时为 true：worker 需先抓取 URL 正文再分段。 */
  fetchUrlContent?: true;
};

/** 已强类型化的作业类型 → payload 契约映射（目前只有非 companion 的 parse_source）。 */
export type TypedJobPayloadByType = {
  [JobType.PARSE_SOURCE]: ParseSourceJobPayload;
};

export type TypedJobType = keyof TypedJobPayloadByType;

/**
 * 某个作业类型的 payload 形状：已登记的类型用精确契约，其余（companion_*）保持
 * 不透明 JSON——收紧只发生在明确登记过的类型上。
 *
 * "新增类型自动收紧"由这张表本身保证：往 TypedJobPayloadByType 加一个键，
 * 该类型的 payload 立刻从 Record<string, unknown> 变成精确契约，调用点会当场报错。
 * 因此不需要额外的运行期清单（那种清单只会多一处需要同步的真相）。
 */
export type JobPayloadFor<TJobType extends string> =
  TJobType extends TypedJobType ? TypedJobPayloadByType[TJobType] : Record<string, unknown>;

/** payload 与类型不符（确定性失败：重试不会让缺失字段出现）。 */
export class JobPayloadContractError extends Error {
  readonly code = "job_payload_contract_error";
  constructor(readonly jobType: string, message: string) {
    super(`${jobType}: ${message}`);
    this.name = "JobPayloadContractError";
  }
}

export type NormalizedParseSourceJobPayload = {
  sourceId: string;
  /** 归一化为布尔：只有字面 true 才算需要抓取。 */
  fetchUrlContent: boolean;
};

/**
 * 读取并校验 parse_source 的 payload（fail closed）。
 *
 * `fetchUrlContent` 只认字面 `true`：历史载荷里可能混入 `"true"`/`1` 之类的脏值，
 * 把它当成"要抓 URL"会对外发起非预期请求；而把它当成 false 的代价只是不抓正文，
 * 用户可以重试。两害相权取后者。
 */
export function readParseSourceJobPayload(
  payload: Record<string, unknown> | null | undefined,
): NormalizedParseSourceJobPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new JobPayloadContractError(JobType.PARSE_SOURCE, "payload must be a JSON object");
  }
  const rawSourceId = payload[PARSE_SOURCE_JOB_PAYLOAD_FIELDS.sourceId];
  if (typeof rawSourceId !== "string" || rawSourceId.trim() === "") {
    throw new JobPayloadContractError(
      JobType.PARSE_SOURCE,
      `payload.${PARSE_SOURCE_JOB_PAYLOAD_FIELDS.sourceId} must be a non-empty string`,
    );
  }
  return {
    sourceId: rawSourceId,
    fetchUrlContent:
      payload[PARSE_SOURCE_JOB_PAYLOAD_FIELDS.fetchUrlContent] === true,
  };
}
