import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  COMPANION_PERSONA_V1,
  COMPANION_PERSONA_V1_PROMPT_ID,
  COMPANION_PERSONA_V1_SHA256,
} from "./companion-persona.ts";

// 03 合同 §9.1：canonical bytes = UTF-8、LF 换行、无 BOM、末行后无换行，1335 bytes，
// SHA-256 固定。任何字符变化都必须升级 prompt version，不能悄悄修改。
test("companion-persona-v1 canonical bytes 与 hash 固定", () => {
  const bytes = Buffer.from(COMPANION_PERSONA_V1, "utf8");
  assert.equal(bytes.length, 1335, "canonical bytes 必须是 1335");
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash, COMPANION_PERSONA_V1_SHA256, "SHA-256 必须匹配合同固定值");
  assert.equal(hash, "719f18b816b401de16ee33e3ee6e26bb6f09b2f5256c2bf4a40695a220a4d39d");
  assert.equal(COMPANION_PERSONA_V1_PROMPT_ID, "companion-persona-v1");
  assert.equal(bytes[0] !== 0xef, true, "无 BOM（不以 EF BB BF 开头）");
  assert.equal(COMPANION_PERSONA_V1.endsWith("。"), true, "末行后无换行");
});
