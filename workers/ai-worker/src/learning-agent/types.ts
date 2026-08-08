/**
 * Learning Agent 共享类型（阶段 03 / W2 任务 03-1）
 *
 * 位置：workers/ai-worker/src/learning-agent/types.ts（冻结记录 01-10 文件边界）。
 * 角色 / 工具 / Provider / 预算与 Generation Supervisor 完全独立（任务 03-1 验收：
 * 两套 Supervisor 的数据与工具权限隔离测试通过）。
 *
 * 本文件仅骨架：类型语义在 W0 冻结记录 01-2 / 01-3 与 03-w2 规范范围内，
 * 具体 schema / 持久化 / Zod 校验实现于 W2 后续任务（03-2/03-3/03-6）。
 */

// ─── 1. 角色枚举 ─────────────────────────────────────────────────────────

/**
 * Learning Agent 角色。
 *
 * 前六个是 LLM 驱动的 specialist Agents（有界 SESSION_AGENT 编排内）；
 * 后两个是 deterministic 服务（非 LLM），仅在 Tool Gateway 的 allowlist 中显式注册。
 *
 * 与 generation 的 AgentRole（packages/shared card-agent-contracts.ts）**完全独立**：
 * - 不存在 generation_supervisor / text_extractor 等 generation 角色；
 * - generation 角色的工具 allowlist 不进入本枚举，反之亦然（任务 03-1）。
 */
export const LearningAgentRole = {
  /** 有界 SESSION_AGENT 编排者（turns ≤ 8，W0 冻结） */
  SESSION_SUPERVISOR: "session_supervisor",
  /** RUBRIC_AND_SCENE_PREPARE 子流程中提出 Scene 草案 */
  SCENE_AUTHOR: "scene_author",
  /** 独立 Rubric / Scene Critic（scene-safety-v1 强制调用，01-2 §3.3） */
  RUBRIC_SCENE_CRITIC: "rubric_scene_critic",
  /** INDEPENDENT_ASSESS 逐项证据化评估者 */
  ASSESSMENT_CRITIC: "assessment_critic",
  /** practice 状态 grounded tutor（有界、仅当前 target） */
  GROUNDED_TUTOR: "grounded_tutor",
  /** practice 状态 grounded answer critic（逐段 support verdict） */
  GROUNDED_ANSWER_CRITIC: "grounded_answer_critic",
  /** deterministic Scene Activation Service（非 LLM，唯一激活权限，01-2 §3.3） */
  SCENE_ACTIVATION: "scene_activation",
  /** deterministic core：派发独立评估 / 锁 / reducer / commit / outbox / scheduler（非 LLM） */
  DETERMINISTIC_CORE: "deterministic_core",
} as const;
export type LearningAgentRole = (typeof LearningAgentRole)[keyof typeof LearningAgentRole];

/** 全部合法角色 */
export const ALL_LEARNING_AGENT_ROLES = Object.values(LearningAgentRole) as LearningAgentRole[];

/** LLM 驱动的角色（其余为 deterministic 服务，不做 provider 调用） */
export const LEARNING_LLM_ROLES = [
  LearningAgentRole.SESSION_SUPERVISOR,
  LearningAgentRole.SCENE_AUTHOR,
  LearningAgentRole.RUBRIC_SCENE_CRITIC,
  LearningAgentRole.ASSESSMENT_CRITIC,
  LearningAgentRole.GROUNDED_TUTOR,
  LearningAgentRole.GROUNDED_ANSWER_CRITIC,
] as const;

// ─── 2. LearningToolId 联合类型 ──────────────────────────────────────────

/**
 * Learning Agent 工具 / 产品动作 ID 全集。
 *
 * 分四类：
 * - spatial_action：typed spatial actions（原方案 §5.3，伴星优先、模型不能返回任意 DOM/CSS/HTML/脚本）；
 * - global_shell_action：Global Companion Shell 确定性产品动作（原方案 §5.4，不能创建 Episode/改领域数据/被模型自由拼装）；
 * - agent_internal_tool：服务端 Agent actor 内部工具（03-4 actor 矩阵 allowlist）；
 * - forbidden_product_action：真实存在的产品动作（01-3 端点），但**禁止任何 Agent actor 调用**（网关默认拒绝）。
 *
 * 禁止清单（01-3 §4）与 03-4：任意 SQL/shell/文件系统/HTTP/插件不在本联合类型中；
 * `enter-practice` / `confirm-and-lock` / `submit` / `commit` 显式列在下方，
 * 使网关对任何 actor 调用它们都能「确定性拒绝越权」。
 */
