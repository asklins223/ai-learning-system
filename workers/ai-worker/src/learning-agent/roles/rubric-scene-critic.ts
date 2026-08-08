/**
 * Rubric / Scene Critic 角色骨架（阶段 03 / W2 任务 03-1，scene-safety-v1 于任务 03-3）
 *
 * 职责（03-4 actor 矩阵 / 01-2 §3.3）：
 * - 只读 private Scene staging（read_private_scene_staging，不向用户展示）；
 * - 按 scene-safety-v1 输出激活 verdict（submit_scene_critic_verdict）。
 *
 * 禁止项（03-4 / 01-3 §4）：
 * - **不得把 staging/verdict 展示给用户**（RUBRIC_AND_SCENE_PREPARE 子流程不向用户展示）；
 * - 不得参与辅导 / 出题（不生成 probe，不读用户回答）；
 * - 不得签发生效业务 outcome（不签发 trust / mastery / schedule）；
 * - 不得修改 artifact / staging；
 * - 不得跳过本 Critic（scene-safety-v1 对动态 formal Scene 是 mandatory）。
 *
 * 本文件仅骨架：实现于 W2 后续任务（03-3）。
 */

import {
  LearningAgentRole,
  LearningToolId,
  type LearningRoleSpec,
} from "../types.ts";

/** 创建 Rubric / Scene Critic 角色规格 */
export function createRubricSceneCriticRole(): LearningRoleSpec {
  return {
    role: LearningAgentRole.RUBRIC_SCENE_CRITIC,
    description:
      "独立 Rubric / Scene Critic：只读 private Scene staging，输出 scene-safety-v1 激活 verdict；不展示给用户、不签发生效业务 outcome。",
    allowedToolIds: [
      LearningToolId.READ_PRIVATE_SCENE_STAGING,
      LearningToolId.SUBMIT_SCENE_CRITIC_VERDICT,
    ],
  };
}
