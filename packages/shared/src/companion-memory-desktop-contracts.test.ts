import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { companionMemoryStarMapV2Schema } from "./companion-memory-desktop-contracts.ts";

const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const UPDATED_AT = "2026-09-19T08:00:00.000Z";

function mapWithLink(link: Record<string, unknown>) {
  return {
    version: 2,
    nodes: [{
      memoryId: MEMORY_ID,
      kind: "learning_context",
      content: "牛顿第二定律与这份笔记有关",
      state: "active",
      importance: 0.8,
      updatedAt: UPDATED_AT,
      entityLinks: [link],
    }],
    cursor: null,
  };
}

describe("companion memory star-map V2", () => {
  it("accepts a named live entity with a normalized navigation target", () => {
    const parsed = companionMemoryStarMapV2Schema.parse(mapWithLink({
      entityType: "note",
      entityId: NOTE_ID,
      label: "牛顿第二定律笔记",
      target: { kind: "note", noteId: NOTE_ID },
      orphaned: false,
    }));
    assert.equal(parsed.nodes[0].entityLinks[0].label, "牛顿第二定律笔记");
  });

  it("requires orphaned entities to be non-navigable", () => {
    const invalid = companionMemoryStarMapV2Schema.safeParse(mapWithLink({
      entityType: "note",
      entityId: NOTE_ID,
      label: "已失效笔记",
      target: { kind: "note", noteId: NOTE_ID },
      orphaned: true,
    }));
    assert.equal(invalid.success, false);
  });

  it("rejects a live relation without a navigation target", () => {
    const invalid = companionMemoryStarMapV2Schema.safeParse(mapWithLink({
      entityType: "note",
      entityId: NOTE_ID,
      label: "牛顿第二定律笔记",
      target: null,
      orphaned: false,
    }));
    assert.equal(invalid.success, false);
  });
});