export const LearningToolId = {
  // ── typed spatial actions（§5.3） ──────────────────────────────────────
  FOCUS_NODES: "focus_nodes",
  DRAW_ROUTE: "draw_route",
  STAGE_SCENE: "stage_scene",
  READ_PROMPT: "read_prompt",
  OFFER_BRANCH: "offer_branch",
  SHOW_CHANGE: "show_change",
  PROPOSE_CURIOSITY_SAVE: "propose_curiosity_save",
  RETURN_TO_ORIGIN: "return_to_origin",
  END_SESSION: "end_session",

  // ── Global Shell 确定性产品动作（§5.4） ────────────────────────────────
  SPOTLIGHT_UI_ANCHOR: "spotlight_ui_anchor",
  OPEN_PAGE_HELP: "open_page_help",
  PREVIEW_NAVIGATION: "preview_navigation",
  RESUME_ONBOARDING: "resume_onboarding",
  RESUME_CHECKPOINT: "resume_checkpoint",
  SHOW_PERMISSION_SCOPE: "show_permission_scope",
  DISMISS_SUGGESTION: "dismiss_suggestion",
  PREVIEW_REGISTERED_PAGE_ACTION: "preview_registered_page_action",
  REQUEST_PAGE_ACTION_CONFIRMATION: "request_page_action_confirmation",

  // ── Session Supervisor 内部工具（03-4） ────────────────────────────────
  /** 读净化 contract summary（不含 hidden rubric/solution/evidence） */
  READ_PURIFIED_CONTRACT_SUMMARY: "read_purified_contract_summary",
  /** 默认提议一条路线；"换一个"才生成备选 */
  PROPOSE_BOUNDED_ROUTE: "propose_bounded_route",
  /** 从已审核模板提议 probe（不自由出题） */
  PROPOSE_PROBE: "propose_probe",
  /** 提议当前 Episode 可进入评估 */
  PROPOSE_EPISODE_READY: "propose_episode_ready",
  /** 提议结束（origin-aware completion） */
  PROPOSE_END: "propose_end",

  // ── Scene Author 内部工具（03-4） ──────────────────────────────────────
  /** 只读当前 target 的已发布 claim/evidence（canonical） */
  READ_PUBLISHED_CLAIM_EVIDENCE: "read_published_claim_evidence",
  /** 只读 private Rubric staging（仅当前 Episode 隔离 staging） */
  READ_PRIVATE_RUBRIC_STAGING: "read_private_rubric_staging",
  /** 写未激活 Scene staging（0 canonical write） */
  SUBMIT_SCENE_STAGING: "submit_scene_staging",

  // ── Rubric / Scene Critic 内部工具（03-4） ─────────────────────────────
  READ_PRIVATE_SCENE_STAGING: "read_private_scene_staging",
  SUBMIT_SCENE_CRITIC_VERDICT: "submit_scene_critic_verdict",

  // ── Assessment Critic 内部工具（03-4） ─────────────────────────────────
  READ_LOCKED_ARTIFACT: "read_locked_artifact",
  READ_RUBRIC_TARGET: "read_rubric_target",
  READ_EVIDENCE_REFS: "read_evidence_refs",
  SUBMIT_ASSESSMENT_VERDICT: "submit_assessment_verdict",

  // ── Grounded Tutor 内部工具（03-4） ────────────────────────────────────
  READ_CURRENT_TARGET_EVIDENCE: "read_current_target_evidence",
  RENDER_EVIDENCE_CARD: "render_evidence_card",
  RENDER_CURRENT_TARGET_SCENE: "render_current_target_scene",
  OFFER_SHORT_EXPLANATION: "offer_short_explanation",

  // ── Grounded Answer Critic 内部工具（03-4） ────────────────────────────
  READ_TUTOR_SEGMENT: "read_tutor_segment",
  READ_ALLOWLISTED_EVIDENCE_PREMISES: "read_allowlisted_evidence_premises",
  READ_SUPPORT_MODE: "read_support_mode",
  SUBMIT_SUPPORT_VERDICT: "submit_support_verdict",

  // ── Scene Activation Service（deterministic，01-2 §3.3 唯一激活权限） ──
  ACTIVATE_SCENE_CONTRACT: "activate_scene_contract",

  // ── Deterministic Core（01-1 §5 固定锁序 + 完整 CAS） ───────────────────
  DISPATCH_INDEPENDENT_ASSESS: "dispatch_independent_assess",
  LOCK_RESPONSE_ARTIFACT: "lock_response_artifact",
  RUN_RUBRIC_REDUCER: "run_rubric_reducer",
  EXISTING_DOMAIN_COMMIT: "existing_domain_commit",
  RECORD_OUTBOX: "record_outbox",
  CONSUME_SCHEDULE: "consume_schedule",

  // ── forbidden_product_action：任何 Agent actor 都禁止直接调用 ──────────
  ENTER_PRACTICE: "enter-practice",
  CONFIRM_AND_LOCK: "confirm-and-lock",
  SUBMIT: "submit",
  COMMIT: "commit",
} as const;
export type LearningToolId = (typeof LearningToolId)[keyof typeof LearningToolId];

