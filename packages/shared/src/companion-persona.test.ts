import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  COMPANION_PERSONA_V4,
  COMPANION_PERSONA_V4_PROMPT_ID,
  COMPANION_PERSONA_V4_SHA256,
} from "./companion-persona.ts";

test("current companion persona has the frozen canonical bytes and hash", () => {
  const bytes = Buffer.from(COMPANION_PERSONA_V4, "utf8");
  assert.equal(bytes.length, 3225);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), COMPANION_PERSONA_V4_SHA256);
  assert.equal(COMPANION_PERSONA_V4_PROMPT_ID, "companion-persona-v4");
  assert.ok(COMPANION_PERSONA_V4.includes("有来有回"));
  assert.ok(COMPANION_PERSONA_V4.includes("不要编造"));
  assert.ok(COMPANION_PERSONA_V4.includes("不要输出 [方括号] 形式的任何标记"));
  assert.ok(!COMPANION_PERSONA_V4.includes("[sad]悲伤"));
  assert.ok(COMPANION_PERSONA_V4.endsWith("。"));
});
