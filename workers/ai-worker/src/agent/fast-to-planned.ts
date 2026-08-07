import type {
  FastExtractionArtifact,
  GenerationPlan,
} from "@ailearn/shared";

/**
 * P3-7: Fast ExtractArtifact → Planned 按 Bundle 重新归属转换
 * (实施计划 §5.3 P3-7"Fast ExtractArtifact 按 Bundle 重新归属转换步骤")。
 *
 * Fast 阶段产出全局候选列表(evidenceRefIds 引用全局 evidence);
 * Planned 阶段 Specialist 按 bundle 分工。本模块把 Fast 产物按
 * `plan.bundleTasks` 的 extractionFocus 归属到 bundle,输出
 * `bundleId → 归属候选`,供 Planned 的 Replan/Compose 复用:
 * - 归属失败的候选(Fast 遗留)进入 `leftovers`,由 Gap Detection 识别
 *   (升级矩阵前置验证第二项);
 * - 转换是纯函数、只读,不修改 Fast Artifact 本身。
 */

export interface BundleAttribution {
  bundleId: string;
  /** 该 bundle 归属的候选(按 focus 关键词命中,保持原顺序) */
  candidateIds: string[];
  /** 该 bundle 归属的 evidenceRefIds */
  evidenceRefIds: string[];
}

export interface AttributionResult {
  byBundle: Record<string, BundleAttribution>;
  /** 未归属任何 bundle 的候选(Fast 遗留,供 Gap Detection) */
  leftovers: string[];
}

/** 把 focus 转成匹配关键词(简单分词:去掉空白/括号/引号,取 2 字以上词) */
function focusKeywords(focus: string): string[] {
  return focus
    .split(/[\s,，。;；()（）"'“”]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
}

/**
 * 按 extractionFocus 关键词归属候选(标题/内容命中即归属;
 * 多 bundle 同时命中时按 plan 顺序先到先得,候选只归属一次)。
 */
export function attributeFastArtifactToBundles(
  plan: GenerationPlan,
  artifact: FastExtractionArtifact,
): AttributionResult {
  const byBundle: Record<string, BundleAttribution> = {};
  const leftovers: string[] = [];
  const assigned = new Set<string>();

  for (const task of plan.bundleTasks) {
    const keywords = focusKeywords(task.extractionFocus);
    const bucket: BundleAttribution = { bundleId: task.bundleId, candidateIds: [], evidenceRefIds: [] };

    for (const c of artifact.candidates) {
      if (assigned.has(c.localId)) continue;
      const haystack = `${c.topic ?? ""} ${c.claim ?? ""}`;
      const hit = keywords.length === 0 || keywords.some((k) => haystack.includes(k));
      if (hit) {
        bucket.candidateIds.push(c.localId);
        bucket.evidenceRefIds.push(...c.evidenceRefIds.filter((r) => !bucket.evidenceRefIds.includes(r)));
        assigned.add(c.localId);
      }
    }
    byBundle[task.bundleId] = bucket;
  }

  for (const c of artifact.candidates) {
    if (!assigned.has(c.localId)) leftovers.push(c.localId);
  }
  return { byBundle, leftovers };
}
