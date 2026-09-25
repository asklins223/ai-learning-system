/**
 * 实体先行解析（P1，39b §9.3；39d W2-3）：用户这句话指到的对象，服务端先替她查好。
 *
 * 原事故：用户问「为啥第四张学习卡这么慢」，她拿两个真读数推出一个假结论——两个工具都
 * 答对了，问题问的是第三个东西。根因不是她算错，而是"「第四张」是谁"这件事**没有人在
 * 她开口之前先确定**。所以这里在回合读阶段（`loadHereAndNow` 那次读事务里，不新开连接）
 * 跑确定性解析器，把这句话指到的实体查出来，渲染成 `<this_turn_facts>` 数据块。
 *
 * 指称语法封闭五条（扫的是**用户输入**，不是她的输出）：
 *   ① `《X》`／`「X」` 括号里的字面标题 —— **不在这里**：它已由 `noteReference`
 *      （`extractNoteTitleReference` + `<here_and_now>` 里那几行）承担，本次只给它补上
 *      "没匹配时最接近的一篇"。同一个事实两处渲染就是两份，迟早分叉。
 *   ② 序数指代 `第N张/条/篇/个` → 当前可读视图 `items[].ordinal`；
 *   ③ 代词 `这篇/那篇/这条/那张/它` → 当前视图 `title`，取不到不解析；
 *   ④ 用户输入里的显式 id → **上一轮**工具调用的真参数（`companion_agent_tool_calls.arguments`）；
 *   ⑤ 裸标题 → 已有的按词 AND 逻辑（`noteSearchTerms`）。
 *
 * 五类实体（39b §9.3：一次事务批量查 notes／cards／reminders／memory／due reviews）：
 * 每类一条查询，条数与指称个数无关；到期状态随卡那一条 LEFT JOIN 取回，不是第六类查询。
 *
 * 三条"不许"（每一条都对应一种会静默变坏的形态）：
 *   - **扫用户输入不算扫措辞**：漏一次指称的代价只是她照常调工具（与今天一致，工具面一条
 *     不减），方向是安全的；把判据挪到她的**输出**上才是另一回事。
 *   - **超预算整块丢弃**：单轮总预算 `TURN_FACTS_BUDGET_MS`，超了就这一轮不发这块——半个
 *     事实块比没有更容易被她当成全部（39b §9.3：超预算丢弃本轮 preflight 不拖回合）。
 *   - **不猜**：解析不出对象时给的是"没解析出来"的回执，不是替她挑一个最像的。
 *
 * 与重放台的关系：`scripts/companion-gate-counterfactual.py` 的 G3 覆盖判定读的就是本模块
 * 的真实结果（`ThisTurnFacts.definite`）；它此前自己用 Python 正则模拟 P1，那份模拟已删。
 */

import { sql } from "drizzle-orm";
import { noteVisibleSqlText } from "@ailearn/shared/note-visibility";
import type { WorkerTransaction } from "../db.ts";
import { noteSearchTerms } from "./companion-dialogue-content.ts";
import { ageLabel, visibleCompanionCardSourceCondition } from "./companion-here-and-now.ts";
import type { LivePageView } from "./companion-live-view.ts";
import { findNearestNoteTitle, findNoteRuns, type NoteRunRow } from "./companion-note-reads.ts";

/**
 * 单轮 preflight 总预算（毫秒）。超了整块丢弃：这块是"她张口之前先替她查好"的增值，
 * 不是回合的必经步骤，慢一点就退回调工具（39b §9.3 的预算条款）。
 */
export const TURN_FACTS_BUDGET_MS = 120;

/** 一次最多解析几个指称（39b §9.3：上限 6 个指称 × 5 类）。 */
export const TURN_REFERENCE_MAX = 6;

export type TurnEntityKind = "note" | "card";

export type TurnReferenceRule = "ordinal" | "pronoun" | "id" | "bare";

export interface TurnReference {
  rule: TurnReferenceRule;
  /** 用户那句话里的说法（回执与相似度都用它），如「第四张」/《标题》。 */
  text: string;
  entity: TurnEntityKind;
  /** 规则②的序数；其余为 null。 */
  ordinal: number | null;
  /** 当前这一屏上那一项的状态字（规则②；没有就是 null）。 */
  screenState: string | null;
  /** false = 已经知道解析不出来（例如代词取不到当前屏对象）→ 只发回执。 */
  resolvable: boolean;
}

