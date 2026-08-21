import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(
  new URL("../workflows/ci.yml", import.meta.url),
  "utf8",
);
const coverageGate = readFileSync(
  new URL("./coverage-gate.mjs", import.meta.url),
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

  it("does not reference the removed database mirror package", () => {
    const unitTests = jobBlock("unit-tests");
    assert.doesNotMatch(unitTests, /packages\/db/);
    assert.doesNotMatch(coverageGate, /packages\/db/);
  });

  it("runs the SEC-01 verification script from the repository root", () => {
    const freshMigrations = jobBlock("fresh-migrations");
    const step = freshMigrations.match(
      /- name: "SEC-01 enforce: run verification script"\n([\s\S]*?)(?=\n\s+- name:)/,
    );

    assert.ok(step, "Fresh Migrations must run SEC-01 enforce verification");
    assert.doesNotMatch(
      step[0],
      /working-directory:/,
      "the repository-root .github script must not run from apps/api",
    );
    assert.match(step[0], /node \.github\/scripts\/sec01-enforce-verify\.mjs/);
  });

  it("keeps coverage discovery self-contained on GitHub runners", () => {
    assert.doesNotMatch(
      coverageGate,
      /execFileSync\(["']rg["']/,
      "coverage collection must not assume ripgrep is installed on the runner",
    );
    assert.match(coverageGate, /readdirSync\(/);
  });
});
