import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  inspectExactReleaseTags,
  inspectVersionCopies,
  loadVersionSource,
  PACKAGE_ROOTS,
  parseReleaseTag,
  REPOSITORY_ROOT,
  syncVersionCopies,
  validateVersion,
} from "./version-contract.mjs";

const temporaryRoots = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createFixture(copyVersion = "0.4.0") {
  const root = mkdtempSync(join(tmpdir(), "ailearn-version-contract-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "release"), { recursive: true });
  writeJson(join(root, "release/version.json"), { version: "0.5.0" });
  writeFileSync(
    join(root, "README.md"),
    `[![Version](https://img.shields.io/badge/version-v${copyVersion}-blue.svg)](https://example.invalid)\n`,
    "utf8",
  );

  for (const packageRoot of PACKAGE_ROOTS) {
    const directory = join(root, packageRoot);
    const name = `fixture-${packageRoot.replaceAll("/", "-")}`;
    mkdirSync(directory, { recursive: true });
    writeJson(join(directory, "package.json"), { name, version: copyVersion, private: true });
    writeJson(join(directory, "package-lock.json"), {
      name,
      version: copyVersion,
      lockfileVersion: 3,
      packages: { "": { name, version: copyVersion } },
    });
  }
  return root;
}

describe("version contract", () => {
  it("accepts the canonical repository copies", () => {
    const version = loadVersionSource(REPOSITORY_ROOT);
    assert.equal(version, "0.5.0");
    assert.deepEqual(inspectVersionCopies(REPOSITORY_ROOT, version), []);
  });

  it("detects and repairs package, lockfile, and README drift", () => {
    const root = createFixture();
    const version = loadVersionSource(root);
    assert.equal(inspectVersionCopies(root, version).length, 16);

    const changed = syncVersionCopies(root, version);
    assert.equal(changed.length, 11);
    assert.deepEqual(inspectVersionCopies(root, version), []);
    assert.match(readFileSync(join(root, "README.md"), "utf8"), /version-v0\.5\.0-blue/);
  });

  it("rejects prerelease or decorated manual version values", () => {
    assert.throws(() => validateVersion("0.5.0-rc.1"), /stable MAJOR\.MINOR\.PATCH/);
    assert.throws(() => validateVersion("v0.5.0"), /stable MAJOR\.MINOR\.PATCH/);
  });

  it("binds exact annotated release tags to the manual version", () => {
    assert.deepEqual(inspectExactReleaseTags("0.5.0", [
      { name: "v0.5.0", objectType: "tag" },
      { name: "v0.5.0-rc.1", objectType: "tag" },
      { name: "benchmark-baseline", objectType: "commit" },
    ]), []);

    const issues = inspectExactReleaseTags("0.5.0", [
      { name: "v0.5.1", objectType: "tag" },
      { name: "v0.5.0", objectType: "commit" },
    ]);
    assert.equal(issues.length, 2);
    assert.match(issues[0], /v0\.5\.1/);
    assert.match(issues[1], /annotated/);
  });

  it("accepts only stable or positive rc.N release tag forms", () => {
    assert.deepEqual(parseReleaseTag("v0.5.0"), { version: "0.5.0", prerelease: null });
    assert.deepEqual(parseReleaseTag("v0.5.0-rc.1"), { version: "0.5.0", prerelease: "rc.1" });
    for (const tag of [
      "v0.5.0-rc.0",
      "v0.5.0-alpha",
      "v0.5.0-rc.1.extra",
      "v0.5",
      "vgarbage",
    ]) {
      assert.equal(parseReleaseTag(tag), null, tag);
    }
  });
});
