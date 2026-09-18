/**
 * Page 14 「今日学习」重构（2026-09-18）：页面不再是"固定三张票"的推荐位，
 * 而是一份按时间倒序的当天操作日志流 + 状态异常事务追溯。这里把服务端
 * TodayActivityV1 投影成渲染层直接可用的行：纯函数、不碰 React，排序与
 * 文案判定都可以脱离渲染器测试。
 *
 * 设计意图（用户原话复述）：
 * 1. 像操作日志一样动态展示当天的真实操作，让用户感知"今天做了什么"；
 * 2. 能追溯状态异常的事务；
 * 3. 操作数据可持续提供给 AI 伴星 —— 由服务端权威表投影保证（伴星日记读同一批表）。
 */
import type {
  ActivityAnomalyV1,
  ActivityEventV1,
  ActivityTargetV1,
  TodayActivityV1,
} from "@ailearn/shared/activity-surface-contracts";

/** 每类事件的展示文案：kind 标签 + 动词前缀。 */
const KIND_LABELS: Readonly<Record<ActivityEventV1["kind"], string>> = {
  note: "笔记",
  source: "来源",
  objective: "理解目标",
  learning_run: "学习旅程",
  card_generation: "卡片生成",
  job: "后台任务",
  page: "页面",
};

/** 动词 → 这一行怎么说。title 仍是服务端给的实体名，这里只给"动作"半句。 */
const VERB_LABELS: Readonly<Record<ActivityEventV1["verb"], string>> = {
  "note.created": "新建笔记",
  "note.updated": "更新笔记",
  "source.created": "收录来源",
  "objective.created": "建立理解目标",
  "learning_run.started": "开始学习旅程",
  "learning_run.completed": "完成学习旅程",
  "card_generation.started": "发起卡片生成",
  "card_generation.review_ready": "候选卡等待审核",
  "job.scheduled": "后台任务",
  "page.viewed": "打开页面",
};

/** 异常状态 → 读者能懂的状态词。 */
export const ANOMALY_STATUS_LABELS: Readonly<Record<string, string>> = {
  needs_attention: "需要处理",
  failed: "失败",
  stale: "已过期",
  pending: "等待中",
  running: "运行中",
  dead: "重试耗尽",
  preparing: "准备中",
  active: "进行中",
  assessing: "评估中",
  checkpoint: "检查点",
  committing: "写入中",
};

/**
 * 「还在等」与「已经坏了」。
 *
 * 这份判定以前散在三个地方：渲染层的 RUNNING_ANOMALY_STATUSES、CSS 里七个
 * `[data-status=…]` 选择器、以及服务端的 phase 枚举 —— 新增一个阶段要改三处，
 * 漏一处就出现"卡住的旅程在转圈"这种自相矛盾的画面。现在渲染层只算一次，
 * 输出一个 `data-phase`，CSS 与图标都只认它。
 *
 * 学习旅程异常一律算 broken：能进这个区的旅程都是"超过 24 小时没进展"，
 * 给它转轮等于告诉读者"正在推进"，那是假的。
 */
const IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "preparing",
  "active",
  "assessing",
  "checkpoint",
  "committing",
]);

export type AnomalyPhase = "inflight" | "broken";

export function anomalyPhase(anomaly: Pick<ActivityAnomalyV1, "kind" | "status">): AnomalyPhase {
  if (anomaly.kind === "learning_run") return "broken";
  return IN_FLIGHT_STATUSES.has(anomaly.status) ? "inflight" : "broken";
}

export type TodayLogRow = {
  readonly id: string;
  /** HH:MM，按读者本地时钟显示。 */
  readonly time: string;
  /** 原始时刻，供 `<time dateTime>` 交给机器读。 */
  readonly at: string;
  /** 机器可读的事件种类（渲染层用它选图标、标 data-kind）。 */
  readonly kind: ActivityEventV1["kind"];
  readonly kindLabel: string;
  readonly action: string;
  readonly title: string;
  readonly detail: string | null;
  readonly target: ActivityTargetV1 | null;
};

/**
 * HH:MM。服务端给的是带时区的 ISO 时刻，这里用读者本地时钟渲染 —— 日志的
 * 读者关心的是"我几点做的那件事"。
 */
export function formatLogTime(iso: string): string {
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.valueOf())) return "--:--";
  const hours = `${parsed.getHours()}`.padStart(2, "0");
  const minutes = `${parsed.getMinutes()}`.padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** 日志流主行序：服务端已按时间倒序排好，这里保持原序（稳定、可直接渲染）。 */
