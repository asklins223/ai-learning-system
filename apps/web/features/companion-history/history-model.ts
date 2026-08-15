import type { Message } from "@/features/companion-pet/conversation/conversation-model";

export type CompanionHistoryKind =
  | "text"
  | "voice_transcript"
  | "proactive"
  | "action"
  | "result"
  | "route"
  | "error"
  | "recovery";

export type CompanionHistoryRole = "user" | "assistant" | "system";

export type CompanionHistoryBlock =
  | { type: "text"; text: string }
  | { type: "code"; code: string; language?: string }
  | { type: "citation"; label: string; href?: string; entityRef?: string }
  | { type: "action_ref"; proposalId: string; label?: string; status?: string }
  | { type: "result_ref"; actionRunId: string; label?: string; status?: string }
  | { type: "route_ref"; route: string; label: string; detail?: string }
  | { type: "error_detail"; code: string; detail: string; retryable: boolean }
  | { type: "recovery_detail"; label: string; detail: string };

export type CompanionHistoryReferenceTone =
  | "unknown"
  | "pending"
  | "running"
  | "success"
  | "stopped"
  | "danger";

export type CompanionHistoryReferenceState = {
  label: string;
  detail: string;
  tone: CompanionHistoryReferenceTone;
};

export type CompanionHistoryEntry = {
  id: string;
  role: CompanionHistoryRole;
  kind: CompanionHistoryKind;
  seq: number;
  createdAt: string;
  editedAt?: string | null;
  runId?: string | null;
  sourceLabel?: string;
  blocks: CompanionHistoryBlock[];
};

export type CompanionHistoryMessageInput = Message & {
  kind?: string;
  editedAt?: string | null;
  runId?: string | null;
};

const HISTORY_KINDS = new Set<CompanionHistoryKind>([
  "text",
  "voice_transcript",
  "proactive",
  "action",
  "result",
  "route",
  "error",
  "recovery",
]);

/**
 * 将当前生产 Message V1 投影为只读档案条目。
 * 未知块不会被当作可执行内容；它们会被忽略，并以安全占位说明代替。
 */
export function adaptProductionHistoryMessage(
  message: CompanionHistoryMessageInput,
): CompanionHistoryEntry {
  const blocks = parseProductionBlocks(message.blocks);
  return {
    id: message.id,
    role: normalizeRole(message.role),
    kind: normalizeKind(message.kind, blocks),
    seq: message.seq,
    createdAt: message.createdAt,
    editedAt: message.editedAt,
    runId: message.runId,
    sourceLabel: message.kind === "voice_transcript" ? "桌面伴星 · 语音" : "桌面伴星",
    blocks: blocks.length > 0
      ? blocks
      : [{ type: "text", text: "此条记录包含当前档案页尚不能展示的内容。" }],
  };
}

export function parseProductionBlocks(blocks: unknown): CompanionHistoryBlock[] {
  if (!Array.isArray(blocks)) return [];
  const result: CompanionHistoryBlock[] = [];

  for (const value of blocks) {
    if (!isObject(value) || typeof value.type !== "string") continue;
    if (value.type === "text" && typeof value.text === "string" && value.text.trim()) {
      result.push({ type: "text", text: value.text });
      continue;
    }
    if (value.type === "code" && typeof value.code === "string" && value.code.trim()) {
      result.push({
        type: "code",
        code: value.code,
        ...(typeof value.language === "string" ? { language: value.language } : {}),
      });
      continue;
    }
    if (value.type === "citation" && typeof value.label === "string" && isObject(value.target)) {
      if (
        value.target.kind === "external_https"
        && typeof value.target.href === "string"
        && isSafeHttpsUrl(value.target.href)
      ) {
        result.push({ type: "citation", label: value.label, href: value.target.href });
      } else if (value.target.kind === "entity" && typeof value.target.entityRef === "string") {
        result.push({ type: "citation", label: value.label, entityRef: value.target.entityRef });
      }
      continue;
    }
    if (value.type === "action_ref" && typeof value.proposalId === "string") {
      result.push({
        type: "action_ref",
        proposalId: value.proposalId,
        ...(typeof value.label === "string" && value.label.trim() ? { label: value.label } : {}),
        ...(typeof value.status === "string" && value.status.trim() ? { status: value.status } : {}),
      });
      continue;
    }
    if (value.type === "result_ref" && typeof value.actionRunId === "string") {
      result.push({
        type: "result_ref",
        actionRunId: value.actionRunId,
        ...(typeof value.label === "string" && value.label.trim() ? { label: value.label } : {}),
        ...(typeof value.status === "string" && value.status.trim() ? { status: value.status } : {}),
      });
    }
  }

  return result;
}

