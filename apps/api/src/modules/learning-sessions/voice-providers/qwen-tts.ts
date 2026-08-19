/**
 * 15b：qwen-audio-3.0-tts-flash 实时语音合成 provider（阿里百炼）。
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
 * 连接关闭不可复用；空闲 60s 无任务自动断开。实现为单槽位 IDLE 连接池
 * （桌面单用户串行；withQwenConcurrencyLimit 保证同一时刻至多一个任务），
 * 连续多轮对话免建连，首包延迟显著降低。
 */

import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { DomainError } from "@ailearn/shared";

export interface QwenTtsOptions {
  /** 业务空间 ID（北京地域 WS URL 前缀，如 llm-55ujpy2wafojbdp8） */
  workspaceId: string;
  /** DASHSCOPE_API_KEY */
  apiKey: string;
  /** 模型（默认 qwen-audio-3.0-tts-flash） */
  model?: string;
  /** 音色（如 longanlingxi 龙安灵希） */
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
  /** 指令控制（高质量声音描述，可选；qwen-audio-3.0-tts-flash 系统音色支持任意指令） */
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
 * 15c：qwen 合成并发限制（全局串行队列）——每段一次 run-task 会并发建立多个
 * WebSocket，连续快速对话时容易触发阿里限流（"Requests rate limit exceeded"）
 * 导致段失败无声。前端播放本身串行（一段播完再播下一段，预取只提前 1 段），
 * 串行合成与播放并行，不增加感知延迟。
 */
let qwenTaskQueue: Promise<unknown> = Promise.resolve();
export function withQwenConcurrencyLimit<T>(task: () => Promise<T>): Promise<T> {
  const run = qwenTaskQueue.then(task, task);
  qwenTaskQueue = run.catch(() => undefined);
  return run;
}

const DEFAULT_MODEL = "qwen-audio-3.0-tts-flash";
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

// ─── 15b 二期：单槽位 IDLE 连接池（连接复用） ───────────────────────────

interface PooledQwenConnection {
  socket: WebSocket;
  alive: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

let idleConnection: PooledQwenConnection | null = null;

function clearPoolIdleTimer(conn: PooledQwenConnection): void {
  if (conn.idleTimer) {
    clearTimeout(conn.idleTimer);
    conn.idleTimer = null;
  }
}

function closePooledConnection(conn: PooledQwenConnection, WebSocketImpl: typeof WebSocket): void {
  clearPoolIdleTimer(conn);
  conn.alive = false;
  if (idleConnection === conn) idleConnection = null;
  if (
    conn.socket.readyState === WebSocketImpl.OPEN ||
    conn.socket.readyState === WebSocketImpl.CONNECTING
  ) {
    try { conn.socket.close(); } catch { /* ignore */ }
  }
}

/** 测试用：清空池状态（避免测试间串扰）。 */
export function resetQwenConnectionPool(): void {
  if (idleConnection) {
    clearPoolIdleTimer(idleConnection);
    idleConnection.alive = false;
    idleConnection = null;
  }
}

/** 取连接：优先复用 IDLE 槽位；否则新建（串行语义由 withQwenConcurrencyLimit 保证）。 */
function acquireQwenConnection(
  options: QwenTtsOptions,
): Promise<PooledQwenConnection> {
  if (idleConnection && idleConnection.alive) {
    const conn = idleConnection;
    idleConnection = null;
    clearPoolIdleTimer(conn);
    return Promise.resolve(conn);
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
    socket.on("open", () => settle(() => resolve({ socket, alive: true, idleTimer: null })));
    socket.on("error", (err) => settle(() => reject(
      new QwenTtsError("NETWORK_ERROR", `qwen TTS WebSocket 错误：${err instanceof Error ? err.message : String(err)}`),
    )));
    socket.on("close", () => settle(() => reject(
      new QwenTtsError("NETWORK_ERROR", "qwen TTS 连接在任务开始前关闭"),
    )));
  });
}

/** 归还连接：reusable=false（task-failed/网络错误）→ 关闭；否则存入 IDLE 槽位（60s 计时）。 */
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
  if (idleConnection && idleConnection !== conn) {
    closePooledConnection(idleConnection, WebSocketImpl);
  }
  idleConnection = conn;
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
