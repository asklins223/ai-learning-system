import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANION_TTS_WARM_MAX_ENTRIES,
  COMPANION_TTS_WARM_MAX_IN_FLIGHT_PER_USER,
  COMPANION_TTS_WARM_TTL_MS,
  companionTtsWarmStats,
  resetCompanionTtsWarmCache,
  takeWarmCompanionSegment,
  warmCompanionSegment,
} from "./companion-tts-warm.ts";

/**
 * 服务端预热的**三条不变量**（方案 29 §14.11 修复 ③）。
 *
 * 这个模块跑在 SSE 的推流循环旁边，出问题的两种方式都很贵：
 * 把同一段合成两遍（TTS 负载翻倍）、或者让预热把推流拖住/炸掉。
 */

const bytes = (n: number) => new Uint8Array([n, n, n]);

function reset(): void {
  resetCompanionTtsWarmCache();
}

test("同一段只合成一次：预热在飞时来取是 join，不是再合成一遍", async () => {
  reset();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  warmCompanionSegment({
    userId: "u1",
    segmentId: "seg-1",
    run: async () => {
      calls += 1;
      await gate;
      return { statusCode: 200, audio: bytes(1) };
    },
  });
  // 同一个 segmentId 再预热一次（多连接/重放都会走到这里）：不新增合成。
  warmCompanionSegment({ userId: "u1", segmentId: "seg-1", run: async () => {
    calls += 1;
    return { statusCode: 200, audio: bytes(9) };
  } });

  const first = takeWarmCompanionSegment("seg-1");
  const second = takeWarmCompanionSegment("seg-1");
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(calls, 1, "只合成一次");
  assert.deepEqual(a?.audio, bytes(1));
  assert.deepEqual(b?.audio, bytes(1), "两次取到的是同一份字节");
  assert.equal(companionTtsWarmStats.joined, 1);
  assert.equal(companionTtsWarmStats.hits, 2);
});

test("没预热过就返回 null：调用方照常自己合成，行为与以前完全一致", async () => {
  reset();
  assert.equal(await takeWarmCompanionSegment("seg-unknown"), null);
  assert.equal(companionTtsWarmStats.missed, 1);
});

test("预热失败不外抛，取到的是失败结果（客户端会退回自己合成）", async () => {
  reset();
  warmCompanionSegment({
    userId: "u1",
    segmentId: "seg-boom",
    run: async () => { throw new Error("engine down"); },
  });
  const result = await takeWarmCompanionSegment("seg-boom");
  assert.equal(result?.statusCode, 500);
  assert.equal(companionTtsWarmStats.failed, 1);
});

test("同一个用户的在飞预热有上限：被打断的回合不会把 TTS 队列占满", () => {
  reset();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const hold = async () => { await gate; return { statusCode: 200, audio: bytes(1) }; };

  for (let i = 0; i < COMPANION_TTS_WARM_MAX_IN_FLIGHT_PER_USER + 5; i += 1) {
    warmCompanionSegment({ userId: "u1", segmentId: `seg-${i}`, run: hold });
  }
  assert.equal(companionTtsWarmStats.started, COMPANION_TTS_WARM_MAX_IN_FLIGHT_PER_USER);
  assert.equal(companionTtsWarmStats.skipped, 5);

  // 别的用户不受这个上限影响。
  warmCompanionSegment({ userId: "u2", segmentId: "other", run: hold });
  assert.equal(companionTtsWarmStats.started, COMPANION_TTS_WARM_MAX_IN_FLIGHT_PER_USER + 1);
  release();
});

test("缓存有界：超过条目上限时淘汰最旧的", async () => {
  reset();
  // 每条换一个 userId：这一段量的是**条目上限**，别撞上"同一用户在飞 ≤3"那道闸。
  for (let i = 0; i < COMPANION_TTS_WARM_MAX_ENTRIES + 4; i += 1) {
    warmCompanionSegment({
      userId: `bulk-user-${i}`,
      segmentId: `bulk-${i}`,
      run: async () => ({ statusCode: 200, audio: bytes(i) }),
    });
  }
  // 让所有 promise 落定
  await Promise.all(
    Array.from({ length: COMPANION_TTS_WARM_MAX_ENTRIES + 4 }, (_, i) => takeWarmCompanionSegment(`bulk-${i}`)),
  );
  const oldest = await takeWarmCompanionSegment("bulk-0");
  assert.equal(oldest, null, "最旧的已被淘汰");
  const newest = await takeWarmCompanionSegment(`bulk-${COMPANION_TTS_WARM_MAX_ENTRIES + 3}`);
  assert.equal(newest?.statusCode, 200, "最新的还在");
});

test("TTL：过期的预热不再命中（不会把几分钟前的音频当成这一段的）", async () => {
  reset();
  warmCompanionSegment({
    userId: "u1",
    segmentId: "seg-ttl",
    run: async () => ({ statusCode: 200, audio: bytes(1) }),
  });
  await takeWarmCompanionSegment("seg-ttl");
  const realNow = Date.now;
  Date.now = () => realNow() + COMPANION_TTS_WARM_TTL_MS + 1;
  try {
    assert.equal(await takeWarmCompanionSegment("seg-ttl"), null, "过期即未命中");
  } finally {
    Date.now = realNow;
  }
});
