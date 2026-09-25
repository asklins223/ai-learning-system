/**
 * 伴星对话的流式下发管线（2026-09-19）。
 *
 * 背景：运行时此前是"整段取回 + 事后切片"（executeAgentTurn + writeBatchedDeltas），
 * `assistant.delta` 只是在终态前把全文补写成事件——客户端永远看不到渐进内容，
 * 回复只能"憋一大口再吐出来"。本模块把 provider 的**真实增量**变成稳定的可见
 * 前缀，边生成边落库（SSE 直推渲染层，逐句开口成为可能）。
 *
 * 两条不变量：
 * 1. **先验后发**：每个 flush 前对累积原文跑增量校验（长度/内部 token 泄露），
 *    失败即终止本轮流式（run 按失败收尾），不会把未过检的内容发给客户端；
 * 2. **前缀稳定**：只发"不会再被 markdown/标签净化改写"的部分（stableVisibleCut），
 *    因此流式期间客户端累积的文本永远是最终 assistant 文本的前缀，终态不会出现
 *    内容回跳。markdown/标签/信封这些全文语义在流结束时由 validateCompanionOutput 兜底。
 */

import { sql } from "drizzle-orm";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import {
  chunkTextIntoDeltas,
  companionOutputRejectionReason,
  looksLikeJsonFragment,
  sanitizeCompanionVisibleText,
} from "./companion-dialogue-content.ts";
import { resolveFactSpans, withholdPartialFactSpanTail, type FactSpanValues } from "./companion-fact-spans.ts";
import type { ReadContext } from "./companion-dialogue-store.ts";

/** 行内标记：出现在哪里都可能被后续文本配对改写。 */
const INLINE_UNSTABLE_CHARS = "*_~`[]()";
/** 行首标记：只有落在行首才参与改写（`- 列表`、`### 标题`、``` 围栏）。 */
const LINE_START_UNSTABLE_CHARS = "#>-+|";

/** 当前行是否已经不携带可能被改写的标记。 */
function lineIsStable(line: string): boolean {
  if (line.length === 0) return true;
  if (LINE_START_UNSTABLE_CHARS.includes(line[0])) return false;
  for (const char of INLINE_UNSTABLE_CHARS) {
    if (line.includes(char)) return false;
  }
  return true;
}

/**
 * 完整占位符（`{{f:today_minutes}}`）在判稳定之前先**遮成等长中性字符**。
 *
 * 为什么必须遮：`today_minutes` 里的下划线是 markdown 强调符，按行内不稳定字符处理，
 * 于是"整行含占位符 ⇒ 整行压住等下一个换行"——而伴星回复 p50 只有 40 字、常常一整条
 * 没有换行，等于**带占位符的回复彻底退回"憋一大口再吐出来"**（那正是流式管线要修的）。
 * 遮成等长（`x`）是关键：切点是原文的下标，长度一变就对不上了。
 * 没写完的 `{{f:today_min` **不遮**——它本来就该被压住，等它长完。
 */
const COMPLETE_FACT_SPAN = /\{\{\s*f:\s*[a-z_]{2,40}\s*\}\}/g;

function maskCompleteFactSpans(line: string): string {
  return line.replace(COMPLETE_FACT_SPAN, (match) => "x".repeat(match.length));
}

/**
 * 稳定可见前缀的切点（在 trimStart 后的原文上计算）。
 *
 * 规则：**行边界之后、标记干净的内容可以立刻下发**。
 * - markdown/标签规则要么是行内的（`**粗**`、`[tag]`、`` `code` ``），要么是行首的
 *   （`- 列表`、`### 标题`、``` 围栏）——已完成的行不会再被后续文本改写，
 *   所以以最后一个换行为界天然安全；
 * - 当前还没结束的行只有在**不含任何标记字符**时才整行下发（干净 ⇒ 没有规则
 *   能匹配上，发出去就是最终文本的一部分）；
 * - 含标记的当前行留到下一行到来（或流结束）再发，最多压住一行，不会长期停滞。
 */
export function stableVisibleCut(raw: string): number {
  const lineStart = raw.lastIndexOf("\n") + 1;
  if (lineIsStable(raw.slice(lineStart)) || lineIsStable(maskCompleteFactSpans(raw.slice(lineStart)))) {
    return raw.length;
  }
  return lineStart;
}

/** 信封守卫：原文以 `{`/`[` 开头时不做流式下发，整段交给全文校验/解包兜底。 */
function looksLikeEnvelopeHead(raw: string): boolean {
  const head = raw.trimStart()[0];
  return head === "{" || head === "[";
}

