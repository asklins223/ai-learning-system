import { and, eq } from "drizzle-orm";
import { withWorkspaceTransaction, SYSTEM_USER_ID, type ApiTransaction } from "../../db/client.ts";
import { validationEvents, evidences, validationQuestions } from "../../db/schema/evidence.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import { createJob } from "../job/service.ts";
import { JobType } from "@ailearn/shared";
import {
  effectiveAlignmentForUser,
  getUserOverrideMap,
} from "../../lib/evidence.ts";
import type { ValidationSubmitInput, CreateQuestionInput } from "./schema.ts";
import { activeLearningCardConsumerPredicate } from "../card/consumer-eligibility.ts";
// OPS-01: Funnel 指标（ADR-0006 §2）
import { recordFunnelEvent } from "../../lib/metrics.ts";

/**
 * 检查 keyPoint 是否有硬证据。
 *
 * QUAL-58/SEC-26 修复：接受可选的事务参数，在 withWorkspaceTransaction 上下文内复用。
 */
async function keyPointHasHardEvidence(
  keyPointId: string,
  workspaceId: string,
  userId: string,
  tx: ApiTransaction,
): Promise<boolean> {
  const keyPointEvidences = await tx.query.evidences.findMany({
    where: and(
      eq(evidences.keyPointId, keyPointId),
      eq(evidences.workspaceId, workspaceId),
    ),
  });
  const userOverrideMap = await getUserOverrideMap(
    userId,
    keyPointEvidences.map((evidence) => evidence.id),
    tx,
  );
  return keyPointEvidences.some(
    (evidence) => effectiveAlignmentForUser(
      evidence.alignment,
      evidence.userOverride,
      userOverrideMap.get(evidence.id) ?? null,
    ) === "aligned",
  );
}

/**
 * N-003: 服务端创建验证题，持久化到 validation_questions 表。
 * 绑定 card/keyPoint/noteVersion，返回 questionId 供客户端使用。
 *
 * QUAL-58/SEC-26 修复：使用 withWorkspaceTransaction 确保 RLS 上下文可用。
 */
export async function createValidationQuestion(
  cardId: string,
  workspaceId: string,
  userId: string,
  input: CreateQuestionInput,
) {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
  // 校验 card 归属
  const card = await tx.query.learningCards.findFirst({
    where: and(
      eq(learningCards.id, cardId),
      eq(learningCards.workspaceId, workspaceId),
      activeLearningCardConsumerPredicate(),
    ),
  });
  if (!card) return null;

  // 校验/确定 keyPoint
  let keyPointId = input.keyPointId;
  if (!keyPointId) {
    const first = await tx.query.cardKeyPoints.findFirst({
      where: and(
        eq(cardKeyPoints.cardId, cardId),
        eq(cardKeyPoints.workspaceId, workspaceId),
      ),
    });
    keyPointId = first?.id ?? undefined;
  } else {
    const kp = await tx.query.cardKeyPoints.findFirst({
      where: and(
        eq(cardKeyPoints.id, keyPointId),
        eq(cardKeyPoints.cardId, cardId),
        eq(cardKeyPoints.workspaceId, workspaceId),
      ),
    });
    if (!kp) return null;
  }

  if (!keyPointId) {
    return { error: "no_key_point" as const };
  }

  // N-004: 服务端强制校验目标 keyPoint 的硬证据门槛
  if (!await keyPointHasHardEvidence(keyPointId, workspaceId, userId, tx)) {
    return { error: "no_hard_evidence" as const };
  }

  // 持久化题目
  const [question] = await tx
    .insert(validationQuestions)
    .values({
      workspaceId,
      cardId,
      keyPointId,
      noteVersionId: card.noteVersionId,
      questionType: input.questionType,
      question: input.question,
      createdBy: userId,
      // 题目 24 小后过期
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning();

  return { questionId: question.id };
    },
  );
}

/**
 * 提交一次理解验证：跨租户校验 card 存在，入队 evaluate_validation job。
 * N-003: 支持 questionId 模式（从服务端持久化的题目获取 question/questionType）。
 *
 * QUAL-58/SEC-26 修复：使用 withWorkspaceTransaction 确保 RLS 上下文可用。
 */
