/**
 * 集中状态映射 — 所有页面共享的 status → presentation 映射。
 *
 * 页面禁止重复写三元表达式决定颜色或同一状态的不同中文文案。
 */

export type StatusTone =
  | "success"
  | "evidence"
  | "warning"
  | "danger"
  | "running"
  | "muted"
  | "neutral";

export interface StatusPresentation {
  label: string;
  tone: StatusTone;
  icon?: string;
  description?: string;
}

/* ── CardStatus 映射 ── */

const CARD_STATUS_MAP: Record<string, StatusPresentation> = {
  active: { label: "使用中", tone: "success" },
  superseded: { label: "已被新版本替代", tone: "muted", description: "此卡已有更新版本" },
  archived: { label: "已归档", tone: "muted" },
};

/* ── EvidenceAlignment 映射 ── */

const EVIDENCE_ALIGNMENT_MAP: Record<string, StatusPresentation> = {
  aligned: { label: "硬证据", tone: "evidence", description: "证据与关键点对齐" },
  soft: { label: "软证据", tone: "warning", description: "证据部分对齐" },
  unaligned: { label: "未对齐", tone: "muted", description: "证据未与关键点对齐" },
  stale_alignment: { label: "对齐过时", tone: "warning", description: "对齐状态可能过时" },
};

/* ── EvidenceOverride 映射 ── */

const EVIDENCE_OVERRIDE_MAP: Record<string, StatusPresentation> = {
  confirmed: { label: "已确认", tone: "success", description: "用户确认此证据" },
  downgraded: { label: "已降级", tone: "warning", description: "用户将证据降级为软证据" },
  rejected: { label: "已排除", tone: "danger", description: "用户排除此证据" },
};

/* ── ValidationOutcome 映射 ── */

const VALIDATION_OUTCOME_MAP: Record<string, StatusPresentation> = {
  preliminary_understanding: { label: "初步理解", tone: "success" },
  unclear_expression: { label: "表述不清", tone: "warning" },
  misunderstanding: { label: "存在误解", tone: "danger" },
  unknown: { label: "未知", tone: "muted" },
};

/* ── ReviewStatus 映射 ── */

const REVIEW_STATUS_MAP: Record<string, StatusPresentation> = {
  pending: { label: "待复习", tone: "warning" },
  accepted: { label: "已接受", tone: "success" },
  dismissed: { label: "已跳过", tone: "muted" },
  completed: { label: "已完成", tone: "success" },
  superseded: { label: "已替代", tone: "muted" },
  cancelled: { label: "已取消", tone: "muted" },
};

/* ── ReviewReason 映射 ── */

const REVIEW_REASON_MAP: Record<string, StatusPresentation> = {
  misunderstanding: { label: "误解修正", tone: "danger" },
  evidence_gap: { label: "证据不足", tone: "warning" },
  due_review: { label: "到期复习", tone: "warning" },
  manual_pin: { label: "手动置顶", tone: "neutral" },
};

/* ── SourceStatus 映射 ── */

const SOURCE_STATUS_MAP: Record<string, StatusPresentation> = {
  draft: { label: "草稿", tone: "muted" },
  processing: { label: "解析中", tone: "running" },
  ready: { label: "就绪", tone: "success" },
  failed: { label: "解析失败", tone: "danger" },
  archived: { label: "已归档", tone: "muted" },
};

/* ── JobStatus 映射 ── */

const JOB_STATUS_MAP: Record<string, StatusPresentation> = {
  pending: { label: "排队中", tone: "muted" },
  running: { label: "运行中", tone: "running" },
  succeeded: { label: "已完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
  dead: { label: "已终止", tone: "danger" },
};

/* ── UnderstandingState 映射 ── */

const UNDERSTANDING_STATE_MAP: Record<string, StatusPresentation> = {
  mastered: { label: "已掌握", tone: "success" },
  validated: { label: "已验证", tone: "evidence" },
  preliminary_understood: { label: "初步理解", tone: "success" },
  reviewed: { label: "已复习", tone: "evidence" },
  seen: { label: "已接触", tone: "muted" },
  learning: { label: "学习中", tone: "warning" },
  unvalidated: { label: "未验证", tone: "warning" },
  unseen: { label: "未接触", tone: "muted" },
  misunderstood: { label: "有误解", tone: "danger" },
  due_review: { label: "到期复习", tone: "warning" },
  context: { label: "学习脉络", tone: "neutral" },
};

/* ── 未知 fallback ── */

const UNKNOWN_PRESENTATION: StatusPresentation = {
  label: "未知状态",
  tone: "muted",
  description: "遇到未识别的状态值",
};

/* ── 查找函数 ── */

function lookup(map: Record<string, StatusPresentation>, key: string | undefined | null): StatusPresentation {
  if (!key) return UNKNOWN_PRESENTATION;
  return map[key] ?? UNKNOWN_PRESENTATION;
}

export const statusMap = {
  cardStatus: (s: string | undefined | null) => lookup(CARD_STATUS_MAP, s),
  evidenceAlignment: (s: string | undefined | null) => lookup(EVIDENCE_ALIGNMENT_MAP, s),
  evidenceOverride: (s: string | undefined | null) => lookup(EVIDENCE_OVERRIDE_MAP, s),
  validationOutcome: (s: string | undefined | null) => lookup(VALIDATION_OUTCOME_MAP, s),
  reviewStatus: (s: string | undefined | null) => lookup(REVIEW_STATUS_MAP, s),
  reviewReason: (s: string | undefined | null) => lookup(REVIEW_REASON_MAP, s),
  sourceStatus: (s: string | undefined | null) => lookup(SOURCE_STATUS_MAP, s),
  jobStatus: (s: string | undefined | null) => lookup(JOB_STATUS_MAP, s),
  understandingState: (s: string | undefined | null) => lookup(UNDERSTANDING_STATE_MAP, s),
};

/* ── Tone → CSS class 映射 ── */

export const TONE_CSS_MAP: Record<StatusTone, { bg: string; text: string; border: string }> = {
  success: {
    bg: "var(--color-success-soft)",
    text: "var(--color-success-text)",
    border: "var(--color-success)",
  },
  evidence: {
    bg: "var(--color-evidence-soft)",
    text: "var(--color-evidence-text)",
    border: "var(--color-evidence)",
  },
  warning: {
    bg: "var(--color-warning-soft)",
    text: "var(--color-warning-text)",
    border: "var(--color-warning)",
  },
  danger: {
    bg: "var(--color-danger-soft)",
    text: "var(--color-danger-text)",
    border: "var(--color-danger)",
  },
  running: {
    bg: "var(--color-running-soft)",
    text: "var(--color-running-text)",
    border: "var(--color-running)",
  },
  muted: {
    bg: "var(--color-surface-soft)",
    text: "var(--color-text-tertiary)",
    border: "var(--color-border)",
  },
  neutral: {
    bg: "var(--color-surface)",
    text: "var(--color-text-secondary)",
    border: "var(--color-border)",
  },
};
