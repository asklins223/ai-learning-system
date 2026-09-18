import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  determineReleaseRequirement,
  inspectImplementedReleaseStage,
  resolveManifestArtifactPath,
  validateReleaseManifest,
} from "./release-manifest-contract.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SCORER_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";
const digestValues = {
  journal: "sha256:9f3c42e9ae5f284a0d244ab6ea4239e76d62951065401173d6436454178f8873",
  api: "sha256:5d6f839ec08bc558fe618f9e517cbe8d6ecbe924bfbbe8c392f7329191c58e08",
  worker: "sha256:7187746e3101d72d68b60dd0e92f1da09cc78e4ab770b3f99eccf29f7f12c6cb",
};
const context = {
  version: "0.5.0",
  tag: "v0.5.0-rc.1",
  commit: COMMIT,
  sourceDateEpoch: 1_752_844_800,
  nodeVersion: process.version,
  githubRunId: "123",
  migration: {
    journalPath: "apps/api/src/db/migrations/meta/_journal.json",
    journalDigest: digestValues.journal,
    latestMigration: "0018_sec01_jobs_expand",
    migrationCount: 19,
  },
};

function gate(name) {
  return { status: "passed", evidence: [`ci://run/1/${name}`] };
}

function imageRecord(name, digest) {
  return {
    repository: `registry.invalid/ailearn/${name}`,
    digest,
    provenance: {
      buildRunId: context.githubRunId,
      builtAt: "2026-07-18T11:00:00.000Z",
      deploymentEnvironment: "ci-compose-smoke",
      observedAt: "2026-07-18T11:30:00.000Z",
      observedDigest: digest,
      evidence: [`ci://run/1/images/${name}`],
    },
  };
}

function validManifest() {
  return {
    schemaVersion: 1,
    version: context.version,
    tag: context.tag,
    commit: context.commit,
    sourceDateEpoch: context.sourceDateEpoch,
    nodeVersion: context.nodeVersion,
    generatedAt: "2026-07-18T12:00:00.000Z",
    migration: { ...context.migration },
    images: {
      api: imageRecord("api", digestValues.api),
      worker: imageRecord("worker", digestValues.worker),
    },
    tests: {
      summary: { passed: 216, failed: 0, skipped: 0, todo: 0 },
      unit: gate("unit"),
      integration: gate("integration"),
      coverage: gate("coverage"),
      dependencyScan: gate("dependency"),
      secretScan: gate("secret"),
      containerScan: gate("container"),
    },
    aiQuality: {
      status: "passed",
      datasetVersion: "2026-07-18-v2",
      datasetDigest: "sha256:3e5c44995e4ebf8cd7e76cd61c43d3c3d688b96643791ebd79cce65d5112a2b2",
      sampleCount: 30,
      labelVersion: "labels-v1",
      scorerCommit: SCORER_COMMIT,
      promptVersion: "card-v1",
      provider: {
        endpointOrigin: "https://dashscope.aliyuncs.com",
        modelId: "qwen-plus",
        modelRevision: "qwen-plus-2026-07-18",
        temperature: 0.2,
      },
      runs: 2,
      runResults: [
        {
          runId: "aiq-run-1",
          completedAt: "2026-07-18T11:00:00.000Z",
          metrics: {
            hardCitationPrecision: 0.9,
            keyPointHardCoverage: 0.85,
            expectedBlockHardCoverage: 0.85,
          },
          evidence: ["ci://run/1/aiq/run-1"],
        },
        {
          runId: "aiq-run-2",
          completedAt: "2026-07-18T11:30:00.000Z",
          metrics: {
            hardCitationPrecision: 0.91,
            keyPointHardCoverage: 0.86,
            expectedBlockHardCoverage: 0.87,
          },
          evidence: ["ci://run/1/aiq/run-2"],
        },
      ],
      metrics: {
        hardCitationPrecision: 0.9,
        keyPointHardCoverage: 0.85,
        expectedBlockHardCoverage: 0.85,
      },
      costUsd: 10,
      evidence: ["ci://run/1/aiq"],
    },
    approvals: {
      owner: {
        decision: "approved",
        approver: "repository-owner",
        decidedAt: "2026-07-18T12:00:00.000Z",
        evidence: "approval://owner/1",
      },
      securityDataReviewer: {
        decision: "approved",
        approver: "security-reviewer",
        decidedAt: "2026-07-18T12:00:00.000Z",
        evidence: "approval://security/1",
      },
    },
  };
}

