import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  GripVertical,
  Link2,
  Lightbulb,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type {
  ArtifactPayload,
  LearningDraftPayload,
  LearningRendererDraftState,
  LearningTaskPublic,
  RelationEdgeKindV1,
  RepairOperationV1,
  StructuredPartAnswerV1,
  StructuredPartPublicV1,
} from "@ailearn/shared/learning-run-contracts";
import type {
  GetLearningRunResultResponseV2,
  LearningRunAllowedActionV2,
  LearningRunPublicSnapshotV2,
  LearningRunReturnContractV2,
  LearningRunTargetRevealV2,
} from "@ailearn/shared/learning-run-v2-contracts";
import type { DesktopLearningRunActionRequestV2, DesktopRouteV1 } from "@ailearn/shared/desktop-ipc-contracts";
import {
  createCommandId,
  createRequestMeta,
  gatewayErrorMessage,
  RendererGatewayError,
  unwrapGatewayResult,
} from "../../app/desktop-client";
import { useRoomStore } from "../../app/room-store";
import { useCompanionHomeProjection } from "../../app/companion-home-projection";
import { speakCompanionLine, type CompanionSpeechHandle } from "../../app/companion-voice-playback";
import { HudPage } from "../hud/HudPage";
import { useHudPage } from "../hud/use-hud-page";
import { reviewTargetFromReturnContract } from "../review-focus";
import { resultPollDelayMs } from "../result-polling";
import { indexedPublicLabel } from "../learning-run-labels";
import {
  activateLearningRunRequestFence,
  captureLearningRunRequest,
  createLearningRunRequestFence,
  deactivateLearningRunRequestFence,
  editorRevisionMatchesRequest,
  isLearningRunRequestCurrent,
  isLearningRunResultQueryCurrent,
  isLearningRunSnapshotResponseCurrent,
  learningRunResultMatchesRun,
  shouldClearPendingResultForSnapshot,
  shouldConfirmCompanionForOutcome,
  shouldPollLearningRunResult,
  snapshotRequiresResolvedLearningResult,
} from "../learning-run-result-policy";
import {
  ACTIVITY_LEASE_INTERVAL_MS,
  buildActivityLeaseWindow,
  isActivityLeaseEligible,
  type ActivityLeaseWindow,
} from "../learning-run-activity-lease";
import { SurfaceDataState } from "./surface-data";
import { formatObjectiveDay } from "./objective-state-copy";
import { ObjectiveProgressBand } from "./ObjectiveProgressBand";
import { progressSegmentForOutcome } from "./objective-progress-band";
import { VoiceTeachbackEditor } from "./run-voice-input";
import { LearningRunCeremony } from "./LearningRunCeremony";
import { microphoneAvailabilityCopy, probeMicrophone, type MicrophoneAvailability } from "../voice-capability";
import { companionResultFeedbackAllowed, learningDiscoveryCard, learningRunFeedback } from "./objective-quest-presentation";

type ResultState =
  | { kind: "idle" }
  | { kind: "pending"; phase: Extract<GetLearningRunResultResponseV2, { status: "pending" }>["phase"] }
  | { kind: "result"; value: Extract<GetLearningRunResultResponseV2, { status: "learning_result" }> }
  | { kind: "terminal"; value: Extract<GetLearningRunResultResponseV2, { status: "terminal_without_result" }> };

type TargetRevealState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; reveal: LearningRunTargetRevealV2 }
  | { kind: "unavailable"; message: string };

type PlayerFailure = {
  readonly message: string;
  readonly retryable: boolean;
};

type PlayerRecovery = "draft" | "submit" | "action";

type LearningRunResultV2 = Extract<GetLearningRunResultResponseV2, { status: "learning_result" }>["result"];
type LearningRunOutcome = LearningRunResultV2["outcome"];
type ScheduleImpact = LearningRunResultV2["scheduleImpact"];

function needsLearningRunResync(error: unknown): boolean {
  return error instanceof RendererGatewayError
    && (error.retry === "resync_first" || error.code === "conflict" || error.code === "result_unknown");
}

/** 一次作答的绝对上限：到点自动结束，不再挂着不计分也不结算（复盘 #13）。 */
const FOCUS_SESSION_LIMIT_SECONDS = 60 * 60;

/**
 * 阶段的用户可见文案。导出给"未完成的学习"那一页共用：同一条 run 在两个面上
 * 必须用同一个词（审计 F24）。
 */
export const phaseLabels: Record<LearningRunPublicSnapshotV2["phase"], string> = {
  
  preparing: "正在准备任务",
  active: "进行中",
  assessing: "回答已锁定，正在评估",
  checkpoint: "等待下一步",
  committing: "正在记录可信结果",
  paused: "已暂停",
  completed: "已完成",
  ended: "已结束",
  skipped: "已跳过",
  cancelled: "已取消",
  stale: "内容已变化",
  recoverable_error: "可以恢复",
};

/**
 * 投影里的 `phase` 是 `string`（不是枚举），所以这里给一个查表 + 兜底：
 * 认不出的阶段原样显示，别让清单吞掉一个它没见过的值。
 */
export function learningPhaseLabel(phase: string): string {
  return (phaseLabels as Record<string, string>)[phase] ?? phase;
}

const terminalCopy: Record<Extract<ResultState, { kind: "terminal" }>["value"]["reasonCode"], string> = {
  user_ended: "这次旅程已安全结束，没有生成新的学习结果。",
  runtime_cancelled: "这次旅程被取消，没有生成新的学习结果。",
  target_fingerprint_changed: "学习目标已经更新，本次旅程不能继续写入旧结果。",
  schedule_generation_changed: "复习安排已经变化，本次旅程不能继续消费旧安排。",
  permission_revoked: "当前账号已失去这条学习内容的权限。",
};

// 静态穷举表既防止新增 outcome 时漏掉结果印章，也为异常展示模型保留安全文案。
// 正常路径优先采用 learningRunFeedback 给出的、能随真实证据变化的 seal。
const outcomeSeal: Record<LearningRunOutcome, string> = {
  demonstrated: "掌握完成",
  partial: "推进一段",
  needs_repair: "发现缺口",
  not_assessable: "暂未判定",
  practice_completed: "练习已留痕",
  skipped: "已放回路线",
  declared_unable: "先去补给",
};

const facetLabels: Record<string, string> = {
  recall: "回忆",
  paraphrase: "复述",
  explain: "解释",
  example: "举例",
  apply: "应用",
  boundary: "边界",
  procedure: "步骤",
  relate: "关联",
  repair: "修补",
};

const verdictLabels: Record<string, string> = {
  covered: "说清了",
  partial: "只说清了一部分",
  missing: "没说到",
  contradicted: "说反了",
  not_assessable: "无法判定",
};

/**
 * 跳过与「暂时不会」不配印章（DESIGN.md:152「跳过或声明暂时不会时不显示印章，
 * 不做庆祝」）。此前这两个 outcome 照样吃一颗 42px 大印章，和「已理解」同字号
 * 同位置同颜色——用户分不清自己到底做成了什么。
 */
const SEALLESS_OUTCOMES: ReadonlySet<LearningRunOutcome> = new Set(["skipped", "declared_unable"]);

/**
 * 这次真说清了些什么——只从逐条判定里数，不看 demonstratedFacets。后者是理解
 * 账本（练习永远为空），拿它当「这次做得怎么样」就是把答对了显示成零
 * （31 号文档 P1 的 UI 那一半）。
 *
 * 两个数分开是有意的：**条数**数判定行（四步全说清就是 4 条，那是这次的成品），
 * **facet 名**去重（四行都是「回忆」时不许写成「回忆、回忆、回忆、回忆」）。
 */
function thisTimeVerdicts(result: LearningRunResultV2 | undefined): {
  readonly coveredCount: number;
  readonly coveredFacets: string[];
} {
  const covered = (result?.assessment?.rubricResults ?? []).filter((item) => item.verdict === "covered");
  return {
    coveredCount: covered.length,
    coveredFacets: [...new Set(covered.map((item) => item.facet))],
  };
}

/**
 * 「算进理解」那一行要说清**为什么是空**，而不是留给用户一句「还没有形成可公开的
 * 已证明部分」——那行字和上面四条「回忆 · 说清了」并排时，读起来就是产品在自己
 * 打自己脸（31 号文档 P1/P6）。练习本就不写理解账本，这是合同，直接讲出来。
 */
function provenLedgerText(result: LearningRunResultV2): string {
  if (result.demonstratedFacets.length) return facetText(result.demonstratedFacets, "");
  if (result.outcome === "practice_completed") return "这次是练习，所以不写进理解账本。";
  return "这次没有能写进理解账本的新证据。";
}

function stableLineIndex(seed: string, length: number): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = ((hash << 5) - hash + seed.charCodeAt(index)) | 0;
  return Math.abs(hash) % length;
}

/**
 * 伴星只念评分已经证明的内容。开头有一点稳定随机感，同一结果反复打开不会换台词，
 * 也不会把模板随机成新的学习结论。
 */
function companionResultLine(result: LearningRunResultV2, targetSummary: string, seed: string): string {
  const feedback = learningRunFeedback(result);
  const subject = targetSummary.length > 30 ? `${targetSummary.slice(0, 30)}…` : targetSummary;
  const strongestEvidence = feedback.strengths[0] ?? feedback.achievement;
  const nextEvidence = feedback.improvements[0] ?? feedback.gap;
  if (result.outcome === "demonstrated") {
    const opener = ["过关啦", "这关拿下啦", "新的理解证据收好啦"][stableLineIndex(`${seed}:success`, 3)];
    return `${opener}！关于${subject}，${strongestEvidence}`;
  }
  if (result.outcome === "practice_completed") {
    const opener = ["练习记录收好啦", "这一轮走完啦", "这次有了复盘材料"][stableLineIndex(`${seed}:practice`, 3)];
    return `${opener}。${strongestEvidence} 接下来留意：${nextEvidence}`;
  }
  const opener = ["已经向前走了一段", "这次的线索很清楚", "进展已经留下来了"][stableLineIndex(`${seed}:progress`, 3)];
  return `${opener}。${strongestEvidence} 下一步先补：${nextEvidence}`;
}

const scheduleReasonLabels: Record<string, string> = {
  not_authorized: "当前证据等级不足以改变复习安排",
  facet_only: "本次只产生了 facet 级证据",
  record_only: "本次只写入记录",
  practice_only: "本次属于练习，不改变复习",
  diagnostic_only: "本次属于诊断，不改变复习",
  sandbox: "本次在沙盒范围，不改变复习",
  not_assessable: "本次回答无法评估",
  skipped: "本次已跳过",
  ended: "旅程提前结束",
  stale: "内容已变化",
};

function interactionRef(taskId: string, part = "main"): string {
  return `desktop-player-${taskId}-${part}`;
}

/**
 * 本地秒表（2026-09-20 实走复盘 #13）。
 *
 * 服务端 `activeSecondsUsed` 靠 15 秒一次的 activity lease 才更新（失焦时完全不记），
 * 界面前只显示它，于是钟每 15 秒跳一格、看起来像卡死。这里改成本地逐秒推进：
 * 服务端读数只在**更大时**校准本地值（绝不倒退），失焦/隐藏时与租约同规则停走，
 * 两者不会互相甩开。到 60 分钟仍未结束就交给 `onTimeout` 自动收尾。
 */
