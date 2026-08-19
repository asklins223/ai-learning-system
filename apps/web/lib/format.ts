/** 相对时间："3 分钟前"、"2 小时前"、"昨天"、"3 天前"，否则日期。null/undefined/无效输入返回空串。 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const time = d.getTime();
  if (!Number.isFinite(time)) return "";
  const now = Date.now();
  const diff = now - time;
  if (diff < 0) return "刚刚";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "昨天";
  if (day < 7) return `${day} 天前`;
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

/** 完整日期时间，用于 hover/title。 */
export function fullTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN");
}

/** 格式化日期为简短的中文日期时间。 */
export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 任务状态 → tone + 文案。 */
export function jobStatusMeta(status: string): { tone: "verified" | "running" | "weak" | "untouched"; label: string } {
  switch (status) {
    case "succeeded":
      return { tone: "verified", label: "成功" };
    case "running":
      return { tone: "running", label: "运行中" };
    case "failed":
    case "dead":
      return { tone: "weak", label: status === "dead" ? "已放弃" : "失败" };
    case "pending":
    default:
      return { tone: "untouched", label: "排队中" };
  }
}

/** 任务类型 → 中文文案。 */
export function jobTypeLabel(type: string): string {
  switch (type) {
    case "execute_card_agent_turn":
      return "生成学习卡";
    case "align_evidence":
      return "对齐证据";
    default:
      return type;
  }
}
