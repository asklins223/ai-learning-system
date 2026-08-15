/**
 * projection-checkpoint 纯函数测试（文档 16 §15.1 opaque token）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  issueCheckpointToken,
  parseCheckpointToken,
  checkpointSummary,
} from "./projection-checkpoint.ts";

test("签发/解析往返一致；篡改/无密钥 fail closed", () => {
  process.env.PROJECTION_CHECKPOINT_SECRET = "test-secret-0123456789abcdef";
  const token = issueCheckpointToken({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    lastCanonicalEventId: "canonical:abc",
    lastPracticeEventId: null,
    capturedAt: new Date().toISOString(),
  });
  assert.ok(token, "token issued");
  const parsed = parseCheckpointToken(token!);
  assert.equal(parsed?.workspaceId, "11111111-1111-4111-8111-111111111111");
  assert.equal(parsed?.lastCanonicalEventId, "canonical:abc");
  assert.equal(parsed?.lastPracticeEventId, null);

  // 篡改签名 → null。
  const tampered = token!.slice(0, -4) + "AAAA";
  assert.equal(parseCheckpointToken(tampered), null);
  // 非法形状 → null。
  assert.equal(parseCheckpointToken("not-a-token"), null);
  delete process.env.PROJECTION_CHECKPOINT_SECRET;
});

test("无密钥时签发/解析都 fail closed（null）", () => {
  delete process.env.PROJECTION_CHECKPOINT_SECRET;
  assert.equal(issueCheckpointToken({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    lastCanonicalEventId: null,
    lastPracticeEventId: null,
    capturedAt: new Date().toISOString(),
  }), null);
  assert.equal(parseCheckpointToken("cp:v1:abc.def"), null);
});

test("checkpointSummary：解析成功返回确定性摘要（不含任何答案内容）", () => {
  process.env.PROJECTION_CHECKPOINT_SECRET = "test-secret-0123456789abcdef";
  const token = issueCheckpointToken({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    lastCanonicalEventId: "canonical:xyz",
    lastPracticeEventId: "practice:abc",
    capturedAt: new Date().toISOString(),
  });
  const summary = checkpointSummary(token!);
  assert.ok(summary);
  assert.equal(summary.hash.length, 64);
  assert.equal(checkpointSummary(token!)!.hash, summary.hash);
  assert.equal(checkpointSummary("bogus"), null);
  delete process.env.PROJECTION_CHECKPOINT_SECRET;
});
