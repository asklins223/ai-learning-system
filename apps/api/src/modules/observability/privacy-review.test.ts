/**
 * 阶段 08（W7）任务 08-4：privacy review 单测（§13.2 / 02-4 / 01-5 §5.3-12）。
 *
 * 覆盖：audit/ledger TTL（含边界）、entity-bearing 数据清理（tombstone content-free
 * 双表）、导出覆盖率 100%（含 tombstone 行）、删除级联/不重邀/不重建画像/唯一删除
 * 入口、用途隔离、RLS 双条件；每个检查项提供「干净样本通过 + 违规样本必检」双断言。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertPrivacyReviewPassed,
  AUDIT_TTL_MS,
  checkAuditTtl,
  checkAuditTombstoneContentFree,
  checkDeleteCascadeAllWorkspaces,
  checkDeleteNoProfileRebuild,
  checkDeleteNoReinvite,
  checkEntityCleanupAllStores,
  checkExportCoverage,
  checkLedgerTtl,
  checkLedgerTombstoneContentFree,
  checkPurposeIsolation,
  checkResidualScanUniqueEntry,
  checkRlsDualCondition,
  LEDGER_TTL_MS,
  PrivacyReviewFailure,
  PRIVACY_CHECK_IDS,
  runPrivacyReview,
  type AuditRowState,
  type DeleteReport,
  type ExportReport,
  type LedgerRowState,
  type PrivacyReviewInput,
  type PurposeIsolationReport,
  type RlsReport,
  type StoreResidual,
} from "./privacy-review.ts";

// ─── helper ───────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = 1_000_000_000_000;

function auditRow(overrides: Partial<AuditRowState> = {}): AuditRowState {
  return {
    createdAtMs: NOW_MS - DAY_MS, // 1 天前，未过期
    deleted: false,
    hasEntityOpaqueIds: false,
    hasContextPermissionHashes: false,
    ...overrides,
  };
}

function ledgerRow(overrides: Partial<LedgerRowState> = {}): LedgerRowState {
  return {
    updatedAtMs: NOW_MS - DAY_MS,
    deleted: false,
    hasRawRefKeys: false,
    hasBoundedReason: false,
    hasSuggestionLease: false,
    hasOneTimePermit: false,
    ...overrides,
  };
}

function cleanInput(overrides: Partial<PrivacyReviewInput> = {}): PrivacyReviewInput {
  return {
    nowMs: NOW_MS,
    auditRows: [auditRow()],
    ledgerRows: [ledgerRow()],
    stores: [],
    confirmedEmptyStores: true, // 清理后确认无存储残留（空 = 确认的干净）
    exportReport: { exportedRows: 1, totalRows: 1, includesTombstoneRows: true },
    deleteReport: {
      cascadeAllWorkspaces: true,
      reinviteAfterDeleteCount: 0,
      profileRebuildAfterDeleteCount: 0,
      deleteEntryPointCount: 1,
    },
    purposeIsolation: {
      intoGrowthProfiles: false,
      intoInterestInference: false,
      intoCrossWorkspaceAnalytics: false,
    },
    rls: { auditDualCondition: true, ledgerDualCondition: true },
    ...overrides,
  };
}

// ─── 1. audit/ledger TTL ───────────────────────────────────────────────────

describe("privacy-review: audit/ledger TTL", () => {
  it("TTL 内未过期行通过", () => {
    assert.equal(checkAuditTtl([auditRow()], NOW_MS).passed, true);
    assert.equal(checkLedgerTtl([ledgerRow()], NOW_MS).passed, true);
  });

  it("超过 TTL 且未 delete/tombstone 的 audit 行判违规", () => {
    const result = checkAuditTtl(
      [auditRow({ createdAtMs: NOW_MS - AUDIT_TTL_MS - 1 })],
      NOW_MS,
    );
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("超过 TTL"));
  });

  it("超过 TTL 但已 tombstone 的 audit 行通过", () => {
    const result = checkAuditTtl(
      [
        auditRow({
          createdAtMs: NOW_MS - AUDIT_TTL_MS - 1,
          tombstonedAtMs: NOW_MS - 1,
        }),
      ],
      NOW_MS,
    );
    assert.equal(result.passed, true);
  });

  it("超过 TTL 但已 delete 的 audit 行通过", () => {
    const result = checkAuditTtl(
      [auditRow({ createdAtMs: NOW_MS - AUDIT_TTL_MS - 1, deleted: true })],
      NOW_MS,
    );
    assert.equal(result.passed, true);
  });

  it("超过 TTL 且未处理（不 tombstone 不 delete）的 ledger 行判违规", () => {
    const result = checkLedgerTtl(
      [ledgerRow({ updatedAtMs: NOW_MS - LEDGER_TTL_MS - 1 })],
      NOW_MS,
    );
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("仍含原始 entity refs"));
  });

  it("超过 TTL 但已 tombstone 的 ledger 行通过", () => {
    const result = checkLedgerTtl(
      [ledgerRow({ updatedAtMs: NOW_MS - LEDGER_TTL_MS - 1, tombstonedAtMs: NOW_MS })],
      NOW_MS,
    );
    assert.equal(result.passed, true);
  });

  it("默认 TTL 常量与冻结口径一致（30 天）", () => {
    assert.equal(AUDIT_TTL_MS, 30 * DAY_MS);
    assert.equal(LEDGER_TTL_MS, 30 * DAY_MS);
  });

  it("TTL 边界：恰好等于 TTL 未过期（> 而非 >=）", () => {
    assert.equal(checkAuditTtl([auditRow({ createdAtMs: NOW_MS - AUDIT_TTL_MS })], NOW_MS).passed, true);
  });
});

// ─── 2. entity-bearing 数据清理（tombstone content-free）──────────────────

describe("privacy-review: entity-bearing 数据清理", () => {
  it("audit tombstone 行已清空 entity refs 通过", () => {
    assert.equal(
      checkAuditTombstoneContentFree([auditRow({ tombstonedAtMs: NOW_MS })]).passed,
      true,
    );
  });

  it("audit tombstone 行仍含 entityOpaqueIds 判违规", () => {
    const result = checkAuditTombstoneContentFree([
      auditRow({ tombstonedAtMs: NOW_MS, hasEntityOpaqueIds: true }),
    ]);
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("entityOpaqueIds"));
  });

  it("audit tombstone 行仍含 contextPermissionHashes 判违规", () => {
    const result = checkAuditTombstoneContentFree([
      auditRow({ tombstonedAtMs: NOW_MS, hasContextPermissionHashes: true }),
    ]);
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("contextPermissionHashes"));
  });

  it("非 tombstone 活动行含 entity refs 不违反（活动行是正常状态）", () => {
    assert.equal(
      checkAuditTombstoneContentFree([auditRow({ hasEntityOpaqueIds: true })]).passed,
      true,
    );
  });

  it("ledger tombstone 行已替换截断键且清空受限内容通过", () => {
    assert.equal(
      checkLedgerTombstoneContentFree([ledgerRow({ tombstonedAtMs: NOW_MS })]).passed,
      true,
    );
  });

  it("ledger tombstone 行仍含原始 key 判违规", () => {
    const result = checkLedgerTombstoneContentFree([
      ledgerRow({ tombstonedAtMs: NOW_MS, hasRawRefKeys: true }),
    ]);
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("原始 key"));
  });

  it("ledger tombstone 行仍含 boundedReason/lease/permit 判违规", () => {
    for (const dirty of [
      { hasBoundedReason: true },
      { hasSuggestionLease: true },
      { hasOneTimePermit: true },
    ]) {
      const result = checkLedgerTombstoneContentFree([
        ledgerRow({ tombstonedAtMs: NOW_MS, ...dirty }),
      ]);
      assert.equal(result.passed, false);
    }
  });

  it("entity 清理覆盖全存储：任一存储残留 >0 判违规", () => {
    const stores: StoreResidual[] = [
      { storeName: "db", entityResidualCount: 0 },
      { storeName: "object_storage", entityResidualCount: 3 },
    ];
    const result = checkEntityCleanupAllStores(stores);
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("object_storage=3"));
    assert.equal(checkEntityCleanupAllStores([{ storeName: "db", entityResidualCount: 0 }]).passed, true);
  });
});

// ─── 3. 导出 / 删除 / 残留扫描 ─────────────────────────────────────────────

describe("privacy-review: 导出/删除与残留扫描", () => {
  it("导出覆盖率 100% 且含 tombstone 行通过", () => {
    const report: ExportReport = { exportedRows: 5, totalRows: 5, includesTombstoneRows: true };
    assert.equal(checkExportCoverage(report).passed, true);
  });

  it("导出覆盖率不足 100% 判违规", () => {
    const report: ExportReport = { exportedRows: 4, totalRows: 5, includesTombstoneRows: true };
    const result = checkExportCoverage(report);
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("4/5"));
  });

  it("导出不含 tombstone 行判违规（02-4 §4 必须含活动行与 tombstone 行）", () => {
    const report: ExportReport = { exportedRows: 5, totalRows: 5, includesTombstoneRows: false };
    const result = checkExportCoverage(report);
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("tombstone"));
  });

  it("删除跨全部 workspace 级联通过；未级联判违规", () => {
    const full: DeleteReport = {
      cascadeAllWorkspaces: true,
      reinviteAfterDeleteCount: 0,
      profileRebuildAfterDeleteCount: 0,
      deleteEntryPointCount: 1,
    };
    assert.equal(checkDeleteCascadeAllWorkspaces(full).passed, true);
    assert.equal(checkDeleteCascadeAllWorkspaces({ ...full, cascadeAllWorkspaces: false }).passed, false);
  });

  it("删除后不触发重新邀请通过；重邀 >0 判违规", () => {
    const full: DeleteReport = {
      cascadeAllWorkspaces: true,
      reinviteAfterDeleteCount: 0,
      profileRebuildAfterDeleteCount: 0,
      deleteEntryPointCount: 1,
    };
    assert.equal(checkDeleteNoReinvite(full).passed, true);
    const result = checkDeleteNoReinvite({ ...full, reinviteAfterDeleteCount: 2 });
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("2"));
  });

  it("删除后不重建画像通过；重建 >0 判违规", () => {
    const full: DeleteReport = {
      cascadeAllWorkspaces: true,
      reinviteAfterDeleteCount: 0,
      profileRebuildAfterDeleteCount: 0,
      deleteEntryPointCount: 1,
    };
    assert.equal(checkDeleteNoProfileRebuild(full).passed, true);
    assert.equal(
      checkDeleteNoProfileRebuild({ ...full, profileRebuildAfterDeleteCount: 1 }).passed,
      false,
    );
  });

  it("唯一删除入口通过；非 1 判违规", () => {
    const full: DeleteReport = {
      cascadeAllWorkspaces: true,
      reinviteAfterDeleteCount: 0,
      profileRebuildAfterDeleteCount: 0,
      deleteEntryPointCount: 1,
    };
    assert.equal(checkResidualScanUniqueEntry(full).passed, true);
    assert.equal(checkResidualScanUniqueEntry({ ...full, deleteEntryPointCount: 0 }).passed, false);
    assert.equal(checkResidualScanUniqueEntry({ ...full, deleteEntryPointCount: 3 }).passed, false);
  });
});

// ─── 4. 用途隔离与 RLS ─────────────────────────────────────────────────────

describe("privacy-review: 用途隔离与 RLS", () => {
  it("用途隔离通过；进入任一画像/推断/跨 workspace analytics 判违规", () => {
    const clean: PurposeIsolationReport = {
      intoGrowthProfiles: false,
      intoInterestInference: false,
      intoCrossWorkspaceAnalytics: false,
    };
    assert.equal(checkPurposeIsolation(clean).passed, true);
    assert.equal(
      checkPurposeIsolation({ ...clean, intoGrowthProfiles: true }).passed,
      false,
    );
    assert.equal(
      checkPurposeIsolation({ ...clean, intoInterestInference: true }).passed,
      false,
    );
    assert.equal(
      checkPurposeIsolation({ ...clean, intoCrossWorkspaceAnalytics: true }).passed,
      false,
    );
  });

  it("RLS 双条件通过；任一缺失判违规", () => {
    const clean: RlsReport = { auditDualCondition: true, ledgerDualCondition: true };
    assert.equal(checkRlsDualCondition(clean).passed, true);
    assert.equal(checkRlsDualCondition({ ...clean, auditDualCondition: false }).passed, false);
    assert.equal(checkRlsDualCondition({ ...clean, ledgerDualCondition: false }).passed, false);
  });
});

// ─── 5. 聚合套件与 fail closed ─────────────────────────────────────────────

describe("privacy-review: 聚合套件与 fail closed", () => {
  it("干净输入 12 项全部通过", () => {
    const results = runPrivacyReview(cleanInput());
    assert.equal(results.length, PRIVACY_CHECK_IDS.length);
    assert.deepEqual(results.map((r) => r.id), PRIVACY_CHECK_IDS);
    assert.equal(results.every((r) => r.passed), true);
  });

  it("任一违规导致 assertPrivacyReviewPassed 抛 PrivacyReviewFailure", () => {
    const input = cleanInput({
      deleteReport: {
        cascadeAllWorkspaces: true,
        reinviteAfterDeleteCount: 1,
        profileRebuildAfterDeleteCount: 0,
        deleteEntryPointCount: 1,
      },
    });
    assert.throws(() => assertPrivacyReviewPassed(input), PrivacyReviewFailure);
  });

  it("失败详情包含全部违规项 id（fail closed 人类可读）", () => {
    const input = cleanInput({
      auditRows: [auditRow({ createdAtMs: NOW_MS - AUDIT_TTL_MS - 1 })],
      purposeIsolation: { intoGrowthProfiles: true, intoInterestInference: false, intoCrossWorkspaceAnalytics: false },
    });
    try {
      assertPrivacyReviewPassed(input);
      assert.fail("应当抛错");
    } catch (err) {
      assert.ok(err instanceof PrivacyReviewFailure);
      const ids = err.failures.map((f) => f.id);
      assert.ok(ids.includes("audit_ttl"));
      assert.ok(ids.includes("purpose_isolation"));
    }
  });

  it("cleanInput 通过 assertPrivacyReviewPassed 返回全部结果", () => {
    const results = assertPrivacyReviewPassed(cleanInput());
    assert.equal(results.length, 12);
  });

  it("TTL 注入参数可覆盖（确定性、不改判定逻辑）", () => {
    // 1 天前的行 + 7 天 TTL 通过；7 天前超过 1 天 TTL 判违规。
    const input = cleanInput({
      auditTtlMs: DAY_MS,
      auditRows: [auditRow({ createdAtMs: NOW_MS - 2 * DAY_MS })],
    });
    const results = runPrivacyReview(input);
    const auditTtl = results.find((r) => r.id === "audit_ttl");
    assert.equal(auditTtl?.passed, false);
  });
});
