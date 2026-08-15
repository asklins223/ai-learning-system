import { api } from "@/lib/api";
import type {
  CompanionGroundedTutorGrantV1,
  CompanionLearningSessionContextV1,
} from "@ailearn/shared";
import {
  companionGroundedTutorGrantV1Schema,
  companionLearningSessionContextV1Schema,
} from "@ailearn/shared";
import type {
  CreateLearningSessionInput,
  LearningAnswerResult,
  LearningAssessmentResult,
  LearningSessionPublicView,
} from "./contracts";

export const learningSessionClient = {
  /** 各方法均支持 signal 透传：卸载/取消时 abort 在途请求，避免迟到响应覆盖状态。 */
  create(input: CreateLearningSessionInput, signal?: AbortSignal): Promise<LearningSessionPublicView> {
    return api.createLearningSession(input, signal) as Promise<LearningSessionPublicView>;
  },
  get(sessionId: string, signal?: AbortSignal): Promise<LearningSessionPublicView> {
    return api.getLearningSession(sessionId, signal) as Promise<LearningSessionPublicView>;
  },
  getCompanionContext(
    sessionId: string,
    episodeId?: string,
    signal?: AbortSignal,
  ): Promise<CompanionLearningSessionContextV1> {
    return api.getCompanionLearningSessionContext(sessionId, episodeId, signal).then((body) =>
      companionLearningSessionContextV1Schema.parse(body)
    );
  },
  createCompanionContextGrant(
    args: {
      sessionId: string;
      episodeId: string;
      pageInstanceId: string;
      contextRevision: string;
    },
    signal?: AbortSignal,
  ): Promise<CompanionGroundedTutorGrantV1> {
    return api.createCompanionContextGrant(args.sessionId, {
      version: 1,
      pageInstanceId: args.pageInstanceId,
      episodeId: args.episodeId,
      contextRevision: args.contextRevision,
    }, signal).then((body) => companionGroundedTutorGrantV1Schema.parse(body));
  },
  answer(
    sessionId: string,
    episodeId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<LearningAnswerResult> {
    return this.answerWithModality(sessionId, episodeId, text, "text_or_mixed", signal);
  },
  /**
   * 任务 14：按模态提交回答（§3.6 多样性只在前端作答层，真相写入路径不变）。
   * - voice：canonical answer = 用户确认的逐字 transcript（04-1/04-2），
   *   走同一 answer 端点（服务端 modality=voice 已支持）；
   * - text_or_mixed：现状语义。
   */
  answerWithModality(
    sessionId: string,
    episodeId: string,
    text: string,
    modality: "text_or_mixed" | "voice",
    signal?: AbortSignal,
  ): Promise<LearningAnswerResult> {
    return api.submitLearningAnswer(sessionId, episodeId, { modality, text }, signal) as Promise<LearningAnswerResult>;
  },
  assess(
    sessionId: string,
    episodeId: string,
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<LearningAssessmentResult> {
    return api.assessLearningEpisode(sessionId, episodeId, artifactId, signal) as Promise<LearningAssessmentResult>;
  },
  end(sessionId: string, signal?: AbortSignal): Promise<LearningSessionPublicView> {
    return api.endLearningSession(sessionId, signal) as Promise<LearningSessionPublicView>;
  },
};
