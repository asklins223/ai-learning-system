/**
 * 环境快照（方案 29 §4.1）：每轮**无条件**注入的「她现在知道什么」。
 *
 * 为什么是注入而不是工具：基线实测 90.7% 的轮次她一个工具都没拿到（`selectSkill`
 * 关键词没命中 → 工具面为空 → 单步）。把「知道当前时间/在学什么/刚写了什么笔记」
 * 做成一次工具调用，等于把这些事实也一并关进了那 90.7%。所以：
 *
 *   **自觉 = 每轮免费预计算；工具 = 需要下钻时才调。**
 *
 * 全部走 SQL，不调模型，跑在对话 handler 已有的那个 RLS 读事务里（`loadHereAndNow`
 * 收 `tx` 而不是自己开事务，就是为了不多一次往返、也不脱离 RLS 作用域）。
 *
 * 时区口径：库里存 UTC，用户侧是 +8。时区**不硬编码**——取
 * `user_companion_account_state.quiet_hours->>'timezone'`（客户端 `Intl` 探测后随
 * 静默时段一起存进来的，见 proactive-hook 的同一来源），缺省才回落 Asia/Shanghai。
 * 主动提醒的静默判定用的就是这一列，两处必须同源，否则会出现「她说现在是早上，
 * 但静默时段按另一个钟判」的分裂。
 */

import { sql } from "drizzle-orm";
import type { WorkerTransaction } from "../db.ts";
import { parsePageContext } from "./companion-dialogue-content.ts";

const FALLBACK_TIMEZONE = "Asia/Shanghai";

export interface HereAndNowSnapshot {
  /** 用户本地钟面时间，如 `2026-09-20 18:12`。 */
  localTime: string;
  /** 中文星期，如 `周六`。 */
  weekday: string;
  /** 中文时段：凌晨/早上/上午/中午/下午/傍晚/晚上/深夜。 */
  partOfDay: string;
  /** 距上一次伴星对话多少分钟；从未聊过为 null。 */
  minutesSinceLastSeen: number | null;
  pet: { name: string; activeness: string; interactionCount: number } | null;
  /**
   * 进行中的学习运行。
   *
   * `topic` 取 `learning_tasks.target_summary`（真人类可读，如「牛顿第二定律的公式 F=ma」），
   * **不是** `learning_runs.goal`——那一列是枚举，实测活跃运行里恒为 `stabilize`，
   * 注入进去会让她说"你正在学习 stabilize"。
   */
  activeRun: { topic: string | null; phase: string; usedSeconds: number; budgetSeconds: number | null; taskPrompt: string | null } | null;
  dueReviews: number;
  today: { studySeconds: number; runs: number };
  recentNotes: { title: string; ageLabel: string }[];
  noteCount: number;
  pendingProposals: number;
  /**
   * 用户此刻停在哪个界面（抱怨 #5「看不到我当前界面」）。
   *
   * 这是**本轮免费预计算**而不是工具：她要么知道用户在哪儿，要么这一轮根本不知道
   * 该问什么。title 只有在实体级页面（笔记/卡片）才解析得出来，其余只有页面类型。
   */
  currentPage: { kind: string; title: string | null } | null;
  /**
   * 最近一条还没兑现的提醒（她答应过的事）。不放进快照，她就只能"当场记住"，
   * 转头又问用户"你要我提醒什么"——许过约却不记得，比从没答应更伤信任。
   */
  nextReminder: { text: string; fireAtLocal: string } | null;
}

const ACTIVE_RUN_PHASES = ["preparing", "active", "assessing", "checkpoint", "committing", "paused"];

/**
 * `phase = ANY(${数组})` 在 drizzle 下是**坏的**：它把 JS 数组摊成 6 个独立标量参数，
 * 生成 `= ANY(($3,$4,$5,$6,$7,$8))`，Postgres 直接报 "op ANY/ALL (array) requires
 * array on right side"（实机把 read 阶段打挂、job 连败三次）。用 IN + 逐项参数化。
 */
const ACTIVE_RUN_PHASE_PREDICATE = sql`r.phase IN (${sql.join(
  ACTIVE_RUN_PHASES.map((phase) => sql`${phase}`),
  sql`, `,
)})`;

function partOfDay(hour: number): string {
  if (hour < 5) return "凌晨";
  if (hour < 8) return "早上";
  if (hour < 11) return "上午";
  if (hour < 13) return "中午";
  if (hour < 17) return "下午";
  if (hour < 19) return "傍晚";
  if (hour < 23) return "晚上";
  return "深夜";
}