/**
 * 交付管线要求停止时抛出的错误（校验失败 / fence 失联）。
 *
 * 单独一个类型是为了让对话 handler 能把它与 provider 故障区分开：前者按
 * "本轮不可重试的失败"收尾（重试不会让泄露消失），后者走既有的可重试分类。
 */
export class CompanionStreamStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanionStreamStoppedError";
  }
}

/**
 * 当前可安全下发的可见前缀（trimStart 后按稳定切点净化 + 读数占位符渲染）。
 *
 * 顺序是有讲究的：先净化（剥控制符/标签/孤立标点），再**扣住结尾没写完的占位符**
 * （`…今天学了{{f:today_min`），最后渲染——不扣住的话用户会先看到半个标记，
 * 下一拍再看到它变成数字。
 */
export function companionVisibleText(raw: string, factSpanValues?: FactSpanValues): string {
  const trimmed = raw.trimStart();
  const cut = stableVisibleCut(trimmed);
  const sanitized = sanitizeCompanionVisibleText(trimmed.slice(0, cut));
  if (!factSpanValues) return sanitized;
  return resolveFactSpans(withholdPartialFactSpanTail(sanitized), factSpanValues).text;
}

export type CompanionVisibleProjection =
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "envelope_guarded" }
  | { readonly kind: "visible"; readonly text: string };

/**
 * 累积原文 → 当前能下发的可见文本（纯函数，流式状态机的全部判断都在这里）。
 *
 * - `rejected`：增量校验命中（长度/泄露）→ 调用方终止本轮；
 * - `envelope_guarded`：原文以 `{`/`[` 开头（JSON 信封），不发任何流式内容；
 * - `visible`：稳定前缀（可能为空串——尾巴还没稳定）。
 */
export function projectCompanionVisible(raw: string, factSpanValues?: FactSpanValues): CompanionVisibleProjection {
  const rejection = companionOutputRejectionReason(raw);
  if (rejection) return { kind: "rejected", reason: rejection };
  if (looksLikeEnvelopeHead(raw)) return { kind: "envelope_guarded" };
  // 无头 JSON 残片（2026-09-19 T3）：头部防线只管"带头/完整的信封"，而信封被从
  // 中间截断后剩下的尾巴（`213, 609]`、`content":"…"}`）根本不以 `{`/`[` 开头，
  // 会被当成普通文本一路下发——用户眼里就是"输出乱码"。这里就地拦停：
  // 判 rejected（而不是 envelope_guarded），因为残片没有可靠的信封头可解析，
  // 整段下发给全文校验也解不出正文，只会白等一轮。
  if (looksLikeJsonFragment(raw)) return { kind: "rejected", reason: "json_envelope_leak" };
  return { kind: "visible", text: companionVisibleText(raw, factSpanValues) };
}

export type CompanionStreamFinish =
  | { ok: true; text: string }
  | { ok: false; reason: string };

export interface CompanionStreamDelivery {
  /**
   * provider 原始增量。返回 false = 本轮流式已终止（校验失败/落库失联），
   * 调用方应停止消费并让 run 按失败收尾。
   */
  onRawDelta(rawDelta: string): Promise<boolean>;
  /** 流结束：把当前稳定前缀的剩余部分落库，返回已下发文本。 */
  finish(): Promise<CompanionStreamFinish>;
  /**
   * 补齐尾部：全文净化后可能比已下发的稳定前缀多出结尾（最后一个未闭合标记被
   * 剥掉、信封守卫整段兜底等）。差值走同一条 delta 管线，保证
   * "delta 拼接 == 终态 assistant 文本"。
   */
  writeTail(fullText: string): Promise<boolean>;
  /** 已经下发的可见字符数（测试/诊断）。 */
  deliveredChars(): number;
  /**
   * 已经下发的可见文本本体。
   *
   * 失败收尾要用它留档：一轮失败之后，用户看到过的那半句必须留在历史里
   * （见 `companion-dialogue.ts` 的 `persistFailedPartial`），而"看到过多少"
   * 只有交付管线自己知道。
   */
  deliveredText(): string;
  /** 终止原因（校验失败时非空）。 */
  failureReason(): string | null;
}

