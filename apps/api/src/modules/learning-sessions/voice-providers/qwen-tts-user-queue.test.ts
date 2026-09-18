/**
 * 稳定 P0（2026-09-15）：qwen TTS 的**按用户串行 + 全局有界并发**，以及
 * **按连接身份（WS URL + apiKey）分槽**的连接池。
 *
 * 被取代的旧行为：一条模块级 promise 链（withQwenConcurrencyLimit）把所有用户的
 * 所有段落串成同一队列，并共用同一个全局连接槽——多用户服务里一个用户的合成会
 * 阻塞其他所有人，后来者还可能拿到"上一个用户的"连接（错的业务空间/错的 key）。
 *
 * 与 qwen-tts.test.ts 一样：连接池、任务名额、队列尾都是模块级共享状态，用例必须
 * 串行，故合并进单个 test 顺序执行（每场景前 resetQwenTestState）。
 * 每个启动过的任务都会在本用例内被推到底（serveTaskBody / cancel / task-failed），
 * 不留悬挂的 30s 任务计时器。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  qwenIdleConnectionCount,
  qwenTtsActiveTaskCount,
  qwenTtsQueuedKeyCount,
  qwenTtsSynthesizeStreamForUser,
  resolveQwenTtsMaxConcurrency,
  type QwenTtsOptions,
  type QwenTtsStreamResult,
} from "./qwen-tts.ts";
import {
  MockWebSocket,
  QWEN_TEST_BASE_OPTS,
  openPendingSockets,
  pumpStream,
  resetQwenTestState,
  serveTaskBody,
  settleTicks,
} from "./qwen-tts-test-doubles.ts";

/**
 * 启动一个任务并返回**真正开工的那条连接**（新建或复用都算）：等落定 → 打开
 * 新建的连接 → 再落定 → 找出发出 run-task 的连接。调用方另外断言连接数即可
 * 区分"新建"与"复用"。
 */
async function startTask(
  queueKey: string,
  text: string,
  opts: QwenTtsOptions = QWEN_TEST_BASE_OPTS,
): Promise<{ ws: MockWebSocket; result: Promise<QwenTtsStreamResult>; newConnections: number }> {
  const beforeInstances = MockWebSocket.instances.length;
  const beforeRunTasks = MockWebSocket.instances.map((ws) => ws.runTaskIds().length);
  const result = qwenTtsSynthesizeStreamForUser(queueKey, text, opts);
  await settleTicks();
  openPendingSockets();
  await settleTicks();
  const started = MockWebSocket.instances.find(
    (ws, index) => ws.runTaskIds().length > (beforeRunTasks[index] ?? 0),
  );
  assert.ok(started, `任务 ${queueKey}/${text} 预期发出 run-task 但没发`);
  return {
    ws: started,
    result,
    newConnections: MockWebSocket.instances.length - beforeInstances,
  };
}

/** 启动一个**预期被排队**的任务：只拿到 promise，由调用方在放行后 await。 */
function queueTask(
  queueKey: string,
  text: string,
  opts: QwenTtsOptions = QWEN_TEST_BASE_OPTS,
): Promise<QwenTtsStreamResult> {
  return qwenTtsSynthesizeStreamForUser(queueKey, text, opts);
}

async function withMaxConcurrency<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.QWEN_TTS_MAX_CONCURRENCY;
  process.env.QWEN_TTS_MAX_CONCURRENCY = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.QWEN_TTS_MAX_CONCURRENCY;
    else process.env.QWEN_TTS_MAX_CONCURRENCY = previous;
  }
}

const USER_A = "ws-1:userA";
const USER_B = "ws-1:userB";

