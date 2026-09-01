import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(import.meta.dirname, "..");
const defaultManifestPath = resolve(
  appRoot,
  "src/renderer/public/assets/learning-room/v1/manifest.json",
);
const defaultRuntimeRoot = resolve(
  appRoot,
  "src/renderer/public/assets/learning-room/v1",
);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ROOM_LAYER_ALPHA_MODES = new Set([
  "straight-rgba",
  "premultiplied-rgba",
  "blend",
  "opaque-rgb",
]);
const ROOM_LAYER_THEMES = new Set(["day", "night"]);
const ROOM_LAYER_DEPTHS = new Set(["D1", "D2", "D3", "D4", "D5", "D6"]);
const ROOM_LAYER_ORDER_MAX = 63;
const ROOM_LAYER_ANCHOR_IDS = new Set([
  "room.notebook",
  "room.review",
  "room.lamp",
  "room.search",
  "room.graph",
  "room.ambient",
]);
const ROOM_SCENE_WORLD = Object.freeze({ width: 1672, height: 941 });
const ROOM_LAYER_REGISTRATION_BLEED = 2;
const SUPPORTED_EXTENSIONS = new Set([".png", ".webp"]);
const SAFE_ASSET_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isValidLayerOrder(value) {
  return Number.isInteger(value) && value >= 0 && value <= ROOM_LAYER_ORDER_MAX;
}

function isFinitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

function isSafeAssetPath(value) {
  return isNonEmptyString(value)
    && SAFE_ASSET_PATH.test(value)
    && value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function isFinitePair(value) {
  return Array.isArray(value)
    && value.length === 2
    && value.every((item) => Number.isFinite(item));
}

function isNormalizedPair(value) {
  return isFinitePair(value) && value.every((item) => item >= 0 && item <= 1);
}

function isRoomLayerRegistrationWithinWorld(registration) {
  if (
    !isRecord(registration)
    || !isFinitePair(registration.position)
    || !isRecord(registration.size)
    || !isFinitePositive(registration.size.width)
    || !isFinitePositive(registration.size.height)
    || !isNormalizedPair(registration.anchor)
  ) {
    return false;
  }

  const [positionX, positionY] = registration.position;
  const [anchorX, anchorY] = registration.anchor;
  const left = positionX - registration.size.width * anchorX;
  const top = positionY - registration.size.height * anchorY;
  const right = left + registration.size.width;
  const bottom = top + registration.size.height;
  return left >= -ROOM_LAYER_REGISTRATION_BLEED
    && top >= -ROOM_LAYER_REGISTRATION_BLEED
    && right <= ROOM_SCENE_WORLD.width + ROOM_LAYER_REGISTRATION_BLEED
    && bottom <= ROOM_SCENE_WORLD.height + ROOM_LAYER_REGISTRATION_BLEED;
}

function pushReason(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function stableManifestValue(value) {
  if (Array.isArray(value)) return value.map(stableManifestValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableManifestValue(value[key])]),
  );
}

function compareManifestParity(sourceManifest, outputManifest) {
  const reasons = [];
  const sourceFingerprint = isRecord(sourceManifest)
    ? JSON.stringify(stableManifestValue(sourceManifest))
    : null;
  const outputFingerprint = isRecord(outputManifest)
    ? JSON.stringify(stableManifestValue(outputManifest))
    : null;

  if (sourceFingerprint === null) pushReason(reasons, "source-manifest-invalid");
  if (outputFingerprint === null) pushReason(reasons, "output-manifest-invalid");
  if (sourceFingerprint !== null && outputFingerprint !== null && sourceFingerprint !== outputFingerprint) {
    pushReason(reasons, "output-manifest-mismatch");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    sourceLayerCount: Array.isArray(sourceManifest?.roomLayers) ? sourceManifest.roomLayers.length : null,
    outputLayerCount: Array.isArray(outputManifest?.roomLayers) ? outputManifest.roomLayers.length : null,
  };
}

function parsePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.length < 33) return { error: "invalid-image-header" };

  let offset = 8;
  let width = null;
  let height = null;
  let colorType = null;
  let sawIend = false;
  let hasTransparencyChunk = false;

  while (offset + 12 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > buffer.length) return { error: "invalid-image-header" };

    if (chunkType === "IHDR") {
      if (chunkLength !== 13 || width !== null) return { error: "invalid-image-header" };
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      colorType = buffer[dataStart + 9];
      if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
        return { error: "invalid-image-header" };
      }
      if (![0, 2, 3, 4, 6].includes(colorType)) {
        return { error: "invalid-image-header" };
      }
    } else if (chunkType === "tRNS") {
      hasTransparencyChunk = true;
    } else if (chunkType === "IEND") {
      sawIend = true;
      break;
    }

    offset = chunkEnd;
  }

  if (width === null || height === null || colorType === null || !sawIend) {
    return { error: "invalid-image-header" };
  }

  return {
    format: "png",
    width,
    height,
    hasAlphaChannel: [4, 6].includes(colorType) || hasTransparencyChunk,
  };
}

