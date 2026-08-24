import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { qualityEvidenceManifestV1Schema } from "./quality-evidence-contracts";
import type { QualityEvidenceManifestV1 } from "./quality-evidence-contracts";

const DIGEST = "a".repeat(64);

function manifest(): QualityEvidenceManifestV1 {
  return {
    schemaVersion: 1 as const,
    suiteRevision: "qg-01-v1",
    environment: {
      schemaVersion: 1 as const,
      gitCommit: "abcdef1234567",
      artifactSha256: DIGEST,
      electronVersion: "43.4.1",
      chromiumVersion: "134.0.6998.179",
      nodeVersion: "22.23.2",
      os: "macos" as const,
      osVersion: "15.6",
      arch: "arm64" as const,
      viewport: { width: 1440, height: 810 },
      deviceScaleFactor: 2,
      zoomFactor: 1,
      locale: "zh-CN" as const,
      timezone: "Asia/Shanghai" as const,
      theme: "day" as const,
      motionMode: "off" as const,
      mediaMode: "poster-only" as const,
      fontManifestSha256: DIGEST,
      assetManifestSha256: DIGEST,
      seedRevision: "capture-fixture-v1",
      apiBuildRevision: "unconfigured",
      domainSchemaRevision: "desktop-ipc-m2-2026-08-23",
    },
    gates: [{
      id: "EVIDENCE-INFRA-01",
      status: "advisory_passed" as const,
      evidenceFiles: [{ path: "evidence/scene.svg", sha256: DIGEST }],
    }],
    visualBaselines: ["evidence/scene.svg"],
    knownIssues: [],
    redactionsApplied: ["no secrets, tokens, cookies, or user content included"],
  };
}

describe("QualityEvidenceManifestV1", () => {
  it("accepts a complete strict manifest", () => {
    assert.equal(qualityEvidenceManifestV1Schema.parse(manifest()).schemaVersion, 1);
  });

  it("rejects extra fields and unsafe evidence paths", () => {
    const value = { ...manifest(), extra: true };
    assert.equal(qualityEvidenceManifestV1Schema.safeParse(value).success, false);

    const unsafe = manifest();
    unsafe.gates[0].evidenceFiles[0].path = "../secret.txt";
    assert.equal(qualityEvidenceManifestV1Schema.safeParse(unsafe).success, false);
  });

  it("requires an explanation for blocked or not-applicable gates", () => {
    const value = manifest();
    value.gates[0].status = "blocked";
    assert.equal(qualityEvidenceManifestV1Schema.safeParse(value).success, false);
  });

  it("rejects duplicate gate and baseline identities", () => {
    const value = manifest();
    value.gates.push({ ...value.gates[0] });
    assert.equal(qualityEvidenceManifestV1Schema.safeParse(value).success, false);

    const withDuplicateBaseline = manifest();
    withDuplicateBaseline.visualBaselines.push("evidence/scene.svg");
    assert.equal(qualityEvidenceManifestV1Schema.safeParse(withDuplicateBaseline).success, false);
  });
});
