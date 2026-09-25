/**
 * 公共任务运行内核接**真租约**的集测（D5 §4.1 / 39d W3-1）。
 *
 * 单元那一层已经证明了外壳的判据（什么时候重跑、什么时候不许提交）。这一份要证的只有一件事：
 * **那道"旧尝试不许提交"的门不是测试自己造的**——它接的是产品里本来就在用的
 * `jobs.lease_token` 与 `lockJobLease`／`isJobLeaseActive`，在一个真的受限角色事务里。
 *
 * 所以这里的夹具形状全部照生产：
 *   - 写夹具用超级用户（`DATABASE_URL`，BYPASSRLS）；
 *   - 被测那三段各自 `withWorkerWorkspaceTransaction`（`ailearn_worker`，受限角色）；
 *   - 模型调用用 mock provider（**不花钱**；真模型那一手属每波末尾那一批）。
 *
 * 事务边界本身的实测（"外部等待期间不持行锁"）是 W3-2 的判据，这里刻意不做——
 * 那份证据要注入慢模型并看 `pg_stat_activity`，不该由一个 mock 冒充。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
// `tx.execute(...)` 里的 tx 是 drizzle 的，要的是 drizzle 的 sql 标签；
// 这个文件顶层那条 `sql` 是 postgres.js 的**连接**（夹具用），两者同名会撞成
// `query.getSQL is not a function`——所以这里显式起个别名。
import { sql as drizzleSql } from "drizzle-orm";
// 类型是编译期擦掉的，所以静态 import 不会破坏"连接串在 `../db.ts` 加载时求值"那件事；
// 值一律走下面的动态 import。（esbuild 不接受动态 import 的解构里带内联 `type`。）
import type { AiTaskDefinition } from "@ailearn/shared/ai-task-kernel";
import type { JobLeaseContext } from "../lib/job-lease.ts";

const ADMIN_CONN = process.env.DATABASE_URL ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_WORKER ??= "postgres://ailearn_worker:ailearn_dev@127.0.0.1:5432/ailearn";

const sql = postgres(ADMIN_CONN, { max: 2 });

const { runAiTask } = await import("@ailearn/shared/ai-task-kernel");
const { withWorkerWorkspaceTransaction, closeDatabase, currentWorkerWorkspaceTransaction } = await import("../db.ts");
const { isJobLeaseActive, lockJobLease } = await import("../lib/job-lease.ts");
const { MockProvider } = await import("../lib/providers/mock.ts");

const workspaceId = randomUUID();
const ownerId = randomUUID();

after(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${ownerId}, true)`;
    await tx`DELETE FROM companion_messages WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM companion_conversations WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM jobs WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await tx`DELETE FROM users WHERE id = ${ownerId}`;
  });
  await closeDatabase().catch(() => undefined);
  await sql.end({ timeout: 2 }).catch(() => undefined);
});

await sql.begin(async (tx) => {
  await tx`INSERT INTO users (id, email, password_hash, display_name)
           VALUES (${ownerId}, ${`kernel-it-${ownerId.slice(0, 8)}@example.test`}, ${"x"}, ${"内核集测"})`;
  await tx`INSERT INTO workspaces (id, owner_id, name) VALUES (${workspaceId}, ${ownerId}, ${"内核集测空间"})`;
  await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
           VALUES (${workspaceId}, ${ownerId}, 'owner')`;
});

/**
 * 造一条真实的 `jobs` 行并返回它。`leaseToken` 就是产品的租约令牌本身，
 * 不是测试编的字符串——换掉它等于 reaper 把这条 job 重领了一次。
 */
interface SeededJob extends JobLeaseContext {
  /** 业务落点：worker **可以**往里写的表（`companion_messages`），会话行由超级用户夹具种。 */
  conversationId: string;
}

async function seedJob(leaseToken: string): Promise<SeededJob> {
  const id = randomUUID();
  const conversationId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${ownerId}, true)`;
    await tx`
      INSERT INTO jobs (id, type, workspace_id, payload, status, attempts, lease_token,
                        requested_by, priority, resource_class, idempotency_key, started_at)
      VALUES (${id}, 'ai_task_kernel_it', ${workspaceId}, ${tx.json({})}::jsonb, 'running', 1,
              ${leaseToken}, ${ownerId}, 100, 'interactive_ai', ${`idem-${id}`}, now())
    `;
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status, next_message_seq, next_event_seq, next_generation)
             VALUES (${conversationId}, ${workspaceId}, ${ownerId}, 'dialogue', '内核集测会话', 'placeholder', 'active', 1, 1, 1)`;
  });
  return { id, workspaceId, requestedBy: ownerId, leaseToken, conversationId };
}

