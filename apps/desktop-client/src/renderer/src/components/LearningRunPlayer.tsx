import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Clock3,
  GripVertical,
  Lightbulb,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RotateCcw,
  SkipForward,
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
} from "@ailearn/shared/learning-run-v2-contracts";
import type { DesktopLearningRunActionRequestV2 } from "@ailearn/shared/desktop-ipc-contracts";
import {
  createCommandId,
  createRequestMeta,
  gatewayErrorMessage,
  RendererGatewayError,
  unwrapGatewayResult,
} from "../app/desktop-client";
import { useRoomStore } from "../app/room-store";
import { reviewTargetFromReturnContract } from "./review-focus";
import { resultPollDelayMs } from "./result-polling";
import { indexedPublicLabel } from "./learning-run-labels";
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
} from "./learning-run-result-policy";
import {
  ACTIVITY_LEASE_INTERVAL_MS,
  buildActivityLeaseWindow,
  isActivityLeaseEligible,
  type ActivityLeaseWindow,
} from "./learning-run-activity-lease";

gsap.registerPlugin(useGSAP);

type PlayerProps = {
  readonly runId: string;
  readonly onExit: () => void;
};

type ResultState =
  | { kind: "idle" }
  | { kind: "pending"; phase: Extract<GetLearningRunResultResponseV2, { status: "pending" }>["phase"] }
  | { kind: "result"; value: Extract<GetLearningRunResultResponseV2, { status: "learning_result" }> }
  | { kind: "terminal"; value: Extract<GetLearningRunResultResponseV2, { status: "terminal_without_result" }> };

type PlayerFailure = {
  readonly message: string;
  readonly retryable: boolean;
};

type PlayerRecovery = "draft" | "submit" | "action";

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

const terminalCopy: Record<Extract<ResultState, { kind: "terminal" }>['value']["reasonCode"], string> = {
  user_ended: "这次旅程已安全结束，没有生成新的学习结果。",
  runtime_cancelled: "这次旅程被取消，没有生成新的学习结果。",
  target_fingerprint_changed: "学习目标已经更新，本次旅程不能继续写入旧结果。",
  schedule_generation_changed: "复习安排已经变化，本次旅程不能继续消费旧安排。",
  permission_revoked: "当前账号已失去这条学习内容的权限。",
};

function interactionRef(taskId: string, part = "main"): string {
  return `desktop-player-${taskId}-${part}`;
}

