/**
 * 15b：qwen-audio-3.1-tts-flash 实时语音合成 provider（阿里百炼）。
 *
 * 协议（WebSocket 原始协议，见阿里百炼《实时语音合成-Qwen-Audio-TTS》文档）：
 *   run-task（streaming: duplex，parameters 含 voice/format/sample_rate 等）
 *     → task-started → continue-task（文本）→ 二进制音频帧 → finish-task
 *     → task-finished
 *   取消：finish-task + input.directive=cancel（服务端立即结束任务并返回
 *   task-finished，之后连接仍可复用）；连接异常关闭即任务终止。
 *
 * 15b 二期（连接复用）：task-finished 后 60s 内可重新 run-task（每次新
 * task_id）复用同一条连接；cancel 后同样可复用；task-failed/网络错误 →
 * 连接关闭不可复用；空闲 60s 无任务自动断开。连接池按**连接身份**
 * （WS URL + apiKey）分槽位，连续多轮对话免建连，首包延迟显著降低。
 * 并发模型见下方「按用户串行 + 全局有界并发」。
 */

import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { DomainError } from "@ailearn/shared";

export interface QwenTtsOptions {
  /** 业务空间 ID（北京地域 WS URL 前缀，如 llm-55ujpy2wafojbdp8） */
  workspaceId: string;
  /** DASHSCOPE_API_KEY */
  apiKey: string;
  /** 模型（默认 qwen-audio-3.1-tts-flash） */
  model?: string;
  /** 音色（如 longhua_v3.1 龙华；音色名带模型版本后缀，不能跨模型混用） */
  voice: string;
  /** 音频格式（默认 mp3） */
  format?: string;
  /** 采样率（默认 22050） */
  sampleRate?: number;
  /** 音量 0-100（默认 50） */
  volume?: number;
  /** 语速（默认 1） */
  rate?: number;
  /** 音调（默认 1） */
  pitch?: number;
  /** 指令控制（高质量声音描述，可选；qwen-audio-3.1-tts-flash 系统音色支持任意指令） */
  instruction?: string;
  /** 连接/任务超时 ms（默认 30s） */
  timeoutMs?: number;
  /** 测试注入 WebSocket 构造器 */
  WebSocketImpl?: typeof WebSocket;
}

export interface QwenTtsStreamResult {
  /** 上游 mp3 音频流（chunked 透传） */
  stream: ReadableStream<Uint8Array>;
  contentType: string;
}

export class QwenTtsError extends DomainError {
  constructor(code: string, message: string) {
    super({ name: "QwenTtsError", code, message, statusCode: 500 });
  }
}

/**
 * ── 按用户串行 + 全局有界并发（稳定 P0，2026-09-15）─────────────────────
 *
 * 取代此前的 `withQwenConcurrencyLimit`——那是一条**模块级** promise 链，把
 * 所有用户的所有段落串成同一条队列，并共用同一个 WS 连接槽位。桌面单用户时
 * 没问题，但 api 是多用户服务：任一用户一段 30s 的合成会把其他用户的 TTS 全部
 * 排在后面（P95 直接相加），而且他们还会被塞进"上一个用户的"连接复用槽。
 *
 * 现在分两层：
 *   1. **按队列键（workspaceId:userId）串行**——同一用户的连续段落仍然严格顺序
 *      执行（保住前端按 ordinal 播放的时序、以及单连接复用的收益），不同用户互不阻塞。
 *   2. **全局有界并发**（`QWEN_TTS_MAX_CONCURRENCY`，默认 4）——原全局串行是为了
 *      避免阿里 "Requests rate limit exceeded"；取消全局串行不等于取消总量约束，
 *      只是把"一律 1"换成"有上界的 N"。
 *
 * 名额与**流生命周期**绑定（见 bindTaskSlotToStream）：qwenTtsSynthesizeStream 在
 * task-started 就 resolve，而音频要到 task-finished 才结束、连接那一刻才归还池子。
 * 所以名额必须等流结束/出错/被取消才释放——否则同一用户的两段会在音频阶段重叠
 * （正是要避免的），全局名额也会被提前释放而失去约束力。
 *
 * 队列深度不需要额外上限：/voice/tts/stream 在进入这里之前已按用户限流
 * （COMPANION_RATE_LIMITS.ttsPerMinute），在途请求数天然有界。
 */
