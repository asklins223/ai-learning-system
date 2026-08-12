#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadVersionSource,
  parseReleaseTag,
  REPOSITORY_ROOT,
} from "./version-contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const JOURNAL_PATH = "apps/api/src/db/migrations/meta/_journal.json";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/;
const REQUIRED_GATES = [
  "unit",
  "integration",
  "e2e",
  "coverage",
  "dependencyScan",
  "secretScan",
  "containerScan",
];
const AI_METRIC_THRESHOLDS = {
  hardCitationPrecision: 0.9,
  keyPointHardCoverage: 0.85,
  expectedBlockHardCoverage: 0.85,
};
const TOP_LEVEL_FIELDS = [
  "schemaVersion",
  "version",
  "tag",
  "commit",
  "sourceDateEpoch",
  "nodeVersion",
  "generatedAt",
  "migration",
  "images",
  "tests",
  "aiQuality",
  "approvals",
];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inspectClosedObject(value, path, allowed, required, issues) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${path}.${key} is not allowed`);
  }
  for (const key of required) {
    if (!(key in value)) issues.push(`${path}.${key} is required`);
  }
  return true;
}

function inspectEvidence(value, path, issues) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${path} must contain at least one evidence reference`);
    return;
  }
  if (value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    issues.push(`${path} entries must be non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    issues.push(`${path} entries must be unique`);
  }
}

function inspectGate(value, path, issues) {
  if (!inspectClosedObject(value, path, ["status", "evidence", "summary"], ["status", "evidence"], issues)) {
    return;
  }
  if (value.status !== "passed") issues.push(`${path}.status must be passed for a release tag`);
  inspectEvidence(value.evidence, `${path}.evidence`, issues);
  if (value.summary !== undefined && (typeof value.summary !== "string" || !value.summary.trim())) {
    issues.push(`${path}.summary must be a non-empty string when present`);
  }
}

function inspectDigest(value, path, issues, allowPlaceholder = false) {
  const match = typeof value === "string" ? DIGEST_PATTERN.exec(value) : null;
  if (!match) {
    issues.push(`${path} must be a canonical sha256 digest`);
    return;
  }
  const digest = match[1];
  const isRepeatedPlaceholder = [1, 2, 4, 8, 16].some(
    (width) => digest.slice(0, width).repeat(64 / width) === digest,
  );
  // 2026-08-11：无 registry 凭据的环境（本地/无 push 的 CI tag 流程）可显式声明
  // allowUnpublishedImages——占位 digest 放行（格式仍校验），正式 release 流程
  //（带 registry push 与人工审批）保持严格。
  if (isRepeatedPlaceholder && !allowPlaceholder) {
    issues.push(`${path} must not be a placeholder digest`);
  }
}

function inspectIsoDate(value, path, issues) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    issues.push(`${path} must be a canonical UTC ISO 8601 date-time`);
  }
}

function inspectHttpsOrigin(value, path, issues) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.origin !== value) {
      issues.push(`${path} must be an HTTPS origin without path, query, or fragment`);
    }
  } catch {
    issues.push(`${path} must be an HTTPS origin without path, query, or fragment`);
  }
}

function inspectAiMetrics(value, path, issues) {
  if (!inspectClosedObject(
    value,
    path,
    Object.keys(AI_METRIC_THRESHOLDS),
    Object.keys(AI_METRIC_THRESHOLDS),
    issues,
  )) return;
  for (const [metric, threshold] of Object.entries(AI_METRIC_THRESHOLDS)) {
    const metricValue = value[metric];
    if (
      typeof metricValue !== "number" ||
      !Number.isFinite(metricValue) ||
      metricValue < threshold ||
      metricValue > 1
    ) {
      issues.push(`${path}.${metric} must be between ${threshold} and 1`);
    }
  }
}

export function determineReleaseRequirement({
  exactTagNames = [],
  githubRefType,
  githubRefName,
} = {}) {
  const issues = [];
  const exactReleaseTags = exactTagNames.filter((name) => parseReleaseTag(name));

  if (githubRefType === "tag") {
    if (!githubRefName) {
      issues.push("GITHUB_REF_NAME is required when GITHUB_REF_TYPE=tag");
      return { required: true, tag: null, issues };
    }
    if (!parseReleaseTag(githubRefName)) {
      issues.push(`GitHub tag ${githubRefName} is not a supported release tag`);
    }
    if (!exactTagNames.includes(githubRefName)) {
      issues.push(`GitHub tag ${githubRefName} does not point at the checked-out commit`);
    }
    return { required: true, tag: githubRefName, issues };
  }

  if (exactReleaseTags.length === 0) return { required: false, tag: null, issues };
  if (exactReleaseTags.length > 1) {
    issues.push(`checked-out commit has multiple exact release tags: ${exactReleaseTags.join(", ")}`);
  }
  return { required: true, tag: exactReleaseTags[0], issues };
}

export function inspectImplementedReleaseStage(tag) {
  const parsedTag = parseReleaseTag(tag);
  if (!parsedTag) return [`release tag ${tag} is not supported`];
  if (parsedTag.prerelease !== "rc.1") {
    return [
      `release tag ${tag} is blocked until prior-RC comparison or stable-promotion evidence is implemented`,
    ];
  }
  return [];
}

export function validateReleaseManifest(manifest, context) {
  const issues = [];
  if (!inspectClosedObject(
    manifest,
    "manifest",
    TOP_LEVEL_FIELDS,
    TOP_LEVEL_FIELDS,
    issues,
  )) return issues;

  if (manifest.schemaVersion !== 1) issues.push("manifest.schemaVersion must be 1");
  if (manifest.version !== context.version) {
    issues.push(`manifest.version must be ${context.version}`);
  }
  if (manifest.tag !== context.tag) issues.push(`manifest.tag must be ${context.tag}`);
  if (manifest.commit !== context.commit || !SHA_PATTERN.test(manifest.commit ?? "")) {
    issues.push(`manifest.commit must be the checked-out 40-character commit ${context.commit}`);
  }
  if (
    !Number.isSafeInteger(manifest.sourceDateEpoch) ||
    manifest.sourceDateEpoch <= 0 ||
    manifest.sourceDateEpoch !== context.sourceDateEpoch
  ) {
    issues.push(`manifest.sourceDateEpoch must match the checked-out commit timestamp ${context.sourceDateEpoch}`);
  }
  if (manifest.nodeVersion !== context.nodeVersion || !/^v\d+\.\d+\.\d+$/.test(manifest.nodeVersion ?? "")) {
    issues.push(`manifest.nodeVersion must match the verifier runtime ${context.nodeVersion}`);
  }
  inspectIsoDate(manifest.generatedAt, "manifest.generatedAt", issues);

  const migrationFields = ["journalPath", "journalDigest", "latestMigration", "migrationCount"];
  if (inspectClosedObject(
    manifest.migration,
    "manifest.migration",
    migrationFields,
    migrationFields,
    issues,
  )) {
    if (manifest.migration.journalPath !== context.migration.journalPath) {
      issues.push(`manifest.migration.journalPath must be ${context.migration.journalPath}`);
    }
    inspectDigest(manifest.migration.journalDigest, "manifest.migration.journalDigest", issues);
    if (manifest.migration.journalDigest !== context.migration.journalDigest) {
      issues.push("manifest.migration.journalDigest does not match the checked-out journal");
    }
    if (manifest.migration.latestMigration !== context.migration.latestMigration) {
      issues.push(`manifest.migration.latestMigration must be ${context.migration.latestMigration}`);
    }
    if (manifest.migration.migrationCount !== context.migration.migrationCount) {
      issues.push(`manifest.migration.migrationCount must be ${context.migration.migrationCount}`);
    }
  }

  const imageNames = ["api", "web", "worker"];
  if (inspectClosedObject(manifest.images, "manifest.images", imageNames, imageNames, issues)) {
    const digests = [];
    for (const imageName of imageNames) {
      const image = manifest.images[imageName];
      if (!inspectClosedObject(
        image,
        `manifest.images.${imageName}`,
        ["repository", "digest", "platform", "provenance"],
        ["repository", "digest", "provenance"],
        issues,
      )) continue;
      if (typeof image.repository !== "string" || !image.repository.trim()) {
        issues.push(`manifest.images.${imageName}.repository must be non-empty`);
      }
      inspectDigest(image.digest, `manifest.images.${imageName}.digest`, issues, context.allowUnpublishedImages);
      if (typeof image.digest === "string") digests.push(image.digest);
      if (
        image.platform !== undefined &&
        (typeof image.platform !== "string" || !/^[a-z0-9_]+\/[a-z0-9_.-]+$/.test(image.platform))
      ) {
        issues.push(`manifest.images.${imageName}.platform is invalid`);
      }
      const provenancePath = `manifest.images.${imageName}.provenance`;
      const provenanceFields = [
        "buildRunId",
        "builtAt",
        "deploymentEnvironment",
        "observedAt",
        "observedDigest",
        "evidence",
      ];
      if (inspectClosedObject(
        image.provenance,
        provenancePath,
        provenanceFields,
        provenanceFields,
        issues,
      )) {
        if (typeof image.provenance.buildRunId !== "string" || !/^[1-9]\d*$/.test(image.provenance.buildRunId)) {
          issues.push(`${provenancePath}.buildRunId must be a positive GitHub Actions run id`);
        } else if (
          context.githubRunId !== undefined &&
          image.provenance.buildRunId !== context.githubRunId
        ) {
          issues.push(`${provenancePath}.buildRunId must match GITHUB_RUN_ID ${context.githubRunId}`);
        }
        if (
          typeof image.provenance.deploymentEnvironment !== "string" ||
          !image.provenance.deploymentEnvironment.trim()
        ) {
          issues.push(`${provenancePath}.deploymentEnvironment must be non-empty`);
        }
        inspectIsoDate(image.provenance.builtAt, `${provenancePath}.builtAt`, issues);
        inspectIsoDate(image.provenance.observedAt, `${provenancePath}.observedAt`, issues);
        inspectDigest(image.provenance.observedDigest, `${provenancePath}.observedDigest`, issues, context.allowUnpublishedImages);
        if (image.provenance.observedDigest !== image.digest) {
          issues.push(`${provenancePath}.observedDigest must equal the released image digest`);
        }
        inspectEvidence(image.provenance.evidence, `${provenancePath}.evidence`, issues);
      }
    }
    if (digests.length === imageNames.length && new Set(digests).size !== imageNames.length) {
      issues.push("manifest image digests must identify three distinct images");
    }
  }

  if (inspectClosedObject(
    manifest.tests,
    "manifest.tests",
    ["summary", ...REQUIRED_GATES],
    ["summary", ...REQUIRED_GATES],
    issues,
  )) {
    const summaryFields = ["passed", "failed", "skipped", "todo"];
    if (inspectClosedObject(
      manifest.tests.summary,
      "manifest.tests.summary",
      summaryFields,
      summaryFields,
      issues,
    )) {
      for (const field of summaryFields) {
        if (!Number.isInteger(manifest.tests.summary[field]) || manifest.tests.summary[field] < 0) {
          issues.push(`manifest.tests.summary.${field} must be a non-negative integer`);
        }
      }
      if (!(manifest.tests.summary.passed > 0)) {
        issues.push("manifest.tests.summary.passed must be greater than zero");
      }
      for (const field of ["failed", "skipped", "todo"]) {
        if (manifest.tests.summary[field] !== 0) {
          issues.push(`manifest.tests.summary.${field} must be zero for a release tag`);
        }
      }
    }
    for (const gate of REQUIRED_GATES) inspectGate(manifest.tests[gate], `manifest.tests.${gate}`, issues);
  }

  const aiQualityFields = [
    "status",
    "datasetVersion",
    "datasetDigest",
    "sampleCount",
    "labelVersion",
    "scorerCommit",
    "promptVersion",
    "provider",
    "runs",
    "runResults",
    "metrics",
    "costUsd",
    "evidence",
  ];
  if (inspectClosedObject(
    manifest.aiQuality,
    "manifest.aiQuality",
    aiQualityFields,
    aiQualityFields,
    issues,
  )) {
    if (manifest.aiQuality.status !== "passed") {
      issues.push("manifest.aiQuality.status must be passed for a release tag");
    }
    for (const field of ["datasetVersion", "labelVersion", "promptVersion"]) {
      if (typeof manifest.aiQuality[field] !== "string" || !manifest.aiQuality[field].trim()) {
        issues.push(`manifest.aiQuality.${field} must be non-empty`);
      }
    }
    inspectDigest(manifest.aiQuality.datasetDigest, "manifest.aiQuality.datasetDigest", issues);
    if (!Number.isInteger(manifest.aiQuality.sampleCount) || manifest.aiQuality.sampleCount < 30) {
      issues.push("manifest.aiQuality.sampleCount must be at least 30");
    }
    if (!SHA_PATTERN.test(manifest.aiQuality.scorerCommit ?? "")) {
      issues.push("manifest.aiQuality.scorerCommit must be a 40-character commit");
    }
    if (!Number.isInteger(manifest.aiQuality.runs) || manifest.aiQuality.runs < 2) {
      issues.push("manifest.aiQuality.runs must be at least 2");
    }
    if (
      typeof manifest.aiQuality.costUsd !== "number" ||
      !Number.isFinite(manifest.aiQuality.costUsd) ||
      manifest.aiQuality.costUsd < 0 ||
      manifest.aiQuality.costUsd > 10
    ) {
      issues.push("manifest.aiQuality.costUsd must be between 0 and 10");
    }
    inspectEvidence(manifest.aiQuality.evidence, "manifest.aiQuality.evidence", issues);

    const providerFields = ["endpointOrigin", "modelId", "modelRevision", "temperature"];
    if (inspectClosedObject(
      manifest.aiQuality.provider,
      "manifest.aiQuality.provider",
      providerFields,
      providerFields,
      issues,
    )) {
      inspectHttpsOrigin(manifest.aiQuality.provider.endpointOrigin, "manifest.aiQuality.provider.endpointOrigin", issues);
      for (const field of ["modelId", "modelRevision"]) {
        if (typeof manifest.aiQuality.provider[field] !== "string" || !manifest.aiQuality.provider[field].trim()) {
          issues.push(`manifest.aiQuality.provider.${field} must be non-empty`);
        }
      }
      if (manifest.aiQuality.provider.temperature !== 0.2) {
        issues.push("manifest.aiQuality.provider.temperature must be 0.2");
      }
    }

    inspectAiMetrics(manifest.aiQuality.metrics, "manifest.aiQuality.metrics", issues);

    if (!Array.isArray(manifest.aiQuality.runResults)) {
      issues.push("manifest.aiQuality.runResults must be an array");
    } else {
      if (manifest.aiQuality.runResults.length < 2) {
        issues.push("manifest.aiQuality.runResults must contain at least 2 runs");
      }
      if (manifest.aiQuality.runs !== manifest.aiQuality.runResults.length) {
        issues.push("manifest.aiQuality.runs must equal manifest.aiQuality.runResults.length");
      }
      const runIds = [];
      for (const [index, runResult] of manifest.aiQuality.runResults.entries()) {
        const path = `manifest.aiQuality.runResults[${index}]`;
        if (!inspectClosedObject(
          runResult,
          path,
          ["runId", "completedAt", "metrics", "evidence"],
          ["runId", "completedAt", "metrics", "evidence"],
          issues,
        )) continue;
        if (typeof runResult.runId !== "string" || !runResult.runId.trim()) {
          issues.push(`${path}.runId must be non-empty`);
        } else {
          runIds.push(runResult.runId.trim());
        }
        inspectIsoDate(runResult.completedAt, `${path}.completedAt`, issues);
        inspectAiMetrics(runResult.metrics, `${path}.metrics`, issues);
        inspectEvidence(runResult.evidence, `${path}.evidence`, issues);
      }
      if (runIds.length === manifest.aiQuality.runResults.length && new Set(runIds).size !== runIds.length) {
        issues.push("manifest.aiQuality.runResults must use distinct runId values");
      }
    }
  }

  const approvalNames = ["owner", "securityDataReviewer"];
  if (inspectClosedObject(
    manifest.approvals,
    "manifest.approvals",
    approvalNames,
    approvalNames,
    issues,
  )) {
    const approverIdentifiers = [];
    for (const approvalName of approvalNames) {
      const approval = manifest.approvals[approvalName];
      const path = `manifest.approvals.${approvalName}`;
      if (!inspectClosedObject(
        approval,
        path,
        ["decision", "approver", "decidedAt", "evidence"],
        ["decision", "approver", "decidedAt", "evidence"],
        issues,
      )) continue;
      if (approval.decision !== "approved") issues.push(`${path}.decision must be approved`);
      if (typeof approval.approver !== "string" || !approval.approver.trim()) {
        issues.push(`${path}.approver must be non-empty`);
      } else {
        approverIdentifiers.push(approval.approver.trim().toLocaleLowerCase("en-US"));
      }
      inspectIsoDate(approval.decidedAt, `${path}.decidedAt`, issues);
      if (typeof approval.evidence !== "string" || !approval.evidence.trim()) {
        issues.push(`${path}.evidence must be non-empty`);
      }
    }
    if (
      approverIdentifiers.length === approvalNames.length &&
      new Set(approverIdentifiers).size !== approvalNames.length
    ) {
      issues.push("manifest.approvals owner and securityDataReviewer must have distinct approver identifiers");
    }
  }

  return issues;
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isWithinRoot(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

export function resolveManifestArtifactPath(root, configuredPath) {
  const issues = [];
  if (typeof configuredPath !== "string" || !configuredPath.trim()) {
    return { path: null, issues: ["RELEASE_MANIFEST_PATH is required for an exact release tag"] };
  }

  const requestedPath = configuredPath.trim();
  const absolutePath = isAbsolute(requestedPath) ? requestedPath : resolve(root, requestedPath);
  if (!absolutePath.toLowerCase().endsWith(".json")) {
    issues.push("RELEASE_MANIFEST_PATH must name a JSON artifact");
  }
  if (!existsSync(absolutePath)) {
    issues.push(`release manifest artifact is missing: ${requestedPath}`);
    return { path: absolutePath, issues };
  }

  let canonicalPath;
  try {
    canonicalPath = realpathSync(absolutePath);
    if (!statSync(canonicalPath).isFile()) {
      issues.push(`release manifest artifact is not a regular file: ${requestedPath}`);
    }
  } catch (error) {
    issues.push(`release manifest artifact cannot be resolved: ${error instanceof Error ? error.message : error}`);
    return { path: absolutePath, issues };
  }
  if (!canonicalPath.toLowerCase().endsWith(".json")) {
    issues.push("RELEASE_MANIFEST_PATH must resolve to a JSON artifact");
  }

  return { path: canonicalPath, issues };
}

export function verifyReleaseManifestForCurrentCheckout({
  root = REPOSITORY_ROOT,
  env = process.env,
  allowUnpublishedImages = false,
} = {}) {
  const issues = [];
  const exactTagNames = git(root, ["tag", "--points-at", "HEAD"])
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const requirement = determineReleaseRequirement({
    exactTagNames,
    githubRefType: env.GITHUB_REF_TYPE,
    githubRefName: env.GITHUB_REF_NAME,
  });
  issues.push(...requirement.issues);
  if (!requirement.required) return { required: false, tag: null, manifestPath: null, issues };

  const version = loadVersionSource(root);
  const parsedTag = requirement.tag ? parseReleaseTag(requirement.tag) : null;
  if (!parsedTag || parsedTag.version !== version) {
    issues.push(`release tag ${requirement.tag ?? "<missing>"} must target version ${version}`);
  }
  // The first foundation slice implements the absolute rc.1 gate only. Later
  // RCs need a verified previous-manifest comparison, and the stable tag needs
  // the 14-day promotion evidence. Keep both fail-closed until those contracts
  // are implemented rather than silently accepting incomplete declarations.
  if (requirement.tag) issues.push(...inspectImplementedReleaseStage(requirement.tag));
  if (requirement.tag) {
    try {
      const objectType = git(root, ["cat-file", "-t", `refs/tags/${requirement.tag}`]);
      if (objectType !== "tag") issues.push(`release tag ${requirement.tag} must be annotated`);
    } catch {
      issues.push(`release tag ${requirement.tag} is unavailable in the checkout`);
    }
  }

  const artifact = resolveManifestArtifactPath(root, env.RELEASE_MANIFEST_PATH);
  issues.push(...artifact.issues);
  if (!artifact.path || artifact.issues.length > 0) {
    return { required: true, tag: requirement.tag, manifestPath: artifact.path, issues };
  }
  const absolutePath = artifact.path;

  // A manifest contains the immutable HEAD commit it describes, so committing
  // that same manifest would create an impossible self-reference. It must be a
  // post-tag CI/release artifact (outside the checkout or in an ignored path).
  if (isWithinRoot(root, absolutePath)) {
    const relativePath = relative(root, absolutePath);
    try {
      git(root, ["ls-files", "--error-unmatch", relativePath]);
      issues.push(`release manifest artifact must not be tracked by Git: ${relativePath}`);
    } catch {
      // Expected: generated artifacts are deliberately untracked/ignored.
    }
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    issues.push(`release manifest is invalid JSON: ${error instanceof Error ? error.message : error}`);
    return { required: true, tag: requirement.tag, manifestPath: absolutePath, issues };
  }

  const journalBytes = readFileSync(resolve(root, JOURNAL_PATH));
  const journal = JSON.parse(journalBytes.toString("utf8"));
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const context = {
    version,
    tag: requirement.tag,
    commit: git(root, ["rev-parse", "HEAD"]),
    sourceDateEpoch: Number(git(root, ["show", "-s", "--format=%ct", "HEAD"])),
    nodeVersion: process.version,
    githubRunId: env.GITHUB_RUN_ID,
    migration: {
      journalPath: JOURNAL_PATH,
      journalDigest: `sha256:${createHash("sha256").update(journalBytes).digest("hex")}`,
      latestMigration: entries.at(-1)?.tag ?? null,
      migrationCount: entries.length,
    },
    allowUnpublishedImages,
  };
  issues.push(...validateReleaseManifest(manifest, context));
  return { required: true, tag: requirement.tag, manifestPath: absolutePath, issues };
}

function main() {
  try {
    const allowUnpublishedImages = process.argv.includes("--allow-unpublished-images");
    const result = verifyReleaseManifestForCurrentCheckout({ allowUnpublishedImages });
    if (result.issues.length > 0) {
      for (const issue of result.issues) console.error(`release manifest verification failed: ${issue}`);
      process.exitCode = 1;
      return;
    }
    console.log(result.required
      ? `release manifest OK (${result.tag}; ${result.manifestPath})`
      : "release manifest not required (no exact release tag)");
  } catch (error) {
    console.error(`release manifest verification failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main();
}