test("qwen 按用户串行、全局有界并发、连接按身份分槽", async () => {
  // ─── 场景 0：上限解析（非法值回落默认，不做静默取整）────────────────
  assert.equal(resolveQwenTtsMaxConcurrency("1"), 1);
  assert.equal(resolveQwenTtsMaxConcurrency("8"), 8);
  for (const bad of ["0", "-1", "2.5", "abc", ""]) {
    assert.equal(resolveQwenTtsMaxConcurrency(bad), 4, `非法值 ${JSON.stringify(bad)} 回落默认 4`);
  }

  // ─── 场景 1：不同用户并行（旧实现下第二个会排在第一个后面）──────────
  resetQwenTestState();
  {
    const a = await startTask(USER_A, "A1");
    const b = await startTask(USER_B, "B1");
    assert.equal(a.newConnections, 1, "A 新建连接");
    assert.equal(b.newConnections, 1, "B 新建连接");
    assert.equal(MockWebSocket.instances.length, 2, "两个用户各自建连（不再共用单槽位）");
    assert.equal(a.ws.runTaskIds().length, 1, "A 的 run-task 已发出");
    assert.equal(b.ws.runTaskIds().length, 1, "B 的 run-task 已发出（未被 A 阻塞）");
    assert.equal(qwenTtsActiveTaskCount(), 2, "两个任务同时在跑");

    serveTaskBody(a.ws);
    serveTaskBody(b.ws);
    assert.equal((await pumpStream((await a.result).stream)).length, 1);
    assert.equal((await pumpStream((await b.result).stream)).length, 1);
    assert.equal(qwenTtsActiveTaskCount(), 0, "两个流都结束后名额归零");
    assert.equal(qwenTtsQueuedKeyCount(), 0, "队列尾已清理（不按用户数无限累积）");
  }

  // ─── 场景 2：同一用户严格串行，音频阶段也不重叠 ──────────────────────
  resetQwenTestState();
  {
    const a1 = await startTask(USER_A, "A1");
    a1.ws.serverEvent("task-started"); // 流已建立、音频阶段开始
    a1.ws.audioFrame();

    const a2 = queueTask(USER_A, "A2");
    await settleTicks();
    assert.equal(MockWebSocket.instances.length, 1, "同键第二段不建新连接");
    assert.equal(a1.ws.runTaskIds().length, 1, "A1 音频未结束时 A2 不得开工");
    assert.equal(qwenTtsActiveTaskCount(), 1, "排队的 A2 不占全局名额");
    assert.equal(qwenTtsQueuedKeyCount(), 1, "存在一个排队中的队列键");

    // A1 收尾 → A2 立刻在同一连接上开工（新 task_id）。
    a1.ws.serverEvent("task-finished");
    assert.equal((await pumpStream((await a1.result).stream)).length, 1, "A1 音频帧透传");
    await settleTicks();
    assert.equal(MockWebSocket.instances.length, 1, "A2 复用 A1 的连接");
    assert.equal(a1.ws.runTaskIds().length, 2, "A2 在 A1 结束后才开工");
    const [task1, task2] = a1.ws.runTaskIds();
    assert.notEqual(task1, task2, "复用连接但每次新 task_id");

    serveTaskBody(a1.ws);
    assert.equal((await pumpStream((await a2).stream)).length, 1);
    assert.equal(qwenTtsActiveTaskCount(), 0);
  }

  // ─── 场景 3：全局名额有界（不同键也受总量约束）──────────────────────
  await withMaxConcurrency("1", async () => {
    resetQwenTestState();
    const a = await startTask(USER_A, "A1");
    const b = queueTask(USER_B, "B1");
    await settleTicks();
    assert.equal(MockWebSocket.instances.length, 1, "名额=1 时 B 不得启动（即便键不同）");
    assert.equal(a.ws.runTaskIds().length, 1, "B 尚未发出 run-task");
    assert.equal(qwenTtsQueuedKeyCount(), 2, "A 在跑、B 仍在自己的队列里等");

    serveTaskBody(a.ws);
    await pumpStream((await a.result).stream);
    await settleTicks();
    // B 与 A 连接身份相同 → 复用 A 交回池子的那条连接（不新建），但必须已开工。
    assert.equal(MockWebSocket.instances.length, 1, "同身份复用连接");
    assert.equal(a.ws.runTaskIds().length, 2, "A 的流结束后名额移交 B 并开工");
    assert.equal(qwenTtsActiveTaskCount(), 1, "任一时刻至多 1 个任务");

    serveTaskBody(a.ws);
    assert.equal((await pumpStream((await b).stream)).length, 1);
    assert.equal(qwenTtsActiveTaskCount(), 0);
  });

  // ─── 场景 4：前端打断（cancel）立刻释放名额，不占住其他用户 ──────────
  await withMaxConcurrency("1", async () => {
    resetQwenTestState();
    const optsB: QwenTtsOptions = { ...QWEN_TEST_BASE_OPTS, workspaceId: "llm-space-b", apiKey: "sk-b" };
    const a = await startTask(USER_A, "A1");
    const b = queueTask(USER_B, "B1", optsB);
    await settleTicks();
    assert.equal(MockWebSocket.instances.length, 1, "B 在等名额");

    a.ws.serverEvent("task-started");
    await (await a.result).stream.cancel();
    await settleTicks();
    assert.equal(
      MockWebSocket.instances.length,
      2,
      "cancel 后名额立即移交（不等服务端 task-finished 确认）",
    );
    assert.ok(a.ws.sentActions().includes("finish-task"), "cancel 仍向服务端发 finish-task");
    // 服务端补一个 task-finished：清掉 5s 强制弃连计时器，连接回到池子。
    a.ws.serverEvent("task-finished");

    openPendingSockets(); // B 是新建连接，要等它 open 才会发出 run-task
    await settleTicks();
    const bWs = MockWebSocket.instances[1]!;
    assert.equal(bWs.runTaskIds().length, 1, "B 已开工（cancel 没有把名额吞掉）");
    serveTaskBody(bWs);
    assert.equal((await pumpStream((await b).stream)).length, 1);
    assert.equal(qwenTtsActiveTaskCount(), 0);
  });

  // ─── 场景 5：建流失败（task-failed）既还名额、也放行同键队列 ──────────
  await withMaxConcurrency("1", async () => {
    resetQwenTestState();
    const a = await startTask(USER_A, "A1");
    const a2 = queueTask(USER_A, "A2");
    await settleTicks();
    assert.equal(MockWebSocket.instances.length, 1, "A2 在同键队列上等 A1");
    assert.equal(qwenTtsActiveTaskCount(), 1);

    // task-started 之前失败 → result 直接 reject（建流失败路径）。
    a.ws.serverEvent("task-failed", { error_message: "boom" });
    await assert.rejects(() => a.result, /boom/);
    await settleTicks();
    assert.equal(qwenTtsActiveTaskCount(), 1, "名额已移交给 A2（不是泄漏成 0）");

    openPendingSockets();
    await settleTicks();
    const a2Ws = MockWebSocket.instances[1]!;
    assert.equal(a2Ws.runTaskIds().length, 1, "A1 失败后 A2 照常开工");
    serveTaskBody(a2Ws);
    assert.equal((await pumpStream((await a2).stream)).length, 1);
    assert.equal(qwenTtsActiveTaskCount(), 0, "失败任务不泄漏全局名额");
  });

  // ─── 场景 6：连接池按连接身份（URL + apiKey）分槽 ───────────────────
  resetQwenTestState();
  {
    const optsA: QwenTtsOptions = { ...QWEN_TEST_BASE_OPTS, workspaceId: "llm-space-a", apiKey: "sk-a" };
    const optsB: QwenTtsOptions = { ...QWEN_TEST_BASE_OPTS, workspaceId: "llm-space-b", apiKey: "sk-b" };

    const a1 = await startTask(USER_A, "A1", optsA);
    serveTaskBody(a1.ws);
    await pumpStream((await a1.result).stream);
    await settleTicks();
    assert.equal(qwenIdleConnectionCount(), 1, "A 身份留下一个空闲槽位");

    const b1 = await startTask(USER_B, "B1", optsB);
    assert.equal(b1.newConnections, 1, "不同身份必然新建连接");
    assert.equal(MockWebSocket.instances.length, 2, "不同身份不得复用同一个 socket");
    assert.match(b1.ws.url, /llm-space-b/, "新连接打到 B 的业务空间");
    assert.equal(b1.ws.headers.Authorization, "bearer sk-b", "新连接用 B 的 key");

    serveTaskBody(b1.ws);
    await pumpStream((await b1.result).stream);
    await settleTicks();
    assert.equal(qwenIdleConnectionCount(), 2, "两个身份各自保留一个空闲槽位");

    const a2 = await startTask(USER_A, "A2", optsA);
    assert.equal(a2.newConnections, 0, "A2 复用 A 的连接（不新建）");
    assert.equal(MockWebSocket.instances.length, 2, "回到 A 身份时复用 A 自己的连接");
    assert.equal(a2.ws, a1.ws, "复用的正是 A 之前的 socket");
    assert.equal(a1.ws.runTaskIds().length, 2);
    serveTaskBody(a1.ws);
    assert.equal((await pumpStream((await a2.result).stream)).length, 1);
    assert.equal(qwenTtsActiveTaskCount(), 0);
  }

  // ─── 场景 7：队列键为空 fail closed（不静默退回全局串行）────────────
  resetQwenTestState();
  {
    await assert.rejects(
      () => qwenTtsSynthesizeStreamForUser("", "hi", QWEN_TEST_BASE_OPTS),
      /TTS 队列键为空/,
    );
    await assert.rejects(
      () => qwenTtsSynthesizeStreamForUser("   ", "hi", QWEN_TEST_BASE_OPTS),
      /TTS 队列键为空/,
    );
    assert.equal(MockWebSocket.instances.length, 0, "非法队列键不建连、不占名额");
    assert.equal(qwenTtsActiveTaskCount(), 0);
  }

  resetQwenTestState();
});
