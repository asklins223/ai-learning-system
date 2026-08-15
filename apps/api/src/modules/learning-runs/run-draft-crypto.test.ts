/**
 * run-draft-crypto 单元测试（§12.7 静态加密）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decryptDraftPayload,
  encryptDraftPayload,
  isDraftEncryptionAvailable,
} from "./run-draft-crypto.ts";

test("密钥缺失时 fail closed：加密不可用、解密返回 null", () => {
  delete process.env.LEARNING_DRAFT_ENC_KEY;
  assert.equal(isDraftEncryptionAvailable(), false);
  assert.equal(encryptDraftPayload({ kind: "text", text: "草稿" }), null);
  assert.equal(decryptDraftPayload({ enc: "abc" }), null);
});

test("配置合法密钥后加解密往返一致，密文不含明文", () => {
  process.env.LEARNING_DRAFT_ENC_KEY = "a".repeat(64);
  assert.equal(isDraftEncryptionAvailable(), true);
  const payload = { kind: "text", text: "用户草稿正文" };
  const encrypted = encryptDraftPayload(payload);
  assert.ok(encrypted, "encrypted shape");
  assert.ok(encrypted.enc.length > 0);
  assert.ok(!JSON.stringify(encrypted).includes("用户草稿正文"));
  const decrypted = decryptDraftPayload(encrypted);
  assert.deepEqual(decrypted, payload);
  delete process.env.LEARNING_DRAFT_ENC_KEY;
});

test("非法密钥格式按未配置处理（fail closed）", () => {
  process.env.LEARNING_DRAFT_ENC_KEY = "not-hex";
  assert.equal(isDraftEncryptionAvailable(), false);
  delete process.env.LEARNING_DRAFT_ENC_KEY;
});

test("密文损坏/密钥不匹配时解密返回 null（不抛异常不伪造）", () => {
  process.env.LEARNING_DRAFT_ENC_KEY = "b".repeat(64);
  const encrypted = encryptDraftPayload({ kind: "voice", unconfirmedTranscript: "t" });
  assert.ok(encrypted);
  // 用另一把密钥解密 → 认证失败 → null
  process.env.LEARNING_DRAFT_ENC_KEY = "c".repeat(64);
  assert.equal(decryptDraftPayload(encrypted), null);
  // 损坏 base64 → null
  assert.equal(decryptDraftPayload({ enc: "!!!!" }), null);
  delete process.env.LEARNING_DRAFT_ENC_KEY;
});
