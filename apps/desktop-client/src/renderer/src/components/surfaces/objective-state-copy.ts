/**
 * 理解目标状态的**唯一**一份人话文案。
 *
 * 此前同一个状态词在四处各写各的（列表页 / 卡片页 / 星空图 / 宇宙图），
 * 于是「待验证」在两个不同的状态轴上各指一件事——用户看到同一个词，
 * 却不知道指的是哪一件（2026-09-20 实走复盘 #9、#14）。
 * 本文件是纯模块：React 组件与 `graph-sky.ts` 这类无 React 依赖的布局代码都能引。
 */
// 深路径导入：`@ailearn/shared` 的 barrel 会把 Node 侧模块（content-hash、
// feature-flags、provider-capabilities）拖进 renderer 的编译与打包图里。
import type {
  LearningObjectivePrimaryActionV3,
  ObjectivePersonalStateV3,
} from "@ailearn/shared/learning-objective-surface-contracts";

const STATE_COPY: Record<ObjectivePersonalStateV3, { label: string; hint: string }> = {
  unvalidated: {
    label: "还没正式答过",
    hint: "这张卡还没有一次正式作答。答一次才知道你到底会不会。",
  },
  learning: {
    label: "正在作答",
    hint: "这一轮还没有结束，接着上次的位置继续就行。",
  },
  stable: {
    label: "已经答对过",
    hint: "至少有一次正式作答被判为达标。",
  },
  fragile: {
    label: "有点生疏",
    hint: "隔得久了正确率在掉，做一遍就能补回来。",
  },
  needs_repair: {
    label: "上次答错了",
    hint: "最近一次正式作答没达标，需要重新把理解修一遍。",
  },
  due_review: {
    label: "到复习时间了",
    hint: "按记忆曲线排到今天，复习一次就好。",
  },
  scheduled: {
    label: "已排复习",
    hint: "下一次复习时间已经排好，到期之前不用管它。",
  },
  outdated: {
    label: "原文更新了",
    hint: "笔记内容变了，这张卡说的还是旧版本，需要重新核对。",
  },
  archived: {
    label: "已归档",
    hint: "你把它收起来了，不再出现在作答和复习队列里。",
  },
  superseded: {
    label: "已被新卡替代",
    hint: "同一件事有了新版本，旧卡只留记录，不再可答。",
  },
};

/** 星空图等投影侧的 state 是自由字符串；认不出的一律原样显示，不编造文案。 */
function copyOf(state: string): { label: string; hint: string } | null {
  return STATE_COPY[state as ObjectivePersonalStateV3] ?? null;
}

export function formatObjectiveState(state: string): string {
  return copyOf(state)?.label ?? state;
}

/** 一句话说明这个状态到底意味着什么；列表与详情共用同一句，不另写一份。 */
export function objectiveStateHint(state: string): string {
  return copyOf(state)?.hint ?? "";
}

export function objectiveStateTone(state: string): "calm" | "attention" | "progress" | "neutral" {
  switch (state) {
    case "stable": return "calm";
    case "learning":
    case "scheduled": return "progress";
    case "fragile":
    case "needs_repair":
    case "due_review":
    case "outdated": return "attention";
    default: return "neutral";
  }
}

/**
 * 「需要学习者来一趟」的唯一口径：星空图靠它决定星星的大小，列表页靠它数
 * 「要处理」。`unvalidated` 不在 tone 的 attention 里，但一张从没答过的卡
 * 恰恰是最需要处理的那一类——这个例外以前写在调用方的 if 里，现在写在这里。
 */
export function objectiveStateNeedsAttention(state: string): boolean {
  return objectiveStateTone(state) === "attention" || state === "unvalidated";
}

/**
 * 时间点自己拼，不走 `Intl` 的 zh-CN：同一份 `month:"numeric"` 在 Electron
 * （full-icu）里出「9月21日」，在 vitest 的 Node 里出「9/21」——等待终点是
 * 用户要做决定的信息，不能随运行环境的 ICU 版本换写法。
 */
