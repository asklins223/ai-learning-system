import type { DesktopPetWindowStateV1 } from "@ailearn/shared/desktop-pet-contracts";
import type { AllowedMainRouteV1 } from "@ailearn/shared/desktop-pet-contracts";
import type { CompanionConversationSnapshotV1 } from "@ailearn/shared/companion-conversation-contracts";
import type { CompanionCharacterCueV1 } from "@ailearn/shared/companion-conversation-contracts";
import type { CharacterCueV1 } from "@ailearn/shared/companion-character-contracts";

/**
 * P1 subset of the seven-domain runtime (02 §1–§5).
 *
 * The reducer is pure: it returns the next state plus effect descriptors; the
 * effect runner executes side effects and re-feeds typed events. P1 runs a
 * deterministic fixture pipeline (no LLM / ASR / TTS / DB); P2 replaces the
 * fixture effects with the 03-contract SSE adapter while keeping this reducer.
 */

// ─── 1. Runtime context (02 §1.2) ────────────────────────────────────────

export interface PetRuntimeContextV1 {
  surfaceId: string;
  surfaceKind: "pet" | "main" | "web_fallback";
  userId: string | null;
  workspaceId: string | null;
  accountEpoch: number;
  conversationId: string | null;
  latestEventSeq: number;
  inboxConversationId: string | null;
  inboxLatestEventSeq: number;
  activeGeneration: number;
  online: boolean;
  reducedMotion: boolean;
  animationOff: boolean;
  voiceOff: boolean;
  privacyMode: boolean;
  /** 最近一次应用的 desktop window state revision（§3.3：只接受更高 revision）。 */
  windowStateRevision: number;
}

// ─── 2. Seven domains (02 §2) ────────────────────────────────────────────

export type PetLifecycleStateV1 =
  | { kind: "booting" }
  | { kind: "visible" }
  | { kind: "hidden"; reason: "temporary" | "global_off" | "owner_disabled" }
  | { kind: "suspended"; reason: "system_sleep" | "locked_screen" | "temporary_hidden" | "app_quitting" }
  | { kind: "auth_required" }
  | { kind: "fatal"; code: string };

export type ConversationTurnStateV1 =
  | { kind: "idle" }
  | {
      kind: "submitting";
      clientMessageId: string;
      idempotencyKey: string;
      input: { kind: "text" };
    }
  | {
      kind: "running";
      conversationId: string;
      runId: string;
      generation: number;
      phase: "accepted" | "thinking" | "streaming" | "acting";
      previewText: string;
      lastSeq: number;
    }
  | {
      kind: "final";
      runId: string;
      generation: number;
      messageId: string;
      previewText: string;
    }
  | { kind: "cancelled"; runId: string; generation: number }
  | { kind: "error"; runId?: string; generation?: number; code: string; recoverable: boolean };

export type BubbleDisplayStateV1 =
  | { kind: "hidden" }
  | {
      kind: "turn";
      ref:
        | { kind: "client"; clientMessageId: string }
        | { kind: "run"; runId: string };
    }
  | {
      kind: "incoming";
      deliveryId: string;
      messageId: string;
      previewText: string;
    }
  | {
      kind: "confirmation";
      proposalId: string;
      actionName: string;
      target: string;
      impact: string;
    }
  | {
      kind: "action_result";
      actionRunId: string;
      status: "completed" | "failed";
      summary: string;
      code?: string;
      route: AllowedMainRouteV1 | null;
    }
  | {
      kind: "action_pending";
      actionRunId: string;
      summary: string;
    }
  | { kind: "voice_status" }
  | { kind: "error"; code: string };

export type ComposerStateV1 =
  | { kind: "closed"; draft?: string }
  | { kind: "editing"; draft: string; voiceArtifactId?: string; transcriptSha256?: string }
  | {
      kind: "submitting";
      draftSnapshot: string;
      clientMessageId: string;
      voiceArtifactId?: string;
      transcriptSha256?: string;
    };

