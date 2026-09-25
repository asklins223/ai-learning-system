/**
 * 伴星的学习统计读数 vs 首页读数（39b §9.8；39d W2-3）。
 *
 * 为什么要有这一支：`companion_get_learning_stats` 的描述曾经自称"与首页同一口径"——
 * 那是一条**需要断言的关系**，不是注释。这一支把能对账的三项写成等式：
 *
 *   noteCount（笔记数） / activeCards（活跃卡数） / dueReviews（到期复习数）
 *
 * 另两项（今日/本周时长）在首页那侧没有同源对象：`learning_metrics_events` 在
 * `apps/api/src/modules` 全域零命中（39d §18.1 第 3 条），所以**断言只写这三项**，
 * 描述里那半句已经删掉。
 *
 * 两侧各跑**各自进程里的真实现**：首页走 `getStatsOverview`（本进程），她那一侧走
 * 判据桥的 `stats` 模式（`workers/ai-worker`，受限角色 `DATABASE_URL_WORKER`）——
 * 跨包 import 会把对方的依赖图拖进来，而口径对账要的恰恰是"各自包里的那一份"。
 *
 * 夹具写用 `DATABASE_URL`（超级用户）；这一支不写 RLS 断言（另见
 * `companion-turn-facts-postgres.integration.ts` 的角色纪律）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const CONN = process.env.DATABASE_URL;
if (!CONN) {
  throw new Error("伴星统计对账集测要求 DATABASE_URL（要造排程与卡）");
}
const sql = postgres(CONN, { max: 3 });
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const { seedV2Fixture, addV2ObjectiveToWorkspace } = await import("./helpers/v2-card-fixture.ts");
const { getStatsOverview } = await import("../modules/stats/service.ts");

interface Seeded {
  workspaceId: string;
  userId: string;
  noteId: string;
  objectiveId: string;
  cardId: string;
  cleanup: () => Promise<void>;
}

let owner: Seeded;
let memberId = "";

/** 与她那一侧的读法同事务：夹具写走超级用户，被测读数由判据桥换受限角色。 */
async function insertSchedule(
  target: { workspaceId: string; userId: string | null; objectiveId: string },
  opts: { dueHours: number },
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${target.workspaceId}, true)`;
    await tx`INSERT INTO review_schedules
      (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at,
       interval_days, generation, policy_version, reason_code, created_at, updated_at)
      VALUES (${randomUUID()}, ${target.workspaceId}, ${target.userId}, 'card', ${target.objectiveId},
              'pending', now() + (${opts.dueHours} * interval '1 hour'),
              1, 1, 'w23-parity', 'fixture', now(), now())`;
  });
}

/** 她那一侧的真读数（worker 进程、受限角色、产品自己的读事务）。 */
function companionStats(workspaceId: string, userId: string): {
  noteCount: number; activeCards: number; dueReviews: number;
} {
  const runner = `${REPO_ROOT}workers/ai-worker/node_modules/.bin/tsx`;
  const bridge = `${REPO_ROOT}workers/ai-worker/scripts/companion-gate-eval.ts`;
  assert.ok(existsSync(runner), `判据桥的运行器不在：${runner}`);
  // `--tsconfig` 显式给：桥 import 的是 `@ailearn/shared/*` 的实时源码，缺这一条时
  // tsx 会退回 worker 的 `node_modules/@ailearn/shared` 安装期快照（新文件不在里面）。
  const out = execFileSync(runner, [
    "--tsconfig", `${REPO_ROOT}workers/ai-worker/tsconfig.json`,
    bridge,
  ], {
    input: JSON.stringify({
      mode: "stats",
      turns: [{ runId: randomUUID(), workspaceId, userId }],
    }),
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL_WORKER: process.env.DATABASE_URL_WORKER
        ?? "postgres://ailearn_worker:ailearn_dev@127.0.0.1:5432/ailearn",
    },
  });
  const parsed = JSON.parse(out) as { turns: { stats: { noteCount: number; activeCards: number; dueReviews: number } }[] };
  return parsed.turns[0].stats;
}

before(async () => {
  owner = await seedV2Fixture(sql) as Seeded;
  // 第二位成员：他的一篇**私有**笔记里长出来的卡，排程却挂在 owner 名下——
  // 这正是两个口径分岔的地方（首页那张卡"可消费"，而她的卡片可见性把它挡掉）。
  memberId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${owner.workspaceId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${memberId}, ${`parity-member-${memberId.slice(0, 8)}@x.test`}, 'h', 'member')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${owner.workspaceId}, ${memberId}, 'member')`;
  });
  const added = await addV2ObjectiveToWorkspace(sql, owner.workspaceId, memberId, {
    objectiveStatement: "成员的私有目标",
    publicSummary: "成员的私有目标",
  });

  // 三条排程：本人的到点、本人的未到点、以及 owner 名下但**卡的来源笔记是成员的私有笔记**那条。
  //
  // 第三条是两个口径今天唯一会分岔的地方（实测 `review_schedules.user_id` 是 NOT NULL、
  // 库里 0 行 NULL，所以"系统级排程"那一支不成立）：首页的"待复习"谓词只判"卡可消费"
  // （目标 active + 活卡 + 来源笔记没进回收站），不判来源笔记的归属；她那一侧还要过
  // `visibleCompanionCardSourceCondition`。
  await insertSchedule(
    { workspaceId: owner.workspaceId, userId: owner.userId, objectiveId: added.objectiveId },
    { dueHours: -1 },
  );
});

after(async () => {
  if (memberId) {
    await sql`DELETE FROM workspace_members WHERE workspace_id = ${owner.workspaceId} AND user_id = ${memberId}`
      .catch(() => undefined);
    await sql`DELETE FROM users WHERE id = ${memberId}`.catch(() => undefined);
  }
  for (const target of [owner]) {
    if (target) await target.cleanup();
  }
  await sql.end({ timeout: 2 }).catch(() => undefined);
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("同一时刻，她的三项读数与首页逐项相等（含「卡的来源笔记是别人私有笔记」那条）", async () => {
  const overview = await getStatsOverview(owner.workspaceId, owner.userId);
  const hers = companionStats(owner.workspaceId, owner.userId);

  assert.equal(
    hers.noteCount,
    overview.noteCount,
    `笔记数对不上：她 ${hers.noteCount} / 首页 ${overview.noteCount}`,
  );
  assert.equal(
    hers.activeCards,
    overview.activeCardCount,
    `活跃卡数对不上：她 ${hers.activeCards} / 首页 ${overview.activeCardCount}`,
  );
  assert.equal(
    hers.dueReviews,
    overview.pendingReviewCount,
    `到期数对不上：她 ${hers.dueReviews} / 首页 ${overview.pendingReviewCount}`
      + "（她看到的必须是用户点进复习队列能看到的那个数）",
  );
});

test("正向对照：把到点的推到未来，两个数一起回落到只剩未到点那条", async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${owner.workspaceId}, true)`;
    await tx`UPDATE review_schedules SET next_review_at = now() + interval '9 days'
             WHERE workspace_id = ${owner.workspaceId} AND next_review_at <= now()`;
  });
  const overview = await getStatsOverview(owner.workspaceId, owner.userId);
  const hers = companionStats(owner.workspaceId, owner.userId);
  assert.equal(overview.pendingReviewCount, 0, "推到 9 天之后首页还有数——到点那一半没判");
  assert.equal(hers.dueReviews, 0, "她那一侧还留着到点的数");
  assert.equal(hers.dueReviews, overview.pendingReviewCount);
});