function emptyPartAnswer(part: StructuredPartPublicV1): StructuredPartAnswerV1 {
  switch (part.kind) {
    case "ordering":
      return { kind: "ordering", partId: part.partId, orderedTokenIds: [...part.publicTokenIds] };
    case "relation":
      return { kind: "relation", partId: part.partId, edges: [] };
    case "repair":
      return { kind: "repair", partId: part.partId, operations: [] };
    case "scenario":
      return { kind: "scenario", partId: part.partId, decisions: [] };
    case "choice":
      return { kind: "choice", partId: part.partId, selectedOptionIds: [] };
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
    case "scenario":
      return { kind: "scenario", decisions: [] };
    case "choice_with_rationale":
      return { kind: "choice", selectedOptionIds: [] };
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
    case "scenario":
      return payload.decisions.length > 0;
    case "choice":
      return payload.selectedOptionIds.length > 0;
    case "structured_bundle":
      return payload.partAnswers.every((part) => {
        switch (part.kind) {
          case "ordering": return part.orderedTokenIds.length > 1;
          case "relation": return part.edges.length > 0;
          case "repair": return part.operations.length > 0;
          case "scenario": return part.decisions.length > 0;
          case "choice": return part.selectedOptionIds.length > 0;
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
      if (op === "move") next.push({ op: "move", elementId, toIndex: 0 });
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
            </div>
          );
        })}
      </div>
    );
  }

  if (part.kind === "scenario" && value.kind === "scenario") {
    return (
      <div className="run-scenario-list">
        {part.steps.map((step) => {
          const decision = value.decisions.find((candidate) => candidate.stepId === step.stepId);
          return (
            <label key={step.stepId} className="run-choice-row">
              <span>{indexedPublicLabel(labels, part.steps.map((candidate) => candidate.stepId), step.stepId, "步骤")}</span>
              <select aria-label={`${indexedPublicLabel(labels, part.steps.map((candidate) => candidate.stepId), step.stepId, "步骤")}的选择`} value={decision?.optionId ?? ""} onChange={(event) => onChange({ ...value, decisions: [...value.decisions.filter((candidate) => candidate.stepId !== step.stepId), { stepId: step.stepId, optionId: event.target.value }] })}>
                <option value="">请选择</option>
                {step.publicOptionIds.map((optionId) => <option key={optionId} value={optionId}>{indexedPublicLabel(labels, step.publicOptionIds, optionId, "选项")}</option>)}
              </select>
            </label>
          );
        })}
      </div>
    );
  }

  if (part.kind === "choice" && value.kind === "choice") {
    return (
      <div className="run-choice-list">
        {part.publicOptionIds.map((optionId) => {
          const checked = value.selectedOptionIds.includes(optionId);
          return (
            <label className={`run-choice-option${checked ? " run-choice-option--selected" : ""}`} key={optionId}>
              <input type="checkbox" checked={checked} onChange={() => onChange({ ...value, selectedOptionIds: checked ? value.selectedOptionIds.filter((id) => id !== optionId) : [...value.selectedOptionIds, optionId] })} />
              <span>{indexedPublicLabel(labels, part.publicOptionIds, optionId, "选项")}</span>
            </label>
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
      <label className="run-text-editor">
        <span>用自己的话回答</span>
        <textarea maxLength={interaction.maxChars} value={value.text} onChange={(event) => onChange({ ...value, text: event.target.value })} placeholder="先说出你的判断，再说明依据…" />
        <small>{value.text.length} / {interaction.maxChars}</small>
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

  if (interaction.kind === "scenario" && value.kind === "scenario") {
    return <PartEditor part={{ kind: "scenario", partId: "main", steps: interaction.steps, partTrustCeiling: "practice_only", qualificationProfileHash: null }} value={{ kind: "scenario", partId: "main", decisions: value.decisions }} labels={undefined} onChange={(partValue) => partValue.kind === "scenario" && onChange({ ...value, decisions: partValue.decisions })} />;
  }

  if (interaction.kind === "choice_with_rationale" && value.kind === "choice") {
    return (
      <div className="run-choice-list">
        {interaction.publicOptionIds.map((optionId) => {
          const checked = value.selectedOptionIds.includes(optionId);
          return (
            <label className={`run-choice-option${checked ? " run-choice-option--selected" : ""}`} key={optionId}>
              <input type="checkbox" checked={checked} onChange={() => onChange({ ...value, selectedOptionIds: checked ? value.selectedOptionIds.filter((id) => id !== optionId) : [...value.selectedOptionIds, optionId] })} />
              <span>{indexedPublicLabel(undefined, interaction.publicOptionIds, optionId, "选项")}</span>
            </label>
          );
        })}
        {interaction.rationaleModes.includes("text") ? (
          <label className="run-text-editor run-text-editor--compact">
            <span>补充理由（可选）</span>
            <textarea value={value.rationale?.kind === "text" ? value.rationale.text : ""} onChange={(event) => onChange({ ...value, rationale: event.target.value ? { kind: "text", text: event.target.value } : undefined })} />
          </label>
        ) : null}
      </div>
    );
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

export function LearningRunPlayer({ runId, onExit }: PlayerProps) {
  const setActiveReviewTarget = useRoomStore((state) => state.setActiveReviewTarget);
  const setCompanionMoment = useRoomStore((state) => state.setCompanionMoment);
  const motionMode = useRoomStore((state) => state.motionMode);
  const [snapshot, setSnapshot] = useState<LearningRunPublicSnapshotV2 | null>(null);
  const [editor, setEditor] = useState<ArtifactPayload | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [draftStatus, setDraftStatus] = useState("尚未输入");
  const [dirty, setDirty] = useState(false);
  const [draftWriteBusy, setDraftWriteBusy] = useState(false);
  const [draftWriteBlocked, setDraftWriteBlocked] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [resultState, setResultState] = useState<ResultState>({ kind: "idle" });
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
  const activeSubscriptionRef = useRef<{ id: string; stop: () => void } | null>(null);
  const primaryHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const focusKeyRef = useRef<string | null>(null);
  const confirmationHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const confirmationReturnFocusRef = useRef<HTMLElement | null>(null);
  const recoveryHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const unavailableHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const resultMotionRef = useRef<HTMLDivElement | null>(null);
  const resultOutcome = resultState.kind === "result" ? resultState.value.result.outcome : null;
  const demonstratedResult = resultOutcome !== null && shouldConfirmCompanionForOutcome(resultOutcome);
  const resultAcknowledgementMotion = demonstratedResult && resultAcknowledgementActive;

  useLayoutEffect(() => {
    const activeFence = activateLearningRunRequestFence(runRequestFenceRef.current, runId);
    runRequestFenceRef.current = activeFence;
    const mountedToken = captureLearningRunRequest(activeFence);

    return () => {
      if (isLearningRunRequestCurrent(mountedToken, runRequestFenceRef.current)) {
        runRequestFenceRef.current = deactivateLearningRunRequestFence(runRequestFenceRef.current);
      }
      // Clear the global presentation during the same commit that switches or
      // unmounts the Player. A late response from this run cannot revive it.
      setCompanionMoment("idle");
    };
  }, [runId, setCompanionMoment]);

  useGSAP(() => {
    const marks = resultMotionRef.current?.querySelectorAll<HTMLElement>(".run-result__ink-mark");
    if (!marks?.length) return;
    gsap.killTweensOf(marks);
    gsap.set(marks, { autoAlpha: 0, scale: 0.45, transformOrigin: "50% 50%" });
    if (!resultAcknowledgementMotion || motionMode === "off") return;
    const timeline = gsap.timeline({ defaults: { ease: "power2.out" } });
    timeline.to(marks, { autoAlpha: 0.54, scale: 1, duration: motionMode === "lite" ? 0.22 : 0.38, stagger: 0.08 })
      .to(marks, { autoAlpha: 0, scale: 1.35, duration: motionMode === "lite" ? 0.24 : 0.5, stagger: 0.08 }, "-=0.1");
    return () => timeline.kill();
  }, { scope: resultMotionRef, dependencies: [motionMode, resultAcknowledgementMotion, resultOutcome] });

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
    setActiveReviewTarget(null);
    setCompanionMoment("idle");
  }, [runId, setActiveReviewTarget, setCompanionMoment]);

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
    if (forceTaskResync) taskKeyRef.current = null;
    const taskKey = `${activeTask.taskId}:${activeTask.revision}:${activeTask.activeVariant.variantId}:${activeTask.activeVariant.revision}`;
    if (taskKeyRef.current === taskKey) return true;
    taskKeyRef.current = taskKey;
    draftWriteGenerationRef.current += 1;
    setDraftWriteBusy(false);
    setDraftWriteBlocked(false);
    editorRevisionRef.current = 0;
    setEditor(emptyEditor(activeTask));
    setDraftRevision(0);
    setDraftStatus("尚未输入");
    setDirty(false);
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
      if (editorRevisionMatchesRequest(draftEditorRevision, editorRevisionRef.current)) {
        setDraftStatus("已恢复服务端草稿");
        if (draft.payload) setEditor(editorFromDraft(draft.payload));
      } else {
        setDraftStatus("已读取服务端草稿；当前新输入仍待保存");
      }
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
      setDraftStatus(kind === "draft" ? "已同步服务端草稿" : "已同步服务端学习状态");
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
        // Re-read the server snapshot so the UI shows the authoritative
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
        // demonstrated result observed after processing in this mount.
        setCompanionMoment("confirm");
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
  }, [applyReturnContract, requestSnapshotRefresh, runId, setCompanionMoment]);

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
      setSnapshot(value.snapshot);
      setFailure(null);
      setRecovery(null);
      if (value.actionResult.kind === "hint_revealed") setHint(value.actionResult.text);
      if (action.kind === "end" || action.kind === "skip_run") setResultPollTick((value) => value + 1);
      requestSnapshotRefresh();
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

  const alternativeActions = useMemo(() => snapshot?.allowedActions.filter((action) => action.kind === "switch_variant") ?? [], [snapshot?.allowedActions]);
  const canSubmitUnable = snapshot?.activeTask !== null && snapshot?.phase === "active";
  const retryResultQuery = () => {
    setFailure(null);
    setResultQueryFailure(null);
    setResultQueryBudgetExhausted(false);
    setResultPollTick((value) => value + 1);
  };

  if (loading && !snapshot) {
    return <div className="run-player run-player--loading task-artifact" role="status"><LoaderCircle className="run-spinner" size={22} aria-hidden="true" /><span>正在读取 LearningRun 快照…</span></div>;
  }

  if (failure && !snapshot) {
    return (
      <div className="run-player run-player--error task-artifact" role="alert">
        <h1 ref={unavailableHeadingRef} tabIndex={-1}>暂时无法打开这条学习旅程</h1>
        <p>{failure.message}</p>
        {failure.retryable ? <button type="button" className="surface-primary" onClick={requestSnapshotRefresh}><RotateCcw size={16} aria-hidden="true" />重新同步</button> : null}
        <button type="button" className="text-action" onClick={onExit}>返回复习队列</button>
      </div>
    );
  }

  if (!snapshot) return null;

  const activeTask = snapshot.activeTask;
  const result = resultState.kind === "result" ? resultState.value.result : null;
  const terminal = resultState.kind === "terminal" ? resultState.value : null;
  const unresolvedResultFailure = resultState.kind === "idle"
    && snapshotRequiresResolvedLearningResult(snapshot.phase)
    ? resultQueryFailure
    : null;
  const processingFailure = resultQueryFailure ?? failure;
  const processingPhase = resultState.kind === "pending" ? resultState.phase : snapshot.phase;
  const resultReturnLabel = returnContract?.status === "projection_pending" ? "复习记录同步中" : returnContract?.status === "ready" ? "返回并刷新复习" : "返回复习队列";
  const recoveryHeading = recovery === "draft" ? "草稿版本需要同步" : "上一动作结果需要确认";
  const recoveryDescription = recovery === "draft"
    ? "服务端可能已经保存了草稿，或已有更新版本。先读取最新草稿；客户端不会重复写入。"
    : "服务端可能已经接受了提交或操作。先读取当前快照并查询结果；客户端不会盲目重放。";

  return (
    <div className="run-player task-artifact" data-phase={snapshot.phase}>
      <div className="run-player__meta">
        <span className="run-phase"><span className="run-phase__dot" aria-hidden="true" />{phaseLabels[snapshot.phase]}</span>
        <span><Clock3 size={14} aria-hidden="true" />服务端已计入 {snapshot.activeSecondsUsed} 秒</span>
      </div>
      <div className="run-player__target">
        <span>当前学习目标</span>
        <p>{snapshot.target.publicSummary}</p>
      </div>

      {recovery ? (
        <div className="run-resync" role="alert">
          <h2 ref={recoveryHeadingRef} tabIndex={-1}>{recoveryHeading}</h2>
          <span>{recoveryDescription}</span>
          <button type="button" className="surface-secondary" disabled={resyncing} onClick={() => void resyncLearningRun(recovery)}>
            {resyncing ? <LoaderCircle className="run-spinner" size={15} aria-hidden="true" /> : <RotateCcw size={15} aria-hidden="true" />}
            {resyncing ? "正在同步…" : "同步当前状态"}
          </button>
        </div>
      ) : null}

      {result ? (
        <div className={`run-result${demonstratedResult ? "" : " run-result--neutral"}`} role="status" aria-live="polite" tabIndex={-1}>
          {resultAcknowledgementMotion ? (
            <div ref={resultMotionRef} className="run-result__ink-bloom" aria-hidden="true">
              <span className="run-result__ink-mark run-result__ink-mark--one" />
              <span className="run-result__ink-mark run-result__ink-mark--two" />
              <span className="run-result__ink-mark run-result__ink-mark--three" />
            </div>
          ) : null}
          <div className="run-result__mark">{demonstratedResult ? <Check size={20} aria-hidden="true" /> : <SkipForward size={20} aria-hidden="true" />}</div>
          <h1 ref={primaryHeadingRef} tabIndex={-1}>{result.outcome === "demonstrated" ? "这次回答提供了足够证据" : result.outcome === "partial" ? "这次只证明了一部分" : result.outcome === "needs_repair" ? "这次结果显示仍有内容需要修补" : result.outcome === "declared_unable" ? "已记录暂时不会" : result.outcome === "skipped" ? "本次已跳过" : "本次练习已完成"}</h1>
          <p>结果来自服务端 Assessment / Commit；客户端不根据字数或本地状态推断掌握。</p>
          <div className="run-result__columns">
            <div><strong>已证明</strong><span>{result.demonstratedFacets.length ? result.demonstratedFacets.join("、") : "暂无公开 facet"}</span></div>
            <div><strong>仍需关注</strong><span>{result.gapFacets.length ? result.gapFacets.join("、") : "暂无公开缺口"}</span></div>
            <div><strong>复习影响</strong><span>{result.scheduleImpact.kind === "created" ? "已创建复习安排" : result.scheduleImpact.kind === "rescheduled" ? "已重新安排复习" : "本次没有改变复习安排"}</span></div>
          </div>
          <button type="button" className="surface-primary" onClick={onExit}><ArrowLeft size={16} aria-hidden="true" />{resultReturnLabel}</button>
        </div>
      ) : terminal ? (
        <div className="run-result run-result--terminal" role="status" aria-live="polite">
          <div className="run-result__mark"><SkipForward size={20} aria-hidden="true" /></div>
          <h1 ref={primaryHeadingRef} tabIndex={-1}>这次旅程没有形成新的学习结果</h1>
          <p>{terminalCopy[terminal.reasonCode]}</p>
          <button type="button" className="surface-primary" onClick={onExit}><ArrowLeft size={16} aria-hidden="true" />返回复习队列</button>
        </div>
      ) : unresolvedResultFailure ? (
        <div className="run-processing" role="alert">
          <RotateCcw size={22} aria-hidden="true" />
          <h1 ref={primaryHeadingRef} tabIndex={-1}>暂时无法确认最终学习结果</h1>
          <p>{unresolvedResultFailure.message}</p>
          <div className="run-processing__actions">
            <button type="button" className="surface-primary" disabled={resultQueryBusy} onClick={retryResultQuery}>
              {resultQueryBusy ? <LoaderCircle className="run-spinner" size={16} aria-hidden="true" /> : <RotateCcw size={16} aria-hidden="true" />}
              {resultQueryBusy ? "正在重新检查…" : "重新检查结果"}
            </button>
            <button type="button" className="surface-secondary" onClick={onExit}>先回到复习队列</button>
          </div>
        </div>
      ) : resultState.kind === "pending" || ["assessing", "committing"].includes(snapshot.phase) ? (
        <div className="run-processing" role="status" aria-live="polite">
          <LoaderCircle className="run-spinner" size={23} aria-hidden="true" />
          <h1 ref={primaryHeadingRef} tabIndex={-1}>{processingPhase === "committing" ? "正在记录可信学习结果" : processingPhase === "assessing" ? "回答已锁定，正在评估" : "正在确认可信学习结果"}</h1>
          <p>你可以暂时离开；客户端只会在收到真实结果后显示复习影响。</p>
          {processingFailure ? <p className="run-inline-error" role="alert">{processingFailure.message}</p> : null}
          <div className="run-processing__actions">
            {resultQueryBudgetExhausted || processingFailure ? (
              <button
                type="button"
                className="surface-secondary"
                disabled={resultQueryBusy}
                onClick={retryResultQuery}
              >
                {resultQueryBusy ? "正在重新检查…" : "重新检查结果"}
              </button>
            ) : null}
            <button type="button" className="surface-secondary" onClick={onExit}>先回到复习队列</button>
          </div>
        </div>
      ) : activeTask ? (
        <>
          <div className="run-task-heading">
            <span>第 {activeTask.sequence} 个动作 · {activeTask.intent}</span>
            <h1 ref={primaryHeadingRef} tabIndex={-1}>{activeTask.prompt}</h1>
            <p>{activeTask.targetSummary}</p>
          </div>
          <InteractionEditor task={activeTask} value={editor ?? emptyEditor(activeTask)} onChange={updateEditor} />
          {hint ? <div className="run-hint" role="status"><Lightbulb size={16} aria-hidden="true" /><span>{hint}</span></div> : null}
          {failure ? <p className="run-inline-error" role="alert">{failure.message}</p> : null}
          <div className="run-submit-row">
            <button type="button" className="surface-primary" disabled={pendingAction !== null || submitting || resyncing || recovery !== null || snapshot.phase !== "active" || !editor || (editor.kind !== "declared_unable" && !payloadIsReady(editor))} onClick={() => editor && submit(editor)}>
              {submitting ? <LoaderCircle className="run-spinner" size={16} aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />}提交这次证据
            </button>
            {canSubmitUnable ? <button type="button" className="text-action" disabled={pendingAction !== null || submitting || resyncing || recovery !== null} onClick={() => submit({ kind: "declared_unable", reasonCode: "cannot_recall" })}>我暂时不会</button> : null}
          </div>
          {draftStatus ? <p className="run-draft-status" role="status">{draftStatus}</p> : null}
        </>
      ) : (
        <div className="run-processing" role="status">
          <LoaderCircle className="run-spinner" size={22} aria-hidden="true" />
          <h1 ref={primaryHeadingRef} tabIndex={-1}>{phaseLabels[snapshot.phase]}</h1>
          <p>服务端正在准备下一个可执行动作。</p>
        </div>
      )}

      <div className="run-action-bar" aria-label="LearningRun 操作">
        {alternativeActions.map((action) => <button type="button" key={`${action.kind}-${action.alternativeId}`} className="run-action-link" disabled={pendingAction !== null || actionBusy || resyncing || recovery !== null} onClick={() => void dispatchAction(action)}><RotateCcw size={14} aria-hidden="true" />换方式</button>)}
        {snapshot.allowedActions.filter((action) => ["pause", "resume", "request_hint", "activate_followup", "finish_current_evidence", "finish_without_commit", "retry_prepare", "retry_assessment", "retry_commit"].includes(action.kind)).map((action) => <button type="button" key={`${action.kind}-${"level" in action ? action.level : ""}`} className="run-action-link" disabled={pendingAction !== null || actionBusy || resyncing || recovery !== null} onClick={() => void dispatchAction(action)}>{action.kind === "pause" ? <Pause size={14} aria-hidden="true" /> : action.kind === "resume" ? <Play size={14} aria-hidden="true" /> : action.kind === "request_hint" ? <Lightbulb size={14} aria-hidden="true" /> : null}{actionLabel(action)}</button>)}
        {snapshot.allowedActions.filter((action) => ["skip_task", "skip_run", "end"].includes(action.kind)).map((action) => <button type="button" key={`${action.kind}-${"taskId" in action ? action.taskId : ""}`} className="run-action-link run-action-link--quiet" disabled={pendingAction !== null || actionBusy || resyncing || recovery !== null} onClick={() => void dispatchAction(action)}>{action.kind === "end" ? <ArrowLeft size={14} aria-hidden="true" /> : <SkipForward size={14} aria-hidden="true" />}{actionLabel(action)}</button>)}
      </div>

      {pendingAction ? (
        <div className="run-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="learning-run-confirmation-title" onKeyDown={handleConfirmationKeyDown}>
          <h2 id="learning-run-confirmation-title" ref={confirmationHeadingRef} tabIndex={-1}>确认这项学习旅程操作</h2>
          <p>确定要{actionLabel(pendingAction)}吗？当前已输入内容会按服务端合同处理。</p>
          <button type="button" className="surface-primary" disabled={resyncing} onClick={() => void confirmPendingAction()}>确认</button>
          <button type="button" className="surface-secondary" onClick={closeConfirmation}>取消</button>
        </div>
      ) : null}
    </div>
  );
}
