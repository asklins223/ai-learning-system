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
// 所有 bucket 共用同一个最长窗口，便于统一 prune 判断。
const WINDOW_MS_MAX = 3_600_000; // 1h（最大窗口为 hourly bucket）
// F2（round-4）：惰性逐窗口过期逐出参数。与 identity rate-limit 的 lazySweep
// 同型：每次 increment 顺带清 MAX_SWEEP_PER_CALL 个 resetAt 已过的 key，使
// Map 长期远低于 MAX_BUCKETS 阈值 → 命中路径的 50k 全扫 prune 几乎不可达。
const MAX_BUCKETS_BEFORE_SWEEP = 40_000; // 低于 50k 阈值，先触发惰性整批清理
const MAX_SWEEP_PER_CALL = 400;
// F2（round-5）：lazySweep 与整批清理的最小执行间隔。原实现在每次 companion
// API 调用上都跑一遍 lazySweep（O(n) 全 Map 扫描，n 最高 40k）。改为周期性
// 执行：命中路径几乎不再线性扫 Map，Map 仍由阈值整批清理兜底保持有界。
const SWEEP_INTERVAL_MS = 1_000;
let lastSweepAt = 0;

/** 惰性清理：基于 windowStart + 最久窗口淘汰已过期 key，单次最多清 MAX_SWEEP_PER_CALL 条。 */
function lazySweep(now: number): void {
  if (buckets.size === 0) return;
  let removed = 0;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= WINDOW_MS_MAX) {
      buckets.delete(key);
      if (++removed >= MAX_SWEEP_PER_CALL) break;
    }
  }
}

/** 清理过期 bucket；条目超上限时先清过期，仍超则重置全表（内存护栏）。
 * F2：命中路径不再做 O(MAX_BUCKETS) 全扫——惰性清理维持 Map 有界后，此全扫
 * 属真正极端兜底（一次性清全部过期，仍超则 clear）。
 */
function prune(now: number): void {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= WINDOW_MS_MAX) buckets.delete(key);
  }
  if (buckets.size >= MAX_BUCKETS) buckets.clear();
}

export function companionRateLimit(args: {
  /** 稳定 scope 键，通常 `${workspaceId}:${userId}:${bucketName}`。 */
  key: string;
  limit: number;
  windowMs: number;
}): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  // F2：惰性逐窗口过期逐出不再每次调用全 Map 扫描——仅在距上次清理超过
  // SWEEP_INTERVAL_MS 时执行（增量分摊）；Map 仍由阈值整批清理兜底保持有界，
  // 下方 prune 的 50k 全扫仅作极端护栏。
  if (now - lastSweepAt >= SWEEP_INTERVAL_MS) {
    lazySweep(now);
    // F5（round-5 审计 #10）：整批清理同样受 SWEEP_INTERVAL_MS 门控——原实现
    // 一旦 size >= MAX_BUCKETS_BEFORE_SWEEP 就在每次调用上全 Map 扫描。改为与
    // lazySweep 同频率（至多每秒一次）执行，命中路径不再因逼近阈值而线性扫 Map。
    if (buckets.size >= MAX_BUCKETS_BEFORE_SWEEP) {
      // 一次性清掉全部过期桶，避免状态持续逼近 MAX_BUCKETS 后触发 prune 的全扫尖刺。
      for (const [key, bucket] of buckets) {
        if (now - bucket.windowStart >= WINDOW_MS_MAX) buckets.delete(key);
      }
    }
    lastSweepAt = now;
  }
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
  // 设置里的音色试听：目录一共 6 条，一分钟全听一遍再加几遍重听够用。
  // 单列一个限额是因为它和真实朗读的预算不同——朗读是"陪她说话"，试听是"挑声音"，
  // 共用 60/min 时一边会把另一边的余量吃掉，报表里也分不出是哪一种。
  ttsPreviewPerMinute: { limit: 20, windowMs: 60_000 },
  exportPerHour: { limit: 3, windowMs: 3_600_000 },
  // companion bridge context 发布/续租/撤销（§14.2）：与其余 companion 路由
  // 一致的 per-(workspace,user) 内存固定窗口限流，防认证客户端滥用端点。
  bridgeContextPerMinute: { limit: 60, windowMs: 60_000 },
} as const);
