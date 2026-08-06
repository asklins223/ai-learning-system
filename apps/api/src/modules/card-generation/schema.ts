import { z } from "zod";
import { decodeCursor } from "../../lib/pagination.ts";

/**
 * 创建生成任务请求 schema（计划 §12）。
 *
 * 新增 density 参数（计划 §11.2）：
 * - overview: 概览密度
 * - standard: 标准密度（默认）
 * - complete: 完整密度
 */
export const createCardGenerationRunSchema = z.object({
  noteVersionId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  /** 生成密度（计划 §11.2），默认 standard */
  density: z.enum(["overview", "standard", "complete"]).optional().default("standard"),
  /**
   * B1（计划 §2.4）：强制重新生成。
   * - false（默认）：如果同 fingerprint 的 succeeded run 存在，直接返回该 run（复用结果）。
   * - true：跳过 succeeded run 复用，创建新 epoch 全量重跑。
   */
  force: z.boolean().optional().default(false),
  /**
   * E2 阶段二（计划 §2.9）：反馈摘要。
   * 当 isFeedbackRegenerationEnabled() 为 true 时，
   * 前端可传入上一次 run 的质量报告聚合摘要，
   * 注入到下一 run 的 system prompt 作为补充段。
   * 不触碰可信判定链。
   */
  feedbackSummary: z.string().trim().max(2000).optional(),
});

export const generationEventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().default(0),
});

/**
 * /agent-events 分页查询参数（设计 §5.2）。
 *
 * - `since`：`(createdAt, id)` 复合游标（base64 编码的 `ISO时间:id`），
 *   语义为"返回严格晚于此游标的事件"；不传则从最早开始（兼容旧客户端）。
 * - `limit`：页大小，1–200，默认 200（与旧行为"最旧 200 条"一致）。
 */
export const agentEventsQuerySchema = z.object({
  since: z.string().max(200).refine((value) => decodeCursor(value) !== null, {
    message: "invalid cursor",
  }).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  /**
   * 是否返回 usage 计费/token 用量。默认不返回（体积考虑），
   * 由前端 flag 门控的可选增强开启。
   */
  includeUsage: z.coerce.boolean().optional().default(false),
});

export type CreateCardGenerationRunInput = z.input<typeof createCardGenerationRunSchema>;
export type CreateCardGenerationRunParsed = z.output<typeof createCardGenerationRunSchema>;