export type VoiceDialogueStateV1 =
  | { kind: "idle" }
  | { kind: "requesting_permission" }
  | { kind: "listening"; startedAt: number; streamId: string }
  | { kind: "finalizing"; streamId: string }
  | { kind: "transcribing"; streamId: string; uploadId: string }
  | { kind: "speaking"; runId: string; generation: number; segmentId: string }
  | { kind: "cooldown"; until: number }
  | { kind: "cancelled"; reason: string }
  | { kind: "error"; code: string; recoverable: boolean };

export type PetMenuStateV1 =
  | { kind: "closed" }
  | { kind: "root"; focusItem: string }
  | { kind: "study"; focusItem: string }
  | { kind: "more"; focusItem: string };

/**
 * 服务端受控表现情绪（03 §4.4 / 方案 13 §9.6）。
 * reducer 只保存最近一次 cue（含事件级 generation 供过期守卫）；连续
 * 的 VAD 插值/衰减由表现层 emotion-runtime 完成（soullink 思路迁移）。
 */
export interface PetEmotionStateV1 {
  /** 最近一次受控 cue；无 cue 时为 null（表现层回落到 presentation 投影）。 */
  cue: CharacterCueV1 | null;
  /** 本地接收时间戳（ms）。 */
  receivedAt: number;
}

export type PetWindowInteractionStateV1 =
  | { kind: "passive" }
  | { kind: "interactive"; reason: "pointer_hit" | "menu" | "bubble" }
  | { kind: "text_input" }
  | { kind: "dragging" }
  | { kind: "accessibility_focus" };

export interface PetRuntimeStateV1 {
  lifecycle: PetLifecycleStateV1;
  /** 2026-08-11（性能专项）：窗口被完全遮挡时暂停渲染（不中止会话/语音）。 */
  occluded: boolean;
  turn: ConversationTurnStateV1;
  bubble: BubbleDisplayStateV1;
  composer: ComposerStateV1;
  voice: VoiceDialogueStateV1 & { operationEpoch: number };
  menu: PetMenuStateV1;
  emotion: PetEmotionStateV1;
  window: PetWindowInteractionStateV1;
  context: PetRuntimeContextV1;
}

// ─── 3. Events (02 §3.1 / §3.2, P1 subset) ───────────────────────────────

export type PetUiIntentV1 =
  | { type: "character.clicked" }
  | { type: "composer.opened" }
  | { type: "composer.draft_changed"; draft: string }
  | { type: "composer.submitted" }
  | { type: "composer.closed" }
  | { type: "menu.opened" }
  | { type: "menu.navigated"; target: "root" | "study" | "more" }
  | { type: "menu.closed" }
  | { type: "window.drag_started" }
  | { type: "window.drag_ended" }
  | { type: "privacy_mode.set_requested"; enabled: boolean }
  | { type: "turn.cancel_requested" }
  | { type: "voice.toggle_requested" }
  | { type: "voice.cancel_requested" }
  | {
      type: "bubble.learning_proposal_received";
      proposalId: string;
      actionName: string;
      target: string;
      impact: string;
    }
  | { type: "bubble.dismissed" };

