/**
 * Learning Tool Manifest（阶段 03 / W2 任务 03-1，规范 03-4 §5.3/§5.4）
 *
 * - typed spatial actions（原方案 §5.3）：伴星优先使用的动作；
 *   模型不能返回任意 DOM、CSS、HTML 或脚本；
 * - Global Shell 确定性产品动作（§5.4）：页面导航/引导/静态帮助，
 *   不能创建 Episode、直接修改领域数据或被模型自由拼装。
 *
 * 本文件仅骨架：各动作的参数 schema（Zod，additionalProperties:false）、
 * 幂等键与 DTO 序列化实现于 W2 后续任务（03-4 executor / public DTO serializer）。
 */

import type { LearningAgentRole, LearningToolId } from "../types.ts";
import { LearningToolId as T } from "../types.ts";

// ─── 1. typed spatial actions（§5.3，9 个） ───────────────────────────────

/** 伴星 typed spatial actions：模型只能返回这些动作，不能返回任意前端代码 */
export const SPATIAL_ACTIONS = [
  T.FOCUS_NODES,
  T.DRAW_ROUTE,
  T.STAGE_SCENE,
  T.READ_PROMPT,
  T.OFFER_BRANCH,
  T.SHOW_CHANGE,
  T.PROPOSE_CURIOSITY_SAVE,
  T.RETURN_TO_ORIGIN,
  T.END_SESSION,
] as const;
export type SpatialAction = (typeof SPATIAL_ACTIONS)[number];

// ─── 2. Global Shell 确定性产品动作（§5.4，9 个） ─────────────────────────

/** Global Companion Shell 动作：页面导航/首次引导/静态帮助，不创建 Session、不借用 learning budget */
export const GLOBAL_SHELL_ACTIONS = [
  T.SPOTLIGHT_UI_ANCHOR,
  T.OPEN_PAGE_HELP,
  T.PREVIEW_NAVIGATION,
  T.RESUME_ONBOARDING,
  T.RESUME_CHECKPOINT,
  T.SHOW_PERMISSION_SCOPE,
  T.DISMISS_SUGGESTION,
  T.PREVIEW_REGISTERED_PAGE_ACTION,
  T.REQUEST_PAGE_ACTION_CONFIRMATION,
] as const;
export type GlobalShellAction = (typeof GLOBAL_SHELL_ACTIONS)[number];

// ─── 3. 完整 manifest ────────────────────────────────────────────────────

/** 工具分类 */
export type LearningToolCategory =
  | "spatial_action"
  | "global_shell_action"
  | "agent_internal_tool"
  | "forbidden_product_action";

/** 清单条目 */
export interface LearningToolManifestEntry {
  toolId: LearningToolId;
  category: LearningToolCategory;
  description: string;
  /** 是否有副作用（需要幂等键；01-3 §5 side-effect tool 同一事务记录 result event + staging mutation） */
  hasSideEffect: boolean;
  /** 允许该工具的 actor 提示（仅供阅读/文档；强制执行在 LearningToolGateway） */
  actorHint: readonly LearningAgentRole[];
}

