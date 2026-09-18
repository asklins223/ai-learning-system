import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectRoomLayerRaster,
  preflightRoomLayers,
} from "./validate-room-layers.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const workspaceRootDefault = resolve(appRoot, "../..");
const defaultSpecPath = resolve(appRoot, "scripts/fixtures/room-layer-pack.input.json");
const defaultOutputRoot = resolve(
  workspaceRootDefault,
  ".impeccable/review/room-layer-pack-candidate-v1",
);

const ROOM_SCENE_WORLD = Object.freeze({ width: 1672, height: 941 });
const ROOM_LAYER_REGISTRATION_BLEED = 2;
const ROOM_LAYER_ORDER_MAX = 63;
const ROOM_LAYER_ALPHA_MODES = new Set([
  "straight-rgba",
  "premultiplied-rgba",
  "blend",
  "opaque-rgb",
]);
const ROOM_LAYER_THEMES = new Set(["day", "dusk", "night"]);
const ROOM_LAYER_DEPTHS = new Set(["D0", "D1", "D2", "D3", "D4", "D5", "D6"]);
const ROOM_LAYER_ANCHOR_IDS = new Set([
  "room.notebook",
  "room.review",
  "room.lamp",
  "room.search",
  "room.graph",
  "room.ambient",
]);
const SUPPORTED_EXTENSIONS = new Set([".png", ".webp"]);
const SAFE_ASSET_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const PACK_SCHEMA_VERSION = 1;
const GENERATOR_ID = "apps/desktop-client/scripts/generate-room-layer-pack.mjs";
const TARGET_MANIFEST_PATH =
  "apps/desktop-client/src/renderer/public/assets/learning-room/v1/manifest.json";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isInsideRoot(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (
    relativePath !== ".."
    && !relativePath.startsWith(".." + sep)
    && !isAbsolute(relativePath)
  );
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function isSafeSourcePath(value) {
  if (!isNonEmptyString(value) || isAbsolute(value)) return false;
  const normalized = normalizePath(value);
  return normalized.split("/").every((segment) => (
    segment.length > 0 && segment !== "." && segment !== ".."
  ));
}

function isSafeId(value) {
  return isNonEmptyString(value) && SAFE_ID.test(value);
}

function isValidRegistration(registration) {
  if (
    !isRecord(registration)
    || !Array.isArray(registration.position)
    || registration.position.length !== 2
    || !registration.position.every((item) => Number.isFinite(item))
    || !isRecord(registration.size)
    || !isPositiveInteger(registration.size.width)
    || !isPositiveInteger(registration.size.height)
    || !Array.isArray(registration.anchor)
    || registration.anchor.length !== 2
    || !registration.anchor.every((item) => Number.isFinite(item) && item >= 0 && item <= 1)
  ) return false;

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

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value), null, 2) + "\n";
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertSafeOutputRoot(targetRoot, workspaceRoot) {
  const forbiddenRoots = new Set([
    resolve("/"),
    resolve(workspaceRoot),
    resolve(appRoot),
  ]);
  if (forbiddenRoots.has(targetRoot)) {
    throw new Error(`Refusing to use a broad or protected output directory: ${targetRoot}`);
  }
}

async function isGeneratedPackFor(targetRoot, packId) {
  try {
    const pack = JSON.parse(await readFile(resolve(targetRoot, "pack.json"), "utf8"));
    return pack?.generatedBy === GENERATOR_ID && pack?.packId === packId;
  } catch {
    return false;
  }
}