/** 一次运行的三段各自开了独立事务、顺序如何——用它断言"模型调用不在任何事务里"。 */
interface Trace {
  phases: string[];
  committedTitles: string[];
}

function buildDefinition(job: SeededJob, trace: Trace, titleTag: string): AiTaskDefinition<string, string> {
  const provider = new MockProvider();
  return {
    id: "kernel-it-task",
    version: 1,
    mode: "structured",
    resourceClass: "interactive_ai",
    budget: { maxModelCalls: 4, stepTimeoutMs: 2_000, taskDeadlineMs: 8_000, maxAutoRetries: 1 },
    completion: { kind: "structured_parsed" },
    usageContext: { modelId: provider.modelId, promptVersion: "it-v1", resourceClass: "interactive_ai" },
    // 短事务准备
    prepare: async () => {
      trace.phases.push("prepare");
      return await withWorkerWorkspaceTransaction({ workspaceId, userId: ownerId }, async (tx) => {
        const rows = await tx.execute<{ id: string }>(drizzleSql`SELECT id FROM jobs WHERE id = ${job.id}`);
        return rows.length > 0 ? "input" : "missing";
      });
    },
    // 事务外执行：这里**没有** tx 可拿（D5 §5.2 第一件是类型，不是纪律）
    execute: async (input) => {
      trace.phases.push("execute");
      const answer = await provider.chatCompletion(
        [{ role: "user", content: `生成一个标题：${input}` }],
        { maxTokens: 64, temperature: 0 },
      );
      return { ok: true as const, output: `${titleTag}|${answer.content.slice(0, 40)}`, promptTokens: 3, completionTokens: 2 };
    },
    // 短事务保存：租约核对与业务写入在同一个事务里（D5 §3：每个检查点、结果与下一步投递同事务形成）
    commit: async (_ctx, attemptToken, output) => {
      trace.phases.push("commit");
      // 提交的租约身份**就是尝试令牌**——生产里两者是同一条 `jobs` 行的同一列，
      // 分成两个来源就会出现"核对放过、写入拒收"这种自相矛盾的闸。
      const live: JobLeaseContext = { ...job, leaseToken: attemptToken.leaseToken };
      await withWorkerWorkspaceTransaction({ workspaceId, userId: ownerId }, async (tx) => {
        await lockJobLease(tx, live);
        // blocks 走 `JSON.stringify(...)::jsonb`：文本参数再显式 cast 才是 JSON 对象，
        // 直接丢 JS 对象会被驱动当成 Postgres 数组或双重编码成字符串标量。
        await tx.execute(drizzleSql`
          INSERT INTO companion_messages (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, content_sha256)
          VALUES (${randomUUID()}, ${workspaceId}, ${ownerId}, ${job.conversationId}, 1, 'assistant', 'text',
                  ${JSON.stringify([{ type: "text", text: output }])}::jsonb, ${"0".repeat(64)})
        `);
      });
      trace.committedTitles.push(output);
      return {
        outcome: "committed" as const, output,
        usage: { modelCalls: 1, promptTokens: 3, completionTokens: 2, elapsedMs: 0, autoRetriesUsed: 0 },
        failure: null, preservedValidResult: false, resumedFromCheckpoint: false, modelCalls: 1,
      };
    },
  };
}

const context = () => ({
  workspaceId,
  userId: ownerId,
  inputSnapshotRef: { kind: "task" as const, id: workspaceId, hash: "sha-kernel-it" },
  permissionLevel: "guided",
});
const attemptFor = (job: JobLeaseContext) => ({
  taskId: "kernel-it-task",
  taskVersion: 1,
  attemptId: randomUUID(),
  leaseToken: job.leaseToken,
  idempotencyKey: `idem-${job.id}`,
  workspaceId,
  userId: ownerId,
});