/** 她说出"找到／没找到／没解析出来"这三类确定口径之一时置真——G3 的覆盖判定读它。 */
export interface ThisTurnFacts {
  /** 可直接进 prompt 的 `<this_turn_facts>` 块（含边界标记）；`dropped` 时为 null。 */
  readonly block: string | null;
  readonly definite: boolean;
  /** 命中的规则（供实施日志与重放台逐条对账），无解析时为 null。 */
  readonly rule: string | null;
  /** 本次 preflight 自身耗时（毫秒）。 */
  readonly ms: number;
  /** 是否因为超预算被整块丢弃（丢的时候 block 为 null）。 */
  readonly dropped: boolean;
}

/** 页面种类 → 这一屏上的对象是什么。认不出来的页按"没解析出来"处理。 */
const ENTITY_KIND_BY_PAGE: Record<string, TurnEntityKind> = {
  note: "note",
  card: "card",
  objective: "card",
  review: "card",
};

const ORDINAL_REF = /第\s*([一二三四五六七八九十\d]+)\s*[张条篇个]/;
const PRONOUN_REF = /(这篇|那篇|这条|那张|它)/;
const EXPLICIT_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const CN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function ordinalValue(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw.length === 1) return CN_DIGITS[raw] ?? null;
  // 「十二」「二十三」这类两位数：够用就停在这里，不为它写一套中文数字解析。
  if (raw.length === 2 && raw[0] === "十") return 10 + (CN_DIGITS[raw[1]] ?? 0);
  if (raw.length === 2 && raw[1] === "十") return (CN_DIGITS[raw[0]] ?? 0) * 10;
  if (raw.length === 3 && raw[1] === "十") return (CN_DIGITS[raw[0]] ?? 0) * 10 + (CN_DIGITS[raw[2]] ?? 0);
  return null;
}

/**
 * 五条规则里能扫出指称的这四条（① 见文件头：它落在 `noteReference`）。
 *
 * 规则⑤（裸标题）刻意**只在没有任何更强的指称时**才试一次，且只拿整句做一次 AND/ILIKE
 * 匹配：它是漏接也安全的兜底（匹配不上就什么都不说，她照常调工具），不是"每句话都去
 * 猜一个标题"的入口。
 */
