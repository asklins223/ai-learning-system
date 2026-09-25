/**
 * Plan 23 RL-01/RL-02：Cross-surface identity & count parity 集成测试。
 *
 * §25.3 同一 fixture 断言：
 *   Dashboard.activeObjectives
 *   = Objective list total
 *   = Topology objective node 数
 *   = learning_objectives_v2 active 计数
 *   = 详情可读（每个 objectiveId 都能装配 Surface）
 *
 * 隐藏 alias 永不进入正式计数（legacy active 卡不参与以上任何查询；§2.5/§21.5）。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { findPrivatePayloadLeaks } from "@ailearn/shared";
import { learningObjectivesV2 } from "@ailearn/shared/db-schema/card-generation-v2";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
}
// 自播种纯 V2 工作区（替代被 0176 清库抹掉的手工工作区 4f825f38-…）。
const pgSql = (await import("postgres")).default(process.env.DATABASE_URL, { max: 1 });
const { seedPureV2Workspace } = await import("./helpers/pure-v2-workspace-fixture.ts");
const { addV2ObjectiveWithoutCard, seedObjectiveNoteEvidence } = await import("./helpers/v2-card-fixture.ts");
const pureV2 = await seedPureV2Workspace(pgSql, { objectiveCount: 3 });
const PURE_V2_WORKSPACE = pureV2.workspaceId;
const SYSTEM_USER = pureV2.userId;
/**
 * 第四个目标是**没有学习卡**的那一个（W4-2）。这一档过去在这份夹具里造不出来，
 * 于是下面那条"主行动必须真的能开一轮"从来没有真的对着无卡目标跑过。
 */
const CARDLESS = await addV2ObjectiveWithoutCard(pgSql, PURE_V2_WORKSPACE, SYSTEM_USER, {
  objectiveStatement: "无卡夹具目标：只靠笔记原稿开一轮",
  publicSummary: "无卡夹具",
});
// 来源行（learning_objective_origins_v2 的 note 行）**不是**目标自身带的：它由笔记依据那套
// 夹具写。没有它，按 noteId 收窄会一条都取不到——夹具缺口，不是查询的错。
await seedObjectiveNoteEvidence(pgSql, {
  workspaceId: PURE_V2_WORKSPACE, userId: SYSTEM_USER, ...CARDLESS,
});
const [{ withWorkspaceTransaction }, { buildLearningDashboardV2 }, { listObjectiveSurfacesV3 }, { buildTopologySnapshotV3 }] =
  await Promise.all([
    import("../db/client.ts"),
    import("../modules/learning-dashboard/service.ts"),
    import("../modules/learning-objectives/surface-service.ts"),
    import("../modules/understanding-v3/topology-repository.ts"),
  ]);

