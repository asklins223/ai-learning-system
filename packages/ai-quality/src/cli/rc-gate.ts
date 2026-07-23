#!/usr/bin/env node
/**
 * AIQ-01 RC 门禁 CLI 入口
 *
 * 用法：
 *   DASHSCOPE_API_KEY=sk-xxx \
 *   DASHSCOPE_MODEL=qwen-plus \
 *   node --import tsx src/cli/rc-gate.ts
 *
 * 可选环境变量：
 *   DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/api/v1
 *   AIQ_RC_MAX_BUDGET_USD=10
 *   AIQ_INPUT_USD_PER_1K_TOKENS=0.004
 *   AIQ_OUTPUT_USD_PER_1K_TOKENS=0.012
 *   AIQ_RC_PREVIOUS_METRICS_JSON='{"hardCitationPrecision":0.92,...}'
 *
 * 对应 ADR-0005 第 3 条：
 * "RC 门禁使用固定参考 Provider 对 30 篇完整黄金集运行 2 次，
 *  两次都必须满足 90% / 85% / 85% 绝对阈值"。
 *
 * 这是带成本的门禁（真实 Provider 调用），只在 RC 候选版时运行，
 * 不在普通 PR 中运行。
 */

import {
  ProviderError,
  runRCGate,
  type ProviderClient,
  type ProviderCallResult,
} from "../rc-runner.ts";
import { realAlignEvidence } from "../real-align.ts";
import { DEFAULT_RC_CONFIG } from "../rc-runner.ts";
import type { DatasetBlock, ModelCardOutput, ScorerMetrics } from "../types.ts";
import { learningCardOutputSchema } from "@ailearn/shared";
import { resolveDashScopeTextEndpoint } from "@ailearn/shared/ai-endpoints";
import { SYSTEM_PROMPT } from "@ailearn/shared/prompts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GOLDEN_DATASET } from "../dataset.ts";
import { GOLDEN_LABELS } from "../labels.ts";
import {
  calculateProviderUsageCost,
  parseRCBudgetUsd,
  resolveTokenPricing,
} from "../provider-usage-cost.ts";

// ─── DashScope RC ProviderClient ────────────────────────────────────

/**
 * DashScope ProviderClient for RC gate.
 *
 * Wraps the DashScope text-generation endpoint, returning ModelCardOutput
 * plus revision and cost information for the RC manifest.
 */
class DashScopeRCClient implements ProviderClient {
  private readonly apiKey: string;
  private readonly basePath: string;
  private readonly modelId: string;
  private readonly request: typeof globalThis.fetch;
  private readonly inputUsdPerThousandTokens: number;
  private readonly outputUsdPerThousandTokens: number;
  private readonly requestTimeoutMs: number;