export function formatObjectiveDateTime(value: string | null | undefined): string {
  if (!value) return "时间未定";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return "时间未定";
  const hour = String(parsed.getHours()).padStart(2, "0");
  const minute = String(parsed.getMinutes()).padStart(2, "0");
  return `${parsed.getMonth() + 1}月${parsed.getDate()}日 ${hour}:${minute}`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 「今天 / 昨天 / 5 天后 / 9月25日」：行内放不下完整日期，也不该让用户自己减天数。 */
export function formatObjectiveDay(value: string | null | undefined): string {
  const parsed = value ? new Date(value) : null;
  if (!parsed || !Number.isFinite(parsed.valueOf())) return "时间未定";
  const dayDiff = Math.round((startOfDay(parsed) - startOfDay(new Date())) / 86_400_000);
  if (dayDiff === 0) return "今天";
  if (dayDiff === -1) return "昨天";
  if (dayDiff === 1) return "明天";
  if (dayDiff > 1 && dayDiff <= 30) return `${dayDiff} 天后`;
  if (dayDiff < -1 && dayDiff >= -30) return `${-dayDiff} 天前`;
  return `${parsed.getMonth() + 1}月${parsed.getDate()}日`;
}

/**
 * 列表行上的进展标记（复盘 #7：答完一张卡回到列表，行上什么变化都看不到）。
 * 只讲服务端确实知道的事实，不重复状态标签已经说过的话。
 */
export function objectiveProgressChips(progress: {
  practiceTrailCount: number;
  lastCanonicalAt: string | null;
  reviewDueAt: string | null;
  initialValidation: "ready" | "deferred" | "completed" | null;
  validationNotBefore: string | null;
}): string[] {
  const chips: string[] = [];
  if (progress.lastCanonicalAt) {
    chips.push(`正式答过 · ${formatObjectiveDay(progress.lastCanonicalAt)}`);
  } else if (progress.practiceTrailCount > 0) {
    chips.push(`练过 ${progress.practiceTrailCount} 次`);
  }
  if (progress.initialValidation === "deferred") {
    chips.push(`${formatObjectiveDateTime(progress.validationNotBefore)} 后才能正式答`);
  }
  if (progress.reviewDueAt) {
    // 「复习 11 天前」在活应用里被读成了"11 天前复习过"（实测一行 overdue 的卡）。
    // 过期的要说成过期，未到的说还有几天。
    const due = new Date(progress.reviewDueAt);
    const days = Number.isFinite(due.valueOf())
      ? Math.round((startOfDay(due) - startOfDay(new Date())) / 86_400_000)
      : null;
    chips.push(days === null || days > 30
      ? `复习 ${formatObjectiveDay(progress.reviewDueAt)}`
      : days < 0
        ? `复习已到期 ${-days} 天`
        : days === 0
          ? "今天复习"
          : `复习 ${days} 天后`);
  }
  return chips;
}

export function primaryActionLabel(action: LearningObjectivePrimaryActionV3): string {
  switch (action.kind) {
    case "create_run":
    case "create_review_run":
    case "practice_only": return action.label;
    case "resume_run": return "继续作答";
    case "wait_for_initial_validation": return "现在还不能正式答";
    case "view_successor": return "看新版本";
    case "refresh": return "重新读取";
    case "none": return "暂无可做的";
  }
}

/**
 * 按钮下面那一句话。`wait_for_initial_validation` 与 `practice_only` 必须
 * 把「为什么」和「什么时候能正式算」写在明面上——只给一个灰色按钮，
 * 用户只会以为产品坏了（复盘 #9）。
 */
export function primaryActionDescription(action: LearningObjectivePrimaryActionV3): string {
  switch (action.kind) {
    case "create_run":
    case "create_review_run": return `${action.label}，完成后会写回这一题的真实状态。`;
    case "resume_run": return "上次保存的进度还在，不会从头再来。";
    case "practice_only": return action.formalValidationNotBefore
      ? `这一题的参考答案你看过，所以这次只算练习；正式验证 ${formatObjectiveDateTime(action.formalValidationNotBefore)} 开放。`
      : "这一题的参考答案你看过，所以这次只算练习，不改动正式理解状态。";
    case "wait_for_initial_validation": return `这一题要到 ${formatObjectiveDateTime(action.qualificationNotBefore)} 才能开始正式验证。到点自动开放；这段时间可以先看讲解，或去做别的卡。`;
    case "view_successor": return "这张卡已经有新版本，旧版本只保留记录。";
    case "refresh": return "目标或来源内容变了，需要重新读取最新内容。";
    case "none": return "这一轮暂时没有要做的。";
  }
}
