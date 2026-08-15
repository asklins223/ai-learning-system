import {
  evaluateSpriteLicense,
  spriteLicenseV1Schema,
  spriteManifestV1Schema,
  type SpriteLicenseV1,
  type SpriteManifestV1,
  validateSpriteManifestShape,
} from "@ailearn/shared/companion-character-contracts";

/**
 * Fail-closed validator for the Level A sprite pack
 * (`apps/web/public/images/companion/pet/sprite-v1/`).
 *
 * Pure-function layer (Node-testable) + browser loader. The loader refuses to
 * hand a pack to the runtime unless every pose image/hit-mask hash matches the
 * frozen manifest, the manifest shape is valid, and the license evaluates to
 * `production` or `prototype`. A rejected license only ever downgrades the
 * pack to Surface Prototype mode, never to production.
 */

export interface SpriteAssetPackV1 {
  manifest: SpriteManifestV1;
  license: SpriteLicenseV1;
  mode: "production" | "prototype";
  images: Record<string, ArrayBuffer>;
  hitMasks: Record<string, ArrayBuffer>;
}

export type SpriteAssetPackResult =
  | { ok: true; pack: SpriteAssetPackV1; reasons: string[] }
  | { ok: false; reasons: string[] };

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const raw = data instanceof Uint8Array
    ? (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
    : data;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(raw));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Pure validation shared by the browser loader and the Node tests. */
export async function validateSpritePack(
  manifest: unknown,
  license: unknown,
  images: Record<string, ArrayBuffer>,
  hitMasks: Record<string, ArrayBuffer>,
): Promise<SpriteAssetPackResult> {
  const reasons: string[] = [];
  const manifestParsed = spriteManifestV1Schema.safeParse(manifest);
  if (!manifestParsed.success) {
    return { ok: false, reasons: ["manifest schema invalid", ...manifestParsed.error.issues.map((i) => i.path.join(".") + ": " + i.message)] };
  }
  const shape = validateSpriteManifestShape(manifestParsed.data);
  if (!shape.ok) {
    return { ok: false, reasons: shape.reasons };
  }
  const licenseParsed = spriteLicenseV1Schema.safeParse(license);
  if (!licenseParsed.success) {
    return { ok: false, reasons: ["license schema invalid", ...licenseParsed.error.issues.map((i) => i.path.join(".") + ": " + i.message)] };
  }
  const licenseResult = evaluateSpriteLicense(
    licenseParsed.data,
    manifestParsed.data.sourceReference.sha256,
  );
  if (licenseResult.mode === "rejected") {
    return { ok: false, reasons: licenseResult.reasons };
  }

  for (const pose of manifestParsed.data.poseOrder) {
    const entry = manifestParsed.data.poses[pose];
    if (!entry) {
      reasons.push(`missing pose entry: ${pose}`);
      continue;
    }
    const image = images[entry.image];
    if (!image) {
      reasons.push(`${entry.image} missing`);
      continue;
    }
    const mask = hitMasks[entry.hitMask];
    if (!mask) {
      reasons.push(`${entry.hitMask} missing`);
      continue;
    }
    const imageHash = await sha256Hex(image);
    if (imageHash !== entry.imageSha256) {
      reasons.push(`${entry.image} sha256 mismatch (got ${imageHash})`);
    }
    const maskHash = await sha256Hex(mask);
    if (maskHash !== entry.hitMaskSha256) {
      reasons.push(`${entry.hitMask} sha256 mismatch`);
    }
    if (mask.byteLength !== 128 * 128 / 8) {
      reasons.push(`${entry.hitMask} must be 2048 bytes`);
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  return {
    ok: true,
    pack: {
      manifest: manifestParsed.data,
      license: licenseParsed.data,
      mode: licenseResult.mode,
      images,
      hitMasks,
    },
    reasons: licenseResult.reasons,
  };
}

const SPRITE_V1_BASE_URL = "/images/companion/pet/sprite-v1";

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  // F3：sprite 是冻结资产（manifest 含文件 hash 完整性校验），且上方
  // loadSpriteAssetPack 已做模块级缓存兜底——移除 `cache: "no-store"`
  // 允许浏览器 HTTP 缓存命中，避免每次 pet 首挂重复下载 ~4.7MB。
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`sprite asset fetch failed: ${url} (${response.status})`);
  }
  return response.arrayBuffer();
}

/** Browser loader: fetches the frozen pack and returns a validated result. */
export async function loadSpriteAssetPackUncached(): Promise<SpriteAssetPackResult> {
  const [manifestBuffer, licenseBuffer] = await Promise.all([
    fetchBytes(`${SPRITE_V1_BASE_URL}/manifest.json`),
    fetchBytes(`${SPRITE_V1_BASE_URL}/LICENSE.json`),
  ]);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBuffer)) as unknown;
  const license = JSON.parse(new TextDecoder().decode(licenseBuffer)) as unknown;
  const manifestParsed = spriteManifestV1Schema.safeParse(manifest);
  if (!manifestParsed.success) {
    return { ok: false, reasons: ["manifest schema invalid"] };
  }
  const images: Record<string, ArrayBuffer> = {};
  const hitMasks: Record<string, ArrayBuffer> = {};
  const imageUrls = manifestParsed.data.poseOrder.map((pose) => {
    const entry = manifestParsed.data.poses[pose];
    if (!entry) throw new Error(`missing pose entry: ${pose}`);
    return entry.image;
  });
  const maskUrls = manifestParsed.data.poseOrder.map((pose) => {
    const entry = manifestParsed.data.poses[pose];
    if (!entry) throw new Error(`missing pose entry: ${pose}`);
    return entry.hitMask;
  });
  const [imageBuffers, maskBuffers] = await Promise.all([
    Promise.all(imageUrls.map((name) => fetchBytes(`${SPRITE_V1_BASE_URL}/${name}`))),
    Promise.all(maskUrls.map((name) => fetchBytes(`${SPRITE_V1_BASE_URL}/${name}`))),
  ]);
  imageUrls.forEach((name, index) => {
    images[name] = imageBuffers[index];
  });
  maskUrls.forEach((name, index) => {
    hitMasks[name] = maskBuffers[index];
  });
  return validateSpritePack(manifest, license, images, hitMasks);
}

// 2026-08-11（性能专项）：sprite 资产为冻结资产（pack 不可变）——模块级
// Promise 缓存，避免每次 pet 挂载重复 fetch manifest/LICENSE/全部图片与
// hit-mask + 校验。校验失败（ok:false）不缓存，下次挂载可重试。
let spritePackPromise: Promise<SpriteAssetPackResult> | null = null;

export function loadSpriteAssetPack(): Promise<SpriteAssetPackResult> {
  if (!spritePackPromise) {
    spritePackPromise = loadSpriteAssetPackUncached().then((result) => {
      if (!result.ok) {
        spritePackPromise = null; // 校验失败：允许下次挂载重试
      }
      return result;
    });
  }
  return spritePackPromise;
}
