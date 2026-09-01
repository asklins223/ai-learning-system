import { describe, expect, it } from "vitest";
import {
  compareRoomSceneLayerEntries,
  isRoomSceneLayerAuditRecord,
  isRoomSceneLayerAuditAligned,
  serializeRoomSceneLayerIdentities,
  serializeRoomSceneLayerAudit,
  summarizeRoomSceneLayerAudit,
  type RoomSceneLayerAuditRecord,
} from "./room-scene-layer-audit";

describe("Room scene layer audit", () => {
  it("keeps candidate, mounted, blocked and failed counts consistent", () => {
    const audit: RoomSceneLayerAuditRecord[] = [
      {
        assetId: "ROOM-FOREGROUND-DAY",
        theme: "day",
        depth: "D6",
        order: 10,
        status: "mounted",
        reason: "mounted",
      },
      {
        assetId: "ROOM-LAMP-DAY",
        theme: "day",
        depth: "D4",
        order: 10,
        status: "blocked",
        reason: "review-not-approved",
      },
      {
        assetId: "ROOM-PAPER-DAY",
        theme: "day",
        depth: "D2",
        order: 10,
        status: "failed",
        reason: "texture-load-failed",
      },
    ];

    expect(summarizeRoomSceneLayerAudit(audit)).toEqual({
      candidates: 3,
      mounted: 1,
      blocked: 1,
      failed: 1,
    });
    expect(JSON.parse(serializeRoomSceneLayerAudit(audit))).toEqual(audit);
  });

  it("serializes an empty production layer registry as an empty audit", () => {
    expect(summarizeRoomSceneLayerAudit([])).toEqual({
      candidates: 0,
      mounted: 0,
      blocked: 0,
      failed: 0,
    });
    expect(serializeRoomSceneLayerAudit([])).toBe("[]");
  });

  it("keeps the audit identity list aligned with the current layer candidates", () => {
    const identities = [
      { assetId: "ROOM-FOREGROUND-DAY", theme: "day" as const, depth: "D6" as const, order: 10 },
      { assetId: "ROOM-LAMP-DAY", theme: "day" as const, depth: "D4" as const, order: 10 },
    ];
    const audit: RoomSceneLayerAuditRecord[] = [
      { ...identities[0], status: "mounted", reason: "mounted" },
      { ...identities[1], status: "blocked", reason: "review-not-approved" },
    ];

    expect(serializeRoomSceneLayerIdentities(identities)).toBe(JSON.stringify(identities));
    expect(isRoomSceneLayerAuditAligned(audit, identities)).toBe(true);
    expect(isRoomSceneLayerAuditAligned(audit, [identities[1], identities[0]])).toBe(false);
    expect(isRoomSceneLayerAuditAligned(audit, [identities[0], identities[0]])).toBe(false);
    expect(isRoomSceneLayerAuditAligned(audit, [identities[0], { ...identities[1], order: 11 }])).toBe(false);
  });

  it("orders entries by depth band and then by local order", () => {
    const entries = [
      { assetId: "near", theme: "day" as const, depth: "D4" as const, order: 20 },
      { assetId: "far", theme: "day" as const, depth: "D2" as const, order: 20 },
      { assetId: "middle", theme: "day" as const, depth: "D4" as const, order: 10 },
    ];

    expect([...entries].sort(compareRoomSceneLayerEntries).map((entry) => entry.assetId)).toEqual([
      "far",
      "middle",
      "near",
    ]);
  });

  it("rejects invalid audit enums and status-reason combinations", () => {
    const mounted = {
      assetId: "ROOM-FOREGROUND-DAY",
      theme: "day",
      depth: "D6",
      order: 10,
      status: "mounted",
      reason: "mounted",
    };

    expect(isRoomSceneLayerAuditRecord(mounted)).toBe(true);
    expect(isRoomSceneLayerAuditRecord({ ...mounted, order: 64 })).toBe(false);
    expect(isRoomSceneLayerAuditRecord({ ...mounted, theme: "dawn" })).toBe(false);
    expect(isRoomSceneLayerAuditRecord({ ...mounted, depth: "D0" })).toBe(false);
    expect(isRoomSceneLayerAuditRecord({ ...mounted, status: "blocked", reason: "unsupported-anchor" })).toBe(true);
    expect(isRoomSceneLayerAuditRecord({ ...mounted, status: "blocked", reason: "registration-out-of-bounds" })).toBe(true);
    expect(isRoomSceneLayerAuditRecord({ ...mounted, status: "blocked", reason: "invalid-registration" })).toBe(true);
    expect(isRoomSceneLayerAuditRecord({ ...mounted, status: "mounted", reason: "runtime-failed" })).toBe(false);
    expect(isRoomSceneLayerAuditRecord({ ...mounted, status: "blocked", reason: "texture-load-failed" })).toBe(false);
    expect(isRoomSceneLayerAuditRecord({ ...mounted, status: "failed", reason: "review-not-approved" })).toBe(false);
  });
});