interface CompanionDeliveryArgs {
  ctx: { workspaceId: string };
  read: ReadContext;
  expiresAt: string;
  notifyCompanionEvent: (tx: { execute(q: unknown): Promise<unknown> }, seq: number) => Promise<void>;
  /** 本轮可报读数的目录（39d W2-5）：下发前渲染 `{{f:key}}`；缺省 = 不渲染。 */
  factSpanValues?: FactSpanValues;
  /** 落库节流：可见字符累积到这么多、或距上次落库超过这么久才写一次。 */
  flushChars?: number;
  flushIntervalMs?: number;
  /**
   * 落库实现（测试注入用）：缺省走 worker 事务写 `assistant.delta`。
   * 注入后不碰数据库，用于验证节流/切片/补齐的拼接语义（不重不漏）。
   */
  writeVisible?: (text: string, appendFrom: number) => Promise<boolean>;
  /**
   * 可见 delta 已经通过 fence 并落库后的通知。语音分段在这里消费真实提交前缀，
   * 从而保证每个 voice.segment.ready 永远排在对应 assistant.delta 之后。
   */
  onVisibleCommitted?: (committedText: string, fullVisibleText: string) => Promise<void>;
}

/**
 * 落库节流阈值（2026-09-19 ④ 调整：96 字 / 200ms → 24 字 / 90ms）。
 *
 * 伴星回复实测 p50 = 40 字：96 字的阈值意味着**绝大多数轮次在流结束前一个字都不落库**，
 * 全部文本挤在 finish() 那一次 flush 里 → 库里每个 run 只有 1 条 `assistant.delta`、
 * 时间跨度 0.00 秒，客户端看到的就是"憋一大口再吐出来"。降到 24 字 / 90ms 后，一条
 * 40 字回复能分 2–3 步显现（首个 flush 本来就是立即的），朗读也可以随第一句就开始。
 *
 * 代价是短回复的落库事务变多（40 字约 3 次 vs 之前 1 次）；相对"看起来像一整块"的
 * 体验问题，这个代价值得。
 */
const DEFAULT_FLUSH_CHARS = 24;
const DEFAULT_FLUSH_INTERVAL_MS = 90;
const DELTAS_PER_TX = 4;