describe("release manifest policy", () => {
  it("accepts a complete release manifest at the absolute thresholds", () => {
    assert.deepEqual(validateReleaseManifest(validManifest(), context), []);
  });

  it("fails closed on version, commit, migration, or placeholder image drift", () => {
    const manifest = validManifest();
    manifest.version = "0.5.1";
    manifest.commit = "f".repeat(40);
    manifest.migration.latestMigration = "0017_old";
    manifest.images.api.digest = `sha256:${"0".repeat(64)}`;
    manifest.images.api.provenance.observedDigest = digestValues.api;
    const issues = validateReleaseManifest(manifest, context);
    assert.ok(issues.some((issue) => issue.includes("manifest.version")));
    assert.ok(issues.some((issue) => issue.includes("manifest.commit")));
    assert.ok(issues.some((issue) => issue.includes("latestMigration")));
    assert.ok(issues.some((issue) => issue.includes("placeholder")));
    assert.ok(issues.some((issue) => issue.includes("observedDigest")));
  });

  it("binds source/runtime metadata and rejects normalized calendar dates", () => {
    const manifest = validManifest();
    manifest.sourceDateEpoch += 1;
    manifest.nodeVersion = "v99.0.0";
    manifest.generatedAt = "2026-02-30T12:00:00.000Z";
    manifest.images.api.provenance.buildRunId = "124";
    const issues = validateReleaseManifest(manifest, context);
    assert.ok(issues.some((issue) => issue.includes("sourceDateEpoch")));
    assert.ok(issues.some((issue) => issue.includes("nodeVersion")));
    assert.ok(issues.some((issue) => issue.includes("generatedAt")));
    assert.ok(issues.some((issue) => issue.includes("GITHUB_RUN_ID")));
  });

  it("rejects incomplete test, AIQ, and approval gates", () => {
    const manifest = validManifest();
    manifest.tests.summary.skipped = 1;
    manifest.aiQuality.runs = 1;
    manifest.aiQuality.sampleCount = 29;
    manifest.aiQuality.datasetDigest = `sha256:${"f".repeat(64)}`;
    manifest.aiQuality.runResults[1].metrics.keyPointHardCoverage = 0.849;
    manifest.aiQuality.runResults[1].runId = "aiq-run-1";
    manifest.aiQuality.costUsd = 10.01;
    manifest.aiQuality.provider.modelRevision = null;
    manifest.aiQuality.metrics.hardCitationPrecision = 0.899;
    manifest.approvals.securityDataReviewer.decision = "pending";
    manifest.approvals.securityDataReviewer.approver = " REPOSITORY-OWNER ";
    const issues = validateReleaseManifest(manifest, context);
    for (const expected of [
      "summary.skipped",
      "runs",
      "sampleCount",
      "datasetDigest",
      "runResults[1].metrics.keyPointHardCoverage",
      "distinct runId values",
      "costUsd",
      "modelRevision",
      "hardCitationPrecision",
      "securityDataReviewer.decision",
      "distinct approver identifiers",
    ]) {
      assert.ok(issues.some((issue) => issue.includes(expected)), `missing issue for ${expected}`);
    }
  });

  it("requires a manifest only for exact or GitHub release tags", () => {
    assert.deepEqual(determineReleaseRequirement({ exactTagNames: ["benchmark-baseline"] }), {
      required: false,
      tag: null,
      issues: [],
    });
    assert.deepEqual(determineReleaseRequirement({ exactTagNames: ["v0.5.0-rc.1"] }), {
      required: true,
      tag: "v0.5.0-rc.1",
      issues: [],
    });
    const github = determineReleaseRequirement({
      exactTagNames: [],
      githubRefType: "tag",
      githubRefName: "v0.5.0",
    });
    assert.equal(github.required, true);
    assert.ok(github.issues.some((issue) => issue.includes("does not point")));
  });

  it("keeps later RC comparison and stable promotion fail-closed", () => {
    assert.deepEqual(inspectImplementedReleaseStage("v0.5.0-rc.1"), []);
    assert.ok(inspectImplementedReleaseStage("v0.5.0-rc.2")[0].includes("prior-RC"));
    assert.ok(inspectImplementedReleaseStage("v0.5.0")[0].includes("stable-promotion"));
    assert.ok(inspectImplementedReleaseStage("v0.5.0-alpha")[0].includes("not supported"));
  });

  it("accepts explicit external or checkout-local generated JSON artifacts", () => {
    const fixture = mkdtempSync(join(tmpdir(), "release-manifest-artifact-"));
    const checkout = join(fixture, "checkout");
    const external = join(fixture, "ci-artifacts", "release.json");
    const local = join(checkout, "release", "artifacts", "release.json");
    try {
      mkdirSync(join(fixture, "ci-artifacts"), { recursive: true });
      mkdirSync(join(checkout, "release", "artifacts"), { recursive: true });
      writeFileSync(external, "{}\n");
      writeFileSync(local, "{}\n");
      assert.deepEqual(resolveManifestArtifactPath(checkout, external), {
        path: realpathSync(external),
        issues: [],
      });
      assert.deepEqual(resolveManifestArtifactPath(checkout, "release/artifacts/release.json"), {
        path: realpathSync(local),
        issues: [],
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects missing, non-JSON, and non-regular manifest artifact paths", () => {
    const fixture = mkdtempSync(join(tmpdir(), "release-manifest-artifact-"));
    try {
      const textPath = join(fixture, "release.txt");
      const directoryPath = join(fixture, "release.json");
      writeFileSync(textPath, "{}\n");
      mkdirSync(directoryPath);
      assert.ok(resolveManifestArtifactPath(fixture, "missing.json").issues.some((issue) => issue.includes("missing")));
      assert.ok(resolveManifestArtifactPath(fixture, textPath).issues.some((issue) => issue.includes("JSON")));
      assert.ok(resolveManifestArtifactPath(fixture, directoryPath).issues.some((issue) => issue.includes("regular file")));
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
