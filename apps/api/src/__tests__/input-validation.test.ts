/**
 * F-024/F-018: 分页参数 clamp 测试。
 *
 * 验证：负 limit/cursor 不会传递到数据库查询，
 * 而是被纠正为合法值。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clampLimit,
  clampOffset,
  clampPagination,
  decodeCursor,
  encodeCursor,
  paginationQuerySchema,
} from "../lib/pagination.ts";

describe("pagination clamp", () => {
  describe("clampLimit", () => {
    it("returns default for undefined", () => {
      assert.equal(clampLimit(undefined), 100);
      assert.equal(clampLimit(undefined, 50), 50);
    });

    it("returns default for NaN", () => {
      assert.equal(clampLimit(NaN), 100);
    });

    it("clamps to minimum 1", () => {
      assert.equal(clampLimit(0), 1);
      assert.equal(clampLimit(-1), 1);
      assert.equal(clampLimit(-100), 1);
    });

    it("clamps to maximum 100", () => {
      assert.equal(clampLimit(101), 100);
      assert.equal(clampLimit(1000), 100);
    });

    it("passes through valid values", () => {
      assert.equal(clampLimit(1), 1);
      assert.equal(clampLimit(50), 50);
      assert.equal(clampLimit(100), 100);
    });

    it("floors decimal values", () => {
      assert.equal(clampLimit(50.7), 50);
      assert.equal(clampLimit(0.9), 1); // clamped to min after floor
    });
  });

  describe("clampOffset", () => {
    it("returns 0 for undefined", () => {
      assert.equal(clampOffset(undefined), 0);
    });

    it("returns 0 for NaN", () => {
      assert.equal(clampOffset(NaN), 0);
    });

    it("clamps negative to 0", () => {
      assert.equal(clampOffset(-1), 0);
      assert.equal(clampOffset(-100), 0);
    });

    it("passes through valid values", () => {
      assert.equal(clampOffset(0), 0);
      assert.equal(clampOffset(50), 50);
      assert.equal(clampOffset(1000), 1000);
    });

    it("floors decimal values", () => {
      assert.equal(clampOffset(10.9), 10);
    });
  });

  describe("clampPagination", () => {
    it("uses defaults when no opts", () => {
      const result = clampPagination();
      assert.equal(result.limit, 100);
      assert.equal(result.offset, 0);
    });

    it("clamps negative values", () => {
      const result = clampPagination({ limit: -5, cursor: -10 });
      assert.equal(result.limit, 1);
      assert.equal(result.offset, 0);
    });

    it("clamps excessive values", () => {
      const result = clampPagination({ limit: 500, cursor: 200 });
      assert.equal(result.limit, 100);
      assert.equal(result.offset, 200);
    });

    it("respects custom defaults", () => {
      const result = clampPagination({}, { limit: 50, cursor: 10 });
      assert.equal(result.limit, 50);
      assert.equal(result.offset, 10);
    });
  });
});

describe("cursor validation", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";

  it("round-trips a canonical timestamp and UUID", () => {
    const cursor = encodeCursor(new Date("2026-07-17T08:30:00.000Z"), id);
    assert.deepEqual(decodeCursor(cursor), {
      timestamp: "2026-07-17T08:30:00.000Z",
      id,
    });
    assert.equal(paginationQuerySchema.safeParse({ cursor }).success, true);
  });

  it("rejects invalid dates, ids, and non-canonical base64", () => {
    const invalidDate = Buffer.from(`not-a-date:${id}`).toString("base64");
    const invalidId = Buffer.from("2026-07-17T08:30:00.000Z:anything").toString("base64");
    for (const cursor of [invalidDate, invalidId, "%%%", "YWJjZA"] ) {
      assert.equal(decodeCursor(cursor), null);
      assert.equal(paginationQuerySchema.safeParse({ cursor }).success, false);
    }
  });
});
