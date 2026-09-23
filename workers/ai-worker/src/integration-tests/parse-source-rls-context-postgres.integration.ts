/**
 * F27 回归 —— `parse_source` 的起手读取必须带工作区上下文。
 *
 * 为什么需要这条测试：这个 bug 在超管角色下**结构上不可能被发现**。`sources` 的
 * `sec01_v1_sources_tenant_guard` 谓词是 `workspace_id = current_setting('app.workspace_id')`，
 * 没有“上下文未设置即放行”那一支；裸 `db` 句柄读它不报错，只返回 0 行。于是每一次
 * 采集都抛 `source … not found in workspace`、重试三次后 job 直接 dead，而界面上永远
 * 显示“正在解析”。dev 的 worker 早就是受限角色（`docker-compose.dev.yml` 的
 * `DATABASE_URL_WORKER`），所以线上必现、测试全绿——因为过去的测试都连的是超管库。
 *
 * 两条断言是一对的，缺一条另一条就没有意义：
 * 1. **正控**：以受限角色、不设上下文去读这一行，必须读不到。它证明挡住 handler 的是
 *    RLS 而不是“夹具没写进去”；没有它，第 2 条可能在数据根本没落库时照样绿。
 * 2. handler 跑完后来源必须是 `ready` 且有片段行——这才是用户能感知的那件事
 *    （“粘贴一段文本，几秒后能开始写笔记”）。
 *
 * 运行（真 Postgres、零 AI 调用、不出网）：
 *   DATABASE_URL_MIGRATOR=postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn \
 *   node --import tsx --test --test-timeout=120000 \
 *     workers/ai-worker/src/integration-tests/parse-source-rls-context-postgres.integration.ts
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as schema from "@ailearn/shared/db-schema";

const ADMIN_URL =
  process.env.DATABASE_URL_MIGRATOR ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_WORKER ??= "postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_API ??= ADMIN_URL;

const admin = postgres(ADMIN_URL, { max: 2 });

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const SOURCE_ID = randomUUID();
const JOB_ID = randomUUID();
const LEASE_TOKEN = randomUUID();

const RAW_TEXT = [
  "主动回忆比重新阅读更能提升长期保持，因为检索本身就是修改记忆的事件。",
  "间隔重复把复习排在快要忘但还没忘的时刻，提取难度最高而挫败最低。",
  "必要难度来自提取过程，任意困难只来自材料含糊，两者对学习的作用相反。",
].join("\n\n");

before(async () => {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`parse-source-rls-${USER_ID}@example.invalid`}, 'unused')`;
    await tx`INSERT INTO workspaces (id, name, workspace_type, owner_id)
      VALUES (${WORKSPACE_ID}, ${`ws-parse-rls-${WORKSPACE_ID.slice(0, 8)}`}, 'personal', ${USER_ID})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner', now())`;
    // 采集刚落地时的形状：status=draft，正文在 metadata.rawContent 里等 worker 分段。
    await tx`INSERT INTO sources (id, workspace_id, type, title, origin, status, metadata, created_by)
      VALUES (${SOURCE_ID}, ${WORKSPACE_ID}, 'text', ${"解析上下文回归夹具"},
              ${"pasted"}, 'draft',
              ${tx.json({ rawContent: RAW_TEXT })}, ${USER_ID})`;
    await tx`INSERT INTO jobs (id, workspace_id, type, payload, status, priority, resource_class,
                               idempotency_key, requested_by, lease_token, attempts, scheduled_at, started_at)
      VALUES (${JOB_ID}, ${WORKSPACE_ID}, 'parse_source',
              ${tx.json({ sourceId: SOURCE_ID })}, 'running', 70, 'default',
              ${`parse-source-rls:${JOB_ID}`}, ${USER_ID}, ${LEASE_TOKEN}, 1, now(), now())`;
  });
});

after(async () => {
  await admin.begin(async (tx) => {
    await tx`DELETE FROM source_segments WHERE source_id = ${SOURCE_ID}`;
    await tx`DELETE FROM jobs WHERE id = ${JOB_ID}`;
    await tx`DELETE FROM sources WHERE id = ${SOURCE_ID}`;
    await tx`DELETE FROM workspace_members WHERE workspace_id = ${WORKSPACE_ID}`;
    await tx`DELETE FROM workspaces WHERE id = ${WORKSPACE_ID}`;
    await tx`DELETE FROM users WHERE id = ${USER_ID}`;
  });
  await admin.end({ timeout: 5 });
  // handler 用的是 worker 自己那套连接池；不关掉它，两条断言全绿而进程挂到超时
  // 才会红——那时读到的失败信息是“test timed out”，看不出跟被测行为有任何关系。
  const { closeDatabase: closeWorkerDatabase } = await import("../db.ts");
  await closeWorkerDatabase().catch(() => undefined);
});

test("正控：受限角色不设上下文时，这一行来源对 worker 不可见", async () => {
  const { db, withWorkerWorkspaceTransaction } = await import("../db.ts");

  const bare = await db.query.sources.findFirst({
    where: and(
      eq(schema.sources.id, SOURCE_ID),
      eq(schema.sources.workspaceId, WORKSPACE_ID),
    ),
  });
  assert.equal(bare, undefined, "裸 db 句柄必须读不到（读到了说明这条测试连的是超管库）");

  // 同一行、同一角色，设了上下文就该看得见——差别只有 GUC。
  const scoped = await withWorkerWorkspaceTransaction(
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    (tx) => tx.query.sources.findFirst({ where: eq(schema.sources.id, SOURCE_ID) }),
  );
  assert.ok(scoped, "设了 app.workspace_id 之后同一行必须可读");
});

test("runParseSource 把文本来源解析成 ready，而不是 dead 在“找不到来源”", async () => {
  const { runParseSource } = await import("../handlers/parse-source.ts");

  await runParseSource({
    id: JOB_ID,
    workspaceId: WORKSPACE_ID,
    requestedBy: USER_ID,
    payload: { sourceId: SOURCE_ID },
    leaseToken: LEASE_TOKEN,
  });

  const [source] = await admin`SELECT status, title FROM sources WHERE id = ${SOURCE_ID}`;
  assert.equal(source.status, "ready", `来源应当解析完成，实际停在 ${source.status}`);

  const [segments] = await admin`SELECT count(*)::int AS n FROM source_segments WHERE source_id = ${SOURCE_ID}`;
  assert.ok(segments.n >= 3, `三段正文应至少切出 3 个片段，实际 ${segments.n}`);

  const [job] = await admin`SELECT status FROM jobs WHERE id = ${JOB_ID}`;
  assert.notEqual(job.status, "dead", "job 不能被判定为确定性失败");
});
