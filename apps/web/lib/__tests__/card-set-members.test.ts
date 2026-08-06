/**
 * 卡组成员排序（lib/card-set-members.ts）— 总览优先、ordinal 升序、id 稳定。
 * 与 /card-sets/[id]、/cards/[id] 详情页共用同一 comparator（单一事实来源）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CardDetailResponse } from "../api";
import { compareCardSetMembers } from "../card-set-members";

function member(
  id: string,
  scope: "overview" | "section",
  ordinal: number,
): CardDetailResponse {
  return {
    card: {
      id,
      noteVersionId: "nv-1",
      workspaceId: "ws-1",
      status: "active",
      schemaJson: { title: id, summary: "" },
      artifactId: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      cardSetId: "set-1",
      scope,
      ordinal,
    },
    keyPoints: [],
  };
}

describe("compareCardSetMembers", () => {
  it("总览卡永远排在章节卡前", () => {
    assert.ok(compareCardSetMembers(member("a", "section", 1), member("b", "overview", 0)) > 0);
    assert.ok(compareCardSetMembers(member("b", "overview", 0), member("a", "section", 1)) < 0);
  });

  it("章节卡按 ordinal 升序", () => {
    assert.ok(compareCardSetMembers(member("a", "section", 2), member("b", "section", 1)) > 0);
    assert.ok(compareCardSetMembers(member("a", "section", 1), member("b", "section", 2)) < 0);
    // 完全相同的成员 → 0
    assert.equal(compareCardSetMembers(member("a", "section", 1), member("a", "section", 1)), 0);
  });

  it("ordinal 缺失时当作无穷大排最后", () => {
    const withOrdinal = member("a", "section", 1);
    const missing = member("b", "section", null as unknown as number);
    assert.ok(compareCardSetMembers(missing, withOrdinal) > 0);
  });

  it("ordinal 相同按 id 稳定排序", () => {
    assert.ok(compareCardSetMembers(member("a", "section", 1), member("b", "section", 1)) < 0);
    assert.ok(compareCardSetMembers(member("b", "section", 1), member("a", "section", 1)) > 0);
  });

  it("排序结果：总览先、章节按 ordinal", () => {
    const list = [
      member("c", "section", 3),
      member("a", "overview", 0),
      member("b", "section", 1),
    ];
    const sorted = [...list].sort(compareCardSetMembers).map((item) => item.card.id);
    assert.deepEqual(sorted, ["a", "b", "c"]);
  });
});