export function buildTodayLogRows(events: readonly ActivityEventV1[]): readonly TodayLogRow[] {
  return events.map((event) => ({
    id: event.id,
    time: formatLogTime(event.at),
    at: event.at,
    kind: event.kind,
    kindLabel: KIND_LABELS[event.kind] ?? event.kind,
    action: VERB_LABELS[event.verb] ?? event.verb,
    title: event.title,
    detail: event.detail,
    target: event.target,
  }));
}

/**
 * 同一件事的重复异常会被并成一组。
 *
 * 真实数据里 26 条异常只有 4 个不同标题 —— 22 条是《无标题笔记》的重复项，标题
 * 又被省略号截断，读者看到的是一堵**长得分毫不差**的墙，只能靠看不见的 id 区分。
 * 归并后一行说清"同一件事 × N"，跳转取最近的那一条（同组本来就是同一个笔记/来源）。
 */
export type TodayAnomalyGroup = {
  /** 组内最新一条的 id，同时充当 React key。 */
  readonly id: string;
  readonly kind: ActivityAnomalyV1["kind"];
  readonly status: string;
  readonly statusLabel: string;
  readonly phase: AnomalyPhase;
  readonly title: string;
  readonly detail: string | null;
  /** 同一件事被记了几条；> 1 时页面要显示 ×N，不能假装只发生了一次。 */
  readonly count: number;
  readonly target: ActivityTargetV1 | null;
};

export function buildTodayAnomalyGroups(
  anomalies: readonly ActivityAnomalyV1[],
): readonly TodayAnomalyGroup[] {
  const groups = new Map<string, TodayAnomalyGroup>();
  for (const anomaly of anomalies) {
    // 服务端已按时间倒序排好，所以第一次见到的就是组内最新的一条。
    const key = `${anomaly.kind}|${anomaly.title}`;
    const existing = groups.get(key);
    if (existing) {
      groups.set(key, { ...existing, count: existing.count + 1 });
      continue;
    }
    groups.set(key, {
      id: anomaly.id,
      kind: anomaly.kind,
      status: anomaly.status,
      statusLabel: ANOMALY_STATUS_LABELS[anomaly.status] ?? anomaly.status,
      phase: anomalyPhase(anomaly),
      title: anomaly.title,
      detail: anomaly.detail,
      count: 1,
      target: anomaly.target,
    });
  }
  return [...groups.values()];
}

/** 一组的"处置语"：状态词 + 服务端给的处置提示。 */
export function anomalyStep(group: TodayAnomalyGroup): string {
  return group.detail ? `${group.statusLabel} · ${group.detail}` : group.statusLabel;
}

/**
 * 分诊顺序：最厚的一摞排最前。
 *
 * 归并重复项的全部意义就在那个 ×N —— 同一件事被记了 10 条，处理一次能清掉 10 条。
 * 服务端给的是时间倒序，于是最厚的一摞常常排在最后（实机截图里 ×10 那组正是第三
 * 行），读者要先看完两件零星的才会碰到收益最大的那件。次数相同时保持服务端原序
 * （Array.prototype.sort 是稳定的）。
 */
export function sortAnomalyGroups(groups: readonly TodayAnomalyGroup[]): readonly TodayAnomalyGroup[] {
  return [...groups].sort((a, b) => b.count - a.count);
}

/**
 * 多数组共用的处置语，提到组头上说一次。
 *
 * 实机数据里三组的第二行是**逐字相同**的"需要处理 · 服务端要求你先确认，再继续这次
 * 生成"—— 同一句话重复三遍不是强调，是噪声，还把每张卡的行高撑起来。只有覆盖 ≥2 组
 * 才算"共同"：只命中一组时那是这一组自己的话，逐行渲染才对。
 */
