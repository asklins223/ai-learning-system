/**
 * Objective 域的用户可见文案映射（纯常量 + 纯函数）。
 *
 * 背景（2026-08-22 实机 UI 审查）：服务端契约使用英文枚举
 * （knowledgeForm / reasonCodes / revisionClass / origin kind），
 * 直接渲染会把机器码泄漏给用户；conceptLabel 为 null 时前端回退
 * publicSummary，又导致"标题=摘要"的重复观感。这里统一收口：
 *  - 英文枚举 → 中文标签；
 *  - 标题/摘要去重（摘要与标题相同则不重复展示）。
 */

/** 知识形式 → 中文标签。未知值回退原码（fail-visible，便于发现新枚举）。 */
export const KNOWLEDGE_FORM_LABELS: Record<string, string> = {
  fact: "事实",
  definition: "定义",
  relationship: "关系",
  comparison: "对比",
  sequence: "过程顺序",
  procedure: "操作步骤",
  causal_model: "因果机制",
  boundary: "适用边界",
  application_rule: "应用规则",
};

export function knowledgeFormLabel(form: string): string {
  return KNOWLEDGE_FORM_LABELS[form] ?? form;
}

/** Dashboard primaryAction reasonCodes → 中文（见 learning-dashboard/service.ts priorityReasons）。 */
export const REASON_CODE_LABELS: Record<string, string> = {
  resume_active_run: "有未完成的练习",
  review_due_schedule: "到期复习",
  first_validation_ready: "等待首次验证",
  objective_ready: "可以开始学习",
  practice_only_reveal: "已看参考内容，练一下",
  missing_origin_repair: "来源待修复",
  superseded_has_successor: "已更新为新目标",
  // suggestedNote.reasonCodes（learning-dashboard/service.ts）也会发出的码：
  notes_without_objectives: "笔记可以生成学习目标",
  no_action_available: "暂无可执行动作",
  unknown_action: "状态确认中",
};

export function reasonCodeLabels(codes: readonly string[]): string {
  if (codes.length === 0) return "";
  return codes.map((code) => REASON_CODE_LABELS[code] ?? code).join(" · ");
}

/** 目标修订类别 → 中文（learning-card-v2-contracts objectiveRevisionClassV2）。 */
export const REVISION_CLASS_LABELS: Record<string, string> = {
  presentation_only: "呈现更新",
  target_equivalent: "等价修订",
  semantic_change: "语义变更",
};

export function revisionClassLabel(cls: string): string {
  return REVISION_CLASS_LABELS[cls] ?? cls;
}

/** 来源类型 → 中文（origin.kind：note | manual | imported | legacy）。 */
export const ORIGIN_KIND_LABELS: Record<string, string> = {
  note: "笔记",
  manual: "手动创建",
  imported: "导入",
  legacy: "历史迁移",
};

export function originKindLabel(kind: string): string {
  return ORIGIN_KIND_LABELS[kind] ?? kind;
}

/** 星图节点类型 → 中文（understanding-topology-v3 nodeRef.kind）。 */
export const NODE_KIND_LABELS: Record<string, string> = {
  source: "来源",
  note: "笔记",
  objective: "学习目标",
  evidence: "证据",
};

export function nodeKindLabel(kind: string): string {
  return NODE_KIND_LABELS[kind] ?? kind;
}

/** Objective 个人理解状态 → 中文（ObjectivePersonalStateV3）。 */
export const PERSONAL_STATE_LABELS: Record<string, string> = {
  unvalidated: "等待首次验证",
  learning: "学习中",
  stable: "已稳定",
  fragile: "脆弱",
  needs_repair: "需修复来源",
  due_review: "到期复习",
  scheduled: "已安排复习",
  archived: "已归档",
  superseded: "已由新版替代",
  outdated: "来源待更新",
};

export function personalStateLabel(state: string): string {
  return PERSONAL_STATE_LABELS[state] ?? state;
}

/** 稳定标题：conceptLabel 为空时回退 publicSummary（不再二次展示同一句）。 */
export function objectiveDisplayTitle(input: {
  conceptLabel?: string | null;
  publicSummary?: string | null;
}, maxLength = 60): string {
  const label = input.conceptLabel?.trim();
  if (label) return label.length > maxLength ? label.slice(0, maxLength) : label;
  const summary = input.publicSummary?.trim() ?? "";
  return summary.length > maxLength ? summary.slice(0, maxLength) : summary;
}

/** 摘要行：与标题相同（或为空）时返回 null，调用方据此隐藏，避免同句重复。 */
export function objectiveDistinctSummary(input: {
  conceptLabel?: string | null;
  publicSummary?: string | null;
}, maxLength = 120): string | null {
  const summary = input.publicSummary?.trim() ?? "";
  if (!summary) return null;
  const title = objectiveDisplayTitle(input, Number.MAX_SAFE_INTEGER);
  if (summary === title) return null;
  return summary.length > maxLength ? `${summary.slice(0, maxLength)}…` : summary;
}
