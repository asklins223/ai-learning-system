import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRoomLayerPack,
  validateRoomLayerPackSpec,
} from "./generate-room-layer-pack.mjs";

const temporaryRoots = [];

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, typeBytes, data, Buffer.alloc(4)]);
}

function minimalRgbaPng(width = 12, height = 8, marker = "") {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const text = marker ? Buffer.from(`marker\0${marker}`, "utf8") : Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    ...(text.length > 0 ? [pngChunk("tEXt", text)] : []),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function makeFixture({ approved = false, withPrompt = false } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "room-layer-pack-test-"));
  temporaryRoots.push(root);
  await writeFile(resolve(root, "day.png"), minimalRgbaPng(12, 8, "day"));
  await writeFile(resolve(root, "night.png"), minimalRgbaPng(12, 8, "night"));
  const status = approved ? "approved" : "CHANGES_REQUIRED";
  const releaseApproval = approved;
  const spec = {
    schemaVersion: 1,
    packId: "test-room-layer-pack",
    revision: 1,
    coordinateSpace: "room-1672x941",
    world: { width: 1672, height: 941 },
    sourceRoot: ".",
    layers: [
        {
          assetId: "TEST-DAY",
          sourceAssetId: "SOURCE-DAY",
          sourcePath: "day.png",
          outputPath: "layers/day/d5-day.png",
          theme: "day",
          depth: "D5",
          order: 0,
          anchorId: null,
          sourceSize: { width: 12, height: 8 },
          registration: {
            position: [0, 0],
            size: { width: 12, height: 8 },
            anchor: [0, 0],
          },
          alphaMode: "straight-rgba",
          reviewStatus: status,
          releaseApproval,
        },
        {
          assetId: "TEST-NIGHT",
          sourceAssetId: "SOURCE-NIGHT",
          sourcePath: "night.png",
          outputPath: "layers/night/d5-night.png",
          theme: "night",
          depth: "D5",
          order: 0,
          anchorId: null,
          sourceSize: { width: 12, height: 8 },
          registration: {
            position: [0, 0],
            size: { width: 12, height: 8 },
            anchor: [0, 0],
          },
          alphaMode: "straight-rgba",
          reviewStatus: status,
          releaseApproval,
        },
    ],
  };
  if (withPrompt) {
    await writeFile(resolve(root, "prompt.md"), "test generation prompt\n");
    for (const layer of spec.layers) {
      layer.promptPath = "prompt.md";
      layer.generationMethod = "test-generator";
    }
  }
  return { root, spec };
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    await rm(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe("generate-room-layer-pack", () => {
  it("validates source facts and generates an auditable review candidate", async () => {
    const fixture = await makeFixture();
    const outputRoot = resolve(fixture.root, "out");
    const validated = await validateRoomLayerPackSpec(fixture.spec, { workspaceRoot: fixture.root });
    expect(validated.layers).toHaveLength(2);
    expect(validated.layers[0].sourceHasAlphaChannel).toBe(true);
    expect(validated.releaseEligibleByMetadata).toBe(false);

    const result = await buildRoomLayerPack(fixture.spec, {
      workspaceRoot: fixture.root,
      outputRoot,
      mode: "review",
    });

    expect(result.layerCount).toBe(2);
    expect(result.releaseEligible).toBe(false);
    expect(result.integrityOk).toBe(true);
    expect(result.sourceOutputParity).toBe(true);
    expect(result.staticPreflight.ok).toBe(false);
    expect(result.releaseBlockers).toEqual(["release-not-approved", "review-not-approved"]);
    expect(existsSync(resolve(outputRoot, "layers/day/d5-day.png"))).toBe(true);
    expect(existsSync(resolve(outputRoot, "provenance/TEST-DAY.json"))).toBe(true);

    const patch = JSON.parse(await readFile(resolve(outputRoot, "manifest.patch.json"), "utf8"));
    const pack = JSON.parse(await readFile(resolve(outputRoot, "pack.json"), "utf8"));
    expect(patch.target).toContain("apps/desktop-client/src/renderer/public/assets/learning-room/v1/manifest.json");
    expect(patch.roomLayers).toHaveLength(2);
    expect(pack).toMatchObject({ mode: "review", reviewOnly: true, releaseEligible: false });
    expect(JSON.stringify(patch)).not.toContain(fixture.root);
  });

  it("produces a release-ready pack only after approval and remains deterministic", async () => {
    const fixture = await makeFixture({ approved: true });
    const firstOutput = resolve(fixture.root, "first");
    const secondOutput = resolve(fixture.root, "second");

    const first = await buildRoomLayerPack(fixture.spec, {
      workspaceRoot: fixture.root,
      outputRoot: firstOutput,
      mode: "release",
    });
    const second = await buildRoomLayerPack(fixture.spec, {
      workspaceRoot: fixture.root,
      outputRoot: secondOutput,
      mode: "release",
    });

    expect(first.releaseEligible).toBe(true);
    expect(first.staticPreflight.ok).toBe(true);
    expect(second.releaseEligible).toBe(true);
    for (const file of ["pack.json", "room-layer-manifest.json", "manifest.patch.json", "integrity.json", "validation.json"]) {
      expect(await readFile(resolve(firstOutput, file))).toEqual(await readFile(resolve(secondOutput, file)));
    }
  });

  it("archives optional generation prompts and method in provenance", async () => {
    const fixture = await makeFixture({ withPrompt: true });
    const outputRoot = resolve(fixture.root, "out");

    await buildRoomLayerPack(fixture.spec, {
      workspaceRoot: fixture.root,
      outputRoot,
      mode: "review",
    });

    const provenance = JSON.parse(await readFile(resolve(
      outputRoot,
      "provenance/TEST-DAY.json",
    ), "utf8"));
    const pack = JSON.parse(await readFile(resolve(outputRoot, "pack.json"), "utf8"));
    expect(provenance).toMatchObject({
      promptPath: "prompt.md",
      promptArchivePath: "provenance/prompts/TEST-DAY.md",
      generationMethod: "test-generator",
    });
    expect(await readFile(resolve(outputRoot, "provenance/prompts/TEST-DAY.md"), "utf8"))
      .toBe("test generation prompt\n");
    expect(pack.layers[0]).toMatchObject({
      promptPath: "prompt.md",
      promptArchivePath: "provenance/prompts/TEST-DAY.md",
      generationMethod: "test-generator",
    });
  });

  it("refuses an unapproved release without creating the output directory", async () => {
    const fixture = await makeFixture();
    const outputRoot = resolve(fixture.root, "release");

    await expect(buildRoomLayerPack(fixture.spec, {
      workspaceRoot: fixture.root,
      outputRoot,
      mode: "release",
    })).rejects.toThrow(/release room layer pack/);
    expect(existsSync(outputRoot)).toBe(false);
  });

  it("rejects duplicate placements and registrations outside the canonical world", async () => {
    const fixture = await makeFixture();
    fixture.spec.layers[1].theme = "day";
    fixture.spec.layers[1].registration.position = [-10, 0];

    await expect(validateRoomLayerPackSpec(fixture.spec, { workspaceRoot: fixture.root }))
      .rejects.toThrow(/duplicates layer placement|outside the canonical world/);
  });

  it("does not overwrite an existing pack unless force is explicit", async () => {
    const fixture = await makeFixture();
    const outputRoot = resolve(fixture.root, "out");
    await buildRoomLayerPack(fixture.spec, {
      workspaceRoot: fixture.root,
      outputRoot,
      mode: "review",
    });

    await expect(buildRoomLayerPack(fixture.spec, {
      workspaceRoot: fixture.root,
      outputRoot,
      mode: "review",
    })).rejects.toThrow(/Output already exists/);
  });

  it("does not force-replace an unrecognized directory", async () => {
    const fixture = await makeFixture();
    const outputRoot = resolve(fixture.root, "out");
    await mkdir(outputRoot, { recursive: true });
    await writeFile(resolve(outputRoot, "unrelated.txt"), "keep");
    await expect(buildRoomLayerPack(fixture.spec, {
      workspaceRoot: fixture.root,
      outputRoot,
      mode: "review",
      force: true,
    })).rejects.toThrow(/unrecognized output directory/);
  });
});
