#!/usr/bin/env node
/**
 * AIQ-01 RC Smoke Test — 验证 DashScope API 连通性和输出解析
 *
 * 用途：在运行完整 RC gate（30 篇×2 轮，约 $10）之前，
 * 先用 1 个样本验证 API 连通性、输出格式和成本估算。
 *
 * 用法：
 *   DASHSCOPE_API_KEY=sk-xxx \
 *   DASHSCOPE_MODEL=qwen-plus \
 *   node --import tsx src/cli/rc-smoke.ts
 *
 * 退出码：
 *   0 — smoke test 通过，可以运行完整 RC gate
 *   1 — smoke test 失败，需修复后再运行 RC gate
 */

import { GOLDEN_DATASET } from "../dataset.ts";
import { realAlignEvidence } from "../real-align.ts";
import { getGoldenLabels } from "../labels.ts";
import { learningCardOutputSchema } from "@ailearn/shared";
import { resolveDashScopeTextEndpoint } from "@ailearn/shared/ai-endpoints";
import { SYSTEM_PROMPT } from "@ailearn/shared/prompts";
import type { DatasetBlock, ModelCardOutput, AlignmentResult, GoldenLabelFile } from "../types.ts";

// ─── DashScope 调用 ──────────────────────────────────────────────────

async function callDashScope(
  apiKey: string,
  modelId: string,
  basePath: string,
  blocks: DatasetBlock[],
): Promise<{ output: ModelCardOutput; revision: string | null; costUsd: number; rawText: string }> {
  const endpoint = resolveDashScopeTextEndpoint(basePath, modelId);

  const userContent = JSON.stringify({
    note_title: "AIQ-01 RC Smoke Test",
    blocks: blocks.map((b, i) => ({ ordinal: i, type: b.type, content: b.content })),
  });

  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: userContent },
  ];

  const body = {
    model: modelId,
    messages,
    temperature: 0.2,
    response_format: { type: "json_object" as const },
    stream: false,
  };

  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`DashScope ${response.status}: ${text || response.statusText}`);
  }

  const payload = await response.json() as Record<string, unknown>;

  const choices = (payload?.choices as Array<{ message: { content: string } }>) ?? [];
  const text = choices[0]?.message?.content;
  if (!text) {
    throw new Error("DashScope returned empty output");
  }

  const parsed = safeParseJson(text);
  const result = learningCardOutputSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Output failed schema check: ${result.error.issues.slice(0, 3).map((i) => i.message).join("; ")}`,
    );
  }

  const revision =
    response.headers.get("x-dashscope-model-revision")
    ?? (payload as Record<string, unknown>)?.model_revision as string | null
    ?? null;

  const inputTokens = Math.ceil(userContent.length / 4);
  const outputTokens = Math.ceil(text.length / 4);
  const costUsd = (inputTokens * 0.004 + outputTokens * 0.012) / 1000;

  return {
    output: result.data as unknown as ModelCardOutput,
    revision,
    costUsd,
    rawText: text,
  };
}

function safeParseJson(raw: string): unknown {
  const stripped = raw.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // fall through
  }
  const start = stripped.indexOf("{");
  if (start === -1) throw new Error("No JSON object in output");
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inStr) {
      if (escape) { escape = false; } else if (ch === "\\") { escape = true; } else if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; }
    else if (ch === "{") { depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(stripped.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  throw new Error("Unparseable JSON in output");
}

// ─── 主逻辑 ─────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    console.error("DASHSCOPE_API_KEY is required");
    process.exit(2);
  }

  const modelId = process.env.DASHSCOPE_MODEL ?? "qwen-plus";
  const basePath = (
    process.env.DASHSCOPE_BASE_URL
    ?? "https://dashscope.aliyuncs.com/api/v1"
  ).replace(/\/$/, "");

  console.log("=== AIQ-01 RC Smoke Test ===");
  console.log(`Model: ${modelId}`);
  console.log(`Endpoint: ${basePath}`);
  console.log(`Dataset: ${GOLDEN_DATASET.length} samples (running 1 for smoke)`);
  console.log("");

  // 取第一个样本
  const sample = GOLDEN_DATASET[0];
  console.log(`Sample: ${sample.file} (${sample.blocks.length} blocks)`);

  try {
    const result = await callDashScope(apiKey, modelId, basePath, sample.blocks);

    console.log("");
    console.log("=== API Call Result ===");
    console.log(`Revision: ${result.revision ?? "null"}`);
    console.log(`Cost: $${result.costUsd.toFixed(6)}`);
    console.log(`Output title: ${result.output.title}`);
    console.log(`Output summary: ${result.output.summary.slice(0, 100)}...`);
    console.log(`Key points: ${result.output.key_points.length}`);

    // 对齐证据
    const alignments: AlignmentResult[] = realAlignEvidence(sample.file, result.output);
    console.log("");
    console.log("=== Evidence Alignment ===");
    console.log(`Aligned key points: ${alignments.length}`);
    for (const a of alignments.slice(0, 3)) {
      console.log(`  KP${a.ordinal}: alignment=${a.alignment}, score=${a.alignmentScore}, block=${a.blockOrdinal ?? "null"}`);
    }

    // 评分（单样本，不是完整集）
    const labels: GoldenLabelFile[] = getGoldenLabels();
    const sampleLabel = labels.find((l) => l.noteFile === sample.file);
    if (sampleLabel) {
      console.log("");
      console.log("=== Label Check ===");
      console.log(`Expected key points: ${sampleLabel.keyPoints.length}`);
      console.log(`Sample file has golden labels: yes`);
    }

    console.log("");
    console.log("=== Smoke Test PASSED ===");
    console.log("API connectivity, output parsing, and evidence alignment all work.");
    console.log("");
    console.log("To run the full RC gate (30 samples × 2 rounds, ~$10):");
    console.log("  DASHSCOPE_API_KEY=sk-xxx DASHSCOPE_MODEL=qwen-plus npm run rc-gate");
    console.log("");

    // 估算完整 RC gate 的成本
    const estimatedCost = result.costUsd * 30 * 2;
    console.log(`Estimated full RC gate cost: $${estimatedCost.toFixed(4)} (budget: $10)`);

    process.exit(0);
  } catch (err) {
    console.error("");
    console.error("=== Smoke Test FAILED ===");
    console.error(err instanceof Error ? err.message : String(err));

    if (err instanceof Error && err.stack) {
      console.error("");
      console.error("Stack trace:");
      console.error(err.stack);
    }

    console.error("");
    console.error("Fix the issue above before running the full RC gate.");

    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
