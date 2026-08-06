import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EVAL_SYSTEM_PROMPT } from "./prompts.ts";

describe("shared prompt contracts", () => {
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
