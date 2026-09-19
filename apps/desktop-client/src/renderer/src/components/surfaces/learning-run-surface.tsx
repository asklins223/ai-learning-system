import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  GripVertical,
  Lightbulb,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
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
import { SurfaceDataState, formatRelative } from "./surface-data";

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

const phaseLabels: Record<LearningRunPublicSnapshotV2["phase"], string> = {
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

const terminalCopy: Record<Extract<ResultState, { kind: "terminal" }>["value"]["reasonCode"], string> = {
  user_ended: "这次旅程已安全结束，没有生成新的学习结果。",
  runtime_cancelled: "这次旅程被取消，没有生成新的学习结果。",
  target_fingerprint_changed: "学习目标已经更新，本次旅程不能继续写入旧结果。",
  schedule_generation_changed: "复习安排已经变化，本次旅程不能继续消费旧安排。",
  permission_revoked: "当前账号已失去这条学习内容的权限。",
};

const outcomeSeal: Record<LearningRunOutcome, string> = {
  demonstrated: "已理解",
  partial: "部分理解",
  needs_repair: "需要修补",
  not_assessable: "无法评估",
  practice_completed: "练习完成",
  skipped: "已跳过",
  declared_unable: "已记录",
};

const outcomeHeadline: Record<LearningRunOutcome, string> = {
  demonstrated: "这次回答提供了足够证据",
  partial: "这次只证明了一部分",
  needs_repair: "这次结果显示仍有内容需要修补",
  not_assessable: "这次回答没有形成可评估的证据",
  practice_completed: "本次练习已经完成",
  skipped: "本次已跳过",
  declared_unable: "已记录暂时不会",
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
  if (impact.kind === "created") return `已创建复习安排，下次到期 ${formatRelative(impact.dueAt)}。`;
  if (impact.kind === "rescheduled") return `已重新安排复习，下次到期 ${formatRelative(impact.dueAt)}。`;
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

function payloadIsReady(payload: ArtifactPayload): boolean {
  switch (payload.kind) {
    case "voice":
      return payload.confirmedTranscript.trim().length > 0;
    case "text":
      return payload.text.trim().length > 0;
    case "ordering":
      return payload.orderedTokenIds.length > 1;
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
    case "skip_task":
      return { kind: action.kind, taskId: action.taskId };
    case "activate_followup":
      return { kind: action.kind, followupId: action.followupId };
    case "retry_assessment":
      return { kind: action.kind, assessmentId: action.assessmentId };
    case "end":
      return { kind: action.kind, abandonLockedEvidence: action.abandonLockedEvidence };
  }
}

function actionLabel(action: LearningRunAllowedActionV2): string {
  switch (action.kind) {
    case "pause": return "暂停";
    case "resume": return "继续旅程";
    case "switch_variant": return "换一种方式";
    case "request_hint": return action.level === 1 ? "给我一点提示" : `查看第 ${action.level} 级提示`;
    case "skip_task": return "跳过这一步";
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
    const addEdge = () => {
      if (!relationDraft.from || !relationDraft.to || relationDraft.from === relationDraft.to) return;
      onChange({ ...value, edges: [...value.edges, { fromNodeId: relationDraft.from, toNodeId: relationDraft.to, edgeKind: relationDraft.edgeKind }] });
      setRelationDraft((current) => ({ ...current, from: "", to: "" }));
    };
    return (
      <div className="run-part-editor">
        <div className="run-relation-controls">
          <select aria-label="关系起点" value={relationDraft.from} onChange={(event) => setRelationDraft((current) => ({ ...current, from: event.target.value }))}>
            <option value="">选择起点</option>
            {part.publicNodeIds.map((id) => <option key={id} value={id}>{indexedPublicLabel(labels, part.publicNodeIds, id, "节点")}</option>)}
          </select>
          <select aria-label="关系类型" value={relationDraft.edgeKind} onChange={(event) => setRelationDraft((current) => ({ ...current, edgeKind: event.target.value as RelationEdgeKindV1 }))}>
            {part.allowedEdgeKinds.map((kind) => <option key={kind} value={kind}>{relationKindLabel(kind)}</option>)}
          </select>
          <select aria-label="关系终点" value={relationDraft.to} onChange={(event) => setRelationDraft((current) => ({ ...current, to: event.target.value }))}>
            <option value="">选择终点</option>
            {part.publicNodeIds.map((id) => <option key={id} value={id}>{indexedPublicLabel(labels, part.publicNodeIds, id, "节点")}</option>)}
          </select>
          <button type="button" className="run-icon-button" onClick={addEdge} aria-label="加入关系"><Plus size={16} aria-hidden="true" /></button>
        </div>
        <ul className="run-relation-list">
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
                  aria-label="选择替换内容"
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
    );
  }

  return <p className="run-inline-error">当前结构化部分与任务版本不一致，请重新同步。</p>;
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
  const move = (index: number, offset: -1 | 1) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= value.length) return;
    const next = [...value];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    onChange(next);
  };

  return (
    <ol className="run-order-list" aria-label="可调整顺序的内容">
      {value.map((id, index) => (
        <li key={`${id}-${index}`}>
          <GripVertical size={16} aria-hidden="true" />
          <span>{indexedPublicLabel(labels, ids, id, "排序项")}</span>
          <span className="run-order-controls">
            <button type="button" className="run-icon-button" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`将${indexedPublicLabel(labels, ids, id, "排序项")}上移`}><ArrowUp size={14} aria-hidden="true" /></button>
            <button type="button" className="run-icon-button" disabled={index === value.length - 1} onClick={() => move(index, 1)} aria-label={`将${indexedPublicLabel(labels, ids, id, "排序项")}下移`}><ArrowDown size={14} aria-hidden="true" /></button>
          </span>
        </li>
      ))}
      {ids.length === 0 ? <li className="run-empty-row">服务端没有提供可排序内容。</li> : null}
    </ol>
  );
}

