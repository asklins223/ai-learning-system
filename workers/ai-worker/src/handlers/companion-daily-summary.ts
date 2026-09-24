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
  COMPANION_VOICE_STYLE_LINES_V1,
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
  type AIGovernanceContext,
} from "../lib/governance.ts";
import { getObjectBytes } from "../lib/object-storage.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import { companionDiaryTotal } from "../lib/metrics.ts";
import { DailyDiaryOutputError } from "../lib/non-retryable-errors.ts";
import { parseMemoryExtractJson } from "./companion-memory-extractor.ts";
import {
  PERSONA_SAFETY_GUARD,
  renderPersonaBehaviour,
  sanitizePersonaField,
  stripProviderControlTokens,
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
  // 熟悉度不再进 prompt：那一句「刚认识该客气一点」正是"把设定念出来"的邀请
  //（实录「这种生疏感让我保持着一份客气的距离，既不过分热情，也不刻意冷淡」）。
  // 亲疏本来就写在人格与素材里，不需要她去朗读一个数字。
}

/**
 * 她能嵌进日记的东西。
 *
 * 关键分工（沿用对话链路 §4.8 的规矩）：**服务端手里有真货，她只负责选**。
 * 图片 url、引用原文都由这里带着，她的输出里只有一个 `ref` 编号——
 * 她给不出一个指向站外的 img src，也就不用担心她把几百字原文改写一遍再"引用"。
 */
/**
 * 一天里给她的图：**每篇笔记最多一张**。
 *
 * 09-24 第一次真跑：同一篇笔记的两张图被塞进两段里，第二段（讲复习的那段）
 * 跟那篇笔记一点关系都没有，两条图注还是同一个干饭梗——候选给了六张，
 * 她就当成配额在用。优先要有上下文的（`nearby` 有值 = 能写出具体的一句），
 * 同一篇里按正文顺序取最靠前的那张。
 */
export function pickImagesPerNote<T extends { note_id: string; position: string; nearby: string | null }>(
  rows: T[],
  max = 6,
): T[] {
  const byNote = new Map<string, T[]>();
  for (const row of rows) {
    const group = byNote.get(row.note_id);
    if (group) group.push(row);
    else byNote.set(row.note_id, [row]);
  }
  const picked: T[] = [];
  for (const group of byNote.values()) {
    const best = [...group].sort((a, b) => {
      const context = Number(b.nearby !== null) - Number(a.nearby !== null);
      if (context !== 0) return context;
      return Number(a.position) - Number(b.position);
    })[0];
    picked.push(best);
    if (picked.length >= max) break;
  }
  return picked;
}

export type DiaryEmbed =
  // 没有 alt：我们不知道图里画的是什么（读图要外发字节，政策关着时读不到），
  // 编一段替代文字比不给更糟。渲染层本来就回落到图注（`alt ?? label`）。
  // 图注由她在日记里自己写一句（2026-09-24）：机器拼的「· 第 1 张」是图录味的来源，
  // 而 `nearby`（这一张挨着的那段正文）是她能对着一张她看不见的图说出人话的唯一依据。
  // 2026-09-24 第二轮再加两样：`noteId`（让嵌入物跟着"线头"走）与
  // `description`（读图拿到的"图里画的是什么"，政策开着时才有）。
  | {
    ref: string; kind: "image"; url: string; noteTitle: string; noteId: string;
    nth: number; nearby: string | null; shape: string;
    objectKey: string; mimeType: string; byteSize: number;
    /** 读图结果；没读（政策关着/失败/太大）时是 null。 */
    description: string | null;
  }
  | { ref: string; kind: "quote"; label: string; text: string; noteId: string };

/**
 * 素材的一条。
 *
 * 2026-09-24 第二轮把 `lines: string[]` 换成带分组与权重的 pieces：用户裁定
 * 「日记的主角是她自己的日子」——之前素材是平铺的日志，她的原话和"他改了篇笔记"
 * 同权，模型自然写成"他的一天 + 我的感想"。分组之后，"她的一天"整块排在最前，
 * 他的动静退成背景，超预算时先丢背景。
 */
export interface DiaryPiece {
  text: string;
  /** her = 她自己的一天；his = 他做了什么；backdrop = 时刻、页面这类骨架。 */
  group: "her" | "his" | "backdrop";
  /** 4 = 她明确承认没弄懂/答好；3 = 她的话；2 = 她的念头；1 = 他的动作；0 = 骨架。 */
  weight: number;
  /** 本地钟点 HH:MM；没有时刻的素材用空串。渲染成"下午"这类时段词。 */
  at: string;
  /** 与某篇笔记有关时记下来——"线头"落在哪篇笔记，嵌入物就优先给那篇。 */
  noteId?: string;
}

export interface DiaryMaterial {
  /** 当天素材，按时间先后。渲染见 `renderMaterial`。 */
  pieces: DiaryPiece[];
  /** 这一天的线头（参见 `pickDiarySubject`）：只写一件小事时写它。 */
  subject: DiaryPiece | null;
  /** 可嵌入的图与原文片段，`ref` 就是给她看的编号（图1 / 引1）；线头那篇的排在最前。 */
  embeds: DiaryEmbed[];
  /** 前几天日记的开头，用来掐掉"每天同一句式"。 */
  previousOpenings: string[];
  /**
   * 这一天几乎没有留下动静（没有对话、没有笔记、没有学习）。
   *
   * 09-24 的实录：这种日子她会写两段纯情绪的散文（「像是等待某种确切的回应」
   * 「假装那里有你留下的温度」）——没有真事可写的时候，料只有情绪。
   * 判据只看**发生过的事**：只在页面上转过一圈不算。
   */
  quietDay: boolean;
  /** 成稿前收窄到一幕；渲染时按实际对话顺序说清是谁先说、谁回答。 */
  focused?: boolean;
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

/**
 * 本地钟点 → 时段词。
 *
 * 素材以前前缀着精确到分的 `HH:MM`（"14:05 · 你新建了笔记「…」"），她照着写出来的
 * 就是「下午两点多开始改那个无标题笔记，后来又在傍晚新建了一篇同名的」——一句
 * 把日志翻译成散文的话。人回忆自己的昨天用的是"下午""傍晚"，不是分钟。
 */
export function dayPartOf(at: string): string {
  const hour = Number(at.slice(0, 2));
  if (!Number.isFinite(hour)) return "";
  if (hour < 5) return "深夜";
  if (hour < 8) return "早上";
  if (hour < 11) return "上午";
  if (hour < 13) return "中午";
  if (hour < 17) return "下午";
  if (hour < 19) return "傍晚";
  if (hour < 23) return "晚上";
  return "深夜";
}

const CHINESE_HOURS = ["十二", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一"];

/** "20:14" → "晚上八点多"。只给节奏行用（"他第一次来找我是晚上八点多"）。 */
export function clockPhrase(at: string): string {
  const hour = Number(at.slice(0, 2));
  if (!Number.isFinite(hour)) return "";
  return `${dayPartOf(at)}${CHINESE_HOURS[hour % 12]}点多`;
}

/**
 * 这一天的线头：她明确卡壳 > 她自己说过的话 > 她的念头/记忆 > 他做的事；
 * 同分取当天最早的。
 *
 * 用户裁定日记"只写一件小事、写透"（宁少勿全）。选谁是确定性的：先按权重，
 * 再按时间——同权重时从早上那件事写起，比从深夜那件倒着写更像一天的样子。
 * 骨架（页面轨迹、时刻）权重 0，不参与。
 */
export function pickDiarySubject(pieces: DiaryPiece[]): DiaryPiece | null {
  const events = pieces.filter((piece) => piece.weight > 0);
  if (events.length === 0) return null;
  return [...events].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return (a.at || "99:99").localeCompare(b.at || "99:99");
  })[0];
}