test("接真租约跑通一段：prepare→execute→commit 各自一个事务，业务行落在库里", async () => {
  const job = await seedJob(`lease-${randomUUID().slice(0, 8)}`);
  const trace: Trace = { phases: [], committedTitles: [] };
  const receipt = await runAiTask(buildDefinition(job, trace, "ok"), {
    ctx: context(),
    attempt: attemptFor(job),
    currentActiveTransaction: currentWorkerWorkspaceTransaction,
    verifyAttempt: (attempt) => isJobLeaseActive({ ...job, leaseToken: attempt.leaseToken }),
  });
  assert.equal(receipt.outcome, "committed", `没跑通：${JSON.stringify(receipt.failure)}`);
  assert.deepEqual(trace.phases, ["prepare", "execute", "commit"], "三段该各自独立，中间不该嵌在一个事务里");
  const rows = await sql`SELECT blocks FROM companion_messages WHERE workspace_id = ${workspaceId}`;
  assert.equal(rows.length, 1);
  assert.match(JSON.stringify(rows[0].blocks), /ok\|/, "落库的正文该是模型那一步产出的内容");
  assert.equal(receipt.usage.modelCalls, 1);
});

test("reaper 重领之后，旧令牌的晚到结果提交不出去（真 `jobs` 行说的，不是测试说的）", async () => {
  const job = await seedJob(`lease-${randomUUID().slice(0, 8)}`);
  const before = await sql`SELECT count(*)::int AS n FROM companion_messages WHERE workspace_id = ${workspaceId}`;
  const trace: Trace = { phases: [], committedTitles: [] };
  const definition = buildDefinition(job, trace, "stale");
  // 结果拿到的那一刻租约被换掉——D5 §4.3 的"worker 租约过期、旧结果晚到"那一行。
  const originalExecute = definition.execute;
  definition.execute = async (input, env) => {
    await sql`UPDATE jobs SET lease_token = ${"lease-taken-by-reaper"} WHERE id = ${job.id}`;
    return originalExecute(input, env);
  };
  const receipt = await runAiTask(definition, {
    ctx: context(),
    attempt: attemptFor(job),
    currentActiveTransaction: currentWorkerWorkspaceTransaction,
    verifyAttempt: (attempt) => isJobLeaseActive({ ...job, leaseToken: attempt.leaseToken }),
  });
  assert.equal(receipt.outcome, "failed");
  assert.equal(receipt.failure?.class, "lease_lost", `该拒收的是租约这一格，实际是 ${JSON.stringify(receipt.failure)}`);
  assert.equal(trace.committedTitles.length, 0);
  assert.ok(!trace.phases.includes("commit"), "提交段根本不该开始");
  // 钱已经花过：结果留在回执里，调用方可以选择"这一份丢弃、按新尝试重投"，
  // 但**不许**写进业务表（那会把旧数据盖到新尝试的轮次上）。
  assert.ok(receipt.preservedValidResult);
  const after = await sql`SELECT count(*)::int AS n FROM companion_messages WHERE workspace_id = ${workspaceId}`;
  assert.equal(after[0].n, before[0].n, "旧尝试往业务表写了一行");
});

test("第二道闸独立成立：没有 verifyAttempt 时，提交事务里的行锁照样拒收", async () => {
  // 上面那道是内核层的"提交前核对"。这一条要证明**它不是唯一的闸**：忘了接
  // `verifyAttempt` 的调用方，仍会被 `lockJobLease` 挡在业务事务里——
  // 两道闸一道是外壳给的，一道是库里本来就在的。
  const job = await seedJob(`lease-${randomUUID().slice(0, 8)}`);
  const before = await sql`SELECT count(*)::int AS n FROM companion_messages WHERE workspace_id = ${workspaceId}`;
  const trace: Trace = { phases: [], committedTitles: [] };
  const definition = buildDefinition(job, trace, "double-fence");
  const originalExecute = definition.execute;
  definition.execute = async (input, env) => {
    await sql`UPDATE jobs SET lease_token = ${"lease-taken-by-reaper-2"} WHERE id = ${job.id}`;
    return originalExecute(input, env);
  };
  const receipt = await runAiTask(definition, { ctx: context(), attempt: attemptFor(job), currentActiveTransaction: currentWorkerWorkspaceTransaction });
  assert.equal(trace.phases.includes("commit"), true, "这一条走的就是'核对没接上、提交段开始了'的形状");
  assert.equal(receipt.outcome, "failed");
  assert.equal(trace.committedTitles.length, 0);
  const after = await sql`SELECT count(*)::int AS n FROM companion_messages WHERE workspace_id = ${workspaceId}`;
  assert.equal(after[0].n, before[0].n, "行锁那道闸没挡住旧尝试");
});

