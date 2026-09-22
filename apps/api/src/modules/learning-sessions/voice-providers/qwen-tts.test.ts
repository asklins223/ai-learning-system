// 15b 二期：qwen TTS 连接复用（按连接身份分槽的 IDLE 池）测试。
// 覆盖：正常合成（run-task 参数含 voice/instruction）、task-finished 后连接
// 复用（不新建连接、新 task_id）、task-failed 不归还（下次新建）、流 cancel
// 发 cancel 指令并在 task-finished 后复用。
//
// 注意：node:test 顶层 test 默认并发执行，而连接池是模块级共享状态——
// 四个场景必须串行，故合并为单个 test 内顺序执行（每场景前 resetState）。
// Mock WebSocket 与公共夹具见 qwen-tts-test-doubles.ts（与本文件、以及
// qwen-tts-user-queue.test.ts 共用同一份替身，避免协议改动时两处漂移）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { qwenTtsSynthesizeStream, QwenTtsError } from "./qwen-tts.ts";
import {
  MockWebSocket,
  QWEN_TEST_BASE_OPTS,
  launchQwenTask,
  pumpStream,
  resetQwenTestState,
  serveTaskBody,
} from "./qwen-tts-test-doubles.ts";

const BASE_OPTS = QWEN_TEST_BASE_OPTS;

function startTask(
  text: string,
  opts: typeof BASE_OPTS = BASE_OPTS,
): Promise<{ ws: MockWebSocket; result: Promise<Awaited<ReturnType<typeof qwenTtsSynthesizeStream>>> }> {
  return launchQwenTask(() => qwenTtsSynthesizeStream(text, opts));
}

function pump(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  return pumpStream(stream);
}

function resetState(): void {
  resetQwenTestState();
}

// ─── 场景 1：正常合成 ────────────────────────────────────────────────────

async function scenarioNormal(): Promise<void> {
  const { ws, result } = await startTask("你好呀。");
  assert.ok(ws, "建立了连接");
  assert.equal(ws.headers.Authorization, "bearer sk-test");

  serveTaskBody(ws);
  const stream = (await result).stream;
  const chunks = await pump(stream);
  assert.equal(chunks.length, 1, "音频帧透传");

  const actions = ws.sentActions();
  assert.ok(actions.includes("run-task"));
  assert.ok(actions.includes("continue-task"));
  assert.ok(actions.includes("finish-task"));
  assert.equal(ws.continueTaskText(), "你好呀。");
  // run-task parameters 校验
  const runMsg = ws.sent.find((m) => (m as { header?: { action?: string } }).header?.action === "run-task") as {
    payload?: { parameters?: Record<string, unknown>; model?: string };
  };
  assert.equal(runMsg.payload?.parameters?.voice, "longanlingxi_v3.1");
  assert.equal(runMsg.payload?.parameters?.instruction, "可爱的年轻女性声音");
  assert.equal(runMsg.payload?.model, "qwen-audio-3.1-tts-flash");
}

// ─── 场景 2：task-finished 后连接复用 ─────────────────────────────────────

async function scenarioReuse(): Promise<void> {
  const t1 = await startTask("第一句。");
  const ws1 = t1.ws;
  serveTaskBody(ws1);
  await pump((await t1.result).stream);

  const t2 = await startTask("第二句。");
  assert.equal(MockWebSocket.instances.length, 1, "复用同一连接（未新建）");
  assert.equal(ws1.closed, false, "连接未被关闭");

  const ids = ws1.runTaskIds();
  assert.equal(ids.length, 2, "两次 run-task");
  assert.notEqual(ids[0], ids[1], "复用连接时每次使用新 task_id");

  serveTaskBody(ws1);
  await pump((await t2.result).stream);
}

// ─── 场景 3：task-failed 不归还 ──────────────────────────────────────────

async function scenarioFailed(): Promise<void> {
  const t1 = await startTask("会失败。");
  const ws1 = t1.ws;
  ws1.serverEvent("task-started");
  ws1.serverEvent("task-failed", { error_message: "boom" });

  await assert.rejects(
    async () => pump((await t1.result).stream),
    (err: unknown) => err instanceof QwenTtsError && err.code === "UPSTREAM_ERROR",
  );
  assert.equal(ws1.closed, true, "失败连接被关闭");

  const t2 = await startTask("重试。");
  assert.equal(MockWebSocket.instances.length, 2, "失败后新建连接");
  const ws2 = t2.ws;
  serveTaskBody(ws2);
  await pump((await t2.result).stream);
}

// ─── 场景 4：流 cancel → 指令 + 复用 ─────────────────────────────────────

async function scenarioCancel(): Promise<void> {
  const t1 = await startTask("要打断。");
  const ws1 = t1.ws;
  ws1.serverEvent("task-started");

  const reader = (await t1.result).stream.getReader();
  await reader.cancel(); // 前端打断

  const cancel = ws1.sent.find((m) => {
    const input = (m as { payload?: { input?: { directive?: string } } }).payload?.input;
    return input?.directive === "cancel";
  });
  assert.ok(cancel, "发送了 cancel 指令");

  // 服务端确认 task-finished → 连接归还
  ws1.serverEvent("task-finished");
  await new Promise((r) => setImmediate(r));

  const t2 = await startTask("打断后继续。");
  assert.equal(MockWebSocket.instances.length, 1, "cancel 后连接复用（未新建）");
  serveTaskBody(ws1);
  await pump((await t2.result).stream);
}

// ─── 主测试（串行跑全部场景） ────────────────────────────────────────────

test("qwen TTS 连接复用全套（串行场景）", async () => {
  resetState();
  await scenarioNormal();
  resetState();
  await scenarioReuse();
  resetState();
  await scenarioFailed();
  resetState();
  await scenarioCancel();
  resetState(); // 清掉 IDLE 连接的 60s 空闲 timer，避免挂住事件循环
});