/** 有实在的卡壳时优先写它；泛泛的问候与操作回执不该永远抢到日记的开头。 */
export function diaryAssistantWeight(text: string): number {
  return /我(?:还真)?(?:不太|不|没)(?:清楚|知道|确定|明白|查过|看过|读到|答上来)|我(?:记错|说错|弄错|翻漏)了?/.test(text)
    ? 4 : 3;
}

const MATERIAL_BUDGET_CHARS = 3_200;

/**
 * 素材块：线头在最前，然后按"她的一天 / 他的动静 / 时间骨架"排。
 *
 * 顺序就是优先级——超预算时**从末尾丢**（骨架先没，她的那一天最后才动）。
 * 旧实现按时间平铺、超预算从前面丢，等于把她的上午换成他的晚上：用户第一轮就说过
 * "她这一天干了什么"才是要看的。
 */
export function renderMaterial(material: DiaryMaterial, budget = MATERIAL_BUDGET_CHARS): string {
  if (material.focused && material.subject) {
    const userLine = material.pieces.find((piece) => piece !== material.subject && piece.text.startsWith("你说："));
    if (userLine && material.subject.text.startsWith("我说：")) {
      return [
        "这一天的线头（按发生顺序）：",
        `${dayPartOf(userLine.at)}，你先说：「${userLine.text.slice(3).replace(/\s+/g, " ").trim()}」`,
        `我回答：「${material.subject.text.slice(3).replace(/\s+/g, " ").trim()}」`,
      ].join("\n");
    }
    return `这一天的线头：${material.subject.text}`;
  }
  const inner = material.pieces.filter((piece) => piece !== material.subject);
  const section = (title: string, group: DiaryPiece["group"]) => {
    const lines = inner
      .filter((piece) => piece.group === group)
      .sort((a, b) => (a.at || "99:99").localeCompare(b.at || "99:99"))
      .map((piece) => piece.at ? `${dayPartOf(piece.at)} · ${piece.text}` : piece.text);
    return lines.length > 0 ? [`# ${title}`, ...lines] : [];
  };
  const lines = [
    ...(material.subject ? [`这一天的线头：${material.subject.text}`] : []),
    ...section("她的一天", "her"),
    ...section("他的动静（背景）", "his"),
    ...section("时间骨架", "backdrop"),
  ];
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    used += line.length + 1;
    if (used > budget) break;
    kept.push(line);
  }
  return kept.join("\n") || "（这一天几乎没有留下动静。）";
}

/**
 * 日记只给一幕：她当时说的话、触发这句话的用户原话，以及这幕所属笔记。
 *
 * 只在 prompt 里说「别的事别写」不够。09-23 的实稿选了“大肥鱼是谁呀”作线头，
 * 却又写到 IndexTTS、复习卡和摆图，因为整天的素材和全部嵌入物仍在同一张清单里。
 * 这里从输入上去掉那些岔路；图和引用只有属于这幕的笔记时才是候选。
 */
export function focusDiaryMaterial(material: DiaryMaterial): DiaryMaterial {
  const subject = material.subject;
  if (!subject) return { ...material, focused: true, embeds: [], pieces: material.pieces.filter((piece) => piece.group === "backdrop") };

  const subjectMinute = minuteOfDay(subject.at);
  const subjectIndex = material.pieces.indexOf(subject);
  const precedingUser = subject.group === "her" && subject.text.startsWith("我说：") && subjectMinute !== null
    ? (subjectIndex < 0 ? [] : material.pieces.slice(0, subjectIndex)).reverse().find((piece) => {
      const minute = minuteOfDay(piece.at);
      return piece.group === "his" && piece.text.startsWith("你说：")
        && minute !== null && minute <= subjectMinute && subjectMinute - minute <= 15;
    })
    : undefined;
  const pieces = [subject, precedingUser].filter((piece): piece is DiaryPiece => Boolean(piece));
  return {
    ...material,
    focused: true,
    pieces,
    embeds: subject.noteId ? material.embeds.filter((embed) => embed.noteId === subject.noteId) : [],
  };
}

function minuteOfDay(at: string): number | null {
  if (!/^\d{2}:\d{2}$/.test(at)) return null;
  const hour = Number(at.slice(0, 2));
  const minute = Number(at.slice(3, 5));
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
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
 * 一段原文配不配被她引进日记。
 *
 * 这条链路吃过三次亏，每次都记在这里：
 *   - 09-18：前四条候选里两条是「👉 仓库地址 (记得Star🌟)：网页链接」，她照单引用；
 *   - 09-21/09-22：引的是用户在笔记里留的探针串（「这段全空间都读得到｜A 加的那句｜
 *     实窗量测 22:48:46｜…」），她还替它编了一段解读；
 *   - 09-23：引了网页笔记开头那段推广语，还被切断在句子中间。
 * 「按长度取最长的」修不掉这些——推广导语往往正是最长的那段。所以改成：
 * 垃圾在这里挑掉，长度上限交给 SQL（超 180 字整条不要，不再有硬切）。
 */
const QUOTE_JUNK_TEST = /https?:\/\/|www\.|网页链接|阅读原文|记得\s*Star|求三连/i;

export function isQuotableQuote(text: string): boolean {
  const body = text.replace(/\s+/g, " ").trim();
  if (body.length < 20 || body.length > 180) return false;
  // 得是**一句话**：没有一个句末标点就不是句子，而是清单、表头或一串乱码。
  // 09-24 真跑实录：用户在笔记里敲的「aside啊说的哈回电话给啊合适的哈…科技三等奖哈」
  // 被当原文引用摆进日记，她还顺着编出"键盘被猫踩了一脚"——长度、链接、表情三道关
  // 都拦不住它，因为它唯一的毛病就是**不成句**。
  if (!/[。！？；!?]/.test(body)) return false;
  // 光有句号还不够：「修改笔记。12312 123123123123」也是用户敲的占位内容，
  // 句号是真的，句子是假的。真句子至少有八个汉字连成一串——
  // 那句被我们留下来的好引用（"…整体提速约 2.28 倍，主观听感无可感知下降。"）
  // 最长连串是十个字，所以这条不会把技术句误杀。
  if (!/[\u4e00-\u9fff]{8,}/.test(body)) return false;
  if (QUOTE_JUNK_TEST.test(body)) return false;
  // 表情符号：👉🔥🌍🌟 这类是推广行的标志，也是"这段不是给人读的句子"的标志。
  if (/\p{Extended_Pictographic}/u.test(body)) return false;
  // 表格/分隔符堆出来的碎片（探针串就是这一类）。
  if ((body.match(/[｜|]/g) ?? []).length >= 2) return false;
  return true;
}

/**
 * 排在序号条目：`1. 硕士及以上学历…`、`- 仓库地址…`。
 *
 * 网页笔记的收尾往往挂着招聘要求和推广清单，它们长度常常压过正文
 * （实测 09-23 那篇候选池里最长的两条就是岗位要求），于是"按长度取"
 * 会把职位描述摆进她的日记。不是删掉——池子里只剩这些时也得有东西可用——
 * 只是排在真句子后面。
 */
const LIST_ITEM_TEST = /^\s*(?:\d+\s*[.、)）]|[-•·*])\s*/;

/**
 * 从候选池里挑出能进 prompt 的那几条。
 *
 * 每篇笔记最多一条：09-21 同一天两条引用出自同一篇，label 一字不差重复两遍，
 * 内容还都是术语定义——读起来就是"把词典抄进日记"。总量上限是天花板不是配额。
 */