  constructor() {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      console.error("DASHSCOPE_API_KEY is required for RC gate");
      process.exit(2);
    }
    this.apiKey = apiKey;
    this.modelId = process.env.DASHSCOPE_MODEL ?? "qwen-plus";
    const pricing = resolveTokenPricing(
      this.modelId,
      process.env.AIQ_INPUT_USD_PER_1K_TOKENS,
      process.env.AIQ_OUTPUT_USD_PER_1K_TOKENS,
    );
    this.inputUsdPerThousandTokens = pricing.inputUsdPerThousandTokens;
    this.outputUsdPerThousandTokens = pricing.outputUsdPerThousandTokens;
    this.requestTimeoutMs = Number(process.env.AIQ_PROVIDER_TIMEOUT_MS ?? 120_000);
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("AIQ_PROVIDER_TIMEOUT_MS 必须是正数");
    }
    this.basePath = (
      process.env.DASHSCOPE_BASE_URL
      ?? "https://dashscope.aliyuncs.com/api/v1"
    ).replace(/\/$/, "");
    this.request = globalThis.fetch;
  }

  getEndpointOrigin(): string {
    return new URL(this.basePath).origin;
  }

  getModelId(): string {
    return this.modelId;
  }

  async generateCard(
    blocks: DatasetBlock[],
    signal?: AbortSignal,
  ): Promise<ProviderCallResult> {
    const endpoint = resolveDashScopeTextEndpoint(this.basePath, this.modelId);

    const userContent = JSON.stringify({
      note_title: "AIQ-01 RC Gate Sample",
      blocks: blocks.map((b, i) => ({ ordinal: i, type: b.type, content: b.content })),
    });

    const messages = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      { role: "user" as const, content: userContent },
    ];

    const body = {
      model: this.modelId,
      messages,
      temperature: 0.2,
      response_format: { type: "json_object" as const },
      stream: false,
    };

    const response = await this.request(endpoint.url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)])
        : AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const message = `DashScope ${response.status}: ${text || response.statusText}`;
      // Authentication, throttling/request-timeout and 5xx are classified as
      // infrastructure evidence per ADR-0005. The runner retries at most twice
      // and remains blocked unless a complete round eventually succeeds.
      if (
        response.status === 401
        || response.status === 403
        || response.status === 408
        || response.status === 429
        || response.status >= 500
      ) {
        throw new ProviderError(message, "infrastructure");
      }
      throw new Error(message);
    }

    const payload = await response.json() as Record<string, unknown>;

    // Extract text content
    const choices = (payload?.choices as Array<{ message: { content: string } }>) ?? [];
    const text = choices[0]?.message?.content;
    if (!text) {
      throw new Error("DashScope returned empty output");
    }

    // Parse JSON from text
    const parsed = safeParseJson(text);
    const result = learningCardOutputSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `DashScope output failed schema check: ${result.error.issues.slice(0, 3).map((i) => i.message).join("; ")}`,
      );
    }

    // Extract revision from response headers or body
    const revision =
      response.headers.get("x-dashscope-model-revision")
      ?? (payload as Record<string, unknown>)?.model_revision as string | null
      ?? null;

    // Budget evidence must use Provider-reported token usage. Character-count
    // estimates omit the system prompt and can under-report actual spend.
    let costUsd: number;
    try {
      costUsd = calculateProviderUsageCost(payload, {
        inputUsdPerThousandTokens: this.inputUsdPerThousandTokens,
        outputUsdPerThousandTokens: this.outputUsdPerThousandTokens,
      });
    } catch {
      throw new ProviderError("DashScope 未返回有效 token usage，预算证据不可验证", "content");
    }

    return {
      output: result.data as unknown as ModelCardOutput,
      revision,
      costUsd,
    };
  }
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

// ─── CLI 主逻辑 ─────────────────────────────────────────────────────

async function main() {
  const outputArgIndex = process.argv.indexOf("--output");
  const outputPath = outputArgIndex >= 0 ? process.argv[outputArgIndex + 1] : null;
  if (outputArgIndex >= 0 && !outputPath) {
    console.error("--output requires a path");
    process.exit(2);
  }

  const provider = new DashScopeRCClient();

  // Parse previous RC metrics from env (optional)
  let previousRCMetrics: ScorerMetrics | null = null;
  const prevJson = process.env.AIQ_RC_PREVIOUS_METRICS_JSON;
  if (prevJson) {
    try {
      previousRCMetrics = JSON.parse(prevJson) as ScorerMetrics;
    } catch {
      console.error(`AIQ_RC_PREVIOUS_METRICS_JSON is not valid JSON`);
      process.exit(2);
    }
  }

  let maxBudgetUsd: number;
  try {
    maxBudgetUsd = parseRCBudgetUsd(
      process.env.AIQ_RC_MAX_BUDGET_USD,
      DEFAULT_RC_CONFIG.maxBudgetUsd,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  const config = {
    provider,
    alignEvidence: realAlignEvidence,
    ...DEFAULT_RC_CONFIG,
    maxBudgetUsd,
    previousRCMetrics,
  };

  console.error(`Starting RC gate: model=${provider.getModelId()}, endpoint=${provider.getEndpointOrigin()}`);
  console.error(`Budget: $${config.maxBudgetUsd}, Rounds: ${config.maxRounds}`);

  const result = await runRCGate(config);

  const repoRoot = resolve(import.meta.dirname, "../../../..");
  const scorerCommit = process.env.AIQ_SCORER_COMMIT ?? execFileSync(
    "git",
    ["log", "-1", "--format=%H", "--", "packages/ai-quality/src/scorer.ts"],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
  const datasetDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify({ dataset: GOLDEN_DATASET, labels: GOLDEN_LABELS }))
    .digest("hex")}`;
  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    datasetDigest,
    sampleCount: GOLDEN_DATASET.length,
    scorerCommit,
    result,
  };

  if (outputPath) {
    mkdirSync(dirname(resolve(outputPath)), { recursive: true });
    writeFileSync(resolve(outputPath), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    console.error(`RC gate evidence written to ${resolve(outputPath)}`);
  }

  // Output JSON result to stdout
  console.log(JSON.stringify(artifact, null, 2));

  // Exit code: 0 = pass, 1 = fail
  process.exit(result.passed ? 0 : 1);
}

main().catch((err) => {
  console.error("RC gate failed with unhandled error:", err);
  process.exit(1);
});