function readWebpChunk(buffer, offset) {
  if (offset + 8 > buffer.length) return null;
  const type = buffer.toString("ascii", offset, offset + 4);
  const length = buffer.readUInt32LE(offset + 4);
  const dataStart = offset + 8;
  const dataEnd = dataStart + length;
  if (dataEnd > buffer.length) return null;
  return { type, length, dataStart, dataEnd, nextOffset: dataEnd + (length % 2) };
}

function readVp8Dimensions(buffer, dataStart, dataEnd) {
  if (dataEnd - dataStart < 10) return null;
  if (
    buffer[dataStart + 3] !== 0x9d
    || buffer[dataStart + 4] !== 0x01
    || buffer[dataStart + 5] !== 0x2a
  ) {
    return null;
  }
  const width = buffer.readUInt16LE(dataStart + 6) & 0x3fff;
  const height = buffer.readUInt16LE(dataStart + 8) & 0x3fff;
  if (!isPositiveInteger(width) || !isPositiveInteger(height)) return null;
  return { width, height };
}

function readVp8lDimensions(buffer, dataStart, dataEnd) {
  if (dataEnd - dataStart < 5 || buffer[dataStart] !== 0x2f) return null;
  const width = 1 + (buffer[dataStart + 1] | ((buffer[dataStart + 2] & 0x3f) << 8));
  const height = 1
    + ((buffer[dataStart + 2] >> 6) | (buffer[dataStart + 3] << 2) | ((buffer[dataStart + 4] & 0x3f) << 10));
  if (!isPositiveInteger(width) || !isPositiveInteger(height)) return null;
  return { width, height };
}

function parseWebp(buffer) {
  if (
    buffer.length < 12
    || buffer.toString("ascii", 0, 4) !== "RIFF"
    || buffer.toString("ascii", 8, 12) !== "WEBP"
  ) return { error: "invalid-image-header" };

  let offset = 12;
  while (offset < buffer.length) {
    const chunk = readWebpChunk(buffer, offset);
    if (!chunk) return { error: "invalid-image-header" };

    if (chunk.type === "VP8X") {
      if (chunk.length < 10) return { error: "invalid-image-header" };
      const flags = buffer[chunk.dataStart];
      const width = 1 + buffer.readUIntLE(chunk.dataStart + 4, 3);
      const height = 1 + buffer.readUIntLE(chunk.dataStart + 7, 3);
      if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
        return { error: "invalid-image-header" };
      }
      return {
        format: "webp",
        width,
        height,
        hasAlphaChannel: Boolean(flags & 0x10),
      };
    }

    if (chunk.type === "VP8 ") {
      const dimensions = readVp8Dimensions(buffer, chunk.dataStart, chunk.dataEnd);
      if (!dimensions) return { error: "invalid-image-header" };
      return { format: "webp", ...dimensions, hasAlphaChannel: false };
    }

    if (chunk.type === "VP8L") {
      const dimensions = readVp8lDimensions(buffer, chunk.dataStart, chunk.dataEnd);
      if (!dimensions) return { error: "invalid-image-header" };
      return { format: "webp", ...dimensions, hasAlphaChannel: true };
    }

    offset = chunk.nextOffset;
  }

  return { error: "invalid-image-header" };
}

/**
 * Inspect the smallest stable source facts needed by the Room layer gate.
 * This intentionally reads headers only; Pixi remains responsible for the
 * browser decode and TextureSource upload path at runtime.
 */
export function inspectRoomLayerRaster(buffer) {
  if (!Buffer.isBuffer(buffer)) return { error: "invalid-image-header" };
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return parsePng(buffer);
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF") return parseWebp(buffer);
  return { error: "unsupported-image-format" };
}

