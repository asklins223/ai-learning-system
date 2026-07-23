import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(
  new URL("../workflows/ci.yml", import.meta.url),
  "utf8",
);

function jobBlock(name) {
  const match = workflow.match(
    new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:\\n|$)`),
  );
  assert.ok(match, `expected ${name} job in ci.yml`);
  return match[1];
}

describe("CI workflow contract", () => {
  it("keeps the Gitleaks job on a full Git checkout", () => {
    const typecheck = jobBlock("typecheck");
    assert.match(typecheck, /gitleaks\/gitleaks-action@v2/);
    assert.match(
      typecheck,
      /- uses: actions\/checkout@v4\n\s+with:\n(?:\s+#.*\n)*\s+fetch-depth: 0/,
      "Gitleaks requires the complete pushed commit range, including merge parents",
    );
  });
});