test("取消落在提交之前：库里一行都不留", async () => {
  // 与上面两条对着读：取消与旧租约**结果一样**（都不提交），但类别不一样——
  // 用户按的是停止，不是"这一步没做好"，所以它既不重试也不算失败重跑。
  const job = await seedJob(`lease-${randomUUID().slice(0, 8)}`);
  const controller = new AbortController();
  const before = await sql`SELECT count(*)::int AS n FROM companion_messages WHERE workspace_id = ${workspaceId}`;
  const trace: Trace = { phases: [], committedTitles: [] };
  const definition = buildDefinition(job, trace, "cancel");
  definition.execute = async () => {
    controller.abort();
    return { ok: true as const, output: "不该被提交", promptTokens: 0, completionTokens: 0 };
  };
  const receipt = await runAiTask(definition, {
    ctx: { ...context(), signal: controller.signal },
    attempt: attemptFor(job),
    currentActiveTransaction: currentWorkerWorkspaceTransaction,
    verifyAttempt: (attempt) => isJobLeaseActive({ ...job, leaseToken: attempt.leaseToken }),
  });
  assert.equal(receipt.outcome, "cancelled");
  assert.equal(trace.committedTitles.length, 0);
  const after = await sql`SELECT count(*)::int AS n FROM companion_messages WHERE workspace_id = ${workspaceId}`;
  assert.equal(after[0].n, before[0].n, "取消之后仍然写了业务行");
});

/**
 * 39d W3-2 的判据之一：**注入慢外部调用，真去看锁与并发写**（39c §5.2 末句明写
 * "验收不是只检查函数名或新增 `isolated:true`"）。
 *
 * 两条一起才算测出来：
 *   - 负对照先证明**这套探针看得见阻塞**（同一行被一个开着的事务 `FOR UPDATE` 钉住时，
 *     并发写立刻撞 `lock_timeout`）。少了这条，正向"没被钉住"可以靠"探针根本没在看"糊过去。
 *   - 正向跑内核的三段形状：`prepare` 里锁完就提交（锁随事务释放），慢调用发生在
 *     两个事务**之间** ⇒ 并发写不等它。
 *
 * 慢的那一段是**假**的（`setTimeout`），不是真模型：这里要量的是"外部等待期间
 * 数据库锁不跟着等"，与响应来自哪里无关。真模型 30 秒那一手属每波末尾那一次真跑。
 */
const SLOW_EXTERNAL_MS = 8_000;
const LOCK_PROBE_TIMEOUT = "500ms";

async function tryConcurrentUpdate(jobId: string): Promise<{ blocked: boolean; elapsedMs: number }> {
  const started = Date.now();
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${ownerId}, true)`;
      await tx`SELECT set_config('lock_timeout', ${LOCK_PROBE_TIMEOUT}, true)`;
      await tx`UPDATE jobs SET priority = priority WHERE id = ${jobId}`;
    });
    return { blocked: false, elapsedMs: Date.now() - started };
  } catch (err) {
    if (/canceling statement due to statement timeout|lock timeout/i.test(String(err))) {
      return { blocked: true, elapsedMs: Date.now() - started };
    }
    throw err;
  }
}

test("负对照：行锁在开着的事务里时，探针看得见并发写被钉住", async () => {
  const job = await seedJob(`lease-${randomUUID().slice(0, 8)}`);
  const holder = sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT id FROM jobs WHERE id = ${job.id} FOR UPDATE`;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const probe = await tryConcurrentUpdate(job.id);
  await holder;
  assert.equal(probe.blocked, true, "锁都持着还测得出并发写成功＝这套探针是瞎的，正向那条不可信");
  assert.ok(probe.elapsedMs < 1_400, `并发写真的等完了持锁方（${probe.elapsedMs}ms），lock_timeout 没生效`);
});

