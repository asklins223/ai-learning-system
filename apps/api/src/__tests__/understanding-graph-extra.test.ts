/**
 * understanding/graph.ts 补充测试
 *
 * 覆盖原有测试未覆盖的边界情况：
 * - card 无对应 noteVersion
 * - keyPoint 排序
 * - null/空字段处理
 * - 多 keyPoint 同一 card
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildUnderstandingGraphDto,
  UNDERSTANDING_GRAPH_CARD_LIMIT,
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
      title: "原文",
      origin: "doc.md",
      status: "ready",
      metadata: { lang: "zh" },
      createdAt: NOW,
      updatedAt: NOW,
    }],
    notes: [{
      id: "note-1",
      title: "笔记",
      sourceId: "source-1",
      currentVersionId: "version-1",
      createdAt: NOW,
      updatedAt: NOW,
    }],
    noteVersions: [{
      id: "version-1",
      noteId: "note-1",
      versionNo: 1,
      createdAt: NOW,
    }],
    cards: [{
      id: "card-1",
      noteVersionId: "version-1",
      title: "卡片",
      summary: "摘要",
      status: "active",
      state: "unseen",
      evidenceCoverage: 0,
      hardEvidenceCount: 0,
      softEvidenceCount: 0,
      misunderstandingCount: 0,
      lastValidatedAt: null,
      nextReviewAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    }],
    keyPoints: [{
      id: "kp-1",
      cardId: "card-1",
      ordinal: 1,
      claim: "要点",
      quoteText: "引用",
      segmentRef: null,
      hardEvidenceCount: 0,
      softEvidenceCount: 0,
      misunderstandingCount: 0,
      lastValidatedAt: null,
    }],
    ...overrides,
  };
}

test("graph: card 无对应 noteVersion 时仍生成 card 节点但无 note 节点", () => {
  const input = fixture({
    cards: [{
      ...fixture().cards[0]!,
      noteVersionId: "version-missing",
    }],
  });

  const graph = buildUnderstandingGraphDto(input);

  const cardNode = graph.nodes.find((n) => n.type === "card");
  assert.ok(cardNode);
  assert.equal(cardNode!.parentId, null);
  // 没有 note 节点
  assert.equal(graph.nodes.some((n) => n.type === "note"), false);
  // 没有 generated_from 边
  assert.equal(graph.edges.some((e) => e.type === "generated_from"), false);
});

test("graph: keyPoint 按 ordinal 排序", () => {
  const input = fixture();
  input.totalCards = 1;
  input.keyPoints = [
    { ...input.keyPoints[0]!, id: "kp-3", ordinal: 3 },
    { ...input.keyPoints[0]!, id: "kp-1", ordinal: 1 },
    { ...input.keyPoints[0]!, id: "kp-2", ordinal: 2 },
  ];

  const graph = buildUnderstandingGraphDto(input);
  const kpNodes = graph.nodes.filter((n) => n.type === "key_point");
  assert.equal(kpNodes.length, 3);
  // 验证 ordinal 在 metadata 中
  assert.equal(kpNodes[0]!.metadata.ordinal, 1);
  assert.equal(kpNodes[1]!.metadata.ordinal, 2);
  assert.equal(kpNodes[2]!.metadata.ordinal, 3);
});

test("graph: keyPoint ordinal 相同时按 id 排序", () => {
  const input = fixture();
  input.keyPoints = [
    { ...input.keyPoints[0]!, id: "kp-zzz", ordinal: 1 },
    { ...input.keyPoints[0]!, id: "kp-aaa", ordinal: 1 },
  ];

  const graph = buildUnderstandingGraphDto(input);
  const kpNodes = graph.nodes.filter((n) => n.type === "key_point");
  assert.equal(kpNodes.length, 2);
  assert.equal(kpNodes[0]!.entityId, "kp-aaa");
  assert.equal(kpNodes[1]!.entityId, "kp-zzz");
});

test("graph: source 无 origin 时 description 为 null", () => {
  const input = fixture({
    sources: [{
      ...fixture().sources[0]!,
      origin: null,
    }],
  });

  const graph = buildUnderstandingGraphDto(input);
  const sourceNode = graph.nodes.find((n) => n.type === "source");
  assert.ok(sourceNode);
  assert.equal(sourceNode!.description, null);
});

test("graph: card summary 为空时 description 为 null", () => {
  const input = fixture({
    cards: [{
      ...fixture().cards[0]!,
      summary: "",
    }],
  });

  const graph = buildUnderstandingGraphDto(input);
  const cardNode = graph.nodes.find((n) => n.type === "card");
  assert.ok(cardNode);
  assert.equal(cardNode!.description, null);
});

test("graph: keyPoint 无 quoteText 时 description 为 null", () => {
  const input = fixture({
    keyPoints: [{
      ...fixture().keyPoints[0]!,
      quoteText: "",
    }],
  });

  const graph = buildUnderstandingGraphDto(input);
  const kpNode = graph.nodes.find((n) => n.type === "key_point");
  assert.ok(kpNode);
  assert.equal(kpNode!.description, null);
});

test("graph: source metadata 为 null 时使用空对象", () => {
  const input = fixture({
    sources: [{
      ...fixture().sources[0]!,
      metadata: null,
    }],
  });

  const graph = buildUnderstandingGraphDto(input);
  const sourceNode = graph.nodes.find((n) => n.type === "source");
  assert.ok(sourceNode);
  assert.deepEqual(sourceNode!.metadata.sourceMetadata, {});
});

test("graph: note 无 sourceId 时不生成 derived_from 边", () => {
  const input = fixture({
    notes: [{
      ...fixture().notes[0]!,
      sourceId: null,
    }],
    sources: [],
  });

  const graph = buildUnderstandingGraphDto(input);
  assert.equal(graph.nodes.some((n) => n.type === "source"), false);
  assert.equal(graph.nodes.some((n) => n.type === "note"), true);
  assert.equal(graph.edges.some((e) => e.type === "derived_from"), false);
});

test("graph: keyPoint 有 hardEvidence 时 evidenceCoverage 为 1", () => {
  const input = fixture({
    keyPoints: [{
      ...fixture().keyPoints[0]!,
      hardEvidenceCount: 2,
    }],
  });

  const graph = buildUnderstandingGraphDto(input);
  const kpNode = graph.nodes.find((n) => n.type === "key_point");
  assert.ok(kpNode);
  assert.equal(kpNode!.evidenceCoverage, 1);
});

test("graph: keyPoint 无 hardEvidence 时 evidenceCoverage 为 0", () => {
  const input = fixture({
    keyPoints: [{
      ...fixture().keyPoints[0]!,
      hardEvidenceCount: 0,
    }],
  });

  const graph = buildUnderstandingGraphDto(input);
  const kpNode = graph.nodes.find((n) => n.type === "key_point");
  assert.ok(kpNode);
  assert.equal(kpNode!.evidenceCoverage, 0);
});

test("graph: card 的 isCurrentNoteVersion 正确判断", () => {
  const input = fixture();
  // version-1 是 note-1 的 currentVersionId
  const graph = buildUnderstandingGraphDto(input);
  const cardNode = graph.nodes.find((n) => n.type === "card");
  assert.ok(cardNode);
  assert.equal(cardNode!.metadata.isCurrentNoteVersion, true);
});

test("graph: card 的 isCurrentNoteVersion 为 false 当版本不是当前版本", () => {
  const input = fixture();
  input.notes[0]!.currentVersionId = "version-other";
  const graph = buildUnderstandingGraphDto(input);
  const cardNode = graph.nodes.find((n) => n.type === "card");
  assert.ok(cardNode);
  assert.equal(cardNode!.metadata.isCurrentNoteVersion, false);
});

test("graph: 多个 card 共享同一 note 时只生成一个 note 节点", () => {
  const input = fixture();
  input.totalCards = 2;
  input.cards.push({
    ...input.cards[0]!,
    id: "card-2",
    title: "第二张卡",
  });

  const graph = buildUnderstandingGraphDto(input);
  assert.equal(graph.nodes.filter((n) => n.type === "note").length, 1);
  assert.equal(graph.nodes.filter((n) => n.type === "card").length, 2);
  assert.equal(graph.edges.filter((e) => e.type === "generated_from").length, 2);
});

test("graph: UNDERSTANDING_GRAPH_CARD_LIMIT 常量为 200", () => {
  assert.equal(UNDERSTANDING_GRAPH_CARD_LIMIT, 200);
});

test("graph: totalCards 正好等于 limit 时 truncated 为 false", () => {
  const input = fixture({ totalCards: 200 });
  const graph = buildUnderstandingGraphDto(input);
  assert.equal(graph.meta.truncated, false);
});
