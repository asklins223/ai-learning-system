import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  inspectRoomLayerRaster,
  preflightRoomLayerOutput,
  preflightRoomLayers,
} from "./validate-room-layers.mjs";

function pngHeader({ width, height, colorType = 6, transparencyChunk = false }) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = colorType;
  const iend = Buffer.alloc(12);
  iend.write("IEND", 4, 4, "ascii");
  const trns = transparencyChunk ? Buffer.concat([Buffer.from([0, 0, 0, 2]), Buffer.from("tRNS"), Buffer.alloc(2), Buffer.alloc(4)]) : Buffer.alloc(0);
  return Buffer.concat([signature, ihdr, trns, iend]);
}

function webpVp8xHeader({ width, height, alpha = true }) {
  const payload = Buffer.alloc(10);
  payload[0] = alpha ? 0x10 : 0;
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  const chunk = Buffer.concat([Buffer.from("VP8X"), Buffer.alloc(4), payload]);
  chunk.writeUInt32LE(payload.length, 4);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, 4, "ascii");
  riff.writeUInt32LE(4 + chunk.length, 4);
  riff.write("WEBP", 8, 4, "ascii");
  return Buffer.concat([riff, chunk]);
}

function layer(overrides = {}) {
  return {
    assetId: "STATIC-ROOM-DAY-D6-01",
    path: "foreground/room-day.png",
    theme: "day",
    depth: "D6",
    order: 0,
    anchorId: null,
    sourceSize: { width: 12, height: 8 },
    registration: {
      position: [0, 0],
      size: { width: 12, height: 8 },
      anchor: [0, 0],
    },
    alphaMode: "straight-rgba",
    reviewStatus: "approved",
    releaseApproval: true,
    ...overrides,
  };
}

