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
import { normalizeWorkspaceAIPolicy } from "../lib/governance.ts";
import { noteSearchTerms, parsePageContext } from "./companion-dialogue-content.ts";

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
  /**
   * 用户这句话里点名的那篇笔记（《标题》形态）到底存不存在。见
   * `extractNoteTitleReference` 的实测理由：这是**假阴性**的源头闸。
   *
   * `imageCount` 顺带在这里给出，理由与"存不存在"同一条：**不该由她决定去不去查**。
   * 实机 2026-09-21 她零工具就说"这篇正文读完了，里面没有截图"，而那篇挂着 6 张图——
   * 因为图不在 `note_blocks` 里，她照实读完正文仍会推出"没有图"这个假阴性。
   */
  noteReference: {
    title: string; found: boolean; noteId: string | null; ageLabel: string | null;
    imageCount: number; opening: string | null;
  } | null;
  /** 图片外发政策是否开着（决定"有图但看不了"这句话怎么说）。 */
  imagesReadable: boolean;
  /**
   * 学习统计真值——**只在用户这一轮问到学习数据时**才非空。
   *
   * 实机 2026-09-22 场景 B/N：她先说"今天 50 分钟啦，本周累计 107 分钟"（那是昨天
   * 说过的数，今天已经跨日），再调工具查出 33/154，然后在**同一条消息里**改口。
   * 事后闸救不了：话是流式说出口的。所以和图数、笔记存在性同一个解法——
   * 服务端在她开口之前把真值算好放进她的感知里。
   *
   * 没问就是 null：把统计常驻注入正是 §9.60 撤掉的东西，不能从这里绕回来。
   */
  learningStats: LearningStatsFacts | null;
  /**
   * 当前生效的行为边界——**只在用户这一轮要改边界时**才非空。
   * 理由同 `learningStats`：她得先知道现在是什么状态，才谈得上"帮你改掉了"。
   */
  boundaryFacts: BoundaryFacts | null;
}

/** 学习统计的一份真值。取数与摘要都只有这一处，工具与环境块共用。 */
export interface LearningStatsFacts {
  readonly todayMinutes: number;
  readonly weekMinutes: number;
  readonly dueReviews: number;
  readonly dueNext24Hours: number;
  readonly activeCards: number;
  readonly noteCount: number;
}

/** 工具返回给模型的 safeSummary 与环境块那一行共用同一句措辞（两处各写迟早会分叉）。 */
export function summarizeLearningStats(facts: LearningStatsFacts): string {
  return `今日 ${facts.todayMinutes} 分钟，本周 ${facts.weekMinutes} 分钟，到期复习 ${facts.dueReviews} 项`;
}

/**
 * 用户这句话在要学习数据吗。
 *
 * **判得保守是设计的一部分**：漏了的代价只是她自己再调一次工具（今天就是这样，
 * 多花一步而已）；误判的代价是把"没问也报数"重新请回来——那是 §9.60 刚赶出去的缺陷，
 * 而且这次是系统自己递上去的数字，她不可能不说。
 */
const LEARNING_STATS_ASK_PATTERNS = [
  // "我今天一共学了多久" / "这周总共学了多长时间"
  "(今天|今日|这周|本周|这个星期|最近|这一阵)[^。！？]{0,12}(学|复习|读)[^。！？]{0,6}(多久|多长时间|多少|几分钟|几小时)",
  // "有多少张活跃卡片、多少篇笔记" / "多少个东西到期该复习"
  "(多少|几个|几张|几篇|还剩)[^。！？]{0,6}(分钟|小时|张|篇|项|条|题)",
  "多少[^。！？]{0,4}(到期|复习)",
  // "最近的学习进度怎么样"
  "(学习|进度|统计)[^。！？]{0,4}(情况|数据|怎么样|如何)",
];
const LEARNING_STATS_ASK_TEST = new RegExp(LEARNING_STATS_ASK_PATTERNS.join("|"));

export function asksForLearningStats(text: string | undefined): boolean {
  return typeof text === "string" && LEARNING_STATS_ASK_TEST.test(text);
}

/**
 * 用户这一轮要改她的行为边界吗（催不催学习、玩趣、语音情绪标签、口头禅）。
 *
 * 为什么要在这里预取当前状态：实机 2026-09-22 场景 T，用户说「以后别主动催我复习」，
 * 她回"嗯，这条早就设好了喵"——而库里 `allowNudgeLearning` 还是 true。
 * 她不是故意骗人，是**不知道自己现在是什么状态**，于是把"应下来"当成了"已经改好"。
 * 同 §9.30/§9.67：服务端一行 SELECT 就知道的事，不该留给模型猜。
 */
