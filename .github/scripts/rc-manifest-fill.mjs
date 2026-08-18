#!/usr/bin/env node
/**
 * REL-01: RC manifest aiQuality 字段填充脚本（已弃用 — V1 supervisor-rc-gate 已删除）
 *
 * 该脚本原调用 packages/ai-quality/src/cli/supervisor-rc-gate.ts 驱动 V1 golden 集。
 * V1 CLI 已于学习卡 V1 清理阶段 E 删除，本脚本保留但输出 not_run 占位，
 * 等待 V2 RC gate CLI（packages/ai-quality/src/card-generation-v2/）就绪后重写。
 *
 * 用法：
 *   node .github/scripts/rc-manifest-fill.mjs \
 *     --input /path/to/release-manifest-rc.json \
 *     --output /path/to/release-manifest-rc-filled.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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

Note: V1 supervisor-rc-gate has been deleted. This script currently
outputs the manifest with aiQuality status "not_run". A V2 RC gate
CLI is pending.

Example:
  node .github/scripts/rc-manifest-fill.mjs \\
    --input outputs/release-manifest-rc.json \\
    --output outputs/release-manifest-rc-filled.json
`);
  process.exit(1);
}

// ─── 主逻辑 ─────────────────────────────────────────────────────

async function main() {
  const { input: inputPath, output: outputPath } = parseArgs();

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

  // 4. V1 supervisor-rc-gate 已删除（学习卡 V1 清理阶段 E）；
  //    暂以 not_run 占位输出，待 V2 RC gate CLI 就绪后重写本段。
  console.error(`V1 supervisor-rc-gate 已删除，aiQuality 保持 not_run 占位`);

  // 5. 保持 manifest.aiQuality 原状（status: not_run）
  manifest.aiQuality = manifest.aiQuality ?? { status: "not_run" };

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

  // 7. V1 已删除，不执行 RC gate 判定
  console.error(`RC gate skipped — V1 supervisor-rc-gate 已删除，等待 V2 重写`);
  process.exit(0);
}

main().catch((err) => {
  console.error("rc-manifest-fill failed with unhandled error:", err);
  process.exit(1);
});
