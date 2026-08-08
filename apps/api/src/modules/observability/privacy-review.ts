/**
 * 阶段 08（W7）任务 08-4：privacy review 纯逻辑（§13.2 / 02-4 / 01-5 §5.3-12）。
 *
 * 本文件是**纯逻辑**（无 DB / 无网络 / 无时钟 / 无副作用 / 无随机）：把 02-4
 * 「Companion audit/ledger 隐私生命周期」与冻结记录 01-5 §5.3-12（「Companion
 * audit/ledger 超过冻结 TTL 仍含 entity ref、用户删除后存储残留、进入增长画像/
 * 兴趣推断或跨 workspace analytics：0；导出覆盖率：100%」）翻译成确定性检查清单。
 *
 * 检查面（`runPrivacyReview` 逐项输出 `PrivacyCheckResult`）：
 * 1. audit TTL：`companion_audit` 超过 30 天未 delete/tombstone 为违规；
 * 2. ledger TTL：`companion_invitation_ledger` 原始 entity refs 超过 30 天未
 *    delete/tombstone 为违规；
 * 3. audit tombstone content-free：tombstone 行必须清空 entity opaque IDs 与
 *    context/permission hashes；
 * 4. ledger tombstone content-free：tombstone 行必须把 key 替换为不可逆 SHA-256
 *    截断键、清空 boundedReason/suggestionLease/oneTimePermit；
 * 5. entity 数据清理覆盖全存储（DB/对象存储/队列/cache 残留为 0）；
 * 6. 导出覆盖率 100%：导出必须含活动行与 tombstone 行；
 * 7. 删除跨全部 workspace 级联；
 * 8. 删除后不触发重新邀请；
 * 9. 删除后不把拒绝行为重建为画像；
 * 10. 全存储残留扫描有唯一删除入口（deleteEntryPointCount === 1）；
 * 11. 用途隔离：不进入增长画像/兴趣推断/跨 workspace analytics；
 * 12. RLS 双条件：audit 属 user-private、ledger 属 user-private-in-workspace，
 *     任一 context 缺失 fail closed。
 */

// ─── 1. 冻结常量 ──────────────────────────────────────────────────────────

/** `companion_audit` 默认 TTL（30 天，02-4 §3，W0 privacy owner 冻结）。 */
export const AUDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** `companion_invitation_ledger` 原始 entity refs 默认 TTL（30 天，02-4 §3）。 */
export const LEDGER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ─── 2. 输入模型（纯数据）─────────────────────────────────────────────────

/** 一条 `companion_audit` 行的可观察状态（不含内容字段本身，只含是否 entity-bearing）。 */
export interface AuditRowState {
  createdAtMs: number;
  /** 已 tombstone（delete 模式下行已不存在；tombstone 模式保留不可逆计数）。 */
  tombstonedAtMs?: number;
  deleted: boolean;
  /** entityOpaqueIds 非空（entity-bearing）。 */
  hasEntityOpaqueIds: boolean;
  /** contextPermissionHashes 非空（entity-bearing）。 */
  hasContextPermissionHashes: boolean;
}

/** 一条 `companion_invitation_ledger` 行的可观察状态。 */
export interface LedgerRowState {
  updatedAtMs: number;
  tombstonedAtMs?: number;
  deleted: boolean;
  /** stablePageContextKey / contextBudgetKey / reasonBudgetKey 仍为原始值（未替换为不可逆截断键）。 */
  hasRawRefKeys: boolean;
  hasBoundedReason: boolean;
  hasSuggestionLease: boolean;
  hasOneTimePermit: boolean;
}

/** 全存储残留扫描结果：每个存储的 entity 残留计数必须为 0。 */
export interface StoreResidual {
  storeName: string;
  entityResidualCount: number;
}

/** 导出报告（导出覆盖率必须 100% 且含 tombstone 行）。 */
export interface ExportReport {
  exportedRows: number;
  totalRows: number;
  includesTombstoneRows: boolean;
}

/** 删除报告（级联、不重邀、不重建画像、唯一删除入口）。 */
export interface DeleteReport {
  cascadeAllWorkspaces: boolean;
  reinviteAfterDeleteCount: number;
  profileRebuildAfterDeleteCount: number;
  deleteEntryPointCount: number;
}

/** 用途隔离报告（审计/ledger 不得进入三处）。 */
export interface PurposeIsolationReport {
  intoGrowthProfiles: boolean;
  intoInterestInference: boolean;
  intoCrossWorkspaceAnalytics: boolean;
}

/** RLS 双条件（02-4 §4：ledger user-private-in-workspace、audit user-private）。 */
export interface RlsReport {
  auditDualCondition: boolean;
  ledgerDualCondition: boolean;
}