export type PetRuntimeEventV1 =  | { type: "bootstrap.authenticated"; userId: string; workspaceId: string; accountEpoch: number; animationOff?: boolean; voiceOff?: boolean }
  | { type: "bootstrap.auth_required" }
  | { type: "account.global_off"; epoch: number }
  | { type: "account.preferences_changed"; accountEpoch: number; animationOff: boolean; voiceOff: boolean }
  | { type: "workspace.changed"; workspaceId: string; accountEpoch: number; animationOff?: boolean; voiceOff?: boolean }
  | { type: "network.online" }
  | { type: "network.offline" }
  | { type: "conversation.restored"; snapshot: CompanionConversationSnapshotV1 }
  | { type: "system.suspended"; reason: "system_sleep" | "locked_screen" | "temporary_hidden" | "app_quitting" }
  | { type: "system.resumed" }
  | { type: "system.occluded"; occluded: boolean }
  | { type: "desktop.window_state_changed"; state: DesktopPetWindowStateV1 }
  | { type: "voice.permission_result"; operationEpoch: number; granted: boolean }
  | { type: "voice.track_started"; operationEpoch: number; streamId: string }
  | { type: "voice.track_stopped"; operationEpoch: number; streamId: string }
  | {
      type: "voice.transcript_ready";
      operationEpoch: number;
      streamId: string;
      uploadId: string;
      text: string;
      /** 服务端 Voice Artifact id；本地 ASR（P6 §13）无 artifact 时为 null。 */
      voiceArtifactId: string | null;
      transcriptSha256: string | null;
    }
  | {
      type: "voice.transcription_failed";
      operationEpoch: number;
      streamId: string;
      uploadId: string;
      code: string;
      recoverable: boolean;
    }
  | {
      type: "voice.segments";
      conversationId: string;
      runId: string;
      generation: number;
      accountEpoch?: number;
      seq: number;
      segment: { ordinal: number; segmentId: string; text: string; emotion?: string };
    }
  | {
      type: "voice.playback_started";
      runId: string;
      generation: number;
      segmentId: string;
    }
  | {
      type: "voice.playback_finished";
      runId: string;
      generation: number;
      segmentId: string;
    }
  | { type: "voice.cooldown_done"; now: number }
  | {
      type: "turn.accepted";
      conversationId: string;
      runId: string;
      generation: number;
      seq: number;
    }
  | {
      type: "assistant.status";
      runId: string;
      generation: number;
      phase: "thinking" | "streaming";
      accountEpoch?: number;
      seq: number;
    }
  | {
      type: "assistant.delta";
      runId: string;
      generation: number;
      accountEpoch?: number;
      seq: number;
      text: string;
    }
  | {
      type: "assistant.final";
      runId: string;
      generation: number;
      accountEpoch?: number;
      seq: number;
      messageId: string;
      text: string;
      textSha256: string;
    }
  | {
      type: "character.cue";
      runId: string;
      generation: number;
      accountEpoch?: number;
      seq: number;
      cue: CompanionCharacterCueV1;
    }
  | { type: "turn.cancelled"; runId: string; generation: number; accountEpoch?: number; seq: number }
  | {
      type: "action.completed";
      actionRunId: string;
      resultRef: string | null;
      route: AllowedMainRouteV1 | null;
      safeSummary: string;
      accountEpoch?: number;
      seq: number;
    }
  | {
      type: "action.failed";
      actionRunId: string;
      code: string;
      recoverable: boolean;
      accountEpoch?: number;
      seq: number;
    }
  | { type: "turn.failed"; code: string; recoverable: boolean; seq: number };

export type PetActionV1 = PetUiIntentV1 | PetRuntimeEventV1;

/**
 * P1 demo-only events for deterministic visual evidence capture (G02/G07/G09).
 * They are typed and handled explicitly by the P1 reducer; the P2 adapter
 * replaces them with real proactive/confirmation/voice events and removes
 * these branches.
 */
export type PetDemoEventV1 =
  | { type: "bubble.incoming_fixture"; text: string }
  | {
      type: "bubble.confirmation_fixture";
      actionName: string;
      target: string;
      impact: string;
    }
  | {
      type: "voice.speaking_fixture";
      runId: string;
      generation: number;
      segmentId: string;
    }
  | { type: "voice.transcript_fixture"; operationEpoch: number; text: string }
  | { type: "voice.reset_fixture" };

export type PetActionV1WithDemo = PetActionV1 | PetDemoEventV1;

// ─── 4. Effects (executed by the runner, then re-fed as events) ──────────

export type PetEffectV1 =
  | { kind: "request_text_input_focus" }
  | { kind: "release_text_input_focus" }
  | { kind: "set_interaction_mode"; mode: "passive" | "interactive" | "text_input" | "dragging" | "accessibility_focus" }
  | {
      kind: "submit_turn";
      clientMessageId: string;
      idempotencyKey: string;
      draft: string;
      voiceArtifactId?: string;
      transcriptSha256?: string;
    }
  | { kind: "cancel_turn" }
  | { kind: "request_privacy_mode"; enabled: boolean }
  | { kind: "start_voice_capture"; operationEpoch: number }
  | { kind: "stop_voice_capture"; operationEpoch: number; streamId: string }
  | { kind: "transcribe_voice"; operationEpoch: number; streamId: string; uploadId: string }
  | {
      kind: "play_voice_segment";
      conversationId: string;
      runId: string;
      generation: number;
      ordinal: number;
      segmentId: string;
      text: string;
    }
  | { kind: "cancel_voice_capture"; operationEpoch: number }
  | { kind: "abort_turn_stream" }
  | { kind: "stop_playback" }
  | { kind: "schedule_voice_cooldown_done"; until: number }
  | { kind: "dismiss_bubble" }
  | {
      kind: "defer_learning_proposal";
      proposalId: string;
      actionName: string;
      target: string;
      impact: string;
    };