export function extractTurnReferences(userText: string | undefined, view: LivePageView | null): TurnReference[] {
  const text = typeof userText === "string" ? userText.trim() : "";
  if (text.length === 0) return [];
  const refs: TurnReference[] = [];
  const pageEntity = view ? ENTITY_KIND_BY_PAGE[view.pageKind] ?? null : null;

  const ordinal = ORDINAL_REF.exec(text);
  if (ordinal) {
    const value = ordinalValue(ordinal[1]);
    if (value != null) {
      const item = view?.items.find((entry) => entry.ordinal === value) ?? null;
      refs.push({
        rule: "ordinal",
        // 解析出来了就用屏上那一项的名字（她照着念的也是这个名字），否则保留用户说法。
        text: item ? item.label : ordinal[0],
        entity: pageEntity ?? "card",
        ordinal: value,
        screenState: item?.state ?? null,
        resolvable: Boolean(item),
      });
    }
  }

  const pronoun = PRONOUN_REF.exec(text);
  if (pronoun) {
    refs.push({
      rule: "pronoun",
      text: view?.title ?? pronoun[1],
      entity: pageEntity ?? "note",
      ordinal: null,
      screenState: null,
      resolvable: Boolean(view?.title),
    });
  }

  const uuid = EXPLICIT_UUID.exec(text);
  if (uuid) {
    refs.push({ rule: "id", text: uuid[0], entity: "note", ordinal: null, screenState: null, resolvable: true });
  }

  if (refs.length === 0) {
    const terms = noteSearchTerms(text);
    if (terms.length > 0) {
      refs.push({ rule: "bare", text: terms.join(" "), entity: "note", ordinal: null, screenState: null, resolvable: true });
    }
  }

  // 同一说法只留一条；顺序即优先级（序数 > 代词 > id > 裸标题）。
  const seen = new Set<string>();
  return refs
    .filter((ref) => {
      const key = `${ref.rule}:${ref.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, TURN_REFERENCE_MAX);
}

// ─── 取数（五类，每类一条） ────────────────────────────────────────────────

interface NoteFactRow extends Record<string, unknown> {
  id: string;
  title: string;
  age_minutes: string;
  block_count: string;
  image_count: string;
}

interface CardFactRow extends Record<string, unknown> {
  card_id: string;
  cue: string | null;
  schedule_status: string | null;
  next_review_at: string | null;
  user_deferred_until: string | null;
  overdue: boolean | null;
}

interface ReminderFactRow extends Record<string, unknown> {
  id: string;
  text: string;
  fire_at_local: string;
}

interface MemoryFactRow extends Record<string, unknown> {
  id: string;
  kind: string;
  content: string;
}

function matchedTermCount(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term.toLowerCase())).length;
}

/**
 * 候选够不够格（指称里的词至少一半出现在候选文本里）。
 *
 * 为什么不是"全部词都要命中"：规则⑤ 的指称是**用户整句话**（"数据库索引优化策略
 * 讲了什么"），要求每个词都进标题等于永远匹配不上；而为什么不是"命中一个就算"：
 * 一句话里随便一个常见词命中就会把不相干的对象递给她。一半是能同时挡住两头的界。
 * 单字指称（屏上那一项的名字）在这一条下退化成"必须完整包含"，正是要的。
 */
export const TURN_FACT_MIN_COVERAGE = 0.5;

function coverage(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  return matchedTermCount(text, terms) / terms.length;
}

function bestByCoverage<T>(rows: T[], terms: string[], textOf: (row: T) => string): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const row of rows) {
    const score = coverage(textOf(row), terms);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return bestScore >= TURN_FACT_MIN_COVERAGE ? best : null;
}

function termMatchChain(column: (term: string) => ReturnType<typeof sql>, terms: string[]) {
  return sql.join(terms.map((term) => column(term)), sql` OR `);
}

async function findNotes(
  tx: WorkerTransaction,
  scope: { workspaceId: string; userId: string },
  terms: string[],
): Promise<NoteFactRow[]> {
  if (terms.length === 0) return [];
  const match = termMatchChain((term) => sql`n.title ILIKE ${`%${term}%`}`, terms);
  const rows = await tx.execute<NoteFactRow>(sql`
    SELECT n.id, n.title,
           EXTRACT(EPOCH FROM (now() - n.updated_at)) / 60 AS age_minutes,
           (SELECT count(*) FROM note_blocks nb
             WHERE nb.version_id = n.current_version_id AND coalesce(nb.content, '') <> '') AS block_count,
           (SELECT count(*) FROM note_image_assets a
             WHERE a.workspace_id = n.workspace_id AND a.uploaded_for_note_id = n.id
               AND a.status = 'ready' AND a.deleted_at IS NULL) AS image_count
    FROM notes n
    WHERE n.workspace_id = ${scope.workspaceId} AND n.deleted_at IS NULL
      AND ${sql.raw(noteVisibleSqlText("n", `'${scope.userId}'::uuid`))}
      AND ${match}
    ORDER BY n.updated_at DESC LIMIT 6
  `);
  return Array.isArray(rows) ? rows : [];
}

async function findCards(
  tx: WorkerTransaction,
  scope: { workspaceId: string; userId: string },
  terms: string[],
): Promise<CardFactRow[]> {
  if (terms.length === 0) return [];
  const match = termMatchChain((term) => sql`c.front->>'cue' ILIKE ${`%${term}%`}`, terms);
  const rows = await tx.execute<CardFactRow>(sql`
    SELECT c.card_id, c.front->>'cue' AS cue,
           s.status AS schedule_status,
           to_char(s.next_review_at, 'MM-DD HH24:MI') AS next_review_at,
           to_char(s.user_deferred_until, 'MM-DD HH24:MI') AS user_deferred_until,
           (s.next_review_at IS NOT NULL AND s.next_review_at <= now()) AS overdue
    FROM learning_cards_v2 c
    LEFT JOIN review_schedules s
      ON s.workspace_id = c.workspace_id AND s.subject_type = 'card'
     AND s.subject_id = c.objective_id AND s.status = 'pending'
     AND (s.user_id = ${scope.userId} OR s.user_id IS NULL)
    WHERE c.workspace_id = ${scope.workspaceId} AND c.lifecycle = 'active'
      AND ${visibleCompanionCardSourceCondition(scope.userId)}
      AND ${match}
    ORDER BY c.updated_at DESC LIMIT 6
  `);
  return Array.isArray(rows) ? rows : [];
}

async function findReminders(
  tx: WorkerTransaction,
  scope: { workspaceId: string; userId: string },
  terms: string[],
): Promise<ReminderFactRow[]> {
  if (terms.length === 0) return [];
  const match = termMatchChain((term) => sql`r.text ILIKE ${`%${term}%`}`, terms);
  const rows = await tx.execute<ReminderFactRow>(sql`
    SELECT r.id, r.text,
           to_char(r.fire_at AT TIME ZONE coalesce(
             (SELECT quiet_hours->>'timezone' FROM user_companion_account_state
               WHERE user_id = ${scope.userId} LIMIT 1), 'Asia/Shanghai'),
             'MM-DD HH24:MI') AS fire_at_local
    FROM companion_reminders r
    WHERE r.workspace_id = ${scope.workspaceId} AND r.user_id = ${scope.userId}
      AND r.status = 'pending' AND (${match})
    ORDER BY r.fire_at LIMIT 3
  `);
  return Array.isArray(rows) ? rows : [];
}

async function findMemories(
  tx: WorkerTransaction,
  scope: { workspaceId: string; userId: string },
  terms: string[],
): Promise<MemoryFactRow[]> {
  if (terms.length === 0) return [];
  const match = termMatchChain((term) => sql`m.content ILIKE ${`%${term}%`}`, terms);
  const rows = await tx.execute<MemoryFactRow>(sql`
    SELECT m.id, m.kind, m.content
    FROM assistant_memory_items m
    WHERE m.workspace_id = ${scope.workspaceId} AND m.user_id = ${scope.userId}
      AND m.deleted_at IS NULL AND m.archived_at IS NULL AND coalesce(m.candidate, false) = false
      AND (${match})
    ORDER BY m.updated_at DESC LIMIT 2
  `);
  return Array.isArray(rows) ? rows : [];
}

/**
 * 规则④：这句话里的 id 是不是**上一轮工具结果里出现过**的那一个。
 *
 * 只认"她上一轮真的查过"的 id：用户随口报一个 uuid 就替他去库里翻，等于把一条可以被
 * 外部输入驱动的查询接到伴星上（39b §9.3 规则④原文就是"上一轮工具结果里出现过的"）。
 */
async function resolvePreviousToolId(
  tx: WorkerTransaction,
  scope: { workspaceId: string; userId: string; conversationId?: string | null },
  id: string,
): Promise<string | null> {
  if (!scope.conversationId) return null;
  const rows = await tx.execute<{ arguments: unknown }>(sql`
    SELECT c.arguments FROM companion_agent_tool_calls c
    WHERE c.workspace_id = ${scope.workspaceId} AND c.user_id = ${scope.userId}
      AND c.conversation_id = ${scope.conversationId}
    ORDER BY c.created_at DESC LIMIT 20
  `);
  const seen = (Array.isArray(rows) ? rows : [])
    .some((row) => JSON.stringify(row.arguments ?? null).includes(id));
  if (!seen) return null;
  const notes = await tx.execute<{ title: string }>(sql`
    SELECT n.title FROM notes n
    WHERE n.id = ${id}::uuid AND n.workspace_id = ${scope.workspaceId} AND n.deleted_at IS NULL
      AND ${sql.raw(noteVisibleSqlText("n", `'${scope.userId}'::uuid`))}
    LIMIT 1
  `);
  if (notes[0]) return `笔记《${notes[0].title}》`;
  const cards = await tx.execute<{ cue: string | null }>(sql`
    SELECT front->>'cue' AS cue FROM learning_cards_v2
    WHERE card_id = ${id} AND workspace_id = ${scope.workspaceId} AND lifecycle = 'active' LIMIT 1
  `);
  if (cards[0]) return `学习卡《${cards[0].cue ?? ""}》`;
  const reminders = await tx.execute<{ text: string }>(sql`
    SELECT text FROM companion_reminders
    WHERE id = ${id}::uuid AND workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId} LIMIT 1
  `);
  if (reminders[0]) return `提醒「${reminders[0].text}」`;
  return null;
}

// ─── 渲染 ─────────────────────────────────────────────────────────────────

function truncate(value: string, max: number): string {
  const chars = Array.from(value.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

function renderNoteLine(note: NoteFactRow, runs: NoteRunRow[]): string {
  const parts = [
    `笔记《${truncate(note.title, 24)}》：noteId=${note.id}`,
    `${ageLabel(Number(note.age_minutes))}改过`,
    `正文 ${note.block_count} 块`,
  ];
  if (Number(note.image_count) > 0) parts.push(`${note.image_count} 张图`);
  const paused = runs.filter((run) => run.phase === "paused");
  const running = runs.filter((run) => run.phase !== "paused");
  if (running.length > 0) parts.push(`有 ${running.length} 轮学习正在进行中（runId=${running[0].id}）`);
  if (paused.length > 0) parts.push(`有 ${paused.length} 轮学习在暂停中（runId=${paused[0].id}）`);
  return `- ${parts.join("，")}。`;
}

function renderCardLine(ref: TurnReference, card: CardFactRow): string {
  const state = card.schedule_status === "pending"
    ? (card.overdue ? "到期待复习" : "已安排复习")
    : "没有待复习安排";
  const deferred = card.user_deferred_until ? `，用户已延后到 ${card.user_deferred_until}` : "";
  return `- 「${truncate(ref.text, 24)}」：学习卡《${truncate(card.cue ?? "", 24)}》`
    + `（cardId=${card.card_id}，${state}${deferred}）。`;
}

// ─── 主流程 ───────────────────────────────────────────────────────────────

export interface ThisTurnFactsScope {
  workspaceId: string;
  userId: string;
  conversationId?: string | null;
  userText?: string;
  liveView: LivePageView | null;
}

/**
 * 跑一轮实体先行解析。返回 null 表示这一轮不发这块（没有指称，或超预算被丢弃）。
 *
 * 预算按**指称逐个**检查：超了立刻停、整块丢弃，不把剩下的事实补齐——这块的定位是
 * "她张口之前先替她查好"，慢到影响首字延迟就已经输给"她自己去调工具"了。
 */
export async function loadThisTurnFacts(
  tx: WorkerTransaction,
  scope: ThisTurnFactsScope,
): Promise<ThisTurnFacts | null> {
  const started = Date.now();
  const refs = extractTurnReferences(scope.userText, scope.liveView);
  if (refs.length === 0) return null;

  const deadline = started + TURN_FACTS_BUDGET_MS;
  const drop = (): ThisTurnFacts => ({
    block: null, definite: false, rule: null, ms: Date.now() - started, dropped: true,
  });

  // 五类批量查：每类一条查询，条数与指称个数无关；只在真有指称时才发。
  const textRefs = refs.filter((ref) => ref.rule !== "id");
  const terms = [...new Set(textRefs.flatMap((ref) => noteSearchTerms(ref.text)))].slice(0, 6);
  const noteRows = await findNotes(tx, scope, terms);
  const cardRows = await findCards(tx, scope, terms);
  const reminderRows = await findReminders(tx, scope, terms);
  const memoryRows = await findMemories(tx, scope, terms);
  const noteRuns = await findNoteRuns(tx, scope, noteRows.map((note) => note.id));

  const lines: string[] = [];
  const hitRules = new Set<string>();
  for (const ref of refs) {
    if (Date.now() > deadline) return drop();
    const refTerms = noteSearchTerms(ref.text);

    if (ref.rule === "id") {
      const target = await resolvePreviousToolId(tx, scope, ref.text);
      if (target) {
        lines.push(`- ${ref.text}：上一轮查到过这个 id，它是${target}。`);
        hitRules.add(ref.rule);
      }
      continue;
    }

    if (!ref.resolvable) {
      lines.push(`- 「${truncate(ref.text, 20)}」：没法确定用户指的是哪一项（当前这一屏没有给出具体对象），别猜、也别声称查过。`);
      hitRules.add(ref.rule);
      continue;
    }

    if (ref.entity === "card") {
      const card = cardRows.find((row) => (row.cue ?? "") === ref.text)
        ?? bestByCoverage(cardRows, refTerms, (row) => row.cue ?? "");
      if (card) {
        lines.push(renderCardLine(ref, card));
      } else if (ref.ordinal != null) {
        lines.push(`- 「${truncate(ref.text, 24)}」：这是用户当前这一屏上的第 ${ref.ordinal} 项`
          + `${ref.screenState ? `（状态：${ref.screenState}）` : ""}，但库里没能对上它对应的学习卡；`
          + "要操作它先用检索工具确认 id。");
      } else {
        lines.push(`- 「${truncate(ref.text, 24)}」：没能在库里对上这一屏上的对象；要操作它先用检索工具确认 id。`);
      }
      hitRules.add(ref.rule);
      continue;
    }

    // 笔记这一支：同名笔记 → 学习卡 → 提醒 → 记忆，逐级降；全都对不上才谈"没匹配"。
    const exact = (ref.rule === "bare"
      ? bestByCoverage(noteRows, refTerms, (row) => row.title)
      : noteRows.find((row) => row.title === ref.text) ?? null);
    if (exact) {
      lines.push(renderNoteLine(exact, noteRuns.get(exact.id) ?? []));
      hitRules.add(ref.rule);
      continue;
    }
    const card = bestByCoverage(cardRows, refTerms, (row) => row.cue ?? "");
    if (card) {
      lines.push(`- 「${truncate(ref.text, 24)}」：没有同名笔记，但这个说法对得上学习卡《${truncate(card.cue ?? "", 24)}》（cardId=${card.card_id}）。`);
      hitRules.add(ref.rule);
      continue;
    }
    const reminder = bestByCoverage(reminderRows, refTerms, (row) => row.text);
    if (reminder) {
      lines.push(`- 「${truncate(ref.text, 20)}」：对得上一条待提醒（id=${reminder.id}，${reminder.fire_at_local} 提醒「${truncate(reminder.text, 20)}」）。`);
      hitRules.add(ref.rule);
      continue;
    }
    const memory = bestByCoverage(memoryRows, refTerms, (row) => row.content);
    if (memory) {
      lines.push(`- 「${truncate(ref.text, 20)}」：记忆里有一条相关记录（${memory.kind}）：${truncate(memory.content, 40)}`);
      hitRules.add(ref.rule);
      continue;
    }
    if (ref.rule === "bare") {
      // 裸标题漏接是安全方向：这一轮什么都不说，她照常调用检索工具（与今天一致）。
      continue;
    }
    const nearest = await findNearestNoteTitle(tx, scope, ref.text);
    lines.push(nearest
      ? `- 「${truncate(ref.text, 20)}」：这是用户当前这一屏上的对象，库里没有标题匹配的笔记；最接近的是《${truncate(nearest.title, 24)}》（相似度 ${nearest.score.toFixed(2)}）。没匹配不等于没有，要查就调用 companion_search_notes。`
      : `- 「${truncate(ref.text, 20)}」：这是用户当前这一屏上的对象，库里没有标题匹配的笔记。没匹配不等于没有，要查就调用 companion_search_notes。`);
    hitRules.add(ref.rule);
  }

  if (lines.length === 0) return null;
  const block = [
    "<this_turn_facts>",
    "用户这句话点到的对象，服务端刚查过（可以直接当事实用；这里没提到的对象不代表库里没有，别凭印象下结论）：",
    ...lines,
    "</this_turn_facts>",
  ].join("\n");
  return {
    block,
    definite: true,
    rule: [...hitRules].join(",") || null,
    ms: Date.now() - started,
    dropped: false,
  };
}