test("慢外部调用期间不持业务事务与行锁：三段形状实测（W3-2 判据）", async () => {
  const job = await seedJob(`lease-${randomUUID().slice(0, 8)}`);
  const trace: Trace = { phases: [], committedTitles: [] };
  // 这一步的预算必须**大于**假外部调用的时长，否则量不到东西：内核默认 2 秒的
  // 单步超时会在第 2 秒把它切掉（第一次跑就是这么红的——那反而是超时在生效的证据）。
  const definition = {
    ...buildDefinition(job, trace, "slow"),
    budget: { maxModelCalls: 4, stepTimeoutMs: SLOW_EXTERNAL_MS + 6_000, taskDeadlineMs: SLOW_EXTERNAL_MS + 12_000, maxAutoRetries: 1 },
  };
  const originalPrepare = definition.prepare;
  const probeTimes: number[] = [];

  definition.prepare = async (ctx, attemptToken) => {
    const input = await originalPrepare(ctx, attemptToken);
    // 锁在这一个短事务里拿、随它提交而释放——然后才是慢的那一段。
    await withWorkerWorkspaceTransaction({ workspaceId, userId: ownerId }, async (tx) => {
      await tx.execute(drizzleSql`SELECT id FROM jobs WHERE id = ${job.id} FOR UPDATE`);
    });
    return input;
  };
  definition.execute = async (input, env) => {
    const stepped = await (async () => {
      // 外部等待期间去改同一行：不该等。
      const probe = await tryConcurrentUpdate(job.id);
      probeTimes.push(probe.elapsedMs);
      assert.equal(probe.blocked, false, "慢外部调用期间，并发写被钉住了");
      await new Promise((resolve) => setTimeout(resolve, SLOW_EXTERNAL_MS));
      return { ok: true as const, output: `slow|${input}`, promptTokens: 1, completionTokens: 1 };
    })();
    void env;
    return stepped;
  };

  const started = Date.now();
  const receipt = await runAiTask(definition, {
    ctx: context(),
    attempt: attemptFor(job),
    currentActiveTransaction: currentWorkerWorkspaceTransaction,
    verifyAttempt: (attempt) => isJobLeaseActive({ ...job, leaseToken: attempt.leaseToken }),
  });
  const total = Date.now() - started;
  assert.equal(receipt.outcome, "committed");
  assert.equal(probeTimes.length, 1);
  // 并发写要在 lock_timeout 之内回来，而且远早于外部调用的耗时。
  assert.ok(probeTimes[0] < 400, `并发写花了 ${probeTimes[0]}ms——它确实在等那个外部调用`);
  assert.ok(total >= SLOW_EXTERNAL_MS, "外部调用没真等够时间，这条测量不成立");
  assert.equal(trace.committedTitles.length, 1, "提交段照常落地（不持锁不等于不提交）");
});

test("误用被边界拒绝：在真的 worker 事务里跑内核 ⇒ 一次模型都不发（隐式外层事务）", async () => {
  // 这一条是 W3-2 判据里"含隐式外层事务，不只查文本里有没有 transaction"那一手：
  // `definition.execute` 从头到尾**没有收到过任何事务对象**，它甚至在另一个文件里，
  // 挡得住它的只有 `AsyncLocalStorage` 那一个读数。
  const job = await seedJob(`lease-${randomUUID().slice(0, 8)}`);
  const trace: Trace = { phases: [], committedTitles: [] };
  const definition = buildDefinition(job, trace, "misuse");
  const reported: string[] = [];
  await assert.rejects(
    () => withWorkerWorkspaceTransaction({ workspaceId, userId: ownerId }, async (tx) => {
      await tx.execute(drizzleSql`SELECT 1`);
      return runAiTask(definition, {
        ctx: context(),
        attempt: attemptFor(job),
        currentActiveTransaction: currentWorkerWorkspaceTransaction,
        reportDevelopmentError: (message) => reported.push(message),
        verifyAttempt: (attempt) => isJobLeaseActive({ ...job, leaseToken: attempt.leaseToken }),
      });
    }),
    /外部调用被拒/,
  );
  assert.equal(trace.phases.filter((p) => p === "execute").length, 0, "边界拒了却还是把模型调出去了");
  assert.equal(trace.committedTitles.length, 0);
  assert.equal(reported.length, 1, "拒绝了但没记开发错误＝下一轮没人知道是谁在锁上等模型");
  assert.match(reported[0], /kernel-it-task@v1/);

  // 同一个定义、同一个租约，在事务**外面**跑就过得去——被拒的原因是作用域，不是定义本身。
  const cleanTrace: Trace = { phases: [], committedTitles: [] };
  const clean = await runAiTask(buildDefinition(job, cleanTrace, "misuse"), {
    ctx: context(),
    attempt: attemptFor(job),
    currentActiveTransaction: currentWorkerWorkspaceTransaction,
    verifyAttempt: (attempt) => isJobLeaseActive({ ...job, leaseToken: attempt.leaseToken }),
  });
  assert.equal(clean.outcome, "committed");
});