export interface PetReducerResultV1 {
  state: PetRuntimeStateV1;
  effects: PetEffectV1[];
}

// ─── 5. Derived character presentation (02 §4, fixed priority) ───────────

export type CharacterPresentationV1 =
  | "hidden"
  | "idle"
  | "invite"
  | "listen"
  | "think"
  | "analyze"
  | "speak"
  | "navigate"
  | "encourage"
  | "celebrate"
  | "uncertain";

export function deriveCharacterPresentation(
  state: PetRuntimeStateV1,
): CharacterPresentationV1 {
  const { lifecycle, voice, turn, bubble, context } = state;
  if (
    lifecycle.kind === "booting" ||
    lifecycle.kind === "hidden" ||
    lifecycle.kind === "suspended" ||
    lifecycle.kind === "auth_required"
  ) {
    return "hidden";
  }
  if (lifecycle.kind === "fatal") return "uncertain";
  if (voice.kind === "listening" || voice.kind === "finalizing") return "listen";
  if (voice.kind === "transcribing") return "think";
  if (voice.kind === "speaking") return "speak";
  if (turn.kind === "running") {
    if (turn.phase === "acting") return "analyze";
    if (turn.phase === "thinking" || turn.phase === "streaming") return "think";
  }
  if (turn.kind === "error" || bubble.kind === "error") return "uncertain";
  if (bubble.kind === "incoming" && !context.privacyMode) return "invite";
  return "idle";
}

// ─── 方案 16 §9.3 PetRuntimeV2 正交状态（V1 域 + 会话外域聚合投影） ────────

export type PetAttentionV2 = "passive" | "cue_pending" | "cue_visible" | "engaged" | "dnd";
export type PetTaskV2 =
  | "none"
  | "attached"
  | "assisting"
  | "proposing"
  | "confirming"
  | "executing"
  | "reporting";
export type PetJourneyV2 =
  | "not_offered"
  | "offered"
  | "active"
  | "paused"
  | "skipped"
  | "completed"
  | "recoverable_error";
export type PetMemorySyncV2 = "idle" | "reading" | "writing" | "failed";

/**
 * §9.3 正交状态：渲染优先级 安全/off > 用户输入或语音 > 当前回答 > 操作确认 >
 * 执行结果 > 主动提示 > idle。由 V1 runtime 状态 + Journey/Delivery 外部信号
 * 投影得到（非第二真相源）。
 */
export interface PetRuntimeV2 {
  lifecycle: "boot" | "auth" | "onboarding" | "ready" | "suspended" | "off" | "fault";
  attention: PetAttentionV2;
  task: PetTaskV2;
  turn: ConversationTurnStateV1;
  journey: PetJourneyV2;
  activeContext: unknown | null;
  proactiveQueue: unknown[];
  memorySync: PetMemorySyncV2;
}

/** §9.4 PetPresentationV2 气泡协议（messageId 引用同一响应中已持久化的 AssistantMessage）。 */
export type PetPresentationChoiceV2 =
  | { kind: "reply"; choiceId: string; label: string; replyText: string }
  | { kind: "proposal"; choiceId: string; label: string; proposalId: string };

export interface PetPresentationV2 {
  messageId: string;
  speechMode: "text_only" | "speak_message";
  choices?: PetPresentationChoiceV2[];
  proposedAction?: { proposalId: string; impactSummary: string };
  progressCue?: { state: "waiting" | "processing" | "ready" | "failed" };
  contextRef?: { contextId: string; revision: string };
  dismissPolicy: "auto" | "explicit" | "persistent_until_result";
}