function InteractionEditor({
  task,
  value,
  onChange,
}: {
  readonly task: LearningTaskPublic;
  readonly value: ArtifactPayload;
  readonly onChange: (value: ArtifactPayload) => void;
}) {
  const interaction = task.activeVariant.interaction;

  if (interaction.kind === "voice_teachback") {
    return (
      <div className="run-blocker" role="status">
        <strong>当前设备没有可用的语音输入</strong>
        <span>请使用任务下方服务端授权的其他方式；客户端不会把文字伪装成语音证据。</span>
      </div>
    );
  }

  if (interaction.kind === "text_response" && value.kind === "text") {
    return (
      <label className="run-text-editor" style={{ display: "block", height: "100%" }}>
        <span className="sr-only">用自己的话回答</span>
        <textarea
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
    return (
      <div className="run-bundle-editor">
        {interaction.parts.map((part, index) => {
          const partValue = value.partAnswers[index];
          const labels = part.kind === "ordering"
            ? part.publicTokenLabels
            : part.kind === "relation"
              ? part.publicNodeLabels
              : part.kind === "repair"
                ? part.publicElementLabels
                : undefined;
          const replacementLabels = part.kind === "repair" ? part.replacementOptionLabels : undefined;
          return (
            <section className="run-bundle-part" key={part.partId}>
              <h4>第 {index + 1} 个证明片段</h4>
              <PartEditor
                part={part}
                value={partValue}
                labels={labels}
                replacementLabels={replacementLabels}
                onChange={(nextPart) => {
                  const next = [...value.partAnswers] as [StructuredPartAnswerV1] | [StructuredPartAnswerV1, StructuredPartAnswerV1];
                  next[index] = nextPart;
                  onChange({ ...value, partAnswers: next });
                }}
              />
            </section>
          );
        })}
      </div>
    );
  }

  return <p className="run-inline-error">当前 Task 与客户端可用的交互合同不一致，已停止提交。</p>;
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
  const queueHomeCompletion = useRoomStore((state) => state.queueHomeCompletion);
  const [snapshot, setSnapshot] = useState<LearningRunPublicSnapshotV2 | null>(null);
  const [editor, setEditor] = useState<ArtifactPayload | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [draftStatus, setDraftStatus] = useState("尚未输入");
  const [dirty, setDirty] = useState(false);
  const [draftWriteBusy, setDraftWriteBusy] = useState(false);
  const [draftWriteBlocked, setDraftWriteBlocked] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [resultState, setResultState] = useState<ResultState>({ kind: "idle" });
  const [targetReveal, setTargetReveal] = useState<TargetRevealState>({ kind: "idle" });
  const [returnContract, setReturnContract] = useState<LearningRunReturnContractV2 | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [failure, setFailure] = useState<PlayerFailure | null>(null);
  const [recovery, setRecovery] = useState<PlayerRecovery | null>(null);
  const [loading, setLoading] = useState(true);
  const [resyncing, setResyncing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingAction, setPendingAction] = useState<LearningRunAllowedActionV2 | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [resultPollTick, setResultPollTick] = useState(0);
  const [resultQueryBusy, setResultQueryBusy] = useState(false);
  const [resultQueryBudgetExhausted, setResultQueryBudgetExhausted] = useState(false);
  const [resultQueryFailure, setResultQueryFailure] = useState<PlayerFailure | null>(null);
  const [resultAcknowledgementActive, setResultAcknowledgementActive] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const runRequestFenceRef = useRef(createLearningRunRequestFence(runId));
  const snapshotRequestGenerationRef = useRef(0);
  const acceptedSnapshotRef = useRef<{ runId: string; runRevision: number; snapshotId: string } | null>(null);
  const resultPollGenerationRef = useRef(0);
  const resultAcknowledgementEligibleRef = useRef(false);
  const acknowledgedResultKeyRef = useRef<string | null>(null);
  const draftWriteGenerationRef = useRef(0);
  const epochRef = useRef<number | undefined>(undefined);
  const taskKeyRef = useRef<string | null>(null);
  const editorRevisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const activeSubscriptionRef = useRef<{ id: string; stop: () => void } | null>(null);
  const primaryHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const focusKeyRef = useRef<string | null>(null);
  const confirmationHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const confirmationReturnFocusRef = useRef<HTMLElement | null>(null);
  const recoveryHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const unavailableHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const primaryContentRef = useRef<HTMLDivElement | null>(null);
  const resultOutcome = resultState.kind === "result" ? resultState.value.result.outcome : null;
  const demonstratedResult = resultOutcome !== null && shouldConfirmCompanionForOutcome(resultOutcome);
  const showResult = resultState.kind === "result" || resultState.kind === "terminal";

  useEffect(() => {
    onPageChange(showResult ? "result" : "assessment");
  }, [onPageChange, showResult]);

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
    taskKeyRef.current = null;
    editorRevisionRef.current = 0;
    focusKeyRef.current = null;
    confirmationReturnFocusRef.current = null;
    resultAcknowledgementEligibleRef.current = false;
    acknowledgedResultKeyRef.current = null;
    snapshotRequestGenerationRef.current += 1;
    acceptedSnapshotRef.current = null;
    draftWriteGenerationRef.current += 1;
    setSnapshot(null);
    setEditor(null);
    setDraftWriteBusy(false);
    setDraftWriteBlocked(false);
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
    setHint(null);
    setActiveReviewTarget(null);
    setCompanionMoment("idle");
  }, [runId, setActiveReviewTarget, setCompanionMoment]);

  useEffect(() => {
    let active = true;
    if (!window.ailearn) return;
    void window.ailearn.capabilities.get({ meta: createRequestMeta(epochRef.current) })
      .then((response) => {
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        const capabilities = unwrapGatewayResult(response);
        if (active) setVoiceAvailable(capabilities.nativeCapabilities.asr === "available");
      })
      .catch(() => { if (active) setVoiceAvailable(false); });
    return () => { active = false; };
  }, [runId]);

  useEffect(() => {
    const content = primaryContentRef.current;
    if (!content) return;
    if (pendingAction) content.setAttribute("inert", "");
    else content.removeAttribute("inert");
    return () => content.removeAttribute("inert");
  }, [pendingAction]);

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
    if (focusKeyRef.current === focusKey || !primaryHeadingRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      focusKeyRef.current = focusKey;
      primaryHeadingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [resultQueryFailure, resultState, snapshot]);

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
    setHint(null);
    draftWriteGenerationRef.current += 1;
    setDraftWriteBusy(false);
    setDraftWriteBlocked(false);
    if (!preserveLocalInput) {
      editorRevisionRef.current = 0;
      setEditor(emptyEditor(activeTask));
      setDraftRevision(0);
      setDraftStatus("尚未输入");
      setDirty(false);
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
        setDraftStatus("已恢复服务端草稿");
        if (draft.payload) setEditor(editorFromDraft(draft.payload));
      } else {
        setDraftStatus("已读取服务端草稿；当前新输入仍待保存");
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
      if (!dirtyRef.current) setDraftStatus(kind === "draft" ? "已同步服务端草稿" : "已同步服务端学习状态");
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
          setDraftStatus("草稿结果未确认，请先同步当前状态");
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
      const canAcknowledge = resultAcknowledgementEligibleRef.current
        && shouldConfirmCompanionForOutcome(value.result.outcome);
      if (canAcknowledge && acknowledgedResultKeyRef.current !== resultKey) {
        acknowledgedResultKeyRef.current = resultKey;
        setResultAcknowledgementActive(true);
        // The one-shot confirmation is unlocked only by a trusted,
        // demonstrated result observed after processing in this mount. Keep
        // it pending until the cottage has fully returned to its idle phase;
        // this surface may unmount before that transition completes.
        queueHomeCompletion(`learning-result:${resultKey}`);
      } else if (!canAcknowledge) {
        // skipped / declared_unable / repair and restored terminal results are
        // deliberately neutral and never reuse the success presentation.
        setResultAcknowledgementActive(false);
        setCompanionMoment("idle");
      }
    } else {
      setResultState({ kind: "terminal", value });
      setResultAcknowledgementActive(false);
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
  }, [applyReturnContract, queueHomeCompletion, requestSnapshotRefresh, runId, setCompanionMoment]);

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
    setDirty(true);
    setDraftWriteBlocked(false);
    setDraftStatus(recovery === "draft" ? "先同步服务端草稿，再继续编辑" : "有未保存修改");
  };

  const submit = async (payload: ArtifactPayload) => {
    if (!snapshot?.activeTask || !window.ailearn || submitting || resyncing || recovery !== null) return;
    if (payload.kind !== "declared_unable" && !payloadIsReady(payload)) {
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
        setDraftStatus("上一提交结果未确认，请先同步当前状态");
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
      if (value.actionResult.kind === "hint_revealed") setHint(value.actionResult.text);
      if (action.kind === "end" || action.kind === "skip_run") setResultPollTick((value) => value + 1);
      const changedTask = action.kind === "switch_variant"
        || action.kind === "skip_task"
        || action.kind === "activate_followup";
      await loadSnapshot(changedTask);
    } catch (error) {
      if (!isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) return;
      const shouldResync = needsLearningRunResync(error);
      if (shouldResync) {
        setRecovery("action");
        setDraftStatus("上一动作结果未确认，请先同步当前状态");
      }
      setFailure({ message: gatewayErrorMessage(error), retryable: !shouldResync && error instanceof RendererGatewayError && error.retry !== "never" });
    } finally {
      if (isLearningRunRequestCurrent(requestToken, runRequestFenceRef.current)) {
        setActionBusy(false);
        setPendingAction(null);
      }
    }
  };

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

  const alternativeActions = useMemo(() => snapshot?.allowedActions.filter((action) => {
    if (action.kind !== "switch_variant") return false;
    const alternative = snapshot.activeTask?.availableAlternatives.find((candidate) => candidate.alternativeId === action.alternativeId);
    return voiceAvailable || alternative?.family !== "voice";
  }) ?? [], [snapshot?.activeTask?.availableAlternatives, snapshot?.allowedActions, voiceAvailable]);
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
    return <SurfaceDataState kind="loading" message="正在读取 LearningRun" detail="正在确认当前身份、工作区与这条旅程的服务端快照。" />;
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
  const exitDestinationLabel = exitRoute.kind === "review.queue" ? "回到复习队列" : "返回书房";
  const resultReturnLabel = returnContract?.status === "projection_pending" ? `同步中 · ${exitDestinationLabel}` : exitDestinationLabel;
  const recoveryHeading = recovery === "draft" ? "草稿版本需要同步" : "上一动作结果需要确认";
  const processingHeadline = processingPhase === "committing"
    ? "正在记录可信学习结果"
    : processingPhase === "assessing"
      ? "回答已锁定，正在评估"
      : phaseLabels[processingPhase];
  const busy = pendingAction !== null || actionBusy || resyncing || recovery !== null;
  const actionLinks = [
    ...alternativeActions,
    ...snapshot.allowedActions.filter((action) => ["pause", "resume", "request_hint", "activate_followup", "finish_current_evidence", "finish_without_commit", "retry_prepare", "retry_assessment", "retry_commit"].includes(action.kind)),
    ...snapshot.allowedActions.filter((action) => ["skip_task", "skip_run", "end"].includes(action.kind)),
  ];
  const switchAction = actionLinks.find((action) => action.kind === "switch_variant");
  const phaseAction = actionLinks.find((action) => action.kind === "pause" || action.kind === "resume");
  const hintAction = actionLinks
    .filter((action): action is Extract<LearningRunAllowedActionV2, { kind: "request_hint" }> => action.kind === "request_hint")
    .sort((left, right) => left.level - right.level)[0];
  const quickActions: LearningRunAllowedActionV2[] = [];
  if (switchAction) quickActions.push(switchAction);
  if (phaseAction) quickActions.push(phaseAction);
  if (hintAction) quickActions.push(hintAction);
  const quickActionKeys = new Set(quickActions.map(actionKey));
  const moreActions = actionLinks.filter((action) => !quickActionKeys.has(actionKey(action)));
  const activeSecondsProgress = Math.min(100, (snapshot.activeSecondsUsed / snapshot.timeBudgetSeconds) * 100);

  return (
    <>
      <div ref={primaryContentRef} className="learning-run-primary-content" aria-hidden={pendingAction ? true : undefined}>
      {result || terminal ? (
        <section className="learning-run-result-board" data-outcome={result ? result.outcome : "no_result"} data-acknowledgement={resultAcknowledgementActive ? "active" : "idle"}>
          <aside className="learning-run-result-summary" data-tone={demonstratedResult ? "confirmed" : "neutral"}>
            <span className="learning-run-result-summary__kicker">本次练习</span>
            <strong className="learning-run-result-summary__seal">{result ? outcomeSeal[result.outcome] : "未形成结果"}</strong>
            <p>{snapshot.target.publicSummary}</p>
            <dl>
              <div><dt>用时</dt><dd>{formatClock(snapshot.activeSecondsUsed)}</dd></div>
              <div><dt>已证明</dt><dd>{result ? `${result.demonstratedFacets.length} 项` : "—"}</dd></div>
              <div><dt>仍有缺口</dt><dd>{result ? `${result.gapFacets.length} 项` : "—"}</dd></div>
            </dl>
          </aside>
          <article className="learning-run-result-report">
            <header>
              <span>{runOriginLabel(snapshot.originV2)}</span>
              <h2 ref={primaryHeadingRef} tabIndex={-1}>
                {result ? outcomeHeadline[result.outcome] : "这次旅程没有形成新的学习结果"}
              </h2>
            </header>
            {result ? (
              <div className="learning-run-result-evidence">
                <div>
                  <b>已经证明</b>
                  <p>{facetText(result.demonstratedFacets, "这次还没有形成可公开的已证明部分。")}</p>
                </div>
                <div>
                  <b>还需补上</b>
                  <p>{facetText(result.gapFacets, "这次没有留下待补的理解缺口。")}</p>
                </div>
                <div>
                  <b>复习安排</b>
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
              <div className="learning-run-result-rubric">
                <b>逐条判定</b>
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
              </div>
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
                    <h3 className="serif">这次想考的是</h3>
                    <p className="learning-run-result-reveal__answer">{targetReveal.reveal.answerText}</p>
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
              <strong>{
                result?.outcome === "declared_unable"
                  ? "先回研究册把这条看懂，再回来验证"
                  : result && result.gapFacets.length
                    ? `先补上「${facetText(result.gapFacets.slice(0, 1), "")}」`
                    : returnTargetLabel(returnTarget)
              }</strong>
              <p>
                {result?.outcome === "declared_unable"
                  ? "说不会不扣任何东西：这条已排到最近的复习。回研究册看懂之后再来一次，就当第一次见。"
                  : returnContract?.status === "projection_pending"
                    ? "复习记录正在同步；返回后会继续刷新真实进度。"
                    : returnContract?.status === "ready"
                      ? "复习记录已经就绪，可以沿着当前路径继续。"
                      : "返回后会按服务端给出的真实目标继续。"}
              </p>
            </section>
            <div className="actions learning-run-result-actions">
              <button type="button" className="button primary" onClick={() => onExit({ route: exitRoute })}>
                <ArrowLeft size={15} aria-hidden="true" />{resultReturnLabel}
              </button>
              <button type="button" className="button" onClick={openObjective}>查看理解目标</button>
            </div>
          </article>
        </section>
      ) : (
        <section className="learning-run-workbench" data-phase={snapshot.phase} data-interaction={activeTask?.activeVariant.interaction.kind ?? "none"}>
          <aside className="learning-run-journey">
            <div className="learning-run-journey__state"><i aria-hidden="true" />{phaseLabels[snapshot.phase]}</div>
            <span className="learning-run-journey__kicker">{runOriginLabel(snapshot.originV2)}</span>
            <h2 title={snapshot.target.publicSummary}>{snapshot.target.publicSummary}</h2>
            <dl>
              <div><dt>当前位置</dt><dd>{activeTask ? `问题 ${activeTask.sequence}` : phaseLabels[processingPhase]}</dd></div>
              <div><dt>作答方式</dt><dd>{activeTask ? interactionLabel(activeTask) : "等待下一步"}</dd></div>
              <div><dt>证据范围</dt><dd>{eligibilityLabel(snapshot.publishedTargetEligibility)}</dd></div>
            </dl>
            <div className="learning-run-clock">
              <div><span>专注时间</span><b>{formatClock(snapshot.activeSecondsUsed)}</b></div>
              <div className="learning-run-clock__track" aria-label={`已使用 ${formatClock(snapshot.activeSecondsUsed)}`}><i style={{ width: `${activeSecondsProgress}%` }} /></div>
            </div>
            <div className={`learning-run-hint${hint ? " learning-run-hint--shown" : ""}`} role={hint ? "status" : undefined}>
              <Lightbulb size={15} aria-hidden="true" />
              <span>{hint ?? "卡住时可以先要一条提示，或换一种作答方式。"}</span>
            </div>
          </aside>
          <section className="learning-run-stage">
            <header className="learning-run-stage__header">
              <div>
                <span>{activeTask ? `${facetLabels[activeTask.intent] ?? activeTask.intent} · ${interactionLabel(activeTask)}` : phaseLabels[processingPhase]}</span>
                <small>{activeTask && snapshot.phase === "active" ? draftStatus : "服务端状态"}</small>
              </div>
              <h2 ref={primaryHeadingRef} tabIndex={-1}>
                {activeTask && snapshot.phase === "active" ? activeTask.prompt : processingHeadline}
              </h2>
              {activeTask && snapshot.phase === "active" ? <p>{activeTask.targetSummary}</p> : null}
            </header>
            <div className="learning-run-response">
              {activeTask && snapshot.phase === "active" ? (
                <InteractionEditor task={activeTask} value={editor ?? emptyEditor(activeTask)} onChange={updateEditor} />
            ) : unresolvedResultFailure ? (
              <div role="alert">
                <strong className="title">暂时无法确认最终学习结果</strong>
                <p className="small">{unresolvedResultFailure.message}</p>
              </div>
            ) : resultState.kind === "pending" || ["assessing", "committing"].includes(snapshot.phase) ? (
              <div role="status" aria-live="polite">
                <strong className="title">{processingHeadline}</strong>
                <p className="small">你可以暂时离开；客户端只会在收到真实结果后显示复习影响。</p>
                {processingFailure ? <p className="small" role="alert">{processingFailure.message}</p> : null}
              </div>
            ) : (
              <div role="status">
                <strong className="title">{activeTask ? activeTask.prompt : phaseLabels[snapshot.phase]}</strong>
                <p className="small">服务端正在准备下一个可执行动作。</p>
                {failure ? <p className="small" role="alert">{failure.message}</p> : null}
              </div>
            )}
          </div>
          <footer className="learning-run-dock">
            <span className="learning-run-dock__status" role="status">
              {recovery
                ? recoveryHeading
                : activeTask && snapshot.phase === "active"
                  ? `回答不会自动提交 · ${draftStatus}`
                  : draftStatus}
            </span>
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
              {quickActions.map((action) => (
                <button
                  type="button"
                  key={actionKey(action)}
                  className="button"
                  disabled={busy}
                  onClick={() => void dispatchAction(action)}
                >
                  {actionIcon(action)}
                  {actionLabel(action)}
                </button>
              ))}
              {moreActions.length > 0 || canSubmitUnable ? (
                <details className="learning-run-more">
                  <summary>更多选择</summary>
                  <div className="learning-run-more__menu">
                    {moreActions.map((action) => (
                      <button type="button" key={actionKey(action)} disabled={busy} onClick={() => void dispatchAction(action)}>
                        {actionIcon(action)}<span>{actionLabel(action)}</span>
                      </button>
                    ))}
                    {canSubmitUnable ? (
                      <button type="button" disabled={busy || submitting} onClick={() => void submit({ kind: "declared_unable", reasonCode: "cannot_recall" })}>
                        <span>暂时不会</span>
                      </button>
                    ) : null}
                  </div>
                </details>
              ) : null}
              {activeTask && snapshot.phase === "active" ? (
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || submitting || !editor || (editor.kind !== "declared_unable" && !payloadIsReady(editor))}
                  onClick={() => editor && void submit(editor)}
                >
                  {submitting ? <LoaderCircle size={15} aria-hidden="true" /> : <ArrowRight size={15} aria-hidden="true" />}
                  提交回答
                </button>
              ) : (
                <button type="button" className="button primary" onClick={() => onExit({ route: exitRoute })}>
                  <ArrowLeft size={15} aria-hidden="true" />{resultReturnLabel}
                </button>
              )}
            </div>
          </footer>
          </section>
        </section>
      )}
      </div>

      {pendingAction ? (
        <div className="run-confirmation-backdrop">
          <div className="run-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="learning-run-confirmation-title" aria-describedby="learning-run-confirmation-description" onKeyDown={handleConfirmationKeyDown}>
            <h2 id="learning-run-confirmation-title" ref={confirmationHeadingRef} tabIndex={-1}>确认这项学习旅程操作</h2>
            <p id="learning-run-confirmation-description">确定要{actionLabel(pendingAction)}吗？当前已输入内容会按服务端合同处理。</p>
            <div className="actions">
              <button type="button" className="button primary" disabled={resyncing} onClick={() => void confirmPendingAction()}>确认</button>
              <button type="button" className="button" onClick={closeConfirmation}>取消</button>
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