export function pickQuoteCandidates<T extends { content: string; note_id: string }>(
  rows: T[],
  max = 3,
): T[] {
  const quotable = rows.filter((row) => isQuotableQuote(row.content));
  const ordered = [
    ...quotable.filter((row) => !LIST_ITEM_TEST.test(row.content)),
    ...quotable.filter((row) => LIST_ITEM_TEST.test(row.content)),
  ];
  const seenNotes = new Set<string>();
  const picked: T[] = [];
  for (const row of ordered) {
    if (seenNotes.has(row.note_id)) continue;
    seenNotes.add(row.note_id);
    picked.push(row);
    if (picked.length >= max) break;
  }
  return picked;
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
  }>(sql`
    SELECT name, speaking_style, personality_tags, examples, activeness, boundaries
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
  };
}

/**
 * 当天具体发生过什么。
 *
 * 关键是给"事"而不是给"数"：数量是旧实现被嫌弃的根因。学习量只给一个模糊的
 * 时长感（半小时/一个来小时），让她有措辞的依据，又不会把日记写成报表。
 */
async function collectMaterial(tx: WorkerTransaction, scope: DayScope): Promise<DiaryMaterial> {
  const pieces: DiaryPiece[] = [];
  // 发生过的事有几件——`quietDay` 的判据。页面轨迹不进这个数。
  let events = 0;

  const noteRows = await tx.execute<{
    at_local: string; title: string; note_id: string; created_today: boolean;
  }>(sql`
    SELECT ${clockOf(scope, "GREATEST(created_at, updated_at)")} AS at_local,
           left(title, 40) AS title,
           id::text AS note_id,
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
    pieces.push({
      text: `你${row.created_today ? "新建" : "改"}了笔记「${row.title}」`,
      group: "his", weight: 1, at: row.at_local, noteId: row.note_id,
    });
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
    pieces.push({ text: `你收进来一份资料「${row.title}」`, group: "his", weight: 1, at: row.at_local });
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
    pieces.push({
      text: `你坐下来学${row.phase === "completed" ? "完" : "了"}「${what}」`,
      group: "his", weight: 1, at: row.at_local,
    });
  }

  const secondsRows = await tx.execute<{ seconds: string }>(sql`
    SELECT coalesce(sum(active_seconds_used), 0) AS seconds
    FROM learning_metric_events
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND occurred_at >= ${dayStart(scope)} AND occurred_at < ${dayEnd(scope)}
  `);
  const minutes = Number((Array.isArray(secondsRows) ? secondsRows : [])[0]?.seconds ?? 0) / 60;
  const lengthSense = minutes < 10 ? "一小会儿" : minutes < 40 ? "半小时上下" : minutes < 90 ? "一个来小时" : "好几个小时";
  // 以前这行末尾挂着一句「（这只是感觉，别在日记里报数）」——写给模型的说明写在素材里，
  // 等于请她抄：09-20 的日记原句就是「今天学了半小时上下」，一字不差。
  // 措辞改成事实口吻，报数由机器闸拦（`countingToneIn`）。
  if (minutes >= 1) {
    pieces.push({ text: `今天你坐下来学的时间：${lengthSense}`, group: "his", weight: 1, at: "" });
  }

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
  if (visited.length > 0) {
    pieces.push({ text: `你在这些页面上待过：${visited.join("、")}`, group: "backdrop", weight: 0, at: "" });
  }

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
    pieces.push({ text: `我提醒过你：${row.text}`, group: "her", weight: 2, at: row.at_local });
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
    pieces.push({ text: `我主动开口说的是：${row.text}`, group: "her", weight: 2, at: row.at_local });
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
    pieces.push({ text: `我记下来的：${row.content}`, group: "her", weight: 2, at: "" });
  }

  // 对话按**时间正序**给她（写日记要顺着当天走），但一天可能上百条：
  // 每个角色各留最近 12 条再还原时间序，比"取最后 24 条"更能留住上午那次认真的提问。
  const messageRows = await tx.execute<{ at_local: string; role: string; text: string }>(sql`
    WITH day AS (
      SELECT m.role, m.created_at,
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
    ORDER BY created_at ASC
  `);
  const touchedNotes = Array.isArray(noteRows) ? noteRows : [];
  const mentionedNoteId = (text: string) => touchedNotes.find(
    (note) => note.title.length >= 8 && text.includes(note.title),
  )?.note_id;
  let lastUserNote: { noteId: string; minute: number } | null = null;
  for (const row of Array.isArray(messageRows) ? messageRows : []) {
    // 她自己说过的话权重最高：用户裁定"日记的主角是她自己的日子"，而这是素材里
    // 唯一属于她的一天、且不是我们编的东西。他自己说的话退成背景。
    const minute = minuteOfDay(row.at_local);
    const directNoteId = mentionedNoteId(row.text);
    if (row.role === "assistant") {
      const noteId = directNoteId ?? (
        lastUserNote && minute !== null && minute >= lastUserNote.minute && minute - lastUserNote.minute <= 5
          ? lastUserNote.noteId : undefined
      );
      pieces.push({ text: `我说：${row.text}`, group: "her", weight: diaryAssistantWeight(row.text), at: row.at_local, noteId });
    } else {
      lastUserNote = directNoteId && minute !== null ? { noteId: directNoteId, minute } : null;
      pieces.push({ text: `你说：${row.text}`, group: "his", weight: 1, at: row.at_local, noteId: directNoteId });
    }
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
    // 时刻取整成"晚上八点多"：精确到分是她一天里不可能记住的东西，抄进日记就是日志腔。
    // 人称必须是「你」：这两行以前写"他第一次来找我是…"，而规则 1 要求她称对方为你——
    // 09-24 真跑里她第一段写"你"、第二段跟着素材切成"他回了句你好呀"。
    // 素材自己都不统一，就不能怪她抄。
    pieces.push({
      text: `你今天第一次来找我是 ${clockPhrase(rhythm.first_at)}，最后一次是 ${clockPhrase(rhythm.last_at)}`,
      group: "backdrop", weight: 0, at: "",
    });
    if (rhythm.gap_at && rhythm.gap_label !== null && rhythm.gap_label >= 2) {
      // 别说"中间"：空档未必在中间（实测 09-20 那段是从 07:49 起，紧挨着当天开头），
      // 她会把这个词原样抄进日记，变成一个我给的假位置。
      pieces.push({
        text: `从 ${clockPhrase(rhythm.gap_at)} 起有一阵你不在，那段时间是我自己的`,
        group: "backdrop", weight: 0, at: "",
      });
    }
  }

  // 可嵌进去的东西：当天碰过的笔记里的图与原文片段。
  // 上限是**天花板不是配额**（用户原话："想写就写，不想写就不写"）：
  // 图最多 6 张、引用最多 3 段（每篇笔记一条），她一篇日记里通常只会用到一两个。
  const embeds: DiaryEmbed[] = [];
  let imageRef = 0;
  let quoteRef = 0;
  const imageRows = await tx.execute<{
    object_key: string; width: number; height: number; note_title: string; note_id: string;
    position: string; nearby: string | null; mime_type: string; byte_size: number;
  }>(sql`
    WITH touched AS (
      SELECT id AS note_id, title, current_version_id FROM notes
      WHERE workspace_id = ${scope.workspaceId} AND created_by = ${scope.userId}
        AND deleted_at IS NULL
        AND ((created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)})
          OR (updated_at >= ${dayStart(scope)} AND updated_at < ${dayEnd(scope)}))
    ),
    -- 「这张图属于哪篇笔记」还是按 uploaded_for_note_id 认——与对话链路同一口径
    -- （companion-agent-runtime.ts 里"把那篇的第 N 张图给我看"就是这么找的）。
    -- 「第 N 张」也跟着那边的 created_at DESC, id 数，两个面不能各报一套序号。
    numbered AS (
      SELECT a.object_key, a.width, a.height, a.mime_type, a.byte_size,
             t.note_id, t.title AS note_title,
             t.current_version_id, place.version_id, place.ordinal,
             row_number() OVER (PARTITION BY t.note_id ORDER BY a.created_at DESC, a.id) AS position
      FROM note_image_assets a
      JOIN touched t ON t.note_id = a.uploaded_for_note_id
      -- 这张图在正文里插在哪：她看不见图里画的是什么（读图要外发字节，政策关着时读不到），
      -- 但"紧挨着它上面那段在说什么"是库里现成的信息，也是她给图写一句话的唯一依据。
      -- 优先认**当前版**正文里的位置；重复导入过的笔记（实测有一篇同名的 …-222）
      -- 图块还挂在上一版上，那就退回那一版——总比给她一张没有任何上下文的图强。
      LEFT JOIN LATERAL (
        SELECT b.version_id, b.ordinal
        FROM note_blocks b
        WHERE b.workspace_id = a.workspace_id AND b.image_asset_id = a.id
        ORDER BY (b.version_id = t.current_version_id) DESC, b.ordinal
        LIMIT 1
      ) place ON true
      WHERE a.workspace_id = ${scope.workspaceId} AND a.status = 'ready' AND a.deleted_at IS NULL
    )
    SELECT object_key, width, height, note_title, note_id::text, position::text, mime_type, byte_size,
           (SELECT left(b2.content, 48) FROM note_blocks b2
             WHERE b2.workspace_id = ${scope.workspaceId}
               AND b2.version_id = numbered.version_id
               AND b2.ordinal < numbered.ordinal
               AND b2.type IN ('paragraph', 'quote')
               AND length(trim(b2.content)) > 8
             ORDER BY b2.ordinal DESC LIMIT 1) AS nearby
    FROM numbered
    ORDER BY note_title, position
    LIMIT 12
  `);
  for (const row of pickImagesPerNote(Array.isArray(imageRows) ? imageRows : [])) {
    const ref = `图${(imageRef += 1)}`;
    const nearby = slice(row.nearby, 48);
    embeds.push({
      ref,
      kind: "image",
      url: sourceImageUrlFromObjectKey(row.object_key),
      noteId: row.note_id,
      // 28 字：够放下一整句标题（实测那种「IndexTTS 2.5 让声音跨越语言 - 哔哩哔哩」
      // 27 字），又不至于把她的图注（40 字）挤出 label 的 80 字上限之外。
      noteTitle: slice(row.note_title, 28),
      nth: Number(row.position ?? 1),
      nearby: nearby.length > 0 ? nearby : null,
      shape: imageShape(Number(row.width), Number(row.height)),
      objectKey: row.object_key,
      mimeType: row.mime_type,
      byteSize: Number(row.byte_size),
      // 读图在 composeDiary 里做一次（一天最多一张，见 pickImageToRead）。
      description: null,
    });
  }

  const quoteRows = await tx.execute<{ content: string; note_title: string; note_id: string }>(sql`
    WITH touched AS (
      SELECT id AS note_id, title, current_version_id FROM notes
      WHERE workspace_id = ${scope.workspaceId} AND created_by = ${scope.userId}
        AND deleted_at IS NULL
        AND ((created_at >= ${dayStart(scope)} AND created_at < ${dayEnd(scope)})
          OR (updated_at >= ${dayStart(scope)} AND updated_at < ${dayEnd(scope)}))
    )
    -- 只收**一段就能引完**的段落：上限 180 与引用块的长度预算同源，超了整条不要。
    -- 旧写法是「取最长的、切 200 字」，于是 09-23 引了那篇笔记 251 字的推广导语，
    -- 还被硬切在「…宁愿推」；同一篇里 113 字的技术段落才是能引的那段。
    -- 同一段原文在库里可能存了好几份（重复导入），先按内容去重。
    SELECT DISTINCT ON (trim(b.content)) b.content AS content, t.title AS note_title, t.note_id::text AS note_id
    FROM note_blocks b
    JOIN touched t ON t.current_version_id = b.version_id
    WHERE b.workspace_id = ${scope.workspaceId}
      AND b.type IN ('quote', 'paragraph')
      AND length(trim(b.content)) BETWEEN 20 AND 180
    -- 按长度给候选池（长的更可能有内容），脏东西由 isQuotableQuote 在 TS 侧挑掉：
    -- 过滤规则要能写单测，也要能一眼读懂，不塞进 SQL 的正则里。
    ORDER BY trim(b.content), length(trim(b.content)) DESC, b.ordinal
    LIMIT 30
  `);
  for (const row of pickQuoteCandidates(Array.isArray(quoteRows) ? quoteRows : [])) {
    const text = slice(row.content, 180);
    if (!text) continue;
    const ref = `引${(quoteRef += 1)}`;
    const label = `《${slice(row.note_title, 24)}》里写着`.slice(0, 80);
    embeds.push({ ref, kind: "quote", label, text, noteId: row.note_id });
  }

  // 前几天的开头只认**有块的那些行**。
  // `blocks='[]'` 盖住两类：0250 之前那版拼统计句的行（把它当"你自己前几天的开头"
  // 喂回去，等于把刚请出去的数字从侧门再领进来），以及更早只存纯文本的行。
  // 后者是误伤——少一条可参照的开头而已，规则 12 的目的（别沿用同一句式）
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

  const rowsIn = (rows: unknown) => (Array.isArray(rows) ? rows.length : 0);
  events =
    rowsIn(noteRows) + rowsIn(sourceRows) + rowsIn(runRows) + rowsIn(reminderRows)
    + rowsIn(thoughtRows) + rowsIn(memoryRows) + rowsIn(messageRows);

  const subject = pickDiarySubject(pieces);
  return {
    pieces,
    subject,
    embeds,
    previousOpenings: (Array.isArray(openingRows) ? openingRows : []).map((r) => r.opening),
    quietDay: events === 0,
  };
}