export function sharedAnomalyStep(groups: readonly TodayAnomalyGroup[]): string | null {
  if (groups.length < 2) return null;
  const counts = new Map<string, number>();
  for (const group of groups) {
    const step = anomalyStep(group);
    counts.set(step, (counts.get(step) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [step, count] of counts) {
    if (count > bestCount) {
      best = step;
      bestCount = count;
    }
  }
  return bestCount > 1 ? best : null;
}

/**
 * 「今天到底怎么样」——这一页第一眼要回答的问题。
 *
 * 原先这条判断只有一个 headline（"今天记录了 6 件事"）和放在右栏的分解句，
 * 数字与判断混在一句话里，而"有几件事卡住了"这个最要紧的数字根本不在第一屏。
 * 现在把**数字**和**判断**拆开：数字进 metrics（一眼可读），判断进 headline
 * （不带数字，避免同一屏把同一个数说两遍），countsLine 只作为分解。
 */
export type TodayMetric = {
  readonly key: "events" | "pending" | "span";
  readonly label: string;
  readonly value: string;
  /** 需要读者动手的那一枚（待处理）在页面上用警示色。 */
  readonly alarm: boolean;
};

export type TodayVerdict = {
  readonly headline: string;
  readonly detail: string;
  /** 待处理的事务条数（原始条数，不是归并后的类数）。 */
  readonly pending: number;
  /** 空的一天不给数字：0 和 0 说不了任何事。 */
  readonly metrics: readonly TodayMetric[];
};

const SUMMARY_KIND_ORDER: readonly ActivityEventV1["kind"][] = [
  "note",
  "source",
  "objective",
  "learning_run",
  "card_generation",
  "job",
];

/**
 * 今天操作的时段：最早一次到最晚一次。
 *
 * 只算正向操作。异常事务**不能**算 —— 它们不是按当天窗口查的（合同写的是
 * "今天（或近期）需要追溯"），实机 12 条异常横向跨到了前一天，于是 22:43 和
 * 19:50 被拼成一个读不懂的倒挂区间"22:43 – 19:50"。宁可这一格不出现。
 *
 * 只有一个时刻时不画成区间（"09:05 – 09:05" 是噪声）。
 */
export function todaySpan(activity: Pick<TodayActivityV1, "events">): string | null {
  const marks = activity.events
    .map((event) => new Date(event.at))
    .filter((date) => Number.isFinite(date.valueOf()))
    .sort((a, b) => a.valueOf() - b.valueOf());
  if (marks.length === 0) return null;
  const first = formatLogTime(marks[0].toISOString());
  const last = formatLogTime(marks[marks.length - 1].toISOString());
  return first === last ? first : `${first} – ${last}`;
}

/** 今日判断条：把当天的事实压成"数字 + 一句判断"。 */
export function buildTodayVerdict(
  activity: Pick<TodayActivityV1, "events" | "anomalies" | "truncated">,
): TodayVerdict {
  const total = activity.events.length;
  const pending = activity.anomalies.length;
  // 触顶时 total 只是"这一页装下的条数"，加号是因为不能让读者把这当成全天的总量。
  const counted = activity.truncated ? `${total}+` : `${total}`;

  const counts = new Map<ActivityEventV1["kind"], number>();
  for (const event of activity.events) {
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  }
  const countsLine = SUMMARY_KIND_ORDER.map((kind) => {
    const count = counts.get(kind) ?? 0;
    return count > 0 ? `${KIND_LABELS[kind]} ${count}` : null;
  })
    .filter((value): value is string => value !== null)
    .join(" · ");

  const span = todaySpan(activity);

  if (total === 0 && pending === 0) {
    return {
      headline: "今天还没有留下记录",
      detail: "写过笔记、收录过来源、复习过卡片，都会按时间出现在这里。",
      pending,
      metrics: [],
    };
  }

  const metrics: TodayMetric[] = [{ key: "events", label: "记录", value: counted, alarm: false }];
  if (pending > 0) metrics.push({ key: "pending", label: "待处理", value: `${pending}`, alarm: true });
  if (span) metrics.push({ key: "span", label: "时段", value: span, alarm: false });

  if (pending === 0) {
    return { headline: "今天的操作都推进得顺利", detail: countsLine || "今天没有卡住的事务。", pending, metrics };
  }
  if (total === 0) {
    return {
      headline: "今天的操作还没起步",
      detail: "先把卡住的事务处理掉，新的操作会按时间排在这里。",
      pending,
      metrics,
    };
  }
  return { headline: "有事务停在半路，处理完就能继续推进", detail: countsLine, pending, metrics };
}

/** 记录栏底部的诚实声明：触顶就说这不是完整账本，与旧账本栏同一原则。 */
export function todayLogTruncationNote(activity: Pick<TodayActivityV1, "truncated" | "events">): string | null {
  if (!activity.truncated) return null;
  return `今天的事超过了单页上限，这里只显示最近的 ${activity.events.length} 条；更早的记录请到各自的资料库查看。`;
}

/** 异常区被封顶时同样要说出来：没列出的异常不会自己消失。 */
export function todayAnomalyTruncationNote(activity: Pick<TodayActivityV1, "anomaliesTruncated">): string | null {
  if (!activity.anomaliesTruncated) return null;
  return "异常事务太多，这里只列最近的一部分；处理完这些后会看到剩下的。";
}