after(async () => {
  await pureV2.cleanup();
  await pgSql.end({ timeout: 2 });
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("RL-01: Home/Cards/Graph 的 active Objective 数量完全一致", async () => {
  const ctx = { workspaceId: PURE_V2_WORKSPACE, userId: SYSTEM_USER };
  const [dashboard, listPage, topology, objectiveCount] = await withWorkspaceTransaction(
    ctx,
    async (tx) => {
      // 注意：postgres.js 的事务连接不允许多条查询流并发交错（会导致
      // drizzle 构建器状态损坏 → orderSelectedFields 无限递归），必须顺序执行。
      const d = await buildLearningDashboardV2(tx, ctx);
      const l = await listObjectiveSurfacesV3(tx, ctx, { limit: 100 });
      const t = await buildTopologySnapshotV3(tx, ctx);
      // 独立对账计数：走 postgres-js 客户端而非本文件的 drizzle `sql` 标签
      // （tsx 模块图下该文件静态解析到的 drizzle 实例与 db/client 的不一致，
      // 其 SQL 对象传入事务会触发 getSQL 缺失/orderSelectedFields 无限递归，
      // 2026-08-23 审查；服务内部与同文件普通列查询不受影响）。
      const cntRows = await pgSql`
        SELECT count(*)::int AS n FROM learning_objectives_v2
        WHERE workspace_id = ${PURE_V2_WORKSPACE} AND lifecycle = 'active'
      `;
      const objectiveCountN = Number(cntRows[0]?.n ?? 0);
      return [d, l, t, objectiveCountN] as const;
    },
  );

  const dashboardCount = dashboard.counts.activeObjectives;
  const listTotal = listPage.total;
  // Graph 含 archived/superseded 历史节点（§36.5 可选历史层）——parity 只对账 active
  const graphActiveNodes = topology.nodes.filter(
    (n) =>
      n.nodeRef.kind === "objective" &&
      (n as { lifecycle?: string }).lifecycle === "active",
  ).length;
  assert.equal(
    dashboardCount,
    listTotal,
    "Dashboard.activeObjectives 必须等于 Cards list total",
  );
  assert.equal(listTotal, graphActiveNodes, "Cards list total 必须等于 Graph active objective 节点数");
  assert.equal(graphActiveNodes, objectiveCount, "Graph active 节点数必须等于 objectives 表 active 计数");
  assert.ok(dashboardCount >= 3, "纯 V2 fixture 至少有 3 个 active Objective");
});

test("RL-01: 每个 active Objective 都能装配可行动、无泄漏 Surface", async () => {
  const ctx = { workspaceId: PURE_V2_WORKSPACE, userId: SYSTEM_USER };
  const { assembleObjectiveSurfaceV3 } = await import("../modules/learning-objectives/surface-service.ts");
  await withWorkspaceTransaction(ctx, async (tx) => {
    const rows = await tx
      .select({ objectiveId: learningObjectivesV2.objectiveId })
      .from(learningObjectivesV2)
      .where(and(
        eq(learningObjectivesV2.workspaceId, PURE_V2_WORKSPACE),
        eq(learningObjectivesV2.lifecycle, "active"),
      ));
    for (const row of rows) {
      const surface = await assembleObjectiveSurfaceV3(tx, ctx, row.objectiveId);
      assert.equal(surface.objectiveId, row.objectiveId, "Surface objectiveId 必须与 inventory 一致");
      assert.ok(
        // W4-2（2026-09-25）：`refresh` 从这一档里删掉。它过去是"active 但没有卡"的
        // 落点——一个只会重新读取的主行动，正是这条断言当时该红却没红的地方。
        surface.primaryAction.kind === "create_run" || surface.primaryAction.kind === "resume_run",
        "active Objective 主行动必须真的能开一轮，实际 " + surface.primaryAction.kind,
      );
      assert.deepEqual(findPrivatePayloadLeaks(surface), [], "Surface 不得泄漏私有载荷");
    }
    // 分母自证：这一屏里必须**真的**扫到过那个无卡目标，否则上面那条收紧是空跑。
    assert.ok(rows.some((row) => row.objectiveId === CARDLESS.objectiveId),
      "夹具里种的无卡 active 目标没进对账清单（计数四件套也就没对过它）");
    const cardlessSurface = await assembleObjectiveSurfaceV3(tx, ctx, CARDLESS.objectiveId);
    assert.equal(cardlessSurface.primaryAction.kind, "create_run",
      "无卡目标的主动作必须是「开始学习」，不是 refresh");
    if (cardlessSurface.primaryAction.kind === "create_run") {
      assert.equal(cardlessSurface.primaryAction.label, "开始学习");
      assert.deepEqual(cardlessSurface.primaryAction.start.originV2,
        { kind: "today", objectiveId: CARDLESS.objectiveId },
        "无卡目标开的那一轮走的必须是无卡那种 origin");
    }
  });
});

/**
 * 39d W4-2 第三刀：列表要能**按笔记收窄**（笔记页要报"这一篇的主要动作"）。
 * 两侧都断言：命中的那一篇拿到完整清单，另一篇笔记的清单里不许混进别人的目标。
 * 夹具自证也在里面——那条无卡目标必须真的带 note origin，否则这条用例等于在测空集。
 */
test("RL-01: 按 noteId 收窄目标清单（命中一篇、不串另一篇、total 同口径）", async () => {
  const ctx = { workspaceId: PURE_V2_WORKSPACE, userId: SYSTEM_USER };
  const { listObjectiveSurfacesV3 } = await import("../modules/learning-objectives/surface-service.ts");
  await withWorkspaceTransaction(ctx, async (tx) => {
    const scoped = await listObjectiveSurfacesV3(tx, ctx, { limit: 100, noteId: CARDLESS.noteId });
    assert.deepEqual(scoped.items.map((item) => item.objectiveId), [CARDLESS.objectiveId],
      "这一篇笔记名下应当只有夹具种的那个目标");
    assert.equal(scoped.total, 1, "total 必须跟着筛选走（否则出现「筛出 0 条却报共 3 条」）");

    const all = await listObjectiveSurfacesV3(tx, ctx, { limit: 100 });
    assert.ok(all.items.length > 1, "正控制：不带 noteId 时应当看到多于一条（否则这条用例没在测收窄）");
    assert.ok(all.items.some((item) => item.objectiveId === CARDLESS.objectiveId));
  });
});

/**
 * 39d W4-2 第三刀收尾（§3.2 第三种情况）：最近一轮判成明显缺口时，那个动词换成
 * 「接着弄懂上次没弄通的地方」——而**四块屏必须换成同一个词**。
 *
 * 这条用例存在的全部理由是：这一档的判据要喂进四个装配处（详情页单装配、列表批装配、
 * 星图批装配、首页焦点），四处各自"看 latestResult 判一下"迟早只对上一半，
 * 症状是同一张卡在两块屏上印着两个动词。所以这里造**一条真落库的 completed run**
 * （`result.outcome = needs_repair`），四个读点逐个读回来对同一句。
 *
 * 控制端点是那个**没有轮次**的目标：它必须还说「开始学习」，否则这条用例
 * 只是在测"所有目标都说缺口词"。
 */
test("RL-01: 最近一轮的缺口词在四块屏上是同一句（没答过的那一个仍说开始学习）", async () => {
  const ctx = { workspaceId: PURE_V2_WORKSPACE, userId: SYSTEM_USER };
  const { randomUUID } = await import("node:crypto");
  const runId = randomUUID();
  await pgSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${PURE_V2_WORKSPACE}, true)`;
    await tx`SELECT set_config('app.user_id', ${SYSTEM_USER}, true)`;
    // origin 走 `today`：这就是无卡目标真开一轮时服务端写进去的那个形状
    // （`startRunOriginV2`），换成 card 形状会在这一篇上造出应用产不出的行。
    await tx`INSERT INTO learning_runs (id, workspace_id, user_id, origin, return_target,
                                        target_fingerprint, goal, phase, result)
      VALUES (${runId}, ${PURE_V2_WORKSPACE}, ${SYSTEM_USER},
              ${tx.json({ kind: "today", objectiveId: CARDLESS.objectiveId })},
              ${tx.json({ kind: "note", noteId: CARDLESS.noteId })},
              ${"b".repeat(64)}, 'stabilize', 'completed',
              ${tx.json({ outcome: "needs_repair" })})`;
  });

  // `buildLearningDashboardV2`／`listObjectiveSurfacesV3`／`buildTopologySnapshotV3`
  // 是本文件顶部就引进来的那三个读点，这里不再另开一条 import 路径。
  const { assembleObjectiveSurfaceV3 } =
    await import("../modules/learning-objectives/surface-service.ts");

  const GAP = "接着弄懂上次没弄通的地方";
  const reads = await withWorkspaceTransaction(ctx, async (tx) => {
    const detail = await assembleObjectiveSurfaceV3(tx, ctx, CARDLESS.objectiveId);
    const listPage = await listObjectiveSurfacesV3(tx, ctx, { limit: 100 });
    const topology = await buildTopologySnapshotV3(tx, ctx);
    const dashboard = await buildLearningDashboardV2(tx, ctx);
    const controlId = pureV2.objectiveIds[0];
    const control = await assembleObjectiveSurfaceV3(tx, ctx, controlId);
    return {
      detail: detail.primaryAction,
      list: listPage.items.find((item) => item.objectiveId === CARDLESS.objectiveId)?.primaryAction ?? null,
      // 拓扑节点是一个按 `nodeRef.kind` 分的联合，`personal` 只在 objective 那一支上；
      // `.find` 的谓词不会替结果收窄，所以这里显式用 `in` 判一次。
      graph: (() => {
        const node = topology.nodes.find((item) => item.nodeRef.kind === "objective"
          && item.nodeRef.objectiveId === CARDLESS.objectiveId);
        return node && "personal" in node ? node.personal.primaryAction : null;
      })(),
      focus: dashboard.primaryFocus?.objective.objectiveId === CARDLESS.objectiveId
        ? dashboard.primaryFocus.action
        : null,
      controlDetail: control.primaryAction,
      controlList: listPage.items.find((item) => item.objectiveId === controlId)?.primaryAction ?? null,
    };
  });

  // 分母自证：首页焦点这一读**今天可能就不落在这个目标上**（焦点按紧迫度选），
  // 读不到就不许把"四块屏一致"当成已经对过——它得红成"这一读没参与"。
  assert.ok(reads.focus !== null,
    "首页 primaryFocus 没落在那个有缺口的目标上：这条断言四缺一，先修夹具再谈一致");
  for (const [where, action] of [["详情", reads.detail], ["列表", reads.list],
    ["星图", reads.graph], ["首页", reads.focus]] as const) {
    assert.ok(action !== null, `${where}没读到那个目标的主动作`);
    assert.equal(action.kind, "create_run", `${where}上缺口那一档应当还是 create_run，实际 ${action.kind}`);
    assert.ok(action.kind === "create_run");
    assert.equal(action.label, GAP, `${where}上的动词与另外几块屏不一致`);
    assert.deepEqual(action.start.originV2, { kind: "today", objectiveId: CARDLESS.objectiveId },
      `${where}：换了动词不许顺手换开出去那一轮的 origin`);
  }

  // 控制端点：另一篇没答过的目标仍说「开始学习」。
  assert.ok(reads.controlDetail.kind === "create_run" && reads.controlList?.kind === "create_run");
  assert.equal(reads.controlDetail.label, "开始学习", "控制目标被误判成有缺口");
  assert.equal(reads.controlList.label, "开始学习");
});
