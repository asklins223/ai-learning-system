/**
 * 伴星语音段的**服务端预热**（方案 29 §14.11 修复 ③）。
 *
 * 为什么要有它：合成以前只由客户端发起——SSE 把 `voice.segment.ready` 送到桌面端，
 * 桌面端再 POST `/voice/tts`。也就是说"她这一段该用什么声音"要等一个来回才开始算。
 * 这里让**服务端在把段事件推给客户端之前**就把合成发出去，客户端来取时命中缓存。
 *
 * 三条不变量，缺一条就会帮倒忙：
 *
 * 1. **同一段只合成一次**：缓存按 `segmentId` 去重，客户端来取时若还在飞就 join 同一个
 *    promise（不是再合成一次）。否则"预热"会把 TTS 负载翻倍。
 * 2. **预热失败不影响正常链路**：任何异常都咽掉，客户端该发起的请求照旧发起、
 *    照旧走原来的合成路径。
 * 3. **有界**：条目数上限 + TTL。被打断的回合会留下没人取的段，不能让它一直占内存，
 *    也不能让它一直占着 TTS 队列——所以每个用户的在飞预热有并发上限。
 */

import { logger } from "../../lib/logger.ts";

/** 缓存活多久：段被签发到客户端来取，正常在几秒内；2 分钟足够覆盖一次打断后重放。 */
export const COMPANION_TTS_WARM_TTL_MS = 120_000;
/** 缓存条目上限（每条约 20–120KB 音频，64 条约几 MB）。 */
export const COMPANION_TTS_WARM_MAX_ENTRIES = 64;
/** 同一用户同时在飞的预热上限——被打断的回合不该继续把 TTS 队列占满。 */
export const COMPANION_TTS_WARM_MAX_IN_FLIGHT_PER_USER = 3;

export interface WarmSegmentResult {
  readonly statusCode: number;
  readonly audio?: Uint8Array;
  readonly error?: { code: string; message: string };
  /**
   * 这一次合成的读数（耗时/引擎/字节数）。**命中缓存时由路由补记**
   * （`recordCompanionTtsSynthOutcome`）——预热的合成发生在没人要的时候，
   * 只有客户端真的来取，它才算"字节交给了客户端"。
   */
  readonly deferred?: { durationMs: number; engine?: "qwen" | "edge"; bytes: number };
}

interface WarmEntry {
  readonly userId: string;
  readonly promise: Promise<WarmSegmentResult>;
  expiresAt: number;
}

const entries = new Map<string, WarmEntry>();
const inFlightPerUser = new Map<string, number>();

/** 预热命中/未命中的计数（只用于日志与验证，不参与任何判定）。 */
export const companionTtsWarmStats = { started: 0, joined: 0, hits: 0, missed: 0, failed: 0, skipped: 0 };

function pruneExpired(now: number): void {
  for (const [segmentId, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(segmentId);
  }
  // 超上限时按过期时间淘汰最旧的（Map 保持插入序，先插的先走）。
  while (entries.size > COMPANION_TTS_WARM_MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/**
 * 发起一次预热。**不 await**：调用方是 SSE 的推流循环，不能被合成拖住。
 *
 * `synthesize` 由调用方给（它知道引擎选择与降级链），这样这个模块不需要认识 TTS 栈。
 */
export function warmCompanionSegment(args: {
  userId: string;
  segmentId: string;
  run: () => Promise<WarmSegmentResult>;
}): void {
  const now = Date.now();
  pruneExpired(now);
  if (entries.has(args.segmentId)) {
    companionTtsWarmStats.joined += 1;
    return;
  }
  const inFlight = inFlightPerUser.get(args.userId) ?? 0;
  if (inFlight >= COMPANION_TTS_WARM_MAX_IN_FLIGHT_PER_USER) {
    // 这个用户的 TTS 队列已经排满：不再往前面塞，让客户端自己按需来取。
    companionTtsWarmStats.skipped += 1;
    return;
  }
  inFlightPerUser.set(args.userId, inFlight + 1);
  companionTtsWarmStats.started += 1;
  const promise = args.run()
    .catch((error: unknown): WarmSegmentResult => {
      // 不变量 2：预热失败只记一笔，绝不外抛（它跑在 SSE 的推流循环里）。
      companionTtsWarmStats.failed += 1;
      logger.debug(
        { err: error instanceof Error ? error.message : String(error), segmentId: args.segmentId },
        "companion tts warm failed",
      );
      return { statusCode: 500, error: { code: "TTS_FAILED", message: "warm synthesis failed" } };
    })
    .finally(() => {
      const current = inFlightPerUser.get(args.userId) ?? 1;
      if (current <= 1) inFlightPerUser.delete(args.userId);
      else inFlightPerUser.set(args.userId, current - 1);
    });
  entries.set(args.segmentId, { userId: args.userId, promise, expiresAt: now + COMPANION_TTS_WARM_TTL_MS });
  // 没人来取也不能变成未处理拒绝。
  void promise.catch(() => undefined);
}

/**
 * 取一段预热好的音频；没有（或已经过期）返回 null，调用方照常自己合成。
 *
 * 还在飞的时候**join 同一个 promise**，这是"同一段只合成一次"的落点。
 */
export async function takeWarmCompanionSegment(segmentId: string): Promise<WarmSegmentResult | null> {
  const entry = entries.get(segmentId);
  if (!entry || entry.expiresAt <= Date.now()) {
    companionTtsWarmStats.missed += 1;
    return null;
  }
  companionTtsWarmStats.hits += 1;
  return entry.promise;
}

/** 测试用：清空缓存与计数。 */
export function resetCompanionTtsWarmCache(): void {
  entries.clear();
  inFlightPerUser.clear();
  companionTtsWarmStats.started = 0;
  companionTtsWarmStats.joined = 0;
  companionTtsWarmStats.hits = 0;
  companionTtsWarmStats.missed = 0;
  companionTtsWarmStats.failed = 0;
  companionTtsWarmStats.skipped = 0;
}