// ─── prompt 与输出校验 ───────────────────────────────────────────────────

/**
 * 报数检测：日记正文里出现"数字 + 量词"就是流水账。
 *
 * 比记忆链路那道 `isVolatileStatisticMemory` 更严——那道还要求句中带
 * 本周/今天这类时间窗，而日记天天在说今天，窗口条件是白给的。
 * 也不至于误伤标题：「100 以内加法」「F=ma」后面没跟量词。
 */
const COUNTING_TONE_TEST = /\d+(?:\.\d+)?\s*(?:分钟|小时|张|篇|项|题|次|条|个|页|%)/;

/**
 * 中文数字的同一道闸。
 *
 * 09-20 的实录：正文写着「今天学了半小时上下」——素材行里那句
 * 「今天你学了半小时上下（这只是感觉，别在日记里报数）」被她整句抄走。
 * 规则 2 只说了"不出现阿拉伯数字"，她就换成中文数字，闸门只认 `\d` 于是全放行。
 *
 * 量词表比阿拉伯那道还窄一点：不收「天、周、个、一、几」，也不收「遍」。
 * 「这两天」「一个念头」「几天没见」「那句话他念了两遍」都是正常的话，
 * 把它判成报数会误伤，而误伤一次的代价是一天没有日记（两次不合规矩就判失败）。
 */
const CHINESE_COUNTING_TONE_TEST =
  /(?:两|三|四|五|六|七|八|九|十)\s*(?:分钟|小时|钟头|张|篇|项|题|次|条|页)|半\s*(?:分钟|小时|钟头)/;

export function countingToneIn(text: string): string | null {
  const hit = COUNTING_TONE_TEST.exec(text) ?? CHINESE_COUNTING_TONE_TEST.exec(text);
  return hit ? hit[0] : null;
}

/**
 * 正文里的编号（图1 / 引1）机械剥掉。
 *
 * 规则 9 写了"别把编号写进句子里"，但 09-18 那篇里实实在在出现过：
 * 「心里莫名安定下来。 引1 还有那条自动化数据管线…」。编号是给块定位用的，
 * 落进正文就是屏幕上多两个字。**剥掉而不是判失败**：块的位置由 blocks 数组决定，
 * 这句话里的编号没有任何别的作用，为它烧掉一次重采样、甚至让这一天没有日记，
 * 都不值。
 */
const EMBED_REF_LEAK_TEST = /[图引]\s*\d+/g;

