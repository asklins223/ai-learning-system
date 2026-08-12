/**
 * P2 §6.10 内存固定窗口限流（per (workspace,user) + bucket）。
 *
 * 与 SSE 连接限制（companion-events.ts）同属单进程内存态：当前部署为单
 * API 实例，多实例部署时必须换成共享存储（Redis/Postgres），否则限额会
 * 按实例拆分。达限返回 429 RATE_LIMITED + Retry-After，不创建任何副作用。
 */

interface RateBucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, RateBucket>();
const MAX_BUCKETS = 50_000;

/** 清理过期 bucket；条目超上限时先清过期，仍超则重置全表（内存护栏）。 */
function prune(now: number): void {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= WINDOW_MS_MAX) buckets.delete(key);
  }
  if (buckets.size >= MAX_BUCKETS) buckets.clear();
}

/** 所有 bucket 共用同一个最长窗口，便于统一 prune 判断。 */
const WINDOW_MS_MAX = 3_600_000; // 1h（最大窗口为 hourly bucket）

export function companionRateLimit(args: {
  /** 稳定 scope 键，通常 `${workspaceId}:${userId}:${bucketName}`。 */
  key: string;
  limit: number;
  windowMs: number;
}): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  prune(now);
  const existing = buckets.get(args.key);
  if (!existing || now - existing.windowStart >= args.windowMs) {
    buckets.set(args.key, { count: 1, windowStart: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (existing.count >= args.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.windowStart + args.windowMs - now) / 1000)),
    };
  }
  existing.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

/** 429 响应构造（envelope 与 §6.9 一致）。 */
export function companionRateLimitReply(
  reply: { code(statusCode: number): { send(body: unknown): unknown }; send(body: unknown): unknown },
  requestId: string,
  retryAfterSeconds: number,
): unknown {
  reply.code(429);
  return reply.send({
    version: 1,
    error: "RATE_LIMITED",
    message: "操作太频繁，请稍后再试",
    recoverable: true,
    requestId,
    retryAfterSeconds,
  });
}

// §6.10 固定限额（全部按 (workspace,user)）。
export const COMPANION_RATE_LIMITS = Object.freeze({
  createTurnPerMinute: { limit: 12, windowMs: 60_000 },
  createTurnPerHour: { limit: 120, windowMs: 3_600_000 },
  createConversationPerMinute: { limit: 10, windowMs: 60_000 },
  // bootstrap + conversation list/snapshot/messages/proposal snapshot 合并
  readQueriesPerMinute: { limit: 120, windowMs: 60_000 },
  mutateConversationPerMinute: { limit: 20, windowMs: 60_000 }, // PATCH/DELETE
  inboxEnsurePerMinute: { limit: 30, windowMs: 60_000 },
  cancelPerMinute: { limit: 30, windowMs: 60_000 },
  deliveryViewDismissPerMinute: { limit: 60, windowMs: 60_000 },
  proposalDecisionPerMinute: { limit: 20, windowMs: 60_000 },
  learningContextPerMinute: { limit: 30, windowMs: 60_000 },
  // menu-proposal 与 create turn 共用 12/min 写预算（§6.10）
  menuProposalPerMinute: { limit: 12, windowMs: 60_000 },
  asrPerMinute: { limit: 10, windowMs: 60_000 },
  asrPerHour: { limit: 60, windowMs: 3_600_000 },
  ttsPerMinute: { limit: 60, windowMs: 60_000 },
  exportPerHour: { limit: 3, windowMs: 3_600_000 },
} as const);
