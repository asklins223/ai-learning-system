/**
 * P2-4：Fast 按需读取 Evidence（§3.1 原则）。
 *
 * FAST_EXTRACT / FAST_COMPOSE 只按 Evidence ID / Candidate / Bundle / Section
 * 读取证据子集，**禁止全文扫描**。本模块提供：
 * - 选择器契约(readSelector: ids | bundleIds | sectionKeys)
 * - 读取函数(纯函数,给定 evidence 池 + 选择器返回子集)
 * - 全文扫描守卫(检测未限定范围的调用)
 *
 * 不设数值上限(输入不受 token 限制的设计),但**范围必须由选择器限定**。
 */

export type EvidenceSelection =
  | { mode: "by_ids"; evidenceRefIds: string[] }
  | { mode: "by_bundles"; bundleIds: string[] }
  | { mode: "by_sections"; sectionKeys: string[] };

/** evidence 池条目(调用方从 PREPARE/DB 加载) */
export interface FastEvidenceEntry {
  refId: string;
  text: string;
  bundleId: string | null;
  sectionKey: string | null;
  blockType: string | null;
}

/** 按需读取结果 */
export interface FastEvidenceReadResult {
  selected: FastEvidenceEntry[];
  selection: EvidenceSelection;
  /** 命中证据的 Bundle 集(用于后续归属) */
  coveredBundleIds: string[];
}

/** 空选择器(未限定范围) → 拒绝全文扫描 */
export function isUnboundedSelection(selection: EvidenceSelection): boolean {
  if (selection.mode === "by_ids") return selection.evidenceRefIds.length === 0;
  if (selection.mode === "by_bundles") return selection.bundleIds.length === 0;
  return selection.sectionKeys.length === 0;
}

/**
 * 按选择器读取证据子集(纯函数,可单测)。
 * 未限定范围(空选择器)返回空结果——调用方必须显式选择,杜绝全文扫描。
 */
export function readEvidenceSubset(
  pool: FastEvidenceEntry[],
  selection: EvidenceSelection,
): FastEvidenceReadResult {
  if (isUnboundedSelection(selection)) {
    return { selected: [], selection, coveredBundleIds: [] };
  }

  let selected: FastEvidenceEntry[];
  if (selection.mode === "by_ids") {
    const wanted = new Set(selection.evidenceRefIds);
    selected = pool.filter((e) => wanted.has(e.refId));
  } else if (selection.mode === "by_bundles") {
    const wanted = new Set(selection.bundleIds);
    selected = pool.filter((e) => e.bundleId != null && wanted.has(e.bundleId));
  } else {
    const wanted = new Set(selection.sectionKeys);
    selected = pool.filter((e) => e.sectionKey != null && wanted.has(e.sectionKey));
  }

  const coveredBundleIds = [...new Set(selected.map((e) => e.bundleId).filter((b): b is string => b != null))];
  return { selected, selection, coveredBundleIds };
}