function useLocalActiveClock(active: boolean, serverSeconds: number, onTimeout: () => void) {
  const [seconds, setSeconds] = useState(serverSeconds);
  const [ticking, setTicking] = useState(true);

  useEffect(() => {
    setSeconds((current) => (serverSeconds > current ? serverSeconds : current));
  }, [serverSeconds]);

  useEffect(() => {
    const readVisibility = () => document.visibilityState === "visible" && document.hasFocus();
    setTicking(readVisibility());
    const sync = () => setTicking(readVisibility());
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  useEffect(() => {
    if (!active || !ticking) return;
    const timer = window.setInterval(() => setSeconds((current) => current + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [active, ticking]);

  useEffect(() => {
    if (active && ticking && seconds >= FOCUS_SESSION_LIMIT_SECONDS) onTimeout();
  }, [active, ticking, seconds, onTimeout]);

  return { seconds: Math.max(seconds, serverSeconds), paused: !ticking };
}

/**
 * 等待期间回显的答案正文。
 *
 * 只覆盖有自然语言正文的形态；排序/连线/改错这类结构化答案的载荷是一组 id，
 * 在这里还原不出可读原文——那就宁可不显示，也不拼一个看着像但其实不是的东西。
 */
function answerPreview(payload: ArtifactPayload): string | null {
  switch (payload.kind) {
    case "text": return payload.text.trim() || null;
    case "voice": return payload.confirmedTranscript.trim() || null;
    case "declared_unable": return "这一题我标记为暂时不会。";
    default: return null;
  }
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function facetText(facets: readonly string[], empty: string): string {
  if (facets.length === 0) return empty;
  return facets.map((facet) => facetLabels[facet] ?? facet).join("、");
}

function scheduleImpactText(impact: ScheduleImpact): string {
  // 到期时间是**未来**，不能用 formatRelative：它算的是 (now - value)，未来时间
  // 得到负 minutes，`minutes < 1` 直接命中「刚刚」——于是明天和下个月都显示
  // 「下次到期 刚刚。」（31 号文档 P4）。复用列表行那套「今天/明天/N 天后」。
  if (impact.kind === "created") return `已创建复习安排，下次到期 ${formatObjectiveDay(impact.dueAt)}。`;
  if (impact.kind === "rescheduled") return `已重新安排复习，下次到期 ${formatObjectiveDay(impact.dueAt)}。`;
  return `本次没有改变复习安排：${scheduleReasonLabels[impact.reasonCode] ?? impact.reasonCode}。`;
}

function returnTargetLabel(target: LearningRunPublicSnapshotV2["returnTargetV2"]): string {
  switch (target.kind) {
    case "review": return "回到复习队列";
    case "card": return "回到这张学习卡";
    case "star_map": return "回到理解星图";
    case "today": return "回到今日学习";
    case "onboarding": return "继续首次设置";
  }
}

function routeForReturnTarget(target: LearningRunPublicSnapshotV2["returnTargetV2"]): DesktopRouteV1 {
  return target.kind === "review" ? { kind: "review.queue" } : { kind: "room.home" };
}

function emptyPartAnswer(part: StructuredPartPublicV1): StructuredPartAnswerV1 {
  switch (part.kind) {
    case "ordering":
      return { kind: "ordering", partId: part.partId, orderedTokenIds: [...part.publicTokenIds] };
    case "relation":
      return { kind: "relation", partId: part.partId, edges: [] };
    case "repair":
      return { kind: "repair", partId: part.partId, operations: [] };
  }
}

function emptyEditor(task: LearningTaskPublic): ArtifactPayload {
  const interaction = task.activeVariant.interaction;
  switch (interaction.kind) {
    case "voice_teachback":
      return { kind: "voice", confirmedTranscript: "", correctionMethod: "none" };
    case "text_response":
      return { kind: "text", text: "" };
    case "ordering":
      return {
        kind: "ordering",
        orderedTokenIds: [...interaction.publicTokenIds],
        interactionRefs: [interactionRef(task.taskId)],
      };
    case "single_choice":
      // 不给默认选项：合同里 selectedOptionId 可省略，省略就是"还没选"。
      return { kind: "choice", interactionRefs: [interactionRef(task.taskId)] };
    case "true_false":
      return { kind: "true_false", interactionRefs: [interactionRef(task.taskId)] };
    case "matching":
      return { kind: "matching", assignments: [], interactionRefs: [interactionRef(task.taskId)] };
    case "relation_canvas":
      return { kind: "relation", edges: [], interactionRefs: [interactionRef(task.taskId)] };
    case "repair":
      return { kind: "repair", operations: [], interactionRefs: [interactionRef(task.taskId)] };
    case "structured_bundle":
      return {
        kind: "structured_bundle",
        partAnswers: interaction.parts.map(emptyPartAnswer) as [StructuredPartAnswerV1] | [StructuredPartAnswerV1, StructuredPartAnswerV1],
        interactionRefs: [interactionRef(task.taskId)],
      };
  }
}

function editorFromDraft(payload: LearningDraftPayload): ArtifactPayload {
  if (payload.kind === "voice") {
    return { kind: "voice", confirmedTranscript: payload.unconfirmedTranscript, correctionMethod: "none" };
  }
  return payload;
}

function toDraftPayload(payload: ArtifactPayload): LearningDraftPayload | null {
  if (payload.kind === "declared_unable") return null;
  if (payload.kind === "voice") return { kind: "voice", unconfirmedTranscript: payload.confirmedTranscript };
  return payload;
}

function rendererStateFor(payload: ArtifactPayload): LearningRendererDraftState {
  if (payload.kind === "voice") return { kind: "voice", asrState: payload.confirmedTranscript ? "ready" : "idle" };
  if (payload.kind === "text") {
    return {
      kind: "text",
      selectionStart: payload.text.length,
      selectionEnd: payload.text.length,
    };
  }
  return { kind: "structured", activePartId: null, focusedElementId: null };
}

function payloadIsReady(payload: ArtifactPayload, task: LearningTaskPublic | null): boolean {
  switch (payload.kind) {
    case "voice":
      return payload.confirmedTranscript.trim().length > 0;
    case "text":
      return payload.text.trim().length > 0;
    case "ordering":
      return payload.orderedTokenIds.length > 1;
    case "choice":
      return Boolean(payload.selectedOptionId);
    case "true_false":
      return typeof payload.answer === "boolean";
    case "matching":
      // 所有左端都必须连上，左右两端都不能重复占用。
      return task?.activeVariant.interaction.kind === "matching"
        && payload.assignments.length === task.activeVariant.interaction.publicLeftIds.length
        && new Set(payload.assignments.map((pair) => pair.leftId)).size === payload.assignments.length
        && new Set(payload.assignments.map((pair) => pair.rightId)).size === payload.assignments.length;
    case "relation":
      return payload.edges.length > 0;
    case "repair":
      return payload.operations.length > 0;
    case "structured_bundle":
      return payload.partAnswers.every((part) => {
        switch (part.kind) {
          case "ordering": return part.orderedTokenIds.length > 1;
          case "relation": return part.edges.length > 0;
          case "repair": return part.operations.length > 0;
        }
      });
    case "declared_unable":
      return true;
  }
  return false;
}

function actionRequestFor(action: LearningRunAllowedActionV2): DesktopLearningRunActionRequestV2["action"] {
  switch (action.kind) {
    case "pause":
    case "resume":
    case "skip_run":
    case "finish_current_evidence":
    case "finish_without_commit":
    case "retry_prepare":
    case "retry_commit":
      return { kind: action.kind };
    case "switch_variant":
      return { kind: action.kind, alternativeId: action.alternativeId };
    case "request_hint":
      return { kind: action.kind, level: action.level };
    case "activate_followup":
      return { kind: action.kind, followupId: action.followupId };
    case "retry_assessment":
      return { kind: action.kind, assessmentId: action.assessmentId };
    case "end":
      return { kind: action.kind, abandonLockedEvidence: action.abandonLockedEvidence };
  }
}

/**
 * 备选模态的按钮文案（方案 §3 D5）：此前所有备选都写「换一种方式」，
 * 用户看不出换过去是做题还是说话。kind 由服务端随备选一起下发。
 */
function switchActionLabel(kind: LearningTaskPublic["availableAlternatives"][number]["interactionKind"] | undefined): string {
  switch (kind) {
    case "single_choice": return "改做选择题";
    case "true_false": return "改做判断题";
    case "matching": return "改做配对题";
    case "ordering": return "改做排序题";
    case "relation_canvas": return "改用关系搭建";
    case "repair": return "改用纠错修补";
    case "structured_bundle": return "改用组合证明";
    case "voice_teachback": return "改用语音讲解";
    case "text_response": return "改用自己的话回答";
    default: return "换一种方式";
  }
}

function actionLabel(action: LearningRunAllowedActionV2): string {
  switch (action.kind) {
    case "pause": return "暂停";
    case "resume": return "继续旅程";
    case "switch_variant": return "换一种方式";
    case "request_hint": return action.level === 1 ? "给我一点提示" : `查看第 ${action.level} 级提示`;
    case "skip_run": return "稍后再做";
    case "activate_followup": return "继续补充证据";
    case "finish_current_evidence": return "结算当前证据";
    case "finish_without_commit": return "结束但不改变复习";
    case "retry_prepare": return "重新准备";
    case "retry_assessment": return "重新评估";
    case "retry_commit": return "重试记录结果";
    case "end": return "安全退出";
  }
}

function actionKey(action: LearningRunAllowedActionV2): string {
  const discriminator = "alternativeId" in action
    ? action.alternativeId
    : "level" in action
      ? String(action.level)
      : "taskId" in action
        ? action.taskId
        : "followupId" in action
          ? action.followupId
          : "assessmentId" in action
            ? action.assessmentId
            : "";
  return `${action.kind}-${discriminator}`;
}

function interactionLabel(task: LearningTaskPublic): string {
  switch (task.activeVariant.interaction.kind) {
    case "voice_teachback": return "语音讲解";
    case "text_response": return "用自己的话回答";
    case "ordering": return "顺序整理";
    case "single_choice": return "选择题";
    case "true_false": return "判断题";
    case "matching": return "配对题";
    case "relation_canvas": return "关系搭建";
    case "repair": return "纠错修补";
    case "structured_bundle": return "组合证明";
  }
}

function runOriginLabel(origin: LearningRunPublicSnapshotV2["originV2"]): string {
  switch (origin.kind) {
    case "card": return "学习卡练习";
    case "review": return "到期复习";
    case "star_map": return "理解星图练习";
    case "today": return "今日学习";
    case "onboarding": return "首次练习";
  }
}

function eligibilityLabel(eligibility: LearningRunPublicSnapshotV2["publishedTargetEligibility"]): string {
  switch (eligibility) {
    case "eligible": return "可形成理解证据";
    case "practice_only": return "本次只作练习";
    case "blocked": return "暂不写入证据";
  }
}

function actionIcon(action: LearningRunAllowedActionV2) {
  if (action.kind === "pause") return <Pause size={14} aria-hidden="true" />;
  if (action.kind === "resume") return <Play size={14} aria-hidden="true" />;
  if (action.kind === "request_hint") return <Lightbulb size={14} aria-hidden="true" />;
  if (action.kind === "end") return <ArrowLeft size={14} aria-hidden="true" />;
  if (action.kind === "switch_variant") return <RotateCcw size={14} aria-hidden="true" />;
  return null;
}

function relationKindLabel(kind: RelationEdgeKindV1): string {
  const labels: Record<RelationEdgeKindV1, string> = {
    causes: "导致",
    depends_on: "依赖",
    part_of: "属于",
    contrasts_with: "对比",
    supports: "支持",
    precedes: "先于",
  };
  return labels[kind];
}

function repairOperationTarget(operation: RepairOperationV1): string | null {
  return operation.op === "insert" ? operation.afterElementId : operation.elementId;
}

function repairPreviewItems({
  elementIds,
  labels,
  replacementOptionIds,
  replacementLabels,
  operations,
}: {
  readonly elementIds: string[];
  readonly labels?: Record<string, string>;
  readonly replacementOptionIds: string[];
  readonly replacementLabels?: Record<string, string>;
  readonly operations: RepairOperationV1[];
}): Array<{ key: string; label: string; changed: boolean }> {
  const original = elementIds.map((id) => ({
    key: `source:${id}`,
    sourceId: id,
    label: indexedPublicLabel(labels, elementIds, id, "元素"),
    changed: false,
  }));

  return operations.reduce((items, operation, operationIndex) => {
    if (operation.op === "remove") {
      return items.filter((item) => item.sourceId !== operation.elementId);
    }
    if (operation.op === "replace") {
      return items.map((item) => item.sourceId === operation.elementId
        ? {
            ...item,
            label: indexedPublicLabel(replacementLabels, replacementOptionIds, operation.replacementOptionId, "替换项"),
            changed: true,
          }
        : item);
    }
    if (operation.op === "move") {
      const fromIndex = items.findIndex((item) => item.sourceId === operation.elementId);
      if (fromIndex < 0) return items;
      const next = [...items];
      const [moved] = next.splice(fromIndex, 1);
      const toIndex = Math.max(0, Math.min(operation.toIndex, next.length));
      next.splice(toIndex, 0, { ...moved!, changed: true });
      return next;
    }
    const inserted = {
      key: `insert:${operationIndex}:${operation.replacementOptionId}`,
      sourceId: `insert:${operationIndex}`,
      label: indexedPublicLabel(replacementLabels, replacementOptionIds, operation.replacementOptionId, "插入项"),
      changed: true,
    };
    if (operation.afterElementId === null) return [inserted, ...items];
    const afterIndex = items.findIndex((item) => item.sourceId === operation.afterElementId);
    if (afterIndex < 0) return [...items, inserted];
    return [...items.slice(0, afterIndex + 1), inserted, ...items.slice(afterIndex + 1)];
  }, original);
}

function structuredPartReady(value: StructuredPartAnswerV1, orderingTouched: boolean): boolean {
  if (value.kind === "ordering") return value.orderedTokenIds.length > 1 && orderingTouched;
  if (value.kind === "relation") return value.edges.length > 0;
  return value.operations.length > 0;
}

function PartEditor({
  part,
  value,
  onChange,
  labels,
  replacementLabels,
}: {
  readonly part: StructuredPartPublicV1;
  readonly value: StructuredPartAnswerV1;
  readonly onChange: (value: StructuredPartAnswerV1) => void;
  readonly labels?: Record<string, string>;
  readonly replacementLabels?: Record<string, string>;
}) {
  const [relationDraft, setRelationDraft] = useState({ from: "", to: "", edgeKind: "supports" as RelationEdgeKindV1 });

  if (part.kind === "ordering" && value.kind === "ordering") {
    return <OrderingEditor ids={part.publicTokenIds} labels={labels} value={value.orderedTokenIds} onChange={(orderedTokenIds) => onChange({ ...value, orderedTokenIds })} />;
  }

  if (part.kind === "relation" && value.kind === "relation") {
    const selectedEdgeKind = part.allowedEdgeKinds.includes(relationDraft.edgeKind)
      ? relationDraft.edgeKind
      : part.allowedEdgeKinds[0];
    const relationAlreadyExists = value.edges.some((edge) => edge.fromNodeId === relationDraft.from
      && edge.toNodeId === relationDraft.to
      && edge.edgeKind === selectedEdgeKind);
    const canAddRelation = Boolean(relationDraft.from
      && relationDraft.to
      && selectedEdgeKind
      && relationDraft.from !== relationDraft.to
      && !relationAlreadyExists);
    const addEdge = () => {
      if (!canAddRelation) return;
      onChange({ ...value, edges: [...value.edges, { fromNodeId: relationDraft.from, toNodeId: relationDraft.to, edgeKind: selectedEdgeKind! }] });
      setRelationDraft((current) => ({ ...current, from: "", to: "" }));
    };
    return (
      <div className="run-part-editor">
        <div className="run-relation-controls">
          <select aria-label="关系起点" value={relationDraft.from} onChange={(event) => setRelationDraft((current) => ({ ...current, from: event.target.value }))}>
            <option value="">选择起点</option>
            {part.publicNodeIds.map((id) => <option key={id} value={id}>{indexedPublicLabel(labels, part.publicNodeIds, id, "节点")}</option>)}
          </select>
          <select aria-label="关系类型" value={selectedEdgeKind ?? ""} onChange={(event) => setRelationDraft((current) => ({ ...current, edgeKind: event.target.value as RelationEdgeKindV1 }))}>
            {part.allowedEdgeKinds.map((kind) => <option key={kind} value={kind}>{relationKindLabel(kind)}</option>)}
          </select>
          <select aria-label="关系终点" value={relationDraft.to} onChange={(event) => setRelationDraft((current) => ({ ...current, to: event.target.value }))}>
            <option value="">选择终点</option>
            {part.publicNodeIds.map((id) => <option key={id} value={id}>{indexedPublicLabel(labels, part.publicNodeIds, id, "节点")}</option>)}
          </select>
          <button type="button" className="run-icon-button" disabled={!canAddRelation} onClick={addEdge} aria-label="加入关系"><Plus size={16} aria-hidden="true" /></button>
        </div>
        {!canAddRelation && relationDraft.from && relationDraft.to ? (
          <p className="run-editor-guidance" role="status">{relationDraft.from === relationDraft.to ? "起点和终点不能是同一项。" : relationAlreadyExists ? "这条关系已经加入了。" : ""}</p>
        ) : null}
        <ul className="run-relation-list" aria-label="已经创建的关系" aria-live="polite">
          {value.edges.map((edge, index) => (
            <li key={`${edge.fromNodeId}-${edge.toNodeId}-${index}`}>
              <span>{indexedPublicLabel(labels, part.publicNodeIds, edge.fromNodeId, "节点")} {relationKindLabel(edge.edgeKind)} {indexedPublicLabel(labels, part.publicNodeIds, edge.toNodeId, "节点")}</span>
              <button type="button" className="run-icon-button" onClick={() => onChange({ ...value, edges: value.edges.filter((_, edgeIndex) => edgeIndex !== index) })} aria-label="删除这条关系"><Trash2 size={14} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (part.kind === "repair" && value.kind === "repair") {
    const operations = value.operations;
    const previewItems = repairPreviewItems({
      elementIds: part.publicElementIds,
      labels,
      replacementOptionIds: part.replacementOptionIds,
      replacementLabels,
      operations,
    });
    const updateOperation = (elementId: string, op: string) => {
      const next = operations.filter((operation) => repairOperationTarget(operation) !== elementId);
      if (op === "replace") next.push({ op: "replace", elementId, replacementOptionId: part.replacementOptionIds[0] ?? "" });
      if (op === "remove") next.push({ op: "remove", elementId });
      if (op === "move") next.push({ op: "move", elementId, toIndex: part.publicElementIds.indexOf(elementId) });
      if (op === "insert") next.push({ op: "insert", afterElementId: elementId, replacementOptionId: part.replacementOptionIds[0] ?? "" });
      onChange({ ...value, operations: next as RepairOperationV1[] });
    };
    return (
      <div className="run-repair-list">
        <div className="run-repair-list__source">
          {part.publicElementIds.map((elementId) => {
            const operation = operations.find((candidate) => repairOperationTarget(candidate) === elementId);
            return (
              <div className="run-repair-row" key={elementId}>
              <span>{indexedPublicLabel(labels, part.publicElementIds, elementId, "元素")}</span>
              <select aria-label={`${indexedPublicLabel(labels, part.publicElementIds, elementId, "元素")}的修正动作`} value={operation?.op ?? ""} onChange={(event) => updateOperation(elementId, event.target.value)}>
                <option value="">保持不变</option>
                {part.allowedOperationKinds.map((kind) => <option key={kind} value={kind}>{kind === "replace" ? "替换" : kind === "remove" ? "移除" : kind === "move" ? "移动" : "插入"}</option>)}
              </select>
              {operation?.op === "replace" || operation?.op === "insert" ? (
                <select
                  aria-label={`${indexedPublicLabel(labels, part.publicElementIds, elementId, "元素")}的替换内容`}
                  value={operation.replacementOptionId}
                  onChange={(event) => onChange({ ...value, operations: operations.map((candidate) => repairOperationTarget(candidate) === elementId ? { ...candidate, replacementOptionId: event.target.value } : candidate) as RepairOperationV1[] })}
                >
                  {part.replacementOptionIds.map((optionId) => <option key={optionId} value={optionId}>{indexedPublicLabel(replacementLabels, part.replacementOptionIds, optionId, "替换项")}</option>)}
                </select>
              ) : null}
              {operation?.op === "move" ? (
                <select
                  aria-label={`${indexedPublicLabel(labels, part.publicElementIds, elementId, "元素")}的目标位置`}
                  value={operation.toIndex}
                  onChange={(event) => onChange({
                    ...value,
                    operations: operations.map((candidate) => repairOperationTarget(candidate) === elementId
                      ? { ...candidate, toIndex: Number(event.target.value) }
                      : candidate) as RepairOperationV1[],
                  })}
                >
                  {part.publicElementIds.map((id, index) => <option key={id} value={index}>第 {index + 1} 位</option>)}
                </select>
              ) : null}
              </div>
            );
          })}
        </div>
        <aside className="run-repair-preview" aria-live="polite">
          <strong><Check size={15} aria-hidden="true" />修补预览</strong>
          <ol className="run-repair-preview__sequence">
            {previewItems.map((item, index) => (
              <li key={item.key} data-changed={item.changed ? "true" : "false"}>
                <span>{index + 1}</span><b>{item.label}</b>
              </li>
            ))}
          </ol>
          <p>{operations.length ? `已预览 ${operations.length} 处修补。` : "还没有修改；原内容会保持不变。"}</p>
        </aside>
      </div>
    );
  }

  return <p className="run-inline-error">当前结构化部分与任务版本不一致，请重新同步。</p>;
}

function ChoiceEditor({
  ids,
  labels,
  value,
  onChange,
}: {
  readonly ids: string[];
  readonly labels?: Record<string, string>;
  readonly value: string | undefined;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="run-choice-list" role="radiogroup" aria-label="选择一个答案">
      {ids.map((id, index) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          tabIndex={value === id || (value === undefined && index === 0) ? 0 : -1}
          className={`run-choice-option${value === id ? " is-selected" : ""}`}
          onClick={() => onChange(id)}
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
            event.preventDefault();
            const offset = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
            const nextIndex = (index + offset + ids.length) % ids.length;
            const group = event.currentTarget.parentElement;
            onChange(ids[nextIndex]!);
            window.requestAnimationFrame(() => {
              group?.querySelectorAll<HTMLButtonElement>("[role='radio']")[nextIndex]?.focus();
            });
          }}
        >
          <span className="run-choice-option__mark" aria-hidden="true">
            {value === id ? <Check size={15} strokeWidth={3} /> : null}
          </span>
          {indexedPublicLabel(labels, ids, id, `第 ${index + 1} 个选项`)}
        </button>
      ))}
      {ids.length === 0 ? <p className="run-empty-row">这道题没有给出选项。</p> : null}
    </div>
  );
}

function TrueFalseEditor({
  proposition,
  value,
  onChange,
}: {
  readonly proposition: string;
  readonly value: boolean | undefined;
  readonly onChange: (value: boolean) => void;
}) {
  const options = [true, false] as const;
  const moveSelection = (current: boolean, key: string, button: HTMLButtonElement) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(key)) return;
    const currentIndex = options.indexOf(current);
    const offset = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
    const nextIndex = (currentIndex + offset + options.length) % options.length;
    onChange(options[nextIndex]!);
    window.requestAnimationFrame(() => {
      button.parentElement?.querySelectorAll<HTMLButtonElement>("[role='radio']")[nextIndex]?.focus();
    });
  };
  return (
    <div className="run-truefalse">
      <p className="run-truefalse__claim">{proposition}</p>
      <div className="run-truefalse__actions" role="radiogroup" aria-label="判断这条说法对不对">
        <button
          type="button"
          role="radio"
          aria-checked={value === true}
          tabIndex={value === true || value === undefined ? 0 : -1}
          className={`button${value === true ? " primary" : ""}`}
          onClick={() => onChange(true)}
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
            event.preventDefault();
            moveSelection(true, event.key, event.currentTarget);
          }}
        >这条说法对</button>
        <button
          type="button"
          role="radio"
          aria-checked={value === false}
          tabIndex={value === false ? 0 : -1}
          className={`button${value === false ? " primary" : ""}`}
          onClick={() => onChange(false)}
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
            event.preventDefault();
            moveSelection(false, event.key, event.currentTarget);
          }}
        >这条说法错</button>
      </div>
      {value === undefined ? <p className="meta">先选一个，再提交。</p> : null}
    </div>
  );
}

function MatchingEditor({
  leftIds,
  rightIds,
  labels,
  value,
  onChange,
}: {
  readonly leftIds: string[];
  readonly rightIds: string[];
  readonly labels?: Record<string, string>;
  readonly value: Array<{ leftId: string; rightId: string }>;
  readonly onChange: (value: Array<{ leftId: string; rightId: string }>) => void;
}) {
  const [activeLeft, setActiveLeft] = useState<string | null>(null);
  const paired = new Map(value.map((pair) => [pair.leftId, pair.rightId]));

  const connect = (rightId: string) => {
    if (!activeLeft) return;
    // 两端都只保留一条连线：重新选择任意一端都是改答案，不会生成互相冲突的配对。
    onChange([
      ...value.filter((pair) => pair.leftId !== activeLeft && pair.rightId !== rightId),
      { leftId: activeLeft, rightId },
    ]);
    setActiveLeft(null);
  };

  return (
    <div className="run-matching">
      <p className="meta">先点左边一项，再点右边它该连的那一项。</p>
      <div className="run-matching__columns">
        <ul className="run-matching__col" aria-label="左列">
          {leftIds.map((id) => (
            <li key={id}>
              <button
                type="button"
                className={`run-matching__item${activeLeft === id ? " is-active" : ""}`}
                aria-pressed={activeLeft === id}
                onClick={() => setActiveLeft(activeLeft === id ? null : id)}
              >
                {labels?.[id] ?? id}
                {paired.get(id) ? <span className="run-matching__linked" aria-hidden="true">已连</span> : null}
              </button>
            </li>
          ))}
        </ul>
        <ul className="run-matching__col" aria-label="右列">
          {rightIds.map((id) => (
            <li key={id}>
              <button
                type="button"
                className="run-matching__item"
                disabled={!activeLeft}
                aria-label={activeLeft ? `把${labels?.[activeLeft] ?? activeLeft}与${labels?.[id] ?? id}配成一对` : `先选择左侧项目，再连接${labels?.[id] ?? id}`}
                onClick={() => connect(id)}
              >
                {labels?.[id] ?? id}
              </button>
            </li>
          ))}
        </ul>
      </div>
      {value.length > 0 ? (
        <div className="run-matching__result" role="status">
          <div className="run-matching__trail"><Link2 size={14} aria-hidden="true" />已连 {value.length} 对<button type="button" className="text-action" onClick={() => { onChange([]); setActiveLeft(null); }}>全部重连</button></div>
          <ul className="run-matching__pairs" aria-label="已经组成的配对">
            {value.map((pair) => (
              <li key={`${pair.leftId}-${pair.rightId}`}>
                <span>{labels?.[pair.leftId] ?? pair.leftId}</span><ArrowRight size={13} aria-hidden="true" /><span>{labels?.[pair.rightId] ?? pair.rightId}</span>
                <button type="button" className="run-icon-button" aria-label={`撤销${labels?.[pair.leftId] ?? pair.leftId}的配对`} onClick={() => onChange(value.filter((candidate) => candidate.leftId !== pair.leftId))}><X size={13} aria-hidden="true" /></button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function OrderingEditor({
  ids,
  labels,
  value,
  onChange,
}: {
  readonly ids: string[];
  readonly labels?: Record<string, string>;
  readonly value: string[];
  readonly onChange: (value: string[]) => void;
}) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [grabbedIndex, setGrabbedIndex] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("尚未调整顺序");
  const pointerIndexRef = useRef<number | null>(null);

  const moveTo = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= value.length || toIndex >= value.length) return;
    const next = [...value];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved!);
    onChange(next);
    setAnnouncement(`${indexedPublicLabel(labels, ids, moved!, "排序项")}已移到第 ${toIndex + 1} 位`);
  };
  const move = (index: number, offset: -1 | 1) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= value.length) return;
    moveTo(index, nextIndex);
  };

  return (
    <div className="run-ordering">
      <p className="meta">拖动路标调整顺序；键盘按空格抓取，再用方向键移动。</p>
      <ol className="run-order-list" aria-label="可调整顺序的内容">
        {value.map((id, index) => (
          <li
            key={id}
            data-order-index={index}
            draggable
            data-dragging={draggedIndex === index ? "true" : "false"}
            aria-grabbed={grabbedIndex === index || draggedIndex === index}
            onDragStart={() => setDraggedIndex(index)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); if (draggedIndex !== null) moveTo(draggedIndex, index); setDraggedIndex(null); }}
            onDragEnd={() => setDraggedIndex(null)}
          >
            <b className="run-order-index">{index + 1}</b>
            <button
              type="button"
              className="run-order-grip"
              aria-pressed={grabbedIndex === index}
              aria-label={`${indexedPublicLabel(labels, ids, id, "排序项")}，当前第 ${index + 1} 位。按空格抓取后用上下方向键移动`}
              onPointerDown={(event) => {
                if (event.pointerType === "mouse" && event.button !== 0) return;
                event.preventDefault();
                pointerIndexRef.current = index;
                setDraggedIndex(index);
                event.currentTarget.setPointerCapture?.(event.pointerId);
                setAnnouncement(`正在拖动第 ${index + 1} 项`);
              }}
              onPointerMove={(event) => {
                const fromIndex = pointerIndexRef.current;
                if (fromIndex === null) return;
                const target = document.elementFromPoint?.(event.clientX, event.clientY)?.closest<HTMLElement>("[data-order-index]");
                const toIndex = Number(target?.dataset.orderIndex);
                if (!Number.isInteger(toIndex) || fromIndex === toIndex) return;
                moveTo(fromIndex, toIndex);
                pointerIndexRef.current = toIndex;
                setDraggedIndex(toIndex);
              }}
              onPointerUp={(event) => {
                if (pointerIndexRef.current === null) return;
                event.currentTarget.releasePointerCapture?.(event.pointerId);
                pointerIndexRef.current = null;
                setDraggedIndex(null);
                setAnnouncement("已放下排序项");
              }}
              onPointerCancel={() => {
                pointerIndexRef.current = null;
                setDraggedIndex(null);
                setAnnouncement("已取消拖动");
              }}
              onKeyDown={(event) => {
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  setGrabbedIndex(grabbedIndex === index ? null : index);
                  setAnnouncement(grabbedIndex === index ? "已放下" : `已抓取第 ${index + 1} 项`);
                } else if (event.key === "Escape") {
                  setGrabbedIndex(null);
                  setAnnouncement("已取消移动");
                } else if (grabbedIndex === index && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                  event.preventDefault();
                  const nextIndex = Math.max(0, Math.min(value.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
                  moveTo(index, nextIndex);
                  setGrabbedIndex(nextIndex);
                  window.requestAnimationFrame(() => document.querySelectorAll<HTMLButtonElement>(".run-order-grip")[nextIndex]?.focus());
                }
              }}
            ><GripVertical size={17} aria-hidden="true" /></button>
            <span className="run-order-label">{indexedPublicLabel(labels, ids, id, "排序项")}</span>
            <span className="run-order-controls">
              <button type="button" className="run-icon-button" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`将${indexedPublicLabel(labels, ids, id, "排序项")}上移`}><ArrowUp size={14} aria-hidden="true" /></button>
              <button type="button" className="run-icon-button" disabled={index === value.length - 1} onClick={() => move(index, 1)} aria-label={`将${indexedPublicLabel(labels, ids, id, "排序项")}下移`}><ArrowDown size={14} aria-hidden="true" /></button>
            </span>
          </li>
        ))}
        {ids.length === 0 ? <li className="run-empty-row">这道题没有给出可以排序的内容。</li> : null}
      </ol>
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </div>
  );
}

type StructuredBundleInteraction = Extract<LearningTaskPublic["activeVariant"]["interaction"], { kind: "structured_bundle" }>;
type StructuredBundlePayload = Extract<ArtifactPayload, { kind: "structured_bundle" }>;

function StructuredBundleEditor({
  interaction,
  value,
  onChange,
  restoredDraft,
  onReviewStateChange,
}: {
  readonly interaction: StructuredBundleInteraction;
  readonly value: StructuredBundlePayload;
  readonly onChange: (value: StructuredBundlePayload) => void;
  readonly restoredDraft: boolean;
  readonly onReviewStateChange: (ready: boolean) => void;
}) {
  const [activePart, setActivePart] = useState(0);
  const [touchedOrderingParts, setTouchedOrderingParts] = useState<ReadonlySet<string>>(() => new Set(
    restoredDraft
      ? interaction.parts.filter((part) => part.kind === "ordering").map((part) => part.partId)
      : [],
  ));
  useEffect(() => {
    if (!restoredDraft) return;
    setTouchedOrderingParts(new Set(
      interaction.parts.filter((part) => part.kind === "ordering").map((part) => part.partId),
    ));
  }, [interaction.parts, restoredDraft]);
  const reviewing = activePart >= interaction.parts.length;
  const part = interaction.parts[Math.min(activePart, interaction.parts.length - 1)];
  const partValue = value.partAnswers[Math.min(activePart, value.partAnswers.length - 1)];

  const openPart = (index: number) => {
    onReviewStateChange(false);
    setActivePart(index);
  };

  const answerSummary = (item: StructuredPartPublicV1, answer: StructuredPartAnswerV1 | undefined) => {
    if (!answer || item.kind !== answer.kind) return "这个片段还没有有效答案";
    if (item.kind === "ordering" && answer.kind === "ordering") {
      return answer.orderedTokenIds.map((id) => indexedPublicLabel(item.publicTokenLabels, item.publicTokenIds, id, "排序项")).join(" → ");
    }
    if (item.kind === "relation" && answer.kind === "relation") {
      return answer.edges.map((edge) => `${indexedPublicLabel(item.publicNodeLabels, item.publicNodeIds, edge.fromNodeId, "节点")} ${relationKindLabel(edge.edgeKind)} ${indexedPublicLabel(item.publicNodeLabels, item.publicNodeIds, edge.toNodeId, "节点")}`).join("；");
    }
    if (item.kind === "repair" && answer.kind === "repair") {
      return repairPreviewItems({
        elementIds: item.publicElementIds,
        labels: item.publicElementLabels,
        replacementOptionIds: item.replacementOptionIds,
        replacementLabels: item.replacementOptionLabels,
        operations: answer.operations,
      }).map((preview) => preview.label).join(" → ");
    }
    return "这个片段还没有有效答案";
  };

  if (reviewing) {
    return (
      <div className="run-bundle-review">
        <header><Check size={18} aria-hidden="true" /><div><strong>提交前再看一遍</strong><span>全部证明片段会作为一组答案提交。</span></div></header>
        <ol>
          {interaction.parts.map((item, index) => (
            <li key={item.partId}>
              <span>片段 {index + 1}</span>
              <strong>{item.kind === "ordering" ? "顺序整理" : item.kind === "relation" ? "关系搭建" : "纠错修补"}</strong>
              <p>{answerSummary(item, value.partAnswers[index])}</p>
              <button type="button" className="text-action" onClick={() => openPart(index)}>返回修改</button>
            </li>
          ))}
        </ol>
        <button type="button" className="button" onClick={() => openPart(Math.max(0, interaction.parts.length - 1))}>返回上一步</button>
      </div>
    );
  }

  if (!part || !partValue) return <p className="run-inline-error">组合题的片段数据不完整，请重新同步。</p>;
  const labels = part.kind === "ordering"
    ? part.publicTokenLabels
    : part.kind === "relation"
      ? part.publicNodeLabels
      : part.publicElementLabels;
  const replacementLabels = part.kind === "repair" ? part.replacementOptionLabels : undefined;
  const currentPartReady = structuredPartReady(partValue, part.kind !== "ordering" || touchedOrderingParts.has(part.partId));
  return (
    <div className="run-bundle-editor">
      <div className="run-bundle-progress" role="status" aria-label={`组合证明，第 ${activePart + 1} 个，共 ${interaction.parts.length} 个`}>
        {interaction.parts.map((item, index) => <i key={item.partId} data-active={index <= activePart ? "true" : "false"} data-current={index === activePart ? "true" : "false"} />)}
        <span>{activePart + 1} / {interaction.parts.length}</span>
      </div>
      <section className="run-bundle-part">
        <h4>第 {activePart + 1} 个证明片段</h4>
        <PartEditor
          part={part}
          value={partValue}
          labels={labels}
          replacementLabels={replacementLabels}
          onChange={(nextPart) => {
            const next = [...value.partAnswers] as [StructuredPartAnswerV1] | [StructuredPartAnswerV1, StructuredPartAnswerV1];
            next[activePart] = nextPart;
            if (part.kind === "ordering") {
              setTouchedOrderingParts((current) => new Set([...current, part.partId]));
            }
            onReviewStateChange(false);
            onChange({ ...value, partAnswers: next });
          }}
        />
      </section>
      <footer className="run-bundle-nav">
        <button type="button" className="button" disabled={activePart === 0} onClick={() => openPart(Math.max(0, activePart - 1))}>上一个片段</button>
        <span className="run-bundle-nav__status" role="status">{currentPartReady ? "这个片段已经可以继续" : part.kind === "ordering" ? "先调整一次顺序，再继续" : "先完成这个片段，再继续"}</span>
        <button type="button" className="button primary" disabled={!currentPartReady} onClick={() => {
          const next = activePart + 1;
          setActivePart(next);
          if (next >= interaction.parts.length) onReviewStateChange(true);
        }}>{activePart === interaction.parts.length - 1 ? "复核整组答案" : "下一个片段"}</button>
      </footer>
    </div>
  );
}

function InteractionEditor({
  task,
  value,
  onChange,
  restoredStructuredDraft,
  onStructuredReviewStateChange,
  onVoiceBusyChange,
}: {
  readonly task: LearningTaskPublic;
  readonly value: ArtifactPayload;
  readonly onChange: (value: ArtifactPayload) => void;
  readonly restoredStructuredDraft: boolean;
  readonly onStructuredReviewStateChange: (ready: boolean) => void;
  readonly onVoiceBusyChange: (busy: boolean) => void;
}) {
  const interaction = task.activeVariant.interaction;

  if (interaction.kind === "voice_teachback" && value.kind === "voice") {
    // 此前这里是一段写死的"当前设备没有可用的语音输入"死路文案：语音载荷类型、
    // 录音器与转写通道都存在，只是这个界面从没把声音接进去。
    return (
      <VoiceTeachbackEditor
        maxSeconds={interaction.maxSeconds}
        value={{ confirmedTranscript: value.confirmedTranscript, voiceArtifactRef: value.voiceArtifactRef, correctionMethod: value.correctionMethod }}
        onChange={(next) => onChange({ ...value, confirmedTranscript: next.confirmedTranscript, voiceArtifactRef: next.voiceArtifactRef, correctionMethod: next.correctionMethod })}
        onBusyChange={onVoiceBusyChange}
      />
    );
  }

  if (interaction.kind === "text_response" && value.kind === "text") {
    return (
      <label className="run-text-editor" style={{ display: "block", height: "100%" }}>
        <span className="sr-only">用自己的话回答</span>
        <textarea
          aria-label="用自己的话回答"
          style={{ resize: "none", outline: "none", display: "block" }}
          maxLength={interaction.maxChars}
          value={value.text}
          onChange={(event) => onChange({ ...value, text: event.target.value })}
          placeholder="用自己的话作答。可以举一个具体学习情境，但不要查看来源……"
        />
        <small className="meta" style={{ display: "block", marginTop: 6, textAlign: "right" }}>{value.text.length} / {interaction.maxChars}</small>
      </label>
    );
  }

  if (interaction.kind === "single_choice" && value.kind === "choice") {
    return (
      <ChoiceEditor
        ids={interaction.publicOptionIds}
        labels={interaction.publicOptionLabels}
        value={value.selectedOptionId}
        onChange={(selectedOptionId) => onChange({ ...value, selectedOptionId })}
      />
    );
  }

  if (interaction.kind === "true_false" && value.kind === "true_false") {
    return (
      <TrueFalseEditor
        proposition={interaction.proposition}
        value={value.answer}
        onChange={(answer) => onChange({ ...value, answer })}
      />
    );
  }

  if (interaction.kind === "matching" && value.kind === "matching") {
    return (
      <MatchingEditor
        leftIds={interaction.publicLeftIds}
        rightIds={interaction.publicRightIds}
        labels={interaction.publicLabels}
        value={value.assignments}
        onChange={(assignments) => onChange({ ...value, assignments })}
      />
    );
  }

  if (interaction.kind === "ordering" && value.kind === "ordering") {
    return <OrderingEditor ids={interaction.publicTokenIds} labels={interaction.publicTokenLabels} value={value.orderedTokenIds} onChange={(orderedTokenIds) => onChange({ ...value, orderedTokenIds })} />;
  }

  if (interaction.kind === "relation_canvas" && value.kind === "relation") {
    return <PartEditor part={{ kind: "relation", partId: "main", publicNodeIds: interaction.publicNodeIds, allowedEdgeKinds: interaction.allowedEdgeKinds, partTrustCeiling: "facet_eligible", qualificationProfileHash: null }} value={{ kind: "relation", partId: "main", edges: value.edges }} labels={interaction.publicNodeLabels} onChange={(partValue) => partValue.kind === "relation" && onChange({ ...value, edges: partValue.edges })} />;
  }

  if (interaction.kind === "repair" && value.kind === "repair") {
    return <PartEditor part={{ kind: "repair", partId: "main", publicElementIds: interaction.publicElementIds, allowedOperationKinds: interaction.allowedOperationKinds, replacementOptionIds: interaction.replacementOptionIds, partTrustCeiling: "facet_eligible", qualificationProfileHash: null }} value={{ kind: "repair", partId: "main", operations: value.operations }} labels={interaction.publicElementLabels} replacementLabels={interaction.replacementOptionLabels} onChange={(partValue) => partValue.kind === "repair" && onChange({ ...value, operations: partValue.operations })} />;
  }

  if (interaction.kind === "structured_bundle" && value.kind === "structured_bundle") {
    return <StructuredBundleEditor interaction={interaction} value={value} onChange={onChange} restoredDraft={restoredStructuredDraft} onReviewStateChange={onStructuredReviewStateChange} />;
  }

  return <p className="run-inline-error">这道题要的作答方式这台电脑给不了，已经停住没有提交。</p>;
}

type LearningRunBodyProps = {
  readonly runId: string;
  readonly onExit: (request?: { route: DesktopRouteV1; objectiveId?: string }) => void;
  readonly onPageChange: (page: "assessment" | "result") => void;
};

/**
 * The real LearningRun state machine behind the practice workbench.
 *
 * Behaviour (fences, snapshot resync, draft autosave, activity lease, submit,
 * result polling and the return contract) stays independent from presentation.
 * The workbench deliberately gives every interaction kind enough room to use
 * its own editor instead of forcing every task into a text-answer mockup.
 */
function LearningRunBody({ runId, onExit, onPageChange }: LearningRunBodyProps) {
  const setActiveReviewTarget = useRoomStore((state) => state.setActiveReviewTarget);
  const setCompanionMoment = useRoomStore((state) => state.setCompanionMoment);
  const masterMuted = useRoomStore((state) => state.masterMuted);
  const companionTemporarilyHidden = useRoomStore((state) => state.companionTemporarilyHidden);
  const companionHome = useCompanionHomeProjection();
  const companionFeedbackAllowed = companionResultFeedbackAllowed({
    masterMuted,
    temporarilyHidden: companionTemporarilyHidden,
    activeness: companionHome.projection?.profileSummary.activeness ?? null,
    proactiveMuted: companionHome.projection?.roomProfile.proactiveMuted === true,
    allowPlayful: companionHome.projection?.profileSummary.boundaries.allowPlayful === true,
  });
  const [snapshot, setSnapshot] = useState<LearningRunPublicSnapshotV2 | null>(null);
  /**
   * 秒表与到点自动结束（复盘 #13）。
   *
   * 必须留在条件 return 之前的 hook 区里；`dispatchAction` 定义在后面，用 ref 转接
   * （渲染期赋值，定时器真正触发时必然已就绪）。
   */
  const autoEndedRef = useRef(false);
  const dispatchActionRef = useRef<((action: LearningRunAllowedActionV2, bypassConfirmation?: boolean) => Promise<void>) | null>(null);
  const autoEndRun = useCallback(() => {
    if (autoEndedRef.current) return;
    autoEndedRef.current = true;
    const exit = (snapshot?.allowedActions ?? []).find(
      (action) => action.kind === "skip_run" || action.kind === "end",
    );
    // 到点自动结束不等用户再确认一次：这一刻可能根本没有人看着。
    if (exit) void dispatchActionRef.current?.(exit, true);
  }, [snapshot?.allowedActions]);
  const clock = useLocalActiveClock(
    snapshot?.phase === "active",
    snapshot?.activeSecondsUsed ?? 0,
    autoEndRun,
  );
  const [editor, setEditor] = useState<ArtifactPayload | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [draftStatus, setDraftStatus] = useState("尚未输入");
  const [dirty, setDirty] = useState(false);
  const [draftWriteBusy, setDraftWriteBusy] = useState(false);
  const [draftWriteBlocked, setDraftWriteBlocked] = useState(false);
  const [orderingTouched, setOrderingTouched] = useState(false);
  const [structuredReviewReady, setStructuredReviewReady] = useState(false);
  const [restoredStructuredDraft, setRestoredStructuredDraft] = useState(false);
  const [voiceEditorBusy, setVoiceEditorBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [resultState, setResultState] = useState<ResultState>({ kind: "idle" });
  const [targetReveal, setTargetReveal] = useState<TargetRevealState>({ kind: "idle" });
  const [returnContract, setReturnContract] = useState<LearningRunReturnContractV2 | null>(null);
  /**
   * 已放行的提示，按层级累积展示（2026-09-20 实走复盘 #11）。
   *
   * 此前第二级提示是一条**独立按钮**，还被塞进「更多选择」的 details 里——
   * 用户看到的就是"提示里面又套一层提示"。现在只有一个按钮：点一次放一级，
   * 文案跟着变，放到最后一级就禁用。downgraded 记录服务端是否因此把本卡
   * 计分降级为练习分（回执给了就必须说）。
   */
  const [hints, setHints] = useState<Array<{ level: number; text: string; downgraded: boolean }>>([]);
  const [failure, setFailure] = useState<PlayerFailure | null>(null);
  const [recovery, setRecovery] = useState<PlayerRecovery | null>(null);
  const [loading, setLoading] = useState(true);
  const [resyncing, setResyncing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingAction, setPendingAction] = useState<LearningRunAllowedActionV2 | null>(null);
  const [pendingHintAction, setPendingHintAction] = useState<Extract<LearningRunAllowedActionV2, { kind: "request_hint" }> | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [resultPollTick, setResultPollTick] = useState(0);
  const [resultQueryBusy, setResultQueryBusy] = useState(false);
  const [resultQueryBudgetExhausted, setResultQueryBudgetExhausted] = useState(false);
  /**
   * 等待评估期间的两样东西（2026-09-20 实走复盘 #6）：交上去的答案本身要留在屏上，
   * 以及"已经等了多久"。此前这段时间界面只剩一行字，提交按钮立刻变成"返回"，
   * 用户完全无法判断是在算还是死了。
   */
  const [lockedAnswer, setLockedAnswer] = useState<string | null>(null);
  const [waitingSeconds, setWaitingSeconds] = useState(0);
  const [resultQueryFailure, setResultQueryFailure] = useState<PlayerFailure | null>(null);
  const [resultAcknowledgementActive, setResultAcknowledgementActive] = useState(false);
  const [discoveryRevealed, setDiscoveryRevealed] = useState(false);
  const assessmentPending = resultState.kind === "pending"
    || snapshot?.phase === "assessing" || snapshot?.phase === "committing";
  /**
   * 答案锁定、进入评估之后，编辑区必须让位给等待面板（2026-09-20 实走复盘 #6）。
   * 服务端此时已经收下这份答案，界面却还留着可编辑的框和"提交回答"：再点一次只会
   * 撞上过期 revision 的 409，看起来就像"提交没反应"。
   */
  const canAnswerNow = !assessmentPending
    && snapshot !== null
    && snapshot.phase === "active"
    && snapshot.activeTask !== null;

  useEffect(() => {
    if (!assessmentPending) {
      setWaitingSeconds(0);
      return;
    }
    const timer = window.setInterval(() => setWaitingSeconds((current) => current + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [assessmentPending]);
  /**
   * 麦克风可用性：真探测，不再读主进程那个恒真的通道名检查（复盘 #8）。
   * `null` = 还没探完，此时先不下结论。
   */
  const [microphone, setMicrophone] = useState<MicrophoneAvailability | null>(null);
  const runRequestFenceRef = useRef(createLearningRunRequestFence(runId));
  const snapshotRequestGenerationRef = useRef(0);
  const acceptedSnapshotRef = useRef<{ runId: string; runRevision: number; snapshotId: string } | null>(null);
  const resultPollGenerationRef = useRef(0);
  const resultAcknowledgementEligibleRef = useRef(false);
  const acknowledgedResultKeyRef = useRef<string | null>(null);
  const resultSpeechRef = useRef<CompanionSpeechHandle | null>(null);
  const pendingResultFeedbackRef = useRef<{ line: string; moment: "confirm" | "encourage" } | null>(null);
  const draftWriteGenerationRef = useRef(0);
  const epochRef = useRef<number | undefined>(undefined);
  const taskKeyRef = useRef<string | null>(null);
  const editorRevisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const activeSubscriptionRef = useRef<{ id: string; stop: () => void } | null>(null);
  const primaryHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const focusKeyRef = useRef<string | null>(null);
  const confirmationHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const hintConfirmationHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const confirmationReturnFocusRef = useRef<HTMLElement | null>(null);
  const recoveryHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const unavailableHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const primaryContentRef = useRef<HTMLDivElement | null>(null);
  const discoveryResultKey = resultState.kind === "result"
    ? `${resultState.value.runId}:${resultState.value.result.snapshotId}:${resultState.value.result.outcome}`
    : null;
  const showResult = resultState.kind === "result" || resultState.kind === "terminal";
  const finishResultCeremony = useCallback(() => {
    setResultAcknowledgementActive(false);
  }, []);
  const playPendingResultFeedback = useCallback(() => {
    const cue = pendingResultFeedbackRef.current;
    pendingResultFeedbackRef.current = null;
    if (!cue || !companionFeedbackAllowed) return;
    setCompanionMoment(cue.moment);
    resultSpeechRef.current?.stop();
    // The voice is requested in the same result-frame as the visual arrival.
    // The shared audio host will speak only when unlocked, visible and unmuted.
    resultSpeechRef.current = speakCompanionLine(cue.line);
    if (cue.moment === "confirm") {
      window.dispatchEvent(new CustomEvent("ailearn:home-v2-sound", { detail: { kind: "success" } }));
    }
  }, [companionFeedbackAllowed, setCompanionMoment]);

  useEffect(() => {
    if (resultState.kind === "result" && !resultAcknowledgementActive) playPendingResultFeedback();
  }, [playPendingResultFeedback, resultAcknowledgementActive, resultState]);

  useEffect(() => {
    onPageChange(showResult ? "result" : "assessment");
  }, [onPageChange, showResult]);

  useEffect(() => {
    setDiscoveryRevealed(false);
  }, [discoveryResultKey]);

  useLayoutEffect(() => {
    const activeFence = activateLearningRunRequestFence(runRequestFenceRef.current, runId);
    runRequestFenceRef.current = activeFence;
    const mountedToken = captureLearningRunRequest(activeFence);

    return () => {
      if (isLearningRunRequestCurrent(mountedToken, runRequestFenceRef.current)) {
        runRequestFenceRef.current = deactivateLearningRunRequestFence(runRequestFenceRef.current);
      }
      // Clear the global presentation during the same commit that switches or
      // unmounts the run. A late response from this run cannot revive it.
      setCompanionMoment("idle");
    };
  }, [runId, setCompanionMoment]);

  const applyReturnContract = useCallback((contract: LearningRunReturnContractV2 | null) => {
    setReturnContract(contract);
    setActiveReviewTarget(contract ? reviewTargetFromReturnContract(contract) : null);
  }, [setActiveReviewTarget]);

  const requestSnapshotRefresh = useCallback(() => {
    // Invalidate any GET that started before the event requesting this refresh.
    snapshotRequestGenerationRef.current += 1;
    setRefreshTick((value) => value + 1);
  }, []);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    if (companionFeedbackAllowed) return;
    pendingResultFeedbackRef.current = null;
    resultSpeechRef.current?.stop();
    resultSpeechRef.current = null;
    setCompanionMoment("idle");
  }, [companionFeedbackAllowed, setCompanionMoment]);

  useEffect(() => () => {
    resultSpeechRef.current?.stop();
    resultSpeechRef.current = null;
  }, []);

  useEffect(() => {
    taskKeyRef.current = null;
    editorRevisionRef.current = 0;
    focusKeyRef.current = null;
    confirmationReturnFocusRef.current = null;
    resultAcknowledgementEligibleRef.current = false;
    acknowledgedResultKeyRef.current = null;
    pendingResultFeedbackRef.current = null;
    resultSpeechRef.current?.stop();
    resultSpeechRef.current = null;
    snapshotRequestGenerationRef.current += 1;
    acceptedSnapshotRef.current = null;
    draftWriteGenerationRef.current += 1;
    setSnapshot(null);
    setEditor(null);
    setDraftWriteBusy(false);
    setDraftWriteBlocked(false);
    setOrderingTouched(false);
    setStructuredReviewReady(false);
    setRestoredStructuredDraft(false);
    setVoiceEditorBusy(false);
    setReturnContract(null);
    setResultState({ kind: "idle" });
    setResultAcknowledgementActive(false);
    setResultQueryBusy(false);
    setResultQueryBudgetExhausted(false);
    setResultQueryFailure(null);
    setRecovery(null);
    setResyncing(false);
    setSubmitting(false);
    setActionBusy(false);
    setPendingAction(null);
    setPendingHintAction(null);
    setHints([]);
    setActiveReviewTarget(null);
    setCompanionMoment("idle");
  }, [runId, setActiveReviewTarget, setCompanionMoment]);

  useEffect(() => {
    let active = true;
    const probe = () => { void probeMicrophone().then((result) => { if (active) setMicrophone(result); }); };
    probe();
    // 用户去系统设置里授权后回到窗口就该恢复，不必重开这一题。
    window.addEventListener("focus", probe);
    return () => {
      active = false;
      window.removeEventListener("focus", probe);
    };
  }, [runId]);

  useEffect(() => {
    const content = primaryContentRef.current;
    if (!content) return;
    if (pendingAction || pendingHintAction) content.setAttribute("inert", "");
    else content.removeAttribute("inert");
    return () => content.removeAttribute("inert");
  }, [pendingAction, pendingHintAction]);

  useEffect(() => {
    if (!snapshot) return;
    const activeTask = snapshot.activeTask;
    const focusKey = resultState.kind === "result"
      ? "result"
      : resultState.kind === "terminal"
        ? "terminal"
        : resultQueryFailure && snapshotRequiresResolvedLearningResult(snapshot.phase)
          ? `result-error:${snapshot.phase}`
        : resultState.kind === "pending" || ["assessing", "committing"].includes(snapshot.phase)
          ? `processing:${snapshot.phase}`
          : activeTask && snapshot.phase === "active"
            ? `task:${activeTask.taskId}:${activeTask.revision}:${activeTask.activeVariant.variantId}:${activeTask.activeVariant.revision}`
            : `phase:${snapshot.phase}`;
    if (resultState.kind === "result" && resultAcknowledgementActive) return;
    if (focusKeyRef.current === focusKey || !primaryHeadingRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      focusKeyRef.current = focusKey;
      primaryHeadingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [resultAcknowledgementActive, resultQueryFailure, resultState, snapshot]);

  useEffect(() => {
    if (!recovery) return;
    const frame = window.requestAnimationFrame(() => recoveryHeadingRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [recovery]);

  useEffect(() => {
    if (snapshot || !failure) return;
    const frame = window.requestAnimationFrame(() => unavailableHeadingRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [failure, snapshot]);

  const loadSnapshot = useCallback(async (forceTaskResync = false) => {
    if (!window.ailearn) {
      throw new Error("desktop API is unavailable");
    }
    const requestToken = captureLearningRunRequest(runRequestFenceRef.current);
    const requestGeneration = snapshotRequestGenerationRef.current + 1;
    snapshotRequestGenerationRef.current = requestGeneration;
    const response = await window.ailearn.learningRun.get({ meta: createRequestMeta(epochRef.current), runId }).catch((error: unknown) => {
      if (requestGeneration !== snapshotRequestGenerationRef.current
        || !isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) return null;
      throw error;
    });
    if (!response) return false;
    if (requestGeneration !== snapshotRequestGenerationRef.current
      || !isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) return false;
    const next = unwrapGatewayResult(response);
    if (next.runId !== requestToken.runId) throw new Error("LearningRun snapshot binding does not match the requested run");
    const accepted = acceptedSnapshotRef.current?.runId === requestToken.runId ? acceptedSnapshotRef.current : null;
    if (!isLearningRunSnapshotResponseCurrent({
      token: requestToken,
      fence: runRequestFenceRef.current,
      requestGeneration,
      currentRequestGeneration: snapshotRequestGenerationRef.current,
      responseRunId: next.runId,
      responseRunRevision: next.runRevision,
      acceptedRunRevision: accepted?.runRevision ?? null,
    })) return false;
    if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
    acceptedSnapshotRef.current = { runId: next.runId, runRevision: next.runRevision, snapshotId: next.snapshotId };
    if (next.phase === "assessing" || next.phase === "committing") {
      resultAcknowledgementEligibleRef.current = true;
    }
    if (shouldClearPendingResultForSnapshot(next.phase)) {
      setResultState((current) => current.kind === "pending" ? { kind: "idle" } : current);
      setResultQueryFailure(null);
      setResultQueryBudgetExhausted(false);
    }
    setSnapshot(next);
    setFailure(null);

    const activeTask = next.activeTask;
    if (!activeTask) return true;
    const previousTaskKey = taskKeyRef.current;
    if (forceTaskResync) taskKeyRef.current = null;
    const taskKey = `${activeTask.taskId}:${activeTask.revision}:${activeTask.activeVariant.variantId}:${activeTask.activeVariant.revision}`;
    if (taskKeyRef.current === taskKey) return true;
    // 同步（forceTaskResync）落在同一个任务上、且本地还有未保存输入时，
    // 保留编辑器内容，只对齐服务端草稿 revision——否则同步会清掉用户输入。
    const preserveLocalInput = previousTaskKey === taskKey && dirtyRef.current && editorRevisionRef.current > 0;
    taskKeyRef.current = taskKey;
    setHints([]);
    draftWriteGenerationRef.current += 1;
    setDraftWriteBusy(false);
    setDraftWriteBlocked(false);
    if (!preserveLocalInput) {
      editorRevisionRef.current = 0;
      setEditor(emptyEditor(activeTask));
      setDraftRevision(0);
      setDraftStatus("尚未输入");
      setDirty(false);
      setOrderingTouched(false);
      setStructuredReviewReady(false);
      setRestoredStructuredDraft(false);
      setVoiceEditorBusy(false);
    }
    const draftEditorRevision = editorRevisionRef.current;

    const draftResponse = await window.ailearn.learningRun.getDraft({ meta: createRequestMeta(epochRef.current), runId, taskId: activeTask.taskId }).catch((error: unknown) => {
      if (requestGeneration !== snapshotRequestGenerationRef.current
        || !isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)
        || acceptedSnapshotRef.current?.snapshotId !== next.snapshotId) return null;
      throw error;
    });
    if (!draftResponse) return false;
    if (requestGeneration !== snapshotRequestGenerationRef.current
      || !isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)
      || acceptedSnapshotRef.current?.snapshotId !== next.snapshotId) return false;
    if (taskKeyRef.current !== taskKey) return true;
    if (draftResponse.workspaceEpoch) epochRef.current = draftResponse.workspaceEpoch;
    const draft = unwrapGatewayResult(draftResponse);
    if (draft) {
      if (draft.runId !== next.runId
        || draft.taskId !== activeTask.taskId
        || draft.variantId !== activeTask.activeVariant.variantId
        || draft.taskRevision !== activeTask.revision) {
        throw new Error("LearningRun draft binding does not match the accepted snapshot");
      }
      setDraftRevision(draft.draftRevision);
      if (preserveLocalInput) {
        setDirty(true);
        setDraftStatus("已保留本地未同步输入，正在继续保存…");
      } else if (editorRevisionMatchesRequest(draftEditorRevision, editorRevisionRef.current)) {
        setDraftStatus("已找回你没写完的草稿");
        if (draft.payload) {
          setEditor(editorFromDraft(draft.payload));
          if (draft.payload.kind === "ordering") setOrderingTouched(true);
          if (draft.payload.kind === "structured_bundle") setRestoredStructuredDraft(true);
        }
      } else {
        setDraftStatus("已取回草稿；你刚写的还没存上");
      }
    } else if (preserveLocalInput) {
      setDraftRevision(0);
      setDirty(true);
      setDraftStatus("已保留本地未同步输入，正在继续保存…");
    }
    return true;
  }, [runId]);

  const resyncLearningRun = useCallback(async (kind: PlayerRecovery) => {
    if (!window.ailearn || resyncing) return;
    setResyncing(true);
    setLoading(true);
    setFailure(null);
    try {
      const loaded = await loadSnapshot(true);
      if (!loaded) return;
      if (kind !== "draft") setResultPollTick((value) => value + 1);
      setRecovery(null);
      focusKeyRef.current = null;
      if (!dirtyRef.current) setDraftStatus(kind === "draft" ? "草稿已存好" : "进度已存好");
    } catch (error) {
      setFailure({ message: gatewayErrorMessage(error), retryable: error instanceof RendererGatewayError && error.retry !== "never" });
    } finally {
      setResyncing(false);
      setLoading(false);
    }
  }, [loadSnapshot, resyncing]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadSnapshot()
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.log("SCRATCH-LOADFAIL", error);
        if (!active) return;
        setFailure({ message: gatewayErrorMessage(error), retryable: error instanceof RendererGatewayError && error.retry !== "never" });
      })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [loadSnapshot, refreshTick]);

  useEffect(() => {
    let active = true;
    let subscriptionId: string | null = null;
    const subscribe = async () => {
      if (!window.ailearn) return;
      try {
        const response = await window.ailearn.subscriptions.subscribe({ meta: createRequestMeta(epochRef.current), topic: { kind: "learningRun", runId } });
        if (!active) return;
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        subscriptionId = unwrapGatewayResult(response).subscriptionId;
        const stop = window.ailearn.subscriptions.onEvent(subscriptionId, requestSnapshotRefresh);
        activeSubscriptionRef.current = { id: subscriptionId, stop };
      } catch {
        // GET/resync remains authoritative. A missing stream never creates a
        // fake result or unlocks Companion context.
      }
    };
    void subscribe();
    return () => {
      active = false;
      activeSubscriptionRef.current?.stop();
      if (subscriptionId && window.ailearn) {
        void window.ailearn.subscriptions.unsubscribe({ meta: createRequestMeta(epochRef.current), subscriptionId });
      }
      activeSubscriptionRef.current = null;
    };
  }, [requestSnapshotRefresh, runId]);

  useEffect(() => {
    const activeSnapshot = snapshot;
    const activeTask = activeSnapshot?.activeTask;
    if (!activeSnapshot || activeSnapshot.phase !== "active" || !activeTask || !window.ailearn) return;

    let active = true;
    let activeWindowStartedAtMs: number | null = null;
    let sending = false;
    const pendingWindows: ActivityLeaseWindow[] = [];

    const drain = async () => {
      if (sending || pendingWindows.length === 0 || !window.ailearn) return;
      const next = pendingWindows[0];
      sending = true;
      let sent = false;
      try {
        const response = await window.ailearn.learningRun.recordActivityLease({
          meta: createRequestMeta(epochRef.current),
          runId,
          request: {
            version: 2,
            snapshotId: activeSnapshot.snapshotId,
            runRevision: activeSnapshot.runRevision,
            runtimeEpoch: activeSnapshot.runtimeEpoch,
            startedAt: next.startedAt,
            endedAt: next.endedAt,
          },
        });
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        unwrapGatewayResult(response);
        sent = true;
      } catch {
        // Activity accounting is best-effort. Keep the exact segment so the
        // next eligible tick can retry it without inventing elapsed time.
      } finally {
        sending = false;
      }
      if (sent && pendingWindows[0] === next) {
        pendingWindows.shift();
        // Re-read the server snapshot so the sheet shows the authoritative
        // activeSecondsUsed value rather than deriving elapsed time locally.
        if (active) requestSnapshotRefresh();
        void drain();
      }
    };

    const enqueueWindow = (startedAtMs: number, endedAtMs: number) => {
      const next = buildActivityLeaseWindow(startedAtMs, endedAtMs, endedAtMs);
      if (!next) return;
      pendingWindows.push(next);
      void drain();
    };

    const flushActiveWindow = () => {
      if (activeWindowStartedAtMs === null) return;
      const startedAtMs = activeWindowStartedAtMs;
      activeWindowStartedAtMs = null;
      enqueueWindow(startedAtMs, Date.now());
    };

    const syncEligibility = () => {
      const eligible = isActivityLeaseEligible({
        phase: activeSnapshot.phase,
        hasActiveTask: activeSnapshot.activeTask !== null,
        visibilityState: document.visibilityState,
        documentFocused: typeof document.hasFocus === "function" ? document.hasFocus() : true,
      });
      const nowMs = Date.now();
      if (!eligible) {
        flushActiveWindow();
        return;
      }
      if (activeWindowStartedAtMs === null) {
        activeWindowStartedAtMs = nowMs;
      } else if (nowMs - activeWindowStartedAtMs >= ACTIVITY_LEASE_INTERVAL_MS) {
        const startedAtMs = activeWindowStartedAtMs;
        activeWindowStartedAtMs = nowMs;
        enqueueWindow(startedAtMs, nowMs);
      }
      void drain();
    };

    syncEligibility();
    const timer = window.setInterval(syncEligibility, ACTIVITY_LEASE_INTERVAL_MS);
    const onVisibilityChange = () => syncEligibility();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", syncEligibility);
    window.addEventListener("blur", syncEligibility);

    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", syncEligibility);
      window.removeEventListener("blur", syncEligibility);
      flushActiveWindow();
      void drain();
    };
  }, [requestSnapshotRefresh, runId, snapshot?.activeTask?.revision, snapshot?.activeTask?.taskId, snapshot?.phase, snapshot?.runRevision, snapshot?.runtimeEpoch, snapshot?.snapshotId]);

  useEffect(() => {
    const activeTask = snapshot?.activeTask;
    if (!dirty || !editor || !activeTask || snapshot.phase !== "active" || loading || draftWriteBusy || draftWriteBlocked || submitting || resyncing || recovery === "draft") return;
    const revision = editorRevisionRef.current;
    const requestToken = captureLearningRunRequest(runRequestFenceRef.current);
    const taskKey = `${activeTask.taskId}:${activeTask.revision}:${activeTask.activeVariant.variantId}:${activeTask.activeVariant.revision}`;
    const timer = window.setTimeout(async () => {
      if (revision !== editorRevisionRef.current || !window.ailearn) return;
      const payload = toDraftPayload(editor);
      if (!payload) return;
      const writeGeneration = draftWriteGenerationRef.current + 1;
      draftWriteGenerationRef.current = writeGeneration;
      setDraftWriteBusy(true);
      setDraftStatus("正在保存草稿…");
      try {
        const response = await window.ailearn.learningRun.saveDraft({
          meta: createRequestMeta(epochRef.current),
          commandId: createCommandId("draft"),
          runId,
          taskId: activeTask.taskId,
          request: {
            version: 2,
            snapshotId: snapshot.snapshotId,
            variantId: activeTask.activeVariant.variantId,
            variantRevision: activeTask.activeVariant.revision,
            taskRevision: activeTask.revision,
            expectedDraftRevision: draftRevision,
            payload,
            rendererState: rendererStateFor(editor),
          },
        });
        if (!isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)
          || taskKeyRef.current !== taskKey) return;
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        const receipt = unwrapGatewayResult(response);
        if (receipt.runId !== requestToken.runId
          || receipt.snapshotId !== snapshot.snapshotId
          || receipt.taskId !== activeTask.taskId
          || receipt.variantId !== activeTask.activeVariant.variantId
          || receipt.taskRevision !== activeTask.revision) {
          throw new Error("LearningRun draft receipt binding does not match the write request");
        }
        setDraftRevision(receipt.draftRevision);
        if (editorRevisionMatchesRequest(revision, editorRevisionRef.current)) {
          setDirty(false);
          setDraftWriteBlocked(false);
          setDraftStatus("草稿已保存");
          setRecovery(null);
        } else {
          // Keep the newer editor state dirty. Updating draftRevision causes
          // this effect to schedule its next write against the exact receipt.
          setDirty(true);
          setDraftStatus("有更新修改，正在继续保存…");
        }
      } catch (error) {
        if (!isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)
          || taskKeyRef.current !== taskKey) return;
        if (needsLearningRunResync(error)) {
          setDraftWriteBlocked(true);
          setRecovery("draft");
          setFailure({ message: gatewayErrorMessage(error), retryable: false });
          setDraftStatus("草稿没存上，先重新读一次再继续");
        } else {
          setDraftWriteBlocked(true);
          setDraftStatus(gatewayErrorMessage(error));
        }
      } finally {
        if (writeGeneration === draftWriteGenerationRef.current
          && isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)
          && taskKeyRef.current === taskKey) {
          setDraftWriteBusy(false);
        }
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [dirty, draftRevision, draftWriteBlocked, draftWriteBusy, editor, loading, recovery, resyncing, runId, snapshot, submitting]);

  const queryResult = useCallback(async (pollGeneration: number) => {
    if (!window.ailearn) return true;
    const requestToken = captureLearningRunRequest(runRequestFenceRef.current);
    const requestIsCurrent = () => isLearningRunResultQueryCurrent(
      requestToken,
      runRequestFenceRef.current,
      pollGeneration,
      resultPollGenerationRef.current,
    );
    const response = await window.ailearn.learningRun.getResult({ meta: createRequestMeta(epochRef.current), runId });
    if (!requestIsCurrent()) return true;
    if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
    const value = unwrapGatewayResult(response);
    if (!learningRunResultMatchesRun(value, requestToken.runId)) {
      throw new Error("LearningRun result binding does not match the requested run");
    }
    setResultQueryFailure(null);
    if (value.status === "pending") {
      if (shouldClearPendingResultForSnapshot(value.phase)) {
        setResultState({ kind: "idle" });
        setResultQueryBudgetExhausted(false);
        requestSnapshotRefresh();
        return true;
      }
      if (value.phase === "assessing" || value.phase === "committing") {
        resultAcknowledgementEligibleRef.current = true;
      }
      setResultState({ kind: "pending", phase: value.phase });
      return false;
    }
    setResultQueryBudgetExhausted(false);
    if (value.status === "learning_result") {
      setResultState({ kind: "result", value });
      const resultKey = `${value.runId}:${value.result.snapshotId}:${value.result.outcome}`;
      const isFreshResult = resultAcknowledgementEligibleRef.current
        && acknowledgedResultKeyRef.current !== resultKey;
      const playsFullCeremony = isFreshResult && shouldConfirmCompanionForOutcome(value.result.outcome);
      const hasPositiveCompanionFeedback = ["demonstrated", "practice_completed", "partial"].includes(value.result.outcome);
      if (isFreshResult) {
        acknowledgedResultKeyRef.current = resultKey;
        setResultAcknowledgementActive(playsFullCeremony);
        if (companionFeedbackAllowed && hasPositiveCompanionFeedback) {
          pendingResultFeedbackRef.current = {
            moment: playsFullCeremony ? "confirm" : "encourage",
            line: companionResultLine(value.result, snapshot?.target.publicSummary ?? "这条理解目标", resultKey),
          };
        } else {
          pendingResultFeedbackRef.current = null;
          resultSpeechRef.current?.stop();
          resultSpeechRef.current = null;
          setCompanionMoment("idle");
        }
      } else {
        // skipped / declared_unable / repair and restored terminal results are
        // deliberately neutral and never reuse the success presentation.
        setResultAcknowledgementActive(false);
        pendingResultFeedbackRef.current = null;
        setCompanionMoment("idle");
      }
    } else {
      setResultState({ kind: "terminal", value });
      setResultAcknowledgementActive(false);
      pendingResultFeedbackRef.current = null;
      setCompanionMoment("idle");
    }
    if (!requestIsCurrent()) return true;
    try {
      const returnResponse = await window.ailearn.learningRun.getReturnContract({ meta: createRequestMeta(epochRef.current), runId });
      if (!requestIsCurrent()) return true;
      if (returnResponse.workspaceEpoch) epochRef.current = returnResponse.workspaceEpoch;
      const contract = unwrapGatewayResult(returnResponse);
      if (contract.runId !== requestToken.runId) throw new Error("LearningRun return binding does not match the requested run");
      applyReturnContract(contract);
    } catch {
      if (requestIsCurrent()) applyReturnContract(null);
    }
    return true;
  }, [applyReturnContract, companionFeedbackAllowed, requestSnapshotRefresh, runId, setCompanionMoment, snapshot?.target.publicSummary]);

  useEffect(() => {
    if (!snapshot || snapshot.runId !== runId || !shouldPollLearningRunResult(snapshot.phase)) return;
    let active = true;
    const pollGeneration = resultPollGenerationRef.current + 1;
    resultPollGenerationRef.current = pollGeneration;
    const startedAt = Date.now();
    let timer: number | undefined;
    setResultQueryBudgetExhausted(false);
    const poll = async (attempt: number) => {
      if (!active) return;
      setResultQueryBusy(true);
      try {
        const complete = await queryResult(pollGeneration);
        if (!active || complete) return;
        const delay = resultPollDelayMs(attempt, Date.now() - startedAt);
        if (delay === null) {
          setResultQueryBudgetExhausted(true);
          return;
        }
        timer = window.setTimeout(() => void poll(attempt + 1), delay);
      } catch (error) {
        if (active) setResultQueryFailure({ message: gatewayErrorMessage(error), retryable: true });
      } finally {
        if (active) setResultQueryBusy(false);
      }
    };
    void poll(0);
    return () => {
      active = false;
      if (resultPollGenerationRef.current === pollGeneration) resultPollGenerationRef.current += 1;
      if (timer) window.clearTimeout(timer);
    };
  }, [queryResult, resultPollTick, runId, snapshot?.phase, snapshot?.runId]);

  const updateEditor = (next: ArtifactPayload) => {
    editorRevisionRef.current += 1;
    setEditor(next);
    if (next.kind === "ordering") setOrderingTouched(true);
    if (next.kind === "structured_bundle") setStructuredReviewReady(false);
    setDirty(true);
    setDraftWriteBlocked(false);
    setDraftStatus(recovery === "draft" ? "先把草稿存上，再继续写" : "有未保存修改");
  };

  const submit = async (payload: ArtifactPayload) => {
    if (!snapshot?.activeTask || !window.ailearn || submitting || resyncing || recovery !== null || (payload.kind === "voice" && voiceEditorBusy)) return;
    if (payload.kind === "ordering" && !orderingTouched) {
      setDraftStatus("先调整一次顺序，确认这不是题目给出的随机初始排列");
      return;
    }
    if (payload.kind === "structured_bundle" && !structuredReviewReady) {
      setDraftStatus("先完成全部片段并复核整组答案，再提交");
      return;
    }
    if (payload.kind !== "declared_unable" && !payloadIsReady(payload, snapshot.activeTask)) {
      setDraftStatus("先完成当前任务，再提交可信证据");
      return;
    }
    const requestToken = captureLearningRunRequest(runRequestFenceRef.current);
    setSubmitting(true);
    setFailure(null);
    try {
      const response = await window.ailearn.learningRun.submit({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId("submit"),
        runId,
        taskId: snapshot.activeTask.taskId,
        request: {
          version: 2,
          snapshotId: snapshot.snapshotId,
          variantId: snapshot.activeTask.activeVariant.variantId,
          variantRevision: snapshot.activeTask.activeVariant.revision,
          runRevision: snapshot.runRevision,
          taskRevision: snapshot.activeTask.revision,
          inputSchemaHash: snapshot.activeTask.activeVariant.inputSchemaHash,
          payload,
        },
      });
      if (!isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) return;
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const receipt = unwrapGatewayResult(response);
      if (receipt.runId !== requestToken.runId
        || receipt.snapshotId !== snapshot.snapshotId
        || receipt.taskId !== snapshot.activeTask.taskId
        || receipt.taskRevision !== snapshot.activeTask.revision) {
        throw new Error("LearningRun submission receipt binding does not match the request");
      }
      const accepted = acceptedSnapshotRef.current?.runId === receipt.runId ? acceptedSnapshotRef.current : null;
      if (!accepted || receipt.runRevision >= accepted.runRevision) {
        acceptedSnapshotRef.current = {
          runId: receipt.runId,
          runRevision: receipt.runRevision,
          snapshotId: receipt.snapshotId,
        };
      }
      setDirty(false);
      setLockedAnswer(answerPreview(payload));
      setDraftStatus("回答已锁定，正在评估");
      setRecovery(null);
      resultAcknowledgementEligibleRef.current = true;
      setResultPollTick((value) => value + 1);
      setResultState({ kind: "pending", phase: "assessing" });
      setResultQueryBudgetExhausted(false);
      requestSnapshotRefresh();
    } catch (error) {
      if (!isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) return;
      const shouldResync = needsLearningRunResync(error);
      if (shouldResync) {
        setRecovery("submit");
        setDraftStatus("上一次提交没回音，先重新读一次再操作");
      }
      setFailure({ message: gatewayErrorMessage(error), retryable: !shouldResync && error instanceof RendererGatewayError && error.retry !== "never" });
    } finally {
      if (isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) setSubmitting(false);
    }
  };

  const dispatchAction = async (action: LearningRunAllowedActionV2, bypassConfirmation = false) => {
    if (!snapshot || !window.ailearn || actionBusy || resyncing || recovery !== null) return;
    if (!bypassConfirmation && "confirmationRequired" in action && action.confirmationRequired) {
      confirmationReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPendingAction(action);
      return;
    }
    const requestToken = captureLearningRunRequest(runRequestFenceRef.current);
    setActionBusy(true);
    try {
      const response = await window.ailearn.learningRun.action({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId("action"),
        runId,
        request: {
          version: 2,
          snapshotId: snapshot.snapshotId,
          runRevision: snapshot.runRevision,
          ...(snapshot.activeTask ? { taskRevision: snapshot.activeTask.revision } : {}),
          runtimeEpoch: snapshot.runtimeEpoch,
          action: actionRequestFor(action),
        },
      });
      if (!isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) return;
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const value = unwrapGatewayResult(response);
      const accepted = acceptedSnapshotRef.current?.runId === value.snapshot.runId ? acceptedSnapshotRef.current : null;
      if (accepted && value.snapshot.runRevision < accepted.runRevision) {
        requestSnapshotRefresh();
        return;
      }
      snapshotRequestGenerationRef.current += 1;
      acceptedSnapshotRef.current = {
        runId: value.snapshot.runId,
        runRevision: value.snapshot.runRevision,
        snapshotId: value.snapshot.snapshotId,
      };
      if (value.snapshot.phase === "assessing" || value.snapshot.phase === "committing") {
        resultAcknowledgementEligibleRef.current = true;
      }
      if (shouldClearPendingResultForSnapshot(value.snapshot.phase)) {
        setResultState((current) => current.kind === "pending" ? { kind: "idle" } : current);
        setResultQueryFailure(null);
        setResultQueryBudgetExhausted(false);
      }
      setFailure(null);
      setRecovery(null);
      if (value.actionResult.kind === "hint_revealed") {
        const revealed = value.actionResult;
        setHints((current) => [
          ...current.filter((entry) => entry.level !== revealed.level),
          {
            level: revealed.level,
            text: revealed.text,
            downgraded: revealed.resultingTrustCeiling === "practice_only",
          },
        ].sort((left, right) => left.level - right.level));
      }
      if (action.kind === "end" || action.kind === "skip_run") setResultPollTick((value) => value + 1);
      const changedTask = action.kind === "switch_variant"
        || action.kind === "activate_followup";
      await loadSnapshot(changedTask);
    } catch (error) {
      if (!isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) return;
      const shouldResync = needsLearningRunResync(error);
      if (shouldResync) {
        setRecovery("action");
        setDraftStatus("上一步没回音，先重新读一次再操作");
      }
      setFailure({ message: gatewayErrorMessage(error), retryable: !shouldResync && error instanceof RendererGatewayError && error.retry !== "never" });
    } finally {
      if (isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) {
        setActionBusy(false);
        setPendingAction(null);
      }
    }
  };
  dispatchActionRef.current = dispatchAction;

  const closeConfirmation = () => {
    const returnFocus = confirmationReturnFocusRef.current;
    confirmationReturnFocusRef.current = null;
    setPendingAction(null);
    window.requestAnimationFrame(() => {
      const canRestore = returnFocus
        && returnFocus.isConnected
        && returnFocus !== document.body
        && returnFocus !== document.documentElement
        && !returnFocus.closest("[inert], [aria-hidden='true']");
      if (canRestore) {
        returnFocus.focus({ preventScroll: true });
      } else {
        primaryHeadingRef.current?.focus({ preventScroll: true });
      }
    });
  };

  const confirmPendingAction = async () => {
    const action = pendingAction;
    if (!action) return;
    setPendingAction(null);
    await dispatchAction(action, true);
  };

  const closeHintConfirmation = () => {
    setPendingHintAction(null);
    window.requestAnimationFrame(() => primaryHeadingRef.current?.focus({ preventScroll: true }));
  };

  const confirmHint = async () => {
    const action = pendingHintAction;
    if (!action) return;
    setPendingHintAction(null);
    await dispatchAction(action, true);
  };

  const handleConfirmationKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeConfirmation();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [confirmationHeadingRef.current, ...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)")]
      .filter((element): element is HTMLElement => Boolean(element));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    if (!pendingAction) return;
    const frame = window.requestAnimationFrame(() => confirmationHeadingRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [pendingAction]);

  useEffect(() => {
    if (!pendingHintAction) return;
    const frame = window.requestAnimationFrame(() => hintConfirmationHeadingRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [pendingHintAction]);

  /**
   * 语音替代项在麦克风不可用时**保留但禁用**，并把原因写在旁边（复盘 #8）：
   * 直接把它藏起来，用户只会以为"根本没有换一种方式这回事"。
   */
  const microphoneUnavailable = microphone !== null && microphone.state !== "ready";
  const microphoneReason = microphoneUnavailable ? microphoneAvailabilityCopy(microphone!) : "";
  const blockedSwitchIds = new Set(microphoneUnavailable
    ? (snapshot?.activeTask?.availableAlternatives ?? [])
      .filter((alternative) => alternative.family === "voice")
      .map((alternative) => alternative.alternativeId)
    : []);
  const alternativeActions = useMemo(
    () => snapshot?.allowedActions.filter((action) => action.kind === "switch_variant") ?? [],
    [snapshot?.allowedActions],
  );
  /** 备选 id → 模态，供按钮写出「改做选择题」这类具体文案（方案 §3 D5）。 */
  const alternativeKindById = useMemo(
    () => new Map((snapshot?.activeTask?.availableAlternatives ?? [])
      .map((alternative) => [alternative.alternativeId, alternative.interactionKind])),
    [snapshot?.activeTask?.availableAlternatives],
  );
  const canSubmitUnable = snapshot?.activeTask !== null && snapshot?.phase === "active";
  const retryResultQuery = () => {
    setFailure(null);
    setResultQueryFailure(null);
    setResultQueryBudgetExhausted(false);
    setResultPollTick((value) => value + 1);
  };
  const openObjective = () => {
    if (!snapshot) return;
    onExit({ route: { kind: "room.home" }, objectiveId: snapshot.target.objectiveId });
  };

  if (loading && !snapshot) {
    return <SurfaceDataState kind="loading" message="正在读取 LearningRun" detail="正在读取这一轮学到哪了。" />;
  }

  if (failure && !snapshot) {
    return (
      <SurfaceDataState
        kind="error"
        message="暂时无法打开这条学习旅程"
        detail={failure.message}
        onRetry={failure.retryable ? requestSnapshotRefresh : undefined}
      />
    );
  }

  if (!snapshot) return null;

  const activeTask = snapshot.activeTask;
  const result = resultState.kind === "result" ? resultState.value.result : null;
  const terminal = resultState.kind === "terminal" ? resultState.value : null;
  const resultSeed = result ? `${runId}:${result.snapshotId}:${result.outcome}` : null;
  const rawDiscoveryCard = result && resultSeed ? learningDiscoveryCard(result, resultSeed) : null;
  // 安静模式仍保留真实学习发现，但不能把它包装成“伴星在说话”。这是学习反馈，
  // 不是角色主动打扰；声音、动作和角色口吻都由 companionFeedbackAllowed 单独关掉。
  const discoveryCard = rawDiscoveryCard && !companionFeedbackAllowed && rawDiscoveryCard.eyebrow === "伴星发现"
    ? { ...rawDiscoveryCard, eyebrow: "本次闪光点" as const }
    : rawDiscoveryCard;
  const companionFeedbackLine = result && resultSeed
    ? companionResultLine(result, snapshot.target.publicSummary, resultSeed)
    : null;

  const loadTargetReveal = () => {
    if (targetReveal.kind === "loading" || targetReveal.kind === "ready") return;
    setTargetReveal({ kind: "loading" });
    void window.ailearn.learningRun.revealTarget({ meta: createRequestMeta(epochRef.current), runId })
      .then((response) => {
        setTargetReveal({ kind: "ready", reveal: unwrapGatewayResult(response) });
      })
      .catch((error: unknown) => {
        setTargetReveal({ kind: "unavailable", message: gatewayErrorMessage(error) });
      });
  };
  const unresolvedResultFailure = resultState.kind === "idle"
    && snapshotRequiresResolvedLearningResult(snapshot.phase)
    ? resultQueryFailure
    : null;
  const processingFailure = resultQueryFailure ?? failure;
  const processingPhase = resultState.kind === "pending" ? resultState.phase : snapshot.phase;
  const contractTarget = returnContract?.status === "unavailable"
    ? returnContract.fallbackTargetV2
    : returnContract?.returnTargetV2 ?? null;
  const returnTarget = contractTarget ?? snapshot.returnTargetV2;
  const exitRoute = routeForReturnTarget(returnTarget);
  const exitDestinationLabel = exitRoute.kind === "review.queue" ? "回到复习队列" : "返回学习空间";
  // 「同步中」是内部词：用户要知道的不是数据在同步，而是回去之后落点还没定。
  const resultReturnLabel = returnContract?.status === "projection_pending" ? `确认中 · ${exitDestinationLabel}` : exitDestinationLabel;
  const nextChallengeLabel = result?.outcome === "declared_unable"
    ? "先回研究册把这条看懂，再回来验证"
    : result && result.gapFacets.length
      ? `先补上「${facetText(result.gapFacets.slice(0, 1), "")}」`
      : returnTargetLabel(returnTarget);
  const recoveryHeading = recovery === "draft" ? "草稿版本需要同步" : "上一动作结果需要确认";
  const processingHeadline = processingPhase === "committing"
    ? "正在记录可信学习结果"
    : processingPhase === "assessing"
      ? "回答已锁定，正在评估"
      : phaseLabels[processingPhase];
  const busy = pendingAction !== null || pendingHintAction !== null || actionBusy || resyncing || recovery !== null;
  const actionLinks = [
    ...alternativeActions,
    ...snapshot.allowedActions.filter((action) => ["pause", "resume", "request_hint", "activate_followup", "finish_current_evidence", "finish_without_commit", "retry_prepare", "retry_assessment", "retry_commit"].includes(action.kind)),
    ...snapshot.allowedActions.filter((action) => ["skip_run", "end"].includes(action.kind)),
  ];
  const switchAction = actionLinks.find((action) => action.kind === "switch_variant");
  const phaseAction = actionLinks.find((action) => action.kind === "pause" || action.kind === "resume");
  /**
   * 提示阶梯：服务端按 `hintLevels` 签发 1..N 个 request_hint，界面上只有**一个**
   * 按钮，每次放行下一层；放行到最后一层后禁用（复盘 #11）。
   */
  const hintLadder = actionLinks
    .filter((action): action is Extract<LearningRunAllowedActionV2, { kind: "request_hint" }> => action.kind === "request_hint")
    .sort((left, right) => left.level - right.level);
  const nextHintAction = hintLadder.find((action) => !hints.some((entry) => entry.level === action.level));
  const hintsExhausted = hintLadder.length > 0 && nextHintAction === undefined;
  /**
   * 退出动作必须摆在明面上（复盘 #12）：此前 `更多选择` 的 details 折叠了「稍后再做」，
   * 用户在无障碍树里根本找不到它——折叠区里的东西对键盘和读屏都不存在。
   * `end` 在其它阶段是唯一出口，同样直给。
   */
  const exitAction = actionLinks.find((action) => action.kind === "skip_run" || action.kind === "end");
  /**
   * checkpoint 的下一步（补充证据 / 结束但不改变复习 / 结算当前证据）是**用户的选择**，
   * 不是后台在准备什么——它们必须在明面上（2026-09-21 实机截图：藏在「更多选择」里，
   * 屏上只剩「安全退出」，用户以为要一直等下去）。
   */
  const checkpointActions = actionLinks.filter((action) =>
    action.kind === "activate_followup"
    || action.kind === "finish_current_evidence"
    || action.kind === "finish_without_commit");
  const checkpointPrimaryAction = checkpointActions.find((action) => action.kind === "finish_current_evidence")
    ?? checkpointActions.find((action) => action.kind === "activate_followup")
    ?? checkpointActions.find((action) => action.kind === "finish_without_commit")
    ?? null;
  const checkpointUnassessable = checkpointActions.some((action) => action.kind === "finish_without_commit");
  /**
   * 审计 F28：`not_assessable` 有两种完全不同的原因。系统侧缺冻结证据时，服务端
   * 已经不再签发 `activate_followup`（补回答补不上），这里再把它说明白——否则
   * 用户读到的仍然是"我答得不够好"，而正确的心智模型是"这条目标现在判不了"。
   */
  const checkpointEvidenceGap = snapshot.checkpointReason === "no_frozen_evidence";
  const quickActions: LearningRunAllowedActionV2[] = [];
  if (switchAction) quickActions.push(switchAction);
  if (phaseAction) quickActions.push(phaseAction);
  if (nextHintAction) quickActions.push(nextHintAction);
  else if (hintLadder.length > 0) quickActions.push(hintLadder[hintLadder.length - 1]!);
  quickActions.push(...checkpointActions);
  if (exitAction) quickActions.push(exitAction);
  const quickActionKeys = new Set(quickActions.map(actionKey));
  /**
   * 出口（离开这次作答）与求助（换个走法继续）是两类东西，此前却和主按钮平铺在
   * 同一个 flex-wrap 行里：控件一多，状态文字被挤到 74px 宽折成两行、主按钮掉到
   * 第二排（31 号文档 P19，1440×810 实测 dock 高 123px、两排在 y=625 与 y=693）。
   * 现在分成定死的两排——出口在上、主按钮在下排右端，不再靠换行碰运气。
   */
  const isExitAction = (action: LearningRunAllowedActionV2) => action.kind === "skip_run" || action.kind === "end";
  const exitActions = quickActions.filter(isExitAction);
  const helpActions = quickActions.filter((action) => !isExitAction(action) && action !== checkpointPrimaryAction);
  const quickButton = (action: LearningRunAllowedActionV2, primary = false) => {
    const isHint = action.kind === "request_hint";
    const isSwitch = action.kind === "switch_variant";
    const blockedSwitch = isSwitch && blockedSwitchIds.has(action.alternativeId);
    const label = isSwitch
      ? switchActionLabel(alternativeKindById.get(action.alternativeId))
      : !isHint
        ? actionLabel(action)
        : hints.length === 0
          ? "给我一点提示"
          : hintsExhausted
            ? "提示已经给完"
            : "再看一层提示";
    return (
      <button
        key={actionKey(action)}
        type="button"
        className={`button${primary ? " primary" : ""}${blockedSwitch ? " learning-run-alt-disabled" : ""}`}
        disabled={busy || (isHint && hintsExhausted) || blockedSwitch}
        aria-describedby={blockedSwitch ? "learning-run-switch-note" : undefined}
        title={blockedSwitch ? microphoneReason : undefined}
        onClick={() => {
          const needsDowngradeConfirmation = isHint
            && hints.length === 0
            && snapshot.publishedTargetEligibility === "eligible"
            && Boolean(activeTask?.assistancePolicy.exposureLowersTrust);
          if (needsDowngradeConfirmation && action.kind === "request_hint") {
            setPendingHintAction(action);
            return;
          }
          void dispatchAction(action);
        }}
      >
        {actionIcon(action)}
        <span>{label}{isHint && hints.length === 0 && snapshot.publishedTargetEligibility === "eligible" && activeTask?.assistancePolicy.exposureLowersTrust ? <small className="learning-run-action-cost">使用后转为练习</small> : null}</span>
      </button>
    );
  };
  // request_hint 一律由那**一个**阶梯按钮代表：服务端按 hintLevels 签发了 1..N 个
  // 动作，若只把"下一个"放进快捷区、其余留在更多菜单里，用户看到的还是两个提示
  // 按钮（复盘 #11 的原始形态）。
  const moreActions = actionLinks.filter((action) =>
    action.kind !== "request_hint" && !quickActionKeys.has(actionKey(action)));
  const thisTime = thisTimeVerdicts(result ?? undefined);
  const feedback = result ? learningRunFeedback(result) : null;
  const runModeLabel = snapshot.publishedTargetEligibility === "eligible" && !hints.some((entry) => entry.downgraded)
    ? "正式挑战"
    : snapshot.publishedTargetEligibility === "blocked"
      ? "暂不计入掌握"
      : "练习关";

  return (
    <>
      <div ref={primaryContentRef} className="learning-run-primary-content" aria-hidden={pendingAction || pendingHintAction ? true : undefined}>
      {result || terminal ? (
        <>
        {result && feedback ? <LearningRunCeremony active={resultAcknowledgementActive} headline={feedback.headline} achievement={feedback.achievement} companionLine={companionFeedbackAllowed ? companionFeedbackLine : null} onStart={playPendingResultFeedback} onFinish={finishResultCeremony} /> : null}
        <section className="learning-run-result-board" inert={resultAcknowledgementActive || undefined} data-outcome={result ? result.outcome : "no_result"} data-tone={feedback?.tone ?? "neutral"} data-acknowledgement={resultAcknowledgementActive ? "active" : "idle"}>
          <header className="learning-run-arrival">
            <div className="learning-run-arrival__topline">
              <span>{result?.outcome === "practice_completed" ? "练习旅程完成" : "本次挑战记录"}</span>
              <span>{runOriginLabel(snapshot.originV2)} · {formatClock(clock.seconds)}</span>
            </div>
            {result && !SEALLESS_OUTCOMES.has(result.outcome) ? (
              <strong className="learning-run-arrival__seal">{feedback?.seal ?? outcomeSeal[result.outcome]}</strong>
            ) : (
              <strong className="learning-run-arrival__quiet">{result?.outcome === "declared_unable" ? "这次说了暂时不会" : "这次先放着"}</strong>
            )}
            <h2 ref={primaryHeadingRef} tabIndex={-1} data-surface-initial-focus="true">
              {feedback?.headline ?? "这次旅程没有形成新的学习结果"}
            </h2>
            <p className="learning-run-arrival__target">{snapshot.target.publicSummary}</p>
            <ObjectiveProgressBand segment={progressSegmentForOutcome(result?.outcome)} />
          </header>
          {feedback ? (
            <section className="learning-run-arrival-evidence" aria-label="本次学习反馈">
              <div><span>{feedback.tone === "neutral" ? "本次记录" : result?.outcome === "practice_completed" && !thisTime.coveredCount ? "本次判定" : "做对了什么"}</span><p>{feedback.achievement}</p></div>
              <div><span>还差什么</span><p>{feedback.gap}</p></div>
              <div><span>下一步</span><p>{nextChallengeLabel}</p></div>
            </section>
          ) : null}
          <article className="learning-run-result-report">
            <div className="learning-run-result-report__intro"><span>学习证据</span><h3>把这次收获带走</h3></div>
            {feedback && companionFeedbackAllowed ? (
              <div className="learning-run-result-companion" role="status">
                <Sparkles size={17} aria-hidden="true" />
                <p>
                  <strong>{feedback.tone === "success" ? "伴星回来庆祝了" : feedback.tone === "neutral" ? "这次线索已收好" : "伴星为这次进展点点头"}</strong>
                  <span>{companionFeedbackLine ?? feedback.achievement}</span>
                </p>
              </div>
            ) : null}
            {discoveryCard ? (
              <section className="learning-run-discovery" data-motif={discoveryCard.motif} aria-label="本次学习发现卡">
                <button
                  type="button"
                  className={`learning-run-discovery__card${discoveryRevealed ? " is-revealed" : ""}`}
                  onClick={() => setDiscoveryRevealed(true)}
                  aria-expanded={discoveryRevealed}
                >
                  {discoveryRevealed ? (
                    <span className="learning-run-discovery__front" aria-live="polite">
                      <small>{discoveryCard.eyebrow}</small>
                      <strong>{discoveryCard.title}</strong>
                      <span>{discoveryCard.detail}</span>
                      <em>来自本次真实评分证据 · 不计经验值</em>
                    </span>
                  ) : (
                    <span className="learning-run-discovery__back">
                      <Sparkles size={19} aria-hidden="true" />
                      <strong>翻开本次发现</strong>
                      <small>每轮从真实评分里抽一张，不编造奖励</small>
                    </span>
                  )}
                </button>
              </section>
            ) : null}
            {result ? (
              <div className="learning-run-result-evidence">
                {feedback && feedback.tone !== "neutral" ? (
                  <div data-role="proved-this-time">
                    <b>{result.outcome === "practice_completed" && !thisTime.coveredCount ? "本次判定" : "做对了什么"}</b>
                    {feedback.strengths.length ? (
                      <ul>{feedback.strengths.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                    ) : <p>{feedback.achievement}</p>}
                  </div>
                ) : null}
                <div>
                  <b>本次掌握</b>
                  <p>{provenLedgerText(result)}</p>
                </div>
                <div>
                  <b>还差什么</b>
                  {feedback?.improvements.length ? (
                    <ul>{feedback.improvements.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                  ) : <p>{feedback?.gap ?? "按下一步建议继续即可。"}</p>}
                </div>
                <div>
                  <b>学习状态变化</b>
                  <p>{scheduleImpactText(result.scheduleImpact)}</p>
                </div>
              </div>
            ) : (
              <div className="learning-run-result-evidence learning-run-result-evidence--single">
                <b>结束原因</b>
                <p>{terminalCopy[terminal!.reasonCode]}</p>
              </div>
            )}
            {result?.assessment?.rubricResults.length ? (
              <details className="learning-run-result-rubric">
                <summary>查看逐条判定 · {result.assessment.rubricResults.length} 条</summary>
                <ul>
                  {result.assessment.rubricResults.map((item) => (
                    <li key={item.rubricItemId} data-verdict={item.verdict}>
                      <span className="learning-run-result-rubric__head">
                        {facetLabels[item.facet] ?? item.facet} · {verdictLabels[item.verdict] ?? item.verdict}
                      </span>
                      <p>{item.userFacingReason}</p>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {result ? (
              <div className="learning-run-result-reveal">
                {targetReveal.kind === "idle" ? (
                  <button type="button" className="button" onClick={loadTargetReveal}>
                    看这次的答案与解释
                  </button>
                ) : null}
                {targetReveal.kind === "loading" ? <p className="small">正在读取答案…</p> : null}
                {targetReveal.kind === "ready" ? (
                  <div className="learning-run-result-reveal__body">
                    {lockedAnswer ? (
                      <section className="learning-run-result-comparison" aria-label="提交回答与参考要点对照">
                        <div>
                          <span>你提交的回答</span>
                          <p>{lockedAnswer}</p>
                        </div>
                        <div>
                          <span>这次想考的是</span>
                          <p className="learning-run-result-reveal__answer">{targetReveal.reveal.answerText}</p>
                        </div>
                      </section>
                    ) : (
                      <>
                        <h3 className="serif">这次想考的是</h3>
                        <p className="learning-run-result-reveal__answer">{targetReveal.reveal.answerText}</p>
                      </>
                    )}
                    {targetReveal.reveal.support.explanation ? <p>{targetReveal.reveal.support.explanation}</p> : null}
                    {targetReveal.reveal.support.boundary ? <p><b>边界</b>　{targetReveal.reveal.support.boundary}</p> : null}
                    {targetReveal.reveal.support.misconception ? <p><b>常见误解</b>　{targetReveal.reveal.support.misconception}</p> : null}
                    {targetReveal.reveal.support.workedExample ? <p><b>示例</b>　{targetReveal.reveal.support.workedExample}</p> : null}
                  </div>
                ) : null}
                {targetReveal.kind === "unavailable" ? <p className="small">{targetReveal.message}</p> : null}
              </div>
            ) : null}
            <section className="learning-run-next-step">
              <span>接下来</span>
              <strong>{nextChallengeLabel}</strong>
              <p>
                {result?.outcome === "declared_unable"
                  ? "说不会不扣任何东西：这条已排到最近的复习。回研究册看懂之后再来一次，就当第一次见。"
                  : returnContract?.status === "projection_pending"
                    ? "复习安排还在确认，回去之后会自己刷新到最新。"
                    : returnContract?.status === "ready"
                      ? "复习记录已经就绪，可以沿着当前路径继续。"
                      : "回去之后会接着你真正要练的那一条。"}
              </p>
            </section>
          </article>
          <div className="actions learning-run-result-actions">
            <button type="button" className="button primary" onClick={() => onExit({ route: exitRoute })}>
              <ArrowLeft size={15} aria-hidden="true" />{resultReturnLabel}
            </button>
            <button type="button" className="button" onClick={openObjective}>查看理解目标</button>
          </div>
        </section>
        </>
      ) : (
        <section className="learning-run-focus" data-phase={snapshot.phase} data-interaction={activeTask?.activeVariant.interaction.kind ?? "none"}>
          <header className="learning-run-focus__rail">
            <strong className="learning-run-focus__mode">{runModeLabel}</strong>
            <div className="learning-run-focus__target"><span>{activeTask ? `问题 ${activeTask.sequence} · ${interactionLabel(activeTask)}` : phaseLabels[processingPhase]}</span><strong title={snapshot.target.publicSummary}>{snapshot.target.publicSummary}</strong></div>
            <span className="learning-run-focus__eligibility">{eligibilityLabel(snapshot.publishedTargetEligibility)}</span>
            <div className="learning-run-focus__clock"><b>{formatClock(clock.seconds)}</b><small>{clock.paused ? "已暂停计时" : "专注时间"}</small></div>
          </header>
          <div className="learning-run-focus__body">
          <section className="learning-run-paper">
            <div className="learning-run-paper__scroll">
            <header className="learning-run-paper__question">
              <div>
                <span>{activeTask ? `${facetLabels[activeTask.intent] ?? activeTask.intent} · ${interactionLabel(activeTask)}` : phaseLabels[processingPhase]}</span>
                <small>{activeTask && snapshot.phase === "active" ? draftStatus : "进度"}</small>
              </div>
              {/* 旅程页的初始焦点落点。此前它只有纸外那颗「返回书房」胶囊，
                  于是键盘用户一进作答页，焦点停在"离开"上而不是题目上。 */}
              <h2 ref={primaryHeadingRef} tabIndex={-1} data-surface-initial-focus="true">
                {activeTask && snapshot.phase === "active" ? activeTask.prompt : processingHeadline}
              </h2>
              {activeTask && snapshot.phase === "active" ? <p>{activeTask.targetSummary}</p> : null}
            </header>
            {/* P21（B4）：求助面板从左侧导航栏搬进题面区。此前提示文字落在侧栏里
                207px 宽的一栏、9px 字号，而"看过提示这轮只计练习分"那句只有 **7.5px**
                ——全链路最小、却是最该看清的一句；求助信息和它要帮的题还隔着 250px。 */}
            {hints.length > 0 ? <div className="learning-run-hint learning-run-hint--shown" role="status">
              <Lightbulb size={15} aria-hidden="true" />
              {/*
                提示正文必须包在一个元素里（2026-09-21 实机截图）：
                `.learning-run-hint` 是 `auto minmax(0,1fr)` 两列网格，图标占第一列。
                先前提示层与「只计练习分」那句是**并列的两个网格项**，于是那句被自动
                放进第二行第一列，而 `auto` 列按它的 max-content 撑满整块面板，
                把提示层挤成十几像素宽的一条竖排字。包一层之后网格永远只有两个子项，
                第三行内容再怎么加也挤不到正文列。
              */}
              <div className="learning-run-hint__body">
                <ol className="learning-run-hint__levels">
                  {hints.map((entry) => (
                    <li key={entry.level}><span>{entry.text}</span></li>
                  ))}
                </ol>
                {hints.some((entry) => entry.downgraded) ? <small>看过提示之后，这张卡本轮只计练习分，不再计正式理解分。</small> : null}
              </div>
            </div> : null}
            <div className="learning-run-response">
              {canAnswerNow && activeTask ? (
                <InteractionEditor
                  task={activeTask}
                  value={editor ?? emptyEditor(activeTask)}
                  onChange={updateEditor}
                  restoredStructuredDraft={restoredStructuredDraft}
                  onStructuredReviewStateChange={setStructuredReviewReady}
                  onVoiceBusyChange={setVoiceEditorBusy}
                />
            ) : unresolvedResultFailure ? (
              <div role="alert">
                <strong className="title">暂时无法确认最终学习结果</strong>
                <p className="small">{unresolvedResultFailure.message}</p>
              </div>
            ) : resultState.kind === "pending" || ["assessing", "committing"].includes(snapshot.phase) ? (
              <div role="status" aria-live="polite" className="learning-run-assessing">
                <strong className="title">
                  <LoaderCircle className="run-spinner" size={15} aria-hidden="true" />
                  {processingHeadline}
                  <b className="learning-run-assessing__wait">已等待 {waitingSeconds}s</b>
                </strong>
                {lockedAnswer ? (
                  <blockquote className="learning-run-assessing__answer">
                    <span className="meta">你交上去的回答</span>
                    {lockedAnswer}
                  </blockquote>
                ) : null}
                <p className="small">
                  {resultQueryBudgetExhausted
                    ? "结果还在后台算，算好会自动回到这一页；这段时间不用再交一次，也不会被算成两次。"
                    : "可以先离开，不用等在这儿；结果没回来之前，这里不会先给结论。"}
                </p>
                {processingFailure ? <p className="small" role="alert">{processingFailure.message}</p> : null}
              </div>
            ) : snapshot.phase === "checkpoint" ? (
              /*
                2026-09-21 实机截图：这里原本只写「等待下一步 / 正在准备下一步。」，
                而 checkpoint 的下一步其实**是用户自己**——服务端签发的是
                「继续补充证据 / 结束但不改变复习」，它们却落在折叠的「更多选择」里，
                屏上只剩一个「安全退出」。用户的原话是"我就一直在这里等着？"。
                所以这一段（1）说清这一轮为什么停在这里，（2）把真正的下一步
                提到明面上（见下面 quickActions 里的 checkpointActions）。
              */
              <div role="status">
                <strong className="title">
                  {checkpointEvidenceGap
                    ? "这条还不能正式验证：缺原文证据"
                    : checkpointUnassessable
                      ? "这次没有形成可记录的结论"
                      : "这次只证明了一部分"}
                </strong>
                <p className="small">
                  {checkpointEvidenceGap
                    ? "这次判不出结论不是因为你答得不够好：这条目标的评分点还缺系统侧的原文证据，再补一段回答也补不上。可以结束这一轮，回到目标去看还缺什么。"
                    : checkpointUnassessable
                      ? "题目已经交上去了，但这一次判不出结论。你可以继续补充证据，或者结束这一轮——结束不会改变复习安排。"
                      : "还有几处没被证明。你可以继续补充证据，或者就此结束这一轮。"}
                </p>
                {failure ? <p className="small" role="alert">{failure.message}</p> : null}
              </div>
            ) : (
              <div role="status">
                <strong className="title">{activeTask ? activeTask.prompt : phaseLabels[snapshot.phase]}</strong>
                <p className="small">正在准备下一步。</p>
                {failure ? <p className="small" role="alert">{failure.message}</p> : null}
              </div>
            )}
          </div>
            </div>
          <footer className="learning-run-dock">
            <div className="learning-run-dock__row learning-run-dock__row--exit">
              <span className="learning-run-dock__status" role="status">
                {recovery
                  ? recoveryHeading
                  : activeTask && snapshot.phase === "active"
                    ? `回答不会自动提交 · ${draftStatus}`
                    : draftStatus}
              </span>
              <div className="actions">
                {exitActions.map((action) => quickButton(action))}
                {/* 复盘 #12：两个出口必须一眼看得见——「稍后再做」= 不想做，
                    「暂时不会」= 不会做（这是一种真实作答结果，会记为需要复习）。
                    此前它藏在「更多选择」里，和 skip_task / end 挤在同一个菜单。 */}
                {canSubmitUnable ? (
                  <button
                    type="button"
                    className="button"
                    disabled={busy || submitting}
                    onClick={() => void submit({ kind: "declared_unable", reasonCode: "cannot_recall" })}
                  >
                    <span>暂时不会</span>
                  </button>
                ) : null}
              </div>
            </div>
            <div className="learning-run-dock__row learning-run-dock__row--act">
              <div className="actions">
                {recovery ? (
                  <button type="button" className="button" disabled={resyncing} onClick={() => void resyncLearningRun(recovery)}>
                    {resyncing ? <LoaderCircle size={14} aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
                    {resyncing ? "正在同步…" : "同步当前状态"}
                  </button>
                ) : null}
                {!recovery && (resultQueryBudgetExhausted || processingFailure) ? (
                  <button type="button" className="button" disabled={resultQueryBusy} onClick={retryResultQuery}>
                    {resultQueryBusy ? "正在重新检查…" : "重新检查结果"}
                  </button>
                ) : null}
                {helpActions.map((action) => quickButton(action))}
                {moreActions.length > 0 ? (
                  <details className="learning-run-more">
                    <summary>更多选择</summary>
                    <div className="learning-run-more__menu">
                      {moreActions.map((action) => (
                        <button type="button" key={actionKey(action)} disabled={busy} onClick={() => void dispatchAction(action)}>
                          {actionIcon(action)}<span>{actionLabel(action)}</span>
                        </button>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
              {canAnswerNow ? (
                <button
                  type="button"
                  className="button primary"
                  disabled={busy
                    || submitting
                    || voiceEditorBusy
                    || !editor
                    || (editor.kind !== "declared_unable" && !payloadIsReady(editor, activeTask))
                    || (editor.kind === "ordering" && !orderingTouched)
                    || (editor.kind === "structured_bundle" && !structuredReviewReady)}
                  onClick={() => editor && void submit(editor)}
                >
                  {submitting ? <LoaderCircle size={15} aria-hidden="true" /> : <ArrowRight size={15} aria-hidden="true" />}
                  提交回答
                </button>
              ) : checkpointPrimaryAction ? (
                quickButton(checkpointPrimaryAction, true)
              ) : (
                <button type="button" className="button primary" onClick={() => onExit({ route: exitRoute })}>
                  <ArrowLeft size={15} aria-hidden="true" />{resultReturnLabel}
                </button>
              )}
            </div>
            {/* 说明条从 .actions 里搬出来单独占一行：它此前 flex-basis:100% 挤在按钮
                同一容器里换行，结果压在按钮身上（实测与「暂停」「给我一点提示」重叠），
                而且用的是给深色底的浅色字，落在奶油纸上几乎看不见。 */}
            {blockedSwitchIds.size > 0 ? (
              <p id="learning-run-switch-note" className="learning-run-switch-note" role="status">{`现在还不能改用语音讲解：${microphoneReason}`}</p>
            ) : null}
          </footer>
          </section>
          </div>
        </section>
      )}
      </div>

      {pendingHintAction ? (
        <div className="run-confirmation-backdrop run-hint-confirmation-backdrop">
          <div className="run-confirmation run-hint-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="learning-run-hint-confirmation-title" aria-describedby="learning-run-hint-confirmation-description" onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); closeHintConfirmation(); }
          }}>
            <Lightbulb size={22} aria-hidden="true" />
            <h2 id="learning-run-hint-confirmation-title" ref={hintConfirmationHeadingRef} tabIndex={-1}>看提示后，本轮会转为练习</h2>
            <p id="learning-run-hint-confirmation-description">提示可以帮你继续走，但这次回答不会写入正式掌握。你仍然可以完成练习，并在之后重新正式验证。</p>
            <div className="actions">
              <button type="button" className="button primary" onClick={() => void confirmHint()}>确认查看提示</button>
              <button type="button" className="button" onClick={closeHintConfirmation}>先自己想想</button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingAction ? (
        <div className="run-confirmation-backdrop">
          <div className="run-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="learning-run-confirmation-title" aria-describedby="learning-run-confirmation-description" onKeyDown={handleConfirmationKeyDown}>
            <h2 id="learning-run-confirmation-title" ref={confirmationHeadingRef} tabIndex={-1}>要现在停下来吗？</h2>
            {/* 只有 skip_run 与 end 需要确认（learning-run-v2-contracts.ts:58/69），两者都是
                「离开这次作答」，所以「草稿替你留着」对它们都成立。将来若加了别的可确认
                动作，这句要重新核——它承诺的是数据去向，不是氛围文案。 */}
            <p id="learning-run-confirmation-description">已经写下的内容会替你留着，回来可以从这里接着做。</p>
            <div className="actions">
              <button type="button" className="button primary" disabled={resyncing} onClick={() => void confirmPendingAction()}>先停下来</button>
              <button type="button" className="button" onClick={closeConfirmation}>我继续做</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

type LearningRunSurfaceProps = {
  /**
   * Optional shell hook. The task surface may pass its own run-exit handler
   * (the one that releases the FormalAssessmentGuard through main's route
   * resolver); when absent this surface resolves the same route itself.
   */
  readonly onExit?: (request?: { route: DesktopRouteV1; objectiveId?: string }) => void;
};

/** Pages 16/17 — one multi-format LearningRun workbench and its evidence report. */
export function LearningRunSurface({ onExit }: LearningRunSurfaceProps = {}) {
  const activeRunId = useRoomStore((state) => state.activeRunId);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const invoke = useRoomStore((state) => state.invoke);
  const [page, setPage] = useState<"assessment" | "result">("assessment");
  useHudPage(page);

  const exitRun = useCallback(async (request?: { route: DesktopRouteV1; objectiveId?: string }) => {
    if (onExit) {
      onExit(request);
      return;
    }
    if (!activeRunId || !window.ailearn) return;
    // Remove the run tree before asking main to resolve the return route: main
    // completes FormalAssessmentGuard release only after the renderer has
    // yielded a frame with the run context unmounted.
    setActiveRunId(null);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    let route: DesktopRouteV1 = request?.route ?? { kind: "review.queue" };
    try {
      const resolveResponse = await window.ailearn.navigation.resolve({
        meta: createRequestMeta(),
        route,
        learningRunId: activeRunId,
      });
      const resolved = unwrapGatewayResult(resolveResponse);
      if (resolved.current.scope !== "workspace") throw new Error("navigation did not resolve to the current workspace");
      const goResponse = await window.ailearn.navigation.go({
        meta: createRequestMeta(resolved.current.workspaceEpoch),
        route: resolved.current.route,
        entryKind: "user",
        learningRunId: activeRunId,
      });
      const navigated = unwrapGatewayResult(goResponse);
      if (navigated.current.scope !== "workspace") throw new Error("navigation did not commit to the current workspace");
      route = navigated.current.route;
    } catch {
      // A deleted, forbidden or unresolvable server target must not be
      // replayed by the renderer. Fall back to the review queue intent.
      route = { kind: "room.home" };
    }
    invoke(route.kind === "review.queue" ? "review" : "home");
    if (request?.objectiveId) {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      setActiveObjectiveId(request.objectiveId);
      invoke("open-objective");
    }
  }, [activeRunId, invoke, onExit, setActiveObjectiveId, setActiveRunId]);

  return (
    <HudPage page={page}>
      {activeRunId ? (
        <LearningRunBody runId={activeRunId} onExit={(request) => { void exitRun(request); }} onPageChange={setPage} />
      ) : (
        <SurfaceDataState
          kind="empty"
          message="还没有进行中的学习旅程"
          detail="从理解目标、复习队列或今日学习开始后，系统会冻结真实目标并在这里继续作答。"
        />
      )}
    </HudPage>
  );
}

export { phaseLabels as learningRunPhaseLabels };