export async function submitValidation(
  cardId: string,
  workspaceId: string,
  userId: string,
  input: ValidationSubmitInput,
) {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
  // 跨租户校验 card
  const card = await tx.query.learningCards.findFirst({
    where: and(
      eq(learningCards.id, cardId),
      eq(learningCards.workspaceId, workspaceId),
      activeLearningCardConsumerPredicate(),
    ),
  });
  if (!card) return null;

  let keyPointId: string | undefined;
  let questionType: string;
  let question: string;
  let questionId: string | undefined;

  if (input.questionId) {
    // N-003: 从服务端持久化的题目获取信息
    const q = await tx.query.validationQuestions.findFirst({
      where: and(
        eq(validationQuestions.id, input.questionId),
        eq(validationQuestions.workspaceId, workspaceId),
        eq(validationQuestions.cardId, cardId),
      ),
    });
    if (!q) return { error: "invalid_question" as const };
    // 检查题目是否过期
    if (q.expiresAt && q.expiresAt <= new Date()) {
      return { error: "question_expired" as const };
    }
    keyPointId = q.keyPointId ?? undefined;
    questionType = q.questionType;
    question = q.question;
    questionId = q.id;
  } else {
    // 兼容模式：使用客户端提交的题目
    questionType = input.questionType!;
    question = input.question!;
    keyPointId = input.keyPointId;
  }

  // 若未指定 keyPoint，取该 card 第一个 keyPoint
  if (!keyPointId) {
    const first = await tx.query.cardKeyPoints.findFirst({
      where: and(
        eq(cardKeyPoints.cardId, cardId),
        eq(cardKeyPoints.workspaceId, workspaceId),
      ),
    });
    keyPointId = first?.id ?? undefined;
  } else {
    // 校验 keyPoint 归属该 card
    const kp = await tx.query.cardKeyPoints.findFirst({
      where: and(
        eq(cardKeyPoints.id, keyPointId),
        eq(cardKeyPoints.cardId, cardId),
        eq(cardKeyPoints.workspaceId, workspaceId),
      ),
    });
    if (!kp) return null;
  }

  // card 无 keyPoint 时提前拒绝
  if (!keyPointId) {
    return { error: "no_key_point" as const };
  }

  // N-004: 服务端强制校验目标 keyPoint 的硬证据门槛
  if (!await keyPointHasHardEvidence(keyPointId, workspaceId, userId, tx)) {
    return { error: "no_hard_evidence" as const };
  }

  const job = await createJob({
    type: JobType.EVALUATE_VALIDATION,
    workspaceId,
    requestedBy: userId,
    payload: {
      cardId,
      keyPointId,
      questionType,
      question,
      userAnswer: input.userAnswer,
      userId,
      // N-003: 传递 questionId 和 jobId 供 worker 绑定
      ...(questionId ? { questionId } : {}),
    },
  });

  // OPS-01: Funnel 指标 — 验证提交
  recordFunnelEvent("validation_submitted");

  return { jobId: job.id };
    },
  );
}

/** 列某张学习卡的验证历史
 * F-011: 按 userId 隔离，普通成员只能看到自己的验证记录
 *
 * QUAL-58/SEC-26 修复：使用 withWorkspaceTransaction 确保 RLS 上下文可用。
 */
export async function listValidations(cardId: string, workspaceId: string, userId?: string) {
  return withWorkspaceTransaction(
    { workspaceId, userId: userId ?? SYSTEM_USER_ID },
    async (tx) => {
  // 先校验 card 归属
  const card = await tx.query.learningCards.findFirst({
    where: and(eq(learningCards.id, cardId), eq(learningCards.workspaceId, workspaceId)),
  });
  if (!card) return null;
  const conditions = [
    eq(validationEvents.cardId, cardId),
    eq(validationEvents.workspaceId, workspaceId),
  ];
  // F-011: 若指定 userId 则按用户过滤
  if (userId) {
    conditions.push(eq(validationEvents.userId, userId));
  }
  return tx.query.validationEvents.findMany({
    where: and(...conditions),
    orderBy: (v, { desc: d }) => [d(v.createdAt)],
    limit: 20,
  });
    },
  );
}

/** 取单条验证结果（含 feedback）
 *
 * QUAL-58/SEC-26 修复：使用 withWorkspaceTransaction 确保 RLS 上下文可用。
 */
export async function getValidation(id: string, workspaceId: string, userId?: string) {
  return withWorkspaceTransaction(
    { workspaceId, userId: userId ?? SYSTEM_USER_ID },
    async (tx) => {
  const conditions = [
    eq(validationEvents.id, id),
    eq(validationEvents.workspaceId, workspaceId),
  ];

  // F-011: 若指定 userId 则按用户过滤，确保用户只能访问自己的验证记录
  if (userId) {
    conditions.push(eq(validationEvents.userId, userId));
  }

  return tx.query.validationEvents.findFirst({
    where: and(...conditions),
  });
    },
  );
}

/**
 * N-003: 按 jobId 查询验证结果。
 * 客户端提交验证后获得 jobId，可通过此接口直接取回结果，
 * 不再需要通过 key point、题目、答案和时间窗猜测匹配。
 *
 * QUAL-58/SEC-26 修复：使用 withWorkspaceTransaction 确保 RLS 上下文可用。
 */
export async function getValidationByJobId(jobId: string, workspaceId: string, userId?: string) {
  return withWorkspaceTransaction(
    { workspaceId, userId: userId ?? SYSTEM_USER_ID },
    async (tx) => {
  const conditions = [
    eq(validationEvents.jobId, jobId),
    eq(validationEvents.workspaceId, workspaceId),
  ];

  if (userId) {
    conditions.push(eq(validationEvents.userId, userId));
  }

  return tx.query.validationEvents.findFirst({
    where: and(...conditions),
  });
    },
  );
}