const BOUNDARY_CHANGE_PATTERNS = [
  "别催|不要催|不准催|别提醒|不要提醒",
  "以后[^。！？]{0,8}(别|不要|不准)",
  "口头禅",
  "(玩趣|语气|情绪标签|语音标签)[^。！？]{0,6}(关掉|关闭|开|去掉|别)",
  "(关掉|改成|设为|设置成)[^。！？]{0,8}(玩趣|催|提醒|标签)",
];
const BOUNDARY_CHANGE_TEST = new RegExp(BOUNDARY_CHANGE_PATTERNS.join("|"));

export function asksForBoundaryChange(text: string | undefined): boolean {
  return typeof text === "string" && BOUNDARY_CHANGE_TEST.test(text);
}

/** 当前生效的行为边界（只有用户这一轮要改时才取）。 */
export interface BoundaryFacts {
  readonly allowNudgeLearning: boolean;
  readonly allowPlayful: boolean;
  readonly allowVoiceTags: boolean;
}

interface LearningStatsRow extends Record<string, unknown> {
  today_seconds: string;
  week_seconds: string;
  due_reviews: string;
  due_next_24h: string;
  active_cards: string;
  note_count: string;
}

/**
 * 学习统计的唯一取数（`companion_get_learning_stats` 与环境块共用）。
 *
 * 以前这段 SQL 只长在工具那侧，环境块想要同一份数就得再抄一遍——而"两处各写一份
 * 同一个口径"正是这一串修复一直在拆的东西（日额度写过四份、静默时段写过两份）。
 * 周口径是**滚动 7 天**，不是自然周：改了这里，工具答话和环境块会一起变，
 * 这也正是共用一份的意义。
 */
