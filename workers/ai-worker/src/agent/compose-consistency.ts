import type { GenerationPlan } from "@ailearn/shared";

/**
 * P3-5: Compose 一致性校验(实施计划 §3.2/§3.3)。
 *
 * Compose 按需读取 Evidence(默认不注入全文,不设数值上限——读取量受
 * 全局预算约束,见 §9-1),本节校验 Compose 输出的卡片引用是否一致:
 * - 卡片引用的 candidate ID 必须存在于该 bundle 的 candidate 集合;
 * - 卡片 claim 与 candidate 的 claim 文本一致(防模型改写);
 * - 同一卡片不得重复引用同一 candidate(重复);
 * - 引用必须命中已分配 Evidence(evidenceRefIds ⊆ allowlist)。
 */

export interface ComposeCardRef {
  cardId: string;
  candidateIds: string[];
  /** candidateId → 卡片实际使用的 claim 文本(与权威 claim 比对,防模型改写) */
  claimsByCandidate: Record<string, string>;
  /** 卡片引用的 Evidence ID(需 ⊆ allowlist) */
  evidenceRefIds: string[];
}

export interface ComposeConsistencyInput {
  plan: GenerationPlan;
  /** bundleId → 该 bundle 产出的 candidate ID 集合 */
  bundleCandidates: Record<string, Set<string>>;
  /** candidateId → claim 文本(权威) */
  claimByCandidateId: Map<string, string>;
  /** Evidence 允许清单 */
  evidenceAllowlist: Set<string>;
  cards: ComposeCardRef[];
}

export interface ComposeConsistencyIssue {
  code: "card_refs_unknown_candidate" | "card_claim_mismatch" | "card_duplicate_candidate_ref" | "card_refs_unassigned_evidence";
  cardId: string;
  candidateId?: string;
  message: string;
}

/** 校验 Compose 输出一致性(纯函数) */
export function validateComposeConsistency(input: ComposeConsistencyInput): ComposeConsistencyIssue[] {
  const issues: ComposeConsistencyIssue[] = [];

  // PERF: 一次性构建全局 candidate 集合，避免在 per-card 循环内对每个
  // candidate 做 O(bundles) 的 Object.values().some() 扫描。
  const allCandidateIds = new Set<string>();
  for (const set of Object.values(input.bundleCandidates)) {
    for (const cid of set) allCandidateIds.add(cid);
  }

  for (const card of input.cards) {
    const seen = new Set<string>();
    for (const cid of card.candidateIds) {
      // 重复引用
      if (seen.has(cid)) {
        issues.push({
          code: "card_duplicate_candidate_ref",
          cardId: card.cardId,
          candidateId: cid,
          message: `卡片 ${card.cardId} 重复引用 candidate ${cid}`,
        });
      }
      seen.add(cid);

      // candidate 存在性(任一 bundle 集合中有即可)
      const known = allCandidateIds.has(cid);
      if (!known) {
        issues.push({
          code: "card_refs_unknown_candidate",
          cardId: card.cardId,
          candidateId: cid,
          message: `卡片 ${card.cardId} 引用未知 candidate ${cid}`,
        });
      }
    }

    // claim 与权威 claim 一致(防改写;无权威记录的跳过)
    for (const [cid, claim] of Object.entries(card.claimsByCandidate)) {
      const authoritative = input.claimByCandidateId.get(cid);
      if (authoritative === undefined) continue;
      if (authoritative !== claim) {
        issues.push({
          code: "card_claim_mismatch",
          cardId: card.cardId,
          candidateId: cid,
          message: `卡片 ${card.cardId} 的 claim 与 candidate ${cid} 权威 claim 不一致`,
        });
      }
    }
    // 引用必须命中已分配 Evidence(卡片直接引用的 evidenceRefIds ⊆ allowlist)
    for (const ref of card.evidenceRefIds) {
      if (!input.evidenceAllowlist.has(ref)) {
        issues.push({
          code: "card_refs_unassigned_evidence",
          cardId: card.cardId,
          candidateId: ref,
          message: `卡片 ${card.cardId} 引用未分配 Evidence ${ref}`,
        });
      }
    }
  }

  return issues;
}
