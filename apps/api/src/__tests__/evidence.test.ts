/**
 * evidence.ts 单元测试
 *
 * 覆盖 effectiveAlignment / isHardEvidence / effectiveAlignmentForUser /
 * isHardEvidenceForUser 纯函数，以及 getUserOverrideMap 的空数组快速路径。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  effectiveAlignment,
  isHardEvidence,
  effectiveAlignmentForUser,
  isHardEvidenceForUser,
  getUserOverrideMap,
  type EvidenceAlignment,
  type EvidenceOverride,
} from "../lib/evidence.ts";

// ─── effectiveAlignment (legacy) ─────────────────────────────────────────

test("effectiveAlignment: 无 override 时返回原始 alignment", () => {
  assert.equal(effectiveAlignment("aligned", null), "aligned");
  assert.equal(effectiveAlignment("soft", null), "soft");
  assert.equal(effectiveAlignment("unaligned", null), "unaligned");
  assert.equal(effectiveAlignment("stale_alignment", null), "stale_alignment");
});

test("effectiveAlignment: rejected override 返回 null", () => {
  assert.equal(effectiveAlignment("aligned", "rejected"), null);
  assert.equal(effectiveAlignment("soft", "rejected"), null);
  assert.equal(effectiveAlignment("unaligned", "rejected"), null);
});

test("effectiveAlignment: downgraded override 返回 soft", () => {
  assert.equal(effectiveAlignment("aligned", "downgraded"), "soft");
  assert.equal(effectiveAlignment("unaligned", "downgraded"), "soft");
});

test("effectiveAlignment: confirmed override 返回 aligned", () => {
  assert.equal(effectiveAlignment("soft", "confirmed"), "aligned");
  assert.equal(effectiveAlignment("unaligned", "confirmed"), "aligned");
  assert.equal(effectiveAlignment("stale_alignment", "confirmed"), "aligned");
});

test("effectiveAlignment: 未知 override 值回退到原始 alignment", () => {
  assert.equal(effectiveAlignment("aligned", "unknown"), "aligned" as EvidenceAlignment);
});

// ─── isHardEvidence (legacy) ─────────────────────────────────────────────

test("isHardEvidence: aligned + 无 override 为 true", () => {
  assert.equal(isHardEvidence("aligned", null), true);
});

test("isHardEvidence: 非 aligned + 无 override 为 false", () => {
  assert.equal(isHardEvidence("soft", null), false);
  assert.equal(isHardEvidence("unaligned", null), false);
});

test("isHardEvidence: rejected override 为 false（null !== aligned）", () => {
  assert.equal(isHardEvidence("aligned", "rejected"), false);
});

test("isHardEvidence: confirmed override 将 soft 变为 hard", () => {
  assert.equal(isHardEvidence("soft", "confirmed"), true);
  assert.equal(isHardEvidence("unaligned", "confirmed"), true);
});

test("isHardEvidence: downgraded override 将 aligned 变为 soft → false", () => {
  assert.equal(isHardEvidence("aligned", "downgraded"), false);
});

// ─── effectiveAlignmentForUser (N-005) ───────────────────────────────────

test("effectiveAlignmentForUser: 无任何 override 时返回原始 alignment", () => {
  assert.equal(effectiveAlignmentForUser("aligned", null, null), "aligned");
  assert.equal(effectiveAlignmentForUser("soft", null, null), "soft");
});

test("effectiveAlignmentForUser: 仅 legacy override 时行为与 effectiveAlignment 一致", () => {
  assert.equal(effectiveAlignmentForUser("aligned", "rejected", null), null);
  assert.equal(effectiveAlignmentForUser("soft", "downgraded", null), "soft");
  assert.equal(effectiveAlignmentForUser("unaligned", "confirmed", null), "aligned");
});

test("effectiveAlignmentForUser: 用户级 override 优先于 legacy override", () => {
  // legacy=rejected, user=confirmed → 用户优先 → aligned
  assert.equal(
    effectiveAlignmentForUser("unaligned", "rejected", "confirmed" as EvidenceOverride),
    "aligned",
  );
  // legacy=confirmed, user=rejected → 用户优先 → null
  assert.equal(
    effectiveAlignmentForUser("aligned", "confirmed", "rejected" as EvidenceOverride),
    null,
  );
  // legacy=confirmed, user=downgraded → 用户优先 → soft
  assert.equal(
    effectiveAlignmentForUser("aligned", "confirmed", "downgraded" as EvidenceOverride),
    "soft",
  );
});

test("effectiveAlignmentForUser: 用户级 override 为 null 时回退到 legacy", () => {
  assert.equal(
    effectiveAlignmentForUser("aligned", "rejected", null),
    null,
  );
  assert.equal(
    effectiveAlignmentForUser("soft", "confirmed", null),
    "aligned",
  );
});

// ─── isHardEvidenceForUser (N-005) ───────────────────────────────────────

test("isHardEvidenceForUser: aligned + 无 override 为 true", () => {
  assert.equal(isHardEvidenceForUser("aligned", null, null), true);
});

test("isHardEvidenceForUser: 用户级 rejected 为 false", () => {
  assert.equal(
    isHardEvidenceForUser("aligned", null, "rejected" as EvidenceOverride),
    false,
  );
});

test("isHardEvidenceForUser: 用户级 confirmed 将 soft 变为 hard", () => {
  assert.equal(
    isHardEvidenceForUser("soft", null, "confirmed" as EvidenceOverride),
    true,
  );
});

test("isHardEvidenceForUser: 用户级 downgraded 将 aligned 变为 soft → false", () => {
  assert.equal(
    isHardEvidenceForUser("aligned", null, "downgraded" as EvidenceOverride),
    false,
  );
});

test("isHardEvidenceForUser: 用户级 override 优先于 legacy", () => {
  // legacy=confirmed 但 user=rejected → false
  assert.equal(
    isHardEvidenceForUser("unaligned", "confirmed", "rejected" as EvidenceOverride),
    false,
  );
});

// ─── getUserOverrideMap ──────────────────────────────────────────────────

test("getUserOverrideMap: 空数组返回空 Map（不查询数据库）", async () => {
  const result = await getUserOverrideMap("user-1", []);
  assert.equal(result.size, 0);
  assert.ok(result instanceof Map);
});