/** 下标 = Postgres `EXTRACT(DOW)`：0=周日…6=周六。 */
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * Postgres `EXTRACT(DOW)`（0=周日…6=周六）→ 中文星期。
 *
 * 这里**不**用 `EXTRACT(isodow)`：`dow`/`hour` 都是 Postgres 的保留字（type_name /
 * func_name 类），裸当列别名用会 "syntax error at or near"，把整条快照查询打挂。
 * 别名改用 weekday/hour_of_day，字段名也就跟着换成了同样写法大写的 DOW/HOUR。
 */
export function weekdayLabel(dow: number): string {
  return WEEKDAYS[Number(dow)];
}

/**
 * 「3 小时前」「昨天」「3 天前」这种相对说法；模型转述比 ISO 时间戳自然得多。
 * 导出给工具执行器用（搜索/读取笔记的"上次改动"），两处说法必须一致——
 * 同一个时间在她嘴里出现两种讲法，比不自然更像 bug。
 */
export function ageLabel(minutes: number): string {
  if (minutes < 2) return "刚刚";
  if (minutes < 60) return `${Math.round(minutes)} 分钟前`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} 小时前`;
  const days = Math.round(minutes / (24 * 60));
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  return `${Math.round(days / 30)} 个月前`;
}

export async function loadHereAndNow(
  tx: WorkerTransaction,
  scope: {
    workspaceId: string;
    userId: string;
    conversationId?: string | null;
    /** 本轮 Bridge page context（对象或 JSON 字符串）；缺省就没有"当前界面"这一行。 */
    pageContext?: unknown;
  },
): Promise<HereAndNowSnapshot> {
  // 时钟与账号：单条 SELECT 常量查询，永远返回一行（账号行缺失时走回落时区）。
  // 别名不能叫 `hour`/`date`——它们是 Postgres 保留字，裸用会 "syntax error at or near"
  // （实机把整条 read 阶段打挂，job 连败三次）。
  const clock = (await tx.execute<{ local_time: string; weekday: number; hour_of_day: number }>(sql`
    SELECT
      to_char(now() AT TIME ZONE ${tzSubquery(scope.userId)}, 'YYYY-MM-DD HH24:MI') local_time,
      EXTRACT(DOW FROM now() AT TIME ZONE ${tzSubquery(scope.userId)})::int weekday,
      EXTRACT(HOUR FROM now() AT TIME ZONE ${tzSubquery(scope.userId)})::int hour_of_day
  `))[0];

  const petRows = await tx.execute<{
    name: string; activeness: string; interaction_count: number; last_active_at: Date | null;
  }>(sql`
    SELECT name, activeness, interaction_count, last_active_at
    FROM pet_profiles WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
    LIMIT 1
  `);
  const petRow = petRows[0];

  // conversationId 为空 = 跨**本空间所有**会话取最近一次说话（念头管线没有"当前会话"，
  // 它要的就是"多久没理我了"）；有则排除本轮，避免"距上次说话 0 分钟"这种自指噪音。
  // workspace_id 必须在：多空间审查实测到，缺它时 A 空间的发言会改掉 B 空间她说的
  // "你已经 3 天没理我了"——同一句话在两个空间里指向两个事实。
  const excludeCurrentConversation = scope.conversationId
    ? sql`AND conversation_id <> ${scope.conversationId}`
    : sql``;
  const seenRows = await tx.execute<{ gap: number | null }>(sql`
    SELECT EXTRACT(EPOCH FROM (now() - max(created_at))) / 60 gap
    FROM companion_messages
    WHERE workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId} ${excludeCurrentConversation}
  `);
  const gapMinutes = seenRows[0]?.gap == null ? null : Math.round(Number(seenRows[0].gap));

  const runRows = await tx.execute<{
    phase: string; active_seconds_used: number; time_budget_seconds: number | null;
    target_summary: string | null; task_prompt: string | null;
  }>(sql`
    SELECT r.phase, r.active_seconds_used, r.time_budget_seconds,
           t.target_summary, t.prompt task_prompt
    FROM learning_runs r
    LEFT JOIN learning_tasks t ON t.id = r.active_task_id
    WHERE r.workspace_id = ${scope.workspaceId} AND r.user_id = ${scope.userId}
      AND ${ACTIVE_RUN_PHASE_PREDICATE}
    ORDER BY r.updated_at DESC, r.id LIMIT 1
  `);
  const runRow = runRows[0];

  const dueRows = await tx.execute<{ n: string }>(sql`
    SELECT count(*) n FROM review_schedules
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND status = 'pending' AND next_review_at <= now()
      AND (user_deferred_until IS NULL OR user_deferred_until <= now())
  `);

  // 今日学习量：按**用户本地日**切，不按 UTC 日——否则早上看到的"今日"是昨天下午。
  const todayRows = await tx.execute<{ seconds: string; runs: string }>(sql`
    SELECT coalesce(sum(active_seconds_used), 0) seconds, count(DISTINCT run_id) runs
    FROM learning_metric_events
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND occurred_at >= date_trunc('day', now() AT TIME ZONE ${tzSubquery(scope.userId)}) AT TIME ZONE ${tzSubquery(scope.userId)}
  `);

  const noteCountRows = await tx.execute<{ n: string }>(sql`
    SELECT count(*) n FROM notes
    WHERE workspace_id = ${scope.workspaceId} AND deleted_at IS NULL
  `);
  const noteRows = await tx.execute<{ title: string; age_minutes: string }>(sql`
    SELECT title, EXTRACT(EPOCH FROM (now() - updated_at)) / 60 age_minutes
    FROM notes
    WHERE workspace_id = ${scope.workspaceId} AND deleted_at IS NULL
    ORDER BY updated_at DESC LIMIT 3
  `);

  const proposalRows = await tx.execute<{ n: string }>(sql`
    SELECT count(*) n FROM companion_action_proposals
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId} AND status = 'pending'
  `);

  const reminderRows = await tx.execute<{ text: string; fire_at_local: string }>(sql`
    SELECT text,
           to_char(fire_at AT TIME ZONE ${tzSubquery(scope.userId)}, 'MM-DD HH24:MI') AS fire_at_local
    FROM companion_reminders
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND status = 'pending'
    ORDER BY fire_at
    LIMIT 1
  `);

  return {
    localTime: clock?.local_time ?? "",
    weekday: weekdayLabel(clock?.weekday ?? 1),
    partOfDay: partOfDay(Number(clock?.hour_of_day ?? 12)),
    minutesSinceLastSeen: gapMinutes,
    pet: petRow
      ? { name: petRow.name, activeness: petRow.activeness, interactionCount: Number(petRow.interaction_count) }
      : null,
    activeRun: runRow
      ? {
        topic: runRow.target_summary,
        phase: runRow.phase,
        usedSeconds: Number(runRow.active_seconds_used),
        budgetSeconds: runRow.time_budget_seconds == null ? null : Number(runRow.time_budget_seconds),
        taskPrompt: runRow.task_prompt,
      }
      : null,
    dueReviews: Number(dueRows[0]?.n ?? 0),
    today: {
      studySeconds: Number(todayRows[0]?.seconds ?? 0),
      runs: Number(todayRows[0]?.runs ?? 0),
    },
    recentNotes: noteRows.map((row) => ({ title: row.title, ageLabel: ageLabel(Number(row.age_minutes)) })),
    noteCount: Number(noteCountRows[0]?.n ?? 0),
    pendingProposals: Number(proposalRows[0]?.n ?? 0),
    nextReminder: reminderRows[0]
      ? { text: reminderRows[0].text, fireAtLocal: reminderRows[0].fire_at_local }
      : null,
    currentPage: await resolveCurrentPage(tx, scope),
  };
}

/** 页面类型的中文说法；`other`/`home` 不渲染（见 resolveCurrentPage）。 */
const PAGE_KIND_LABELS: Record<string, string> = {
  note: "笔记",
  card: "学习卡",
  source: "资料",
  review: "复习页",
  star_map: "知识图谱",
  learning_run: "学习运行",
  today: "今日页",
  settings: "设置页",
  conversation: "对话",
};

/**
 * 本轮她面对的是哪个界面（抱怨 #5「看不到我当前界面」）。
 *
 * `pageKind` 为 `other`/`home`（实测占多数——人 idle 在首页）时返回 null：
 * 注入"用户正在看：首页"对模型是纯噪音，她只会围绕"你在首页"找话。
 * 实体级页面才查标题——只说"用户在笔记页"帮不了她，说得出是哪篇才算知道。
 */
async function resolveCurrentPage(
  tx: WorkerTransaction,
  scope: { workspaceId: string; pageContext?: unknown },
): Promise<{ kind: string; title: string | null } | null> {
  const context = parsePageContext(scope.pageContext);
  const pageKind = typeof context?.pageKind === "string" ? context.pageKind : null;
  if (!pageKind || pageKind === "other" || pageKind === "home") return null;
  const refs = Array.isArray(context?.entityRefs)
    ? (context.entityRefs as unknown[]).filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
    )
    : [];
  const label = PAGE_KIND_LABELS[pageKind] ?? pageKind;
  const noteRef = refs.find((entry) => typeof entry.noteId === "string");
  const cardRef = refs.find((entry) => typeof entry.cardId === "string");
  if (noteRef) {
    const rows = await tx.execute<{ title: string }>(sql`
      SELECT title FROM notes
      WHERE id = ${String(noteRef.noteId)}::uuid
        AND workspace_id = ${scope.workspaceId}
        AND deleted_at IS NULL
      LIMIT 1
    `);
    return { kind: label, title: rows[0]?.title ?? null };
  }
  if (cardRef) {
    const rows = await tx.execute<{ cue: string | null }>(sql`
      SELECT front->>'cue' AS cue FROM learning_cards_v2
      WHERE card_id = ${String(cardRef.cardId)}
        AND workspace_id = ${scope.workspaceId}
      LIMIT 1
    `);
    return { kind: label, title: rows[0]?.cue ?? null };
  }
  return { kind: label, title: null };
}


/**
 * 账号级时区的标量子查询；quiet_hours 缺字段时回落。
 *
 * 导出给提醒兑现/挂钟换算用（companion-agent-runtime）：她说"现在几点"、静默时段
 * 判定、"明早九点"换 UTC 必须是同一个钟，各写一处迟早会分裂成差八小时。
 */
export function tzSubquery(userId: string) {
  return sql`coalesce(
    (SELECT quiet_hours->>'timezone' FROM user_companion_account_state
      WHERE user_id = ${userId} LIMIT 1),
    ${FALLBACK_TIMEZONE})`;
}

/**
 * 渲染成注入 system prompt 的数据块。
 *
 * 只写**有值的行**：空行（"当前学习：无"）对模型是负价值——它会开始围绕"没有"
 * 编话题。整块控制在几十字符内，这段每轮都发，长度直接乘在每一次调用上。
 */
export function renderHereAndNow(snapshot: HereAndNowSnapshot): string | null {
  const lines: string[] = [];
  lines.push(`现在：${snapshot.localTime} ${snapshot.weekday}（${snapshot.partOfDay}）`);

  if (snapshot.minutesSinceLastSeen != null && snapshot.minutesSinceLastSeen >= 20) {
    lines.push(`距上次和用户说话：${ageLabel(snapshot.minutesSinceLastSeen)}`);
  }
  if (snapshot.pet) {
    lines.push(`你是「${snapshot.pet.name}」，累计互动 ${snapshot.pet.interactionCount} 次`);
  }
  if (snapshot.activeRun) {
    const run = snapshot.activeRun;
    const minutes = Math.round(run.usedSeconds / 60);
    // "已学 0 分钟"是噪音：刚开始的运行只需要说在学什么，别说学了多久。
    const spent = minutes > 0 ? `，已学 ${minutes} 分钟` : "";
    const budget = run.budgetSeconds ? `${minutes > 0 ? " / 计划" : "，计划"} ${Math.round(run.budgetSeconds / 60)} 分钟` : "";
    const task = run.taskPrompt ? `，正在做：${truncate(run.taskPrompt, 60)}` : "";
    lines.push(`用户正在学习${run.topic ? `「${truncate(run.topic, 30)}」` : ""}${spent}${budget}${task}`);
  }
  const todayMinutes = Math.round(snapshot.today.studySeconds / 60);
  if (todayMinutes > 0 || snapshot.today.runs > 0 || snapshot.dueReviews > 0) {
    const parts: string[] = [];
    if (todayMinutes > 0) parts.push(`今日已学 ${todayMinutes} 分钟`);
    if (snapshot.today.runs > 0) parts.push(`${snapshot.today.runs} 个学习运行`);
    if (snapshot.dueReviews > 0) parts.push(`到期待复习 ${snapshot.dueReviews} 项`);
    lines.push(parts.join("，"));
  }
  if (snapshot.recentNotes.length > 0) {
    const listed = snapshot.recentNotes.map((note) => `《${truncate(note.title, 20)}》(${note.ageLabel})`).join("、");
    lines.push(`最近笔记：${listed}；笔记库共 ${snapshot.noteCount} 篇`);
  }
  if (snapshot.pendingProposals > 0) {
    lines.push(`还有 ${snapshot.pendingProposals} 个动作在等用户确认`);
  }
  if (snapshot.currentPage) {
    const page = snapshot.currentPage;
    lines.push(`用户正在看${page.kind}${page.title ? `《${truncate(page.title, 24)}》` : ""}`);
  }
  if (snapshot.nextReminder) {
    lines.push(`你已经答应：${snapshot.nextReminder.fireAtLocal} 提醒用户「${truncate(snapshot.nextReminder.text, 30)}」`);
  }
  if (lines.length <= 1) return null;
  return ["<here_and_now>", ...lines, "</here_and_now>"].join("\n");
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}
