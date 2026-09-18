import { describe, expect, it } from "vitest";
import {
  beginProjectionRefresh,
  failProjectionRefresh,
  projectionResponseIsCurrent,
  sameProjectionScope,
} from "./workspace-projection";

const workspaceA = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  workspaceEpoch: 3,
};
const workspaceB = {
  workspaceId: "22222222-2222-4222-8222-222222222222",
  workspaceEpoch: 4,
};

describe("workspace projection refresh policy", () => {
  it("keeps the last trusted projection while the same workspace refreshes or degrades", () => {
    const current = { projection: { revision: 8 }, loading: false, failure: null };
    const refreshing = beginProjectionRefresh(current, workspaceA, workspaceA);
    expect(refreshing).toEqual({ projection: { revision: 8 }, loading: true, failure: null });
    expect(failProjectionRefresh(refreshing, "暂时不可用")).toEqual({
      projection: { revision: 8 },
      loading: false,
      failure: "暂时不可用",
    });
  });

  it("clears projection data at a workspace boundary", () => {
    const current = { projection: { revision: 8 }, loading: false, failure: "old" };
    expect(beginProjectionRefresh(current, workspaceA, workspaceB)).toEqual({
      projection: null,
      loading: true,
      failure: null,
    });
    expect(sameProjectionScope(workspaceA, workspaceB)).toBe(false);
  });

  it("rejects late generations, stale scopes, and mismatched gateway epochs", () => {
    expect(projectionResponseIsCurrent(5, 5, workspaceA, workspaceA, 3)).toBe(true);
    expect(projectionResponseIsCurrent(4, 5, workspaceA, workspaceA, 3)).toBe(false);
    expect(projectionResponseIsCurrent(5, 5, workspaceA, workspaceB, 3)).toBe(false);
    expect(projectionResponseIsCurrent(5, 5, workspaceA, workspaceA, 4)).toBe(false);
  });
});
