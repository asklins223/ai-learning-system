import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateSpritePack } from "./sprite-asset-validator";

const PACK_DIR = join(
  __dirname,
  "../../../public/images/companion/pet/sprite-v1",
);

function readPack(): {
  manifest: unknown;
  license: unknown;
  images: Record<string, ArrayBuffer>;
  hitMasks: Record<string, ArrayBuffer>;
} {
  const manifest = JSON.parse(
    readFileSync(join(PACK_DIR, "manifest.json"), "utf8"),
  ) as unknown;
  const license = JSON.parse(
    readFileSync(join(PACK_DIR, "LICENSE.json"), "utf8"),
  ) as unknown;
  const poses = (manifest as { poses: Record<string, { image: string; hitMask: string }> }).poses;
  const images: Record<string, ArrayBuffer> = {};
  const hitMasks: Record<string, ArrayBuffer> = {};
  for (const pose of Object.values(poses)) {
    const imageBytes = readFileSync(join(PACK_DIR, pose.image));
    images[pose.image] = imageBytes.buffer.slice(
      imageBytes.byteOffset,
      imageBytes.byteOffset + imageBytes.byteLength,
    ) as ArrayBuffer;
    const maskBytes = readFileSync(join(PACK_DIR, pose.hitMask));
    hitMasks[pose.hitMask] = maskBytes.buffer.slice(
      maskBytes.byteOffset,
      maskBytes.byteOffset + maskBytes.byteLength,
    ) as ArrayBuffer;
  }
  return { manifest, license, images, hitMasks };
}

test("real sprite-v1 pack validates in production mode (LICENSE approved by Owner 2026-08-10)", async () => {
  const pack = readPack();
  const result = await validateSpritePack(
    pack.manifest,
    pack.license,
    pack.images,
    pack.hitMasks,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    // Owner approved ownership/modification/commercial use/redistribution:
    // the pack is production-enabled now.
    assert.equal(result.pack.mode, "production");
    assert.ok(result.reasons.length === 0);
    assert.equal(result.pack.images["idle.png"].byteLength > 0, true);
  }
});

test("pack rejects a tampered pose image hash", async () => {
  const pack = readPack();
  const tampered: Record<string, ArrayBuffer> = { ...pack.images };
  const idleBytes = new Uint8Array(tampered["idle.png"]);
  const flipped = new Uint8Array(idleBytes);
  flipped[0] = flipped[0] ^ 0xff;
  tampered["idle.png"] = flipped.buffer.slice(
    flipped.byteOffset,
    flipped.byteOffset + flipped.byteLength,
  ) as ArrayBuffer;
  const result = await validateSpritePack(
    pack.manifest,
    pack.license,
    tampered,
    pack.hitMasks,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reasons.join(","), /idle\.png sha256 mismatch/);
  }
});

test("pack rejects a missing hit mask and wrong mask size", async () => {
  const pack = readPack();
  const missingMask = { ...pack.hitMasks };
  delete missingMask["hit-masks/listen.bin"];
  const result = await validateSpritePack(
    pack.manifest,
    pack.license,
    pack.images,
    missingMask,
  );
  assert.equal(result.ok, false);

  const wrongSize = { ...pack.hitMasks };
  const small = new ArrayBuffer(1024);
  wrongSize["hit-masks/think.bin"] = small;
  const result2 = await validateSpritePack(
    pack.manifest,
    pack.license,
    pack.images,
    wrongSize,
  );
  assert.equal(result2.ok, false);
});

test("pack rejects license schema violations and unknown poses", async () => {
  const pack = readPack();
  const badLicense = { ...(pack.license as Record<string, unknown>) };
  delete (badLicense.permissions as Record<string, unknown>).modify;
  const result = await validateSpritePack(
    pack.manifest,
    badLicense,
    pack.images,
    pack.hitMasks,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reasons.join(","), /license schema invalid/);
  }

  const badManifest = structuredClone(pack.manifest) as Record<string, unknown>;
  (badManifest.poses as Record<string, unknown>).extra_pose = {
    image: "x.png",
    imageSha256: "a".repeat(64),
    naturalSize: { width: 700, height: 860 },
    footAnchor: { x: 350, y: 824 },
    opaqueBounds: { x: 100, y: 90, width: 460, height: 730 },
    hitMask: "hit-masks/x.bin",
    hitMaskSize: { width: 128, height: 128 },
    hitMaskSha256: "b".repeat(64),
    semanticPose: "idle",
  };
  const result2 = await validateSpritePack(
    badManifest,
    pack.license,
    pack.images,
    pack.hitMasks,
  );
  assert.equal(result2.ok, false);
  if (!result2.ok) {
    assert.match(result2.reasons.join(","), /manifest schema invalid/);
  }
});