function throwValidationErrors(errors, label = "Room layer pack spec invalid") {
  if (errors.length > 0) {
    throw new Error(`${label}:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
}

function addError(errors, condition, message) {
  if (condition) errors.push(message);
}

async function resolveSourceRoot(spec, workspaceRoot, errors) {
  const sourceRootValue = spec.sourceRoot ?? ".";
  if (!isSafeSourcePath(sourceRootValue) && sourceRootValue !== ".") {
    errors.push("sourceRoot must be a relative path without traversal");
    return resolve(workspaceRoot, ".");
  }

  const sourceRoot = resolve(workspaceRoot, normalizePath(sourceRootValue));
  if (!isInsideRoot(workspaceRoot, sourceRoot)) {
    errors.push("sourceRoot must stay inside the workspace root");
    return resolve(workspaceRoot, ".");
  }
  try {
    if (!(await stat(sourceRoot)).isDirectory()) errors.push("sourceRoot must be a directory");
  } catch {
    errors.push(`sourceRoot does not exist: ${sourceRootValue}`);
  }
  return sourceRoot;
}

function validateTopLevel(spec, errors) {
  addError(errors, !isRecord(spec), "spec must be an object");
  if (!isRecord(spec)) return;
  addError(errors, spec.schemaVersion !== PACK_SCHEMA_VERSION, "schemaVersion must be 1");
  addError(errors, !isSafeId(spec.packId), "packId must contain only letters, numbers, dots, underscores, or hyphens");
  addError(errors, !Number.isInteger(spec.revision) || spec.revision < 1, "revision must be a positive integer");
  addError(errors, spec.coordinateSpace !== "room-1672x941", "coordinateSpace must be room-1672x941");
  addError(
    errors,
    !isRecord(spec.world)
      || spec.world.width !== ROOM_SCENE_WORLD.width
      || spec.world.height !== ROOM_SCENE_WORLD.height,
    `world must be ${ROOM_SCENE_WORLD.width}x${ROOM_SCENE_WORLD.height}`,
  );
  addError(errors, !Array.isArray(spec.layers) || spec.layers.length < 1, "layers must contain at least one layer");
  addError(errors, Array.isArray(spec.layers) && spec.layers.length > 64, "layers cannot contain more than 64 layers");
}

async function validateLayer(
  layer,
  index,
  sourceRoot,
  workspaceRoot,
  errors,
  seenAssetIds,
  seenPlacements,
  seenOutputPaths,
) {
  const prefix = `layers[${index}]`;
  if (!isRecord(layer)) {
    errors.push(`${prefix} must be an object`);
    return null;
  }

  addError(errors, !isSafeId(layer.assetId), `${prefix}.assetId is invalid`);
  if (isSafeId(layer.assetId)) {
    if (seenAssetIds.has(layer.assetId)) errors.push(`${prefix}.assetId duplicates ${layer.assetId}`);
    seenAssetIds.add(layer.assetId);
  }

  const outputPath = isNonEmptyString(layer.outputPath) ? normalizePath(layer.outputPath) : "";
  addError(errors, !SAFE_ASSET_PATH.test(outputPath), `${prefix}.outputPath must be a safe relative .png/.webp path`);
  if (SAFE_ASSET_PATH.test(outputPath)) {
    if (seenOutputPaths.has(outputPath)) errors.push(`${prefix}.outputPath duplicates ${outputPath}`);
    seenOutputPaths.add(outputPath);
    addError(errors, !SUPPORTED_EXTENSIONS.has(extname(outputPath).toLowerCase()), `${prefix}.outputPath uses an unsupported image format`);
  }

  const sourcePath = isNonEmptyString(layer.sourcePath) ? normalizePath(layer.sourcePath) : "";
  addError(errors, !isSafeSourcePath(sourcePath), `${prefix}.sourcePath must be relative and cannot traverse outside sourceRoot`);

  addError(errors, !ROOM_LAYER_THEMES.has(layer.theme), `${prefix}.theme must be day, dusk, or night`);
  addError(errors, !ROOM_LAYER_DEPTHS.has(layer.depth), `${prefix}.depth must be D0 through D6`);
  addError(
    errors,
    !Number.isInteger(layer.order) || layer.order < 0 || layer.order > ROOM_LAYER_ORDER_MAX,
    `${prefix}.order must be an integer from 0 through ${ROOM_LAYER_ORDER_MAX}`,
  );
  if (ROOM_LAYER_THEMES.has(layer.theme) && ROOM_LAYER_DEPTHS.has(layer.depth)
    && Number.isInteger(layer.order) && layer.order >= 0 && layer.order <= ROOM_LAYER_ORDER_MAX) {
    const placement = `${layer.theme}/${layer.depth}/${layer.order}`;
    if (seenPlacements.has(placement)) errors.push(`${prefix} duplicates layer placement ${placement}`);
    seenPlacements.add(placement);
  }

  addError(
    errors,
    layer.anchorId !== null && (!isNonEmptyString(layer.anchorId) || !ROOM_LAYER_ANCHOR_IDS.has(layer.anchorId)),
    `${prefix}.anchorId is unsupported`,
  );
  addError(
    errors,
    !isRecord(layer.sourceSize)
      || !isPositiveInteger(layer.sourceSize.width)
      || !isPositiveInteger(layer.sourceSize.height),
    `${prefix}.sourceSize must contain positive width and height`,
  );
  addError(errors, !isValidRegistration(layer.registration), `${prefix}.registration is missing or outside the canonical world`);
  addError(errors, !ROOM_LAYER_ALPHA_MODES.has(layer.alphaMode), `${prefix}.alphaMode is unsupported`);
  addError(errors, layer.alphaMode === "opaque-rgb" && layer.depth !== "D0", `${prefix}.alphaMode must preserve transparency outside D0`);
  addError(errors, !isNonEmptyString(layer.license), `${prefix}.license is required`);
  addError(errors, !isNonEmptyString(layer.reviewStatus), `${prefix}.reviewStatus is required`);
  addError(errors, typeof layer.releaseApproval !== "boolean", `${prefix}.releaseApproval must be boolean`);
  if (layer.sourceAssetId !== undefined) addError(errors, !isSafeId(layer.sourceAssetId), `${prefix}.sourceAssetId is invalid`);

  const promptPath = layer.promptPath === undefined
    ? null
    : isNonEmptyString(layer.promptPath) ? normalizePath(layer.promptPath) : "";
  addError(
    errors,
    layer.promptPath !== undefined && !isSafeSourcePath(promptPath),
    `${prefix}.promptPath must be a safe workspace-relative file path`,
  );
  let promptAbsolute = null;
  if (promptPath !== null && isSafeSourcePath(promptPath)) {
    promptAbsolute = resolve(workspaceRoot, promptPath);
    if (!isInsideRoot(workspaceRoot, promptAbsolute)) {
      errors.push(`${prefix}.promptPath resolves outside the workspace root`);
      promptAbsolute = null;
    } else {
      try {
        if (!(await stat(promptAbsolute)).isFile()) {
          errors.push(`${prefix}.promptPath must be a file: ${promptPath}`);
          promptAbsolute = null;
        }
      } catch {
        errors.push(`${prefix}.promptPath does not exist or cannot be read: ${promptPath}`);
        promptAbsolute = null;
      }
    }
  }
  const generationMethod = layer.generationMethod === undefined
    ? null
    : layer.generationMethod;
  addError(
    errors,
    generationMethod !== null && !isNonEmptyString(generationMethod),
    `${prefix}.generationMethod must be a non-empty string when provided`,
  );

  if (!isSafeSourcePath(sourcePath)) return null;
  const sourceAbsolute = resolve(sourceRoot, sourcePath);
  if (!isInsideRoot(sourceRoot, sourceAbsolute)) {
    errors.push(`${prefix}.sourcePath resolves outside sourceRoot`);
    return null;
  }

  let sourceBytes;
  try {
    sourceBytes = await readFile(sourceAbsolute);
  } catch {
    errors.push(`${prefix}.sourcePath does not exist or cannot be read: ${sourcePath}`);
    return null;
  }

  const inspected = inspectRoomLayerRaster(sourceBytes);
  addError(errors, Boolean(inspected?.error), `${prefix}.sourcePath is not a supported readable raster`);
  if (inspected?.error) return null;

  const sourceExtension = extname(sourcePath).toLowerCase();
  addError(errors, !SUPPORTED_EXTENSIONS.has(sourceExtension), `${prefix}.sourcePath uses an unsupported image format`);
  addError(errors, sourceExtension !== `.${inspected.format}`, `${prefix}.sourcePath extension does not match its raster format`);
  addError(
    errors,
    !isRecord(layer.sourceSize)
      || inspected.width !== layer.sourceSize.width
      || inspected.height !== layer.sourceSize.height,
    `${prefix}.sourceSize does not match the raster header`,
  );
  addError(errors, !inspected.hasAlphaChannel && layer.depth !== "D0", `${prefix}.sourcePath has no alpha channel outside D0`);

  return {
    ...layer,
    assetId: layer.assetId,
    sourcePath,
    outputPath,
    sourceAbsolute,
    sourceSha256: sha256(sourceBytes),
    sourceBytes: sourceBytes.length,
    sourceFormat: inspected.format,
    sourceHasAlphaChannel: inspected.hasAlphaChannel,
    promptPath,
    promptAbsolute,
    generationMethod: isNonEmptyString(generationMethod) ? generationMethod.trim() : null,
    license: isNonEmptyString(layer.license) ? layer.license.trim() : "",
  };
}

/**
 * Validate and enrich a layer-pack input spec without changing the canonical
 * renderer manifest. The returned source facts are the audit inputs for the
 * generated pack and its provenance records.
 */
export async function validateRoomLayerPackSpec(spec, { workspaceRoot = workspaceRootDefault } = {}) {
  const root = resolve(workspaceRoot);
  const errors = [];
  validateTopLevel(spec, errors);
  if (!isRecord(spec)) throwValidationErrors(errors);
  if (!Array.isArray(spec.layers)) throwValidationErrors(errors);

  const sourceRoot = await resolveSourceRoot(spec, root, errors);
  const seenAssetIds = new Set();
  const seenPlacements = new Set();
  const seenOutputPaths = new Set();
  const layers = [];
  for (let index = 0; index < spec.layers.length; index += 1) {
    const layer = await validateLayer(
      spec.layers[index],
      index,
      sourceRoot,
      root,
      errors,
      seenAssetIds,
      seenPlacements,
      seenOutputPaths,
    );
    if (layer) layers.push(layer);
  }

  throwValidationErrors(errors);
  const releaseEligibleByMetadata = layers.every((layer) => (
    layer.reviewStatus.trim().toLowerCase() === "approved"
    && layer.releaseApproval === true
  ));
  return {
    spec,
    workspaceRoot: root,
    sourceRoot,
    layers,
    releaseEligibleByMetadata,
  };
}

async function writeJson(path, value) {
  await writeFile(path, stableJson(value), "utf8");
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(normalizePath(relative(root, absolute)));
    } else {
      throw new Error(`Generated pack contains an unsupported filesystem entry: ${relative(root, absolute)}`);
    }
  }
  return files.sort();
}

async function buildIntegrityManifest(root) {
  const files = (await listFiles(root)).filter((path) => !["integrity.json", "validation.json"].includes(path));
  const entries = [];
  for (const path of files) {
    const bytes = await readFile(resolve(root, path));
    entries.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    algorithm: "sha256",
    files: entries,
  };
}

function isIntegrityManifestValid(integrity) {
  return integrity.files.length > 0 && integrity.files.every((entry) => (
    entry.path.length > 0 && entry.bytes > 0 && /^[a-f0-9]{64}$/.test(entry.sha256)
  ));
}

function makeRoomLayerManifest(validated) {
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    packId: validated.spec.packId,
    revision: validated.spec.revision,
    coordinateSpace: "room-1672x941",
    world: ROOM_SCENE_WORLD,
    roomLayers: validated.layers.map((layer) => ({
      assetId: layer.assetId,
      path: layer.outputPath,
      theme: layer.theme,
      depth: layer.depth,
      order: layer.order,
      anchorId: layer.anchorId,
      sourceSize: layer.sourceSize,
      registration: layer.registration,
      alphaMode: layer.alphaMode,
      sha256: layer.sourceSha256,
      sourcePath: layer.sourcePath,
      ...(layer.promptPath ? { promptPath: layer.promptPath } : {}),
      license: layer.license,
      reviewStatus: layer.reviewStatus,
      releaseApproval: layer.releaseApproval,
    })),
  };
}

function makeManifestPatch(validated, roomLayerManifest) {
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    target: TARGET_MANIFEST_PATH,
    packId: validated.spec.packId,
    revision: validated.spec.revision,
    roomLayers: roomLayerManifest.roomLayers,
  };
}

function makePackManifest(validated, specSha256, roomLayerManifest) {
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    packId: validated.spec.packId,
    revision: validated.spec.revision,
    kind: "learning-room-room-layer-pack",
    coordinateSpace: "room-1672x941",
    world: ROOM_SCENE_WORLD,
    generatedBy: GENERATOR_ID,
    deterministic: true,
    mode: "review",
    reviewOnly: true,
    releaseEligible: false,
    targetManifest: TARGET_MANIFEST_PATH,
    layerCount: roomLayerManifest.roomLayers.length,
    specSha256,
    layers: validated.layers.map((layer) => ({
      assetId: layer.assetId,
      sourceAssetId: layer.sourceAssetId ?? null,
      sourcePath: layer.sourcePath,
      outputPath: layer.outputPath,
      format: layer.sourceFormat,
      sourceSize: layer.sourceSize,
      sourceBytes: layer.sourceBytes,
      sourceSha256: layer.sourceSha256,
      alphaMode: layer.alphaMode,
      promptPath: layer.promptPath,
      promptArchivePath: layer.promptPath ? `provenance/prompts/${layer.assetId}.md` : null,
      generationMethod: layer.generationMethod,
      reviewStatus: layer.reviewStatus,
      releaseApproval: layer.releaseApproval,
    })),
  };
}

function makeProvenance(layer, validated) {
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    assetId: layer.assetId,
    sourceAssetId: layer.sourceAssetId ?? null,
    sourcePath: layer.sourcePath,
    outputPath: layer.outputPath,
    sourceSha256: layer.sourceSha256,
    sourceBytes: layer.sourceBytes,
    sourceSize: layer.sourceSize,
    sourceFormat: layer.sourceFormat,
    sourceHasAlphaChannel: layer.sourceHasAlphaChannel,
    alphaMode: layer.alphaMode,
    promptPath: layer.promptPath,
    promptArchivePath: layer.promptPath ? `provenance/prompts/${layer.assetId}.md` : null,
    generationMethod: layer.generationMethod,
    reviewStatus: layer.reviewStatus,
    releaseApproval: layer.releaseApproval,
    coordinateSpace: validated.spec.coordinateSpace,
    world: ROOM_SCENE_WORLD,
  };
}

async function copyAndCheckLayers(validated, stagingRoot) {
  const parity = [];
  for (const layer of validated.layers) {
    const outputAbsolute = resolve(stagingRoot, layer.outputPath);
    await mkdir(dirname(outputAbsolute), { recursive: true });
    await copyFile(layer.sourceAbsolute, outputAbsolute);
    const outputBytes = await readFile(outputAbsolute);
    const outputInfo = inspectRoomLayerRaster(outputBytes);
    const outputSha256 = sha256(outputBytes);
    parity.push({
      assetId: layer.assetId,
      sourceSha256: layer.sourceSha256,
      outputSha256,
      sourceBytes: layer.sourceBytes,
      outputBytes: outputBytes.length,
      ok: outputSha256 === layer.sourceSha256 && outputBytes.length === layer.sourceBytes,
      outputFormat: outputInfo?.format ?? null,
      outputSize: outputInfo && !outputInfo.error
        ? { width: outputInfo.width, height: outputInfo.height }
        : null,
    });
  }
  return parity;
}

function getReleaseBlockers(staticPreflight, parity) {
  const blockers = new Set();
  for (const record of staticPreflight.records ?? []) {
    for (const reason of record.reasons ?? []) blockers.add(reason);
  }
  for (const record of parity) {
    if (!record.ok) blockers.add("output-hash-mismatch");
  }
  return [...blockers].sort();
}

/**
 * Generate an isolated, deterministic layer pack. The generated
 * manifest.patch.json is intentionally separate from the canonical manifest:
 * approval is a human/product decision, while generation and validation are
 * mechanical and repeatable.
 */
export async function buildRoomLayerPack(spec, {
  workspaceRoot = workspaceRootDefault,
  outputRoot = defaultOutputRoot,
  mode = "review",
  force = false,
} = {}) {
  if (!new Set(["review", "release"]).has(mode)) {
    throw new Error("Room layer pack mode must be review or release");
  }

  const validated = await validateRoomLayerPackSpec(spec, { workspaceRoot });
  if (mode === "release" && !validated.releaseEligibleByMetadata) {
    throw new Error(
      "Cannot build release room layer pack: every layer must have reviewStatus=approved and releaseApproval=true",
    );
  }

  const targetRoot = resolve(outputRoot);
  assertSafeOutputRoot(targetRoot, workspaceRoot);
  if (existsSync(targetRoot) && !force) {
    throw new Error(`Output already exists; pass --force to replace this exact pack directory: ${targetRoot}`);
  }
  if (existsSync(targetRoot) && force && !(await isGeneratedPackFor(targetRoot, validated.spec.packId))) {
    throw new Error(`Refusing to replace an unrecognized output directory with --force: ${targetRoot}`);
  }
  await mkdir(dirname(targetRoot), { recursive: true });

  const stagingRoot = await mkdtemp(resolve(dirname(targetRoot), `.${validated.spec.packId}-`));
  let committed = false;
  try {
    const specSha256 = sha256(Buffer.from(stableJson(spec), "utf8"));
    const roomLayerManifest = makeRoomLayerManifest(validated);
    const manifestPatch = makeManifestPatch(validated, roomLayerManifest);
    const packManifest = makePackManifest(validated, specSha256, roomLayerManifest);

    await writeJson(resolve(stagingRoot, "generation-spec.json"), spec);
    await writeJson(resolve(stagingRoot, "room-layer-manifest.json"), roomLayerManifest);
    await writeJson(resolve(stagingRoot, "manifest.patch.json"), manifestPatch);

    for (const layer of validated.layers) {
      const provenancePath = resolve(stagingRoot, "provenance", `${layer.assetId}.json`);
      await mkdir(dirname(provenancePath), { recursive: true });
      await writeJson(provenancePath, makeProvenance(layer, validated));
      if (layer.promptAbsolute) {
        const promptArchivePath = resolve(
          stagingRoot,
          "provenance/prompts",
          `${layer.assetId}.md`,
        );
        await mkdir(dirname(promptArchivePath), { recursive: true });
        await copyFile(layer.promptAbsolute, promptArchivePath);
      }
    }

    const parity = await copyAndCheckLayers(validated, stagingRoot);
    const staticPreflight = preflightRoomLayers(roomLayerManifest, stagingRoot);
    const payloadIntegrity = await buildIntegrityManifest(stagingRoot);
    const payloadIntegrityOk = isIntegrityManifestValid(payloadIntegrity);
    const sourceOutputParity = parity.every((record) => record.ok);
    const releaseEligible = validated.releaseEligibleByMetadata
      && staticPreflight.ok
      && payloadIntegrityOk
      && sourceOutputParity;
    const releaseBlockers = getReleaseBlockers(staticPreflight, parity);

    if (mode === "release" && !releaseEligible) {
      throw new Error(`Room layer pack release preflight failed: ${releaseBlockers.join(", ") || "unknown"}`);
    }

    packManifest.mode = mode;
    packManifest.reviewOnly = !releaseEligible;
    packManifest.releaseEligible = releaseEligible;
    await writeJson(resolve(stagingRoot, "pack.json"), packManifest);
    await writeFile(
      resolve(stagingRoot, "README.md"),
      [
        `# ${validated.spec.packId}`,
        "",
        releaseEligible
          ? "This pack passed the static layer gate and is eligible for release review."
          : "This is an isolated review candidate. It must not be merged into the production manifest until reviewStatus=approved, releaseApproval=true, and the static layer gate passes.",
        "",
        "Generated files:",
        "- `layers/`: copied raster layers, preserving source bytes",
        "- `room-layer-manifest.json`: layer-only manifest for the pack",
        "- `manifest.patch.json`: explicit patch for the canonical renderer manifest",
        "- `provenance/`: source hash, dimensions, alpha, and approval facts per layer",
        "- `provenance/prompts/`: archived generation prompts when a layer provides promptPath",
        "- `integrity.json`: deterministic SHA-256 inventory of pack payload files",
        "- `validation.json`: static preflight, parity, and release eligibility report",
        "",
      ].join("\n"),
      "utf8",
    );
    const integrity = await buildIntegrityManifest(stagingRoot);
    const integrityOk = isIntegrityManifestValid(integrity);
    if (!integrityOk) throw new Error("Generated room layer pack integrity inventory is invalid");
    await writeJson(resolve(stagingRoot, "integrity.json"), integrity);
    await writeJson(resolve(stagingRoot, "validation.json"), {
      schemaVersion: PACK_SCHEMA_VERSION,
      packId: validated.spec.packId,
      revision: validated.spec.revision,
      mode,
      status: releaseEligible ? "release-ready" : "review-candidate",
      integrityOk,
      sourceOutputParity,
      staticPreflight,
      releaseEligible,
      releaseBlockers,
    });

    if (force && existsSync(targetRoot)) await rm(targetRoot, { recursive: true, force: true });
    await rename(stagingRoot, targetRoot);
    committed = true;

    return {
      outputRoot: targetRoot,
      packId: validated.spec.packId,
      revision: validated.spec.revision,
      mode,
      layerCount: validated.layers.length,
      releaseEligible,
      integrityOk,
      sourceOutputParity,
      staticPreflight,
      releaseBlockers,
    };
  } finally {
    if (!committed) await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function readRoomLayerPackSpec(specPath) {
  const source = await readFile(specPath, "utf8");
  try {
    return JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot parse room layer pack spec ${specPath}: ${message}`);
  }
}

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const specPath = resolve(appRoot, readOption("--spec", "scripts/fixtures/room-layer-pack.input.json"));
  const outputRoot = resolve(appRoot, readOption("--out", "../../.impeccable/review/room-layer-pack-candidate-v1"));
  const mode = readOption("--mode", "review");
  const force = process.argv.includes("--force");
  const result = await buildRoomLayerPack(await readRoomLayerPackSpec(specPath), {
    workspaceRoot: workspaceRootDefault,
    outputRoot,
    mode,
    force,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
