/** Maximum number of queued (pending) jobs allowed per workspace. */
export const MAX_PENDING_JOBS_PER_WORKSPACE = 50;

/** v0.4 release-quality benchmark contract shared by API, Web and CI. */
export const BENCHMARK_MIN_SAMPLE_COUNT = 30;

export const BENCHMARK_QUALITY_THRESHOLDS = {
  hardCitationPrecision: 0.9,
  keyPointHardCoverage: 0.85,
  expectedBlockHardCoverage: 0.85,
} as const;
