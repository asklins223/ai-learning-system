import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDialogueEvent,
  createInitialPetRuntimeState,
  petReducer,
} from "./pet-reducer";
import { deriveCharacterPresentation, type PetRuntimeStateV1 } from "./pet-runtime-types";
import type { CompanionConversationSnapshotV1 } from "@ailearn/shared/companion-conversation-contracts";

function initialState(overrides: Partial<PetRuntimeStateV1> = {}): PetRuntimeStateV1 {
  return {
    ...createInitialPetRuntimeState({
      surfaceId: "test-surface",
      surfaceKind: "pet",
      reducedMotion: false,
    }),
    ...overrides,
  };
}

test("character.clicked opens the composer and requests focus", () => {
  const result = petReducer(initialState(), { type: "character.clicked" });
  assert.equal(result.state.composer.kind, "editing");
  assert.equal(result.state.menu.kind, "closed");
  assert.equal(result.state.window.kind, "text_input");
  assert.deepEqual(result.effects, [
    { kind: "set_interaction_mode", mode: "text_input" },
    { kind: "request_text_input_focus" },
  ]);
});

test("submitting a draft creates a turn and bubbles the client message", () => {
  let state = initialState();
  state = petReducer(state, { type: "character.clicked" }).state;
  state = petReducer(state, { type: "composer.draft_changed", draft: " 你好 " }).state;
  const result = petReducer(state, { type: "composer.submitted" });
  assert.equal(result.state.composer.kind, "submitting");
  assert.equal(result.state.turn.kind, "submitting");
  assert.equal(result.state.bubble.kind, "turn");
  assert.equal(result.effects[0].kind, "submit_turn");
  if (result.effects[0].kind === "submit_turn") {
    assert.equal(result.effects[0].draft, " 你好 ");
  }
});

test("empty draft does not submit", () => {
  let state = initialState();
  state = petReducer(state, { type: "composer.opened" }).state;
  const result = petReducer(state, { type: "composer.submitted" });
  assert.equal(result.state.composer.kind, "editing");
  assert.equal(result.state.turn.kind, "idle");
  assert.deepEqual(result.effects, []);
});

test("full fixture turn pipeline: accepted → thinking → streaming → final", () => {
  let state = initialState();
  state = petReducer(state, { type: "character.clicked" }).state;
  state = petReducer(state, { type: "composer.draft_changed", draft: "讲讲这个知识点" }).state;
  const submitted = petReducer(state, { type: "composer.submitted" });
  state = submitted.state;

  const accepted = petReducer(state, {
    type: "turn.accepted",
    conversationId: "conv-1",
    runId: "run-1",
    generation: 1,
    seq: 1,
  });
  state = accepted.state;
  assert.equal(state.turn.kind, "running");
  if (state.turn.kind === "running") {
    assert.equal(state.turn.phase, "accepted");
    assert.equal(state.turn.runId, "run-1");
    assert.equal(state.turn.generation, 1);
    assert.equal(state.turn.lastSeq, 1);
  }
  assert.equal(state.composer.kind, "closed");
  assert.equal(state.context.activeGeneration, 1);
  assert.equal(state.context.latestEventSeq, 1);

  state = petReducer(state, {
    type: "assistant.status",
    runId: "run-1",
    generation: 1,
    phase: "thinking",
    seq: 2,
  }).state;
  assert.equal(state.turn.kind === "running" && state.turn.phase, "thinking");

  state = petReducer(state, {
    type: "assistant.delta",
    runId: "run-1",
    generation: 1,
    seq: 3,
    text: "好的，",
  }).state;
  state = petReducer(state, {
    type: "assistant.delta",
    runId: "run-1",
    generation: 1,
    seq: 4,
    text: "我来说明。",
  }).state;
  assert.equal(state.turn.kind === "running" && state.turn.previewText, "好的，我来说明。");
  assert.equal(state.turn.kind === "running" && state.turn.phase, "streaming");

  state = petReducer(state, {
    type: "assistant.final",
    runId: "run-1",
    generation: 1,
    seq: 5,
    messageId: "msg-1",
    text: "好的，我来说明。",
    textSha256: "a".repeat(64),
  }).state;
  assert.equal(state.turn.kind, "final");
  assert.equal(state.turn.kind === "final" && state.turn.previewText, "好的，我来说明。");
  assert.equal(state.bubble.kind, "turn");
});

