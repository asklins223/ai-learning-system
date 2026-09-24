/**
 * 桌宠日记生成器（22-real-desktop-pet-memory-context-prd-tdd.md §15.4/§15.5）。
 *
 * 2026-09-21 重写：正文从确定性模板改成**她自己按人格写的第一人称日记**。
 * 起因是用户对旧产出的裁决——"这跟系统统计数据有什么区别？"旧实现是
 * `buildSummaryText()` 把 12 个 COUNT 拼成一句"…的学习小结：新增学习卡 4 张；…"，
 * 下面再挂一张数字表；那条链路上既没有模型，也没读过 `pet_profiles`。
 *
 * 现在的形状：
 *   1. 当天**具体发生过什么**（笔记标题、学了什么、她说过的话、说到做到的提醒）当素材；
 *   2. `pet_profiles` 的人格 + 活跃度决定语气与篇幅；
 *   3. 模型写正文，服务端按"不许报数"这道机器闸校验，不合规重采样一次；
 *   4. 写不出来就诚实留一行 failed 带成因，不返回任何看起来像日记的兜底文本。
 *
 * 两件事没变、也不能变：
 *   - `facts` 那 12 个计数继续写库（界面不再显示）。`companion-thought.ts` 读
 *     `facts->>'learningRunsCreated'/'learningRunsCompleted'` 算连续学习天数，
 *     少了它们主动念头会静默归零。
 *   - 派生记忆的 `source_event_id = 'daily-summary:<date>'` 与 ≤200 字上限，
 *     「查看关联记忆」按这个键找。存的是**事实备忘**（digest），不是日记正文：
 *     候选记忆一旦确认就每轮注入，把主观创作存成记忆等于让她把自己的情绪
 *     当成回忆引用——这个仓库已经吃过一次"她的谎自己长出引用"。
 */

