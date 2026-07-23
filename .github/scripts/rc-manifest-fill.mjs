#!/usr/bin/env node
/**
 * REL-01: RC manifest aiQuality 字段填充脚本
 *
 * 用法：
 *   DASHSCOPE_API_KEY=sk-xxx \
 *   DASHSCOPE_MODEL=qwen-plus \
 *   node .github/scripts/rc-manifest-fill.mjs \
 *     --input /path/to/release-manifest-rc.json \
 *     --output /path/to/release-manifest-rc-filled.json
 *
 * 该脚本：
 * 1. 读取 RC manifest（由 release-manifest-generate.mjs --rc 生成）
 * 2. 运行 rc-gate CLI（调用真实 Provider）
 * 3. 将 rc-gate 输出填充到 manifest.aiQuality 字段
 * 4. 输出填充后的 manifest 到指定路径
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

// ─── 参数解析 ─────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {
    input: null,
    output: null,
    evidenceOutput: null,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--input" || arg === "-i") {
      params.input = args[++i];
    } else if (arg === "--output" || arg === "-o") {
      params.output = args[++i];
    } else if (arg === "--evidence-output") {
      params.evidenceOutput = args[++i];
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
    }
    i++;
  }

  if (!params.input || !params.output) {
    console.error("Both --input and --output are required");
    usage();
  }

  return params;
}

function usage() {
  console.error(`
Usage: rc-manifest-fill.mjs --input INPUT --output OUTPUT

Options:
  --input, -i    Path to RC manifest (from release-manifest-generate.mjs --rc)
  --output, -o   Path where filled manifest will be written
  --evidence-output Path for the raw RC gate evidence JSON

Environment variables:
  DASHSCOPE_API_KEY    Required: DashScope API key for RC gate
  DASHSCOPE_MODEL       Optional: Model ID (default: qwen-plus)
  AIQ_RC_MAX_BUDGET_USD Optional: Max budget in USD (default: 10)
  AIQ_RC_PREVIOUS_METRICS_JSON Optional: Previous RC metrics JSON

Example:
  DASHSCOPE_API_KEY=sk-xxx DASHSCOPE_MODEL=qwen-plus \\
  node .github/scripts/rc-manifest-fill.mjs \\
    --input outputs/release-manifest-rc.json \\
    --output outputs/release-manifest-rc-filled.json
`);
  process.exit(1);
}

// ─── 主逻辑 ─────────────────────────────────────────────────────

async function main() {
  const { input: inputPath, output: outputPath, evidenceOutput } = parseArgs();
  const repoRoot = resolve(import.meta.dirname, "../..");
  const evidencePath = resolve(evidenceOutput ?? `${outputPath}.aiq-evidence.json`);

  // 1. 验证输入 manifest 存在
  if (!existsSync(inputPath)) {
    console.error(`Input manifest not found: ${inputPath}`);
    process.exit(1);
  }

  // 2. 读取 manifest
  let manifest;
  try {
    const content = readFileSync(inputPath, "utf8");
    manifest = JSON.parse(content);
  } catch (error) {
    console.error(`Failed to parse manifest: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  // 3. 验证 manifest 结构
  if (!manifest.aiQuality) {
    console.error("Manifest missing aiQuality field");
    process.exit(1);
  }

  // 4. 运行 rc-gate
  console.error(`Running rc-gate on: ${inputPath}`);
  console.error(`Budget: $${process.env.AIQ_RC_MAX_BUDGET_USD ?? 10}, Model: ${process.env.DASHSCOPE_MODEL ?? "qwen-plus"}`);

  let rcGateExitCode = 0;
  try {
    execFileSync(
      "node",
      [
        "--import",
        "tsx",
        resolve(repoRoot, "packages/ai-quality/src/cli/rc-gate.ts"),
        "--output",
        evidencePath,
      ],
      {
      cwd: resolve(repoRoot, "packages/ai-quality"),
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "inherit", "inherit"],
      },
    );
  } catch (error) {
    rcGateExitCode = Number.isInteger(error?.status) ? error.status : 1;
    if (!existsSync(evidencePath)) {
      console.error(`Failed to run rc-gate: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    console.error(`rc-gate exited ${rcGateExitCode}; preserving its failed evidence in the manifest`);
  }

  const artifact = JSON.parse(readFileSync(evidencePath, "utf8"));
  const rcGateOutput = artifact?.result;
  if (
    artifact?.schemaVersion !== 1
    || !/^sha256:[0-9a-f]{64}$/.test(artifact.datasetDigest ?? "")
    || !Number.isInteger(artifact.sampleCount)
    || artifact.sampleCount < 30
    || !/^[0-9a-f]{40}$/.test(artifact.scorerCommit ?? "")
    || !rcGateOutput
    || typeof rcGateOutput.passed !== "boolean"
    || !rcGateOutput.config
    || !Array.isArray(rcGateOutput.rounds)
  ) {
    console.error("RC gate evidence is incomplete or malformed; refusing to synthesize defaults");
    process.exit(1);
  }

  const mapMetrics = (metrics) => ({
    hardCitationPrecision: metrics?.hardCitationPrecision ?? null,
    keyPointHardCoverage: metrics?.keyPointHardCoverage ?? null,
    expectedBlockHardCoverage: metrics?.validationExpectedPointsHardCoverage ?? null,
  });
  const runId = process.env.GITHUB_RUN_ID ?? "local";
  const runResults = rcGateOutput.rounds.map((round) => ({
    runId: `aiq-${runId}-round-${round.round}`,
    completedAt: round.report?.timestamp ?? null,
    metrics: mapMetrics(round.report?.metrics),
    evidence: [`ci://run/${runId}/ai-quality/round-${round.round}`],
  }));

  // 5. 填充 manifest.aiQuality
  manifest.aiQuality = {
    status: rcGateOutput.passed ? "passed" : "failed",
    datasetVersion: rcGateOutput.config.datasetVersion,
    datasetDigest: artifact.datasetDigest,
    sampleCount: artifact.sampleCount,
    labelVersion: rcGateOutput.config.labelVersion,
    scorerCommit: artifact.scorerCommit,
    promptVersion: rcGateOutput.config.promptVersion,
    provider: {
      endpointOrigin: rcGateOutput.config.providerEndpointOrigin,
      modelId: rcGateOutput.config.modelId,
      modelRevision: rcGateOutput.config.modelRevision,
      temperature: rcGateOutput.config.temperature,
    },
    runs: runResults.length,
    runResults,
    metrics: mapMetrics(rcGateOutput.averageMetrics),
    costUsd: rcGateOutput.budgetUsedUsd,
    evidence: [`ci://run/${runId}/ai-quality/rc-gate`],
  };

  // 6. 写入输出 manifest
  try {
    mkdirSync(dirname(resolve(outputPath)), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(manifest, null, 2), "utf8");
    console.error(`Filled manifest written to: ${outputPath}`);
    console.error(`AI Quality status: ${manifest.aiQuality.status}`);
  } catch (error) {
    console.error(`Failed to write output manifest: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  // 7. 根据 rc-gate 结果设置退出码
  if (rcGateExitCode !== 0 || !rcGateOutput.passed) {
    console.error(`RC gate failed: metrics do not meet thresholds`);
    process.exit(1);
  }

  console.error(`RC gate passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error("rc-manifest-fill failed with unhandled error:", err);
  process.exit(1);
});