export const QWEN_TTS_DEFAULT_MAX_CONCURRENCY = 4;

export function resolveQwenTtsMaxConcurrency(
  raw: string | undefined = process.env.QWEN_TTS_MAX_CONCURRENCY,
): number {
  const parsed = Number(raw ?? QWEN_TTS_DEFAULT_MAX_CONCURRENCY);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : QWEN_TTS_DEFAULT_MAX_CONCURRENCY;
}

let activeQwenTasks = 0;
const qwenTaskWaiters: Array<() => void> = [];

async function acquireQwenTaskSlot(): Promise<void> {
  if (activeQwenTasks < resolveQwenTtsMaxConcurrency()) {
    activeQwenTasks += 1;
    return;
  }
  // 无可用名额：挂起；releaseQwenTaskSlot 会把名额**直接移交**过来（计数不变）。
  await new Promise<void>((resolveWaiter) => qwenTaskWaiters.push(resolveWaiter));
}

function releaseQwenTaskSlot(): void {
  const next = qwenTaskWaiters.shift();
  if (next) {
    next(); // 名额移交，占用数不变
    return;
  }
  activeQwenTasks = Math.max(0, activeQwenTasks - 1);
}

/** 每个队列键一条 promise 链（同键严格串行）；链尾本身永不 reject。 */
const qwenQueueTails = new Map<string, Promise<void>>();

/** 测试钩子：当前占用中的任务数。 */
export function qwenTtsActiveTaskCount(): number {
  return activeQwenTasks;
}

/** 测试钩子：仍在排队（链尾未清）的队列键数量。 */
export function qwenTtsQueuedKeyCount(): number {
  return qwenQueueTails.size;
}

/** 测试钩子：清空等待队列、占用计数与队列尾（避免用例之间互相影响）。 */
export function resetQwenTaskQueueForTests(): void {
  qwenTaskWaiters.length = 0;
  activeQwenTasks = 0;
  qwenQueueTails.clear();
}

/** 把名额释放绑定到流结束 / 出错 / 被取消。 */
function bindTaskSlotToStream(
  stream: ReadableStream<Uint8Array>,
  releaseOnce: () => void,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          releaseOnce();
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (err) {
        releaseOnce();
        controller.error(err);
      }
    },
    async cancel(reason) {
      releaseOnce();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

/**
 * 按用户排队的合成入口：`queueKey` 相同的调用严格串行（含音频阶段），
 * 不同键并行但受全局名额约束。生产调用点见 voice-routes 的 /voice/tts/stream。
 *
 * `queueKey` 为空直接 fail closed：曾经用"缺省键"兜底会让所有调用方悄悄退回
 * 全局串行，那正是要修掉的语义，不该有静默回退路径。
 */
export async function qwenTtsSynthesizeStreamForUser(
  queueKey: string,
  text: string,
  options: QwenTtsOptions,
): Promise<QwenTtsStreamResult> {
  if (typeof queueKey !== "string" || queueKey.trim() === "") {
    throw new QwenTtsError("INVALID_ARGUMENT", "TTS 队列键为空（fail closed）");
  }

  const previous = qwenQueueTails.get(queueKey) ?? Promise.resolve();
  let finishTask!: () => void;
  const taskFinished = new Promise<void>((resolveTask) => { finishTask = resolveTask; });
  const tail = previous.then(() => taskFinished);
  qwenQueueTails.set(queueKey, tail);
  // 链尾清理：只有自己仍是队尾时才删（否则会把后到的任务从链上摘掉）。
  // 不清理的话 Map 会按用户数无限增长——长期运行的进程里这是泄漏。
  void tail.then(() => {
    if (qwenQueueTails.get(queueKey) === tail) qwenQueueTails.delete(queueKey);
  });

  await previous; // 同键串行：等前一段（含它的音频）彻底结束
  await acquireQwenTaskSlot(); // 全局名额（排队期间不占名额）

  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    releaseQwenTaskSlot();
    finishTask();
  };

  let handedOff = false;
  try {
    const result = await qwenTtsSynthesizeStream(text, options);
    handedOff = true;
    return { ...result, stream: bindTaskSlotToStream(result.stream, releaseOnce) };
  } finally {
    // 建流失败（连接错误/超时/空文本）：立刻还名额并放行同键队列，
    // 否则该用户后续所有段落都会被一个失败任务永久挡住。
    if (!handedOff) releaseOnce();
  }
}

