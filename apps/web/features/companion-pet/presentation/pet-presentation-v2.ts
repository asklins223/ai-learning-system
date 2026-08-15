/**
 * 方案 16 §9.3/§9.4：PetRuntimeV2 / PetPresentationV2 投影适配。
 *
 * V2 是聚合投影（非第二真相源）：从 V1 runtime 状态 + Journey/Delivery 外部
 * 信号派生，供展示层按 §9.3 渲染优先级消费。
 */

import type {
  BubbleDisplayStateV1,
  PetJourneyV2,
  PetRuntimeV2,
  PetPresentationV2,
  PetRuntimeStateV1,
} from "../runtime/pet-runtime-types";

export interface PetV2Signals {
  /** Journey 状态（PetJourneyLive 注入；默认 not_offered）。 */
  journey?: PetJourneyV2;
  /** 主动队列长度（PetDeliveryLayer 注入）。 */
  proactiveQueueLength?: number;
  /** 当前是否展示 delivery 气泡。 */
  deliveryVisible?: boolean;
}

function mapLifecycleV2(state: PetRuntimeStateV1): PetRuntimeV2["lifecycle"] {
  switch (state.lifecycle.kind) {
    case "booting": return "boot";
    case "auth_required": return "auth";
    case "fatal": return "fault";
    case "hidden":
      return state.lifecycle.reason === "global_off" || state.lifecycle.reason === "owner_disabled"
        ? "off"
        : "suspended";
    case "suspended": return "suspended";
    case "visible": return "ready";
  }
}

function mapAttentionV2(
  state: PetRuntimeStateV1,
  signals: PetV2Signals,
): PetRuntimeV2["attention"] {
  if (state.lifecycle.kind === "hidden" || state.lifecycle.kind === "suspended") return "dnd";
  if (state.turn.kind !== "idle" && state.turn.kind !== "error") return "engaged";
  if (signals.deliveryVisible) return "cue_visible";
  if ((signals.proactiveQueueLength ?? 0) > 0) return "cue_pending";
  return "passive";
}

function mapTaskV2(state: PetRuntimeStateV1): PetRuntimeV2["task"] {
  switch (state.bubble.kind) {
    case "confirmation": return "confirming";
    case "action_pending": return "executing";
    case "action_result": return "reporting";
    case "turn": return "assisting";
    case "incoming": return "proposing";
    default: return state.turn.kind === "idle" ? "none" : "assisting";
  }
}

/** §9.3：V1 runtime + 外部信号 → V2 正交状态投影。 */
export function projectPetRuntimeV2(
  state: PetRuntimeStateV1,
  signals: PetV2Signals = {},
): PetRuntimeV2 {
  return {
    lifecycle: mapLifecycleV2(state),
    attention: mapAttentionV2(state, signals),
    task: mapTaskV2(state),
    turn: state.turn,
    journey: signals.journey ?? "not_offered",
    activeContext: null,
    proactiveQueue: Array.from({ length: signals.proactiveQueueLength ?? 0 }),
    memorySync: "idle",
  };
}

/** §9.4：V1 bubble 状态 + 消息文本 → PetPresentationV2（choices 无泄题语义）。 */
export function toPetPresentationV2(
  bubble: BubbleDisplayStateV1,
  messageText: string | null,
  messageId: string,
): PetPresentationV2 {
  if (bubble.kind === "confirmation") {
    return {
      messageId,
      speechMode: "text_only",
      proposedAction: { proposalId: bubble.proposalId, impactSummary: bubble.impact },
      dismissPolicy: "explicit",
    };
  }
  if (bubble.kind === "action_pending") {
    return {
      messageId,
      speechMode: "text_only",
      progressCue: { state: "processing" },
      dismissPolicy: "persistent_until_result",
    };
  }
  if (bubble.kind === "action_result") {
    return {
      messageId,
      speechMode: "text_only",
      progressCue: { state: bubble.status === "completed" ? "ready" : "failed" },
      dismissPolicy: bubble.status === "failed" ? "explicit" : "auto",
    };
  }
  return {
    messageId,
    speechMode: messageText ? "speak_message" : "text_only",
    dismissPolicy: "auto",
  };
}

export type { PetPresentationV2, PetRuntimeV2 };