function validateEntryMetadata(entry) {
  const reasons = [];
  if (!isRecord(entry)) {
    return ["invalid-metadata"];
  }
  if (!isNonEmptyString(entry.assetId)) pushReason(reasons, "invalid-metadata");
  if (!isSafeAssetPath(entry.path)) {
    pushReason(reasons, "invalid-asset-path");
  }
  if (!ROOM_LAYER_THEMES.has(entry.theme) || !ROOM_LAYER_DEPTHS.has(entry.depth)) {
    pushReason(reasons, "invalid-metadata");
  }
  if (!isValidLayerOrder(entry.order)) pushReason(reasons, "invalid-layer-order");
  if (entry.anchorId !== null && !isNonEmptyString(entry.anchorId)) {
    pushReason(reasons, "invalid-metadata");
  } else if (isNonEmptyString(entry.anchorId) && !ROOM_LAYER_ANCHOR_IDS.has(entry.anchorId)) {
    pushReason(reasons, "unsupported-anchor");
  }
  if (
    !isRecord(entry.sourceSize)
    || !isPositiveInteger(entry.sourceSize.width)
    || !isPositiveInteger(entry.sourceSize.height)
  ) {
    pushReason(reasons, "invalid-metadata");
  }
  const hasValidRegistration = isRecord(entry.registration)
    && isFinitePair(entry.registration.position)
    && isRecord(entry.registration.size)
    && isFinitePositive(entry.registration.size.width)
    && isFinitePositive(entry.registration.size.height)
    && isNormalizedPair(entry.registration.anchor);
  if (!hasValidRegistration) {
    pushReason(reasons, "invalid-metadata");
  } else if (!isRoomLayerRegistrationWithinWorld(entry.registration)) {
    pushReason(reasons, "registration-out-of-bounds");
  }
  if (!ROOM_LAYER_ALPHA_MODES.has(entry.alphaMode)) pushReason(reasons, "invalid-metadata");
  if (!isNonEmptyString(entry.reviewStatus)) pushReason(reasons, "invalid-metadata");
  if (typeof entry.releaseApproval !== "boolean") pushReason(reasons, "invalid-metadata");
  return reasons;
}

function recordIdentity(entry, index) {
  return {
    index,
    assetId: isNonEmptyString(entry?.assetId) ? entry.assetId : "",
    path: isNonEmptyString(entry?.path) ? entry.path : "",
    theme: typeof entry?.theme === "string" ? entry.theme : "",
    depth: typeof entry?.depth === "string" ? entry.depth : "",
    order: isValidLayerOrder(entry?.order) ? entry.order : null,
  };
}

function isInsideRoot(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (
    relativePath !== ".."
    && !relativePath.startsWith(".." + sep)
    && !isAbsolute(relativePath)
  );
}

function preflightEntry(entry, index, runtimeRoot, seenAssetIds, seenLayerPlacements) {
  const record = recordIdentity(entry, index);
  const reasons = validateEntryMetadata(entry);
  if (isNonEmptyString(entry?.assetId)) {
    if (seenAssetIds.has(entry.assetId)) pushReason(reasons, "duplicate-asset-id");
    seenAssetIds.add(entry.assetId);
  }
  if (
    ROOM_LAYER_THEMES.has(entry?.theme)
    && ROOM_LAYER_DEPTHS.has(entry?.depth)
    && isValidLayerOrder(entry?.order)
  ) {
    const placementKey = JSON.stringify([entry.theme, entry.depth, entry.order]);
    if (seenLayerPlacements.has(placementKey)) pushReason(reasons, "duplicate-layer-order");
    seenLayerPlacements.add(placementKey);
  }

  if (reasons.includes("invalid-asset-path")) {
    return { ...record, status: "blocked", reasons };
  }

  const assetPath = resolve(runtimeRoot, entry.path);
  if (!isInsideRoot(runtimeRoot, assetPath)) {
    pushReason(reasons, "asset-path-outside-root");
  } else {
    try {
      if (!existsSync(assetPath) || !statSync(assetPath).isFile()) pushReason(reasons, "asset-missing");
    } catch {
      pushReason(reasons, "asset-read-failed");
    }
  }

  const extension = extname(entry.path).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) pushReason(reasons, "unsupported-image-format");

  let imageInfo = null;
  if (reasons.every((reason) => !["asset-path-outside-root", "asset-missing"].includes(reason))) {
    try {
      const bytes = readFileSync(assetPath);
      const inspected = inspectRoomLayerRaster(bytes);
      if (inspected?.error) {
        pushReason(reasons, inspected.error);
      } else {
        imageInfo = {
          ...inspected,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
        if (extension !== `.${inspected.format}`) pushReason(reasons, "format-mismatch");
        if (
          isRecord(entry.sourceSize)
          && (inspected.width !== entry.sourceSize.width || inspected.height !== entry.sourceSize.height)
        ) {
          pushReason(reasons, "source-size-mismatch");
        }
        if (entry.alphaMode !== "opaque-rgb" && !inspected.hasAlphaChannel) {
          pushReason(reasons, "alpha-channel-missing");
        }
      }
    } catch {
      pushReason(reasons, "asset-read-failed");
    }
  }

  if (entry.alphaMode === "opaque-rgb") pushReason(reasons, "opaque-layer");
  if (isNonEmptyString(entry.reviewStatus) && entry.reviewStatus.trim().toLowerCase() !== "approved") {
    pushReason(reasons, "review-not-approved");
  }
  if (entry.releaseApproval !== true) pushReason(reasons, "release-not-approved");

  return {
    ...record,
    status: reasons.length === 0 ? "eligible" : "blocked",
    reasons,
    ...(imageInfo ? { image: imageInfo } : {}),
  };
}