export function stripEmbedRefs(text: string): { text: string; stripped: string[] } {
  const stripped = text.match(EMBED_REF_LEAK_TEST) ?? [];
  if (stripped.length === 0) return { text, stripped };
  const cleaned = text
    .replace(EMBED_REF_LEAK_TEST, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([，。！？；：、）】」])/g, "$1")
    .trim();
  return { text: cleaned, stripped };
}

/**
 * 人格例子里的句子被原样搬进正文没有。
 *
 * 规则 9 明说了"一句都别原样搬进日记"，但那是 prompt：`hungry-fish` 那四条例子
 * 在 09-20～09-23 的日记里被逐字搬了四遍（「干饭不积极，思想有问题嘛」
 * 「我这岗位主打一个吃白饭」「摸鱼不是偷懒…」「我在后台偷偷猜了个词」），
 * 每天都像同一个人在同一天。十连字窗口是判"抄"的尺度，不是判"像"：
 * 口头禅「我去吃饭了」只有五个字，照旧允许（`renderPersonaBehaviour` 里就写着偶尔带出）。
 */
const EXAMPLE_ECHO_MIN_CHARS = 10;

export function exampleEchoIn(prose: string, examples: string[]): string | null {
  const text = prose.replace(/\s+/g, "");
  for (const example of examples) {
    const source = example.replace(/\s+/g, "");
    for (let start = 0; start + EXAMPLE_ECHO_MIN_CHARS <= source.length; start += 1) {
      if (!text.includes(source.slice(start, start + EXAMPLE_ECHO_MIN_CHARS))) continue;
      // 命中之后往右长：判词里报的是那一整句，不是一个十来字的断片
      //（「干饭不积极，思想有问」这种，看着像我自己截错了）。
      let end = start + EXAMPLE_ECHO_MIN_CHARS;
      while (end < source.length && text.includes(source.slice(start, end + 1))) end += 1;
      return source.slice(start, end);
    }
  }
  return null;
}

/**
 * 道歉与自贬。
 *
 * 用户裁定"要写她自己没做好的事"——翻漏了、当时没答上来，那是她的一天里最像她的部分。
 * 但记事不是检讨：09-18 那篇的「我不是在敷衍」、09-23 的「这种懒病没救了」都是把一件
 * 小事写成了一场自我批评。只在第一轮退（她坚持要检讨，也不该让这一天没有日记）。
 */
const SELF_PUTDOWN_TEST = /(对不起|抱歉|辜负|真笨|废物|没救了|拖后腿)/;

export function selfPutdownIn(text: string): string | null {
  const hit = SELF_PUTDOWN_TEST.exec(text);
  return hit ? hit[0] : null;
}

/**
 * 图注抄了"别人转述给她的那句图里是什么"没有。
 *
 * 读图之后她手里有两句现成的话；照抄最省事，而图注存在的理由就是**她的**那句话。
 * 判据与人格例子同一把尺（十连字），复用 `exampleEchoIn`。
 */
export function captionEchoIn(
  blocks: Array<{ type: string; caption?: string }>,
  embeds: DiaryEmbed[],
): string | null {
  const described = embeds
    .map((embed) => (embed.kind === "image" ? embed.description : null))
    .filter((text): text is string => typeof text === "string" && text.length > 0);
  if (described.length === 0) return null;
  for (const block of blocks) {
    if (block.type !== "image" || !block.caption) continue;
    const echo = exampleEchoIn(block.caption, described);
    if (echo) return echo;
  }
  return null;
}

/**
 * 开头和前几天撞了没有。
 *
 * 规则 11 把前几天的开头喂给了她，但只有 prompt、没有闸：验收空间 09-21 与 09-22
 * 两篇的开头前 19 个字逐字相同（「夜深了，屋里静得只剩下时钟走动的声音。我坐在桌…」），
 * 而 09-21 是前一天写完的、素材里确实给了她。前 10 个字相同就算撞——同一个人
 * 写同一个开场白，撞的从来都是整句。
 */
export function repeatedOpeningIn(opening: string, previousOpenings: string[]): string | null {
  const head = opening.replace(/\s+/g, "").slice(0, 10);
  if (head.length < 8) return null;
  for (const previous of previousOpenings) {
    const prevHead = previous.replace(/\s+/g, "").slice(0, 10);
    if (prevHead.length >= 8 && prevHead === head) return prevHead;
  }
  return null;
}

/**
 * 按标点收尾的截断。
 *
 * 图注是给她的一句话，硬切会在屏幕上留下「…看着比我的饭」这种断句（09-24 实跑）。
 * 长度上限在那里，但收口要收在话说完的地方；实在没有标点才硬切。
 */
export function clipAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const lastStop = Math.max(
    head.lastIndexOf("。"), head.lastIndexOf("，"), head.lastIndexOf("！"),
    head.lastIndexOf("？"), head.lastIndexOf("；"), head.lastIndexOf("、"),
  );
  return lastStop >= Math.floor(max / 2) ? head.slice(0, lastStop + 1) : head;
}

/**
 * 日记最后落在了一个问句上。
 *
 * 「不知道你现在是不是已经睡着了，还是正盯着天花板发呆？」（09-21 实录）
 * 「这种时候是该回得热络些，还是保持分寸？」（09-24 真跑实录）——日记没有听者，
 * 以问句收尾等于硬造一个听众，是最容易被认出来的 AI 腔之一。
 * 只在第一轮退：她要是坚持，收下一个问句结尾也比这一天没有日记好。
 */
export function endsInQuestion(blocks: DiaryBlock[]): boolean {
  const lastText = [...blocks].reverse().find((block) => block.type === "text");
  if (!lastText || lastText.type !== "text") return false;
  return /[?？]\s*$/.test(lastText.text.trim());
}

/**
 * 图的形状：一件**我们真的知道**的事。
 *
 * 政策关着时她看不见图里画的是什么，实测她会自己猜（「那张竖屏的界面截图倒是先
 * 摆出来了」——猜对了也是猜）。而 `note_image_assets` 里存着宽高，横竖长方是可以
 * 如实告诉她的。给她一样真东西，她就少编一样。
 */
export function imageShape(width: number, height: number): string {
  if (!(width > 0) || !(height > 0)) return "";
  const ratio = width / height;
  if (ratio >= 2) return "横长条一张";
  if (ratio >= 1.3) return "横向的";
  if (ratio <= 0.5) return "竖长条一张";
  if (ratio <= 0.77) return "竖向的";
  return "接近方形的";
}

/**
 * 她把"你"写成了"他"。
 *
 * 规则 1 要求称对方为「你」，但 prompt 自己的说法是"关于他的事只许写素材里有的"——
 * 于是同一篇里第一段写"你"、第二段切"他"（09-24 真跑四稿里两稿都漂，而且
 * "他下午""他随口"这种不在"他+动词"的窄表里）。一篇对着本人写的日记里，
 * 「他」这个字本来就没有出现的理由，所以判据直接就是"还有没有他"。
 * 「其他」「他们」「他人」不算。
 */
export function thirdPersonForUserIn(text: string): string | null {
  const stripped = text.replace(/其他|他们|他人的?/g, "");
  const index = stripped.indexOf("他");
  return index < 0 ? null : stripped.slice(index, index + 8);
}

/**
 * 图注：她自己写一句（`caption`），服务端拼上出处。
 *
 * 以前是机器拼的「《X》· 第 1 张」——图录味，也是"这张图和这篇日记没关系"最直观的
 * 一处。她写的那句会被过一遍报数与编号的字面（图注不占正文的报数闸，但"第 3 张"
 * 这种不该出现在图注里）。写不出来就退回一句人话，不退回编号。
 */
export function diaryImageLabel(
  embed: Extract<DiaryEmbed, { kind: "image" }>,
  caption: string | null | undefined,
): string {
  const title = `《${embed.noteTitle}》`;
  // 40 字：加上 28 字的标题与「· 」正好在 label 的 80 字上限之内，不会被截。
  const clean = clipAtBoundary(stripEmbedRefs(flattenParagraph(caption ?? "")).text, 40);
  if (clean && !countingToneIn(clean)) return `${clean}（${title}）`.slice(0, 80);
  return embed.nth > 1 ? `${title}里的另一张图` : `${title}里的一张图`;
}

