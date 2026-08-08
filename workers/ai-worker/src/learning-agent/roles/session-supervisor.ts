/**
 * Session Supervisor 角色骨架（阶段 03 / W2 任务 03-1，外壳于任务 03-3）
 *
 * 职责（03-4 actor 矩阵）：
 * - 仅读净化 contract summary（read_purified_contract_summary，不含 hidden rubric/solution/evidence）；
 * - 默认提议一条路线（propose_bounded_route），"换一个"才生成备选；
 * - 从已审核模板提议 probe（propose_probe），不自由出题；
 * - typed spatial 编排：focus_nodes / draw_route / stage_scene；
 * - propose_episode_ready（提议进入评估）/ propose_end（提议结束）。
 *
 * 禁止项（03-4 / 01-3 §4 禁止清单）：
 * - **不得 lock/submit/enter-practice/commit**（本文件允许工具列表不含这些产品动作，
 *   网关对任意 actor 调用它们都确定性拒绝）；
 * - 不得读 hidden rubric / expected target / evidence（trusted 回答前）；
 * - 不得读内容性 gap 后继续 formal 出题（trusted 内容性 follow-up = 0，W0 冻结）；
 * - 不得签发生效 trust（只能请求 requestedTrustClass）；
 * - 不得直接派发/代签独立评估、不得写 mastery/schedule/published semantic relation/canonical Card
 *   （全程 0 canonical write）。
 *
 * 本文件仅骨架：实现于 W2 后续任务（03-2/03-3）。
 */

import {
  LearningAgentRole,
  LearningToolId,
  type LearningRoleSpec,
} from "../types.ts";

/** 创建 Session Supervisor 角色规格 */
export function createSessionSupervisorRole(): LearningRoleSpec {
  return {
    role: LearningAgentRole.SESSION_SUPERVISOR,
    description:
      "有界 SESSION_AGENT 编排者：净化合同读取、路线提议、probe 提议、Scene 编排、Episode ready/end 提议；全程 0 canonical write。",
    allowedToolIds: [
      LearningToolId.READ_PURIFIED_CONTRACT_SUMMARY,
      LearningToolId.PROPOSE_BOUNDED_ROUTE,
      LearningToolId.PROPOSE_PROBE,
      LearningToolId.FOCUS_NODES,
      LearningToolId.DRAW_ROUTE,
      LearningToolId.STAGE_SCENE,
      LearningToolId.PROPOSE_EPISODE_READY,
      LearningToolId.PROPOSE_END,
    ],
  };
}
