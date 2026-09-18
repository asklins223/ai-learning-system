/**
 * SSE 写安全工具。
 *
 * 解决 SSE 端点偶发 500：
 * - 客户端断开后 `raw.write()` 可能抛 `ERR_STREAM_WRITE_AFTER_END` / `EPIPE`；
 * - 统一在这里检查 `writableEnded/destroyed` 并 try/catch，任何一次写失败都
 *   只返回 false，由调用方安静关闭，绝不向上冒泡为 HTTP 500。`write()` 返回
 *   false 时也必须向上传播背压信号；否则调用方会继续推进 cursor，客户端重连
 *   时可能看不到尚未真正排空的事件。
 */

export function safeSseWrite(
  raw: {
    writableEnded: boolean;
    destroyed: boolean;
    write(chunk: string): boolean;
  },
  chunk: string,
): boolean {
  if (raw.writableEnded || raw.destroyed) return false;
  try {
    return raw.write(chunk);
  } catch {
    return false;
  }
}

type EventedWritable = {
  writableEnded: boolean;
  destroyed: boolean;
  write(chunk: string): boolean;
  once(event: "drain" | "close" | "error", listener: () => void): unknown;
  removeListener(event: "drain" | "close" | "error", listener: () => void): unknown;
};

/**
 * 写入一块数据并在 high-water mark 命中时等待 drain。
 *
 * SSE 事件可以在背压时关闭并靠 cursor 重连恢复；NDJSON 导出没有 cursor，
 * 因此必须等待 drain，否则会得到一个没有 footer 的半截导出。
 */
export async function safeWriteWithBackpressure(
  raw: EventedWritable,
  chunk: string,
): Promise<boolean> {
  if (raw.writableEnded || raw.destroyed) return false;
  let accepted: boolean;
  try {
    accepted = raw.write(chunk);
  } catch {
    return false;
  }
  if (accepted) return true;
  if (raw.writableEnded || raw.destroyed) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      raw.removeListener("drain", onDrain);
      raw.removeListener("close", onClose);
      raw.removeListener("error", onError);
      resolve(ok);
    };
    const onDrain = () => finish(!raw.writableEnded && !raw.destroyed);
    const onClose = () => finish(false);
    const onError = () => finish(false);
    raw.once("drain", onDrain);
    raw.once("close", onClose);
    raw.once("error", onError);
    if (raw.writableEnded || raw.destroyed) finish(false);
  });
}