export async function readLearningStats(
  tx: WorkerTransaction,
  scope: { workspaceId: string; userId: string },
): Promise<LearningStatsFacts> {
  const rows = await tx.execute<LearningStatsRow>(sql`
    SELECT
      (SELECT coalesce(sum(active_seconds_used), 0) FROM learning_metric_events
        WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
          AND occurred_at >= date_trunc('day', now() AT TIME ZONE ${tzSubquery(scope.userId)}) AT TIME ZONE ${tzSubquery(scope.userId)}
      ) AS today_seconds,
      (SELECT coalesce(sum(active_seconds_used), 0) FROM learning_metric_events
        WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
          AND occurred_at > now() - interval '7 days'
      ) AS week_seconds,
      (SELECT count(*) FROM review_schedules
        WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
          AND status = 'pending' AND next_review_at <= now()
          AND (user_deferred_until IS NULL OR user_deferred_until <= now())
      ) AS due_reviews,
      (SELECT count(*) FROM review_schedules
        WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
          AND status = 'pending'
          AND coalesce(user_deferred_until, next_review_at) > now()
          AND coalesce(user_deferred_until, next_review_at) <= now() + interval '24 hours'
      ) AS due_next_24h,
      (SELECT count(*) FROM learning_cards_v2
        WHERE workspace_id = ${scope.workspaceId} AND lifecycle = 'active'
      ) AS active_cards,
      (SELECT count(*) FROM notes
        WHERE workspace_id = ${scope.workspaceId} AND deleted_at IS NULL
      ) AS note_count
  `);
  const row = (Array.isArray(rows) ? rows : [])[0] ?? null;
  return {
    todayMinutes: Math.round(Number(row?.today_seconds ?? 0) / 60),
    weekMinutes: Math.round(Number(row?.week_seconds ?? 0) / 60),
    dueReviews: Number(row?.due_reviews ?? 0),
    dueNext24Hours: Number(row?.due_next_24h ?? 0),
    activeCards: Number(row?.active_cards ?? 0),
    noteCount: Number(row?.note_count ?? 0),
  };
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

/**
 * 用户这句话点名的那篇笔记（《标题》形态，取第一个）。
 *
 * 为什么"有没有这篇"要在读阶段就算出来（方案 29 §9.29，实机五轮）：主模型面对
 * "《X》写了什么"会**不查而答**，并且给出可证伪的假阴性——"都搜过了，库里没有这篇"
 * （而那篇在库里，3 个正文块）。同一句 prompt 指名道姓要求它调用
 * `companion_search_notes` 仍然不动；被 steer 换到兜底模型之后才真的去调。
 * 也就是说"要不要查"不能交给它决定：这里先把结果当数据给它，
 * 她只需要负责读和说。
 */
export function extractNoteTitleReference(userText: string): string | null {
  const title = userText.match(/《([^》\n]{1,30})》/)?.[1]?.trim();
  return title ? title : null;
}

export async function loadHereAndNow(
  tx: WorkerTransaction,
  scope: {
    workspaceId: string;
    userId: string;
    conversationId?: string | null;
    /** 本轮 Bridge page context（对象或 JSON 字符串）；缺省就没有"当前界面"这一行。 */
    pageContext?: unknown;
    /** 用户当下这句话：只用来识别《某篇》形态，见 `extractNoteTitleReference`。 */
    userText?: string;
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
    boundaries: Record<string, unknown> | null;
  }>(sql`
    SELECT name, activeness, interaction_count, last_active_at, boundaries
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

  // 用户点名的那篇笔记。`ILIKE '%标题%'` 而不是 `ILIKE '标题'`——不带百分号的
  // ILIKE 是全等比较（记忆检索的 keyword 降级路径踩过同一个坑）。
  //
  // 但**整串子串**仍然会假阴性：人写《欧姆定律 生成验收》中间一个空格，库里那篇
  // 叫《欧姆定律生成验收》就匹配不上（实机 2026-09-22 检索工具踩过同一处，见 §12.3）。
  // 这里的后果比工具更重：这一行决定她开口时手上有没有这篇，匹配不上她就理直气壮地
  // 说"库里没有这篇"——那是最坏的一种错（可证伪的假阴性）。所以按空格切成词，逐词都要命中。
  const noteRefTitle = scope.userText ? extractNoteTitleReference(scope.userText) : null;
  const noteRefTerms = noteRefTitle ? noteSearchTerms(noteRefTitle) : [];
  const noteRefTitleMatch = noteRefTerms.length === 0
    ? sql`n.title = ${noteRefTitle ?? ""}`
    : sql`${sql.join(noteRefTerms.map((term) => sql`n.title ILIKE ${`%${term}%`}`), sql` AND `)}`;
  const noteRefRows = noteRefTitle
    ? await tx.execute<{ id: string; title: string; age_minutes: string; image_count: string; opening: string | null }>(sql`
        SELECT n.id, n.title,
               EXTRACT(EPOCH FROM (now() - n.updated_at)) / 60 age_minutes,
               -- 首块的开头（按 ordinal，与 read_note 同一个顺序）：实机 2026-09-22 AC 轮，
               -- 她零工具交出一段"看着像原文"的课本话——那不是编错的物理，是编的出处。
               -- 真开头在这一行里，她就没有补的必要了（方案 29 §12.5 的 ①）。
               (SELECT nb.content FROM note_blocks nb
                 WHERE nb.version_id = n.current_version_id AND coalesce(nb.content, '') <> ''
                 ORDER BY nb.ordinal LIMIT 1) AS opening,
               -- 图挂在另一张表里，不在 note_blocks——所以她"把正文读完了"仍然看不见它们。
               (SELECT count(*) FROM note_image_assets a
                 WHERE a.workspace_id = n.workspace_id
                   AND a.uploaded_for_note_id = n.id
                   AND a.status = 'ready' AND a.deleted_at IS NULL) AS image_count
        FROM notes n
        WHERE n.workspace_id = ${scope.workspaceId} AND n.deleted_at IS NULL
          AND ${noteRefTitleMatch}
        ORDER BY (n.title = ${noteRefTitle}) DESC, n.updated_at DESC
        LIMIT 1
      `)
    : [];

  const reminderRows = await tx.execute<{ text: string; fire_at_local: string }>(sql`
    SELECT text,
           to_char(fire_at AT TIME ZONE ${tzSubquery(scope.userId)}, 'MM-DD HH24:MI') AS fire_at_local
    FROM companion_reminders
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND status = 'pending'
    ORDER BY fire_at
    LIMIT 1
  `);

  // 图片外发政策在这里也要读一份：注入进去的那句"这篇有 6 张图，看不了"必须与
  // **工具下发面**同源，否则会出现"告诉她看不了、却又把读图工具给她"或反过来。
  // 同源指同一个判定函数（`normalizeWorkspaceAIPolicy`）跑在同一张表的同一行上——
  // 读法不同（这里在既有读事务里一条 SELECT，那边从治理上下文取），口径相同。
  const policyRows = await tx.execute<{ data_policy: unknown }>(sql`
    SELECT data_policy FROM user_ai_settings WHERE user_id = ${scope.userId} LIMIT 1
  `);
  const imagesReadable = normalizeWorkspaceAIPolicy(
    // 没有这一行=没同意过，`normalizeWorkspaceAIPolicy` 自己会回落到 fail-closed 默认。
    policyRows[0]?.data_policy as Parameters<typeof normalizeWorkspaceAIPolicy>[0],
  ).sendImageContent === true;

  // 用户这一轮问到学习数据，就在她开口之前把真值算好（见 HereAndNowSnapshot.learningStats）。
  // 没问到就一次查询都不发——这条支路的开销必须是"问了才付"。
  const learningStats = asksForLearningStats(scope.userText)
    ? await readLearningStats(tx, scope)
    : null;
  // 边界缺省按"允许"读，与念头管线（`boundaries.allowNudgeLearning !== false`）同一口径：
  // 两处的默认值不一样时，"她以为关着/其实开着"这类分裂又会回来。
  const profileBoundaries = (petRow?.boundaries ?? {}) as Record<string, unknown>;
  const boundaryFacts = asksForBoundaryChange(scope.userText)
    ? {
      allowNudgeLearning: profileBoundaries.allowNudgeLearning !== false,
      allowPlayful: profileBoundaries.allowPlayful !== false,
      allowVoiceTags: profileBoundaries.allowVoiceTags !== false,
    }
    : null;

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
    noteReference: noteRefTitle
      ? (noteRefRows[0]
        ? {
          title: noteRefRows[0].title,
          found: true,
          noteId: noteRefRows[0].id,
          ageLabel: ageLabel(Number(noteRefRows[0].age_minutes)),
          imageCount: Number(noteRefRows[0].image_count ?? 0),
          opening: noteOpeningExcerpt(noteRefRows[0].opening),
        }
        : { title: noteRefTitle, found: false, noteId: null, ageLabel: null, imageCount: 0, opening: null })
      : null,
    imagesReadable,
    learningStats,
    boundaryFacts,
    nextReminder: reminderRows[0]
      ? { text: reminderRows[0].text, fireAtLocal: reminderRows[0].fire_at_local }
      : null,
    currentPage: await resolveCurrentPage(tx, scope),
  };
}

/** 页面类型的中文说法；`other`/`home` 不渲染（见 resolveCurrentPage）。 */
/**
 * 首块正文 → 注进环境快照的那一句"开头是…"。
 *
 * 只取到第一句、上限 120 字，并把换行压成空格：这一段的作用是**让她不必自己补原文**
 * （实机 2026-09-22 AC 轮她零工具交出一段课本话当"原文"），不是替她读完全篇——
 * 给得越多，越像可以照抄，而它不进历史、也不带块结构。
 */
export const NOTE_OPENING_MAX_CHARS = 120;

export function noteOpeningExcerpt(content: unknown): string | null {
  if (typeof content !== "string") return null;
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  const stop = flat.search(/[。！？!?；;]/);
  const firstSentence = stop >= 0 ? flat.slice(0, stop + 1) : flat;
  const clipped = firstSentence.length > NOTE_OPENING_MAX_CHARS
    ? `${firstSentence.slice(0, NOTE_OPENING_MAX_CHARS)}…`
    : firstSentence;
  return clipped.length > 0 ? clipped : null;
}

export const PAGE_KIND_LABELS: Record<string, string> = {
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
    lines.push(`你是「${snapshot.pet.name}」`);
  }
  if (snapshot.activeRun) {
    const run = snapshot.activeRun;
    // 进度条上的分钟数不在这里：她在学什么、正在做哪一步才是对话用得上的，
    // 而"已学 4 分钟"这种数用户低头就能看见，念出来就是报流水账。
    const task = run.taskPrompt ? `，正在做：${truncate(run.taskPrompt, 60)}` : "";
    lines.push(`用户正在学习${run.topic ? `「${truncate(run.topic, 30)}」` : ""}${task}`);
  }
  // 今日学了多久 / 跑了几个运行 / 笔记库共几篇**不再渲染**（实机 2026-09-21：用户只说
  // 了「嘿嘿」，她回"今天已经学了 42 分钟，本周累计 99 分钟"）。这块是她的感知，
  // 不是台词本；用户真问"我今天学了多久"时她走 companion_get_learning_stats，
  // 那条路实测通（同一口径）。
  //
  // 到期数**必须**留着：`claimsNothingDueAgainstFacts` 靠这一行识破
  // "到期列表是空的"那句假阴性（§9.41），撤了等于把闸拆掉。
  if (snapshot.dueReviews > 0) {
    lines.push(`到期待复习 ${snapshot.dueReviews} 项`);
  }
  if (snapshot.learningStats) {
    const stats = snapshot.learningStats;
    // 这一行是 §9.66 缺陷① 的解法：她以前先念历史里的旧数、再调工具、再在同一条
    // 消息里改口。真值必须在**她说之前**就在场，历史里的同类数字要被明确降级。
    lines.push(`用户这一轮问的是学习数据，以下是刚查出来的真值：今日 ${stats.todayMinutes} 分钟，`
      + `本周 ${stats.weekMinutes} 分钟，到期复习 ${stats.dueReviews} 项，`
      + `24 小时内到期 ${stats.dueNext24Hours} 项，活跃卡片 ${stats.activeCards} 张，笔记 ${stats.noteCount} 篇。`
      + "只用这一行的数字；历史对话里出现过的同类数字是更早的时刻，可能已经变了。");
  }
  if (snapshot.boundaryFacts) {
    const b = snapshot.boundaryFacts;
    const on = (value: boolean) => (value ? "开着" : "关着");
    lines.push(`用户这一轮要改的是行为边界，当前生效的状态：催复习=${on(b.allowNudgeLearning)}，`
      + `玩趣=${on(b.allowPlayful)}，语音情绪标签=${on(b.allowVoiceTags)}。`
      + "这些开关只有调用 companion_set_boundary 才会变；光答\"记下了\"什么都没变。");
  }
  if (snapshot.recentNotes.length > 0) {
    const listed = snapshot.recentNotes.map((note) => `《${truncate(note.title, 20)}》(${note.ageLabel})`).join("、");
    lines.push(`最近笔记：${listed}`);
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
  if (snapshot.noteReference) {
    const ref = snapshot.noteReference;
    lines.push(ref.found
      ? `用户提到的《${truncate(ref.title, 24)}》在笔记库里，noteId=${ref.noteId}（${ref.ageLabel}写的）；要看正文就调用 companion_read_note 用这个 id。`
      // 没找到时**不把"它不存在"当结论交给她**——那正是实机里她零工具却脱口而出的假阴性。
      : `按标题没找到《${truncate(ref.title, 24)}》这篇笔记：标题可能记岔，或者它其实是一张卡片。先调用 companion_search_notes 换个关键词再查；查不到就照实说没查到，不要替笔记库下"没有这东西"的结论。`);
    // 只给开头一段，并点名"更长的原文还是要去读"：给全篇等于让她抄一个可能已经
    // 过期、也没进历史的版本，而那正是要修的东西。
    if (ref.found && ref.opening) {
      lines.push(`这篇的开头是：「${ref.opening}」（只到第一句为止；要更长的原文仍然要调用 companion_read_note 去读，不要照这段往下补。）`);
    }
    // 图的事实在这里给，而不是等她去猜：图片不是 note_blocks 的一部分，她把正文
    // 读三遍也看不到图，于是"我读完了，里面没有截图"听起来像诚实的回答（实机
    // 2026-09-21 就是这么一句假阴性）。
    if (ref.found && ref.imageCount > 0) {
      lines.push(snapshot.imagesReadable
        ? `这篇另有 ${ref.imageCount} 张图，图不在正文里。要看图里写了什么就调用 companion_read_image。`
        : `这篇另有 ${ref.imageCount} 张图，图不在正文里（正文没有图片标记不代表没有图）。`
          + "图片外发没开启，这些图你看不了：照实说看不了，并告诉用户设置里有个「允许发送图片内容」的开关。"
          + "不要说「我看看这张图」，也不要凭标题猜图里有什么。");
    }
  }
  if (lines.length <= 1) return null;
  return ["<here_and_now>", ...lines, "</here_and_now>"].join("\n");
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}
