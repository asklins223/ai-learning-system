/**
 * Pure labels, narrowing helpers and keys shared by the understanding star map
 * and its detail drawer. Everything here is a projection of the server's
 * topology contract — no layout, no geometry, no invented records.
 */

import type {
  UnderstandingEdgeProjectionV3,
  UnderstandingNodeProjectionV3,
} from "@ailearn/shared/understanding-topology-v3-contracts";
export type GraphNodeKind = UnderstandingNodeProjectionV3["nodeRef"]["kind"];

/** The record's own id, whichever kind it is — the one field all four node
 *  refs share under a different name. */
function nodeRefId(node: UnderstandingNodeProjectionV3): string {
  const ref = node.nodeRef;
  return ref.kind === "source" ? ref.sourceId
    : ref.kind === "note" ? ref.noteId
      : ref.kind === "objective" ? ref.objectiveId
        : ref.evidenceSnapshotId;
}

export function graphNodeKey(node: UnderstandingNodeProjectionV3): string {
  return `${node.nodeRef.kind}:${nodeRefId(node)}`;
}

export function edgeEndpointKey(ref: UnderstandingEdgeProjectionV3["from"]): string {
  return `${ref.kind}:${ref.id}`;
}

/* --- labels -------------------------------------------------------------- */

const KIND_LABEL: Record<GraphNodeKind, string> = {
  source: "来源",
  note: "笔记",
  objective: "理解目标",
  evidence: "证据",
};

export function graphNodeKindLabel(kind: GraphNodeKind): string {
  return KIND_LABEL[kind] ?? kind;
}

export const EDGE_KIND_LABEL = {
  relates_to: "语义关联",
  supersedes: "替代版本",
  supported_by: "证据支撑",
  sourced_from: "来源血缘",
  contains_note: "收录笔记",
} as const satisfies Record<UnderstandingEdgeProjectionV3["kind"], string>;

export function graphEdgeKindLabel(kind: UnderstandingEdgeProjectionV3["kind"]): string {
  return EDGE_KIND_LABEL[kind] ?? kind;
}

const OBJECTIVE_STATE_LABEL = {
  unvalidated: "待验证",
  learning: "学习中",
  stable: "已稳定",
  fragile: "需要巩固",
  needs_repair: "需要修复",
  due_review: "到期复习",
  scheduled: "已排期",
  outdated: "内容过期",
  archived: "已归档",
  superseded: "已被替代",
} as const;

export function graphObjectiveStateLabel(state: string): string {
  return (OBJECTIVE_STATE_LABEL as Record<string, string>)[state] ?? state;
}

/** States that mean "this claim needs the learner" — they earn the bigger star. */
const ATTENTION_STATES: ReadonlySet<string> = new Set([
  "unvalidated",
  "fragile",
  "needs_repair",
  "due_review",
  "outdated",
]);

export function objectiveNeedsAttention(state: string): boolean {
  return ATTENTION_STATES.has(state);
}

/** The 来源库 writes the same four words in `formatSourceKindLabel`; that
 *  helper lives in a React module this pure layout file must not import, so
 *  the graph keeps its own table exactly as it already does for kinds, edges
 *  and objective states. */
const SOURCE_MODALITY_LABEL: Record<string, string> = {
  url: "网页",
  web: "网页",
  markdown: "Markdown",
  code: "代码",
  text: "文本",
};

export function graphSourceModalityLabel(modality: string): string {
  return SOURCE_MODALITY_LABEL[modality] ?? modality;
}

/* --- node narrowing ------------------------------------------------------- *
 * The contract is a plain `z.union`, not a discriminated one: the
 * discriminant (`kind`) sits inside `nodeRef`, so a `nodeRef.kind` check
 * narrows the ref but never the node, and every variant has to be recognised
 * by a property of its own. The four node schemas are `strictObject`s, so
 * these keys are exact hit tests on exactly one kind:
 *
 *   source → modality · note → currentVersionId · objective → personal ·
 *   evidence → supportSummary
 *
 * `freshness` used to stand in for "note", and it was false: objectives carry
 * `freshness` too, so every objective matched the note branch first and the
 * objective summary below was unreachable. Keying each guard on a key only one
 * kind owns removes that class of bug outright.
 */

export type SourceNodeV3 = Extract<UnderstandingNodeProjectionV3, { nodeRef: { kind: "source" } }>;
export type NoteNodeV3 = Extract<UnderstandingNodeProjectionV3, { nodeRef: { kind: "note" } }>;
export type ObjectiveNodeV3 = Extract<UnderstandingNodeProjectionV3, { nodeRef: { kind: "objective" } }>;
export type EvidenceNodeV3 = Extract<UnderstandingNodeProjectionV3, { nodeRef: { kind: "evidence" } }>;

export function isSourceNode(node: UnderstandingNodeProjectionV3): node is SourceNodeV3 {
  return "modality" in node;
}

export function isNoteNode(node: UnderstandingNodeProjectionV3): node is NoteNodeV3 {
  return "currentVersionId" in node;
}

export function isObjectiveNode(node: UnderstandingNodeProjectionV3): node is ObjectiveNodeV3 {
  return "personal" in node;
}

export function isEvidenceNode(node: UnderstandingNodeProjectionV3): node is EvidenceNodeV3 {
  return "supportSummary" in node;
}

/** One line the detail drawer shows under the label — a second fact, never a
 *  restatement of the heading the card already carries. The guards are
 *  mutually exclusive, so the order here is a readability choice, not a
 *  correctness one. */
export function graphNodeSummary(node: UnderstandingNodeProjectionV3): string {
  if (isObjectiveNode(node)) {
    return `${graphObjectiveStateLabel(node.personal.state)} · ${node.publicSummary}`;
  }
  if (isSourceNode(node)) return `${graphSourceModalityLabel(node.modality)}来源`;
  // The server has no basis to compute a note's freshness (it records no
  // per-source content revision), so the note reports the one link it does
  // know: whether a source stands behind it.
  if (isNoteNode(node)) return node.hasSource ? "已关联来源" : "手写笔记";
  return node.restricted ? "证据受限，仅显示元数据。" : node.supportSummary;
}

/** The cosmos labels stay short; the detail drawer carries the full summary. */
export const GRAPH_CAPTION_MAX_LENGTH = 48;

export function graphNodeLabel(node: UnderstandingNodeProjectionV3): string {
  const raw = isEvidenceNode(node) ? (node.sourceLabel ?? node.supportSummary) : node.label;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  return trimmed.length > GRAPH_CAPTION_MAX_LENGTH
    ? trimmed.slice(0, GRAPH_CAPTION_MAX_LENGTH)
    : trimmed;
}
