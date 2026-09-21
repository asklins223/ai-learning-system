/**
 * 日记入队窗口的实库回归（0251 放宽窗口的两条前置不变量）。
 *
 * `ailearn_enqueue_companion_daily_summaries()` 以前只在**本地 01:00 那一小时**投 job，
 * worker 跨过那一小时不可达（部署、宿主机休眠）就永久缺那一天——只读路由按 §16.6
 * 有意不补生成，用户没有自救手段。0251 把窗口放宽到本地 1..6 点，放宽的前提是两条：
 *   1. 窗口外仍然一条都不投（否则"每天一篇"变成"每小时一篇"）；
 *   2. 窗口内反复 tick 也只投一条（幂等键 `daily-summary:<ws>:<user>:<date>`）。
 * 这两条以前都没有覆盖：窗口只有一小时，从未被跨小时验证过。
 *
 * 时区是测试自己挑的：按当前时刻从固定表里选一个本地钟点在 1..6 的、一个不在的，
 * 所以断言不依赖跑测试的墙上时间。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const CONN = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!CONN) {
  throw new Error("DATABASE_URL_API 未配置——日记入队窗口集成测试要求真实 Postgres");
}

const sql = postgres(CONN, { max: 2 });
const userId = randomUUID();
const workspaceId = randomUUID();
const prefix = userId.slice(0, 8);

/**
 * 覆盖 UTC-12..UTC+13 全部 26 个整点偏移（用 `Etc/GMT±N`，注意符号是反的），
 * 所以任意时刻都能挑到"落在放宽段 2..6 里"和"落在窗口外"的两个时区——
 * 断言不依赖跑测试的墙上时间。
 *
 * 为什么必须挑 2..6 而不是 1 点：1 点旧代码也入队，用它测不出放宽有没有生效。
 */
function zoneAtOffset(offsetHours: number): string {
  if (offsetHours === 0) return "Etc/UTC";
  return offsetHours > 0 ? `Etc/GMT-${offsetHours}` : `Etc/GMT+${-offsetHours}`;
}
function localHour(zone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hour: "2-digit", hour12: false,
  }).format(new Date())) % 24;
}
const OFFSETS = Array.from({ length: 26 }, (_unused, i) => i - 12);
const widenedZone = OFFSETS.map(zoneAtOffset).find((z) => { const h = localHour(z); return h >= 2 && h <= 6; });
const outsideZone = OFFSETS.map(zoneAtOffset).find((z) => { const h = localHour(z); return h < 1 || h > 6; });
assert.ok(widenedZone && outsideZone, "时区表必须同时覆盖放宽段与窗口外");

/** 和调度器同一句算法，不在 JS 里重算时区。 */
async function yesterdayLocal(zone: string): Promise<string> {
  const rows = await sql`SELECT to_char((now() AT TIME ZONE ${zone}::text)::date - 1, 'YYYY-MM-DD') AS d`;
  return String(rows[0].d);
}

async function setZone(zone: string): Promise<void> {
  await sql`UPDATE user_companion_account_state SET quiet_hours = jsonb_build_object('timezone', ${zone}::text) WHERE user_id = ${userId}`;
}

async function jobCount(dateKey: string): Promise<number> {
  const rows = await sql`
    SELECT count(*)::int n FROM jobs
    WHERE workspace_id = ${workspaceId} AND requested_by = ${userId}
      AND type = 'companion_daily_summary' AND idempotency_key = ${`daily-summary:${workspaceId}:${userId}:${dateKey}`}
  `;
  return rows[0]?.n ?? 0;
}

