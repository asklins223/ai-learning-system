import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildUnderstandingGraphDto,
  type BuildUnderstandingGraphInput,
} from "../modules/understanding/graph.ts";

const NOW = "2026-07-17T08:00:00.000Z";

function fixture(overrides: Partial<BuildUnderstandingGraphInput> = {}): BuildUnderstandingGraphInput {
  return {
    generatedAt: NOW,
    totalCards: 1,
    sources: [{
      id: "source-1",
      type: "markdown",
      title: "注意力机制原文",
      origin: "attention.md",
      status: "ready",
      metadata: { language: "zh" },
      createdAt: NOW,
      updatedAt: NOW,
    }],
    notes: [{
      id: "note-1",
      title: "注意力机制笔记",
      sourceId: "source-1",
      currentVersionId: "version-1",
      createdAt: NOW,
      updatedAt: NOW,
    }],
    noteVersions: [{
      id: "version-1",
      noteId: "note-1",
      versionNo: 2,
      createdAt: NOW,
    }],
    cards: [{
      id: "card-1",
      noteVersionId: "version-1",
      title: "自注意力机制",
      summary: "理解 Q、K、V 的关系",
      status: "active",
      state: "preliminary_understood",
      evidenceCoverage: 1,
      hardEvidenceCount: 1,
      softEvidenceCount: 0,
      misunderstandingCount: 0,
      lastValidatedAt: NOW,
      nextReviewAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    }],
    keyPoints: [{
      id: "kp-1",
      cardId: "card-1",
      ordinal: 1,
      claim: "注意力按相关性分配权重",
      quoteText: "相关性决定每个位置的关注程度。",
      segmentRef: { blockId: "block-1", blockOrdinal: 3 },
      hardEvidenceCount: 1,
      softEvidenceCount: 0,
      misunderstandingCount: 0,
      lastValidatedAt: NOW,
    }],
    ...overrides,
  };
}

describe("buildUnderstandingGraphDto", () => {
  it("deduplicates shared source and note nodes and their lineage edge", () => {
    const input = fixture();
    input.totalCards = 2;
    input.cards.push({
      ...input.cards[0]!,
      id: "card-2",
      title: "缩放点积注意力",
      state: "unseen",
    });
    // 即使上游意外重复返回同一实体，也不能重复计数或造第二颗星。
    input.cards.push({ ...input.cards[0]!, state: "misunderstood" });
    input.keyPoints.push({
      ...input.keyPoints[0]!,
      id: "kp-2",
      cardId: "card-2",
      claim: "缩放因子稳定 Softmax",
    });

    const graph = buildUnderstandingGraphDto(input);

    assert.equal(graph.nodes.filter((node) => node.type === "source").length, 1);
    assert.equal(graph.nodes.filter((node) => node.type === "note").length, 1);
    assert.equal(graph.nodes.filter((node) => node.type === "card").length, 2);
    assert.equal(graph.nodes.filter((node) => node.type === "key_point").length, 2);
    assert.equal(graph.edges.filter((edge) => edge.type === "derived_from").length, 1);
    assert.equal(new Set(graph.nodes.map((node) => node.id)).size, graph.nodes.length);
    assert.equal(new Set(graph.edges.map((edge) => edge.id)).size, graph.edges.length);
    assert.deepEqual(graph.meta.stateCounts, { preliminary_understood: 1, unseen: 1 });
  });

  it("only emits edges backed by the supplied foreign-key lineage", () => {
    const input = fixture({
      // note 指向不存在的 source；纯构建器不能补一颗虚假来源星。
      notes: [{
        id: "note-1",
        title: "手写笔记",
        sourceId: "source-missing",
        currentVersionId: "version-1",
        createdAt: NOW,
        updatedAt: NOW,
      }],
      sources: [],
      keyPoints: [
        ...fixture().keyPoints,
        // 不属于输入 card 的 keyPoint 不能混入图。
        { ...fixture().keyPoints[0]!, id: "kp-orphan", cardId: "card-missing" },
      ],
    });

    const graph = buildUnderstandingGraphDto(input);
    const ids = new Set(graph.nodes.map((node) => node.id));

    assert.deepEqual(graph.edges.map((edge) => edge.type).sort(), ["contains", "generated_from"]);
    assert.ok(graph.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)));
    assert.equal(graph.nodes.some((node) => node.entityId === "source-missing"), false);
    assert.equal(graph.nodes.some((node) => node.entityId === "kp-orphan"), false);
  });

  it("keeps cards from different notes under one real shared source", () => {
    const input = fixture();
    input.totalCards = 2;
    input.notes.push({
      ...input.notes[0]!,
      id: "note-2",
      title: "缩放注意力笔记",
      currentVersionId: "version-2",
    });
    input.noteVersions.push({
      ...input.noteVersions[0]!,
      id: "version-2",
      noteId: "note-2",
    });
    input.cards = [
      { ...input.cards[0]!, state: "misunderstood" },
      {
        ...input.cards[0]!,
        id: "card-2",
        noteVersionId: "version-2",
        title: "缩放点积学习卡",
        state: "reviewed",
      },
    ];
    input.keyPoints = [];

    const graph = buildUnderstandingGraphDto(input);
    const cardNodes = graph.nodes.filter((node) => node.type === "card");

    assert.equal(graph.meta.sourceCount, 1);
    assert.equal(graph.meta.noteCount, 2);
    assert.equal(cardNodes.length, 2);
    assert.deepEqual(cardNodes.map((node) => node.parentId), ["note:note-1", "note:note-2"]);
    assert.equal(graph.edges.filter((edge) => edge.type === "derived_from").length, 2);
    assert.equal(graph.edges.filter((edge) => edge.type === "generated_from").length, 2);
    assert.deepEqual(graph.meta.stateCounts, { misunderstood: 1, reviewed: 1 });
    assert.equal(graph.meta.truncated, false);
  });

  it("returns a stable, truthful empty graph", () => {
    const graph = buildUnderstandingGraphDto({
      generatedAt: NOW,
      totalCards: 0,
      sources: [],
      notes: [],
      noteVersions: [],
      cards: [],
      keyPoints: [],
    });

    assert.deepEqual(graph.nodes, []);
    assert.deepEqual(graph.edges, []);
    assert.deepEqual(graph.meta, {
      generatedAt: NOW,
      totalCards: 0,
      nodeCount: 0,
      edgeCount: 0,
      sourceCount: 0,
      noteCount: 0,
      cardCount: 0,
      keyPointCount: 0,
      truncated: false,
      stateCounts: {},
    });
  });

  it("marks the projection truncated when more than 200 active cards exist", () => {
    const input = fixture({ totalCards: 201 });
    const graph = buildUnderstandingGraphDto(input);

    assert.equal(graph.meta.cardCount, 1);
    assert.equal(graph.meta.totalCards, 201);
    assert.equal(graph.meta.truncated, true);
  });
});