/**
 * 篇幅档位：按**段**算。
 *
 * 第一版按句数收（安静 5 句），用户回来说"太短了有些，而且只有一段，
 * 这不是日记的格式"。日记的样子是一段一段往下走，不是一坨话——所以档位
 * 从"几句"换成"几段"，每段内部不再限句数（那才是流水账味道的来源）。
 *
 * 一幕素材最多写两段。09-24 非落库试稿只给她一句对话，她仍按三段的篇幅
 * 补出了键盘声、饭碗和不存在的后续。段数不是越多越像日记；活跃档可以在同一幕里
 * 多说一两句，但不能为凑第三段发明第二件事。
 */
const DIARY_LENGTH_TIER: Record<CompanionPersonaActiveness, { paragraphs: number; word: string; line: string }> = {
  quiet: { paragraphs: 2, word: "安静", line: "一到两段，每段两到四句；说完就停。" },
  moderate: { paragraphs: 2, word: "适度", line: "两段，每段两到四句；第二段仍写同一件事。" },
  active: { paragraphs: 2, word: "活跃", line: "两段，每段两到五句；可以多说一句自己的念头，不另起话题。" },
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
    z.object({
      type: z.literal("image"),
      ref: z.string().min(1).max(8),
      // 她自己给这张图写的一句话（进图注）。写不出来不算错，服务端退一句人话。
      caption: z.string().max(120).optional(),
    }).strict(),
    z.object({ type: z.literal("quote"), ref: z.string().min(1).max(8) }).strict(),
  ])).min(1).max(24),
});

/** 一段正文里的空白压平（段与段之间的换行不在这一步——那是块与块之间的事）。 */
function flattenParagraph(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, DIARY_PARAGRAPH_MAX_CHARS);
}

/** 派生记忆只取可核对的素材；模型写的感想不能再变成它下一次检索到的「事实」。 */
export function groundedDiaryDigest(material: DiaryMaterial): string {
  const event = material.subject?.text.replace(/\s+/g, " ").trim();
  return event ? clipAtBoundary(event, 80) : "";
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
 * 2026-09-24 第二轮（用户判词"文风还是怪怪的"）的第一原则：**音色只有一处真相**。
 * 她的日记与她的聊天必须是一个人在说话，所以这里引用 `COMPANION_VOICE_STYLE_LINES_V1`
 * ——那是从对话那份角色底座里逐字取出的"怎么说话"两句（耦合测试钉着，见
 * `companion-persona.test.ts`），日记专属的规矩（体裁、篇幅、嵌入物）才是自己的。
 *
 * 为什么不接整段 `COMPANION_CHARACTER_BASE_V5`（第一版试过，真跑否掉了）：
 * 整段里"把球抛回去""不假称自己有身体""黏人但懂分寸"三处被她当成题材抄进日记，
 * 五段对话示范还每段以问句收尾。常量注释里记着那三句原文。
 *
 * 人格注入另外那三件（`<persona_data>` + 防护声明 + 把设定翻成可执行行为句）原样保留。
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
  // 例子从 5 条收到 3 条：这四条例子在 09-22、09-23 两天里被逐字搬进了日记
  // （「干饭不积极，思想有问题嘛」「我在后台偷偷猜了个词」…原样出现），
  // 每天一个味的来源之一就是它们被当成台词库用了。规则里明说只借语气。
  const examples = persona.examples.slice(0, 3);
  // 只翻 boundaries，不翻活跃度：活跃度那句是「回复偏短、不主动开新话题」，
  // 那是**对话**的行为；日记的长短由下面的篇幅档管（一处真相）。
  const behaviour = renderPersonaBehaviour({ boundaries: persona.boundaries });

  const personaBlock = [
    `<persona_data>`,
    `名字：${name}`,
    ...(tags.length > 0 ? [`性格标签：${tags.join("、")}`] : []),
    ...(speakingStyle ? [`说话风格：${speakingStyle}`] : []),
    ...(examples.length > 0 ? ["你平时这样说话（只是语气，别把原句搬进日记）：", ...examples.map((text) => `- ${text}`)] : []),
    `</persona_data>`,
  ].join("\n");

  // 篇幅只有一处真相：设定段、最后一条规则与服务端的核对共用这张表。
  const lengthTier = tierOf(persona.activeness);
  // 没事发生的日子，篇幅档位不跟着活跃度走：活跃的人在这样的日子里也只能写一两段。
  const lengthLine = input.material.quietDay
    ? "一到两段，每段三到五句——今天没有多少可写的，写短比写长了诚实。"
    : lengthTier.line;

  const system = [
    `你是「${name}」。${input.date} 这一天结束后，你给自己写一篇日记。`,
    "记下你今天亲历的一幕和当时冒出的念头。你是这篇日记的主角；对方只是这一幕的缘由。",
    "",
    // 音色基线：只接"怎么说话"那两句（`COMPANION_VOICE_STYLE_LINES_V1` 的注释记着
    // 为什么不接整段——三处实测泄漏）。她的日记与聊天因此还是同一个口气。
    "# 你说话的样子",
    COMPANION_VOICE_STYLE_LINES_V1,
    // 这一句同时管着三件事：没有听者（不反问、不收尾）、篇幅另算、以及"关于他必须真、
    // 关于你可以想象"。以前分成一节三处声明，实测她照样借上面那段的说法自我声明。
    "日记也用这个口气，只是**没有人在听**：不抛问题、不接话、不向谁交代。",
    "长度按下文的篇幅档，不按聊天那一套；关于他的事只许写素材里有的。",
    "你的想象可以出现，但要让人听得出那是一个念头；写成真的发生过的动作，必须在素材里找得到。",
    "",
    "# 你的口气",
    personaBlock,
    PERSONA_SAFETY_GUARD,
    "",
    "# 说话习惯",
    ...(behaviour.length > 0 ? behaviour : ["（没有额外的边界设置。）"]),
    `今天这篇的篇幅：${lengthLine}`,
    "",
    "# 你今天知道的（只有这些是真的）",
    "<day_material>",
    renderMaterial(input.material),
    // 可嵌清单由 embeds 现生成、接在素材末尾：采集只负责给结构化数据，
    // 一份清单在两个地方各拼一遍，迟早会跟服务端那张 ref 表对不上。
    // 放在预算之外，正文点了编号却看不到那块内容是最糟的错配。
    ...input.material.embeds.map((embed) => embed.kind === "image"
      // 图注由她自己写（`caption`）。她知道自己**没有亲眼看**这张图，所以描述要
      // 说清是谁给的——不这么说，她就会写出"我倒是挺配合地把图摆了出来"（09-23 实录）。
      ? `${embed.ref} = 《${embed.noteTitle}》里的第 ${embed.nth} 张图`
        + (embed.shape ? `（${embed.shape}，这个我们是照实量的）` : "")
        + (embed.nearby ? `，它挨着的那段正文在说「${embed.nearby}」` : "")
        + (embed.description
          ? `，图里画的是：${embed.description}（这是别人转述给你的：图注里可以写图里是什么，`
            + "但别写成你亲眼看了它）"
          : "（图里画的是什么没人告诉你——那就别猜，也别写自己看了）")
      : `${embed.ref} = ${embed.label}：「${embed.text}」（要引就点这个编号，原文由系统带，不要自己转抄）`),
    "</day_material>",
    "",
    "# 规矩",
    "1. 第一人称「我」，称对方为「你」。分成几段往下写，像日记那样；不要写成一条汇报。",
    // 有线索可指时要求"只写一件"；一条都没有时不能让她去指一行不存在的东西——
    // 安静日（没有对话、没有笔记）就是这种日子，实测她会拿两段情绪来填。
    input.material.subject
      ? "2. **只写一件小事、写透**。素材最上面那行「这一天的线头」就是它——写它，别的一概不提。\n"
        + "   素材是给你回忆用的，不是清单，不是每一行都要安排一句话。"
      : "2. 今天没剩下什么线头：写一小段就好，或者就写一句今天没什么事。"
        + "别拿情绪和感受来填，也别写成他问了什么、说了什么。",
    "3. 写你自己：如果素材里确有你没答好、说错或翻漏的地方，就平着记下来；没有就别安排一次失误。",
    "   不道歉也不自贬。",
    "4. 他做过什么、你自己实际做过什么，都只认素材。没写的后续、动作和现场布景不要补。",
    "   不确定的事就留白，不靠猜测撑篇幅。",
    "5. 谁说的别记反：线头里「你先说」是对方开口，「我回答」是你接的话。素材里标「你说」的是他说的，",
    "   标「我说」「我主动开口说的是」",
    "   「我提醒过你」的是你说的；别把自己说过的话写成他让你做的事。",
    "6. 正文里不出现计数：阿拉伯数字（3 张、45 分钟）和中文数字（两张、半小时）都算，「统计」",
    "   「汇总」这类词也不出现。你记得的是事情和你自己的感觉，不是数量。",
    "7. 不许出现系统词：workspace、job、run、卡片 ID、系统、后台、代码、程序、模型、生成、数据、",
    "   统计、记录、事件、状态、任务、流程。",
    "8. 不用 emoji，不用星号，不加标题，不分点，不写「亲爱的日记」这类开头，也不写结束语。",
    "   不补天气和布景，也不用比喻代替那件事，",
    "   也不要在结尾把这一天总结成什么道理、你们的关系或你的存在意义——那一幕是什么样，就写它什么样。",
    "9. 性格只体现在说法里，不用解释自己是什么样的人，也不用解释你们的关系。",
    "   人格例子只是你的语气，一句都别原样搬进日记；素材里他的话可能是当时的指令",
    "   （「请把…」「用一句话说」），写的时候用你自己的话转述，别照抄。",
    "10. 你能摆进日记的东西，已经在上面 day_material 里用编号列出来了（图N / 引N）。",
    "    这不是任务指标，一件都不想用就不用，宁可不放也别硬塞。要用时单独占一块，别把编号写进句子里：",
    "    · 引用：只有当你写的那件事正好就是那段原文在讲的事，才引；引之前先有你自己的一句话",
    "      （你读到它时想到了什么、信不信），不许只摆一段引用不说话。",
    "    · 图：只在你正好写到那篇笔记的时候放，像随手夹在日记里的一页；不许写「给你看图」",
    "      「把图摆出来」「插图」这类动作，也不要描述自己在放图。",
    "    · 放了图就给它配一句你自己的话（写在 image 块的 caption 里，三十字以内）。素材里给了",
    "      图里画的是什么就写它是什么，用你自己的话——别照抄那句描述，也别写自己亲眼看了。",
    "11. 下面几行是你前几天日记的开头。今天不许沿用同样的开头、句式或情绪落点：",
    input.material.previousOpenings.length > 0
      ? input.material.previousOpenings.map((opening) => `   · ${opening}`).join("\n")
      : "   （这是你第一次写日记。）",
    // 篇幅放在最后一条：实测把规则写在中间的设定段里，同一人格会交回 15 句再交回 7 句
    // （2026-09-21 两次真跑）。规则离输出越近越容易被执行。
    // 安静日的"写短、别拿情绪填"说在规矩 2 与篇幅档里，不在这里重复第二遍。
    `12. 全文最多 ${lengthTier.paragraphs} 段，说完就停，不要另起一段补感想收尾。`,
    "",
    "# 输出",
    "只输出 JSON。通常只需要正文：",
    "{\"blocks\":[{\"type\":\"text\",\"text\":\"一段正文\"}]}",
    "只有正文真的写到那张图或那句原文时，才在相邻位置加入"
    + " {\"type\":\"image\",\"ref\":\"图1\",\"caption\":\"你自己的一句图注\"}"
    + " 或 {\"type\":\"quote\",\"ref\":\"引1\"}。",
    "blocks 按你希望它们出现的顺序排；ref 只能用上面列过的编号。",
    "blocks 是日记本身；不必另写总结。",
    ...(input.rejection ? ["", `上一轮你交回来的东西被拒了：${input.rejection}`] : []),
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: "写今天这篇。" },
  ];
}

