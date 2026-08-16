/**
 * SSE 写安全工具。
 *
 * 解决 SSE 端点偶发 500：
 * - 客户端断开后 `raw.write()` 可能抛 `ERR_STREAM_WRITE_AFTER_END` / `EPIPE`；
 * - 统一在这里检查 `writableEnded/destroyed` 并 try/catch，任何一次写失败都
 *   只返回 false，由调用方安静关闭，绝不向上冒泡为 HTTP 500。
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
    raw.write(chunk);
    return true;
  } catch {
    return false;
  }
}