const DEFAULT_MODEL = "qwen-audio-3.1-tts-flash";
const DEFAULT_FORMAT = "mp3";
const DEFAULT_SAMPLE_RATE = 22050;
const DEFAULT_TIMEOUT_MS = 30_000;
/** 15b 二期：取消后等待服务端 task-finished 的上限（超时强制弃连） */
const CANCEL_SETTLE_TIMEOUT_MS = 5_000;
/** 15b 二期：IDLE 连接空闲自动断开（阿里文档：任务结束后 60s 无新任务自动断开） */
const POOL_IDLE_TIMEOUT_MS = 60_000;

function wsUrl(workspaceId: string): string {
  // 北京地域：wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference
  const clean = workspaceId.replace(/^wss:\/\//, "").replace(/\/$/, "");
  if (clean.includes("://") || clean.includes("aliyuncs.com")) {
    // 已含完整域名/URL（测试注入或未来多地域）——原样使用
    return clean.startsWith("wss://") ? clean : `wss://${clean}`;
  }
  return `wss://${clean}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`;
}

// ─── 15b 二期：IDLE 连接池（按连接身份分槽位，连接复用） ─────────────────

interface PooledQwenConnection {
  socket: WebSocket;
  alive: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** 连接身份：WS URL + apiKey。见 connectionKey 的说明。 */
  key: string;
}

/**
 * 连接身份：同一身份才可复用连接。
 *
 * 此前是**单个**全局槽位（`let idleConnection`），取连接时不看身份——一旦
 * workspaceId/apiKey 不同的两个调用方交替合成，后一个会拿到前一个的 socket：
 * 轻则任务打到错误的业务空间，重则用别人的 key 计费/越权。当前系统配置是
 * 单平台所以没暴露，但"多平台"正是配置层已经支持的方向。
 *
 * 同时这也是并发放开后的**必要**条件：全局名额 > 1 时，不同任务各自持有连接，
 * 单槽位会在每次归还时关掉另一个槽里的连接，复用率归零。
 *
 * 槽位数上界 = 配置过的 (URL, key) 组合数（现实里 1 个）；空闲 60s 自动断开，
 * 所以不需要额外的池容量旋钮。
 */
function connectionKey(options: QwenTtsOptions): string {
  return `${wsUrl(options.workspaceId)}|${options.apiKey}`;
}

const idleConnections = new Map<string, PooledQwenConnection>();

function clearPoolIdleTimer(conn: PooledQwenConnection): void {
  if (conn.idleTimer) {
    clearTimeout(conn.idleTimer);
    conn.idleTimer = null;
  }
}

function closePooledConnection(conn: PooledQwenConnection, WebSocketImpl: typeof WebSocket): void {
  clearPoolIdleTimer(conn);
  conn.alive = false;
  if (idleConnections.get(conn.key) === conn) idleConnections.delete(conn.key);
  if (
    conn.socket.readyState === WebSocketImpl.OPEN ||
    conn.socket.readyState === WebSocketImpl.CONNECTING
  ) {
    try { conn.socket.close(); } catch { /* ignore */ }
  }
}

/** 测试用：清空池状态（避免测试间串扰）。 */
export function resetQwenConnectionPool(): void {
  for (const conn of [...idleConnections.values()]) {
    clearPoolIdleTimer(conn);
    conn.alive = false;
  }
  idleConnections.clear();
}

/** 测试钩子：空闲连接槽位数。 */
export function qwenIdleConnectionCount(): number {
  return idleConnections.size;
}

/** 取连接：优先复用同身份的 IDLE 槽位；否则新建（并发由任务名额约束）。 */
function acquireQwenConnection(
  options: QwenTtsOptions,
): Promise<PooledQwenConnection> {
  const key = connectionKey(options);
  const idle = idleConnections.get(key);
  if (idle && idle.alive) {
    idleConnections.delete(key);
    clearPoolIdleTimer(idle);
    return Promise.resolve(idle);
  }
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  const url = wsUrl(options.workspaceId);
  const socket = new WebSocketImpl(url, {
    headers: {
      Authorization: `bearer ${options.apiKey}`,
      "X-DashScope-DataInspection": "enable",
    },
  });
  return new Promise<PooledQwenConnection>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    socket.on("open", () => settle(() => resolve({ socket, alive: true, idleTimer: null, key })));
    socket.on("error", (err) => settle(() => reject(
      new QwenTtsError("NETWORK_ERROR", `qwen TTS WebSocket 错误：${err instanceof Error ? err.message : String(err)}`),
    )));
    socket.on("close", () => settle(() => reject(
      new QwenTtsError("NETWORK_ERROR", "qwen TTS 连接在任务开始前关闭"),
    )));
  });
}