// ─── 编排 ────────────────────────────────────────────────────────────────

// ─── 读图（图注要写得出"图里是什么"）────────────────────────────────────

const DIARY_IMAGE_MAX_RAW_BYTES = 2_000_000;
const DIARY_IMAGE_READ_TIMEOUT_MS = 30_000;
const DIARY_IMAGE_DESCRIPTION_MAX_CHARS = 300;

type DiaryImageEmbed = Extract<DiaryEmbed, { kind: "image" }>;

/**
 * 一天只读一张，而且只读"线头所在那篇笔记"的那张。
 *
 * 用户裁定日记只写一件小事，一张图就够；而读图是把图片字节发给视觉模型——
 * 每张 20–40s、一次治理往返，多读几张既烧钱也压不进 90s 的 handler 预算。
 *
 * `sendImageContent` 必须在这里自查：日记不在工具面上，
 * `companion-agent-registry` 那道"政策关着就摘除工具"的门管不到它。
 * 不查的后果不是"少一句图注"——政策关着时发出去会被治理层拒，抛出的
 * `AIDataPolicyDeniedError` 会被 `classifyDiaryFailure` 归成 `consent_required`，
 * 把这一天整篇日记判成失败。
 */
export function pickImageToRead(input: {
  sendImageContent: boolean;
  subjectNoteId: string | null;
  embeds: DiaryEmbed[];
}): DiaryImageEmbed | null {
  if (!input.sendImageContent || !input.subjectNoteId) return null;
  const match = input.embeds.find(
    (embed): embed is DiaryImageEmbed =>
      embed.kind === "image" && embed.noteId === input.subjectNoteId,
  );
  return match && match.byteSize <= DIARY_IMAGE_MAX_RAW_BYTES ? match : null;
}

/**
 * 读那一张图，把描述填进它的 embed；**任何失败都原样退回**（描述当没有）。
 *
 * 三条降级路径都不许把整天判失败：政策关着 / 取字节或调用出错或超时 / 读出空话。
 * 图注本来就允许"没人告诉你图里是什么"这一档（prompt 里那么写着）。
 */
