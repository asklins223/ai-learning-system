/**
 * Projection Checkpoint 服务（文档 16 §15.1）。
 *
 * token 封装并签名 server-private canonical/practice watermarks；客户端不得
 * 比较字符串、解析 watermark 或自行推断"已追上"——只能把 token 交回服务端。
 * 服务端解码后判断 checkpoint 是否覆盖某个 canonical/practice event。
 */

import { createHmac, createHash } from "node:crypto";

export interface CheckpointWatermark {
  workspaceId: string;
  userId: string;
  lastCanonicalEventId: string | null;
  lastPracticeEventId: string | null;
  capturedAt: string;
}

/** watermark 落后判断：event id 非空性比较（canonical/practice 任一维度落后）。 */
export function watermarkBehind(a: CheckpointWatermark, b: CheckpointWatermark | null): boolean {
  if (!b) return false; // 无历史 checkpoint：任何有效 minimum 都视为已覆盖。
  if (b.lastCanonicalEventId && b.lastCanonicalEventId !== a.lastCanonicalEventId) {
    return a.lastCanonicalEventId === null || a.capturedAt < b.capturedAt;
  }
  if (b.lastPracticeEventId && b.lastPracticeEventId !== a.lastPracticeEventId) {
    return a.lastPracticeEventId === null || a.capturedAt < b.capturedAt;
  }
  return false;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function signingKey(): string {
  const raw = process.env.PROJECTION_CHECKPOINT_SECRET?.trim();
  // fail closed：密钥缺失或过短（<16 字符可离线爆破）都不签发/解析。
  if (!raw || raw.length < 16) return "";
  return raw;
}

/** 签发 opaque token：`cp:v1:<payloadBase64url>.<hmac>`。无密钥返回 null。 */
export function issueCheckpointToken(watermark: CheckpointWatermark): string | null {  const key = signingKey();
  if (!key) return null;
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    ws: watermark.workspaceId,
    u: watermark.userId,
    c: watermark.lastCanonicalEventId,
    p: watermark.lastPracticeEventId,
    at: watermark.capturedAt,
  }), "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  return `cp:v1:${payload}.${signature}`;
}

/** 解析并校验 token。失败/过期/篡改返回 null（fail closed）。 */
export function parseCheckpointToken(token: string): CheckpointWatermark | null {
  const key = signingKey();
  if (!key) return null;
  const match = token.match(/^cp:v1:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  const [, payload, signature] = match;
  const expected = createHmac("sha256", key).update(payload).digest("base64url");
  if (!timingSafeEqual(signature, expected)) return null;
  try {
    const raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      v?: number;
      ws?: string;
      u?: string;
      c?: string | null;
      p?: string | null;
      at?: string;
    };
    if (raw.v !== 1 || !raw.ws || !raw.u || !raw.at) return null;
    return {
      workspaceId: raw.ws,
      userId: raw.u,
      lastCanonicalEventId: raw.c ?? null,
      lastPracticeEventId: raw.p ?? null,
      capturedAt: raw.at,
    };
  } catch {
    return null;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return createHmac("sha256", bufA.toString()).digest("base64") === createHmac("sha256", bufB.toString()).digest("base64");
}

/** watermark 顺序：canonical 事件序用其 id 的字典序近似（事件 id 含时间序前缀）。
 * 实际覆盖判断由 DB 查询（outbox 中该 event 是否早于 watermark 事件）完成；
 * 此函数只提供本地摘要（不含任何答案）。 */
export function checkpointSummary(token: string): { hash: string } | null {
  const watermark = parseCheckpointToken(token);
  if (!watermark) return null;
  return {
    hash: sha256Hex(
      `${watermark.workspaceId}|${watermark.userId}|${watermark.lastCanonicalEventId ?? ""}|${watermark.lastPracticeEventId ?? ""}`,
    ),
  };
}
