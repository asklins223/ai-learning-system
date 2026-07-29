export type PartialCardCoverageWarning = {
  code: "partial_generation";
  excludedImageCount: number;
  excludedUnitIds: string[];
  excludedImages: Array<{
    sourceUnitId: string;
    imageAssetId: string;
    imageBlockId: string;
    reason: string;
  }>;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readPartialCardCoverageWarning(
  schemaJson: unknown,
): PartialCardCoverageWarning | null {
  if (!schemaJson || typeof schemaJson !== "object") return null;

  const coverageWarning = (schemaJson as Record<string, unknown>)
    .coverageWarning;
  if (!coverageWarning || typeof coverageWarning !== "object") return null;

  const warning = coverageWarning as Record<string, unknown>;
  if (
    warning.code !== "partial_generation"
    || !Number.isInteger(warning.excludedImageCount)
    || Number(warning.excludedImageCount) <= 0
    || !Array.isArray(warning.excludedUnitIds)
  ) {
    return null;
  }

  const excludedUnitIds = Array.from(
    new Set(
      warning.excludedUnitIds.filter(
        (value): value is string =>
          typeof value === "string" && UUID_PATTERN.test(value),
      ),
    ),
  );
  const excludedImages = Array.isArray(warning.excludedImages)
    ? warning.excludedImages.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const image = value as Record<string, unknown>;
        if (
          typeof image.sourceUnitId !== "string"
          || !UUID_PATTERN.test(image.sourceUnitId)
          || typeof image.imageAssetId !== "string"
          || !UUID_PATTERN.test(image.imageAssetId)
          || typeof image.imageBlockId !== "string"
          || !UUID_PATTERN.test(image.imageBlockId)
        ) {
          return [];
        }
        const reason =
          typeof image.reason === "string"
          && /^[a-z][a-z0-9_.-]{0,63}$/i.test(image.reason)
            ? image.reason
            : "image_analysis_failed";
        return [{
          sourceUnitId: image.sourceUnitId,
          imageAssetId: image.imageAssetId,
          imageBlockId: image.imageBlockId,
          reason,
        }];
      })
    : [];

  return {
    code: "partial_generation",
    excludedImageCount: Number(warning.excludedImageCount),
    excludedUnitIds,
    excludedImages,
  };
}

/**
 * Card sets keep coverage metadata on the set rather than in a single card
 * schema. Accept both the canonical nested warning and the generation report
 * shape used by the first M5 rollout.
 */
export function readPartialCardSetCoverageWarning(
  coverageReport: unknown,
): PartialCardCoverageWarning | null {
  const nestedWarning = readPartialCardCoverageWarning(coverageReport);
  if (nestedWarning) return nestedWarning;
  if (!coverageReport || typeof coverageReport !== "object") return null;

  const report = coverageReport as Record<string, unknown>;
  const excludedImages = Array.isArray(report.excludedImages)
    ? report.excludedImages.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const image = value as Record<string, unknown>;
        if (
          typeof image.sourceUnitId !== "string"
          || !UUID_PATTERN.test(image.sourceUnitId)
          || typeof image.imageAssetId !== "string"
          || !UUID_PATTERN.test(image.imageAssetId)
          || typeof image.imageBlockId !== "string"
          || !UUID_PATTERN.test(image.imageBlockId)
        ) {
          return [];
        }
        return [{
          sourceUnitId: image.sourceUnitId,
          imageAssetId: image.imageAssetId,
          imageBlockId: image.imageBlockId,
          reason:
            typeof image.reason === "string"
            && /^[a-z][a-z0-9_.-]{0,63}$/i.test(image.reason)
              ? image.reason
              : "image_analysis_failed",
        }];
      })
    : [];
  const explicitCount = Number(report.excludedImageCount);
  const excludedImageCount =
    Number.isInteger(explicitCount) && explicitCount > 0
      ? explicitCount
      : excludedImages.length;
  const isPartial =
    report.resultCompleteness === "partial"
    || report.status === "partial_ready"
    || excludedImageCount > 0;

  if (!isPartial || excludedImageCount <= 0) return null;

  const reportUnitIds = Array.isArray(report.excludedUnitIds)
    ? report.excludedUnitIds
    : [];
  const excludedUnitIds = Array.from(
    new Set(
      [...reportUnitIds, ...excludedImages.map((image) => image.sourceUnitId)]
        .filter(
          (value): value is string =>
            typeof value === "string" && UUID_PATTERN.test(value),
        ),
    ),
  );

  return {
    code: "partial_generation",
    excludedImageCount,
    excludedUnitIds,
    excludedImages,
  };
}

export function formatSafeImageUnitReference(unitId: string) {
  return `${unitId.slice(0, 8)}…${unitId.slice(-4)}`;
}
