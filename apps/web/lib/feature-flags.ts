/**
 * v0.6 Feature Flags (计划 §12.2)
 *
 * Client-side feature flag utilities. Flags are read from NEXT_PUBLIC_
 * environment variables so they are available at build time.
 *
 * When a flag is disabled, the UI falls back to a safe state (计划 §12.2:
 * "关闭 flag 时必须 fail closed：可以回到只读卡片、确定性题目或旧 schedule
 * 展示，但不能恢复客户端题面/outcome 的升级权力").
 */

function isExplicitlyEnabled(value: string | undefined): boolean {
  return value === "true";
}

/** QUESTION_FIRST_UI_ENABLED — controls v0.6 question-first Focus UI (计划 §12.2) */
export function isQuestionFirstUIEnabled(): boolean {
  return isExplicitlyEnabled(process.env.NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED);
}

/** AI_QUESTION_V1_ENABLED — controls server-side AI question generation */
export function isAIQuestionEnabled(): boolean {
  return isExplicitlyEnabled(process.env.NEXT_PUBLIC_AI_QUESTION_V1_ENABLED);
}

/** RUBRIC_EVALUATION_V1_ENABLED — controls server-side rubric evaluation */
export function isRubricEvaluationEnabled(): boolean {
  return isExplicitlyEnabled(process.env.NEXT_PUBLIC_RUBRIC_EVALUATION_V1_ENABLED);
}

/**
 * @deprecated 学习卡 V2 已移除 CardSet 作为产品主信息架构。
 * 仅供 legacy 只读兼容代码识别旧部署配置；/cards 不得再读取此开关。
 */
export function isCardSetDeckUIEnabled(): boolean {
  return isExplicitlyEnabled(process.env.NEXT_PUBLIC_CARD_SET_DECK_UI_ENABLED);
}

/**
 * LEARNING_RUN_V1_ENABLED — 统一 LearningRun 生产入口（文档 16 §22.2）。
 *
 * 与 API 侧 LEARNING_RUN_V1 同一次切换原子开启：Card/Review/Today 的
 * 三分钟入口、/learning-runs 路由与 Player 生产数据源同时生效。
 * fail closed：flag 关闭时全部入口维持旧链路（旧 validation/companion），
 * /learning-runs/new 与 /learning-runs/[runId] 返回 404。
 */
export function isLearningRunV1Enabled(): boolean {
  return isExplicitlyEnabled(process.env.NEXT_PUBLIC_LEARNING_RUN_V1);
}

/**
 * STAR_MAP_ACTION_V1_ENABLED — 星图行动面（文档 16 §22.2）。
 *
 * 与 API 侧投影端点同一次切换开启：graph 页 checkpoint-aware 投影拉取、
 * RoutePlan 与 delta 显影同时生效。fail closed：关闭时 graph 页继续使用
 * 旧 /graph reader，不读取新投影。
 */
export function isStarMapActionV1Enabled(): boolean {
  return isExplicitlyEnabled(process.env.NEXT_PUBLIC_STAR_MAP_ACTION_V1);
}

/**
 * AGENT_ACTIVITY_STREAM_ENABLED — controls the card generation Agent
 * activity-stream console (docs/plans/learning-card-generation-agent-stream-ui.md §8, Phase B/C).
 *
 * 可选增强（hardening §2.6），fail-closed：flag 关闭时 UI 行为与 Phase A
 * 落地后的现状一致（旧进度展示路径），不渲染活动流/汇总卡。
 */
export function isAgentActivityStreamEnabled(): boolean {
  return isExplicitlyEnabled(process.env.NEXT_PUBLIC_AGENT_ACTIVITY_STREAM_ENABLED);
}

/**
 * 救火 1（审计）：伴星壳（CompanionShell）默认关闭。
 *
 * 审计确认伴星面板仍是空壳/演示态（panelContent undefined、朗读/问一问
 * 仅 console 桩、语音端点未接生产路径）——在完成真实闭环前不得展示，
 * 避免把演示 UI 冒充 v1 交付（§12.2 fail closed：flag 关闭时不渲染）。
 *
 * 生产接入真实面板内容/端点后，由部署方显式设
 * `NEXT_PUBLIC_COMPANION_SHELL_ENABLED=true` 开启。
 */
export function isCompanionShellEnabled(): boolean {
  return isExplicitlyEnabled(process.env.NEXT_PUBLIC_COMPANION_SHELL_ENABLED);
}

/**
 * Companion v2 reconstruction surface. This is an internal-only build flag;
 * it is intentionally separate from the retired empty-shell flag above.
 */
export function isCompanionV2InternalEnabled(): boolean {
  return isExplicitlyEnabled(process.env.NEXT_PUBLIC_COMPANION_V2_INTERNAL);
}

/**
 * Journey V2 新用户竖切（文档 16 §22.2 journey_v2 capability 的前端投影）。
 * 开启时：首页 onboarding 大卡停用，新用户引导由桌宠 + Journey 承担。
 * 与 system_pet_v2 属于同一体验发布组（P6 原子切流）。
 */
export function isJourneyV2Enabled(): boolean {
  return isExplicitlyEnabled(process.env.NEXT_PUBLIC_COMPANION_JOURNEY_V2);
}

/**
 * 桌宠 P1（方案 13 §13.1）：Pet surface 的 web build-time fallback 开关。
 *
 * fail-closed：flag 关闭时 `/companion/pet` 只显示"功能未启用"，不渲染
 * Pet surface；它只控制 surface 可见性，不授权任何服务端 API 能力
 * （对话/语音/学习动作分别由 P2/P3/P5 的服务端 capability 授权）。
 */
export function isCompanionPetV1Enabled(): boolean {
  return isExplicitlyEnabled(process.env.NEXT_PUBLIC_COMPANION_PET_ENABLED);
}

/**
 * 任务 14：复习页 voice 可选模态门禁（14-...-multimodal-reconstruction §2.2/§3.3，
 * Owner 决策 1：text 默认、voice 可选）。
 *
 * fail-closed：flag 关闭时复习页保持纯 text（现状路径完全不变）；开启后
 * voice 只是可选入口，text 仍为默认。不授权任何服务端能力——ASR 端点
 * 由服务端会话权限控制（04-1 voice-service requireSession）。
 */
export function isReviewVoiceEntryEnabled(): boolean {
  return isExplicitlyEnabled(process.env.NEXT_PUBLIC_REVIEW_VOICE_ENTRY_ENABLED);
}

/**
 * 方案 20（learning-card-v2）：Card Generation V2 前端门禁（§21.5/§25.7）。
 *
 * fail-closed：flag 关闭时所有 V2 生产入口隐藏并回退 legacy 路径；开启后
 * Note Editor 生成、候选审核、Active Card 与卡片列表才渲染/调用 V2 API。
 * 与 API 侧 `CARD_GENERATION_V2_ENABLED`（server.ts 注册 V2 路由）分开，
 * 前端仅控制展示与接线；服务端 flag 未开时 V2 路由 404，客户端据此回退。
 *
 * 读 NEXT_PUBLIC_ 环境变量（构建期内联）。部署若通过 window.__DSH 注入，
 * 可在下方扩展为读取运行时注入值（现有模式为纯环境变量，保持一致性）。
 */
export function isCardGenerationV2Enabled(): boolean {
  return isExplicitlyEnabled(process.env.NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED);
}
