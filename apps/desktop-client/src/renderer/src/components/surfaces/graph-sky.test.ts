import { describe, expect, it } from "vitest";
import type {
  UnderstandingEdgeProjectionV3,
  UnderstandingNodeProjectionV3,
} from "@ailearn/shared/understanding-topology-v3-contracts";
import {
  graphEdgeKindLabel,
  graphNodeLabel,
  graphNodeSummary,
} from "./graph-sky";

let uuid = 0;
function nextId(): string {
  uuid += 1;
  return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
}

function sourceNode(label = "来源", id = nextId()): UnderstandingNodeProjectionV3 {
  return {
    nodeRef: { kind: "source", sourceId: id },
    label,
    // 服务端（topology-repository）透出的是来源 type：url | markdown | code | text。
    modality: "url",
    createdAt: "2026-09-01T08:00:00+08:00",
  };
}

function noteNode(label = "笔记", id = nextId(), hasSource = true): UnderstandingNodeProjectionV3 {
  return {
    nodeRef: { kind: "note", noteId: id },
    label,
    currentVersionId: nextId(),
    hasSource,
  };
}

function objectiveNode(
  overrides: Partial<Extract<UnderstandingNodeProjectionV3, { nodeRef: { kind: "objective" } }>> = {},
  id = nextId(),
): UnderstandingNodeProjectionV3 {
  // The layout only reads personal.state / personal.activeRunId, and the
  // primaryAction contract is a deep union irrelevant here — the fixture is
  // cast once instead of rebuilding the run-start schema in every helper.
  return {
    nodeRef: { kind: "objective", objectiveId: id },
    label: "提取练习",
    publicSummary: "关于提取练习的主张",
    activeCardId: null,
    lifecycle: "active",
    freshness: "fresh",
    personal: {
      state: "learning",
      activeRunId: null,
      activeScheduleId: null,
      nextReviewAt: null,
      practiceTrailCount: 0,
      lastCanonicalEventId: null,
      primaryAction: { kind: "none" },
    },
    ...overrides,
  } as UnderstandingNodeProjectionV3;
}

function evidenceNode(id = nextId()): UnderstandingNodeProjectionV3 {
  return {
    nodeRef: { kind: "evidence", evidenceSnapshotId: id },
    supportSummary: "来自来源第 3 段的证据快照",
    sourceLabel: "某论文",
    restricted: false,
  };
}

function edge(
  kind: UnderstandingEdgeProjectionV3["kind"],
  from: UnderstandingNodeProjectionV3,
  to: UnderstandingNodeProjectionV3,
  edgeId = nextId(),
): UnderstandingEdgeProjectionV3 {
  return {
    edgeId,
    kind,
    from: { kind: from.nodeRef.kind, id: nodeIdOf(from) },
    to: { kind: to.nodeRef.kind, id: nodeIdOf(to) },
    reasonCodes: [],
  };
}

function nodeIdOf(node: UnderstandingNodeProjectionV3): string {
  const ref = node.nodeRef;
  return ref.kind === "source" ? ref.sourceId
    : ref.kind === "note" ? ref.noteId
      : ref.kind === "objective" ? ref.objectiveId
        : ref.evidenceSnapshotId;
}

type ObjectivePersonalState = Extract<UnderstandingNodeProjectionV3, { nodeRef: { kind: "objective" } }>["personal"]["state"];

function personalState(state: ObjectivePersonalState): { state: ObjectivePersonalState; activeRunId: string | null; activeScheduleId: null; nextReviewAt: null; practiceTrailCount: 0; lastCanonicalEventId: null; primaryAction: { kind: "none" } } {
  return {
    state,
    activeRunId: null,
    activeScheduleId: null,
    nextReviewAt: null,
    practiceTrailCount: 0,
    lastCanonicalEventId: null,
    primaryAction: { kind: "none" },
  };
}

describe("labels", () => {
  it("证据星标用来源名，缺失时退回摘要", () => {
    const withLabel = evidenceNode();
    const withoutLabel = { ...evidenceNode(), sourceLabel: null };
    expect(graphNodeLabel(withLabel)).toBe("某论文");
    expect(graphNodeLabel(withoutLabel)).toBe("来自来源第 3 段的证据快照");
  });

  it("长标签在 DOM 护栏处截断", () => {
    const long = sourceNode("长".repeat(60));
    expect(graphNodeLabel(long).length).toBe(48);
  });

  it("受限证据不泄露内容，只说明受限", () => {
    const restricted = { ...evidenceNode(), restricted: true, sourceLabel: null };
    expect(graphNodeSummary(restricted)).toBe("证据受限，仅显示元数据。");
  });

  it("边类型有中文标签", () => {
    expect(graphEdgeKindLabel("relates_to")).toBe("语义关联");
    expect(graphEdgeKindLabel("contains_note")).toBe("收录笔记");
  });
});

/**
 * 目标节点同时带 `freshness` 和 `personal`。摘要曾经先判 `"freshness" in node`
 * ——那是笔记的字段——于是每个目标都落进笔记分支，目标摘要成了死代码，焦点卡上
 * 只显示「笔记 · fresh」。这一组把四种节点的分发钉死。
 */
describe("graphNodeSummary · 四族各报各的事实", () => {
  it("目标只报公开主张，状态交给详情元数据呈现", () => {
    const objective = objectiveNode({ publicSummary: "关于提取练习的主张" });
    expect(graphNodeSummary(objective)).toBe("关于提取练习的主张");
  });

  it("目标 state 变化不会污染公开主张", () => {
    const attention = objectiveNode({ personal: personalState("due_review") });
    expect(graphNodeSummary(attention)).toBe("关于提取练习的主张");
  });

  it("来源只报中文介质，不重复卡片标题里已有的名字", () => {
    const source = sourceNode("认知科学讲义");
    expect(graphNodeSummary(source)).toBe("网页来源");
    expect(graphNodeSummary(source)).not.toContain("认知科学讲义");
  });

  it("未知介质照原样透出，不编造中文名", () => {
    const odd = { ...sourceNode(), modality: "podcast" };
    expect(graphNodeSummary(odd)).toBe("podcast来源");
  });

  it("笔记报它与来源的连接关系（freshness 无计算依据，已从合同移除）", () => {
    expect(graphNodeSummary(noteNode("收录笔记", nextId(), true))).toBe("已关联来源");
    expect(graphNodeSummary(noteNode("手写笔记", nextId(), false))).toBe("手写笔记");
  });

  it("证据报支撑摘要", () => {
    expect(graphNodeSummary(evidenceNode())).toBe("来自来源第 3 段的证据快照");
  });
});
