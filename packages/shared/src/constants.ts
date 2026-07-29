/** Maximum number of queued (pending) jobs allowed per workspace. */
export const MAX_PENDING_JOBS_PER_WORKSPACE = 50;

/** Explicit product limits for one learning-card generation snapshot. */
export const CARD_GENERATION_MAX_SOURCE_CHARS = 500_000;
export const CARD_GENERATION_MAX_BLOCKS = 2_000;
export const CARD_GENERATION_MAX_IMAGES = 30;

/** At most this many map jobs from one run are pending/running at once. */
export const CARD_GENERATION_MAP_WINDOW = 3;

/** At most this many independent image-analysis jobs from one run are active. */
export const CARD_GENERATION_IMAGE_WINDOW = 2;

/** Hard image-evidence confidence floor, represented as basis points. */
export const CARD_GENERATION_IMAGE_EVIDENCE_MIN_CONFIDENCE_BPS = 8_000;

/** v0.4 release-quality benchmark contract shared by API, Web and CI. */
export const BENCHMARK_MIN_SAMPLE_COUNT = 30;

export const BENCHMARK_QUALITY_THRESHOLDS = {
  hardCitationPrecision: 0.9,
  keyPointHardCoverage: 0.85,
  expectedBlockHardCoverage: 0.85,
} as const;