export function createCompanionStreamDelivery(args: CompanionDeliveryArgs): CompanionStreamDelivery {
  const flushChars = args.flushChars ?? DEFAULT_FLUSH_CHARS;
  const flushIntervalMs = args.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

  let raw = "";
  /** 信封守卫命中后不再产生任何可见输出（整段留给 finish 兜底）。 */
  let envelopeGuarded = false;
  /** 已下发的可见文本（永远是最终文本的前缀）。 */
  let delivered = "";
  /** 已写入的 delta 条数（与库中行数对账，desync 时 fail closed）。 */
  let writtenDeltas = 0;
  let pendingText = "";
  let lastFlushAt = 0;
  let failure: string | null = null;

  async function writeDeltas(text: string): Promise<boolean> {
    const chunks = chunkTextIntoDeltas(text, 256);
    if (chunks.length === 0) return true;
    const base = delivered.length;
    for (let i = 0; i < chunks.length; i += DELTAS_PER_TX) {
      const batch = chunks.slice(i, i + DELTAS_PER_TX);
      const written = await withWorkerWorkspaceTransaction(
        { workspaceId: args.ctx.workspaceId, userId: args.read.userId },
        async (tx) => {
          const alive = await tx.execute<{ id: string }>(sql`
            UPDATE companion_turn_runs
            SET status = 'running', updated_at = now()
            WHERE id = ${args.read.runId} AND status IN ('accepted', 'running')
              AND generation = ${args.read.generation}
            RETURNING id
          `);
          if (!alive[0]) return false;
          const countRows = await tx.execute<{ n: string }>(sql`
            SELECT count(*)::int AS n FROM companion_stream_events
            WHERE conversation_id = ${args.read.conversationId}
              AND run_id = ${args.read.runId} AND type = 'assistant.delta'
          `);
          const existing = Number(countRows[0].n);
          if (existing >= writtenDeltas + chunks.length) return true;
          if (existing !== writtenDeltas + i) {
            throw new Error(`companion delta stream desync: written=${existing} expected=${writtenDeltas + i}`);
          }
          const counters = await tx.execute<{ next_event_seq: string }>(sql`
            UPDATE companion_conversations
            SET next_event_seq = next_event_seq + ${batch.length}
            WHERE id = ${args.read.conversationId}
            RETURNING next_event_seq
          `);
          const endSeq = Number(counters[0].next_event_seq) - 1;
          const startSeq = endSeq - batch.length + 1;
          await tx.execute(sql`
            INSERT INTO companion_stream_events
              (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
            VALUES ${sql.join(batch.map((chunk, j) => sql`(
              ${args.read.conversationId}, ${startSeq + j}, ${args.ctx.workspaceId}, ${args.read.userId},
              ${args.read.runId}, ${args.read.generation}, ${args.read.accountEpoch}, 'assistant.delta',
              ${JSON.stringify({ appendFrom: base + chunk.appendFrom, textDelta: chunk.textDelta })},
              ${args.expiresAt}
            )`), sql`, `)}
          `);
          await args.notifyCompanionEvent(tx, endSeq);
          return true;
        },
      );
      if (!written) return false;
      // 批次间的 50ms 节流只在流式中用于避免打满连接池；末批不等待。
      if (i + DELTAS_PER_TX < chunks.length) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    writtenDeltas += chunks.length;
    return true;
  }

  /**
   * 把当前稳定前缀与"已下发 + 已排队"文本的差值落库。
   *
   * 切片基准必须是 `delivered + pendingText`：节流窗口内多次 flushVisible 会把
   * 同一个 `delivered` 当成起点，只减 `delivered` 会把这段窗口里的文本重复追加
   * （2026-09-19 实机复现：delta 里出现"是软乎乎的是软乎乎的…"式叠加）。
   */
  async function flushVisible(visible: string, force: boolean): Promise<boolean> {
    const delta = visible.slice(delivered.length + pendingText.length);
    if (delta.length > 0) pendingText += delta;
    // 注意：`force` 也必须把**已排队未落库**的部分写掉——finish/补齐尾部时
    // pending 里可能正躺着全部剩余文本（此时 delta 为空，不能就此返回）。
    if (pendingText.length === 0) return true;
    const now = Date.now();
    if (!force && pendingText.length < flushChars && now - lastFlushAt < flushIntervalMs) {
      return true;
    }
    const toWrite = pendingText;
    pendingText = "";
    lastFlushAt = now;
    const ok = args.writeVisible
      ? await args.writeVisible(toWrite, delivered.length)
      : await writeDeltas(toWrite);
    if (ok) {
      delivered += toWrite;
      await args.onVisibleCommitted?.(toWrite, delivered);
    }
    return ok;
  }

  /** 当前可下发的可见前缀；信封守卫命中后恒为空串（整段留给 finish 兜底）。 */
  function currentVisible(): string {
    if (envelopeGuarded) return "";
    const projection = projectCompanionVisible(raw, args.factSpanValues);
    return projection.kind === "visible" ? projection.text : "";
  }

  return {
    async onRawDelta(rawDelta: string): Promise<boolean> {
      if (failure) return false;
      raw += rawDelta;
      const projection = projectCompanionVisible(raw, args.factSpanValues);
      if (projection.kind === "rejected") {
        failure = projection.reason;
        return false;
      }
      if (projection.kind === "envelope_guarded") {
        // 模型把回复包成 JSON 信封：流式语法会原样吐给用户，整段守住不发，
        // 交给 finish 的解包 + 全文校验（退化为一次性下发）。
        envelopeGuarded = true;
        return true;
      }
      return flushVisible(projection.text, false);
    },

    async finish(): Promise<CompanionStreamFinish> {
      if (failure) return { ok: false, reason: failure };
      const ok = await flushVisible(currentVisible(), true);
      if (!ok) return { ok: false, reason: "delta_stream_lost" };
      return { ok: true, text: delivered };
    },

    async writeTail(fullText: string): Promise<boolean> {
      if (failure) return false;
      if (!fullText.startsWith(delivered)) return false;
      const ok = await flushVisible(fullText, true);
      return ok && delivered === fullText;
    },

    deliveredChars(): number {
      return delivered.length;
    },

    deliveredText(): string {
      return delivered;
    },

    failureReason(): string | null {
      return failure;
    },
  };
}

/**
 * 流式下发的最终一致化：把 finish 给出的可见文本与全文校验结果对齐。
 *
 * 为什么需要：流式期间下发的是"稳定前缀"，全文校验（markdown/标签净化 + 信封拒绝）
 * 可能剥掉前缀之外的字符，也可能判定整轮失败。这里返回最终 assistant 文本
 * ——它必须以已下发内容开头，否则说明两条路径漂移了，按失败处理（宁可重试，
 * 也不要给客户端一个前后不一致的回复）。
 */
export function reconcileStreamedText(args: {
  delivered: string;
  validated: { ok: true; text: string } | { ok: false; reason: string };
}): { ok: true; text: string } | { ok: false; reason: string } {
  if (!args.validated.ok) return args.validated;
  if (!args.validated.text.startsWith(args.delivered)) {
    return { ok: false, reason: "stream_full_text_diverged" };
  }
  return { ok: true, text: args.validated.text };
}
