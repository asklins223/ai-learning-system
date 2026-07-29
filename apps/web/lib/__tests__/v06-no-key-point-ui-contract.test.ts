import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const COMPONENT_PATH = resolve(
  import.meta.dirname ?? __dirname,
  "../../components/ValidationFocus.tsx",
);

describe("v0.6 no-key-point presentation", () => {
  const source = readFileSync(COMPONENT_PATH, "utf-8");

  it("maps no_key_point to a blocked prerequisite state", () => {
    assert.match(
      source,
      /errorCode === "no_key_point"[\s\S]{0,240}phase: "question_blocked"[\s\S]{0,120}blockedReason: "no_key_point"/,
    );
  });

  it("shows actionable Chinese copy instead of the raw machine error", () => {
    assert.ok(source.includes("尚无可复习的要点"));
    assert.ok(source.includes("请先补充或重新生成学习卡，再回来复习。"));
  });
});
