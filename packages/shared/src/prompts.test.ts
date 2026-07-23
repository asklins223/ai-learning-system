import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EVAL_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./prompts.ts";

describe("shared prompt contracts", () => {
  it("keeps card generation output structured and evidence-grounded", () => {
    assert.match(SYSTEM_PROMPT, /只输出 JSON/);
    assert.match(SYSTEM_PROMPT, /key_points/);
    assert.match(SYSTEM_PROMPT, /quote_text/);
    assert.match(SYSTEM_PROMPT, /不要从不同的 block 中各取一部分拼接/);
  });

  it("keeps validation outcomes and evidence references explicit", () => {
    for (const outcome of [
      "preliminary_understanding",
      "unclear_expression",
      "misunderstanding",
      "unknown",
    ]) {
      assert.match(EVAL_SYSTEM_PROMPT, new RegExp(outcome));
    }
    assert.match(EVAL_SYSTEM_PROMPT, /evidence_refs/);
    assert.match(EVAL_SYSTEM_PROMPT, /只输出 JSON/);
  });
});
