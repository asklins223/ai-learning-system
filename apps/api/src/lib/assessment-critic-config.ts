/**
 * 评估 Critic / 主动记忆生成共用的 LLM 端点解析（单一来源）。
 *
 * 背景（2026-09-15 审计 · 设计 P0-2）：此前三处各自读 `ASSESSMENT_CRITIC_*`，
 * 且语义互不一致：
 *   - `learning-runs/run-critic.ts`：用 `.find(非空)` 回退 `DASHSCOPE_API_KEY`
 *     （空串能回退），model 缺失时默认 **"default"**（非法模型名）；
 *   - `companion-conversation/proactive-generator.ts` 与 `proactive-hook.ts`：
 *     用 `?? DASHSCOPE_API_KEY`（**空串不回退**），model 缺失时默认 "qwen-plus"。
 *
 * docker-compose 注入的是 `${ASSESSMENT_CRITIC_KEY:-}`——变量缺失时是**空串**
 * 而不是 undefined，所以 `??` 不会回退。后果：未显式配置 key 时，proactive 两处
 * 会 `if (!key) return null` 静默关闭个性化；run-critic 则能回退到主 key。
 *
 * 现在只有一个解析点，语义统一：
 *   1. 空串一律视为未配置（兼容 compose 的 `${VAR:-}` 形态）；
 *   2. key 缺失时回退 `DASHSCOPE_API_KEY`（评估 Critic 与主模型同源）；
 *   3. model 缺失时用 `DEFAULT_ASSESSMENT_CRITIC_MODEL`（不再是 "default"）；
 *   4. 最终仍不完整时返回 null（调用方各自 fail-closed / 降级），但**记录一次
 *      告警**——让"未配置"可归因，而不是静默失败。
 *
 * 注意：这里刻意**不**自动回退到 `config/ai-platforms.json` 的通用
 * `text_generation` 能力。评估结果是掌握度判定（mastery）的高风险输入，
 * 静默降级到一个小模型比 fail-closed 更危险。生产必须显式配置
 * （docker-compose.yml 已注入 ASSESSMENT_CRITIC_*）。
 */

import { logger } from "./logger.ts";

/** 评估 Critic 的默认模型（与 dev compose 的 `${ASSESSMENT_CRITIC_MODEL:-qwen-plus}` 一致）。 */
export const DEFAULT_ASSESSMENT_CRITIC_MODEL = "qwen-plus";

export interface AssessmentCriticConfig {
  url: string;
  key: string;
  model: string;
}

/** 取第一个"非空（trim 后仍有内容）"的值；空串与 undefined 同等对待。 */
export function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

let missingConfigWarned = false;

/**
 * 解析评估 Critic 配置。
 *
 * @param overrides 显式覆盖（优先级最高；供单测注入，不走环境变量）。
 * @returns 完整配置，或 null（未配置——调用方 fail-closed）。
 */
export function resolveAssessmentCriticConfig(
  overrides: Partial<AssessmentCriticConfig> = {},
): AssessmentCriticConfig | null {
  const url = firstNonEmpty(overrides.url, process.env.ASSESSMENT_CRITIC_URL);
  const key = firstNonEmpty(
    overrides.key,
    process.env.ASSESSMENT_CRITIC_KEY,
    // 未单独配置 critic key 时与主模型同源（DashScope OpenAI-compatible）。
    process.env.DASHSCOPE_API_KEY,
  );
  const model = firstNonEmpty(overrides.model, process.env.ASSESSMENT_CRITIC_MODEL)
    ?? DEFAULT_ASSESSMENT_CRITIC_MODEL;

  if (!url || !key) {
    if (!missingConfigWarned) {
      missingConfigWarned = true;
      logger.warn(
        { hasUrl: Boolean(url), hasKey: Boolean(key), defaultModel: model },
        "assessment critic 未配置（ASSESSMENT_CRITIC_URL/KEY 与 DASHSCOPE_API_KEY 均缺失）："
        + "评估链将 fail-closed 为 not_assessable，主动记忆个性化将降级为确定性路径",
      );
    }
    return null;
  }
  return { url, key, model };
}

/** 测试钩子：重置"已告警"状态，使每个用例都能独立断言告警行为。 */
export function resetAssessmentCriticConfigForTests(): void {
  missingConfigWarned = false;
}
