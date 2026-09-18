#!/usr/bin/env node
/**
 * REL-01: Docker 镜像 digest 捕获脚本
 *
 * 在 production-compose CI job 构建完两个生产镜像后运行此脚本，
 * 捕获每个镜像的 canonical sha256 digest 并输出为 JSON。
 *
 * 该 JSON 随后作为 CI artifact 上传，由 release-evidence job 下载
 * 并注入到 RC release manifest 的 images 字段中，替换占位符。
 *
 * 用法：
 *   node .github/scripts/capture-image-digests.mjs [--output <path>] [--allow-local]
 *
 * 环境变量：
 *   COMPOSE_PROJECT_NAME — docker compose 项目名（默认 ailearn_ci）
 *   GITHUB_RUN_ID        — GitHub Actions run ID（用于 provenance）
 *
 * 退出码：
 *   0 — 所有镜像 digest 捕获成功
 *   1 — 有镜像缺失或 digest 格式无效
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

// ─── 参数解析 ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let outputPath = null;
let allowLocal = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--output" && args[i + 1]) {
    outputPath = args[i + 1];
    i++;
  } else if (args[i] === "--allow-local") {
    allowLocal = true;
  }
}

const repoRoot = resolve(import.meta.dirname, "..", "..");
const projectName = process.env.COMPOSE_PROJECT_NAME || "ailearn_ci";
const githubRunId = process.env.GITHUB_RUN_ID || "0";

// ─── 镜像定义 ───────────────────────────────────────────────────────────

/**
 * 两个生产镜像：api / worker
 * 镜像名由 docker compose 基于 COMPOSE_PROJECT_NAME 和 service 名生成
 */
const IMAGES = [
  { key: "api", serviceName: "api", repository: "ghcr.io/asklins223/ailearn/api" },
  { key: "worker", serviceName: "worker", repository: "ghcr.io/asklins223/ailearn/worker" },
];

// ─── 工具函数 ───────────────────────────────────────────────────────────

/**
 * 从 docker inspect 输出中提取镜像的 RepoDigests 和 Id
 *
 * docker compose build 产生的本地镜像没有 RepoDigests（因为未 push 到 registry），
 * 但有 ConfigDigest（即 image id 的 sha256）。
 * 对于 release manifest，我们使用本地构建产物的 sha256 作为 digest，
 * 并在 provenance 中标注 deploymentEnvironment 为 "ci-compose-smoke"。
 *
 * 如果镜像已 push 到 registry（如 ghcr.io），则使用 RepoDigests 中的 canonical digest。
 */
function getImageInfo(imageName, expectedRepository) {
  let inspectRaw;
  try {
    inspectRaw = execFileSync(
      "docker",
      ["image", "inspect", "--format", "{{json .}}", imageName],
      { encoding: "utf8", timeout: 30_000 },
    ).trim();
  } catch (err) {
    return { found: false, error: err.message };
  }

  const inspect = JSON.parse(inspectRaw);

  // RepoDigests: ["ghcr.io/.../api@sha256:abcdef..."]
  const repoDigests = inspect.RepoDigests || [];
  let canonicalDigest = null;
  let canonicalRepository = null;

  for (const rd of repoDigests) {
    const match = rd.match(/^(.+)@(sha256:[0-9a-f]{64})$/);
    if (match && match[1] === expectedRepository) {
      canonicalRepository = match[1];
      canonicalDigest = match[2];
      break;
    }
  }

  // If no RepoDigests (local build only), use the image's config digest
  // The image ID from docker inspect is like "sha256:abcdef..."
  let digestSource = "registry";
  if (!canonicalDigest && allowLocal) {
    const imageId = inspect.Id || "";
    if (imageId.startsWith("sha256:")) {
      canonicalDigest = imageId;
      canonicalRepository = `docker-daemon/${imageName}`;
      digestSource = "local";
    }
  }

  // Build timestamp from Created field
  const builtAt = inspect.Created
    ? new Date(inspect.Created).toISOString()
    : new Date().toISOString();

  // Platform
  const arch = inspect.Architecture || "amd64";
  const os = inspect.Os || "linux";
  const platform = `${os}/${arch}`;

  return {
    found: true,
    digest: canonicalDigest,
    repository: canonicalRepository,
    digestSource,
    builtAt,
    platform,
    imageId: inspect.Id || "",
  };
}