import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  companionDailyBlockV1Schema,
  companionPersonaActivenessV1Schema,
  companionPersonaBoundariesV1Schema,
  readJobPayloadString,
} from "@ailearn/shared";
import { sourceImageUrlFromObjectKey } from "@ailearn/shared/source-image-contracts";
import { logger } from "../lib/logger.ts";
import { assertJobLease, lockJobLease, withJobTransaction } from "../lib/job-lease.ts";
import { createProvider, withThinkingDisabled } from "../lib/ai-provider.ts";
import {
  AIConsentRequiredError,
  AIDataPolicyDeniedError,
  AIProviderNotConfiguredError,
  createGovernedProvider,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../lib/governance.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import { companionDiaryTotal } from "../lib/metrics.ts";
import { DailyDiaryOutputError } from "../lib/non-retryable-errors.ts";
import { parseMemoryExtractJson } from "./companion-memory-extractor.ts";
import {
  PERSONA_SAFETY_GUARD,
  renderPersonaBehaviour,
  sanitizePersonaField,
} from "./companion-dialogue-content.ts";
import { PAGE_KIND_LABELS } from "./companion-here-and-now.ts";
import type { WorkerTransaction } from "../db.ts";
import type { JobPayload } from "./index.ts";

type CompanionPersonaActiveness = z.infer<typeof companionPersonaActivenessV1Schema>;
type CompanionPersonaBoundaries = z.infer<typeof companionPersonaBoundariesV1Schema>;

/** 界面与 DB 共用的失败成因词表（0250 的 CHECK 约束与它同一套取值）。 */
const diaryFailureReasonSchema = z.enum([
  "consent_required",
  "model_unavailable",
  "diary_output_invalid",
]);
type DiaryFailureReason = z.infer<typeof diaryFailureReasonSchema>;

interface DailyFacts {
  notesCreated: number;
  notesUpdated: number;
  cardsCreated: number;
  sourcesCreated: number;
  jobsCreated: number;
  jobsCompleted: number;
  learningRunsCreated: number;
  learningRunsCompleted: number;
  pageContexts: number;
  conversationMessages: number;
  userMessages: number;
  assistantMessages: number;
}

export interface DiaryPersona {
  name: string;
  personalityTags: string[];
  speakingStyle: string;
  examples: string[];
  activeness: CompanionPersonaActiveness | null;
  boundaries: CompanionPersonaBoundaries | null;
  familiarity: number;
}

/**
 * 她能嵌进日记的东西。
 *
 * 关键分工（沿用对话链路 §4.8 的规矩）：**服务端手里有真货，她只负责选**。
 * 图片 url、引用原文都由这里带着，她的输出里只有一个 `ref` 编号——
 * 她给不出一个指向站外的 img src，也就不用担心她把几百字原文改写一遍再"引用"。
 */
export type DiaryEmbed =
  // 没有 alt：我们不知道图里画的是什么（读图要外发字节，政策关着时读不到），
  // 编一段替代文字比不给更糟。渲染层本来就回落到图注（`alt ?? label`）。
  | { ref: string; kind: "image"; url: string; label: string }
  | { ref: string; kind: "quote"; label: string; text: string };

export interface DiaryMaterial {
  /**
   * 渲染成 `HH:MM · 你新建了笔记「…」` 的行。事件类在前、按当天时间先后；
   * 她自己的时段与可嵌清单附在后面——超预算时从**前面**丢，
   * 所以这两组不会被裁掉（正文点了编号却看不到那块内容，比少一段对话糟得多）。
   */
  lines: string[];
  /** 可嵌入的图与原文片段，`ref` 就是给她看的编号（图1 / 引1）。 */
  embeds: DiaryEmbed[];
  /** 前几天日记的开头，用来掐掉"每天同一句式"。 */
  previousOpenings: string[];
}

export type DiaryBlock = z.infer<typeof companionDailyBlockV1Schema>;

interface DiaryDraft {
  blocks: DiaryBlock[];
  digest: string;
}

interface DayScope {
  workspaceId: string;
  userId: string;
  date: string;
  timezone: string;
}

// ─── 素材 ────────────────────────────────────────────────────────────────

/**
 * 用户本地日的一半开区间。
 *
 * 必须写成 `${date}::date::timestamp AT TIME ZONE tz`，不能写 `${date}::date AT TIME ZONE tz`：
 * 后者在 Postgres 里先按**会话时区**把 date 变成 timestamptz，再折算成该时区的
 * **无时区 timestamp**，于是得到的是"UTC 零点在该地是几点"（上海 = 08:00），
 * 再和 timestamptz 列比较时又被按会话时区读回 UTC —— 整个窗口平移了一个时区差。
 * 实测（2026-09-21，dev 库 owner 账号）：`date AT TIME ZONE 'Asia/Shanghai'` 的返回
 * 类型是 `timestamp without time zone`，标着 09-20 的窗口实际盖住
 * 09-20 16:34–09-21 14:11 的本地钟点，也就是"昨天的日记"讲的是今天。
 * 这条平移从 `0171` 起就在；旧实现只拼统计句，看不出来。
 */
function dayStart(scope: DayScope) {
  return sql`${scope.date}::date::timestamp AT TIME ZONE ${scope.timezone}`;
}
function dayEnd(scope: DayScope) {
  return sql`(${scope.date}::date + 1)::timestamp AT TIME ZONE ${scope.timezone}`;
}
/** 本地钟点（HH24:MI）：她写日记用的是"晚上十点你说的那句"，不是 UTC 时间戳。 */
function clockOf(scope: DayScope, column: string) {
  return sql`to_char(${sql.raw(column)} AT TIME ZONE ${scope.timezone}, 'HH24:MI')`;
}

function slice(value: unknown, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * 当天 12 个计数。
 *
 * `sources` 与 `learning_cards_v2` 以前只按 workspace 过滤，把**别人**的收录算到
 * 这个人名下（`0243_companion_daily_summary_per_workspace.sql:16-20` 记的就是这笔债，
 * 当时只影响"要不要给他生成小结"，现在它还会进 prompt，所以必须收紧到人名下）。
 */
async function collectFacts(tx: WorkerTransaction, scope: DayScope): Promise<DailyFacts> {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    SELECT
      (SELECT count(*)::int FROM notes WHERE workspace_id = ${scope.workspaceId} AND created_by = ${scope.userId}
        AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}
        AND deleted_at IS NULL) AS notes_created,
      (SELECT count(*)::int FROM notes WHERE workspace_id = ${scope.workspaceId} AND created_by = ${scope.userId}
        AND updated_at >= ${dayStart(scope)} AND updated_at < ${dayEnd(scope)}
        AND deleted_at IS NULL) AS notes_updated,
      (SELECT count(*)::int FROM learning_cards_v2 c WHERE c.workspace_id = ${scope.workspaceId}
        AND c.created_at >= ${dayStart(scope)} AND c.created_at < ${dayEnd(scope)}
        AND c.note_version_id IN (SELECT nv.id FROM note_versions nv WHERE nv.created_by = ${scope.userId})) AS cards_created,
      (SELECT count(*)::int FROM sources WHERE workspace_id = ${scope.workspaceId} AND created_by = ${scope.userId}
        AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}) AS sources_created,
      (SELECT count(*)::int FROM jobs WHERE workspace_id = ${scope.workspaceId} AND requested_by = ${scope.userId}
        AND scheduled_at >= ${dayStart(scope)} AND scheduled_at < ${dayEnd(scope)}) AS jobs_created,
      (SELECT count(*)::int FROM jobs WHERE workspace_id = ${scope.workspaceId} AND requested_by = ${scope.userId}
        AND finished_at >= ${dayStart(scope)} AND finished_at < ${dayEnd(scope)}
        AND status = 'succeeded') AS jobs_completed,
      (SELECT count(*)::int FROM learning_runs WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}) AS learning_runs_created,
      (SELECT count(*)::int FROM learning_runs WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        AND updated_at >= ${dayStart(scope)} AND updated_at < ${dayEnd(scope)}
        AND phase = 'completed') AS learning_runs_completed,
      (SELECT count(DISTINCT page_kind)::int FROM assistant_page_contexts
        WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}) AS page_contexts,
      (SELECT count(*)::int FROM companion_messages
        WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}) AS conversation_messages,
      (SELECT count(*)::int FROM companion_messages
        WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId} AND role = 'user'
        AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}) AS user_messages,
      (SELECT count(*)::int FROM companion_messages
        WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId} AND role = 'assistant'
        AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}) AS assistant_messages
  `);
  const row = (Array.isArray(rows) ? rows : [])[0] ?? {};
  return {
    notesCreated: Number(row.notes_created ?? 0),
    notesUpdated: Number(row.notes_updated ?? 0),
    cardsCreated: Number(row.cards_created ?? 0),
    sourcesCreated: Number(row.sources_created ?? 0),
    jobsCreated: Number(row.jobs_created ?? 0),
    jobsCompleted: Number(row.jobs_completed ?? 0),
    learningRunsCreated: Number(row.learning_runs_created ?? 0),
    learningRunsCompleted: Number(row.learning_runs_completed ?? 0),
    pageContexts: Number(row.page_contexts ?? 0),
    conversationMessages: Number(row.conversation_messages ?? 0),
    userMessages: Number(row.user_messages ?? 0),
    assistantMessages: Number(row.assistant_messages ?? 0),
  };
}

/**
 * 她的人格。
 *
 * 取值收窄的口径与对话链路一致（`companion-dialogue.ts:303-338`）：库里可能是
 * null / 数组 / 任意对象，不认识的当"没设置"，绝不原样透进 prompt。
 * 白名单直接用共享契约，不再抄第三份。
 */
async function collectPersona(tx: WorkerTransaction, scope: DayScope): Promise<DiaryPersona> {
  const rows = await tx.execute<{
    name: string;
    speaking_style: string;
    personality_tags: unknown;
    examples: unknown;
    activeness: string | null;
    boundaries: unknown;
    familiarity: number | null;
  }>(sql`
    SELECT name, speaking_style, personality_tags, examples, activeness, boundaries, familiarity
    FROM pet_profiles
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
    LIMIT 1
  `);
  const row = (Array.isArray(rows) ? rows : [])[0];
  if (!row) {
    // 没有档案行 = 系统默认人格，界面上也叫「伴星」（pet-profile 路由此时
    // profile 与 activePreset 都是 null，UI 落到 "伴星"）。
    return {
      name: "伴星",
      personalityTags: [],
      speakingStyle: "",
      examples: [],
      activeness: null,
      boundaries: null,
      familiarity: 0,
    };
  }
  const activeness = companionPersonaActivenessV1Schema.safeParse(row.activeness);
  const boundaries = companionPersonaBoundariesV1Schema.safeParse(row.boundaries);
  return {
    name: row.name,
    personalityTags: Array.isArray(row.personality_tags) ? row.personality_tags.map(String) : [],
    speakingStyle: row.speaking_style,
    examples: Array.isArray(row.examples)
      ? (row.examples as Array<{ text?: unknown }>)
          .map((e) => slice(e.text, 200))
          .filter((text) => text.length > 0)
      : [],
    activeness: activeness.success ? activeness.data : null,
    boundaries: boundaries.success ? boundaries.data : null,
    familiarity: Number(row.familiarity ?? 0),
  };
}

/**
 * 当天具体发生过什么。
 *
 * 关键是给"事"而不是给"数"：数量是旧实现被嫌弃的根因。学习量只给一个模糊的
 * 时长感（半小时/一个来小时），让她有措辞的依据，又不会把日记写成报表。
 */
async function collectMaterial(tx: WorkerTransaction, scope: DayScope): Promise<DiaryMaterial> {
  const lines: string[] = [];

  const noteRows = await tx.execute<{
    at_local: string; title: string; created_today: boolean;
  }>(sql`
    SELECT ${clockOf(scope, "created_at")} AS at_local,
           left(title, 40) AS title,
           (created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}) AS created_today
    FROM notes
    WHERE workspace_id = ${scope.workspaceId} AND created_by = ${scope.userId}
      AND deleted_at IS NULL
      AND ((created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)})
        OR (updated_at >= ${dayStart(scope)} AND updated_at < ${dayEnd(scope)}))
    ORDER BY GREATEST(created_at, updated_at) ASC
    LIMIT 5
  `);
  for (const row of Array.isArray(noteRows) ? noteRows : []) {
    lines.push(`${row.at_local} · 你${row.created_today ? "新建" : "改"}了笔记「${row.title}」`);
  }

  const sourceRows = await tx.execute<{ at_local: string; title: string }>(sql`
    SELECT ${clockOf(scope, "created_at")} AS at_local, left(title, 40) AS title
    FROM sources
    WHERE workspace_id = ${scope.workspaceId} AND created_by = ${scope.userId}
      AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}
    ORDER BY created_at ASC
    LIMIT 4
  `);
  for (const row of Array.isArray(sourceRows) ? sourceRows : []) {
    lines.push(`${row.at_local} · 你收进来一份资料「${row.title}」`);
  }

  // 学了什么：走 learning_tasks.target_summary。
  // **不能**用 learning_runs.goal——那一列是枚举（stabilize|clarify|…），
  // 喂进去她会说出"你正在学习 stabilize"（companion-here-and-now.ts:37-43 踩过）。
  const runRows = await tx.execute<{
    at_local: string; what: string | null; phase: string;
  }>(sql`
    SELECT ${clockOf(scope, "r.created_at")} AS at_local,
           coalesce(nullif(t.target_summary, ''), nullif(t.prompt, '')) AS what,
           r.phase
    FROM learning_runs r
    LEFT JOIN learning_tasks t ON t.id = r.active_task_id
    WHERE r.workspace_id = ${scope.workspaceId} AND r.user_id = ${scope.userId}
      AND r.created_at >= ${dayStart(scope)} AND r.created_at < ${dayEnd(scope)}
    ORDER BY r.created_at ASC
    LIMIT 5
  `);
  for (const row of Array.isArray(runRows) ? runRows : []) {
    const what = slice(row.what, 60);
    if (!what) continue;
    lines.push(`${row.at_local} · 你坐下来学${row.phase === "completed" ? "完" : "了"}「${what}」`);
  }

  const secondsRows = await tx.execute<{ seconds: string }>(sql`
    SELECT coalesce(sum(active_seconds_used), 0) AS seconds
    FROM learning_metric_events
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND occurred_at >= ${dayStart(scope)} AND occurred_at < ${dayEnd(scope)}
  `);
  const minutes = Number((Array.isArray(secondsRows) ? secondsRows : [])[0]?.seconds ?? 0) / 60;
  const lengthSense = minutes < 10 ? "一小会儿" : minutes < 40 ? "半小时上下" : minutes < 90 ? "一个来小时" : "好几个小时";
  if (minutes >= 1) lines.push(`今天你学了${lengthSense}（这只是感觉，别在日记里报数）`);

  const pageRows = await tx.execute<{ page_kind: string }>(sql`
    SELECT DISTINCT page_kind
    FROM assistant_page_contexts
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND page_kind NOT IN ('other', 'home')
      AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}
    LIMIT 3
  `);
  const visited = (Array.isArray(pageRows) ? pageRows : [])
    .map((row) => PAGE_KIND_LABELS[row.page_kind] ?? row.page_kind)
    .filter((label) => label.length > 0);
  if (visited.length > 0) lines.push(`你去过这些地方：${visited.join("、")}`);

  const reminderRows = await tx.execute<{ at_local: string; text: string }>(sql`
    SELECT ${clockOf(scope, "fired_at")} AS at_local, left(text, 60) AS text
    FROM companion_reminders
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND status = 'fired'
      AND fired_at >= ${dayStart(scope)} AND fired_at < ${dayEnd(scope)}
    ORDER BY fired_at ASC
    LIMIT 3
  `);
  for (const row of Array.isArray(reminderRows) ? reminderRows : []) {
    lines.push(`${row.at_local} · 我提醒过你：${row.text}`);
  }

  const thoughtRows = await tx.execute<{ at_local: string; text: string }>(sql`
    SELECT ${clockOf(scope, "delivered_at")} AS at_local, left(text, 60) AS text
    FROM assistant_thoughts
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND status = 'delivered'
      AND delivered_at >= ${dayStart(scope)} AND delivered_at < ${dayEnd(scope)}
    ORDER BY delivered_at ASC
    LIMIT 3
  `);
  for (const row of Array.isArray(thoughtRows) ? thoughtRows : []) {
    lines.push(`${row.at_local} · 我主动开口说的是：${row.text}`);
  }

  const memoryRows = await tx.execute<{ content: string }>(sql`
    SELECT left(content, 60) AS content
    FROM assistant_memory_items
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND deleted_at IS NULL
      -- 排除本篇日记自己派生的那条，否则日记会引用自己。
      AND (source_event_id IS NULL OR source_event_id <> ${`daily-summary:${scope.date}`})
      AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}
    ORDER BY created_at DESC
    LIMIT 3
  `);
  for (const row of Array.isArray(memoryRows) ? memoryRows : []) {
    lines.push(`我记下来的：${row.content}`);
  }

  // 对话按**时间正序**给她（写日记要顺着当天走），但一天可能上百条：
  // 每个角色各留最近 12 条再还原时间序，比"取最后 24 条"更能留住上午那次认真的提问。
  const messageRows = await tx.execute<{ at_local: string; role: string; text: string }>(sql`
    WITH day AS (
      SELECT m.role,
             to_char(m.created_at AT TIME ZONE ${scope.timezone}, 'HH24:MI') AS at_local,
             coalesce((SELECT string_agg(b->>'text', '') FROM jsonb_array_elements(m.blocks) b
                        WHERE b->>'type' = 'text'), '') AS text,
             row_number() OVER (PARTITION BY m.role ORDER BY m.created_at DESC) AS recent_rank
      FROM companion_messages m
      WHERE m.workspace_id = ${scope.workspaceId} AND m.user_id = ${scope.userId}
        AND m.kind IN ('text', 'voice_transcript', 'proactive')
        AND m.created_at >= ${dayStart(scope)} AND m.created_at < ${dayEnd(scope)}
    )
    SELECT at_local, role, left(text, 120) AS text
    FROM day
    WHERE recent_rank <= 12 AND length(trim(text)) > 0
    ORDER BY at_local ASC
  `);
  for (const row of Array.isArray(messageRows) ? messageRows : []) {
    const who = row.role === "assistant" ? "我说" : "你说";
    lines.push(`${row.at_local} · ${who}：${row.text}`);
  }

  // 她一个人的时候在干什么——这是"有人味"的事实底座。
  // 没有这条，她只能写"今天陪了你多久"；有了空档，她才有一个属于自己的时间段可写。
  const rhythmRows = await tx.execute<{
    first_at: string | null; last_at: string | null; gap_label: number | null; gap_at: string | null;
  }>(sql`
    WITH msgs AS (
      SELECT created_at,
             lag(created_at) OVER (ORDER BY created_at) AS prev_at
      FROM companion_messages
      WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        AND created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)}
    ),
    -- 最长空档必须「整行取」。写成 to_char(max(prev_at)) 配
    -- ORDER BY max(created_at - prev_at) 时，没有 GROUP BY 的整表就是一组，
    -- 排序排不出第二行，拿到的是"最后一次对话的起点"而不是"最长空档的起点"。
    -- 实测 09-20：真起点 07:49（空 2 小时），旧写法报 22:59。
    -- 这是我们自己造出来的假时刻，比模型编的更难被发现——她只是照抄。
    longest_gap AS (
      SELECT prev_at, created_at - prev_at AS length
      FROM msgs
      WHERE prev_at IS NOT NULL
      ORDER BY created_at - prev_at DESC
      LIMIT 1
    )
    SELECT to_char((SELECT min(created_at) FROM msgs) AT TIME ZONE ${scope.timezone}, 'HH24:MI') AS first_at,
           to_char((SELECT max(created_at) FROM msgs) AT TIME ZONE ${scope.timezone}, 'HH24:MI') AS last_at,
           (SELECT to_char(prev_at AT TIME ZONE ${scope.timezone}, 'HH24:MI') FROM longest_gap) AS gap_at,
           (SELECT round(extract(epoch FROM length) / 3600)::int FROM longest_gap) AS gap_label
  `);
  const rhythm = (Array.isArray(rhythmRows) ? rhythmRows : [])[0];
  if (rhythm?.first_at && rhythm.last_at) {
    lines.push(`他第一次来找我是 ${rhythm.first_at}，最后一次是 ${rhythm.last_at}`);
    if (rhythm.gap_at && rhythm.gap_label !== null && rhythm.gap_label >= 2) {
      // 别说"中间"：空档未必在中间（实测 09-20 那段是从 07:49 起，紧挨着当天开头），
      // 她会把这个词原样抄进日记，变成一个我给的假位置。
      lines.push(`从 ${rhythm.gap_at} 起有一阵他不在，那段时间是我自己的`);
    }
  }

  // 可嵌进去的东西：当天碰过的笔记里的图与原文片段。
  // 上限是**天花板不是配额**（用户原话："想写就写，不想写就不写"）：
  // 图最多 6 张、引用最多 4 段，她一篇日记里通常只会用到一两个。
  const embeds: DiaryEmbed[] = [];
  let imageRef = 0;
  let quoteRef = 0;
  const imageRows = await tx.execute<{
    object_key: string; width: number; height: number; note_title: string; position: string;
  }>(sql`
    WITH touched AS (
      SELECT id AS note_id, title FROM notes
      WHERE workspace_id = ${scope.workspaceId} AND created_by = ${scope.userId}
        AND deleted_at IS NULL
        AND ((created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)})
          OR (updated_at >= ${dayStart(scope)} AND updated_at < ${dayEnd(scope)}))
    ), numbered AS (
      SELECT a.object_key, a.width, a.height, t.title AS note_title,
             row_number() OVER (PARTITION BY t.note_id ORDER BY a.created_at) AS position
      FROM note_image_assets a
      JOIN touched t ON t.note_id = a.uploaded_for_note_id
      WHERE a.workspace_id = ${scope.workspaceId} AND a.status = 'ready' AND a.deleted_at IS NULL
    )
    SELECT object_key, width, height, note_title, position::text
    FROM numbered
    ORDER BY note_title, position
    LIMIT 6
  `);
  for (const row of Array.isArray(imageRows) ? imageRows : []) {
    const ref = `图${(imageRef += 1)}`;
    const label = `《${slice(row.note_title, 24)}》· 第 ${row.position} 张`.slice(0, 80);
    embeds.push({
      ref,
      kind: "image",
      url: sourceImageUrlFromObjectKey(row.object_key),
      label,
    });
  }

  const quoteRows = await tx.execute<{ content: string; note_title: string }>(sql`
    WITH touched AS (
      SELECT id AS note_id, title, current_version_id FROM notes
      WHERE workspace_id = ${scope.workspaceId} AND created_by = ${scope.userId}
        AND deleted_at IS NULL
        AND ((created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)})
          OR (updated_at >= ${dayStart(scope)} AND updated_at < ${dayEnd(scope)}))
    )
    SELECT left(b.content, 200) AS content, t.title AS note_title
    FROM note_blocks b
    JOIN touched t ON t.current_version_id = b.version_id
    WHERE b.workspace_id = ${scope.workspaceId}
      AND b.type IN ('quote', 'paragraph')
      AND length(trim(b.content)) BETWEEN 12 AND 400
    -- 按**长度**给，不按正文顺序：抓来的网页笔记开头往往是标题和推广行，
    -- 实测 09-18 前四条里两条是「👉 仓库地址 (记得Star🌟)：网页链接」这种，
    -- 她照单引用就把推广链接写进日记了。长的那几条才是她想引的东西。
    ORDER BY length(b.content) DESC, b.ordinal
    LIMIT 4
  `);
  for (const row of Array.isArray(quoteRows) ? quoteRows : []) {
    const text = slice(row.content, 200);
    if (!text) continue;
    const ref = `引${(quoteRef += 1)}`;
    const label = `《${slice(row.note_title, 24)}》里写着`.slice(0, 80);
    embeds.push({ ref, kind: "quote", label, text });
  }

  // 前几天的开头只认**有块的那些行**。
  // `blocks='[]'` 盖住两类：0250 之前那版拼统计句的行（把它当"你自己前几天的开头"
  // 喂回去，等于把刚请出去的数字从侧门再领进来），以及更早只存纯文本的行。
  // 后者是误伤——少一条可参照的开头而已，规则 8 的目的（别沿用同一句式）
  // 有一条就够用了，而新写的日子会自己把这份清单填起来。
  // 不用 `summary NOT LIKE '%的学习小结：%'` 那种写法去精确只排前者：
  // 那等于把已删除模板的字面量永久留在代码里。
  const openingRows = await tx.execute<{ opening: string }>(sql`
    SELECT left(summary, 24) AS opening
    FROM companion_daily_summaries
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND date < ${scope.date} AND status = 'generated' AND summary <> ''
      AND blocks <> '[]'::jsonb
    ORDER BY date DESC
    LIMIT 3
  `);

  return {
    lines,
    embeds,
    previousOpenings: (Array.isArray(openingRows) ? openingRows : []).map((r) => r.opening),
  };
}

// ─── prompt 与输出校验 ───────────────────────────────────────────────────

/** 素材块的字预算：超了从**前面**丢，保留接近当天结束的部分（日记的落点在那里）。 */
const MATERIAL_BUDGET_CHARS = 3200;

function fitMaterial(lines: string[]): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    used += lines[i].length + 1;
    if (used > MATERIAL_BUDGET_CHARS) break;
    kept.unshift(lines[i]);
  }
  return kept.join("\n");
}

/**
 * 报数检测：日记正文里出现"数字 + 量词"就是流水账。
 *
 * 比记忆链路那道 `isVolatileStatisticMemory` 更严——那道还要求句中带
 * 本周/今天这类时间窗，而日记天天在说今天，窗口条件是白给的。
 * 也不至于误伤标题：「100 以内加法」「F=ma」后面没跟量词。
 */
const COUNTING_TONE_TEST = /\d+(?:\.\d+)?\s*(?:分钟|小时|张|篇|项|题|次|条|个|页|%)/;

export function countingToneIn(text: string): string | null {
  const hit = COUNTING_TONE_TEST.exec(text);
  return hit ? hit[0] : null;
}

/**
 * 篇幅档位：按**段**算。
 *
 * 第一版按句数收（安静 5 句），用户回来说"太短了有些，而且只有一段，
 * 这不是日记的格式"。日记的样子是一段一段往下走，不是一坨话——所以档位
 * 从"几句"换成"几段"，每段内部不再限句数（那才是流水账味道的来源）。
 */
const DIARY_LENGTH_TIER: Record<CompanionPersonaActiveness, { paragraphs: number; word: string; line: string }> = {
  quiet: { paragraphs: 2, word: "安静", line: "两段，每段三到六句。写不满就短，一天只有一件小事就只写那一件。" },
  moderate: { paragraphs: 3, word: "适度", line: "两到三段，每段三到七句。" },
  active: { paragraphs: 4, word: "活跃", line: "三到四段，可以长一些，把你自己的念头也写进去。" },
};

function tierOf(activeness: CompanionPersonaActiveness | null) {
  return DIARY_LENGTH_TIER[activeness ?? "moderate"];
}

/** 一段正文 = 一个 text 块；图和引用块跟着它前面那段走，不单独计段。 */
export function diaryParagraphCount(blocks: DiaryBlock[]): number {
  return blocks.filter((block) => block.type === "text").length;
}

export function diaryLengthOverflow(
  blocks: DiaryBlock[],
  activeness: CompanionPersonaActiveness | null,
): string | null {
  const tier = tierOf(activeness);
  return diaryParagraphCount(blocks) <= tier.paragraphs
    ? null
    : `太长了。你是${tier.word}的人，这一篇${tier.line}段落之外不必再补一段感想收尾。`;
}

/**
 * 重采样一次后仍超长时，收在**段边界**上。
 *
 * 丢的是第 N 段之后的全部内容（含跟在后面的图/引用），所以不会留下半句话，
 * 也不会留下一张没有上下文说明的图。宁可短一段，也不让这一天没有日记。
 */
export function fitDiaryToParagraphBudget(
  blocks: DiaryBlock[],
  activeness: CompanionPersonaActiveness | null,
): DiaryBlock[] {
  const limit = tierOf(activeness).paragraphs;
  if (diaryParagraphCount(blocks) <= limit) return blocks;
  const kept: DiaryBlock[] = [];
  let paragraphs = 0;
  for (const block of blocks) {
    kept.push(block);
    if (block.type === "text" && (paragraphs += 1) >= limit) break;
  }
  return kept;
}

/**
 * 一段正文的上限。**schema 与压平必须用同一个数**：
 * 先前者写 1200、后者切 1000，一段 1100 字的正文会被静默从中间切断，
 * 而块合同（20000）不会喊——坏在句子里，坏得没有痕迹。
 */
const DIARY_PARAGRAPH_MAX_CHARS = 1_200;

/** 她能引用的东西只有素材里列过的那些编号。 */
const diaryBlockDraftSchema = z.strictObject({
  blocks: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string().min(1).max(DIARY_PARAGRAPH_MAX_CHARS) }).strict(),
    z.object({ type: z.literal("image"), ref: z.string().min(1).max(8) }).strict(),
    z.object({ type: z.literal("quote"), ref: z.string().min(1).max(8) }).strict(),
  ])).min(1).max(24),
  digest: z.string().max(80).default(""),
});

/** 一段正文里的空白压平（段与段之间的换行不在这一步——那是块与块之间的事）。 */
function flattenParagraph(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, DIARY_PARAGRAPH_MAX_CHARS);
}

/**
 * 单次调用的输出预算。
 *
 * 篇幅**由 prompt 按人格分档**（几段），不由这个数控制：maxTokens 是天花板不是目标。
 * 实测教训（2026-09-21 第一次真跑）：按活跃度给 quiet 只留 240 时，qwen3.8-flash
 * 连续 9 次返回空正文（3 次 job 重试 × provider 内部 3 次空输出重试），
 * 因为预算全花在思考 token 上——所以这里给一个够用的统一上限，
 * 并和另外两条伴星链路一样显式关闭思考模式。改成多段 + JSON 块之后又抬高了一次。
 */
export const DIARY_MAX_TOKENS = 1_400;

/**
 * 日记 prompt。
 *
 * 人格注入完全复用对话链路那三件（`<persona_data>` + 防护声明 + 把设定翻成
 * 可执行行为句），所以她在日记里的口气和在对话里的口气是同一个来源。
 * 基础人格 prompt（companion-persona.ts）不动：它被 SHA256 金样锁住，
 * 且讲的是"陪你说话"的规矩，不是"写日记"的规矩。
 */
export function buildDiaryPrompt(input: {
  date: string;
  persona: DiaryPersona;
  material: DiaryMaterial;
  /** 上一轮被服务端拒掉的原因（"你在报数"）；首轮为 null。 */
  rejection: string | null;
}): Array<{ role: "system" | "user"; content: string }> {
  const { persona } = input;
  const name = sanitizePersonaField(persona.name, 60) || "伴星";
  const tags = persona.personalityTags.slice(0, 8).map((t) => sanitizePersonaField(t, 20)).filter(Boolean);
  const speakingStyle = sanitizePersonaField(persona.speakingStyle, 500);
  const examples = persona.examples.slice(0, 5);
  const behaviour = renderPersonaBehaviour({ activeness: persona.activeness, boundaries: persona.boundaries });

  const personaBlock = [
    `<persona_data>`,
    `名字：${name}`,
    ...(tags.length > 0 ? [`性格标签：${tags.join("、")}`] : []),
    ...(speakingStyle ? [`说话风格：${speakingStyle}`] : []),
    ...(examples.length > 0 ? ["你平时这样说话：", ...examples.map((text) => `- ${text}`)] : []),
    `</persona_data>`,
  ].join("\n");

  // 篇幅只有一处真相：设定段、最后一条规则与服务端的核对共用这张表。
  const lengthTier = tierOf(persona.activeness);

  const system = [
    `你是「${name}」。现在是 ${input.date} 的深夜，你在写自己这一天的日记。`,
    "没有人会检查这篇日记，这也不是写给对方看的汇报。",
    "",
    "# 你是谁",
    personaBlock,
    PERSONA_SAFETY_GUARD,
    "",
    "# 你被设定成",
    ...(behaviour.length > 0 ? behaviour : ["（没有额外的边界设置。）"]),
    `今天这篇的篇幅：${lengthTier.line}`,
    `熟悉度 ${persona.familiarity.toFixed(2)}（0 刚认识，1 很熟）：还很生疏就别装亲密，刚认识的日子该写得客气一点。`,
    "",
    "# 你今天知道的（只有这些是真的）",
    "<day_material>",
    fitMaterial(input.material.lines) || "（这一天几乎没有留下动静。）",
    // 可嵌清单由 embeds 现生成、接在素材末尾：采集只负责给结构化数据，
    // 一份清单在两个地方各拼一遍，迟早会跟服务端那张 ref 表对不上。
    // 放在预算之外，正文点了编号却看不到那块内容是最糟的错配。
    ...input.material.embeds.map((embed) => embed.kind === "image"
      ? `${embed.ref} = ${embed.label}（图和图注由系统带，你只写编号）`
      : `${embed.ref} = ${embed.label}：「${embed.text}」（要引就点这个编号，原文由系统带，不要自己转抄）`),
    "</day_material>",
    "",
    "# 写法规则",
    "1. 第一人称「我」，称对方为「你」。分成几段往下写，像日记那样；不要写成一条汇报。",
    "2. 正文里不出现阿拉伯数字加量词的计数（几张、几条、多少分钟、一共），也不出现「统计」「汇总」这类词。",
    "   你记得的是事情和你自己的感觉，不是数量。",
    "3. 不要流水账：不许把 day_material 每一行都复述一遍。挑几件真正留下印子的，其余略过。",
    "4. **关于他的事**只许写 day_material 里有的。它没写的（他后来做了什么、心情如何、有没有回来）",
    "   一律不许编；不确定就写成不确定：「我不知道他后来有没有再翻那篇笔记」。",
    "5. **关于你自己的事可以按你的人设写**：素材里给了你来过的时刻和空着的时候，",
    "   那些空档里你在做什么、在想什么、在等什么，是你的一天，不是他的。",
    "   这部分不必讲学习——你可以写你自己。但别写成一整天都在等他，那不是你。",
    "6. 时间、标题、他说过的话可以直接用，那是你亲眼见的。但谁说的别记反：",
    "   素材里标「你说」的是他说的，标「我说」「我主动开口」「我提醒过你」的是你说的；",
    "   别把自己说过的话写成他让你做的事。",
    "7. 不许出现系统词：workspace、job、run、卡片 ID、页面、模型、生成、数据、统计。你不是程序。",
    "8. 不用 emoji，不用星号，不加标题，不分点，不写「亲爱的日记」这类开头，也不写结束语。",
    "9. 你能摆进日记的东西，已经在上面 day_material 里用编号列出来了（图N / 引N）。",
    "   想用就用，不想用就不想——这不是任务指标。要用时单独占一块，别把编号写进句子里。",
    "   图放在你说到它的那段后面；引用放在你提到那篇笔记的那段后面。",
    "10. 下面几行是你前几天日记的开头。今天不许沿用同样的开头、句式或情绪落点：",
    input.material.previousOpenings.length > 0
      ? input.material.previousOpenings.map((opening) => `   · ${opening}`).join("\n")
      : "   （这是你第一次写日记。）",
    // 篇幅放在最后一条：实测把规则写在中间的设定段里，同一人格会交回 15 句再交回 7 句
    // （2026-09-21 两次真跑）。规则离输出越近越容易被执行。
    `11. 全文最多 ${lengthTier.paragraphs} 段，说完就停，不要另起一段补感想收尾。`,
    "",
    "# 输出",
    "只输出 JSON：",
    "{\"blocks\":[{\"type\":\"text\",\"text\":\"一段正文\"},"
    + "{\"type\":\"image\",\"ref\":\"图1\"},"
    + "{\"type\":\"quote\",\"ref\":\"引1\"},"
    + "{\"type\":\"text\",\"text\":\"下一段正文\"}],"
    + "\"digest\":\"不超过 30 字，一句话记下今天真正发生了什么，不带数字\"}",
    "blocks 按你希望它们出现的顺序排；ref 只能用上面列过的编号。",
    "digest 是给自己的备忘，不是心情；blocks 是日记本身。",
    ...(input.rejection ? ["", `上一轮你交回来的东西被拒了：${input.rejection}`] : []),
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: "写今天这篇。" },
  ];
}

// ─── 编排 ────────────────────────────────────────────────────────────────

export function classifyDiaryFailure(err: unknown): DiaryFailureReason {
  if (err instanceof AIConsentRequiredError) return "consent_required";
  if (err instanceof AIDataPolicyDeniedError) return "consent_required";
  if (err instanceof AIProviderNotConfiguredError) return "consent_required";
  if (err instanceof DailyDiaryOutputError) return "diary_output_invalid";
  return "model_unavailable";
}

async function composeDiary(
  job: JobPayload,
  userId: string,
  date: string,
  persona: DiaryPersona,
  material: DiaryMaterial,
): Promise<DiaryDraft> {
  const govCtx = await resolveAIGovernanceContext(job.workspaceId, userId);
  if (!govCtx.consentOk) throw new AIConsentRequiredError();
  const textRes = resolveProviderForTask(govCtx, "companion_agent");
  const provider = createGovernedProvider(
    // 与伴星对话、念头生成同一口径：关掉思考模式。这三条都是整段取回的非流式调用。
    createProvider(textRes.providerName, withThinkingDisabled(textRes.providerConfig)),
    govCtx,
    job.workspaceId,
    { userId, operation: "companion_daily_diary", jobId: job.id, dataCategories: ["note_content"] },
  );

  let rejection: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const messages = buildDiaryPrompt({ date, persona, material, rejection });
    const result = await runWithAbortBudget(
      (signal) => provider.chatCompletion(
        messages,
        { temperature: 0.85, maxTokens: DIARY_MAX_TOKENS, responseFormat: "json_object" },
        signal,
      ),
      job.signal,
      resolveProviderCallTimeout("companion_daily_summary"),
      (lateError) => logger.warn({ jobId: job.id, err: lateError }, "diary provider settled late"),
    );
    const parsed = diaryBlockDraftSchema.safeParse(parseMemoryExtractJson(result.content));
    if (!parsed.success) {
      rejection = "要的是 {\"blocks\":[…],\"digest\":\"…\"} 这一个 JSON 对象，别的都不要输出。";
      continue;
    }
    const { blocks, droppedRefs } = resolveDiaryBlocks(parsed.data, material.embeds);
    const digest = flattenParagraph(parsed.data.digest);
    if (droppedRefs.length > 0) {
      // 她引用了一个不存在的编号：这块丢掉、正文照留，但必须喊出来——
      // 不然"日记里说的那张图呢"会变成一次无法复盘的投诉。
      logger.warn({ jobId: job.id, date, droppedRefs }, "companion diary referenced unknown embeds");
    }
    const prose = blocks.filter((block) => block.type === "text").map((block) => block.text).join(" ");
    if (prose.length < 24) {
      rejection = "正文太短，不像一篇日记。写一件今天真实发生过的事，再写你自己。";
      continue;
    }
    const counted = countingToneIn(prose);
    if (counted) {
      // 这就是用户嫌弃的那件东西：报数。重写一次，再犯就判失败（0250 的第三种成因）。
      // 只核正文：图注与引用原文里出现数字是真的，不该被她自己的规矩抹掉。
      rejection = `你在报数（${counted}）。重写，把数字全去掉。`;
      continue;
    }
    const tooLong = diaryLengthOverflow(blocks, persona.activeness);
    if (tooLong && attempt === 0) {
      rejection = tooLong;
      continue;
    }
    // 第二次还超长就收在段边界上：宁可短一段，也不让这一天没有日记。
    return {
      blocks: z.array(companionDailyBlockV1Schema).max(24).parse(fitDiaryToParagraphBudget(blocks, persona.activeness)),
      digest,
    };
  }
  throw new DailyDiaryOutputError("桌宠日记正文两次都不合规矩（报数 / 太短 / 输出不是 JSON）");
}

/**
 * 把她给的编号换成真正的块。
 *
 * 她只能给编号，图 url 与引用原文由服务端带——这是对话链路 §4.8 定下的分工，
 * 一个模型给不出的字段就不该出现在它的输出里（否则它会给一个站外地址当 img src）。
 * 编号不存在或重复用：丢掉那一块，正文照留。
 */
export function resolveDiaryBlocks(
  draft: z.infer<typeof diaryBlockDraftSchema>,
  embeds: DiaryEmbed[],
): { blocks: DiaryBlock[]; droppedRefs: string[] } {
  const byRef = new Map(embeds.map((embed) => [embed.ref, embed]));
  const used = new Set<string>();
  const blocks: DiaryBlock[] = [];
  const droppedRefs: string[] = [];
  for (const item of draft.blocks) {
    if (item.type === "text") {
      const text = flattenParagraph(item.text);
      if (text) blocks.push({ type: "text", text });
      continue;
    }
    const embed = byRef.get(item.ref.trim());
    if (!embed || used.has(embed.ref)) {
      droppedRefs.push(item.ref);
      continue;
    }
    used.add(embed.ref);
    blocks.push(embed.kind === "image"
      ? { type: "image", url: embed.url, label: embed.label }
      : { type: "quote", label: embed.label, text: embed.text });
  }
  return { blocks, droppedRefs };
}

export async function runCompanionDailySummary(job: JobPayload): Promise<void> {
  // 设计 P1-8（2026-09-15 审计）：字段名与读取走共享契约（@ailearn/shared 的
  // companion-memory-job-payload），改名时编译器会在所有调用点报错。
  const date = readJobPayloadString(job.payload, "date");
  const timezone = readJobPayloadString(job.payload, "timezone");
  const userId = readJobPayloadString(job.payload, "userId");
  if (!date || !timezone || !userId) {
    throw new Error("companion_daily_summary payload 缺 date/timezone/userId");
  }
  await assertJobLease(job);
  const scope: DayScope = { workspaceId: job.workspaceId, userId, date, timezone };

  // 素材与人格先拿：失败行也要写真实 facts，否则一个失败日会静默打断
  // companion-thought 的连续学习天数计算（旧实现写的是 '{}'::jsonb）。
  const { facts, persona, material } = await withJobTransaction(job, async (tx) => ({
    facts: await collectFacts(tx, scope),
    persona: await collectPersona(tx, scope),
    material: await collectMaterial(tx, scope),
  }));

  let draft: DiaryDraft;
  try {
    draft = await composeDiary(job, userId, date, persona, material);
  } catch (err) {
    const reason = classifyDiaryFailure(err);
    // 顺序是刻意的：**先记下真因，再试着写失败行**。
    // 那次写也可能失败（租约被抢、DB 抖动），让它抛出去就会把原始错误顶掉——
    // 日志里只剩一个"写失败行失败"，而真正的原因（没同意？模型空返回？）永远看不到。
    // 旧实现特意写了这条保护（"写入失败不应影响 job 重试流程"），改成 await 时被我弄丢过一次。
    logger.warn({ jobId: job.id, date, reason, err }, "companion diary generation failed");
    try {
      companionDiaryTotal.labels(reason).inc();
    } catch {
      // metrics 记录失败不阻断错误传播
    }
    try {
      await persistDiary(job, scope, facts, null, reason);
    } catch (persistErr) {
      logger.error({ jobId: job.id, date, err: persistErr }, "companion diary failure row not written");
    }
    throw err;
  }

  await persistDiary(job, scope, facts, draft, null);
  logger.info({ jobId: job.id, date, persona: persona.name }, "companion diary generated");
  try {
    companionDiaryTotal.labels("generated").inc();
  } catch {
    // metrics 记录失败不阻断
  }
}

async function persistDiary(
  job: JobPayload,
  scope: DayScope,
  facts: DailyFacts,
  draft: DiaryDraft | null,
  failureReason: DiaryFailureReason | null,
): Promise<void> {
  // §15.4.4：失败也落一行，页面据此显示"这一天她没能写下来"＋成因。
  // 写入失败不该盖掉真正的失败原因，所以调用方在 catch 里不再处理这里的异常。
  await withJobTransaction(job, async (tx) => {
    // LLM 调用发生在事务之外，中间可能已经跨过租约：提交前重新校验并续租，
    // 否则被 reap 之后另一个 worker 会重领同一 job、重复写也重复计费（同 summarizer 的 TOCTOU 围栏）。
    await lockJobLease(tx, job);
    // `blocks` 是展示面（0252）；`summary` 是它的纯文本投影，给"前几天开头"这类
    // 只要一句话的读法用，也保住 0252 之前那些只有文字的历史行。
    const paragraphs = draft
      ? draft.blocks.filter((block) => block.type === "text").map((block) => block.text)
      : [];
    await tx.execute(sql`
      INSERT INTO companion_daily_summaries
        (workspace_id, user_id, date, timezone, facts, blocks, summary, status, failure_reason, revision, generated_at, created_at, updated_at)
      VALUES
        (${scope.workspaceId}, ${scope.userId}, ${scope.date}, ${scope.timezone},
         ${JSON.stringify(facts)}::jsonb,
         ${JSON.stringify(draft ? draft.blocks : [])}::jsonb,
         ${paragraphs.join("\n\n")},
         ${draft ? "generated" : "failed"},
         ${failureReason},
         1, now(), now(), now())
      ON CONFLICT (workspace_id, user_id, date)
      DO UPDATE SET timezone = EXCLUDED.timezone, facts = EXCLUDED.facts,
                    blocks = EXCLUDED.blocks, summary = EXCLUDED.summary, status = EXCLUDED.status,
                    -- 先失败后成功的日子必须把原因清掉，否则界面上"没能写下来"和正文同时存在。
                    failure_reason = EXCLUDED.failure_reason,
                    revision = companion_daily_summaries.revision + 1,
                    generated_at = now(), updated_at = now()
    `);
    if (!draft) return;
    // §9.4：写入端即限制 ≤200 字，确保读取注入时不需截断、不丢失信息。
    // 存 digest（事实备忘）而不是 diary 正文：候选一旦被确认就每轮注入，
    // 让主观创作进记忆等于给她下一轮的引用提供一个"出处"。
    const memoryContent = `${scope.date} 桌宠日记：${draft.digest}`.slice(0, 200);
    if (countingToneIn(draft.digest) || draft.digest.length === 0) return;
    await tx.execute(sql`
      INSERT INTO assistant_memory_items
        (workspace_id, user_id, kind, content, source_event_id, user_stated, user_confirmed,
         candidate, importance, confidence, scope, source_type, embedding_status, created_at, updated_at)
      VALUES
        (${scope.workspaceId}, ${scope.userId}, 'learning_context', ${memoryContent},
         ${`daily-summary:${scope.date}`}, false, false, true, 0.5, 0.7, 'workspace', 'summary', 'pending', now(), now())
      ON CONFLICT (workspace_id, user_id, kind, source_event_id)
        WHERE deleted_at IS NULL AND source_event_id IS NOT NULL
      DO NOTHING
    `);
  });
}
