import { describe, expect, it } from "vitest";
import {
  createSurfaceCalibrationArtifact,
  parseSurfaceCalibrationArtifact,
  readStoredSurfaceCalibration,
  serializeSurfaceCalibrationArtifact,
  surfaceCalibrationStorageKey,
  validateSurfaceCalibrationArtifact,
  writeStoredSurfaceCalibration,
  clearStoredSurfaceCalibration,
  type SurfaceCalibrationStorage,
} from "./scene-calibration";
import { REVIEW_SURFACE_REGISTRY } from "./scene-surfaces";

function createMemoryStorage(): SurfaceCalibrationStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe("scene calibration artifact", () => {
  const surfaces = Object.values(REVIEW_SURFACE_REGISTRY.surfaces);
  const mode = { theme: "night" as const, renderer: "poster" as const, motion: "off" as const };

  it("round-trips the registry contract with stable surface ordering", () => {
    const artifact = createSurfaceCalibrationArtifact(REVIEW_SURFACE_REGISTRY, surfaces, {}, mode);
    const raw = serializeSurfaceCalibrationArtifact(artifact);
    const parsed = parseSurfaceCalibrationArtifact(raw);

    expect(parsed.status).toBe("valid");
    if (parsed.status !== "valid") return;
    expect(parsed.artifact.artifactVersion).toBe(1);
    expect(parsed.artifact.surfaces.map((surface) => surface.id)).toEqual(
      [...surfaces].map((surface) => surface.id).sort(),
    );
    expect(validateSurfaceCalibrationArtifact(parsed.artifact, REVIEW_SURFACE_REGISTRY, surfaces).status).toBe("valid");
  });

  it("rejects a calibration when an associated asset hash changes", () => {
    const artifact = createSurfaceCalibrationArtifact(REVIEW_SURFACE_REGISTRY, surfaces, {}, mode);
    const value = JSON.parse(serializeSurfaceCalibrationArtifact(artifact)) as { assetHashes: Record<string, string> };
    value.assetHashes.day = "0".repeat(64);
    const parsed = parseSurfaceCalibrationArtifact(JSON.stringify(value));

    expect(parsed.status).toBe("valid");
    if (parsed.status !== "valid") return;
    const validation = validateSurfaceCalibrationArtifact(parsed.artifact, REVIEW_SURFACE_REGISTRY, surfaces);
    expect(validation.status).toBe("stale");
    expect(validation.message).toContain("hash");
  });

  it("rejects malformed quads and an incomplete Surface set", () => {
    const artifact = createSurfaceCalibrationArtifact(REVIEW_SURFACE_REGISTRY, surfaces, {}, mode);
    const malformed = JSON.parse(serializeSurfaceCalibrationArtifact(artifact)) as {
      surfaces: Array<{ quad: number[][] }>;
    };
    malformed.surfaces[0].quad = [[0, 0], [1, 0], [0, 0], [0, 1]];
    expect(parseSurfaceCalibrationArtifact(JSON.stringify(malformed)).status).toBe("invalid");

    const incomplete = JSON.parse(serializeSurfaceCalibrationArtifact(artifact)) as { surfaces: unknown[] };
    incomplete.surfaces = incomplete.surfaces.slice(1);
    const parsed = parseSurfaceCalibrationArtifact(JSON.stringify(incomplete));
    expect(parsed.status).toBe("valid");
    if (parsed.status !== "valid") return;
    expect(validateSurfaceCalibrationArtifact(parsed.artifact, REVIEW_SURFACE_REGISTRY, surfaces).status).toBe("invalid");
  });

  it("writes, reads, and clears only the current development-session override", () => {
    const storage = createMemoryStorage();
    const key = surfaceCalibrationStorageKey(REVIEW_SURFACE_REGISTRY, surfaces);
    const artifact = createSurfaceCalibrationArtifact(REVIEW_SURFACE_REGISTRY, surfaces, {}, mode);

    expect(writeStoredSurfaceCalibration(storage, key, artifact).status).toBe("written");
    expect(readStoredSurfaceCalibration(storage, key, REVIEW_SURFACE_REGISTRY, surfaces).status).toBe("valid");
    expect(clearStoredSurfaceCalibration(storage, key).status).toBe("written");
    expect(readStoredSurfaceCalibration(storage, key, REVIEW_SURFACE_REGISTRY, surfaces).status).toBe("missing");
  });

  it("fails closed when the storage boundary is unavailable", () => {
    const key = surfaceCalibrationStorageKey(REVIEW_SURFACE_REGISTRY, surfaces);
    const artifact = createSurfaceCalibrationArtifact(REVIEW_SURFACE_REGISTRY, surfaces, {}, mode);

    expect(writeStoredSurfaceCalibration(undefined, key, artifact).status).toBe("unavailable");
    expect(readStoredSurfaceCalibration(undefined, key, REVIEW_SURFACE_REGISTRY, surfaces).status).toBe("unavailable");
    expect(clearStoredSurfaceCalibration(undefined, key).status).toBe("unavailable");
  });
});