/** privacy review 输入：一次审查快照的全部可观察事实。 */
export interface PrivacyReviewInput {
  nowMs: number;
  auditTtlMs?: number;
  ledgerTtlMs?: number;
  auditRows: readonly AuditRowState[];
  ledgerRows: readonly LedgerRowState[];
  stores: readonly StoreResidual[];
  exportReport: ExportReport;
  deleteReport: DeleteReport;
  purposeIsolation: PurposeIsolationReport;
  rls: RlsReport;
  /**
   * security_review LOW 修复（fail closed）：若数据面确实为空（如系统刚启动
   * 无 audit 行），调用方必须显式声明 confirmedEmpty* = true 才不算「未确认」；
   * 缺省 false → 空快照视为未确认违规。
   */
  confirmedEmptyAudit?: boolean;
  confirmedEmptyLedger?: boolean;
  confirmedEmptyStores?: boolean;
}

// ─── 3. 检查清单定义与判定函数（每个都是确定性纯函数）────────────────────

/** 检查项 id（冻结）。 */
export type PrivacyCheckId =
  | "audit_unconfirmed"
  | "ledger_unconfirmed"
  | "stores_unconfirmed"
  | "audit_ttl"
  | "ledger_ttl"
  | "audit_tombstone_content_free"
  | "ledger_tombstone_content_free"
  | "entity_cleanup_all_stores"
  | "export_coverage_100"
  | "delete_cascade_all_workspaces"
  | "delete_no_reinvite"
  | "delete_no_profile_rebuild"
  | "residual_scan_unique_entry"
  | "purpose_isolation"
  | "rls_dual_condition";

/** 单个检查项的结果（pass 或带人类可读 detail 的违规）。 */
export interface PrivacyCheckResult {
  id: PrivacyCheckId;
  passed: boolean;
  detail: string;
}

function ok(id: PrivacyCheckId, detail: string): PrivacyCheckResult {
  return { id, passed: true, detail };
}

function fail(id: PrivacyCheckId, detail: string): PrivacyCheckResult {
  return { id, passed: false, detail };
}

/**
 * 1. audit TTL：超过 `auditTtlMs` 的行，必须已 delete 或已 tombstone。
 *    （delete 模式整行删除；tombstone 模式清空 entity refs 并置 tombstonedAt。）
 */
export function checkAuditTtl(
  rows: readonly AuditRowState[],
  nowMs: number,
  ttlMs = AUDIT_TTL_MS,
): PrivacyCheckResult {
  const expiredActive = rows.filter(
    (r) => !r.deleted && r.tombstonedAtMs === undefined && nowMs - r.createdAtMs > ttlMs,
  );
  return expiredActive.length === 0
    ? ok("audit_ttl", `audit 全部行在 ${ttlMs}ms TTL 内已处理`)
    : fail(
        "audit_ttl",
        `${expiredActive.length} 行 audit 超过 TTL ${ttlMs}ms 仍未 delete/tombstone`,
      );
}

/**
 * 2. ledger TTL：原始 entity refs 超过 `ledgerTtlMs` 的行，必须已 delete 或已
 *    tombstone（tombstone 需把 key 替换为不可逆截断键）。
 */
export function checkLedgerTtl(
  rows: readonly LedgerRowState[],
  nowMs: number,
  ttlMs = LEDGER_TTL_MS,
): PrivacyCheckResult {
  const expiredActive = rows.filter(
    (r) => !r.deleted && r.tombstonedAtMs === undefined && nowMs - r.updatedAtMs > ttlMs,
  );
  return expiredActive.length === 0
    ? ok("ledger_ttl", `ledger 全部行在 ${ttlMs}ms TTL 内已处理`)
    : fail(
        "ledger_ttl",
        `${expiredActive.length} 行 ledger 超过 TTL ${ttlMs}ms 仍含原始 entity refs`,
      );
}

/**
 * 3. audit tombstone content-free：tombstone 行必须清空 entityOpaqueIds 与
 *    contextPermissionHashes（02-4 §3）。tombstone 后可保留不可逆计数。
 */
export function checkAuditTombstoneContentFree(
  rows: readonly AuditRowState[],
): PrivacyCheckResult {
  const dirty = rows.filter(
    (r) => r.tombstonedAtMs !== undefined && (r.hasEntityOpaqueIds || r.hasContextPermissionHashes),
  );
  return dirty.length === 0
    ? ok("audit_tombstone_content_free", "audit tombstone 行均无 entity-bearing 字段")
    : fail(
        "audit_tombstone_content_free",
        `${dirty.length} 个 audit tombstone 行仍含 entityOpaqueIds/contextPermissionHashes`,
      );
}

