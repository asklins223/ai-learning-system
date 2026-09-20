import { describe, expect, it } from "vitest";
import {
  companionMemoryListV1Schema,
  companionMemoryStarMapV2Schema,
} from "@ailearn/shared/companion-memory-desktop-contracts";
import { buildCompanionMemoryUniverse, routeForMemoryEntityTarget } from "./companion-memory-universe";

const MEMORY_A = "11111111-1111-4111-8111-111111111111";
const MEMORY_B = "22222222-2222-4222-8222-222222222222";
const NOTE_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_ID = "44444444-4444-4444-8444-444444444444";
const UPDATED_AT = "2026-09-19T08:00:00.000Z";

const memories = companionMemoryListV1Schema.parse({
  version: 2,
  items: [
    {
      memoryItemId: MEMORY_A,
      kind: "preference",
      content: "我更喜欢从例子开始理解概念",
      sourceEventId: null,
      sourceSessionId: null,
      userStated: true,
      userConfirmed: true,
      candidate: false,
      importance: 0.9,
      confidence: 1,
      scope: "workspace",
      pinned: true,
      archived: false,
      dismissedAt: null,
      conflictGroup: null,
      embeddingStatus: "ready",
      sourceType: "confirmed",
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
    },
    {
      memoryItemId: MEMORY_B,
      kind: "goal",
      content: "近期要复习力学",
      sourceEventId: null,
      sourceSessionId: null,
      userStated: false,
      userConfirmed: false,
      candidate: true,
      importance: 0.5,
      confidence: 0.7,
      scope: "workspace",
      pinned: false,
      archived: false,
      dismissedAt: null,
      conflictGroup: null,
      embeddingStatus: "pending",
      sourceType: "model_inferred",
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
    },
  ],
}).items;

const starMap = companionMemoryStarMapV2Schema.parse({
  version: 2,
  nodes: [{
    memoryId: MEMORY_A,
    kind: "preference",
    content: "我更喜欢从例子开始理解概念",
    state: "pinned",
    importance: 0.9,
    updatedAt: UPDATED_AT,
    entityLinks: [
      {
        entityType: "note",
        entityId: NOTE_ID,
        label: "牛顿第二定律笔记",
        target: { kind: "note", noteId: NOTE_ID },
        orphaned: false,
      },
      {
        entityType: "source",
        entityId: SOURCE_ID,
        label: "已删除的讲义",
        target: null,
        orphaned: true,
      },
    ],
  }],
  cursor: null,
});

describe("companion memory universe", () => {
  it("draws only persisted memory links and keeps orphan metadata", () => {
    const universe = buildCompanionMemoryUniverse(starMap, memories);

    expect(universe.graph.nodes).toHaveLength(3);
    expect(universe.graph.edges).toHaveLength(2);
    expect(universe.graph.edges.every((edge) => edge.id.startsWith("memory-link:"))).toBe(true);
    expect(universe.graph.edges.some((edge) => edge.from.startsWith("memory:") && edge.to.startsWith("memory:"))).toBe(false);

    const orphan = universe.graph.nodes.find((node) => node.entityId === SOURCE_ID);
    expect(orphan).toMatchObject({ state: "orphaned", metadata: { orphaned: true } });
    expect(universe.targetsByNode.get(orphan!.id)).toBeNull();
  });

  it("keeps candidates out of the graph and uses the confirmed list state as display authority", () => {
    const universe = buildCompanionMemoryUniverse(starMap, memories);
    const candidateId = universe.memoryNodeIds.get(MEMORY_B);
    const pinnedId = universe.memoryNodeIds.get(MEMORY_A);

    expect(candidateId).toBeUndefined();
    expect(universe.graph.nodes.find((node) => node.id === pinnedId)).toMatchObject({
      state: "pinned",
      metadata: { importance: 0.9 },
    });
  });

  it("keeps the layout stable when server order changes", () => {
    const first = buildCompanionMemoryUniverse(starMap, memories);
    const reordered = buildCompanionMemoryUniverse(
      { ...starMap, nodes: [...starMap.nodes].reverse() },
      [...memories].reverse(),
    );
    expect(reordered.layout.positions).toEqual(first.layout.positions);
  });

  it("normalizes entity targets to current desktop routes", () => {
    expect(routeForMemoryEntityTarget({ kind: "note", noteId: NOTE_ID })).toEqual({ kind: "note.detail", noteId: NOTE_ID });
    expect(routeForMemoryEntityTarget({ kind: "understanding", objectiveId: MEMORY_A })).toEqual({ kind: "objective.detail", objectiveId: MEMORY_A });
  });
});
