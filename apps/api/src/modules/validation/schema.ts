import { z } from "zod";

/**
 * N-003: 验证提交 schema。
 *
 * 支持两种模式：
 * 1. questionId 模式（推荐）：客户端只提交 questionId + answer，题目由服务端持久化。
 * 2. 兼容模式：客户端提交完整 question/questionType + answer（向后兼容旧客户端）。
 *
 * 新客户端应使用 questionId 模式，确保题目身份可追溯。
 */
export const validationSubmitSchema = z.object({
  /** N-003: 服务端持久化的题目 ID */
  questionId: z.string().uuid().optional(),
  /** 要验证的 keyPointId；为空时取该 card 第一个 keyPoint */
  keyPointId: z.string().uuid().optional(),
  /** 兼容模式：客户端提交的题目类型 */
  questionType: z.enum(["explain", "example", "apply"]).optional(),
  /** 兼容模式：客户端提交的题目文本 */
  question: z.string().min(1).max(500).optional(),
  /** 用户答案 */
  userAnswer: z.string().min(1).max(10_000),
}).refine(
  (data) => data.questionId || (data.questionType && data.question),
  {
    message: "Either questionId or (questionType + question) must be provided",
  },
);

export type ValidationSubmitInput = z.infer<typeof validationSubmitSchema>;

/**
 * N-003: 创建验证题 schema。
 * 服务端生成并持久化验证题，返回 questionId 供客户端使用。
 */
export const createQuestionSchema = z.object({
  keyPointId: z.string().uuid().optional(),
  questionType: z.enum(["explain", "example", "apply"]),
  question: z.string().min(1).max(500),
});

export type CreateQuestionInput = z.infer<typeof createQuestionSchema>;
