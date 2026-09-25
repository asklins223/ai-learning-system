/**
 * 念头候选那条 INSERT 的**库级证据**（39d #28 第三步欠的那一条，2026-09-25 补）。
 *
 * 为什么这一支值得单独存在，而不是"源码里看一眼"：`assistant_thoughts` 之前**没有任何**
 * 库级用例跑过它（写这支之前，`src/integration-tests/` 里 grep `assistant_thoughts` 零命中），
 * 而这张表恰恰有过一次"语句写得对、角色没授权"的事故——迁移 0235 的注释记着：缺 GRANT 时
 * **插入恒 0 行**、念头库看着像"她从没想过任何事"。写在大 handler 深处的那条 SQL 没有用例
 * 跑得动（要 job＋模型），所以 `insertThoughtCandidateV1` 被拎出来，让用例走**真角色、
 * 真 RLS 上下文、真 SQL**。
 *
 * 夹具里的候选是 `buildDeterministicThoughts` 现生成的，不是手抄的字段值：这支用例第一次跑
 * 就因为我手写的 `urgency: 0.4` 撞在 `urgency integer` 上（真错是 `invalid input syntax for
 * type integer`）——照类型表猜形状会猜错，从生产函数拿就不会。
 *
 * 角色纪律（doc 34 L37/L43）：夹具写走超级用户 `DATABASE_URL`，被测那一发走
 * `withWorkerWorkspaceTransaction`（= `ailearn_worker`，dev 里 NOBYPASSRLS）。
 * 注意这张表的 RLS 策略对 `ailearn_worker` **一律放行**（见第二支用例里的原文），
 * 所以这一份文件是"写得进、读得回"的证据，**不是**空间隔离的证据。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { sql as dsql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { companionLeakGateVersionV1 } from "@ailearn/shared/companion-leak-gates";
import type { ThoughtMaterial } from "../handlers/companion-thought.ts";

const ADMIN_CONN = process.env.DATABASE_URL ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
// 必须在 import `../db.ts` **之前**设好：连接串在那个模块加载时求值。
process.env.DATABASE_URL_WORKER ??= "postgres://ailearn_worker:ailearn_dev@127.0.0.1:5432/ailearn";

const admin = postgres(ADMIN_CONN, { max: 2 });
const { buildDeterministicThoughts, insertThoughtCandidateV1 } = await import("../handlers/companion-thought.ts");
const { withWorkerWorkspaceTransaction } = await import("../db.ts");

const tag = randomUUID().slice(0, 8);
const workspaceId = randomUUID();
const ownerId = randomUUID();
const strangerId = randomUUID();
const strangerWorkspaceId = randomUUID();

// 一条到期复习 → 生产那条 `review_due` 候选（urgency／familiarity_required 的取值由它定）。
const material: ThoughtMaterial = {
  today: "2026-09-25",
  readyReviews: 1,
  dueSoonReviews: 0,
  dueReviewTitles: [`夹具卡 ${tag}`],
  soonDueTitles: [],
  streakDays: 0,
  daysSinceLastLearning: null,
  familiarity: 0.1,
  petName: null,
  allowNudgeLearning: true,
  allowPlayful: false,
  catchphrase: null,
  recentlySaid: [],
  msSinceLastRoutineCue: null,
  recentThoughtEmbeddings: [],
  recentDeliveryStates: [],
  blockedDedupeKeys: new Set<string>(),
  storedCandidates: new Map<string, string>(),
  facts: null,
};
const candidates = buildDeterministicThoughts(material);
assert.ok(candidates.length > 0, "生产函数没产出候选 ⇒ 这支用例没有可写的东西（分母为空不算通过）");
// 值全部来自生产那份候选，只把 `dedupe_key` 加上本次夹具的 tag：`review_due:<今天>` 这个键
// 在 dev 库里今天已被真实调度用过，按它查会把别人的行数进来（第一版就被数成 3 条）。
const candidate = { ...candidates[0], dedupeKey: `${candidates[0].dedupeKey}-${tag}` };

await admin.begin(async (tx) => {
  await tx`INSERT INTO users (id, email, password_hash, role) VALUES
    (${ownerId}, ${`tc-owner-${tag}@x.test`}, 'h', 'owner'),
    (${strangerId}, ${`tc-stranger-${tag}@x.test`}, 'h', 'owner')`;
  await tx`INSERT INTO workspaces (id, name, owner_id, workspace_type) VALUES
    (${workspaceId}, ${`tc-${tag}`}, ${ownerId}, 'collaborative'),
    (${strangerWorkspaceId}, ${`tc-stranger-${tag}`}, ${strangerId}, 'collaborative')`;
  await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
    (${workspaceId}, ${ownerId}, 'owner'),
    (${strangerWorkspaceId}, ${strangerId}, 'owner')`;
});

after(async () => {
  await admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${ownerId}, true)`;
    await tx`DELETE FROM assistant_thoughts WHERE workspace_id IN (${workspaceId}, ${strangerWorkspaceId})`;
    await tx`DELETE FROM workspace_members WHERE workspace_id IN (${workspaceId}, ${strangerWorkspaceId})`;
    await tx`DELETE FROM workspaces WHERE id IN (${workspaceId}, ${strangerWorkspaceId})`;
    await tx`DELETE FROM users WHERE id IN (${ownerId}, ${strangerId})`;
  });
  const { closeDatabase } = await import("../db.ts");
  await closeDatabase().catch(() => undefined);
  await admin.end({ timeout: 2 }).catch(() => undefined);
});

test("候选行带着「它产出于哪一版闸」，且这一发是 ailearn_worker 真写进去的", async () => {
  const insertedId = await withWorkerWorkspaceTransaction(
    { workspaceId, userId: ownerId },
    (tx) => insertThoughtCandidateV1(tx, { workspaceId, userId: ownerId }, candidate),
  );
  assert.ok(insertedId, "RETURNING id 都没拿到 ⇒ 这条语句在真实角色下根本没跑通（0235 那一族的形状）");

  const rows = await withWorkerWorkspaceTransaction({ workspaceId, userId: ownerId }, (tx) => tx.execute<{
    leak_gate_version: string | null;
    status: string;
    source: string;
    dedupe_key: string;
    alive: boolean;
  }>(dsql`
    SELECT leak_gate_version, status, source, dedupe_key, expires_at > now() AS alive
    FROM assistant_thoughts WHERE id = ${insertedId}`));
  // 分母自证：读不到自己刚插的那一行，后面每条断言都是空的。
  assert.equal(rows.length, 1, "插完读不到这一行（RLS 上下文不对，或清理抢在了前面）");
  assert.equal(rows[0].leak_gate_version, companionLeakGateVersionV1(),
    "落库的闸版本与代码当前那份闸表不一致 ⇒ 写入侧在读别的表（或生产者那一格被摘了）");
  assert.equal(rows[0].status, "candidate");
  assert.equal(rows[0].source, "review_due");
  assert.equal(rows[0].dedupe_key, candidate.dedupeKey);
  assert.equal(rows[0].alive, true, "TTL 没落到 expires_at 上");
});

test("另一个空间的候选在 worker 角色下读得到——这一支不是隔离证据，写清楚免得被误用", async () => {
  const foreignId = await withWorkerWorkspaceTransaction(
    { workspaceId: strangerWorkspaceId, userId: strangerId },
    (tx) => insertThoughtCandidateV1(tx, { workspaceId: strangerWorkspaceId, userId: strangerId },
      { ...candidate, dedupeKey: `${candidate.dedupeKey}-foreign` }),
  );
  assert.ok(foreignId, "第二个空间那发候选没写进去 ⇒ 下面的读数没有分母");

  const seen = await withWorkerWorkspaceTransaction({ workspaceId, userId: ownerId }, (tx) => tx.execute<{ id: string }>(
    dsql`SELECT id FROM assistant_thoughts WHERE id = ${foreignId}`));
  // 策略 `assistant_thoughts_workspace_user_isolation` 的表达式是
  // `CURRENT_USER = 'ailearn_worker' OR (workspace_id = app.workspace_id AND user_id = app.user_id)`，
  // worker 那一支是**一律放行**（它本来就要跨空间把念头送出去）。所以这一支用例判的是
  // "真角色写得进、读得回"，**不能**拿来当空间隔离的证据——那句写在这里就是为了不让人误用。
  // 反过来，哪天有人收紧了那条放行，这里会红：该改的是送念头的调度，不是这条断言。
  assert.equal(seen.length, 1, "worker 读不到别空间的候选 ⇒ 跨空间调度会静默空转，形状变了先查策略");
});
