import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GOLDEN_DATASET } from "./dataset.ts";
import { mockAlignEvidence, generateMockOutput } from "./pr-runner.ts";
import {
  DEFAULT_RC_CONFIG,
  ProviderError,
  averageMetrics,
  checkRegression,
  isInfrastructureError,
  runRCGate,
  type ProviderClient,
  type RCRoundResult,
  type RCRunnerConfig,
} from "./rc-runner.ts";
import { meetsRCThreshold } from "./scorer.ts";
import type { ScorerMetrics } from "./types.ts";

function makeProvider(
  generateCard: ProviderClient["generateCard"],
): ProviderClient {
  return {
    generateCard,
    getEndpointOrigin: () => "https://provider.example.test",
    getModelId: () => "reference-model-v1",
  };
}

function makeConfig(
  provider: ProviderClient,
  overrides: Partial<RCRunnerConfig> = {},
): RCRunnerConfig {
  return {
    ...DEFAULT_RC_CONFIG,
    provider,
    alignEvidence: mockAlignEvidence,
    infraRetryDelayMs: 0,
    ...overrides,
  };
}

function makeRound(metrics: ScorerMetrics): RCRoundResult {
  return {
    round: 1,
    results: [],
    modelRevision: "revision-1",
    modelRevisions: ["revision-1"],
    budgetUsedUsd: 0,
    report: {
      scorerVersion: "test",
      datasetVersion: "test",
      labelVersion: "test",
      promptVersion: "test",
      timestamp: new Date(0).toISOString(),
      totalSamples: 0,
      totalKeyPoints: 0,
      metrics,
      hasLabels: true,
    },
  };
}

describe("RC runner helpers", () => {
  it("classifies only retryable provider and transport failures as infrastructure", () => {
    assert.equal(
      isInfrastructureError(new ProviderError("upstream unavailable", "infrastructure")),
      true,
    );
    assert.equal(isInfrastructureError(new ProviderError("bad json", "schema")), false);
    assert.equal(isInfrastructureError(new Error("request timeout")), true);
    assert.equal(isInfrastructureError(new Error("HTTP 503")), true);
    assert.equal(isInfrastructureError(new Error("HTTP 429")), true);
    assert.equal(isInfrastructureError(new Error("HTTP 504")), true);
    const namedInfrastructureError = new Error("upstream unavailable");
    namedInfrastructureError.name = "InfrastructureError";
    assert.equal(isInfrastructureError(namedInfrastructureError), true);
    assert.equal(
      isInfrastructureError(new TypeError("fetch failed", {
        cause: Object.assign(new Error("temporary DNS failure"), { code: "EAI_AGAIN" }),
      })),
      true,
    );
    assert.equal(isInfrastructureError(new Error("invalid content")), false);
    assert.equal(isInfrastructureError("timeout"), false);
  });

  it("averages verified rounds and keeps partial verification fail-closed", () => {
    assert.equal(averageMetrics([]).metricsVerified, false);

    const first = makeRound({
      hardCitationPrecision: 1,
      keyPointHardCoverage: 0.9,
      validationExpectedPointsHardCoverage: 0.8,
      metricsVerified: true,
    });
    const second = makeRound({
      hardCitationPrecision: 0.8,
      keyPointHardCoverage: 1,
      validationExpectedPointsHardCoverage: 1,
      metricsVerified: true,
    });
    assert.deepEqual(averageMetrics([first, second]), {
      hardCitationPrecision: 0.9,
      keyPointHardCoverage: 0.95,
      validationExpectedPointsHardCoverage: 0.9,
      metricsVerified: true,
    });

    second.report.metrics.metricsVerified = false;
    const partial = averageMetrics([first, second]);
    assert.equal(partial.metricsVerified, false);
    assert.equal(partial.hardCitationPrecision, 1);
  });

  it("allows an exact two-point drop and reports larger regressions", () => {
    const previous: ScorerMetrics = {
      hardCitationPrecision: 0.95,
      keyPointHardCoverage: 0.95,
      validationExpectedPointsHardCoverage: 0.95,
      metricsVerified: true,
    };
    const exactBoundary: ScorerMetrics = {
      hardCitationPrecision: 0.93,
      keyPointHardCoverage: 0.93,
      validationExpectedPointsHardCoverage: 0.93,
      metricsVerified: true,
    };
    assert.equal(checkRegression(exactBoundary, previous).passed, true);
    assert.equal(checkRegression(exactBoundary, null).passed, true);

    const regressed = checkRegression(
      { ...exactBoundary, hardCitationPrecision: 0.92 },
      previous,
    );
    assert.equal(regressed.passed, false);
    assert.match(regressed.regressions[0], /hardCitationPrecision 下降 3\.00pp/);
  });
});

