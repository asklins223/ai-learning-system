/**
 * qwen TTS 测试替身（非 *.test.ts，因此不会被 `find src -name '*.test.ts'` 当用例跑）。
 *
 * 连接池、任务名额、按用户队列都是**模块级共享状态**，所以每个用例前必须
 * `resetQwenTestState()`；node:test 默认并发执行顶层 test，需要串行断言共享状态的
 * 用例请合并进同一个 test 内顺序执行。
 */
import {
  resetQwenConnectionPool,
  resetQwenTaskQueueForTests,
  type QwenTtsOptions,
  type QwenTtsStreamResult,
} from "./qwen-tts.ts";

// ─── Mock WebSocket（最小 EventEmitter + 状态） ──────────────────────────

export class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  url: string;
  headers: Record<string, string>;
  readyState = MockWebSocket.CONNECTING;
  sent: unknown[] = [];
  closed = false;
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  constructor(url: string, opts?: { headers?: Record<string, string> }) {
    this.url = url;
    this.headers = opts?.headers ?? {};
    MockWebSocket.instances.push(this);
  }

  on(ev: string, fn: (...args: unknown[]) => void): void {
    const list = this.listeners.get(ev) ?? [];
    list.push(fn);
    this.listeners.set(ev, list);
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  send(data: unknown): void {
    this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
  }

  close(): void {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close");
  }

  emit(ev: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(ev) ?? []) fn(...args);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }

  serverEvent(event: string, extra: Record<string, unknown> = {}): void {
    this.emit("message", Buffer.from(JSON.stringify({
      header: { event, ...extra },
      payload: {},
    })));
  }

  audioFrame(): void {
    this.emit("message", Buffer.from([1, 2, 3, 4]), true);
  }

  sentActions(): string[] {
    return this.sent.map((m) => (m as { header?: { action?: string } }).header?.action ?? "");
  }

  runTaskIds(): string[] {
    return this.sent
      .filter((m) => (m as { header?: { action?: string } }).header?.action === "run-task")
      .map((m) => (m as { header?: { task_id?: string } }).header?.task_id ?? "");
  }

  continueTaskText(): string {
    const msg = this.sent.find((m) => (m as { header?: { action?: string } }).header?.action === "continue-task");
    return (msg as { payload?: { input?: { text?: string } } })?.payload?.input?.text ?? "";
  }
}

export const QWEN_TEST_BASE_OPTS = {
  workspaceId: "llm-test-workspace",
  apiKey: "sk-test",
  voice: "longanlingxi",
  instruction: "可爱的年轻女性声音",
  WebSocketImpl: MockWebSocket as unknown as typeof import("ws").default,
} satisfies QwenTtsOptions;

/** 让出若干轮事件循环：异步入口（等前驱 → 抢名额 → 建连）需要几跳才落定。 */
export async function settleTicks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** 把仍在 CONNECTING 的连接打开（新建的才需要；复用连接已 OPEN）。 */
export function openPendingSockets(): void {
  for (const ws of MockWebSocket.instances) {
    if (ws.readyState === MockWebSocket.CONNECTING) ws.open();
  }
}

export function latestSocket(): MockWebSocket {
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!ws) throw new Error("no MockWebSocket was created");
  return ws;
}

export async function pumpStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

/** 服务端完成一次任务：task-started → 音频 → task-finished。 */
export function serveTaskBody(ws: MockWebSocket): void {
  ws.serverEvent("task-started");
  ws.audioFrame();
  ws.serverEvent("task-finished");
}

export function resetQwenTestState(): void {
  MockWebSocket.instances = [];
  resetQwenConnectionPool();
  resetQwenTaskQueueForTests();
}

/**
 * 启动一次合成并推进到"run-task 已发出、监听器已注册"：
 * 调用 → 落定（建连）→ 打开新建连接 → 再落定。
 *
 * 返回结果 promise；调用方负责用 serveTaskBody + pumpStream 推进任务。
 */
export async function launchQwenTask(
  launch: () => Promise<QwenTtsStreamResult>,
): Promise<{ ws: MockWebSocket; result: Promise<QwenTtsStreamResult> }> {
  const result = launch();
  await settleTicks();
  openPendingSockets();
  await settleTicks();
  return { ws: latestSocket(), result };
}
