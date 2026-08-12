import {
  type PetEffectV1,
  type PetReducerResultV1,
  type PetRuntimeContextV1,
  type PetRuntimeEventV1,
  type PetRuntimeStateV1,
  type PetActionV1WithDemo,
} from "./pet-runtime-types";
import { PLAYBACK_COOLDOWN_MS } from "../voice/companion-playback";

/**
 * Pure P1 reducer (02 §3). Returns next state + effect descriptors; unknown
 * events fail closed (state unchanged, content-free diagnostic). P1 runs the
 * deterministic fixture pipeline — the same events P2's SSE adapter will feed.
 */

export function createInitialPetRuntimeState(context: Partial<PetRuntimeContextV1>): PetRuntimeStateV1 {
  return {
    lifecycle: { kind: "booting" },
    occluded: false,
    turn: { kind: "idle" },
    bubble: { kind: "hidden" },
    composer: { kind: "closed" },
    voice: { kind: "idle", operationEpoch: 0 },
    menu: { kind: "closed" },
    emotion: { cue: null, receivedAt: 0 },
    window: { kind: "passive" },
    context: {
      surfaceId: context.surfaceId ?? "unknown",
      surfaceKind: context.surfaceKind ?? "web_fallback",
      userId: null,
      workspaceId: null,
      accountEpoch: 0,
      conversationId: null,
      latestEventSeq: 0,
      inboxConversationId: null,
      inboxLatestEventSeq: 0,
      activeGeneration: 0,
      online: true,
      reducedMotion: false,
      animationOff: false,
      voiceOff: false,
      privacyMode: false,
      windowStateRevision: 0,
    },
  };
}

// ─── Generation / cursor guard (02 §5.1, P1 subset) ──────────────────────

export type EventDispositionV1 =
  | "apply"
  | "duplicate"
  | "stale"
  | "future"
  | "unrelated";

const RUN_SCOPED_EVENT_TYPES = new Set<string>([
  "turn.accepted",
  "assistant.status",
  "assistant.delta",
  "assistant.final",
  "turn.cancelled",
  "turn.failed",
  "voice.segments",
]);

export function classifyDialogueEvent(
  context: PetRuntimeContextV1,
  event: Extract<PetRuntimeEventV1, { seq: number }>,
): EventDispositionV1 {
  if (!RUN_SCOPED_EVENT_TYPES.has(event.type)) return "unrelated";
  // L11：事件世代落后于当前账号世代（global off 后旧 run 的迟到事件）→
  // 拒绝，防止 global off 之前的输出污染新会话。
  if ("accountEpoch" in event && event.accountEpoch !== undefined && event.accountEpoch < context.accountEpoch) return "stale";
  if (event.seq <= context.latestEventSeq) return "duplicate";
  if (event.seq !== context.latestEventSeq + 1) return "future";
  if (!("generation" in event) || event.generation === undefined) return "apply";
  if (event.type === "turn.accepted") {
    // turn.accepted establishes the new generation (02 §5.1 POST response
    // semantics): any generation >= active is adopted and becomes the fence.
    if (event.generation < context.activeGeneration) return "stale";
    return "apply";
  }
  if (event.generation < context.activeGeneration) return "stale";
  if (event.generation > context.activeGeneration) return "future";
  return "apply";
}

function withSeq(
  state: PetRuntimeStateV1,
  seq: number,
): PetRuntimeStateV1 {
  return {
    ...state,
    context: { ...state.context, latestEventSeq: seq },
  };
}

// ─── Reducer ─────────────────────────────────────────────────────────────