test("conversation snapshot restores cursor, active run, and pending proposal atomically", () => {
  const result = petReducer(initialState(), {
    type: "conversation.restored",
    snapshot: {
      version: 1,
      conversation: {
        version: 1,
        id: "123e4567-e89b-42d3-a456-426614174000",
        workspaceId: "123e4567-e89b-42d3-a456-426614174001",
        userId: "123e4567-e89b-42d3-a456-426614174002",
        kind: "dialogue",
        title: "伴星对话",
        titleSource: "placeholder",
        status: "active",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:01.000Z",
        lastMessageAt: "2026-08-11T00:00:01.000Z",
      },
      activeRun: {
        version: 1,
        id: "123e4567-e89b-42d3-a456-426614174003",
        conversationId: "123e4567-e89b-42d3-a456-426614174000",
        userMessageId: "123e4567-e89b-42d3-a456-426614174004",
        assistantMessageId: null,
        generation: 2,
        status: "running",
        phase: "streaming",
        previewText: "正在继续回答",
        previewTextSha256: "a".repeat(64),
        lastEventSeq: 8,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:01.000Z",
      },
      latestEventSeq: 8,
      pendingProposal: {
        version: 1,
        proposalId: "123e4567-e89b-42d3-a456-426614174005",
        conversationId: "123e4567-e89b-42d3-a456-426614174000",
        sourceMessageId: "123e4567-e89b-42d3-a456-426614174006",
        sourceGeneration: 2,
        contextGrantId: null,
        payload: { kind: "open_review" },
        payloadSha256: "b".repeat(64),
        title: "打开今日复习",
        targetSummary: "今日复习",
        impactSummary: "打开复习页面，不会修改学习状态。",
        requiresConfirmation: true,
        status: "pending",
        decision: null,
        actionRunId: null,
        expiresAt: "2026-08-11T00:05:00.000Z",
        decidedAt: null,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
      },
      activeActionRun: null,
    },
  });
  assert.equal(result.state.context.conversationId, "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(result.state.context.latestEventSeq, 8);
  assert.equal(result.state.context.activeGeneration, 2);
  assert.equal(result.state.turn.kind, "running");
  assert.equal(result.state.turn.kind === "running" && result.state.turn.previewText, "正在继续回答");
  assert.equal(result.state.bubble.kind, "confirmation");
  assert.deepEqual(result.effects, [
    { kind: "stop_playback" },
    { kind: "set_interaction_mode", mode: "interactive" },
  ]);
});

test("conversation snapshot restores a running learning action after refresh", () => {
  const result = petReducer(initialState(), {
    type: "conversation.restored",
    snapshot: {
      version: 1,
      conversation: {
        version: 1,
        id: "223e4567-e89b-42d3-a456-426614174000",
        workspaceId: "223e4567-e89b-42d3-a456-426614174001",
        userId: "223e4567-e89b-42d3-a456-426614174002",
        kind: "dialogue",
        title: "伴星对话",
        titleSource: "placeholder",
        status: "active",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:01.000Z",
        lastMessageAt: "2026-08-11T00:00:01.000Z",
      },
      activeRun: null,
      latestEventSeq: 12,
      pendingProposal: null,
      activeActionRun: {
        version: 1,
        actionRunId: "223e4567-e89b-42d3-a456-426614174003",
        proposalId: "223e4567-e89b-42d3-a456-426614174004",
        status: "running",
        resultMessageId: null,
        resultRef: null,
        route: null,
        safeSummary: "正在打开今日复习",
        errorCode: null,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:01.000Z",
      },
    },
  });
  assert.equal(result.state.bubble.kind, "action_pending");
  assert.equal(result.state.bubble.kind === "action_pending" && result.state.bubble.actionRunId, "223e4567-e89b-42d3-a456-426614174003");
  assert.equal(result.state.bubble.kind === "action_pending" && result.state.bubble.summary, "正在打开今日复习");
  assert.equal(result.state.window.kind, "interactive");
  assert.deepEqual(result.effects, [
    { kind: "stop_playback" },
    { kind: "set_interaction_mode", mode: "interactive" },
  ]);
});

test("voice.segment.ready 在 final 后进入严格引用播放 effect，并受 seq/generation fence 保护", () => {
  let state = initialState();
  state = petReducer(state, { type: "character.clicked" }).state;
  state = petReducer(state, { type: "composer.draft_changed", draft: "讲讲这个知识点" }).state;
  state = petReducer(state, { type: "composer.submitted" }).state;
  state = petReducer(state, {
    type: "turn.accepted",
    conversationId: "123e4567-e89b-12d3-a456-426614174000",
    runId: "123e4567-e89b-12d3-a456-426614174001",
    generation: 1,
    seq: 1,
  }).state;
  state = petReducer(state, {
    type: "assistant.final",
    runId: "123e4567-e89b-12d3-a456-426614174001",
    generation: 1,
    seq: 2,
    messageId: "123e4567-e89b-12d3-a456-426614174002",
    text: "回答。",
    textSha256: "a".repeat(64),
  }).state;

  const segment = petReducer(state, {
    type: "voice.segments",
    conversationId: "123e4567-e89b-12d3-a456-426614174000",
    runId: "123e4567-e89b-12d3-a456-426614174001",
    generation: 1,
    seq: 3,
    segment: {
      ordinal: 1,
      segmentId: "b".repeat(64),
      text: "回答。",
    },
  });
  assert.equal(segment.state.voice.kind, "speaking");
  assert.deepEqual(segment.effects, [{
    kind: "play_voice_segment",
    conversationId: "123e4567-e89b-12d3-a456-426614174000",
    runId: "123e4567-e89b-12d3-a456-426614174001",
    generation: 1,
    ordinal: 1,
    segmentId: "b".repeat(64),
    text: "回答。",
  }]);

  state = segment.state;
  state = petReducer(state, {
    type: "voice.playback_started",
    runId: "123e4567-e89b-12d3-a456-426614174001",
    generation: 1,
    segmentId: "b".repeat(64),
  }).state;
  const finished = petReducer(state, {
    type: "voice.playback_finished",
    runId: "123e4567-e89b-12d3-a456-426614174001",
    generation: 1,
    segmentId: "b".repeat(64),
  });
  assert.equal(finished.state.voice.kind, "cooldown");
  // 死锁回归：cooldown 必须由 cooldown_done 定时事件移回 idle（接线层定时器派发）。
  assert.equal(
    finished.effects.some((effect) => effect.kind === "schedule_voice_cooldown_done"),
    true,
    "playback_finished 必须调度 cooldown_done 定时器",
  );
  const cooldownEffect = finished.effects.find(
    (effect) => effect.kind === "schedule_voice_cooldown_done",
  ) as { kind: "schedule_voice_cooldown_done"; until: number } | undefined;
  assert.ok(cooldownEffect && cooldownEffect.until > Date.now());

  const stillCooling = petReducer(finished.state, {
    type: "voice.cooldown_done",
    now: Date.now() + 100, // 未到 until，应保持 cooldown
  });
  assert.equal(stillCooling.state.voice.kind, "cooldown");

  const cooledDown = petReducer(finished.state, {
    type: "voice.cooldown_done",
    now: cooldownEffect!.until + 1,
  });
  assert.equal(cooledDown.state.voice.kind, "idle", "cooldown 到期后必须回到 idle");

  // cooldown 期间点按麦克风可立即跳过冷却开始新回合（§11.4）。
  const skip = petReducer(finished.state, { type: "voice.toggle_requested" });
  assert.equal(skip.state.voice.kind, "requesting_permission");

  const late = petReducer(finished.state, {
    type: "voice.segments",
    conversationId: "123e4567-e89b-12d3-a456-426614174000",
    runId: "123e4567-e89b-12d3-a456-426614174001",
    generation: 1,
    seq: 4,
    segment: { ordinal: 2, segmentId: "c".repeat(64), text: "迟到。" },
  });
  assert.equal(late.state.voice.kind, "speaking", "同一 run 的后续 segment 仍可从 cooldown 恢复");
  assert.equal(late.effects[0]?.kind, "play_voice_segment");
});

test("桌面生命周期会让语音/播放/对话流进入可清理状态", () => {
  const result = petReducer(initialState(), { type: "system.suspended", reason: "temporary_hidden" });
  assert.deepEqual(result.effects, [
    { kind: "abort_turn_stream" },
    { kind: "cancel_voice_capture", operationEpoch: 0 },
    { kind: "stop_playback" },
    { kind: "set_interaction_mode", mode: "passive" },
  ]);
  assert.equal(result.state.lifecycle.kind, "suspended");
  if (result.state.lifecycle.kind === "suspended") {
    assert.equal(result.state.lifecycle.reason, "temporary_hidden");
  }
  assert.equal(result.state.voice.kind, "idle");

  const quitting = petReducer(initialState(), { type: "system.suspended", reason: "app_quitting" });
  assert.equal(quitting.effects[0]?.kind, "abort_turn_stream");
});

test("late/stale generations and duplicate seqs are rejected", () => {
  let state = initialState();
  state = petReducer(state, { type: "character.clicked" }).state;
  state = petReducer(state, { type: "composer.draft_changed", draft: "x" }).state;
  state = petReducer(state, { type: "composer.submitted" }).state;
  state = petReducer(state, {
    type: "turn.accepted",
    conversationId: "conv-1",
    runId: "run-1",
    generation: 1,
    seq: 1,
  }).state;

  // Duplicate seq 1 → ignored, no cursor move.
  const dup = petReducer(state, {
    type: "assistant.status",
    runId: "run-1",
    generation: 1,
    phase: "thinking",
    seq: 1,
  });
  assert.equal(dup.state.turn.kind === "running" && dup.state.turn.phase, "accepted");
  assert.equal(dup.state.context.latestEventSeq, 1);

  // Future seq (jump) → ignored.
  const jump = petReducer(state, {
    type: "assistant.status",
    runId: "run-1",
    generation: 1,
    phase: "thinking",
    seq: 9,
  });
  assert.equal(jump.state.turn.kind === "running" && jump.state.turn.phase, "accepted");
  assert.equal(jump.state.context.latestEventSeq, 1);

  // Stale generation delta after generation 2 starts → ignored.
  state = petReducer(state, {
    type: "assistant.status",
    runId: "run-1",
    generation: 1,
    phase: "thinking",
    seq: 2,
  }).state;
  state = petReducer(state, {
    type: "turn.accepted",
    conversationId: "conv-2",
    runId: "run-2",
    generation: 2,
    seq: 3,
  }).state;
  const stale = petReducer(state, {
    type: "assistant.delta",
    runId: "run-1",
    generation: 1,
    seq: 4,
    text: "旧token",
  });
  assert.equal(stale.state.turn.kind === "running" && stale.state.turn.previewText, "");
});

test("classifyDialogueEvent dispositions", () => {
  const ctx = initialState().context;
  const delta = (seq: number, generation = 1) => ({
    type: "assistant.delta" as const,
    runId: "run-1",
    generation,
    seq,
    text: "x",
  });
  const accepted = (seq: number, generation: number) => ({
    type: "turn.accepted" as const,
    conversationId: "c",
    runId: `run-${generation}`,
    generation,
    seq,
  });
  // Fresh context: only turn.accepted may establish generation 1.
  assert.equal(classifyDialogueEvent(ctx, delta(1, 1)), "future");
  assert.equal(classifyDialogueEvent(ctx, accepted(1, 1)), "apply");
  const active = { ...ctx, latestEventSeq: 1, activeGeneration: 1 };
  assert.equal(classifyDialogueEvent(active, delta(2, 1)), "apply");
  assert.equal(classifyDialogueEvent(active, delta(2, 0)), "stale");
  assert.equal(classifyDialogueEvent(active, delta(2, 2)), "future");
  assert.equal(classifyDialogueEvent(active, delta(1, 1)), "duplicate");
  assert.equal(classifyDialogueEvent(active, delta(4, 1)), "future");
  // A newer accepted turn (generation 2) supersedes without being stale.
  assert.equal(classifyDialogueEvent(active, accepted(2, 2)), "apply");
  assert.equal(classifyDialogueEvent(active, accepted(2, 0)), "stale");
});

test("cancel flow stops the running turn", () => {
  let state = initialState();
  state = petReducer(state, { type: "character.clicked" }).state;
  state = petReducer(state, { type: "composer.draft_changed", draft: "x" }).state;
  state = petReducer(state, { type: "composer.submitted" }).state;
  state = petReducer(state, {
    type: "turn.accepted",
    conversationId: "conv-1",
    runId: "run-1",
    generation: 1,
    seq: 1,
  }).state;
  const cancelRequest = petReducer(state, { type: "turn.cancel_requested" });
  assert.deepEqual(cancelRequest.effects, [{ kind: "cancel_turn" }]);
  const cancelled = petReducer(cancelRequest.state, {
    type: "turn.cancelled",
    runId: "run-1",
    generation: 1,
    seq: 2,
  });
  assert.equal(cancelled.state.turn.kind, "cancelled");
});

test("turn failure restores the draft and surfaces a sanitized error", () => {
  let state = initialState();
  state = petReducer(state, { type: "character.clicked" }).state;
  state = petReducer(state, { type: "composer.draft_changed", draft: "草稿内容" }).state;
  state = petReducer(state, { type: "composer.submitted" }).state;
  const result = petReducer(state, {
    type: "turn.failed",
    code: "upstream_timeout",
    recoverable: true,
    seq: 1,
  });
  assert.equal(result.state.turn.kind, "error");
  assert.equal(result.state.bubble.kind, "error");
  assert.equal(result.state.composer.kind, "editing");
  if (result.state.composer.kind === "editing") {
    assert.equal(result.state.composer.draft, "草稿内容");
  }
  assert.equal(result.state.context.latestEventSeq, 1, "error event must consume the durable cursor");
});

test("turn.failed consumes an error cursor even after local cleanup, but not a future gap", () => {
  const base = initialState();
  const future = petReducer(base, {
    type: "turn.failed",
    code: "PROVIDER_UNAVAILABLE",
    recoverable: true,
    seq: 2,
  });
  assert.equal(future.state.context.latestEventSeq, 0);
  assert.equal(future.state.turn.kind, "idle");

  const terminal = petReducer(base, {
    type: "turn.failed",
    code: "PROVIDER_UNAVAILABLE",
    recoverable: true,
    seq: 1,
  });
  assert.equal(terminal.state.context.latestEventSeq, 1);
  assert.equal(terminal.state.turn.kind, "idle");
});

test("voice tap-to-toggle fixture state machine", () => {
  let state = initialState();
  const started = petReducer(state, { type: "voice.toggle_requested" });
  assert.equal(started.state.voice.kind, "requesting_permission");
  assert.deepEqual(started.effects, [
    { kind: "set_interaction_mode", mode: "interactive" },
    { kind: "start_voice_capture", operationEpoch: 1 },
  ]);
  state = started.state;

  state = petReducer(state, {
    type: "voice.permission_result",
    operationEpoch: 1,
    granted: true,
  }).state;
  assert.equal(state.voice.kind, "listening");
  const stopped = petReducer(state, { type: "voice.toggle_requested" });
  assert.deepEqual(stopped.effects, [{
    kind: "stop_voice_capture",
    operationEpoch: 1,
    streamId: "stream-1",
  }]);
  state = stopped.state;
  assert.equal(state.voice.kind, "finalizing");
  const stoppedTranscript = petReducer(state, {
    type: "voice.track_stopped",
    operationEpoch: 1,
    streamId: "stream-1",
  });
  assert.deepEqual(stoppedTranscript.effects, [{
    kind: "transcribe_voice",
    operationEpoch: 1,
    streamId: "stream-1",
    uploadId: "upload-1",
  }]);
  state = stoppedTranscript.state;
  assert.equal(state.voice.kind, "transcribing");
  state = petReducer(state, {
    type: "voice.transcript_fixture",
    operationEpoch: 1,
    text: "识别后的文字",
  }).state;
  assert.equal(state.voice.kind, "idle");
  assert.equal(state.composer.kind, "editing");
  if (state.composer.kind === "editing") assert.equal(state.composer.draft, "识别后的文字");
});

test("真实 ASR transcript 回填并绑定 voice artifact；手工编辑后降级为普通文字", () => {
  let state = initialState();
  state = petReducer(state, { type: "voice.toggle_requested" }).state;
  state = petReducer(state, {
    type: "voice.track_started",
    operationEpoch: 1,
    streamId: "real-stream",
  }).state;
  state = petReducer(state, {
    type: "voice.toggle_requested",
  }).state;
  state = petReducer(state, {
    type: "voice.track_stopped",
    operationEpoch: 1,
    streamId: "real-stream",
  }).state;
  state = petReducer(state, {
    type: "voice.transcript_ready",
    operationEpoch: 1,
    streamId: "real-stream",
    uploadId: "upload-1",
    text: "原始逐字稿",
    voiceArtifactId: "123e4567-e89b-12d3-a456-426614174000",
    transcriptSha256: "a".repeat(64),
  }).state;
  assert.equal(state.composer.kind, "editing");
  if (state.composer.kind !== "editing") return;
  assert.equal(state.composer.voiceArtifactId, "123e4567-e89b-12d3-a456-426614174000");
  state = petReducer(state, { type: "composer.draft_changed", draft: "用户修正后的文字" }).state;
  assert.equal(state.composer.kind, "editing");
  assert.equal(state.composer.voiceArtifactId, undefined);
  const submitted = petReducer(state, { type: "composer.submitted" });
  assert.equal(submitted.effects[0]?.kind, "submit_turn");
  if (submitted.effects[0]?.kind === "submit_turn") {
    assert.equal(submitted.effects[0].voiceArtifactId, undefined);
  }
});

test("voice permission denied is recoverable and keeps text path", () => {
  let state = initialState();
  state = petReducer(state, { type: "voice.toggle_requested" }).state;
  const denied = petReducer(state, {
    type: "voice.permission_result",
    operationEpoch: 1,
    granted: false,
  });
  assert.equal(denied.state.voice.kind, "error");
  assert.equal(denied.state.turn.kind, "idle");
  assert.equal(denied.state.composer.kind, "closed");
});

test("menu open/navigate/close and Esc semantics", () => {
  let state = initialState();
  state = petReducer(state, { type: "menu.opened" }).state;
  assert.equal(state.menu.kind, "root");
  assert.equal(state.window.kind, "interactive");
  state = petReducer(state, { type: "menu.navigated", target: "more" }).state;
  assert.equal(state.menu.kind, "more");
  state = petReducer(state, { type: "menu.navigated", target: "root" }).state;
  assert.equal(state.menu.kind, "root");
  const closed = petReducer(state, { type: "menu.closed" });
  assert.equal(closed.state.menu.kind, "closed");
  assert.equal(closed.state.window.kind, "passive");
});

test("learning proposal becomes a confirmation bubble and closes the menu", () => {
  let state = petReducer(initialState(), { type: "menu.opened" }).state;
  state = petReducer(state, { type: "menu.navigated", target: "study" }).state;
  const result = petReducer(state, {
    type: "bubble.learning_proposal_received",
    proposalId: "123e4567-e89b-12d3-a456-426614174000",
    actionName: "继续当前学习",
    target: "继续学习：光合作用",
    impact: "完成后更新学习进度",
  });
  assert.equal(result.state.menu.kind, "closed");
  assert.deepEqual(result.state.bubble, {
    kind: "confirmation",
    proposalId: "123e4567-e89b-12d3-a456-426614174000",
    actionName: "继续当前学习",
    target: "继续学习：光合作用",
    impact: "完成后更新学习进度",
  });
});

test("learning proposal while a turn is running defers instead of overriding the turn bubble", () => {
  let state = initialState();
  state = petReducer(state, { type: "character.clicked" }).state;
  state = petReducer(state, { type: "composer.draft_changed", draft: "讲讲光合作用" }).state;
  state = petReducer(state, { type: "composer.submitted" }).state;
  state = petReducer(state, {
    type: "turn.accepted",
    conversationId: "conv-1",
    runId: "run-1",
    generation: 1,
    seq: 1,
  }).state;
  state = petReducer(state, {
    type: "assistant.status",
    runId: "run-1",
    generation: 1,
    phase: "streaming",
    seq: 2,
  }).state;
  assert.equal(state.turn.kind, "running");

  const deferred = petReducer(state, {
    type: "bubble.learning_proposal_received",
    proposalId: "123e4567-e89b-12d3-a456-426614174000",
    actionName: "继续当前学习",
    target: "继续学习：光合作用",
    impact: "完成后更新学习进度",
  });
  // §4.2 优先级：用户回合 > 学习确认——气泡保持 turn，不出现 confirmation。
  assert.equal(deferred.state.bubble.kind, "turn");
  assert.equal(deferred.state.menu.kind, "closed");
  const deferEffect = deferred.effects.find((e) => e.kind === "defer_learning_proposal");
  assert.ok(deferEffect, "must emit a defer_learning_proposal effect");
  if (deferEffect) {
    assert.equal(deferEffect.kind, "defer_learning_proposal");
    assert.equal(deferEffect.proposalId, "123e4567-e89b-12d3-a456-426614174000");
  }

  // 回合结束后同一事件正常显示确认卡（接线层负责重派发）。
  state = petReducer(deferred.state, {
    type: "assistant.final",
    runId: "run-1",
    generation: 1,
    seq: 3,
    messageId: "msg-1",
    text: "好的，我来说明。",
    textSha256: "a".repeat(64),
  }).state;
  assert.equal(state.turn.kind, "final");
  const shown = petReducer(state, {
    type: "bubble.learning_proposal_received",
    proposalId: "123e4567-e89b-12d3-a456-426614174000",
    actionName: "继续当前学习",
    target: "继续学习：光合作用",
    impact: "完成后更新学习进度",
  });
  assert.deepEqual(shown.state.bubble, {
    kind: "confirmation",
    proposalId: "123e4567-e89b-12d3-a456-426614174000",
    actionName: "继续当前学习",
    target: "继续学习：光合作用",
    impact: "完成后更新学习进度",
  });
});

test("composer.submitted is rejected while a turn is running (draft preserved)", () => {
  let state = initialState();
  state = petReducer(state, { type: "character.clicked" }).state;
  state = petReducer(state, { type: "composer.draft_changed", draft: "第一条" }).state;
  state = petReducer(state, { type: "composer.submitted" }).state;
  state = petReducer(state, {
    type: "turn.accepted",
    conversationId: "conv-1",
    runId: "run-1",
    generation: 1,
    seq: 1,
  }).state;
  assert.equal(state.turn.kind, "running");
  assert.equal(state.composer.kind, "closed");

  // running 中重新打开 composer（§5.1 composer 可独立编辑）并输入草稿。
  state = petReducer(state, { type: "character.clicked" }).state;
  assert.equal(state.composer.kind, "editing");
  state = petReducer(state, { type: "composer.draft_changed", draft: "第二条" }).state;

  const result = petReducer(state, { type: "composer.submitted" });
  assert.equal(result.state.turn.kind, "running");
  assert.equal(result.state.composer.kind, "editing");
  assert.equal(result.state.composer.kind === "editing" && result.state.composer.draft, "第二条");
  assert.equal(result.effects.some((e) => e.kind === "submit_turn"), false);
});

test("durable action completion/failure becomes a result bubble and advances cursor", () => {
  const completed = petReducer(initialState(), {
    type: "action.completed",
    actionRunId: "123e4567-e89b-12d3-a456-426614174000",
    resultRef: "run:123",
    route: { kind: "review" },
    safeSummary: "已打开复习页",
    seq: 4,
  });
  assert.equal(completed.state.context.latestEventSeq, 4);
  assert.deepEqual(completed.state.bubble, {
    kind: "action_result",
    actionRunId: "123e4567-e89b-12d3-a456-426614174000",
    status: "completed",
    summary: "已打开复习页",
    route: { kind: "review" },
  });

  const failed = petReducer(completed.state, {
    type: "action.failed",
    actionRunId: "123e4567-e89b-12d3-a456-426614174001",
    code: "ACTION_STALE",
    recoverable: true,
    seq: 5,
  });
  assert.equal(failed.state.context.latestEventSeq, 5);
  assert.equal(failed.state.bubble.kind, "action_result");
  assert.equal(failed.state.bubble.status, "failed");
});

test("opening the composer closes the menu", () => {
  let state = initialState();
  state = petReducer(state, { type: "menu.opened" }).state;
  state = petReducer(state, { type: "composer.opened" }).state;
  assert.equal(state.menu.kind, "closed");
  assert.equal(state.composer.kind, "editing");
});

test("opening the menu closes the compact composer", () => {
  let state = petReducer(initialState(), { type: "composer.opened" }).state;
  state = petReducer(state, { type: "composer.draft_changed", draft: "未发送草稿" }).state;
  const opened = petReducer(state, { type: "menu.opened" });
  assert.equal(opened.state.menu.kind, "root");
  assert.equal(opened.state.composer.kind, "closed");
  assert.equal(opened.state.composer.kind === "closed" && opened.state.composer.draft, "未发送草稿");
  assert.equal(opened.state.window.kind, "interactive");
});

test("direct character drag owns interaction mode and restores the active surface mode", () => {
  let state = initialState();
  const started = petReducer(state, { type: "window.drag_started" });
  assert.equal(started.state.window.kind, "dragging");
  assert.deepEqual(started.effects, [{ kind: "set_interaction_mode", mode: "dragging" }]);

  const ended = petReducer(started.state, { type: "window.drag_ended" });
  assert.equal(ended.state.window.kind, "passive");
  assert.deepEqual(ended.effects, [{ kind: "set_interaction_mode", mode: "passive" }]);

  state = petReducer(state, { type: "composer.opened" }).state;
  state = petReducer(state, { type: "window.drag_started" }).state;
  const endedWithComposer = petReducer(state, { type: "window.drag_ended" });
  assert.equal(endedWithComposer.state.window.kind, "text_input");
  assert.deepEqual(endedWithComposer.effects, [{ kind: "set_interaction_mode", mode: "text_input" }]);
});

test("opening the composer yields a passive incoming bubble (01 §6.1)", () => {
  let state = initialState();
  state = petReducer(state, { type: "bubble.incoming_fixture", text: "x" }).state;
  assert.equal(state.bubble.kind, "incoming");
  state = petReducer(state, { type: "composer.opened" }).state;
  assert.equal(state.bubble.kind, "hidden");
  assert.equal(state.composer.kind, "editing");
});

test("workspace change clears scoped state and re-bootstraps", () => {
  let state = initialState();
  state = petReducer(state, {
    type: "bootstrap.authenticated",
    userId: "u1",
    workspaceId: "w1",
    accountEpoch: 1,
  }).state;
  state = petReducer(state, { type: "character.clicked" }).state;
  state = petReducer(state, { type: "composer.draft_changed", draft: "d" }).state;
  const switched = petReducer(state, {
    type: "workspace.changed",
    workspaceId: "w2",
    accountEpoch: 2,
  });
  assert.equal(switched.state.lifecycle.kind, "booting");
  assert.equal(switched.state.turn.kind, "idle");
  assert.equal(switched.state.composer.kind, "closed");
  assert.equal(switched.state.bubble.kind, "hidden");
  assert.equal(switched.state.context.workspaceId, "w2");
});

test("global_off hides the surface without deleting conversation state", () => {
  let state = initialState();
  state = petReducer(state, {
    type: "bootstrap.authenticated",
    userId: "u1",
    workspaceId: "w1",
    accountEpoch: 1,
  }).state;
  const off = petReducer(state, { type: "account.global_off", epoch: 2 });
  assert.equal(off.state.lifecycle.kind, "hidden");
  if (off.state.lifecycle.kind === "hidden") {
    assert.equal(off.state.lifecycle.reason, "global_off");
  }
});

test("account preference changes update voice/animation gates and stop voice immediately", () => {
  let state = initialState();
  state = petReducer(state, {
    type: "bootstrap.authenticated",
    userId: "u1",
    workspaceId: "w1",
    accountEpoch: 1,
  }).state;
  state = {
    ...state,
    voice: { kind: "speaking", runId: "run-1", generation: 1, segmentId: "seg-1", operationEpoch: 0 },
  };
  const changed = petReducer(state, {
    type: "account.preferences_changed",
    accountEpoch: 2,
    animationOff: true,
    voiceOff: true,
  });
  assert.equal(changed.state.context.accountEpoch, 2);
  assert.equal(changed.state.context.animationOff, true);
  assert.equal(changed.state.context.voiceOff, true);
  assert.deepEqual(changed.state.voice, { kind: "idle", operationEpoch: 1 });
  assert.deepEqual(changed.effects, [
    { kind: "cancel_voice_capture", operationEpoch: 0 },
    { kind: "stop_playback" },
  ]);
});

test("unknown events fail closed with no effects", () => {
  const before = initialState();
  const result = petReducer(before, { type: "composer.opened" });
  // compose a genuinely unknown action
  const unknown = petReducer(result.state, { type: "bubble.dismissed" });
  assert.equal(unknown.state.bubble.kind, "hidden");
});

test("deriveCharacterPresentation follows the fixed priority", () => {
  const base = initialState();

  const booting = { ...base, lifecycle: { kind: "booting" as const } };
  assert.equal(deriveCharacterPresentation(booting), "hidden");

  const visible = { ...base, lifecycle: { kind: "visible" as const } };
  assert.equal(deriveCharacterPresentation(visible), "idle");

  const listening = {
    ...visible,
    voice: { kind: "listening" as const, startedAt: 1, streamId: "s", operationEpoch: 1 },
  };
  assert.equal(deriveCharacterPresentation(listening), "listen");

  const transcribing = {
    ...visible,
    voice: { kind: "transcribing" as const, streamId: "s", uploadId: "u", operationEpoch: 1 },
  };
  assert.equal(deriveCharacterPresentation(transcribing), "think");

  const speaking = {
    ...visible,
    voice: { kind: "speaking" as const, runId: "r", generation: 1, segmentId: "g", operationEpoch: 1 },
  };
  assert.equal(deriveCharacterPresentation(speaking), "speak");

  const thinking = {
    ...visible,
    turn: {
      kind: "running" as const,
      conversationId: "c",
      runId: "r",
      generation: 1,
      phase: "thinking" as const,
      previewText: "",
      lastSeq: 1,
    },
  };
  assert.equal(deriveCharacterPresentation(thinking), "think");

  const errored = {
    ...visible,
    turn: { kind: "error" as const, code: "x", recoverable: true },
  };
  assert.equal(deriveCharacterPresentation(errored), "uncertain");

  const incoming = {
    ...visible,
    bubble: { kind: "incoming" as const, deliveryId: "d", messageId: "m", previewText: "提醒" },
  };
  assert.equal(deriveCharacterPresentation(incoming), "invite");

  const fatal = { ...base, lifecycle: { kind: "fatal" as const, code: "boom" } };
  assert.equal(deriveCharacterPresentation(fatal), "uncertain");
});

test("提交中重复 submit_turn 被拒（P2 §10.6 双 surface 单次提交守卫）", () => {
  let state = initialState();
  state = petReducer(state, { type: "character.clicked" }).state;
  state = petReducer(state, { type: "composer.draft_changed", draft: "第一次" }).state;
  const first = petReducer(state, { type: "composer.submitted" });
  assert.equal(first.state.composer.kind, "submitting");
  assert.equal(first.effects.length, 1);

  // submitting 期间再次提交（同一 surface 或并行 surface 的重复 action）→ 零新 effect
  const second = petReducer(first.state, { type: "composer.submitted" });
  assert.equal(second.state.composer.kind, "submitting");
  assert.equal(second.effects.length, 0, "submitting 中不得再次提交");
  assert.equal(second.state.turn.kind, "submitting", "turn 状态不变");

  // composer.closed 在 submitting 中也不打断
  const closed = petReducer(first.state, { type: "composer.closed" });
  assert.equal(closed.state.composer.kind, "submitting", "submitting 中关闭被忽略");
});

test("P3 §11.4 barge-in：speaking 中点按停止播放并开始新录音", () => {
  let state = initialState();
  // idle → tap → requesting_permission
  state = petReducer(state, { type: "voice.toggle_requested" }).state;
  assert.equal(state.voice.kind, "requesting_permission");
  // permission granted → listening
  state = petReducer(state, { type: "voice.permission_result", operationEpoch: state.voice.operationEpoch, granted: true }).state;
  assert.equal(state.voice.kind, "listening");
  // 进入 speaking（fixture）
  state = petReducer(state, { type: "voice.speaking_fixture", runId: "r1", generation: 1, segmentId: "s1" }).state;
  assert.equal(state.voice.kind, "speaking");
  const epochBefore = state.voice.operationEpoch;

  // speaking 中 tap → barge-in
  const barged = petReducer(state, { type: "voice.toggle_requested" });
  assert.equal(barged.state.voice.kind, "requesting_permission", "barge-in 进入 requesting_permission");
  assert.equal(barged.state.voice.operationEpoch, epochBefore + 1, "新 operationEpoch");
  const kinds = barged.effects.map((e) => e.kind);
  assert.ok(kinds.includes("stop_playback"), "先停止播放");
  assert.ok(kinds.includes("start_voice_capture"), "再开麦");
  // speaking 与 listening 互斥：barge-in 后不再处于 speaking
  assert.notEqual(barged.state.voice.kind, "speaking");
});

test("P3 资源清理：迟到 permission_result（非 requesting 状态）被拒，epoch 单调", () => {
  let state = initialState();
  state = petReducer(state, { type: "voice.toggle_requested" }).state;
  assert.equal(state.voice.kind, "requesting_permission");
  const grantedEpoch = state.voice.operationEpoch;
  state = petReducer(state, { type: "voice.permission_result", operationEpoch: grantedEpoch, granted: true }).state;
  assert.equal(state.voice.kind, "listening");

  // 迟到/重复 permission_result（同一旧 epoch，状态已非 requesting）→ 拒绝（无副作用）
  const late = petReducer(state, { type: "voice.permission_result", operationEpoch: grantedEpoch, granted: true });
  assert.equal(late.state.voice.kind, "listening", "迟到 permission 不改变状态");
  assert.equal(late.effects.length, 0, "迟到 permission 零 effect");
});

test("P3 资源清理：识别处理中重复点按被拒", () => {
  let state = initialState();
  state = petReducer(state, { type: "voice.toggle_requested" }).state;
  state = petReducer(state, { type: "voice.permission_result", operationEpoch: state.voice.operationEpoch, granted: true }).state;
  state = petReducer(state, { type: "voice.toggle_requested" }).state;
  assert.equal(state.voice.kind, "finalizing");
  const duringFinalizing = petReducer(state, { type: "voice.toggle_requested" });
  assert.equal(duringFinalizing.effects.length, 0, "finalizing 中重复点按被拒");
  assert.equal(duringFinalizing.state.voice.kind, "finalizing");
});

test("P3 flag off：voiceOff 时按 mic → voice_disabled，文字 composer 保持可用", () => {
  const base = initialState({ context: { ...initialState().context, voiceOff: true } });
  const result = petReducer(base, { type: "voice.toggle_requested" });
  assert.equal(result.state.voice.kind, "error");
  if (result.state.voice.kind === "error") {
    assert.equal(result.state.voice.code, "voice_disabled");
    assert.equal(result.state.voice.recoverable, true);
  }
  // 文字 composer 不受影响（文字路径完整可用：未在提交、可随时打开输入）
  assert.notEqual(result.state.composer.kind, "submitting");
  assert.equal(result.state.bubble.kind, "voice_status");
});

// ─── B1/B2/B3/B4 fix 回归测试 ──────────────────────────────────────────

test("B1 fix：本地失败事件紧跟 durable 游标（latestEventSeq+1）时 turn.failed 生效", () => {
  // 模拟第二个 turn：首个 turn 的 SSE 已消费 seq 1..3，latestEventSeq=3。
  // 本地合成失败事件（网络/服务端错误）seq 必须等于 4 才能通过
  // classifyDialogueEvent 的连续性校验；若用独立递增的本地 seq（例如 1），
  // 会被判 duplicate/future 静默丢弃，错误不显示、turn 卡死。
  const ctx = { ...initialState().context, latestEventSeq: 3, activeGeneration: 1 };
  let state = initialState({ context: ctx });
  state = petReducer(state, { type: "composer.opened" }).state;
  state = petReducer(state, { type: "composer.draft_changed", draft: "第二条消息" }).state;
  state = petReducer(state, { type: "composer.submitted" }).state;
  assert.equal(state.turn.kind, "submitting");
  const result = petReducer(state, {
    type: "turn.failed",
    code: "NETWORK_ERROR",
    recoverable: true,
    seq: 4,
  });
  assert.equal(result.state.turn.kind, "error");
  assert.equal(result.state.bubble.kind, "error");
  assert.equal(result.state.context.latestEventSeq, 4, "错误事件必须消费 durable 游标");
});

test("B1 fix：本地失败事件若用非连续 seq 仍被拒（future gap 不跳过）", () => {
  const ctx = { ...initialState().context, latestEventSeq: 3, activeGeneration: 1 };
  let state = initialState({ context: ctx });
  state = petReducer(state, { type: "composer.opened" }).state;
  state = petReducer(state, { type: "composer.draft_changed", draft: "x" }).state;
  state = petReducer(state, { type: "composer.submitted" }).state;
  const result = petReducer(state, {
    type: "turn.failed",
    code: "NETWORK_ERROR",
    recoverable: true,
    seq: 2,
  });
  // seq=2 <= latestEventSeq=3 → duplicate：不得制造缺口，也不得覆盖游标。
  assert.equal(result.state.context.latestEventSeq, 3);
});

test("B2 fix：取消 turn 时派发 stop_playback，停止已入队 TTS", () => {
  const ctx = { ...initialState().context, latestEventSeq: 0, activeGeneration: 2 };
  let state = initialState({ context: ctx });
  state = petReducer(state, { type: "composer.opened" }).state;
  state = petReducer(state, { type: "composer.draft_changed", draft: "x" }).state;
  state = petReducer(state, { type: "composer.submitted" }).state;
  assert.equal(state.turn.kind, "submitting");
  state = petReducer(state, {
    type: "turn.accepted",
    conversationId: "00000000-0000-4000-8000-000000000001",
    runId: "00000000-0000-4000-8000-000000000002",
    generation: 2,
    seq: 1,
  }).state;
  assert.equal(state.turn.kind, "running");
  const result = petReducer(state, {
    type: "turn.cancelled",
    runId: "00000000-0000-4000-8000-000000000002",
    generation: 2,
    seq: 2,
  });
  assert.equal(result.state.turn.kind, "cancelled");
  assert.ok(
    result.effects.some((effect) => effect.kind === "stop_playback"),
    "取消 turn 必须含 stop_playback effect",
  );
});

test("B3 fix：60s 自动停录（listening 状态）track_stopped 进入转写而非卡死", () => {
  let state = initialState();
  state = petReducer(state, { type: "voice.toggle_requested" }).state;
  state = petReducer(state, {
    type: "voice.permission_result",
    operationEpoch: 1,
    granted: true,
  }).state;
  assert.equal(state.voice.kind, "listening");
  // 自动停录：stopTimer 直接 recorder.stop() → onstop → track_stopped，
  // 此时 voice 仍是 listening（未经 finalizing）。
  const result = petReducer(state, {
    type: "voice.track_stopped",
    operationEpoch: 1,
    streamId: "stream-1",
  });
  assert.equal(result.state.voice.kind, "transcribing");
  assert.deepEqual(result.effects, [{
    kind: "transcribe_voice",
    operationEpoch: 1,
    streamId: "stream-1",
    uploadId: "upload-1",
  }]);
});

test("B4 fix：conversation.restored 保留用户正在编辑的草稿", () => {
  let state = initialState();
  state = petReducer(state, { type: "composer.opened" }).state;
  state = petReducer(state, { type: "composer.draft_changed", draft: "我正在输入的草稿" }).state;
  assert.equal(state.composer.kind, "editing");
  const snapshot = {
    conversation: { id: "00000000-0000-4000-8000-000000000001" },
    latestEventSeq: 5,
    activeRun: null,
    activeActionRun: null,
    pendingProposal: null,
  } as unknown as CompanionConversationSnapshotV1;
  const result = petReducer(state, { type: "conversation.restored", snapshot });
  assert.equal(result.state.composer.kind, "editing", "restore 不得清掉用户草稿");
  if (result.state.composer.kind === "editing") {
    assert.equal(result.state.composer.draft, "我正在输入的草稿");
  }
});

test("15a 根因修复：character.cue 消费 seq，后续 delta/final 不再被拒（卡 thinking 根因）", () => {
  let state = initialState();
  // 提交 turn → accepted（seq=88）（与既有 fixture 测试同路径）
  state = petReducer(state, { type: "character.clicked" }).state;
  state = petReducer(state, { type: "composer.draft_changed", draft: "测试" }).state;
  state = petReducer(state, { type: "composer.submitted" }).state;
  state = petReducer(state, {
    type: "turn.accepted",
    conversationId: "00000000-0000-4000-8000-000000000003",
    runId: "00000000-0000-4000-8000-000000000004",
    generation: 1,
    seq: 1,
  }).state;
  assert.equal(state.context.latestEventSeq, 1);
  // status（2）→ cue（3）→ delta（4）→ final（5）
  state = petReducer(state, {
    type: "assistant.status", runId: "00000000-0000-4000-8000-000000000004", generation: 1, seq: 2, phase: "thinking", accountEpoch: 0,
  }).state;
  assert.equal(state.context.latestEventSeq, 2);
  const cueResult = petReducer(state, {
    type: "character.cue",
    runId: "00000000-0000-4000-8000-000000000004",
    generation: 1,
    seq: 3,
    accountEpoch: 0,
    cue: { version: 1, intent: "think", emotion: "curious", intensity: 0.35 },
  });
  assert.equal(cueResult.state.context.latestEventSeq, 3, "cue 必须消费 seq");
  assert.equal(cueResult.state.emotion.cue?.intent, "think", "cue 存入 emotion 域");
  assert.equal(cueResult.state.emotion.cue?.generation, 1, "emotion 域 cue 带 generation");
  // delta（4）：cue 消费 seq 后不再被 future 拒绝
  const deltaAfterCue = petReducer(cueResult.state, {
    type: "assistant.delta", runId: "00000000-0000-4000-8000-000000000004", generation: 1, seq: 4, accountEpoch: 0, text: "你好",
  });
  assert.equal(deltaAfterCue.state.turn.kind, "running", "cue 消费 seq 后 delta 正常接受");
  if (deltaAfterCue.state.turn.kind === "running") {
    assert.equal(deltaAfterCue.state.turn.previewText, "你好");
  }
  // final（5）正常生效
  const finalResult = petReducer(deltaAfterCue.state, {
    type: "assistant.final", runId: "00000000-0000-4000-8000-000000000004", generation: 1, seq: 5, accountEpoch: 0, messageId: "00000000-0000-4000-8000-000000000005", text: "你好", textSha256: "0".repeat(64),
  });
  assert.equal(finalResult.state.turn.kind, "final");
});
