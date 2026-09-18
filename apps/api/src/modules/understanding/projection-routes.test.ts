/**
 * projection-read-service 纯函数测试（文档 16 §15.2 shared 平面 + 游标分页）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateCardPersonal,
  decodeProjectionCursor,
  encodeProjectionCursor,
  projectionEdgeId,
  projectionKpPageSize,
} from "./projection-read-service.ts";

test("projectionEdgeId：确定性、不同边不同 id", () => {
  const a = projectionEdgeId("contains", "card:c1", "key_point:k1");
  const b = projectionEdgeId("contains", "card:c1", "key_point:k1");
  const c = projectionEdgeId("contains", "card:c1", "key_point:k2");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-f0-9]{24}$/);
});

test("aggregateCardPersonal：空集 → unknown 全空", () => {
  const result = aggregateCardPersonal([]);
  assert.equal(result.state, "unknown");
  assert.equal(result.nextReviewAt, null);
  assert.equal(result.activeScheduleId, null);
  assert.equal(result.lastCanonicalEventId, null);
  assert.equal(result.practiceTrailCount, 0);
});

test("aggregateCardPersonal：needs_repair 优先于 stable", () => {
  const result = aggregateCardPersonal([
    { state: "stable", nextReviewAt: null, activeScheduleId: null, lastCanonicalEventId: "c1", lastCanonicalOccurredAt: "2026-08-14T00:00:00.000Z", practiceTrailCount: 0 },
    { state: "needs_repair", nextReviewAt: null, activeScheduleId: null, lastCanonicalEventId: null, lastCanonicalOccurredAt: null, practiceTrailCount: 1 },
  ]);
  assert.equal(result.state, "needs_repair");
});

test("aggregateCardPersonal：fragile 优先于 forming；取最早复习与最新 canonical", () => {
  const result = aggregateCardPersonal([
    { state: "forming", nextReviewAt: "2026-08-20T00:00:00.000Z", activeScheduleId: null, lastCanonicalEventId: "c-old", lastCanonicalOccurredAt: "2026-08-10T00:00:00.000Z", practiceTrailCount: 2 },
    { state: "fragile", nextReviewAt: "2026-08-14T00:00:00.000Z", activeScheduleId: "s1", lastCanonicalEventId: "c-new", lastCanonicalOccurredAt: "2026-08-13T00:00:00.000Z", practiceTrailCount: 3 },
  ]);
  assert.equal(result.state, "fragile");
  assert.equal(result.nextReviewAt, "2026-08-14T00:00:00.000Z");
  assert.equal(result.activeScheduleId, "s1");
  assert.equal(result.lastCanonicalEventId, "c-new");
  assert.equal(result.practiceTrailCount, 5);
});

test("投影分页游标：编码/解码往返", () => {
  const token = encodeProjectionCursor("kp-1", "2026-08-14 10:00:00.123456");
  assert.ok(token.length > 0);
  assert.deepEqual(decodeProjectionCursor(token), {
    kpId: "kp-1",
    createdAtText: "2026-08-14 10:00:00.123456",
  });
  // 不同 kp/时间 → 不同 token。
  assert.notEqual(token, encodeProjectionCursor("kp-2", "2026-08-14 10:00:00.123456"));
  assert.notEqual(token, encodeProjectionCursor("kp-1", "2026-08-14 10:00:00.123457"));
});

test("投影分页游标：篡改/垃圾输入 → null（fail closed）", () => {
  assert.equal(decodeProjectionCursor("garbage"), null);
  assert.equal(decodeProjectionCursor(""), null);
  assert.equal(decodeProjectionCursor("!!not-base64url!!"), null);
  assert.equal(decodeProjectionCursor("e30="), null); // {}（缺字段）
  // 篡改 kind 字段（直接构造非法 JSON 再编码——base64 层不可读明文）。
  const tampered = Buffer.from(JSON.stringify({ k: "xx", i: "kp-1", c: "2026-08-14 10:00:00.123456" }), "utf8").toString("base64url");
  assert.equal(decodeProjectionCursor(tampered), null);
  // 时间格式不符（ISO 毫秒、非 UTC 文本、缺微秒）。
  const badTime = Buffer.from(JSON.stringify({ k: "kp", i: "kp-1", c: "2026-08-14T10:00:00.000Z" }), "utf8").toString("base64url");
  assert.equal(decodeProjectionCursor(badTime), null);
  const shortTime = Buffer.from(JSON.stringify({ k: "kp", i: "kp-1", c: "2026-08-14 10:00:00" }), "utf8").toString("base64url");
  assert.equal(decodeProjectionCursor(shortTime), null);
});

test("投影分页页大小：env 可调，非法回落默认 400", () => {
  const previous = process.env.PROJECTION_KP_PAGE_SIZE;
  try {
    delete process.env.PROJECTION_KP_PAGE_SIZE;
    assert.equal(projectionKpPageSize(), 400);
    process.env.PROJECTION_KP_PAGE_SIZE = "2";
    assert.equal(projectionKpPageSize(), 2);
    process.env.PROJECTION_KP_PAGE_SIZE = "0";
    assert.equal(projectionKpPageSize(), 400);
    process.env.PROJECTION_KP_PAGE_SIZE = "99999";
    assert.equal(projectionKpPageSize(), 400);
    process.env.PROJECTION_KP_PAGE_SIZE = "abc";
    assert.equal(projectionKpPageSize(), 400);
  } finally {
    if (previous === undefined) delete process.env.PROJECTION_KP_PAGE_SIZE;
    else process.env.PROJECTION_KP_PAGE_SIZE = previous;
  }
});
