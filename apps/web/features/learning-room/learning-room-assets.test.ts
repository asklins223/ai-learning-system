import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const featureRoot = dirname(fileURLToPath(import.meta.url));
const assetRoot = join(featureRoot, "../../public/assets/3d/learning-room/v1");
const manifest = JSON.parse(readFileSync(join(assetRoot, "manifest.json"), "utf8")) as {
  entries: Array<{ id: string; files: Array<{ path: string; bytes: number; sha256: string }> }>;
  reviewOnly: boolean;
};

test("learning-room review manifest resolves every physical file", () => {
  assert.equal(manifest.reviewOnly, true);
  const ids = new Set<string>();
  for (const entry of manifest.entries) {
    assert.equal(ids.has(entry.id), false, `duplicate asset id: ${entry.id}`);
    ids.add(entry.id);
    for (const file of entry.files) {
      const path = join(assetRoot, file.path);
      const stat = statSync(path);
      assert.equal(stat.size, file.bytes, `${entry.id} bytes drifted`);
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      assert.equal(hash, file.sha256, `${entry.id} hash drifted`);
    }
  }
});

test("room-shell delivers all three fixed-camera LODs", () => {
  for (const lod of [0, 1, 2]) {
    const path = join(assetRoot, `models/p0/room-shell-lod${lod}.glb`);
    assert.ok(statSync(path).size > 0, `missing room-shell LOD${lod}`);
  }
});

test("first-scene fallback images remain below the 450 KiB per-file budget", () => {
  for (const name of ["room-day.webp", "room-night.webp", "desk.webp", "companion-orb.webp"]) {
    const bytes = statSync(join(assetRoot, "fallback", name)).size;
    assert.ok(bytes <= 450 * 1024, `${name} exceeds fallback budget`);
  }
});