/**
 * 档案中的引用状态必须保守呈现：只有明确的终态值才使用成功视觉。
 * 缺失或未来新增的状态一律回退为“待确认”，绝不从“存在引用”推断已授权、已执行。
 */
export function historyReferenceState(
  type: "action" | "result",
  status?: string,
): CompanionHistoryReferenceState {
  const normalized = status?.trim().toLocaleLowerCase("zh-CN") ?? "";

  if (!normalized || ["unknown", "recorded", "created", "已记录"].includes(normalized)) {
    return type === "action"
      ? { label: "状态待确认", detail: "尚未读取授权或执行状态", tone: "unknown" }
      : { label: "状态待确认", detail: "尚未读取结果提交状态", tone: "unknown" };
  }

  if (["proposed", "awaiting_authorization", "pending_authorization", "待确认", "等待授权"].includes(normalized)) {
    return { label: "等待你的确认", detail: "尚未授权，也未开始执行", tone: "pending" };
  }

  if (["authorized", "queued", "已授权"].includes(normalized)) {
    return { label: "已授权 · 待执行", detail: "已收到授权，尚无完成回执", tone: "pending" };
  }

  if (["running", "in_progress", "executing", "执行中"].includes(normalized)) {
    return { label: "执行中", detail: "动作仍在进行，尚未形成完成回执", tone: "running" };
  }

  if ([
    "succeeded",
    "success",
    "completed",
    "committed",
    "demonstrated",
    "已完成",
    "已提交",
    "已授权并执行",
    "demonstrated · 已提交",
  ].includes(normalized)) {
    return type === "action"
      ? { label: "已完成", detail: "存在明确的动作完成状态", tone: "success" }
      : { label: "结果已提交", detail: "存在明确的结果提交状态", tone: "success" };
  }

  if (["rejected", "cancelled", "canceled", "expired", "skipped", "已拒绝", "已取消", "已过期"].includes(normalized)) {
    const expired = normalized === "expired" || normalized === "已过期";
    return {
      label: expired ? "提案已过期" : "未执行",
      detail: expired ? "需要重新生成提案后才能继续" : "动作已结束，且没有执行",
      tone: "stopped",
    };
  }

  if (["failed", "error", "commit_failed", "执行失败", "提交失败"].includes(normalized)) {
    return {
      label: type === "action" ? "执行失败" : "结果未提交",
      detail: "存在明确的失败状态，请结合相邻异常记录审阅",
      tone: "danger",
    };
  }

  return type === "action"
    ? { label: "状态待确认", detail: `未识别状态：${status}`, tone: "unknown" }
    : { label: "状态待确认", detail: `未识别状态：${status}`, tone: "unknown" };
}

export function historyEntryText(entry: CompanionHistoryEntry): string {
  const parts = [entry.kind, entry.role, entry.sourceLabel ?? ""];
  for (const block of entry.blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "code":
        parts.push(block.language ?? "", block.code);
        break;
      case "citation":
        parts.push(block.label, block.entityRef ?? "", block.href ?? "");
        break;
      case "action_ref":
        parts.push(block.label ?? "", block.proposalId, block.status ?? "");
        break;
      case "result_ref":
        parts.push(block.label ?? "", block.actionRunId, block.status ?? "");
        break;
      case "route_ref":
        parts.push(block.label, block.detail ?? "", block.route);
        break;
      case "error_detail":
        parts.push(block.code, block.detail);
        break;
      case "recovery_detail":
        parts.push(block.label, block.detail);
        break;
    }
  }
  return parts.join(" ").toLocaleLowerCase("zh-CN");
}

export function compactReference(value: string): string {
  if (value.length <= 13) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function formatHistoryDay(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

export function formatHistoryTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function historyDayKey(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "unknown";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function normalizeRole(role: string): CompanionHistoryRole {
  if (role === "user" || role === "system") return role;
  return "assistant";
}

function normalizeKind(
  kind: string | undefined,
  blocks: CompanionHistoryBlock[],
): CompanionHistoryKind {
  if (kind && HISTORY_KINDS.has(kind as CompanionHistoryKind)) {
    return kind as CompanionHistoryKind;
  }
  if (blocks.some((block) => block.type === "result_ref")) return "result";
  if (blocks.some((block) => block.type === "action_ref")) return "action";
  return "text";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