after(async () => {
  await sql`DELETE FROM jobs WHERE workspace_id = ${workspaceId}`.catch(() => {});
  await sql`DELETE FROM notes WHERE workspace_id = ${workspaceId}`.catch(() => {});
  await sql`DELETE FROM user_companion_account_state WHERE user_id = ${userId}`.catch(() => {});
  await sql`DELETE FROM workspace_members WHERE user_id = ${userId}`.catch(() => {});
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`.catch(() => {});
  await sql`DELETE FROM users WHERE id = ${userId}`.catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
});

await sql`
  INSERT INTO users (id, email, password_hash, role)
  VALUES (${userId}, ${`diary-tick-${prefix}@example.test`}, 'test-hash', 'owner')
`;
await sql`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, 'diary-tick-ws', ${userId})`;
await sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
await sql`
  INSERT INTO user_companion_account_state (user_id, global_enabled, quiet_hours)
  VALUES (${userId}, true, jsonb_build_object('timezone', 'Etc/UTC'))
`;
// 活跃判据：昨天（用户本地日）有一篇新建笔记，否则调度器会直接跳过这个人。
// 钟点取当地正午，保证落在窗口中间，不贴边界。
const seedDateKey = await yesterdayLocal(widenedZone!);
await sql`
  INSERT INTO notes (id, workspace_id, title, title_source, created_by, created_at, updated_at)
  VALUES (gen_random_uuid(), ${workspaceId}, ${`diary-tick-${prefix}`}, 'manual', ${userId},
          (${seedDateKey}::date + interval '12 hours') AT TIME ZONE ${widenedZone!}::text,
          (${seedDateKey}::date + interval '12 hours') AT TIME ZONE ${widenedZone!}::text)
`;

test("窗口外的本地钟点：一次 job 都不投（放宽不等于全天放行）", async () => {
  await setZone(outsideZone!);
  await sql`SELECT public.ailearn_enqueue_companion_daily_summaries()`;
  assert.equal(await jobCount(await yesterdayLocal(outsideZone!)), 0,
    `本地 ${localHour(outsideZone!)} 点在 1..6 之外，不该入队`);
});

test("放宽段（本地 2–6 点）：首次 tick 入队，之后的 tick 靠幂等键不再重复", async () => {
  await setZone(widenedZone!);
  const dateKey = await yesterdayLocal(widenedZone!);
  await sql`SELECT public.ailearn_enqueue_companion_daily_summaries()`;
  assert.equal(await jobCount(dateKey), 1, "旧代码只认本地 1 点，2–6 点这一段必须也入队");

  // 放宽窗口的全部风险都在这一句：01:00 投过之后 02:00–06:59 每个 tick 都会再跑到这里。
  await sql`SELECT public.ailearn_enqueue_companion_daily_summaries()`;
  await sql`SELECT public.ailearn_enqueue_companion_daily_summaries()`;
  assert.equal(await jobCount(dateKey), 1, "同一本地日反复 tick 仍只有一条 job（幂等键兜住）");
});

/**
 * 本地日窗口的类型陷阱（0251 一并修掉的那半）。
 *
 * `d::date AT TIME ZONE tz` 在 Postgres 里得到的是 **timestamp without time zone**
 * （先把 date 按会话时区升成 timestamptz，再折算成该时区的墙上时间），
 * 与 timestamptz 列比较时又被按会话时区读回去 —— 整个窗口平移一个时区差，
 * 于是"09-20 的日记"讲的是 09-20 16:00 到 09-21 16:00。
 * 正确写法 `d::date::timestamp AT TIME ZONE tz` 才是"该地零点的那一刻"。
 */
test("本地日窗口：边界必须是 timestamptz，且上海时区的 09-20 从 UTC 16:00 起算", async () => {
  const rows = await sql`
    SELECT pg_typeof(('2026-09-20'::date::timestamp AT TIME ZONE 'Asia/Shanghai'))::text right_type,
           pg_typeof(('2026-09-20'::date AT TIME ZONE 'Asia/Shanghai'))::text wrong_type,
           to_char(('2026-09-20'::date::timestamp AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') right_start,
           to_char(('2026-09-20'::date AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM-DD HH24:MI') wrong_start
  `;
  const row = rows[0];
  assert.equal(row.right_type, "timestamp with time zone");
  assert.equal(row.wrong_type, "timestamp without time zone",
    "date 直接 AT TIME ZONE 得到的是无时区值——这正是平移的来源");
  assert.equal(row.right_start, "2026-09-19 16:00", `窗口起点错：${row.right_start}`);
  assert.notEqual(row.right_start, row.wrong_start, "两种写法必须给出不同的窗口，否则这条断言是空的");
});
