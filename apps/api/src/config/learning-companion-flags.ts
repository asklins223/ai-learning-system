/** Server-only rollout gates for the Companion reconstruction. */

/**
 * 统一 LearningRun 生产入口门控（§22.2，与前端 NEXT_PUBLIC_LEARNING_RUN_V1
 * 同一次切换）。此前 run-routes.ts 引用本函数但从未定义——API 加载即崩
 * （ESM 命名检查），2026-08-15 接线修复补齐。
 */
export function isLearningRunV1Enabled(): boolean {
  return process.env.LEARNING_RUN_V1 === "true";
}

export function isLearningSessionV2InternalEnabled(): boolean {
  return process.env.LEARNING_SESSION_V2_INTERNAL === "true";
}

/** Keep canonical mastery/schedule writes separately gated from the UI path. */
export function isLearningSessionCanonicalCommitEnabled(): boolean {
  return process.env.LEARNING_SESSION_CANONICAL_COMMIT_ENABLED === "true";
}

/**
 * Card Generation V2 路由注册门控（方案 20 §21.5；测试断言存在）。
 * 关闭时 V2 路由不注册（404 fail closed），前端据此回退 legacy 路径。
 */
export function isCardGenerationV2Enabled(): boolean {
  return process.env.CARD_GENERATION_V2_ENABLED === "true";
}

/**
 * Card Generation V1 writer 停写开关（方案 20 §21.3/C8，R33 恢复）。
 * V2 已启用且本开关未显式开 → V1 `createCardGenerationRun` 必须 409
 * `v1_writer_disabled`（fail closed，防双 writer/旧 schema 反写）；
 * 显式 `CARD_GENERATION_V1_WRITER_ENABLED=true` 才放行（观察窗口/回滚用）。
 */
export function isCardGenerationV1WriterEnabled(): boolean {
  return process.env.CARD_GENERATION_V1_WRITER_ENABLED === "true";
}

export function learningSessionRolloutDisabledReason(): string {
  if (!isLearningSessionV2InternalEnabled()) {
    return "学习伴星重构路径当前仅供内部验证";
  }
  if (!isLearningSessionCanonicalCommitEnabled()) {
    return "正式学习结果尚未开放；当前仅支持诊断练习";
  }
  return "学习伴星重构路径已开放";
}