describe("runRCGate", () => {
  it("runs the complete golden set twice and records a reproducible fingerprint", async () => {
    let calls = 0;
    const provider = makeProvider(async () => {
      const sample = GOLDEN_DATASET[calls % GOLDEN_DATASET.length];
      calls += 1;
      return {
        output: generateMockOutput(sample.file),
        revision: "revision-stable",
        costUsd: 0.001,
      };
    });

    const result = await runRCGate(makeConfig(provider));

    assert.equal(result.passed, true, result.errors.join("\n"));
    assert.equal(result.rounds.length, 2);
    assert.equal(calls, GOLDEN_DATASET.length * 2);
    assert.ok(Math.abs(result.budgetUsedUsd - 0.06) < 1e-9);
    assert.deepEqual(result.averageMetrics, {
      hardCitationPrecision: 1,
      keyPointHardCoverage: 1,
      validationExpectedPointsHardCoverage: 1,
      metricsVerified: true,
    });
    assert.equal(result.config.providerEndpointOrigin, "https://provider.example.test");
    assert.equal(result.config.modelId, "reference-model-v1");
    assert.equal(result.config.modelRevision, "revision-stable");
    assert.equal(result.failureReason, null);
  });

  it("retries infrastructure failures without skipping a golden sample", async () => {
    let attempts = 0;
    let successes = 0;
    const provider = makeProvider(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new ProviderError("temporary 503", "infrastructure");
      }
      const sample = GOLDEN_DATASET[successes];
      successes += 1;
      return {
        output: generateMockOutput(sample.file),
        revision: "revision-retry",
        costUsd: 0,
      };
    });

    const result = await runRCGate(makeConfig(provider, {
      maxRounds: 1,
      maxInfraRetries: 1,
    }));

    assert.equal(result.passed, true, result.errors.join("\n"));
    assert.equal(attempts, GOLDEN_DATASET.length + 1);
    assert.equal(successes, GOLDEN_DATASET.length);
  });

  it("keeps schema failures and missing revisions fail-closed", async () => {
    let calls = 0;
    const provider = makeProvider(async () => {
      calls += 1;
      throw new ProviderError("invalid provider schema", "schema");
    });

    const result = await runRCGate(makeConfig(provider, {
      maxRounds: 1,
      maxInfraRetries: 2,
    }));

    assert.equal(result.passed, false);
    assert.equal(calls, GOLDEN_DATASET.length);
    assert.equal(result.averageMetrics.metricsVerified, false);
    assert.ok(result.errors.some((error) => error.includes("model revision")));
    assert.ok(result.errors.some((error) => error.includes("metricsVerified")));
  });

  it("reports actual spend when a provider call crosses the budget cap", async () => {
    let calls = 0;
    const provider = makeProvider(async () => {
      const sample = GOLDEN_DATASET[calls];
      calls += 1;
      return {
        output: generateMockOutput(sample.file),
        revision: "revision-budget",
        costUsd: 1,
      };
    });

    const result = await runRCGate(makeConfig(provider, {
      maxRounds: 1,
      maxBudgetUsd: 0.5,
    }));

    assert.equal(result.passed, false);
    assert.equal(result.failureReason, "预算超限，RC 保持阻断");
    assert.equal(result.budgetUsedUsd, 1);
    assert.equal(calls, 1);
  });

  it("aborts and blocks when the total RC deadline is exceeded", async () => {
    let calls = 0;
    let observedAbort = false;
    const provider = makeProvider(async (_blocks, signal) => {
      calls += 1;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        signal?.addEventListener("abort", () => {
          observedAbort = true;
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      return {
        output: generateMockOutput(GOLDEN_DATASET[0]!.file),
        revision: "revision-timeout",
        costUsd: 0,
      };
    });

    const result = await runRCGate(makeConfig(provider, {
      maxRunDurationMs: 5,
      maxInfraRetries: 2,
    }));

    assert.equal(result.passed, false);
    assert.equal(result.failureReason, "RC 总运行时限超出，保持阻断");
    assert.equal(calls, 1);
    assert.equal(observedAbort, true);
  });

  it("rejects non-finite or negative provider cost evidence", async () => {
    for (const invalidCost of [Number.NaN, Number.POSITIVE_INFINITY, -0.01]) {
      let calls = 0;
      const provider = makeProvider(async () => {
        const sample = GOLDEN_DATASET[calls % GOLDEN_DATASET.length];
        calls += 1;
        return {
          output: generateMockOutput(sample.file),
          revision: "revision-cost",
          costUsd: invalidCost,
        };
      });

      const result = await runRCGate(makeConfig(provider, { maxRounds: 1 }));
      assert.equal(result.passed, false);
      assert.ok(result.rounds[0]?.results.every((sample) => sample.error));
    }
  });

  it("requires every round to meet the absolute threshold", async () => {
    let providerCalls = 0;
    let alignmentCalls = 0;
    const provider = makeProvider(async () => {
      const sample = GOLDEN_DATASET[providerCalls % GOLDEN_DATASET.length];
      providerCalls += 1;
      return {
        output: generateMockOutput(sample.file),
        revision: "revision-round-threshold",
        costUsd: 0,
      };
    });
    const alignEvidence = (noteFile: string, output: Parameters<typeof mockAlignEvidence>[1]) => {
      const round = Math.floor(alignmentCalls / GOLDEN_DATASET.length);
      const sample = alignmentCalls % GOLDEN_DATASET.length;
      alignmentCalls += 1;
      const alignments = mockAlignEvidence(noteFile, output);
      if (round === 0 && sample < 20 && alignments[0]) {
        alignments[0] = {
          ...alignments[0],
          alignment: "unaligned",
          blockOrdinal: null,
        };
      }
      return alignments;
    };

    const result = await runRCGate(makeConfig(provider, { alignEvidence }));

    assert.equal(meetsRCThreshold(result.rounds[0]!.report.metrics), false);
    assert.equal(meetsRCThreshold(result.rounds[1]!.report.metrics), true);
    assert.equal(meetsRCThreshold(result.averageMetrics), true);
    assert.equal(result.passed, false);
    assert.ok(result.errors.some((error) => error.includes("第 1 轮指标未达到")));
  });

  it("rejects mixed model revisions even when quality metrics pass", async () => {
    let calls = 0;
    const provider = makeProvider(async () => {
      const sample = GOLDEN_DATASET[calls % GOLDEN_DATASET.length];
      const revision = calls < GOLDEN_DATASET.length ? "revision-a" : "revision-b";
      calls += 1;
      return {
        output: generateMockOutput(sample.file),
        revision,
        costUsd: 0,
      };
    });

    const result = await runRCGate(makeConfig(provider));

    assert.equal(result.passed, false);
    assert.ok(result.errors.some((error) => error.includes("不同 model revision")));
  });

  it("rejects model revision drift within a single golden-set round", async () => {
    let calls = 0;
    const provider = makeProvider(async () => {
      const sample = GOLDEN_DATASET[calls % GOLDEN_DATASET.length];
      const revision = calls === GOLDEN_DATASET.length - 1
        ? "revision-late-drift"
        : "revision-stable";
      calls += 1;
      return {
        output: generateMockOutput(sample.file),
        revision,
        costUsd: 0,
      };
    });

    const result = await runRCGate(makeConfig(provider, { maxRounds: 1 }));

    assert.equal(result.passed, false);
    assert.equal(result.rounds[0]?.modelRevision, null);
    assert.deepEqual(
      new Set(result.rounds[0]?.modelRevisions),
      new Set(["revision-stable", "revision-late-drift"]),
    );
    assert.ok(result.errors.some((error) => error.includes("不同 model revision")));
  });
});
