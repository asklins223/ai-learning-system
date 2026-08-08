/**
 * Scene Author 角色骨架（阶段 03 / W2 任务 03-1，RUBRIC_AND_SCENE_PREPARE 于任务 03-3）
 *
 * 职责（03-4 actor 矩阵）：
 * - 只读当前 target 的已发布 claim/evidence（read_published_claim_evidence，canonical，确定性 Publish 之后）；
 * - 只读当前 Episode 的 private Rubric staging（read_private_rubric_staging，隔离 server-side staging）；
 * - 写未激活 Scene staging（submit_scene_staging，0 canonical write）。
 *
 * 禁止项（03-4 / 01-3 §4）：
 * - **不得激活或展示 Scene**（唯一激活权限属于 deterministic Scene Activation Service，
 *   Author/Supervisor/Critic/Companion 都没有 activate_scene_contract 权限，01-2 §3.3）；
 * - 不得读用户回答 / 个人音频 / 理解状态；
 * - 不得跨 target 检索（只读当前 target）；
 * - 不得签发 trust / outcome；
 * - 不得直接写 canonical Card / semantic relation / schedule。
 *
 * 本文件仅骨架：实现于 W2 后续任务（03-3）。
 */

import {
  LearningAgentRole,
  LearningToolId,
  type LearningRoleSpec,
} from "../types.ts";

/** 创建 Scene Author 角色规格 */
export function createSceneAuthorRole(): LearningRoleSpec {
  return {
    role: LearningAgentRole.SCENE_AUTHOR,
    description:
      "RUBRIC_AND_SCENE_PREPARE 子流程的 Scene 草案提出者：只读当前 target 已发布 claim/evidence 与 private Rubric staging，写未激活 Scene staging。",
    allowedToolIds: [
      LearningToolId.READ_PUBLISHED_CLAIM_EVIDENCE,
      LearningToolId.READ_PRIVATE_RUBRIC_STAGING,
      LearningToolId.SUBMIT_SCENE_STAGING,
    ],
  };
}
