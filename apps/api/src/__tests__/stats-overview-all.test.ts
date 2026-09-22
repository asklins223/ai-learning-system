import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceInfo } from "../modules/identity/service.ts";
import {
  getAllWorkspacesStatsOverview,
  STATS_OVERVIEW_WORKSPACE_MAX,
  type StatsOverview,
} from "../modules/stats/service.ts";

/**
 * 「全部空间」总览的聚合逻辑。
 *
 * 这里测的是**聚合**，不是计数：每空间的数字来自 `getStatsOverview`（唯一来源），
 * 所以依赖用 DI 换掉，既不起 DB、也不重算一遍可见性条件。真实计数口径由
 * `getStatsOverview` 自己的集成用例保证。
 */

const USER_ID = "00000000-0000-4000-8000-000000000001";
const CURRENT_WORKSPACE_ID = "00000000-0000-4000-8000-0000000000a1";

function workspace(index: number, overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  const suffix = index.toString(16).padStart(12, "0");
  return {
    workspaceId: `00000000-0000-4000-8000-${suffix}`,
    workspaceName: `空间 ${index}`,
    role: "owner",
    workspaceType: "collaborative",
    isPersonal: false,
    leftAt: null,
    ...overrides,
  };
}

function overview(overrides: Partial<StatsOverview> = {}): StatsOverview {
  return {
    noteCount: 0,
    cardCount: 0,
    activeCardCount: 0,
    evidenceCount: 0,
    pendingReviewCount: 0,
    hardEvidenceCount: 0,
    capped: false,
    activeObjectiveCount: 0,
    objectiveReviewDueCount: 0,
    ...overrides,
  };
}

describe("getAllWorkspacesStatsOverview", () => {
  it("keeps one row per active space and sums the numbers into a total", async () => {
    const memberships = [workspace(1), workspace(2)];
    const perWorkspace: Record<string, StatsOverview> = {
      [memberships[0].workspaceId]: overview({
        noteCount: 3,
        cardCount: 7,
        activeCardCount: 7,
        evidenceCount: 2,
        pendingReviewCount: 1,
        hardEvidenceCount: 2,
        activeObjectiveCount: 4,
        objectiveReviewDueCount: 2,
      }),
      [memberships[1].workspaceId]: overview({
        noteCount: 5,
        cardCount: 9,
        activeCardCount: 8,
        evidenceCount: 1,
        pendingReviewCount: 3,
        hardEvidenceCount: 1,
        activeObjectiveCount: 2,
        objectiveReviewDueCount: 6,
      }),
    };
    const calls: string[] = [];

    const result = await getAllWorkspacesStatsOverview(USER_ID, memberships[1].workspaceId, {
      listWorkspaces: async (userId) => {
        assert.equal(userId, USER_ID);
        return memberships;
      },
      loadOverview: async (workspaceId, userId) => {
        assert.equal(userId, USER_ID, "每个空间的统计都必须按人过滤");
        calls.push(workspaceId);
        return perWorkspace[workspaceId];
      },
    });

    assert.deepEqual(calls, memberships.map((m) => m.workspaceId), "每个活跃空间各算一次");
    assert.equal(result.version, 1);
    assert.equal(result.workspaces.length, 2);
    assert.equal(result.capped, false);
    assert.equal(result.skippedWorkspaceCount, 0);
    // 当前空间由服务端标记：渲染层没有 workspaceId，按名字猜会在同名空间上出错。
    assert.deepEqual(result.workspaces.map((row) => row.isCurrent), [false, true]);
    assert.equal(result.workspaces[0].workspaceName, "空间 1");
    assert.equal(result.workspaces[0].role, "owner");
    assert.deepEqual(result.total, overview({
      noteCount: 8,
      cardCount: 16,
      activeCardCount: 15,
      evidenceCount: 3,
      pendingReviewCount: 4,
      hardEvidenceCount: 3,
      activeObjectiveCount: 6,
      objectiveReviewDueCount: 8,
    }));
  });

  it("does not count a space the user already left", async () => {
    const left = workspace(3, { leftAt: new Date("2026-01-01T00:00:00.000Z") });
    const active = workspace(4);
    const loaded: string[] = [];

    const result = await getAllWorkspacesStatsOverview(USER_ID, active.workspaceId, {
      // listUserWorkspaces 已经按 left_at IS NULL 过滤；这里给它一条脏行，
      // 确认聚合自己也不会把"已经退出的空间"算进合计。
      listWorkspaces: async () => [left, active],
      loadOverview: async (workspaceId) => {
        loaded.push(workspaceId);
        return overview({ noteCount: 2 });
      },
    });

    assert.deepEqual(loaded, [active.workspaceId]);
    assert.equal(result.workspaces.length, 1);
    assert.equal(result.total.noteCount, 2);
  });

  it("caps the fan-out and reports how many spaces were skipped", async () => {
    const memberships = Array.from({ length: STATS_OVERVIEW_WORKSPACE_MAX + 2 }, (_, index) => workspace(index + 1));
    const loaded: string[] = [];

    const result = await getAllWorkspacesStatsOverview(USER_ID, CURRENT_WORKSPACE_ID, {
      listWorkspaces: async () => memberships,
      loadOverview: async (workspaceId) => {
        loaded.push(workspaceId);
        return overview({ noteCount: 1 });
      },
    });

    assert.equal(loaded.length, STATS_OVERVIEW_WORKSPACE_MAX, "扇出必须封顶，不能按历史成员行数无限放大");
    assert.equal(result.workspaces.length, STATS_OVERVIEW_WORKSPACE_MAX);
    assert.equal(result.capped, true);
    assert.equal(result.skippedWorkspaceCount, 2, "少算了几个必须如实说出来");
    assert.equal(result.total.noteCount, STATS_OVERVIEW_WORKSPACE_MAX);
    // 截断掉的空间里也可能有"当前空间"——此时没有任何一行被标成当前空间，
    // 好过把别的空间误标成"你正在看的这个"。
    assert.equal(result.workspaces.some((row) => row.isCurrent), false);
  });

  it("marks the total as degraded when any single space was capped", async () => {
    const memberships = [workspace(1), workspace(2)];

    const result = await getAllWorkspacesStatsOverview(USER_ID, CURRENT_WORKSPACE_ID, {
      listWorkspaces: async () => memberships,
      loadOverview: async (workspaceId) =>
        workspaceId === memberships[0].workspaceId ? overview({ capped: true }) : overview(),
    });

    assert.equal(result.workspaces[0].overview.capped, true);
    assert.equal(result.total.capped, true, "合计里混进了降级口径，就必须承认");
  });

  it("returns an empty total for a user with no active membership", async () => {
    const result = await getAllWorkspacesStatsOverview(USER_ID, CURRENT_WORKSPACE_ID, {
      listWorkspaces: async () => [],
      loadOverview: async () => assert.fail("没有成员关系时不应发起任何空间统计"),
    });

    assert.deepEqual(result.workspaces, []);
    assert.deepEqual(result.total, overview());
    assert.equal(result.capped, false);
    assert.equal(result.skippedWorkspaceCount, 0);
  });
});
