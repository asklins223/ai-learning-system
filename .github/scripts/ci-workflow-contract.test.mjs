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

  it("installs the database package before repository-wide test gates", () => {
    const unitTests = jobBlock("unit-tests");
    const installDatabase = unitTests.search(
      /- name: Install database package\n\s+working-directory: packages\/db\n\s+run: npm ci --no-audit --no-fund/,
    );
    const skipTodoGate = unitTests.indexOf("node .github/scripts/skip-todo-gate.mjs");
    const coverageGate = unitTests.indexOf("node .github/scripts/coverage-gate.mjs");

    assert.ok(installDatabase >= 0, "Unit Tests must install packages/db");
    assert.ok(installDatabase < skipTodoGate, "packages/db must be installed before skip/todo tests");
    assert.ok(installDatabase < coverageGate, "packages/db must be installed before coverage tests");
  });
});