/**
 * 4. ledger tombstone content-free：tombstone 行必须把 key 替换为不可逆 SHA-256
 *    截断键，清空 boundedReason/suggestionLease/oneTimePermit（02-4 §3）。
 */
export function checkLedgerTombstoneContentFree(
  rows: readonly LedgerRowState[],
): PrivacyCheckResult {
  const dirty = rows.filter(
    (r) =>
      r.tombstonedAtMs !== undefined &&
      (r.hasRawRefKeys || r.hasBoundedReason || r.hasSuggestionLease || r.hasOneTimePermit),
  );
  return dirty.length === 0
    ? ok("ledger_tombstone_content_free", "ledger tombstone 行均无原始 key/受限内容")
    : fail(
        "ledger_tombstone_content_free",
        `${dirty.length} 个 ledger tombstone 行仍含原始 key/boundedReason/lease/permit`,
      );
}

/**
 * 5. entity 数据清理覆盖全存储：DB/对象存储/队列/cache 任一残留 > 0 即违规
 *    （01-5 §5.3-12「用户删除后存储残留：0」；全复制面 redaction 语义 04-5）。
 */
export function checkEntityCleanupAllStores(
  stores: readonly StoreResidual[],
): PrivacyCheckResult {
  const dirty = stores.filter((s) => s.entityResidualCount > 0);
  return dirty.length === 0
    ? ok("entity_cleanup_all_stores", "全存储 entity 残留均为 0")
    : fail(
        "entity_cleanup_all_stores",
        dirty.map((s) => `${s.storeName}=${s.entityResidualCount}`).join(", "),
      );
}

/**
 * 6. 导出覆盖率 100%：导出必须包含全部行（活动行 + tombstone 行，02-4 §4）。
 */
export function checkExportCoverage(report: ExportReport): PrivacyCheckResult {
  if (report.totalRows > 0 && report.exportedRows < report.totalRows) {
    return fail(
      "export_coverage_100",
      `导出覆盖率 ${report.exportedRows}/${report.totalRows}，必须 100%`,
    );
  }
  if (!report.includesTombstoneRows) {
    return fail(
      "export_coverage_100",
      "导出必须包含 tombstone 行（活动行 + tombstone 行全量导出）",
    );
  }
  return ok("export_coverage_100", `导出覆盖率 100%（含 tombstone 行）`);
}

/**
 * 7. 删除跨全部 workspace 级联（02-4 §4 `deleteAllUserCompanionAuditAndLedger`）。
 */
export function checkDeleteCascadeAllWorkspaces(report: DeleteReport): PrivacyCheckResult {
  return report.cascadeAllWorkspaces
    ? ok("delete_cascade_all_workspaces", "audit+ledger 跨全部 workspace 级联删除")
    : fail("delete_cascade_all_workspaces", "删除未覆盖全部 workspace（必须级联）");
}

/**
 * 8. 删除后不触发重新邀请：ledger 删除后自动重新邀请计数必须为 0（02-4 §4）。
 */
export function checkDeleteNoReinvite(report: DeleteReport): PrivacyCheckResult {
  return report.reinviteAfterDeleteCount === 0
    ? ok("delete_no_reinvite", "删除后未触发重新邀请")
    : fail("delete_no_reinvite", `删除后自动重新邀请 ${report.reinviteAfterDeleteCount} 次`);
}

/**
 * 9. 删除后不把拒绝行为重建为画像（02-4 §4；不制造负向记录）。
 */
export function checkDeleteNoProfileRebuild(report: DeleteReport): PrivacyCheckResult {
  return report.profileRebuildAfterDeleteCount === 0
    ? ok("delete_no_profile_rebuild", "删除后未重建用户画像")
    : fail(
        "delete_no_profile_rebuild",
        `删除后重建画像 ${report.profileRebuildAfterDeleteCount} 次`,
      );
}

/**
 * 10. 全存储残留扫描有唯一删除入口：deleteEntryPointCount 必须为 1（02-4 §4
 *     「唯一删除入口已集中」）。
 */
export function checkResidualScanUniqueEntry(report: DeleteReport): PrivacyCheckResult {
  return report.deleteEntryPointCount === 1
    ? ok("residual_scan_unique_entry", "残留扫描唯一删除入口（count=1）")
    : fail(
        "residual_scan_unique_entry",
        `删除入口数 ${report.deleteEntryPointCount}，必须唯一（1）`,
      );
}

/**
 * 11. 用途隔离：audit/ledger 不得进入增长画像、兴趣推断或跨 workspace analytics
 *     （02-4 §2、01-5 §5.3-12）。
 */