const buildManifest = (): readonly LearningToolManifestEntry[] => {
  const entries: LearningToolManifestEntry[] = [];
  const push = (entry: LearningToolManifestEntry): void => {
    entries.push(entry);
  };

  // typed spatial actions：由伴星呈现，任何 LLM actor 都不得自由拼装前端代码
  push({ toolId: T.FOCUS_NODES, category: "spatial_action", description: "聚焦画布节点（有界、仅当前 target/Scene）。", hasSideEffect: false, actorHint: ["session_supervisor"] });
  push({ toolId: T.DRAW_ROUTE, category: "spatial_action", description: "在场景画布绘制路线。", hasSideEffect: false, actorHint: ["session_supervisor"] });
  push({ toolId: T.STAGE_SCENE, category: "spatial_action", description: "布置/呈现 Scene（仅已激活的 public contract；supervisor 编排用）。", hasSideEffect: false, actorHint: ["session_supervisor"] });
  push({ toolId: T.READ_PROMPT, category: "spatial_action", description: "读取当前 Scene prompt。", hasSideEffect: false, actorHint: ["session_supervisor"] });
  push({ toolId: T.OFFER_BRANCH, category: "spatial_action", description: "提出分支（仅预冻结 branch）。", hasSideEffect: false, actorHint: ["session_supervisor"] });
  push({ toolId: T.SHOW_CHANGE, category: "spatial_action", description: "展示对 Scene 的变化。", hasSideEffect: false, actorHint: ["session_supervisor"] });
  push({ toolId: T.PROPOSE_CURIOSITY_SAVE, category: "spatial_action", description: "提议保存好奇问题（Should，仅提议）。", hasSideEffect: false, actorHint: ["session_supervisor"] });
  push({ toolId: T.RETURN_TO_ORIGIN, category: "spatial_action", description: "恢复 origin（用户选择返回）。", hasSideEffect: false, actorHint: ["session_supervisor"] });
  push({ toolId: T.END_SESSION, category: "spatial_action", description: "结束会话（用户意图；不是 mastery commit）。", hasSideEffect: false, actorHint: ["session_supervisor"] });

  // Global Shell 确定性产品动作：不创建 Episode、不改领域数据、不被模型自由拼装
  push({ toolId: T.SPOTLIGHT_UI_ANCHOR, category: "global_shell_action", description: "页面锚点亮显。", hasSideEffect: false, actorHint: [] });
  push({ toolId: T.OPEN_PAGE_HELP, category: "global_shell_action", description: "打开页面帮助（静态）。", hasSideEffect: false, actorHint: [] });
  push({ toolId: T.PREVIEW_NAVIGATION, category: "global_shell_action", description: "预览导航目标。", hasSideEffect: false, actorHint: [] });
  push({ toolId: T.RESUME_ONBOARDING, category: "global_shell_action", description: "恢复首次引导。", hasSideEffect: false, actorHint: [] });
  push({ toolId: T.RESUME_CHECKPOINT, category: "global_shell_action", description: "恢复 checkpoint。", hasSideEffect: false, actorHint: [] });
  push({ toolId: T.SHOW_PERMISSION_SCOPE, category: "global_shell_action", description: "展示权限范围。", hasSideEffect: false, actorHint: [] });
  push({ toolId: T.DISMISS_SUGGESTION, category: "global_shell_action", description: "关闭建议。", hasSideEffect: false, actorHint: [] });
  push({ toolId: T.PREVIEW_REGISTERED_PAGE_ACTION, category: "global_shell_action", description: "预览注册的页面动作。", hasSideEffect: false, actorHint: [] });
  push({ toolId: T.REQUEST_PAGE_ACTION_CONFIRMATION, category: "global_shell_action", description: "请求页面动作显式确认。", hasSideEffect: false, actorHint: [] });

  // Session Supervisor 内部工具
  push({ toolId: T.READ_PURIFIED_CONTRACT_SUMMARY, category: "agent_internal_tool", description: "读净化 contract summary（不含 hidden rubric/solution/evidence）。", hasSideEffect: false, actorHint: ["session_supervisor"] });
  push({ toolId: T.PROPOSE_BOUNDED_ROUTE, category: "agent_internal_tool", description: "默认提议一条路线；'换一个'才生成备选。", hasSideEffect: true, actorHint: ["session_supervisor"] });
  push({ toolId: T.PROPOSE_PROBE, category: "agent_internal_tool", description: "从已审核模板提议 probe（不自由出题）。", hasSideEffect: true, actorHint: ["session_supervisor"] });
  push({ toolId: T.PROPOSE_EPISODE_READY, category: "agent_internal_tool", description: "提议当前 Episode 可进入独立评估。", hasSideEffect: true, actorHint: ["session_supervisor"] });
  push({ toolId: T.PROPOSE_END, category: "agent_internal_tool", description: "提议结束（origin-aware completion）。", hasSideEffect: true, actorHint: ["session_supervisor"] });

  // Scene Author
  push({ toolId: T.READ_PUBLISHED_CLAIM_EVIDENCE, category: "agent_internal_tool", description: "只读当前 target 已发布 claim/evidence（canonical）。", hasSideEffect: false, actorHint: ["scene_author"] });
  push({ toolId: T.READ_PRIVATE_RUBRIC_STAGING, category: "agent_internal_tool", description: "只读 private Rubric staging（仅当前 Episode 隔离 staging）。", hasSideEffect: false, actorHint: ["scene_author"] });
  push({ toolId: T.SUBMIT_SCENE_STAGING, category: "agent_internal_tool", description: "写未激活 Scene staging（0 canonical write）。", hasSideEffect: true, actorHint: ["scene_author"] });

  // Rubric / Scene Critic
  push({ toolId: T.READ_PRIVATE_SCENE_STAGING, category: "agent_internal_tool", description: "只读 private Scene staging。", hasSideEffect: false, actorHint: ["rubric_scene_critic"] });
  push({ toolId: T.SUBMIT_SCENE_CRITIC_VERDICT, category: "agent_internal_tool", description: "提交 scene-safety-v1 激活 verdict。", hasSideEffect: true, actorHint: ["rubric_scene_critic"] });

  // Assessment Critic
  push({ toolId: T.READ_LOCKED_ARTIFACT, category: "agent_internal_tool", description: "只读已锁定 artifact。", hasSideEffect: false, actorHint: ["assessment_critic"] });
  push({ toolId: T.READ_RUBRIC_TARGET, category: "agent_internal_tool", description: "只读冻结 RubricTarget。", hasSideEffect: false, actorHint: ["assessment_critic"] });
  push({ toolId: T.READ_EVIDENCE_REFS, category: "agent_internal_tool", description: "只读预绑定 evidence refs。", hasSideEffect: false, actorHint: ["assessment_critic"] });
  push({ toolId: T.SUBMIT_ASSESSMENT_VERDICT, category: "agent_internal_tool", description: "提交逐项 assessment（每冻结 rubric item 恰好一条）。", hasSideEffect: true, actorHint: ["assessment_critic"] });

  // Grounded Tutor
  push({ toolId: T.READ_CURRENT_TARGET_EVIDENCE, category: "agent_internal_tool", description: "practice 状态只读当前 target 已发布证据。", hasSideEffect: false, actorHint: ["grounded_tutor"] });
  push({ toolId: T.RENDER_EVIDENCE_CARD, category: "agent_internal_tool", description: "生成证据卡。", hasSideEffect: false, actorHint: ["grounded_tutor"] });
  push({ toolId: T.RENDER_CURRENT_TARGET_SCENE, category: "agent_internal_tool", description: "生成当前目标 Scene。", hasSideEffect: false, actorHint: ["grounded_tutor"] });
  push({ toolId: T.OFFER_SHORT_EXPLANATION, category: "agent_internal_tool", description: "提供短解释（内容性帮助前先降级 practice_only）。", hasSideEffect: false, actorHint: ["grounded_tutor"] });

  // Grounded Answer Critic
  push({ toolId: T.READ_TUTOR_SEGMENT, category: "agent_internal_tool", description: "只读 Tutor segment。", hasSideEffect: false, actorHint: ["grounded_answer_critic"] });
  push({ toolId: T.READ_ALLOWLISTED_EVIDENCE_PREMISES, category: "agent_internal_tool", description: "只读 allowlisted evidence/premises。", hasSideEffect: false, actorHint: ["grounded_answer_critic"] });
  push({ toolId: T.READ_SUPPORT_MODE, category: "agent_internal_tool", description: "只读 support mode。", hasSideEffect: false, actorHint: ["grounded_answer_critic"] });
  push({ toolId: T.SUBMIT_SUPPORT_VERDICT, category: "agent_internal_tool", description: "提交逐段 support verdict。", hasSideEffect: true, actorHint: ["grounded_answer_critic"] });

  // Scene Activation Service（deterministic 唯一激活权限）
  push({ toolId: T.ACTIVATE_SCENE_CONTRACT, category: "agent_internal_tool", description: "确定性激活 immutable active contract（exactly-once）。", hasSideEffect: true, actorHint: ["scene_activation"] });

  // Deterministic Core
  push({ toolId: T.DISPATCH_INDEPENDENT_ASSESS, category: "agent_internal_tool", description: "校验 required artifacts 后派发独立评估。", hasSideEffect: true, actorHint: ["deterministic_core"] });
  push({ toolId: T.LOCK_RESPONSE_ARTIFACT, category: "agent_internal_tool", description: "确定性锁（lock-first/assistance-first 规则，01-2 §10.2）。", hasSideEffect: true, actorHint: ["deterministic_core"] });
  push({ toolId: T.RUN_RUBRIC_REDUCER, category: "agent_internal_tool", description: "运行 rubric-session-reducer-v2 / facet-to-mastery-policy-v1。", hasSideEffect: false, actorHint: ["deterministic_core"] });
  push({ toolId: T.EXISTING_DOMAIN_COMMIT, category: "agent_internal_tool", description: "existing-domain commit（固定锁序 + 完整 CAS）。", hasSideEffect: true, actorHint: ["deterministic_core"] });
  push({ toolId: T.RECORD_OUTBOX, category: "agent_internal_tool", description: "写 outbox（同事务派生 projection）。", hasSideEffect: true, actorHint: ["deterministic_core"] });
  push({ toolId: T.CONSUME_SCHEDULE, category: "agent_internal_tool", description: "consume input schedule（精确 generation，exactly-once）。", hasSideEffect: true, actorHint: ["deterministic_core"] });

  // forbidden product actions：任何 Agent actor 都禁止直接调用（网关默认拒绝）
  push({ toolId: T.ENTER_PRACTICE, category: "forbidden_product_action", description: "进入 practice（仅用户/确定性端点触发，Agent 禁止）。", hasSideEffect: true, actorHint: [] });
  push({ toolId: T.CONFIRM_AND_LOCK, category: "forbidden_product_action", description: "确认并锁定答案（仅确定性端点，Agent 禁止）。", hasSideEffect: true, actorHint: [] });
  push({ toolId: T.SUBMIT, category: "forbidden_product_action", description: "提交答案（仅确定性端点，Agent 禁止）。", hasSideEffect: true, actorHint: [] });
  push({ toolId: T.COMMIT, category: "forbidden_product_action", description: "commit（仅 deterministic core 内部路径，Agent 角色禁止直接调用）。", hasSideEffect: true, actorHint: [] });

  return entries;
};

/** 完整工具清单 */
export const LEARNING_TOOL_MANIFEST: readonly LearningToolManifestEntry[] = buildManifest();

/** 按 toolId 索引（供 gateway / 幂等计算使用） */
export const LEARNING_TOOL_MANIFEST_BY_ID: Readonly<Record<LearningToolId, LearningToolManifestEntry>> =
  Object.fromEntries(LEARNING_TOOL_MANIFEST.map((entry) => [entry.toolId, entry])) as Record<LearningToolId, LearningToolManifestEntry>;
