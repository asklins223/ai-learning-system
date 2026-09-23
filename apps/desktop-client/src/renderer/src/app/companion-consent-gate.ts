import type { WorkspaceAiSettingsV1 } from "@ailearn/shared/desktop-ipc-contracts";

/**
 * 伴星的 AI 同意门禁（2026-09-19）。
 *
 * 背景：工作区没签 AI 使用同意时，后端不会在创建回合时拦——turn 照常 accepted，
 * worker 到调用 provider 前才发现 `consentOk=false`，于是 run 失败、只留下一个
 * `error` 事件。用户侧看到的是"发出去没反应"（静默失败）。
 *
 * 这里把失败变成引导：发送前先读一次工作区 AI 设置，需要签署而没签就直接让
 * 伴星开口 + 把人送到设置页的同意卡，不消耗一轮 job。SSE 的
 * `AI_CONSENT_REQUIRED` 错误码是同一条引导的兜底（签署状态可能在两次检查之间变化）。
 */

/** 设置页里要被高亮的卡（room-store.settingsAttention 的取值）。 */
export const SETTINGS_ATTENTION_AI_CONSENT = "ai-consent";

/**
 * 缺同意时伴星说的固定台词（共用同一份文字，念不念由同意状态决定）。
 *
 * 2026-09-22 起 `/voice/tts` 也挂上了同意门（doc 34 L13），而目录里两套合成引擎都在本机之外
 * ——把"请先签署同意"这句话发给外部服务念出来，本身就是那次未签署的外发。
 * 所以这句话在未签署时**只显示、不播报**（播报侧的降级见 `companion-voice-playback.ts`）。
 *
 * 语气跟着人设走：先给一句"还差一步"，再说清按哪里；不甩错误码。
 */
export const COMPANION_CONSENT_REQUIRED_LINE =
  "还差一步：先签署你自己的 AI 使用同意，我才被允许帮你思考。设置页已经打开，按一下「签署」，我们接着来。";

/** worker 在 run 失败时写下的错误码（companion-dialogue.ts 的 markCompanionRunFailed 字面量）。 */
export const COMPANION_RUN_ERROR_AI_CONSENT_REQUIRED = "AI_CONSENT_REQUIRED";

export type CompanionConsentGateVerdict = "consent_required" | null;

/**
 * 发送前的同意判定：需要签署且尚未签署 → 引导；其余情况放行。
 *
 * 设置读不到（`null`）时不拦：服务端的门禁仍然生效，SSE 错误码会把同样的引导
 * 补上——渲染层不替服务端做安全决策，只负责别让用户卡在静默里。
 */
export function companionConsentGate(
  settings: Pick<WorkspaceAiSettingsV1, "requiresConsent" | "consentVersion"> | null,
): CompanionConsentGateVerdict {
  if (!settings) return null;
  if (!settings.requiresConsent) return null;
  if (settings.consentVersion) return null;
  return "consent_required";
}

/** SSE error 事件里是否是"缺同意"这一类失败。 */
export function isCompanionConsentFailure(code: unknown): boolean {
  return code === COMPANION_RUN_ERROR_AI_CONSENT_REQUIRED;
}
