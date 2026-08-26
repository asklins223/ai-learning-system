import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FilePendingReturnMarkerStore, MemoryPendingReturnMarkerStore } from "./pending-return-marker-store";

const subjectId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const marker = {
  version: 2 as const,
  runId: "00000000-0000-4000-8000-000000000003",
  originV2: { kind: "card" as const, cardId: "00000000-0000-4000-8000-000000000004", objectiveId: "00000000-0000-4000-8000-000000000005" },
  checkedAt: "2026-08-23T00:00:00.000Z",
};

describe("PendingReturnMarkerStore", () => {
  it("keeps one de-sensitized marker per subject/workspace", async () => {
    const store = new MemoryPendingReturnMarkerStore();
    await store.set(subjectId, workspaceId, marker);
    expect(await store.get(subjectId, workspaceId)).toEqual(marker);
    await store.set(subjectId, workspaceId, { ...marker, runId: "00000000-0000-4000-8000-000000000006" });
    expect((await store.get(subjectId, workspaceId))?.runId).toBe("00000000-0000-4000-8000-000000000006");
    await store.clear(subjectId, workspaceId);
    expect(await store.get(subjectId, workspaceId)).toBeNull();
  });

  it("clears every workspace marker for a subject without touching another subject", async () => {
    const store = new MemoryPendingReturnMarkerStore();
    const otherSubjectId = "00000000-0000-4000-8000-000000000009";
    const otherWorkspaceId = "00000000-0000-4000-8000-000000000010";
    await store.set(subjectId, workspaceId, marker);
    await store.set(subjectId, otherWorkspaceId, { ...marker, runId: "00000000-0000-4000-8000-000000000011" });
    await store.set(otherSubjectId, workspaceId, { ...marker, runId: "00000000-0000-4000-8000-000000000012" });

    await store.clearSubject(subjectId);

    await expect(store.get(subjectId, workspaceId)).resolves.toBeNull();
    await expect(store.get(subjectId, otherWorkspaceId)).resolves.toBeNull();
    await expect(store.get(otherSubjectId, workspaceId)).resolves.toMatchObject({ runId: "00000000-0000-4000-8000-000000000012" });
  });

  it("round-trips only the strict marker envelope across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "ailearn-marker-"));
    const path = join(root, "markers.json");
    try {
      const first = new FilePendingReturnMarkerStore(path);
      await first.set(subjectId, workspaceId, marker);
      const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      expect(persisted).not.toHaveProperty("result");
      expect(persisted).not.toHaveProperty("checkpoint");
      const second = new FilePendingReturnMarkerStore(path);
      await expect(second.get(subjectId, workspaceId)).resolves.toEqual(marker);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects legacy V1 or malformed persisted markers instead of resurrecting them", async () => {
    const root = await mkdtemp(join(tmpdir(), "ailearn-marker-legacy-"));
    const path = join(root, "markers.json");
    try {
      await writeFile(path, JSON.stringify({
        version: 1,
        entries: [{
          subjectId,
          workspaceId,
          marker: {
            version: 1,
            runId: marker.runId,
            origin: { kind: "card", cardId: marker.originV2.cardId, keyPointId: marker.originV2.objectiveId },
          },
        }],
      }));
      const store = new FilePendingReturnMarkerStore(path);
      await expect(store.get(subjectId, workspaceId)).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent workspace mutations so the last in-memory state wins", async () => {
    const root = await mkdtemp(join(tmpdir(), "ailearn-marker-race-"));
    const path = join(root, "markers.json");
    const otherWorkspaceId = "00000000-0000-4000-8000-000000000007";
    try {
      const store = new FilePendingReturnMarkerStore(path);
      await store.set(subjectId, workspaceId, marker);
      await Promise.all([
        store.clear(subjectId, workspaceId),
        store.set(subjectId, otherWorkspaceId, { ...marker, runId: "00000000-0000-4000-8000-000000000008" }),
      ]);

      const restarted = new FilePendingReturnMarkerStore(path);
      await expect(restarted.get(subjectId, workspaceId)).resolves.toBeNull();
      await expect(restarted.get(subjectId, otherWorkspaceId)).resolves.toMatchObject({
        runId: "00000000-0000-4000-8000-000000000008",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