// ─── 主流程 ─────────────────────────────────────────────────────────────

console.log("[capture-image-digests] 捕获生产镜像 digest...");
console.log(`[capture-image-digests] COMPOSE_PROJECT_NAME: ${projectName}`);
console.log(`[capture-image-digests] GITHUB_RUN_ID: ${githubRunId}`);
console.log("");

const imageResults = {};
const errors = [];

for (const img of IMAGES) {
  const imageName = `${projectName}-${img.serviceName}`;
  console.log(`[capture-image-digests] 检查镜像: ${imageName}`);

  const info = getImageInfo(imageName, img.repository);

  if (!info.found) {
    console.error(`[capture-image-digests]   ✗ 镜像未找到: ${imageName}`);
    errors.push(`镜像 ${imageName} 未找到`);
    continue;
  }

  if (!info.digest) {
    console.error(`[capture-image-digests]   ✗ 缺少 ${img.repository}@sha256 RepoDigest`);
    errors.push(`镜像 ${imageName} 尚未以 ${img.repository} push 到 registry`);
    continue;
  }

  // Validate digest format
  if (!/^sha256:[0-9a-f]{64}$/.test(info.digest)) {
    console.error(`[capture-image-digests]   ✗ digest 格式无效: ${info.digest}`);
    errors.push(`镜像 ${imageName} digest 格式无效: ${info.digest}`);
    continue;
  }

  // Check for placeholder-like digests (all same char)
  const hashPart = info.digest.replace("sha256:", "");
  const isPlaceholder = [1, 2, 4, 8, 16].some(
    (width) => hashPart.slice(0, width).repeat(64 / width) === hashPart,
  );
  if (isPlaceholder) {
    console.error(`[capture-image-digests]   ✗ digest 疑似占位符: ${info.digest}`);
    errors.push(`镜像 ${imageName} digest 疑似占位符`);
    continue;
  }

  console.log(`[capture-image-digests]   ✓ digest: ${info.digest.substring(0, 24)}...`);
  console.log(`[capture-image-digests]     platform: ${info.platform}`);
  console.log(`[capture-image-digests]     builtAt: ${info.builtAt}`);
  console.log(`[capture-image-digests]     source: ${info.digestSource}`);

  imageResults[img.key] = {
    repository: info.repository,
    digest: info.digest,
    platform: info.platform,
    publishable: info.digestSource === "registry",
    provenance: {
      buildRunId: githubRunId,
      builtAt: info.builtAt,
      deploymentEnvironment: info.digestSource === "registry" ? "registry" : "ci-local-compose-smoke",
      observedAt: new Date().toISOString(),
      observedDigest: info.digest,
      evidence: [`ci://run/${githubRunId}/images/${img.key}`],
    },
  };
}

console.log("");

if (errors.length > 0) {
  console.error("[capture-image-digests] ========================================");
  console.error(`[capture-image-digests]  失败: ${errors.length} 项`);
  for (const err of errors) {
    console.error(`[capture-image-digests]   - ${err}`);
  }
  console.error("[capture-image-digests] ========================================");
  process.exit(1);
}

// Verify all three images have distinct digests
const digests = Object.values(imageResults).map((r) => r.digest);
if (new Set(digests).size !== digests.length) {
  console.error("[capture-image-digests] 错误: 三个镜像的 digest 必须互不相同");
  process.exit(1);
}

const output = {
  capturedAt: new Date().toISOString(),
  githubRunId,
  composeProjectName: projectName,
  releaseReady: Object.values(imageResults).every((image) => image.publishable),
  images: imageResults,
};

const manifestPath = outputPath || join(repoRoot, "outputs", "image-digests.json");
mkdirSync(join(manifestPath, ".."), { recursive: true });
writeFileSync(manifestPath, JSON.stringify(output, null, 2));

console.log("[capture-image-digests] ========================================");
console.log(`[capture-image-digests]  捕获 ${Object.keys(imageResults).length} 个镜像 digest`);
console.log(`[capture-image-digests]  输出: ${manifestPath}`);
console.log("[capture-image-digests] ========================================");

process.exit(0);