/** 归还连接：reusable=false（task-failed/网络错误）→ 关闭；否则存入同身份 IDLE 槽位（60s 计时）。 */
function releaseQwenConnection(
  conn: PooledQwenConnection,
  reusable: boolean,
  WebSocketImpl: typeof WebSocket,
): void {
  if (!conn.alive) return;
  if (!reusable) {
    closePooledConnection(conn, WebSocketImpl);
    return;
  }
  const existing = idleConnections.get(conn.key);
  if (existing && existing !== conn) {
    closePooledConnection(existing, WebSocketImpl);
  }
  idleConnections.set(conn.key, conn);
  // PERF-BN6 修复：idle timer 加 .unref()，无请求时该 60s 保活计时器
  // 不阻塞进程优雅停机/退出（对齐项目其它 .unref() 惯例）。
  conn.idleTimer = setTimeout(() => {
    closePooledConnection(conn, WebSocketImpl);
  }, POOL_IDLE_TIMEOUT_MS);
  conn.idleTimer.unref();
}

/**
 * 单段文本实时合成：run-task → task-started → continue-task → 音频帧 → finish-task。
 * 返回 ReadableStream（音频 chunk 流式 push，task-finished/连接关闭时结束）。
 * 15b 二期：连接来自 IDLE 池（任务间复用）；流被 cancel（前端打断）时发
 * finish-task + directive=cancel，等服务端 task-finished 后归还连接。
 */