/** 禁止给任何 Agent actor 的产品动作（网关对任意 actor 均拒绝） */
export const FORBIDDEN_LEARNING_TOOL_IDS: readonly LearningToolId[] = [
  LearningToolId.ENTER_PRACTICE,
  LearningToolId.CONFIRM_AND_LOCK,
  LearningToolId.SUBMIT,
  LearningToolId.COMMIT,
];

// ─── 3. Tool Call 结构 ───────────────────────────────────────────────────

/** 模型请求执行的工具调用（native tool call 或 structured_action_v1 统一形态） */
export interface LearningToolCall {
  readonly id: string;
  readonly name: string;
  /** 工具参数（已 JSON 解析） */
  readonly arguments: Record<string, unknown>;
}

// ─── 4. 角色规格（roles/ 工厂返回类型） ──────────────────────────────────

/**
 * 角色规格。每个角色文件导出 `createXxxRole()` 工厂，返回本结构。
 * 允许工具名列表来自 03-4 actor 矩阵；执行侧由 LearningToolGateway 强制 allowlist（默认拒绝）。
 */
export interface LearningRoleSpec {
  readonly role: LearningAgentRole;
  /** 角色职责一句话描述 */
  readonly description: string;
  /** 该角色允许调用的工具 ID 列表（越权调用被网关拒绝） */
  readonly allowedToolIds: readonly LearningToolId[];
}

// ─── 5. Staging 结果类型（0 canonical write 语义） ───────────────────────

/**
 * Staging 结果类型。
 *
 * 0 canonical write 语义（阶段 03 阶段目标「staging plan 0 canonical write」）：
 * - 本类型只描述「写入隔离 staging」的结果，**绝不代表 canonical 事实已落库**；
 * - canonical 事实（mastery / schedule / published semantic relation / canonical Card /
 *   review outcome / validation_point_assessments）只允许由 deterministic COMMIT
 *   （01-1 §5 固定锁序 + 完整 CAS，任务 03-4/03-6）投影产生；
 * - `canonicalWrite: false` 是字面量类型：编译器在类型层面防止把 staging 结果误当
 *   canonical 结果消费（如直接写 schedule 副作用）。
 */
export interface LearningStagingResult {
  readonly kind: "learning_staging";
  /** staging 记录类型 */
  readonly stagingKind: "scene" | "probe" | "route" | "assessment" | "audit";
  /** staging 记录 ID */
  readonly stagingRef: string;
  /** staging 内容 hash（可审计、可重建） */
  readonly stagingHash: string;
  /** staging 生命周期子状态 */
  readonly status: "prepared" | "approved" | "superseded";
  /** 字面量 false：本结果永不表示 canonical 写成功 */
  readonly canonicalWrite: false;
}
