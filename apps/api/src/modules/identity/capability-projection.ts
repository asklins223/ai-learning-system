import {
  actionCapabilityValues,
  capabilityProjectionSchema,
  featureNameValues,
  type CapabilityProjectionV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import {
  isCardGenerationV2Enabled,
  isCompanionDialogueEnabled,
  isCompanionVoiceDialogueEnabled,
  isLearningRunEnabled,
} from "../../config/learning-companion-flags.ts";

type CapabilityRole = "owner" | "member";

/**
 * 工作区 AI 同意与数据策略的**已核实**事实。这些值来自 workspaces 行，
 * 不再由投影自己猜：设置页的「外发同意」四行、账户卡的数据边界、数据路径图
 * 全部读这份投影，硬编码会让它们永远停在同一个状态。
 */
export type WorkspaceAiConsentFacts = {
  /** 部署里配置了外部模型供应商 → 必须先有签署过的同意。 */
  readonly requiresConsent: boolean;
  /** 工作区已签署同意（ai_consent_at + ai_consent_version 同时存在）。 */
  readonly consentSigned: boolean;
  /** 数据策略仍允许把内容发往外部。 */
  readonly sendToExternal: boolean;
};

export type CapabilityProjectionInput = {
  readonly role: CapabilityRole;
  /** 缺失时按 fail-closed 处理：视作需要同意且未签署、不允许外发。 */
  readonly ai: WorkspaceAiConsentFacts | null;
  /**
   * 当前空间的边界令牌（`workspaces.workspace_epoch`，迁移 0261）。
   *
   * 以前这里写死 `workspaceEpoch: 1`，注释还说"桌面主进程拥有这个 epoch"——
   * 那是把"服务端没有这个概念"当成了设计。审查 1.3 指出后果：改 AI 外发政策、
   * 改空间名、撤销设备都无法即时生效。现在它是从空间行读回来的真值。
   */
  readonly workspaceEpoch: number;
};

const unavailableFeature = { state: "disabled" as const, reason: "error.feature_disabled" as const };

/**
 * 内容是否可以离开这台机器。与 `invite-service.ts` 的 `ai_consent` 判定同源：
 * 纯 mock 部署不需要同意；一旦有外部供应商，就必须同时满足「已签署」与
 * 「策略仍允许外发」，任一不成立都按拒绝处理。
 */
function aiOutboundAllowed(ai: WorkspaceAiConsentFacts | null): boolean {
  if (!ai) return false;
  if (!ai.requiresConsent) return true;
  return ai.consentSigned && ai.sendToExternal;
}

export function buildDesktopCapabilityProjection(input: CapabilityProjectionInput): CapabilityProjectionV1 {
  const { role, ai } = input;
  const learningRunEnabled = isLearningRunEnabled();
  const cardGenerationEnabled = isCardGenerationV2Enabled();
  const dialogueEnabled = isCompanionDialogueEnabled();
  const voiceDialogueEnabled = isCompanionVoiceDialogueEnabled();
  const outboundAllowed = aiOutboundAllowed(ai);
  const actionCapabilities = Object.fromEntries(
    actionCapabilityValues.map((capability) => [capability, "denied" as const]),
  ) as Record<(typeof actionCapabilityValues)[number], "allowed" | "denied" | "conditional">;

  for (const capability of ["note.read", "objective.read", "settings.read"] as const) actionCapabilities[capability] = "allowed";
  actionCapabilities["review.read"] = learningRunEnabled ? "allowed" : "denied";
  actionCapabilities["learning_run.read"] = learningRunEnabled ? "allowed" : "denied";
  if (learningRunEnabled) {
    actionCapabilities["learning_run.start"] = "allowed";
    actionCapabilities["learning_run.saveDraft"] = "allowed";
    actionCapabilities["learning_run.submit"] = "allowed";
    actionCapabilities["learning_run.action"] = "allowed";
  }

  // 伴星对工作区内容的读取、外发与提议写入都受同一条 AI 同意边界约束。
  // 三条一起开、一起关，避免出现「读得到但发不出」这类自相矛盾的投影。
  if (outboundAllowed) {
    for (const capability of ["companion.read", "companion.sendMessage", "companion.decideProposal"] as const) {
      actionCapabilities[capability] = "allowed";
    }
  }

  if (role === "owner") {
    for (const capability of ["source.create", "source.update", "source.archive", "source.createNote", "note.create", "note.save", "note.delete", "note.restore", "note.permanentDelete", "settings.update"] as const) {
      actionCapabilities[capability] = "allowed";
    }
    if (cardGenerationEnabled) {
      for (const capability of ["card_generation.start", "card_generation.review", "card_generation.reveal", "card_generation.activate", "card_generation.cancel", "card_generation.close", "card_generation.retry"] as const) {
        actionCapabilities[capability] = "allowed";
      }
    }
  }

  const featureAvailability = Object.fromEntries(
    featureNameValues.map((feature) => [feature, unavailableFeature]),
  ) as Record<(typeof featureNameValues)[number], { state: "enabled" | "disabled" | "conditional" | "unavailable"; reason?: "error.feature_disabled" }>;
  featureAvailability.learning_objective_system_v3 = { state: "enabled" };
  featureAvailability.learning_run_v2 = learningRunEnabled ? { state: "enabled" } : unavailableFeature;
  featureAvailability.card_generation_v2 = cardGenerationEnabled && role === "owner"
    ? { state: "enabled" }
    : unavailableFeature;
  // 设置页的「对话能力」「语音对话」直接显示这两项，必须来自真实开关。
  featureAvailability.companion_dialogue_v1 = dialogueEnabled ? { state: "enabled" } : unavailableFeature;
  featureAvailability.companion_voice_dialogue_v1 = voiceDialogueEnabled ? { state: "enabled" } : unavailableFeature;

  return capabilityProjectionSchema.parse({
    version: 1,
    revision: `desktop-capability-v1:${role}:run-${learningRunEnabled ? "on" : "off"}:card-${cardGenerationEnabled ? "on" : "off"}:ai-${outboundAllowed ? "out" : "hold"}:dialogue-${dialogueEnabled ? "on" : "off"}:voice-${voiceDialogueEnabled ? "on" : "off"}`,
    // 服务端自己的边界令牌：成员变动 / AI 同意或外发政策改变 / 空间改名时
    // 由触发器 +1（0261），这里如实回传。客户端拿旧值请求会被判 stale_workspace。
    workspaceEpoch: input.workspaceEpoch,
    actionCapabilities,
    featureAvailability,
    // 服务端不可能知道桌面壳的本机能力（剪贴板 / 通知 / 自动更新 / Live2D /
    // ASR 都由客户端拥有）。这里只放 fail-closed 占位，真正的值由主进程在
    // capabilities.get 边界上覆盖，见 desktop-gateway.ts 的 nativeCapabilities()。
    nativeCapabilities: {
      filePicker: "unavailable",
      clipboard: "unavailable",
      notifications: "unavailable",
      asr: "unavailable",
      updates: "unavailable",
      live2d: "unavailable",
    },
  });
}