export function petReducer(
  state: PetRuntimeStateV1,
  action: PetActionV1WithDemo,
): PetReducerResultV1 {
  const effects: PetEffectV1[] = [];

  switch (action.type) {
    // ── UI intents ────────────────────────────────────────────────
    case "character.clicked": {
      if (state.composer.kind === "editing") {
        return { state, effects: [{ kind: "request_text_input_focus" }] };
      }
      if (state.composer.kind === "submitting") return { state, effects };
      return {
        state: {
          ...state,
          composer: { kind: "editing", draft: state.composer.draft ?? "" },
          menu: { kind: "closed" },
          window: { kind: "text_input" },
          context: { ...state.context, privacyMode: state.context.privacyMode },
        },
        effects: [
          { kind: "set_interaction_mode", mode: "text_input" },
          { kind: "request_text_input_focus" },
        ],
      };
    }

    case "composer.opened": {
      if (state.composer.kind === "closed") {
        return {
          state: {
            ...state,
            composer: { kind: "editing", draft: state.composer.draft ?? "" },
            menu: { kind: "closed" },
            // A passive incoming bubble yields to the user's own interaction:
            // the bubble shows exactly one current surface (01 §6.1).
            bubble: state.bubble.kind === "incoming" ? { kind: "hidden" } : state.bubble,
            window: { kind: "text_input" },
          },
          effects: [
            { kind: "set_interaction_mode", mode: "text_input" },
            { kind: "request_text_input_focus" },
          ],
        };
      }
      return { state, effects };
    }

    case "composer.draft_changed": {
      if (state.composer.kind !== "editing") return { state, effects };
      return {
        // 手工修改 ASR 文本后，不能继续携带只对原始 transcript 有效的
        // voiceArtifactId/hash；这会让服务端严格绑定失败或把编辑伪装成 voice。
        state: { ...state, composer: { kind: "editing", draft: action.draft } },
        effects,
      };
    }

    case "composer.submitted": {
      if (state.composer.kind !== "editing" || state.composer.draft.trim().length === 0) {
        return { state, effects };
      }
      // 回复生成中禁止发起并发 turn（UI 门控的防御性双保险；草稿保留不丢）。
      if (state.turn.kind === "running") {
        return { state, effects };
      }
      // UUID 必须与真实发送一致（服务端 schema 要求 uuid；provider 不再重生成）。
      const clientMessageId = crypto.randomUUID();
      const idempotencyKey = crypto.randomUUID();
      return {
        state: {
          ...state,
          composer: {
            kind: "submitting",
            draftSnapshot: state.composer.draft,
            clientMessageId,
            voiceArtifactId: state.composer.voiceArtifactId,
            transcriptSha256: state.composer.transcriptSha256,
          },
          turn: {
            kind: "submitting",
            clientMessageId,
            idempotencyKey,
            input: { kind: "text" },
          },
          bubble: { kind: "turn", ref: { kind: "client", clientMessageId } },
          window: { kind: "text_input" },
        },
        effects: [
          {
            kind: "submit_turn",
            clientMessageId,
            idempotencyKey,
            draft: state.composer.draft,
            voiceArtifactId: state.composer.voiceArtifactId,
            transcriptSha256: state.composer.transcriptSha256,
          },
        ],
      };
    }

    case "composer.closed": {
      if (state.composer.kind === "closed") return { state, effects };
      if (state.composer.kind === "submitting") return { state, effects };
      const focusEffect: PetEffectV1[] = state.window.kind === "text_input"
        ? [{ kind: "release_text_input_focus" }]
        : [];
      return {
        state: {
          ...state,
          composer: { kind: "closed", draft: state.composer.draft },
          window: state.menu.kind !== "closed" ? state.window : { kind: "passive" },
        },
        effects: state.menu.kind !== "closed"
          ? [...effects, ...focusEffect]
          : [...focusEffect, { kind: "set_interaction_mode", mode: "passive" }],
      };
    }

    case "menu.opened": {
      if (state.composer.kind === "submitting") return { state, effects };
      const menuClosed = state.menu.kind === "closed";
      const closedComposer = state.composer.kind === "editing"
        ? { kind: "closed" as const, draft: state.composer.draft }
        : state.composer;
      return {
        state: {
          ...state,
          menu: menuClosed ? { kind: "root", focusItem: "say" } : state.menu,
          composer: menuClosed ? closedComposer : state.composer,
          window: menuClosed
            ? { kind: "interactive", reason: "menu" }
            : state.window,
        },
        effects: menuClosed
          ? [{ kind: "set_interaction_mode", mode: "interactive" }]
          : effects,
      };
    }

    case "menu.navigated": {
      const focusItem = action.target === "root" ? "say" : action.target === "study" ? "resume" : "full_conversation";
      return {
        state: {
          ...state,
          menu:
            action.target === "root"
              ? { kind: "root", focusItem }
              : action.target === "study"
                ? { kind: "study", focusItem }
                : { kind: "more", focusItem },
        },
        effects,
      };
    }

    case "menu.closed": {
      if (state.menu.kind === "closed") return { state, effects };
      const needsInteractive = state.composer.kind !== "closed" || state.bubble.kind !== "hidden";
      return {
        state: {
          ...state,
          menu: { kind: "closed" },
          window: needsInteractive
            ? { kind: "interactive", reason: "bubble" }
            : { kind: "passive" },
        },
        effects: needsInteractive
          ? effects
          : [{ kind: "set_interaction_mode", mode: "passive" }],
      };
    }

    case "window.drag_started": {
      if (state.window.kind === "dragging") return { state, effects };
      return {
        state: { ...state, window: { kind: "dragging" } },
        effects: [{ kind: "set_interaction_mode", mode: "dragging" }],
      };
    }

    case "window.drag_ended": {
      if (state.window.kind !== "dragging") return { state, effects };
      const mode = state.composer.kind !== "closed"
        ? "text_input"
        : state.menu.kind !== "closed" || state.bubble.kind !== "hidden"
          ? "interactive"
          : "passive";
      return {
        state: {
          ...state,
          window: mode === "text_input"
            ? { kind: "text_input" }
            : mode === "interactive"
              ? { kind: "interactive", reason: state.menu.kind !== "closed" ? "menu" : "bubble" }
              : { kind: "passive" },
        },
        effects: [{ kind: "set_interaction_mode", mode }],
      };
    }

    case "privacy_mode.set_requested": {
      return {
        state,
        effects: [{ kind: "request_privacy_mode", enabled: action.enabled }],
      };
    }

    case "turn.cancel_requested": {
      if (state.turn.kind !== "running") return { state, effects };
      return {
        state,
        effects: [{ kind: "cancel_turn" }],
      };
    }

    case "voice.toggle_requested": {
      // 点按切换：idle/speaking → 开始，listening → 结束。不存在长按语义。
      // Q4 fix：把“发送中”与“语音关闭”拆开——发送中静默忽略（不弹错误
      // 气泡），语音关闭才显示 voice_disabled 提示，避免两种无关场景混淆。
      if (state.composer.kind === "submitting") return { state, effects };
      if (state.context.voiceOff) {
        return {
          state: {
            ...state,
            voice: {
              kind: "error",
              code: "voice_disabled",
              recoverable: true,
              operationEpoch: state.voice.operationEpoch,
            },
            bubble: { kind: "voice_status" },
            menu: { kind: "closed" },
            window: { kind: "interactive", reason: "bubble" },
          },
          effects: [{ kind: "set_interaction_mode", mode: "interactive" }],
        };
      }

      if (state.voice.kind === "requesting_permission") {
        const operationEpoch = state.voice.operationEpoch;
        return {
          state: {
            ...state,
            voice: {
              kind: "cancelled",
              reason: "user_cancelled",
              operationEpoch: operationEpoch + 1,
            },
            bubble: state.bubble.kind === "voice_status" ? { kind: "hidden" } : state.bubble,
            window: { kind: "passive" },
          },
          effects: [
            { kind: "cancel_voice_capture", operationEpoch },
            { kind: "set_interaction_mode", mode: "passive" },
          ],
        };
      }

      if (state.voice.kind === "listening") {
        return {
          state: {
            ...state,
            voice: {
              kind: "finalizing",
              streamId: state.voice.streamId,
              operationEpoch: state.voice.operationEpoch,
            },
            bubble: { kind: "voice_status" },
          },
          effects: [{
            kind: "stop_voice_capture",
            operationEpoch: state.voice.operationEpoch,
            streamId: state.voice.streamId,
          }],
        };
      }

      if (
        state.voice.kind !== "idle" &&
        state.voice.kind !== "cancelled" &&
        state.voice.kind !== "error" &&
        state.voice.kind !== "speaking" &&
        // §11.4：外置语音按钮点按可立即跳过 cooldown（不等待剩余冷却）。
        state.voice.kind !== "cooldown"
      ) {
        return { state, effects };
      }

      const operationEpoch = state.voice.operationEpoch + 1;
      const interruptingPlayback = state.voice.kind === "speaking";
      return {
        state: {
          ...state,
          voice: { kind: "requesting_permission", operationEpoch },
          bubble: { kind: "voice_status" },
          composer: state.composer.kind === "editing"
            ? { kind: "closed", draft: state.composer.draft }
            : state.composer,
          menu: { kind: "closed" },
          window: { kind: "interactive", reason: "bubble" },
        },
        effects: [
          ...(interruptingPlayback ? [{ kind: "stop_playback" as const }] : []),
          { kind: "set_interaction_mode", mode: "interactive" },
          { kind: "start_voice_capture", operationEpoch },
        ],
      };
    }

    case "voice.cancel_requested": {
      if (state.voice.kind !== "listening" && state.voice.kind !== "requesting_permission") {
        return { state, effects };
      }
      const operationEpoch = state.voice.operationEpoch;
      return {
        state: {
          ...state,
          voice: {
            kind: "cancelled",
            reason: "user_cancelled",
            operationEpoch: operationEpoch + 1,
          },
          bubble: state.bubble.kind === "voice_status" ? { kind: "hidden" } : state.bubble,
          window: { kind: "passive" },
        },
        effects: [
          { kind: "cancel_voice_capture", operationEpoch },
          { kind: "set_interaction_mode", mode: "passive" },
        ],
      };
    }

    case "bubble.dismissed": {
      if (state.bubble.kind === "hidden") return { state, effects };
      return {
        state: {
          ...state,
          bubble: { kind: "hidden" },
          // 2026-08-12（麦克风弹框关不掉修复）：voice error 气泡由
          // voiceBubbleView 按 voice.kind==="error" 渲染（优先级高于
          // bubble），只隐藏 bubble 会立刻重新渲染——必须同步把 voice
          // 复位到 idle，错误提示才能真正关掉（用户可继续打字）。
          voice:
            state.voice.kind === "error"
              ? { kind: "idle" as const, operationEpoch: state.voice.operationEpoch }
              : state.voice,
          window:
            state.menu.kind !== "closed" || state.composer.kind !== "closed"
              ? state.window
              : { kind: "passive" },
        },
        effects: state.menu.kind === "closed" && state.composer.kind === "closed"
          ? [{ kind: "dismiss_bubble" }]
        : effects,
      };
    }

    case "bubble.learning_proposal_received": {
      // §4.2 气泡优先级：用户主动回合(2) > 学习动作确认(3)。回复生成中
      // 不得用确认卡覆盖正在流式输出的回合气泡——挂起，由接线层在当前
      // 回合结束后重派发本事件，届时正常显示确认卡。
      if (state.turn.kind === "running") {
        const needsInteractive =
          state.composer.kind !== "closed" || state.bubble.kind !== "hidden";
        return {
          state: {
            ...state,
            menu: { kind: "closed" },
            window: needsInteractive ? state.window : { kind: "passive" },
          },
          effects: [
            ...effects,
            {
              kind: "defer_learning_proposal",
              proposalId: action.proposalId,
              actionName: action.actionName,
              target: action.target,
              impact: action.impact,
            },
          ],
        };
      }
      return {
        state: {
          ...state,
          bubble: {
            kind: "confirmation",
            proposalId: action.proposalId,
            actionName: action.actionName,
            target: action.target,
            impact: action.impact,
          },
          menu: { kind: "closed" },
          composer: state.composer.kind === "editing"
            ? { kind: "closed", draft: state.composer.draft }
            : state.composer,
          window: { kind: "interactive", reason: "bubble" },
        },
        effects: [{ kind: "set_interaction_mode", mode: "interactive" }],
      };
    }

    // ── Runtime / system events ────────────────────────────────────
    case "bootstrap.authenticated": {
      return {
        state: {
          ...state,
          lifecycle: { kind: "visible" },
          context: {
            ...state.context,
            userId: action.userId,
            workspaceId: action.workspaceId,
            accountEpoch: action.accountEpoch,
            animationOff: action.animationOff ?? state.context.animationOff,
            voiceOff: action.voiceOff ?? state.context.voiceOff,
          },
        },
        effects,
      };
    }

    case "bootstrap.auth_required": {
      return {
        state: { ...state, lifecycle: { kind: "auth_required" }, window: { kind: "passive" } },
        effects: [{ kind: "set_interaction_mode", mode: "passive" }],
      };
    }

    case "account.preferences_changed": {
      const voiceWasEnabled = !state.context.voiceOff;
      const voiceNowDisabled = action.voiceOff;
      const voiceDisabledNow = voiceWasEnabled && voiceNowDisabled;
      return {
        state: {
          ...state,
          voice: voiceDisabledNow
            ? { kind: "idle", operationEpoch: state.voice.operationEpoch + 1 }
            : state.voice,
          context: {
            ...state.context,
            accountEpoch: Math.max(state.context.accountEpoch, action.accountEpoch),
            animationOff: action.animationOff,
            voiceOff: action.voiceOff,
          },
        },
        effects: voiceDisabledNow
          ? [
              { kind: "cancel_voice_capture", operationEpoch: state.voice.operationEpoch },
              { kind: "stop_playback" },
            ]
          : effects,
      };
    }

    case "account.global_off": {
      return {
        state: {
          ...state,
          lifecycle: { kind: "hidden", reason: "global_off" },
          voice: { kind: "idle", operationEpoch: state.voice.operationEpoch + 1 },
          menu: { kind: "closed" },
          window: { kind: "passive" },
          context: { ...state.context, accountEpoch: Math.max(state.context.accountEpoch, action.epoch) },
        },
        effects: [
          { kind: "abort_turn_stream" },
          { kind: "cancel_voice_capture", operationEpoch: state.voice.operationEpoch },
          { kind: "stop_playback" },
          { kind: "set_interaction_mode", mode: "passive" },
        ],
      };
    }

    case "workspace.changed": {
      // 02: clear all scoped state and re-bootstrap.
      return {
        state: {
          ...state,
          lifecycle: { kind: "booting" },
          turn: { kind: "idle" },
          bubble: { kind: "hidden" },
          composer: { kind: "closed" },
          voice: { kind: "idle", operationEpoch: state.voice.operationEpoch + 1 },
          menu: { kind: "closed" },
          window: { kind: "passive" },
          context: {
            ...state.context,
            workspaceId: action.workspaceId,
            accountEpoch: action.accountEpoch,
            animationOff: action.animationOff ?? state.context.animationOff,
            voiceOff: action.voiceOff ?? state.context.voiceOff,
            conversationId: null,
            latestEventSeq: 0,
            activeGeneration: 0,
          },
        },
        effects: [
          { kind: "abort_turn_stream" },
          { kind: "cancel_voice_capture", operationEpoch: state.voice.operationEpoch },
          { kind: "stop_playback" },
        ],
      };
    }

    case "network.online":
      return { state: { ...state, context: { ...state.context, online: true } }, effects };
    case "network.offline":
      return { state: { ...state, context: { ...state.context, online: false } }, effects };

    case "conversation.restored": {
      const { snapshot } = action;
      const active = snapshot.activeRun;
      const pending = snapshot.pendingProposal;
      const restoredTurn: PetRuntimeStateV1["turn"] = active
        ? {
            kind: "running",
            conversationId: active.conversationId,
            runId: active.id,
            generation: active.generation,
            phase: active.phase ?? "accepted",
            previewText: active.previewText,
            lastSeq: active.lastEventSeq,
          }
        : { kind: "idle" };
      const restoredBubble: PetRuntimeStateV1["bubble"] = pending
        ? {
            kind: "confirmation",
            proposalId: pending.proposalId,
            actionName: pending.title,
            target: pending.targetSummary,
            impact: pending.impactSummary,
          }
        : snapshot.activeActionRun
          ? {
              kind: "action_pending",
              actionRunId: snapshot.activeActionRun.actionRunId,
              summary: snapshot.activeActionRun.safeSummary ?? "正在执行已确认的学习动作…",
            }
        : active
          ? { kind: "turn", ref: { kind: "run", runId: active.id } }
          : { kind: "hidden" };
      return {
        state: {
          ...state,
          turn: restoredTurn,
          bubble: restoredBubble,
          // B4 fix：recovery/restore 不应清掉用户正在编辑的草稿。仅当
          // composer 未在编辑时才收起；编辑中保留 draft（用户明确输入
          // 的内容只存在 renderer 内存，restore 无权丢弃）。
          composer:
            state.composer.kind === "editing"
              ? state.composer
              : { kind: "closed" },
          voice: { kind: "idle", operationEpoch: state.voice.operationEpoch + 1 },
          menu: { kind: "closed" },
          window: pending || snapshot.activeActionRun || state.composer.kind === "editing"
            ? { kind: "interactive", reason: "bubble" }
            : { kind: "passive" },
          context: {
            ...state.context,
            conversationId: snapshot.conversation.id,
            latestEventSeq: snapshot.latestEventSeq,
            activeGeneration: active?.generation ?? 0,
          },
        },
        effects: [
          { kind: "stop_playback" },
          { kind: "set_interaction_mode", mode: pending || snapshot.activeActionRun ? "interactive" : "passive" },
        ],
      };
    }

    case "system.suspended": {
      return {
        state: {
          ...state,
          lifecycle: { kind: "suspended", reason: action.reason },
          voice: { kind: "idle", operationEpoch: state.voice.operationEpoch + 1 },
        },
        effects: [
          // Sleep, lock and temporary hide are all non-essential-activity
          // boundaries. Abort both the local SSE and the server run so a
          // hidden Pet cannot keep consuming provider/network resources.
          { kind: "abort_turn_stream" as const },
          { kind: "cancel_voice_capture", operationEpoch: state.voice.operationEpoch },
          { kind: "stop_playback" },
          { kind: "set_interaction_mode", mode: "passive" },
        ],
      };
    }

    case "system.resumed": {
      return {
        state: {
          ...state,
          lifecycle: state.context.userId ? { kind: "visible" } : { kind: "auth_required" },
        },
        effects,
      };
    }

    // 2026-08-11（性能专项）：窗口遮挡仅暂停渲染，不中止会话/语音——
    // 与 system.suspended（中止流）语义区分。
    case "system.occluded": {
      return {
        state: { ...state, occluded: action.occluded },
        effects: [],
      };
    }

    case "desktop.window_state_changed": {
      const windowState = action.state;
      // §3.3：只接受更高 revision，丢弃乱序/迟到的旧状态广播。
      if (windowState.revision < state.context.windowStateRevision) return { state, effects };
      return {
        state: {
          ...state,
          context: {
            ...state.context,
            privacyMode: windowState.privacyMode,
            windowStateRevision: windowState.revision,
          },
        },
        effects,
      };
    }

    case "voice.permission_result": {
      if (state.voice.kind !== "requesting_permission") return { state, effects };
      if (action.operationEpoch !== state.voice.operationEpoch) return { state, effects };
      if (!action.granted) {
        return {
          state: {
            ...state,
            voice: {
              kind: "error",
              code: "permission_denied",
              recoverable: true,
              operationEpoch: action.operationEpoch,
            },
          },
          effects,
        };
      }
      return {
        state: {
          ...state,
          voice: {
            kind: "listening",
            startedAt: Date.now(),
            streamId: `stream-${action.operationEpoch}`,
            operationEpoch: action.operationEpoch,
          },
        },
        effects,
      };
    }

    case "voice.transcript_ready": {
      if (
        state.voice.kind !== "transcribing" ||
        action.operationEpoch !== state.voice.operationEpoch ||
        action.streamId !== state.voice.streamId ||
        action.uploadId !== state.voice.uploadId
      ) return { state, effects };
      return {
        state: {
          ...state,
          voice: { kind: "idle", operationEpoch: state.voice.operationEpoch },
          bubble: { kind: "hidden" },
          composer: {
            kind: "editing",
            draft: action.text,
            // 本地 ASR（P6 §13）无服务端 artifact——null 时存 undefined，
            // 提交走 text inputKind（普通聊天消息，不伪装正式 Voice Artifact）。
            voiceArtifactId: action.voiceArtifactId ?? undefined,
            transcriptSha256: action.transcriptSha256 ?? undefined,
          },
          menu: { kind: "closed" },
          window: { kind: "text_input" },
        },
        effects: [
          { kind: "set_interaction_mode", mode: "text_input" },
          { kind: "request_text_input_focus" },
        ],
      };
    }

    case "voice.transcription_failed": {
      if (
        action.operationEpoch !== state.voice.operationEpoch ||
        (state.voice.kind !== "transcribing" && state.voice.kind !== "listening" && state.voice.kind !== "finalizing")
      ) return { state, effects };
      return {
        state: {
          ...state,
          voice: { kind: "error", code: action.code, recoverable: action.recoverable, operationEpoch: action.operationEpoch },
          bubble: { kind: "voice_status" },
          window: { kind: "interactive", reason: "bubble" },
        },
        effects: [{ kind: "set_interaction_mode", mode: "interactive" }],
      };
    }

    case "voice.track_started": {
      if (state.voice.kind !== "requesting_permission") return { state, effects };
      if (action.operationEpoch !== state.voice.operationEpoch) return { state, effects };
      return {
        state: {
          ...state,
          voice: {
            kind: "listening",
            startedAt: Date.now(),
            streamId: action.streamId,
            operationEpoch: action.operationEpoch,
          },
        },
        effects,
      };
    }

    case "voice.track_stopped": {
      // B3 fix：手动停止路径是 listening →(toggle)→ finalizing → stop →
      // track_stopped；但 60s 自动停录（MAX_COMPANION_AUDIO_DURATION_MS
      // 的 stopTimer 触发 recorder.stop()）时 voice 仍是 listening，没有
      // 经过 finalizing。若这里只接受 finalizing，自动停录的 track_stopped
      // 会被静默拒绝，UI 永远卡在 listening 而 mic 已停。因此 listening
      // 与 finalizing 都允许进入转写。
      if (state.voice.kind !== "finalizing" && state.voice.kind !== "listening") {
        return { state, effects };
      }
      if (
        action.operationEpoch !== state.voice.operationEpoch ||
        action.streamId !== state.voice.streamId
      ) return { state, effects };
      return {
        state: {
          ...state,
          voice: {
            kind: "transcribing",
            streamId: action.streamId,
            uploadId: `upload-${action.operationEpoch}`,
            operationEpoch: action.operationEpoch,
          },
        },
        effects: [{
          kind: "transcribe_voice",
          operationEpoch: action.operationEpoch,
          streamId: action.streamId,
          uploadId: `upload-${action.operationEpoch}`,
        }],
      };
    }

    // ── Dialogue events (generation/cursor guarded) ────────────────
    case "turn.accepted": {
      if (state.turn.kind !== "submitting") return { state, effects };
      const disposition = classifyDialogueEvent(state.context, action);
      if (disposition === "duplicate" || disposition === "stale") {
        return { state: withSeq(state, action.seq), effects };
      }
      if (disposition === "future") return { state, effects };
      return {
        state: withSeq(
          {
            ...state,
            composer: { kind: "closed", draft: "" },
            turn: {
              kind: "running",
              conversationId: action.conversationId,
              runId: action.runId,
              generation: action.generation,
              phase: "accepted",
              previewText: "",
              lastSeq: action.seq,
            },
            bubble: { kind: "turn", ref: { kind: "run", runId: action.runId } },
            window: state.menu.kind !== "closed" ? state.window : { kind: "passive" },
            context: {
              ...state.context,
              conversationId: action.conversationId,
              activeGeneration: action.generation,
            },
          },
          action.seq,
        ),
        effects,
      };
    }

    case "assistant.status": {
      if (state.turn.kind !== "running" || state.turn.runId !== action.runId) {
        return { state, effects };
      }
      const disposition = classifyDialogueEvent(state.context, action);
      if (disposition !== "apply") {
        return disposition === "duplicate" || disposition === "stale"
          ? { state: withSeq(state, action.seq), effects }
          : { state, effects };
      }
      return {
        state: withSeq(
          {
            ...state,
            turn: { ...state.turn, phase: action.phase, lastSeq: action.seq },
          },
          action.seq,
        ),
        effects,
      };
    }

    case "assistant.delta": {
      if (state.turn.kind !== "running" || state.turn.runId !== action.runId) {
        return { state, effects };
      }
      const disposition = classifyDialogueEvent(state.context, action);
      if (disposition !== "apply") {
        return disposition === "duplicate" || disposition === "stale"
          ? { state: withSeq(state, action.seq), effects }
          : { state, effects };
      }
      const generationMatches = action.generation === state.turn.generation;
      if (!generationMatches) {
        // B7 fix：generation 不匹配的 delta 属于旧/未来 run，不得写入
        // previewText；但该事件仍被 classifyDialogueEvent 判为 apply（seq
        // 连续、generation 与 activeGeneration 一致），必须消费其 seq，
        // 否则后续真实事件会因 seq 不连续被误判 future 而丢失。
        return { state: withSeq(state, action.seq), effects };
      }
      return {
        state: withSeq(
          {
            ...state,
            turn: {
              ...state.turn,
              phase: "streaming",
              previewText: state.turn.previewText + action.text,
              lastSeq: action.seq,
            },
          },
          action.seq,
        ),
        effects,
      };
    }

    case "assistant.final": {
      if (state.turn.kind !== "running" || state.turn.runId !== action.runId) {
        return { state, effects };
      }
      const disposition = classifyDialogueEvent(state.context, action);
      if (disposition !== "apply") {
        return disposition === "duplicate" || disposition === "stale"
          ? { state: withSeq(state, action.seq), effects }
          : { state, effects };
      }
      const generationMatches = action.generation === state.turn.generation;
      if (!generationMatches) {
        // B7 fix：与 assistant.delta 同理，消费 seq 但不覆盖当前 turn。
        return { state: withSeq(state, action.seq), effects };
      }
      return {
        state: withSeq(
          {
            ...state,
            turn: {
              kind: "final",
              runId: action.runId,
              generation: action.generation,
              messageId: action.messageId,
              previewText: action.text,
            },
            bubble: { kind: "turn", ref: { kind: "run", runId: action.runId } },
          },
          action.seq,
        ),
        effects,
      };
    }

    case "voice.segments": {
      if (state.lifecycle.kind === "suspended" || state.lifecycle.kind === "hidden") {
        const disposition = classifyDialogueEvent(state.context, action);
        return disposition === "apply" || disposition === "duplicate" || disposition === "stale"
          ? { state: withSeq(state, action.seq), effects }
          : { state, effects };
      }
      // §11.5：barge-in 后用户已进入录音/识别流程（voiceBusy），但尚未提交
      // 新 turn，服务端 generation 未变——旧 run 迟到的 voice.segments 会通过
      // 下方 runId/generation 检查并置 voice=speaking，而 playback 层的
      // blockedFence 会拒绝这些段（队列为空），随后没有任何事件把 voice 拉回
      // idle，语音岛永久卡在 speaking。此处必须在录音/识别/权限/错误/取消
      // 流程中丢弃迟到 segments（仍推进 seq 游标，避免后续事件被误判 stale）。
      const voiceBusy =
        state.voice.kind === "requesting_permission" ||
        state.voice.kind === "listening" ||
        state.voice.kind === "finalizing" ||
        state.voice.kind === "transcribing" ||
        state.voice.kind === "cancelled" ||
        state.voice.kind === "error";
      if (voiceBusy) {
        const disposition = classifyDialogueEvent(state.context, action);
        return disposition === "apply" || disposition === "duplicate" || disposition === "stale"
          ? { state: withSeq(state, action.seq), effects }
          : { state, effects };
      }
      const turnRunId = state.turn.kind === "running" || state.turn.kind === "final"
        ? state.turn.runId
        : null;
      if (
        turnRunId !== action.runId ||
        state.context.activeGeneration !== action.generation
      ) return { state, effects };
      const disposition = classifyDialogueEvent(state.context, action);
      if (disposition !== "apply") {
        return disposition === "duplicate" || disposition === "stale"
          ? { state: withSeq(state, action.seq), effects }
          : { state, effects };
      }
      // M3（审计修复）：已在 speaking 且同 run 时，pump 正在播放旧段——保持
      // 当前 segmentId 不变（否则 playback_finished 的 segmentId 校验失配，
      // voice 停在 speaking 无恢复），但仍入队新段由 pump 按 ordinal 续播。
      if (
        state.voice.kind === "speaking" &&
        state.voice.runId === action.runId &&
        state.voice.generation === action.generation
      ) {
        return {
          state: withSeq(state, action.seq),
          effects: [{
            kind: "play_voice_segment",
            conversationId: action.conversationId,
            runId: action.runId,
            generation: action.generation,
            ordinal: action.segment.ordinal,
            segmentId: action.segment.segmentId,
            text: action.segment.text,
          }],
        };
      }
      return {
        state: withSeq(
          {
            ...state,
            voice: {
              kind: "speaking",
              runId: action.runId,
              generation: action.generation,
              segmentId: action.segment.segmentId,
              operationEpoch: state.voice.operationEpoch,
            },
          },
          action.seq,
        ),
        effects: [{
          kind: "play_voice_segment",
          conversationId: action.conversationId,
          runId: action.runId,
          generation: action.generation,
          ordinal: action.segment.ordinal,
          segmentId: action.segment.segmentId,
          text: action.segment.text,
        }],
      };
    }

    case "voice.playback_started": {
      if (
        state.lifecycle.kind === "suspended" ||
        state.lifecycle.kind === "hidden" ||
        action.generation !== state.context.activeGeneration
      ) return { state, effects };
      return {
        state: {
          ...state,
          voice: {
            kind: "speaking",
            runId: action.runId,
            generation: action.generation,
            segmentId: action.segmentId,
            operationEpoch: state.voice.operationEpoch,
          },
        },
        effects,
      };
    }

    case "voice.playback_finished": {
      if (
        state.voice.kind !== "speaking" ||
        state.voice.runId !== action.runId ||
        state.voice.generation !== action.generation ||
        state.voice.segmentId !== action.segmentId
      ) return { state, effects };
      const until = Date.now() + PLAYBACK_COOLDOWN_MS;
      return {
        state: {
          ...state,
          voice: { kind: "cooldown", until, operationEpoch: state.voice.operationEpoch },
        },
        effects: [...effects, { kind: "schedule_voice_cooldown_done", until }],
      };
    }

    case "voice.cooldown_done": {
      if (state.voice.kind !== "cooldown" || action.now < state.voice.until) return { state, effects };
      return {
        state: {
          ...state,
          voice: { kind: "idle", operationEpoch: state.voice.operationEpoch },
        },
        effects,
      };
    }

    case "turn.cancelled": {
      if (state.turn.kind !== "running") return { state, effects };
      const disposition = classifyDialogueEvent(state.context, action);
      if (disposition !== "apply") {
        return disposition === "duplicate" || disposition === "stale"
          ? { state: withSeq(state, action.seq), effects }
          : { state, effects };
      }
      return {
        state: withSeq(
          {
            ...state,
            turn: {
              kind: "cancelled",
              runId: action.runId,
              generation: action.generation,
            },
            voice: { kind: "idle", operationEpoch: state.voice.operationEpoch + 1 },
          },
          action.seq,
        ),
        // B2 fix：取消 turn 必须同时停掉已入队的 TTS 段与当前播放，
        // 否则 pumpRealPlayback 会继续消费 queue 并把 voice 重新拉回
        // speaking（用户点“停止回复”后仍能听到播报）。
        effects: [{ kind: "stop_playback" }],
      };
    }

    case "action.completed": {
      if (action.seq <= state.context.latestEventSeq) {
        return { state: withSeq(state, Math.max(state.context.latestEventSeq, action.seq)), effects };
      }
      return {
        state: withSeq(
          {
            ...state,
            bubble: {
              kind: "action_result",
              actionRunId: action.actionRunId,
              status: "completed",
              summary: action.safeSummary,
              route: action.route,
            },
            window: { kind: "interactive", reason: "bubble" },
          },
          action.seq,
        ),
        effects: [{ kind: "set_interaction_mode", mode: "interactive" }],
      };
    }

    case "action.failed": {
      if (action.seq <= state.context.latestEventSeq) {
        return { state: withSeq(state, Math.max(state.context.latestEventSeq, action.seq)), effects };
      }
      return {
        state: withSeq(
          {
            ...state,
            bubble: {
              kind: "action_result",
              actionRunId: action.actionRunId,
              status: "failed",
              summary: "这次学习动作没有完成，你可以稍后重试。",
              code: action.code,
              route: null,
            },
            window: { kind: "interactive", reason: "bubble" },
          },
          action.seq,
        ),
        effects: [{ kind: "set_interaction_mode", mode: "interactive" }],
      };
    }

    case "turn.failed": {
      const disposition = classifyDialogueEvent(state.context, action);
      // A terminal error is still a durable conversation event. Consume it
      // even when the local turn was already cleared, but never jump over a
      // gap (the recovery path owns future events).
      if (disposition === "future") return { state, effects };
      const nextSeq = Math.max(state.context.latestEventSeq, action.seq);
      if (state.turn.kind === "idle") {
        return { state: withSeq(state, nextSeq), effects };
      }
      const composer =
        state.composer.kind === "submitting"
          ? { kind: "editing" as const, draft: state.composer.draftSnapshot }
          : state.composer;
      return {
        state: withSeq(
          {
            ...state,
            turn: {
              kind: "error",
              code: action.code,
              recoverable: action.recoverable,
              runId: state.turn.kind === "running" ? state.turn.runId : undefined,
              generation:
                state.turn.kind === "running" ? state.turn.generation : undefined,
            },
            bubble: { kind: "error", code: action.code },
            composer,
          },
          nextSeq,
        ),
        effects,
      };
    }

    // ── P1 demo-only events (G02/G07/G09 evidence capture) ─────────
    case "bubble.incoming_fixture": {
      return {
        state: {
          ...state,
          bubble: {
            kind: "incoming",
            deliveryId: "fixture-delivery-1",
            messageId: "fixture-delivery-msg-1",
            previewText: action.text,
          },
          window:
            state.menu.kind !== "closed" || state.composer.kind !== "closed"
              ? state.window
              : { kind: "interactive", reason: "bubble" },
        },
        effects,
      };
    }

    case "bubble.confirmation_fixture": {
      return {
        state: {
          ...state,
          bubble: {
            kind: "confirmation",
            proposalId: "fixture-proposal-1",
            actionName: action.actionName,
            target: action.target,
            impact: action.impact,
          },
          window: { kind: "interactive", reason: "bubble" },
        },
        effects,
      };
    }

    case "voice.speaking_fixture": {
      return {
        state: {
          ...state,
          voice: {
            kind: "speaking",
            runId: action.runId,
            generation: action.generation,
            segmentId: action.segmentId,
            operationEpoch: state.voice.operationEpoch,
          },
        },
        effects,
      };
    }

    case "voice.transcript_fixture": {
      if (
        state.voice.kind !== "transcribing" ||
        action.operationEpoch !== state.voice.operationEpoch
      ) {
        return { state, effects };
      }
      return {
        state: {
          ...state,
          voice: { kind: "idle", operationEpoch: state.voice.operationEpoch },
          bubble: { kind: "hidden" },
          composer: { kind: "editing", draft: action.text },
          menu: { kind: "closed" },
          window: { kind: "text_input" },
        },
        effects: [
          { kind: "set_interaction_mode", mode: "text_input" },
          { kind: "request_text_input_focus" },
        ],
      };
    }

    case "voice.reset_fixture": {
      return {
        state: {
          ...state,
          voice: { kind: "idle", operationEpoch: state.voice.operationEpoch + 1 },
          bubble: state.bubble.kind === "voice_status" ? { kind: "hidden" } : state.bubble,
        },
        effects,
      };
    }

    default: {
      // Unknown / unimplemented event: fail closed, no state change.
      return { state, effects };
    }
  }
}