export function checkPurposeIsolation(report: PurposeIsolationReport): PrivacyCheckResult {
  const offenders: string[] = [];
  if (report.intoGrowthProfiles) offenders.push("增长画像");
  if (report.intoInterestInference) offenders.push("兴趣推断");
  if (report.intoCrossWorkspaceAnalytics) offenders.push("跨 workspace analytics");
  return offenders.length === 0
    ? ok("purpose_isolation", "audit/ledger 用途隔离（不入画像/兴趣/跨 workspace analytics）")
    : fail("purpose_isolation", `audit/ledger 进入 ${offenders.join("、")}`);
}

/**
 * 12. RLS 双条件：audit 属 user-private、ledger 属 user-private-in-workspace，
 *     workspace_id + user_id 双条件，任一 context 缺失 fail closed（02-4 §4）。
 */
export function checkRlsDualCondition(report: RlsReport): PrivacyCheckResult {
  if (!report.auditDualCondition || !report.ledgerDualCondition) {
    return fail(
      "rls_dual_condition",
      `audit=${report.auditDualCondition} ledger=${report.ledgerDualCondition}，必须双条件 RLS`,
    );
  }
  return ok("rls_dual_condition", "audit/ledger 均满足 user-private 双条件 RLS");
}

// ─── 4. 聚合入口 ──────────────────────────────────────────────────────────

/** 全部检查项 id（冻结清单顺序）。 */
export const PRIVACY_CHECK_IDS: readonly PrivacyCheckId[] = [
  "audit_ttl",
  "ledger_ttl",
  "audit_tombstone_content_free",
  "ledger_tombstone_content_free",
  "entity_cleanup_all_stores",
  "export_coverage_100",
  "delete_cascade_all_workspaces",
  "delete_no_reinvite",
  "delete_no_profile_rebuild",
  "residual_scan_unique_entry",
  "purpose_isolation",
  "rls_dual_condition",
];

/** 运行完整 privacy review：确定性输出每个检查项结果（顺序固定）。 */
export function runPrivacyReview(input: PrivacyReviewInput): readonly PrivacyCheckResult[] {
  const auditTtlMs = input.auditTtlMs ?? AUDIT_TTL_MS;
  const ledgerTtlMs = input.ledgerTtlMs ?? LEDGER_TTL_MS;

  // security_review LOW 修复：未采样快照不得当作零违规通过（fail closed）。
  // 任何数据面为空且调用方未声明「确认为空」→ 标记未确认。
  const unconfirmed: PrivacyCheckResult[] = [];
  if (input.auditRows.length === 0 && !input.confirmedEmptyAudit) {
    unconfirmed.push(fail("audit_unconfirmed", "未提供 audit 行快照（未确认）→ fail closed"));
  }
  if (input.ledgerRows.length === 0 && !input.confirmedEmptyLedger) {
    unconfirmed.push(fail("ledger_unconfirmed", "未提供 ledger 行快照（未确认）→ fail closed"));
  }
  if (input.stores.length === 0 && !input.confirmedEmptyStores) {
    unconfirmed.push(fail("stores_unconfirmed", "未提供存储残留快照（未确认）→ fail closed"));
  }

  return [
    ...unconfirmed,
    checkAuditTtl(input.auditRows, input.nowMs, auditTtlMs),
    checkLedgerTtl(input.ledgerRows, input.nowMs, ledgerTtlMs),
    checkAuditTombstoneContentFree(input.auditRows),
    checkLedgerTombstoneContentFree(input.ledgerRows),
    checkEntityCleanupAllStores(input.stores),
    checkExportCoverage(input.exportReport),
    checkDeleteCascadeAllWorkspaces(input.deleteReport),
    checkDeleteNoReinvite(input.deleteReport),
    checkDeleteNoProfileRebuild(input.deleteReport),
    checkResidualScanUniqueEntry(input.deleteReport),
    checkPurposeIsolation(input.purposeIsolation),
    checkRlsDualCondition(input.rls),
  ];
}

/** privacy review 未通过时抛出的 fail-closed 错误。 */
export class PrivacyReviewFailure extends Error {
  readonly failures: readonly PrivacyCheckResult[];
  constructor(failures: readonly PrivacyCheckResult[]) {
    super(
      `privacy review 未通过（${failures.length} 项违规）：${failures
        .map((f) => `[${f.id}] ${f.detail}`)
        .join("; ")}`,
    );
    this.name = "PrivacyReviewFailure";
    this.failures = failures;
  }
}

/** 全部检查通过则返回结果，任一违规即抛 PrivacyReviewFailure（fail closed）。 */
export function assertPrivacyReviewPassed(
  input: PrivacyReviewInput,
): readonly PrivacyCheckResult[] {
  const results = runPrivacyReview(input);
  const failures = results.filter((r) => !r.passed);
  if (failures.length > 0) {
    throw new PrivacyReviewFailure(failures);
  }
  return results;
}