export async function qwenTtsSynthesizeStream(
  text: string,
  options: QwenTtsOptions,
): Promise<QwenTtsStreamResult> {
  if (typeof text !== "string" || text.trim() === "") {
    throw new QwenTtsError("INVALID_ARGUMENT", "TTS 文本为空（fail closed）");
  }
  const model = options.model ?? DEFAULT_MODEL;
  const format = options.format ?? DEFAULT_FORMAT;
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  const taskId = randomUUID();

  const conn = await acquireQwenConnection(options);
  const { socket } = conn;
  // 15b 二期：连接可能来自 IDLE 槽位（复用）——清掉上一任务遗留的
  // message/error/close 监听器，避免旧 listener 重复处理事件。
  socket.removeAllListeners();

  return new Promise<QwenTtsStreamResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    let finished = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let textSent = false;
    let cancelTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      if (!settled) fail(new QwenTtsError("TIMEOUT", "qwen TTS 任务超时"));
    }, timeoutMs);

    const cleanup = (reusable: boolean): void => {
      clearTimeout(timer);
      if (cancelTimer) {
        clearTimeout(cancelTimer);
        cancelTimer = null;
      }
      releaseQwenConnection(conn, reusable, WebSocketImpl);
    };

    const fail = (err: Error): void => {
      if (settled && controller) {
        // 流已建立（task-started 后）出错：错误通过流传播（reject 已无意义）。
        // 先 error 再 cleanup（cleanup 关闭 socket 会同步触发 close 回调置空 controller）。
        finished = true;
        controller.error(err);
        controller = null;
        cleanup(false);
        return;
      }
      if (settled) return;
      settled = true;
      cleanup(false);
      controller?.error(err);
      controller = null;
      rejectPromise(err);
    };

    const sendJson = (obj: unknown): void => {
      if (socket.readyState === WebSocketImpl.OPEN) {
        socket.send(JSON.stringify(obj));
      }
    };

    const runTask = (): void => {
      // run-task（复用连接时每次使用新 task_id）
      sendJson({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model,
          parameters: {
            text_type: "PlainText",
            voice: options.voice,
            format,
            sample_rate: sampleRate,
            volume: options.volume ?? 50,
            rate: options.rate ?? 1,
            pitch: options.pitch ?? 1,
            enable_ssml: false,
            // 15b 二期：指令控制（高质量声音描述）——按所选音色特质下发
            ...(options.instruction ? { instruction: options.instruction } : {}),
          },
          input: {},
        },
      });
    };

    if (socket.readyState === WebSocketImpl.OPEN) {
      // 复用连接：已 OPEN，立即 run-task（open 事件不会再触发）
      runTask();
    }
    socket.on("open", () => {
      // 新建连接：open 后 run-task
      runTask();
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        // 音频帧 → 流式 push（resolve 已发生；若未 resolve 则先建立流）
        // 音频先于 task-started 到达（异常）——仍尝试建立流（controller 为空则丢弃）
        if (controller) {
          const buf = data as Buffer;
          controller.enqueue(new Uint8Array(buf));
        }
        return;
      }
      let msg: { header?: { event?: string; error_message?: string }; payload?: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // 非 JSON（忽略）
      }
      const event = msg.header?.event;
      if (event === "task-started") {
        // 建立输出流并发送文本
        if (!settled) {
          settled = true;
          const stream = new ReadableStream<Uint8Array>({
            start(c) { controller = c; },
            cancel() {
              // 15b 二期：前端打断 → 发 cancel 指令，等服务端 task-finished 归还连接
              if (!finished) {
                sendJson({
                  header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
                  payload: { input: { directive: "cancel" } },
                });
                cancelTimer = setTimeout(() => {
                  cleanup(false); // 服务端未及时确认 → 强制弃连
                }, CANCEL_SETTLE_TIMEOUT_MS);
              } else {
                cleanup(true);
              }
            },
          });
          resolvePromise({ stream, contentType: "audio/mpeg" });
        }
        if (!textSent) {
          textSent = true;
          sendJson({
            header: { action: "continue-task", task_id: taskId, streaming: "duplex" },
            payload: { input: { text } },
          });
        }
        // 发完文本后立即 finish-task（单段场景）
        sendJson({
          header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
          payload: { input: {} },
        });
      } else if (event === "task-finished") {
        finished = true;
        if (cancelTimer) {
          clearTimeout(cancelTimer);
          cancelTimer = null;
        }
        cleanup(true);
        try {
          controller?.close();
        } catch {
          // 流已被前端 cancel（controller 已关闭）→ 忽略
        }
        controller = null;
      } else if (event === "task-failed") {
        fail(new QwenTtsError("UPSTREAM_ERROR", msg.header?.error_message ?? "qwen TTS 任务失败"));
      }
    });

    socket.on("error", (err) => {
      fail(new QwenTtsError("NETWORK_ERROR", `qwen TTS WebSocket 错误：${err instanceof Error ? err.message : String(err)}`));
    });

    socket.on("close", () => {
      // 正常 task-finished 后关闭 → 已 resolve/close；异常提前关闭 → 失败
      if (!settled || controller) {
        if (controller) {
          try {
            controller.close();
          } catch {
            // 流已被 cancel → 忽略
          }
          controller = null;
        } else if (!settled) {
          fail(new QwenTtsError("NETWORK_ERROR", "qwen TTS 连接提前关闭"));
        }
      }
    });
  });
}