describe("Room layer static preflight", () => {
  it("recognizes PNG alpha and exact source dimensions", () => {
    expect(inspectRoomLayerRaster(pngHeader({ width: 12, height: 8 }))).toMatchObject({
      format: "png",
      width: 12,
      height: 8,
      hasAlphaChannel: true,
    });
    expect(inspectRoomLayerRaster(pngHeader({ width: 12, height: 8, colorType: 2 }))).toMatchObject({
      format: "png",
      hasAlphaChannel: false,
    });
    expect(inspectRoomLayerRaster(pngHeader({ width: 12, height: 8, colorType: 2, transparencyChunk: true }))).toMatchObject({
      hasAlphaChannel: true,
    });
  });

  it("recognizes WebP VP8X alpha metadata", () => {
    expect(inspectRoomLayerRaster(webpVp8xHeader({ width: 12, height: 8 }))).toMatchObject({
      format: "webp",
      width: 12,
      height: 8,
      hasAlphaChannel: true,
    });
    expect(inspectRoomLayerRaster(webpVp8xHeader({ width: 12, height: 8, alpha: false }))).toMatchObject({
      hasAlphaChannel: false,
    });
  });

  it("accepts the explicit empty registry without masking a blocked asset", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "room-layer-preflight-"));
    try {
      expect(preflightRoomLayers({ roomLayers: [] }, root)).toMatchObject({
        ok: true,
        candidates: 0,
        eligible: 0,
        blocked: 0,
      });

      await mkdir(resolve(root, "foreground"));
      await writeFile(resolve(root, "foreground/room-day.png"), pngHeader({ width: 12, height: 8 }));
      await writeFile(resolve(root, "foreground/room-approved.png"), pngHeader({ width: 12, height: 8 }));
      expect(preflightRoomLayers({ roomLayers: [layer()] }, root)).toMatchObject({
        ok: true,
        candidates: 1,
        eligible: 1,
        blocked: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for missing files, wrong dimensions, missing alpha and approval", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "room-layer-preflight-"));
    try {
      await mkdir(resolve(root, "foreground"));
      await writeFile(resolve(root, "foreground/room-day.png"), pngHeader({ width: 12, height: 8, colorType: 2 }));
      await writeFile(resolve(root, "foreground/room-approved.png"), pngHeader({ width: 12, height: 8 }));
      const result = preflightRoomLayers({
        roomLayers: [
          layer({ sourceSize: { width: 12, height: 8 } }),
          layer({ assetId: "STATIC-ROOM-MISSING-01", path: "foreground/missing.png", order: 1 }),
          layer({
            assetId: "STATIC-ROOM-REVIEW-01",
            path: "foreground/room-approved.png",
            sourceSize: { width: 12, height: 8 },
            order: 2,
            reviewStatus: "IN_REVIEW",
            releaseApproval: false,
          }),
        ],
      }, root);

      expect(result.ok).toBe(false);
      expect(result.blocked).toBe(3);
      expect(result.records[0].reasons).toEqual(["alpha-channel-missing"]);
      expect(result.records[1].reasons).toEqual(["asset-missing"]);
      expect(result.records[2].reasons).toEqual(["review-not-approved", "release-not-approved"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal paths and duplicate asset ids", () => {
    const result = preflightRoomLayers({
      roomLayers: [
        layer({ path: "../outside.png" }),
        layer({ path: "foreground/second.png", order: 1 }),
      ],
    }, "/tmp/room-layer-preflight");
    expect(result.ok).toBe(false);
    expect(result.records[0].reasons).toContain("invalid-asset-path");
    expect(result.records[1].reasons).toContain("duplicate-asset-id");
  });

  it("rejects invalid and duplicate layer placement orders", () => {
    const result = preflightRoomLayers({
      roomLayers: [
        layer({ assetId: "STATIC-ROOM-FAR-01", order: 4 }),
        layer({ assetId: "STATIC-ROOM-NEAR-01", order: 4 }),
        layer({ assetId: "STATIC-ROOM-INVALID-01", order: 64 }),
      ],
    }, "/tmp/room-layer-preflight");

    expect(result.ok).toBe(false);
    expect(result.records[0].reasons).not.toContain("duplicate-layer-order");
    expect(result.records[1].reasons).toContain("duplicate-layer-order");
    expect(result.records[2].reasons).toContain("invalid-layer-order");
  });

  it("rejects layer anchors outside the room registry", () => {
    const result = preflightRoomLayers({
      roomLayers: [layer({ anchorId: "room.unknown" })],
    }, "/tmp/room-layer-preflight");

    expect(result.ok).toBe(false);
    expect(result.records[0].reasons).toContain("unsupported-anchor");
  });

  it("rejects layer registrations outside the canonical world", () => {
    const result = preflightRoomLayers({
      roomLayers: [layer({
        registration: {
          position: [-3, 0],
          size: { width: 12, height: 8 },
          anchor: [0, 0],
        },
      })],
    }, "/tmp/room-layer-preflight");

    expect(result.ok).toBe(false);
    expect(result.records[0].reasons).toContain("registration-out-of-bounds");
  });

  it("verifies emitted output copies byte-for-byte against the source root", async () => {
    const sourceRoot = await mkdtemp(resolve(tmpdir(), "room-layer-source-"));
    const outputRoot = await mkdtemp(resolve(tmpdir(), "room-layer-output-"));
    try {
      await mkdir(resolve(sourceRoot, "foreground"));
      await mkdir(resolve(outputRoot, "foreground"));
      const sourceBytes = pngHeader({ width: 12, height: 8 });
      await writeFile(resolve(sourceRoot, "foreground/room-day.png"), sourceBytes);
      await writeFile(resolve(outputRoot, "foreground/room-day.png"), sourceBytes);

      const valid = preflightRoomLayerOutput({ roomLayers: [layer()] }, sourceRoot, outputRoot);
      expect(valid).toMatchObject({
        ok: true,
        candidates: 1,
        eligible: 1,
        blocked: 0,
      });
      expect(valid.records[0].sourceSha256).toBe(valid.records[0].outputSha256);

      await writeFile(resolve(outputRoot, "foreground/room-day.png"), Buffer.concat([sourceBytes, Buffer.from([1])]));
      const mismatch = preflightRoomLayerOutput({ roomLayers: [layer()] }, sourceRoot, outputRoot);
      expect(mismatch.ok).toBe(false);
      expect(mismatch.records[0].reasons).toContain("output-hash-mismatch");
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the emitted manifest drops a canonical Room layer", async () => {
    const sourceRoot = await mkdtemp(resolve(tmpdir(), "room-layer-source-"));
    const outputRoot = await mkdtemp(resolve(tmpdir(), "room-layer-output-"));
    try {
      await mkdir(resolve(sourceRoot, "foreground"));
      await writeFile(resolve(sourceRoot, "foreground/room-day.png"), pngHeader({ width: 12, height: 8 }));

      const sourceManifest = { roomLayers: [layer()] };
      const outputManifest = { roomLayers: [] };
      const result = preflightRoomLayerOutput(
        outputManifest,
        sourceRoot,
        outputRoot,
        sourceManifest,
      );

      expect(result.ok).toBe(false);
      expect(result.manifestParity).toMatchObject({
        ok: false,
        reasons: ["output-manifest-mismatch"],
        sourceLayerCount: 1,
        outputLayerCount: 0,
      });
      expect(result.source.candidates).toBe(1);
      expect(result.output.candidates).toBe(0);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