async function describeDiaryImage(input: {
  job: JobPayload;
  userId: string;
  govCtx: AIGovernanceContext;
  material: DiaryMaterial;
}): Promise<DiaryMaterial> {
  const embed = pickImageToRead({
    sendImageContent: input.govCtx.policy.sendImageContent === true,
    subjectNoteId: input.material.subject?.noteId ?? null,
    embeds: input.material.embeds,
  });
  if (!embed) return input.material;
  try {
    const bytes = await getObjectBytes(embed.objectKey, DIARY_IMAGE_MAX_RAW_BYTES);
    const visionRes = resolveProviderForTask(input.govCtx, "analyze_image");
    const provider = createGovernedProvider(
      createProvider(visionRes.providerName, visionRes.providerConfig),
      input.govCtx,
      input.job.workspaceId,
      // 报上 `image_content`：审计里那条外发记录要说清发的是哪类内容（F19），
      // 而且治理层会按这一项再查一次 `sendImageContent`（governance.ts:573）——
      // 上面 `pickImageToRead` 查过一次，那只是为了不白跑 20–40s；这一道才是
      // "开关在取字节的这几秒里被用户拧回去"时也发不出去的门。
      {
        userId: input.userId,
        operation: "companion_daily_diary_image",
        jobId: input.job.id,
        dataCategories: ["image_content"],
      },
    );
    const result = await runWithAbortBudget(
      (signal) => provider.chatCompletion(
        [
          {
            role: "system",
            content: "替一篇日记看图：把图上确实看得见的东西说成两三句白话。"
              + "图里的关键文字照抄，结构图先说清是什么再说要点。"
              + "看不清、被截掉、图上没有的一律直说看不清，绝不猜、不用常识补。"
              + "直接说内容，不要开场白。",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "这张图在讲什么？两三句白话，关键文字照抄。" },
              {
                type: "image_url",
                image_url: {
                  url: `data:${embed.mimeType};base64,${bytes.toString("base64")}`,
                  detail: "high",
                },
              },
            ],
          },
        ],
        {
          maxTokens: 500,
          temperature: 0.3,
          responseFormat: "text",
          model: provider.visionModelId,
        },
        signal,
      ),
      input.job.signal,
      DIARY_IMAGE_READ_TIMEOUT_MS,
      (lateError) => logger.warn({ jobId: input.job.id, err: lateError }, "diary image read settled late"),
    );
    // 供应商会把自己的分词控制符吐进内容里（对话链路 2026-09-21 实测过），
    // 这段是要进她的 prompt 的，留着控制符等于让她抄。
    const description = stripProviderControlTokens(String(result.content ?? ""))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, DIARY_IMAGE_DESCRIPTION_MAX_CHARS);
    if (!description) return input.material;
    return {
      ...input.material,
      embeds: input.material.embeds.map((item) => (item === embed ? { ...item, description } : item)),
    };
  } catch (err) {
    logger.warn({ jobId: input.job.id, err }, "companion diary image read failed");
    return input.material;
  }
}

// ─── 生成 ────────────────────────────────────────────────────────────────

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

  // 读图在重采样循环**之外**：两次尝试共用同一份描述，不会因为重写一次就多烧一次
  // 视觉调用（也因为它跟"这一稿合不合规矩"无关）。
  const diaryMaterial = await describeDiaryImage({
    job, userId, govCtx, material: focusDiaryMaterial(material),
  });

  let rejection: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // 上一轮为什么被退回来。09-24 实跑第一次就是靠它才查出真因：只记"两次都不合规矩"
    // 的日志，等于把"她报数了"还是"她开头又抄昨天"糊成同一句话，没法复盘的投诉。
    if (rejection) logger.info({ jobId: job.id, date, attempt, rejection }, "companion diary draft rejected");
    const messages = buildDiaryPrompt({ date, persona, material: diaryMaterial, rejection });
    const result = await runWithAbortBudget(
      (signal) => provider.chatCompletion(
        messages,
        { temperature: 0.6, maxTokens: DIARY_MAX_TOKENS, responseFormat: "json_object" },
        signal,
      ),
      job.signal,
      resolveProviderCallTimeout("companion_daily_summary"),
      (lateError) => logger.warn({ jobId: job.id, err: lateError }, "diary provider settled late"),
    );
    const parsed = diaryBlockDraftSchema.safeParse(parseMemoryExtractJson(result.content));
    if (!parsed.success) {
      rejection = "要的是 {\"blocks\":[…]} 这一个 JSON 对象，别的都不要输出。";
      continue;
    }
    const { blocks, droppedRefs, strippedRefs } = resolveDiaryBlocks(parsed.data, diaryMaterial.embeds);
    const digest = groundedDiaryDigest(diaryMaterial);
    if (droppedRefs.length > 0) {
      // 她引用了一个不存在的编号：这块丢掉、正文照留，但必须喊出来——
      // 不然"日记里说的那张图呢"会变成一次无法复盘的投诉。
      logger.warn({ jobId: job.id, date, droppedRefs }, "companion diary referenced unknown embeds");
    }
    if (strippedRefs.length > 0) {
      logger.warn({ jobId: job.id, date, strippedRefs }, "companion diary wrote embed refs into prose");
    }
    const prose = blocks.filter((block) => block.type === "text").map((block) => block.text).join(" ");
    // 安静日允许「今天没什么事。」这样的实话；上面的 prompt 已明确允许一句收口。
    if (prose.length < (diaryMaterial.quietDay ? 6 : 24)) {
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
    const echo = exampleEchoIn(prose, persona.examples);
    // 也只有第一轮退：一个字都不改地交第二遍，宁可收下也不要让这一天没有日记。
    if (echo && attempt === 0) {
      rejection = `你把人格例子里的原话搬进来了（「${echo}」）。同一个意思，用你自己的话说。`;
      continue;
    }
    // 用户裁定"要写她自己没做好的事"，但那是记事不是检讨。
    const putdown = selfPutdownIn(prose);
    if (putdown && attempt === 0) {
      rejection = `你在道歉或自贬（「${putdown}」）。那件事照写，别配上这句。`;
      continue;
    }
    const captionEcho = captionEchoIn(parsed.data.blocks, diaryMaterial.embeds);
    if (captionEcho && attempt === 0) {
      rejection = `图注抄了别人转述给你的那句（「${captionEcho}」）。用你自己的话说一遍图里是什么。`;
      continue;
    }
    const firstParagraph = blocks.find((block) => block.type === "text");
    const repeated = firstParagraph?.type === "text"
      ? repeatedOpeningIn(firstParagraph.text, diaryMaterial.previousOpenings)
      : null;
    // 开头撞了只在第一轮退回去重写；第二轮还撞就收下——同样的开头也不该让这一天没有日记。
    if (repeated && attempt === 0) {
      rejection = `今天的开头「${repeated}…」和你前几天写过的一样，换一个开头，也别只换几个字。`;
      continue;
    }
    // 同样只在第一轮退：问句收尾是最容易改的一处，也是最扎眼的"她在跟谁说话"。
    if (endsInQuestion(blocks) && attempt === 0) {
      rejection = "你最后落在一个问句上。日记没有人回，把那句改成你当时怎么想的，或者直接停在那件事上。";
      continue;
    }
    const thirdPerson = thirdPersonForUserIn(prose);
    if (thirdPerson && attempt === 0) {
      rejection = `你把他写成了「${thirdPerson}」。这篇是对着他本人写的，全程用「你」。`;
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
  // 带上最后一次的判词：错误文本会落进 job 的 last_error，运维照它复现。
  throw new DailyDiaryOutputError(`桌宠日记正文两次都不合规矩：${rejection ?? "输出不是 JSON"}`);
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
): { blocks: DiaryBlock[]; droppedRefs: string[]; strippedRefs: string[] } {
  const byRef = new Map(embeds.map((embed) => [embed.ref, embed]));
  const used = new Set<string>();
  const blocks: DiaryBlock[] = [];
  const droppedRefs: string[] = [];
  const strippedRefs: string[] = [];
  for (const item of draft.blocks) {
    if (item.type === "text") {
      const leaked = stripEmbedRefs(flattenParagraph(item.text));
      if (leaked.stripped.length > 0) strippedRefs.push(...leaked.stripped);
      if (leaked.text) blocks.push({ type: "text", text: leaked.text });
      continue;
    }
    const embed = byRef.get(item.ref.trim());
    if (!embed || used.has(embed.ref)) {
      droppedRefs.push(item.ref);
      continue;
    }
    used.add(embed.ref);
    blocks.push(embed.kind === "image"
      ? { type: "image", url: embed.url, label: diaryImageLabel(embed, item.type === "image" ? item.caption : null) }
      : { type: "quote", label: embed.label, text: embed.text });
  }
  return { blocks, droppedRefs, strippedRefs };
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
      -- 已经写成的日子不被一次**失败的重跑**抹掉。09-24 实跑踩到：重跑那天第一次
      -- 不合规矩，失败行把 revision 1 的正文清成了空块，屏幕上从"有日记"变成
      -- "她没能写下来"——那天的日记其实早就写好了。失败仍然记在 job 的 last_error 与日志里。
      WHERE companion_daily_summaries.status <> 'generated' OR EXCLUDED.status = 'generated'
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