/**
 * Preflight the canonical manifest's independent Room layers against the
 * actual runtime asset root. A non-empty blocked result is a build failure;
 * an empty registry remains a valid, explicit current-state result.
 */
export function preflightRoomLayers(manifest, runtimeRoot = defaultRuntimeRoot) {
  if (!isRecord(manifest)) {
    return {
      ok: false,
      candidates: 0,
      eligible: 0,
      blocked: 0,
      records: [],
      manifestReason: "invalid-manifest",
    };
  }

  if (manifest.roomLayers !== undefined && !Array.isArray(manifest.roomLayers)) {
    return {
      ok: false,
      candidates: 0,
      eligible: 0,
      blocked: 0,
      records: [],
      manifestReason: "invalid-room-layers",
    };
  }

  const layers = manifest.roomLayers ?? [];
  const seenAssetIds = new Set();
  const seenLayerPlacements = new Set();
  const records = layers.map((entry, index) => (
    preflightEntry(entry, index, resolve(runtimeRoot), seenAssetIds, seenLayerPlacements)
  ));
  const eligible = records.filter((record) => record.status === "eligible").length;
  const blocked = records.length - eligible;

  return {
    ok: blocked === 0,
    candidates: records.length,
    eligible,
    blocked,
    records,
  };
}

/**
 * Validate the emitted renderer copy against the source asset root. The
 * source and output are preflighted independently, then compared byte-for-
 * byte so a future public-asset transform cannot silently change a layer.
 */
export function preflightRoomLayerOutput(
  manifest,
  sourceRoot,
  outputRoot,
  sourceManifest = manifest,
) {
  const manifestParity = compareManifestParity(sourceManifest, manifest);
  const sourceResult = preflightRoomLayers(sourceManifest, sourceRoot);
  const outputResult = preflightRoomLayers(manifest, outputRoot);
  const records = outputResult.records.map((outputRecord, index) => {
    const sourceRecord = sourceResult.records[index];
    const reasons = [...outputRecord.reasons];
    const sourceReasons = sourceRecord?.reasons ?? ["source-preflight-failed"];
    sourceReasons.forEach((reason) => {
      if (reason !== undefined && !reasons.includes(`source-${reason}`)) {
        reasons.push(`source-${reason}`);
      }
    });

    let sourceSha256 = sourceRecord?.image?.sha256 ?? null;
    let outputSha256 = outputRecord.image?.sha256 ?? null;
    if (sourceRecord?.status === "eligible" && outputRecord.status === "eligible") {
      try {
        const sourceBytes = readFileSync(resolve(sourceRoot, manifest.roomLayers[index].path));
        const outputBytes = readFileSync(resolve(outputRoot, manifest.roomLayers[index].path));
        sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
        outputSha256 = createHash("sha256").update(outputBytes).digest("hex");
        if (sourceSha256 !== outputSha256) pushReason(reasons, "output-hash-mismatch");
      } catch {
        pushReason(reasons, "output-compare-failed");
      }
    }

    return {
      ...outputRecord,
      status: reasons.length === 0 ? "eligible" : "blocked",
      reasons,
      sourceReasons,
      sourceSha256,
      outputSha256,
    };
  });
  const eligible = records.filter((record) => record.status === "eligible").length;

  return {
    ok: manifestParity.ok && eligible === records.length && sourceResult.ok && outputResult.ok,
    candidates: records.length,
    eligible,
    blocked: records.length - eligible,
    manifestParity,
    source: sourceResult,
    output: outputResult,
    records,
  };
}

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

export function runRoomLayerPreflight({
  manifestPath = defaultManifestPath,
  runtimeRoot = defaultRuntimeRoot,
  sourceRoot = null,
  sourceManifestPath = defaultManifestPath,
} = {}) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, candidates: 0, eligible: 0, blocked: 0, records: [], manifestReason: message };
  }
  if (!sourceRoot) return preflightRoomLayers(manifest, runtimeRoot);

  let sourceManifest;
  try {
    sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      candidates: 0,
      eligible: 0,
      blocked: 0,
      records: [],
      manifestReason: `source-manifest: ${message}`,
    };
  }

  return preflightRoomLayerOutput(manifest, sourceRoot, runtimeRoot, sourceManifest);
}

function main() {
  const result = runRoomLayerPreflight({
    manifestPath: readOption("--manifest", defaultManifestPath),
    runtimeRoot: readOption("--runtime-root", defaultRuntimeRoot),
    sourceRoot: readOption("--source-root", null),
    sourceManifestPath: readOption("--source-manifest", defaultManifestPath),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
