/**
 * 反事实重放台的**判据执行桥**（39b §10 / 39d W1-1）。
 *
 * 为什么需要它：重放台要「不信任日志，重算」11 道输出闸，而这些判据**只能有一份实现**。
 * 把它们逐条翻译成 Python 正则是这条链上最贵的错法——`scripts/companion-quality-report.py`
 * 已经在注释里吃过一次同类亏（同一条判据在 TS 与 POSIX 正则里各写一份，元字符集不同，
 * 漏改的后果是**样本静默变少**而不是报错）。所以这里不翻译：直接 import 真函数。
 *
 * 分工：
 *   - 本桥（TS）：判据执行 + `contextText` 组装 + 环境块渲染 + 实体先行解析（P1），
 *     全部走真实现；
 *   - `scripts/companion-gate-counterfactual.py`（Python）：取数、P2 反事实模拟、
 *     触发分类与退出码。它不重写任何正则。
 *
 * P1 自 39d W2-3 起**不再由 Python 模拟**：环境块模式下本桥在同一事务里多跑一次
 * `loadThisTurnFacts`，把 `definite`（服务端是否给出了确定口径）与耗时一起回传，
 * Python 的 G3 分类直接读它。
 *
 * 输入（stdin，JSON）：
 *   {
 *     "activeness": "quiet" | "moderate" | "active",   // G5 字数线
 *     "turns": [{
 *       "runId": "...",
 *       "replyText": "...",            // 她的可见终答（companion_messages assistant 正文）
 *       "systemTexts": ["..."],        // system 消息原文；本桥按 keepRecomputedBlocks 收窄
 *       "ambient": {...} | null,       // HereAndNowSnapshot → 真 renderHereAndNow 渲染
 *       "userTexts": ["..."],          // 环境块模式下同一条 userText 也喂给 P1 解析器
 *       "toolResultTexts": ["..."]      // 本轮工具回执（G6 的出处比数字宽）
 *     }]
 *   }
 *
 * 输出（stdout，JSON）：同序的 `{ "turns": [{ "runId", "contextText", "quoteSources", "gates" }] }`。
 * 判据形状统一为 `{ "fired": boolean, "detail": ... }`；`detail` 只在能给出具体命中时有值。
 *
 * 只读：本桥不连库、不发模型请求。db.ts 的池在 import 时只是被构造（postgres.js 懒连接），
 * 全程没有一条查询发出。
 */
import { readFileSync, writeFileSync } from "node:fs";

import {
  claimsLookupThatNeverRan,
  claimsNothingDueAgainstFacts,
  containsCompanionInternalToken,
  keepRecomputedBlocks,
  looksLikeJsonEnvelope,
  looksLikeJsonFragment,
  looksLikeUnfulfilledActionNarration,
  looksTruncatedReply,
  unverifiedNumericClaims,
  unverifiedQuoteClaims,
  TRUNCATED_REPLY_MIN_CHARS,
} from "../src/handlers/companion-dialogue-content.ts";
import {
  introducesUnverifiedNumbers,
  readsOutStatistics,
  validateThoughtExpression,
} from "../src/handlers/companion-thought.ts";
import { FACT_SPAN_KEYS } from "../src/handlers/companion-fact-spans.ts";
import {
  loadHereAndNow,
  readLearningStats,
  renderHereAndNow,
  type HereAndNowSnapshot,
} from "../src/handlers/companion-here-and-now.ts";
import { loadThisTurnFacts } from "../src/handlers/companion-this-turn-facts.ts";
import { withWorkerWorkspaceTransaction } from "../src/db.ts";
import { COMPANION_LEAK_GATES_V1, companionLeakGateVersionV1 } from "@ailearn/shared/companion-leak-gates";

interface ReplayTurn {
  runId: string;
  replyText: string;
  systemTexts?: string[];
  ambient?: (Omit<HereAndNowSnapshot, "dueReviews"> & { dueReviews?: number }) | null;
  userTexts?: string[];
  toolResultTexts?: string[];
  /** 用户自己说的话（G10 的 allowedSource 里"用户说的话"那一半）。 */
  allowedNumberSource?: string;
  /** 念头气泡：G10／G11 的覆盖判定改读**产出侧守卫**（见 `thoughtGuardCovers`）。 */
  isThought?: boolean;
}

interface AmbientTurn {
  runId: string;
  workspaceId: string;
  userId: string;
  userText?: string;
  pageContext?: unknown;
  /** 规则④（上一轮工具结果里的显式 id）要按会话收窄，与运行时同一把尺。 */
  conversationId?: string | null;
}

interface ReplayInput {
  mode?: "gates" | "ambient" | "stats" | "spans";
  activeness?: string;
  turns: (ReplayTurn & Partial<AmbientTurn>)[];
}

function readStdin(): string {
  return readFileSync(0, "utf8");
}

/**
 * 结果出口。
 *
 * 为什么不直接写 stdout：worker 的 logger 是 pino（开发走 pino-pretty，默认 fd 1），
 * 环境块模式一旦连库，依赖链里任何一条 info 日志都会混进 stdout，把整份 JSON 截断在
 * 中间——调用方拿到的是一段"看起来像 JSON 但解析不了"的东西。所以给一个显式的
 * `--out <path>` 出口，stdout 留给日志。
 */
function emit(payload: string): void {
  const index = process.argv.indexOf("--out");
  const target = index >= 0 ? process.argv[index + 1] : undefined;
  if (target) writeFileSync(target, payload, "utf8");
  else process.stdout.write(payload);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * 环境块重建模式（`--ambient`）：用**真** `loadHereAndNow` 取快照、真 `renderHereAndNow`
 * 渲染，不改写任何取数 SQL。
 *
 * 边界（必须和调用方一起读）：`loadHereAndNow` 用的是 Postgres 的 `now()`，
 * 所以重建出来的是**重放时刻**的那一屏，不是历史那一刻的那一屏——历史环境块没有落库。
 * 同一账号的多轮因此共用同一份读数；这是数据条件，不是可以在这层修掉的缺陷。
 */
async function runAmbient(turns: AmbientTurn[]): Promise<void> {
  const out: Array<{
    runId: string;
    systemText: string;
    learningStats: unknown;
    ambient: unknown;
    p1Definite: boolean;
    p1Rule: string | null;
    factsMs: number;
    factsDropped: boolean;
  }> = [];
  for (const turn of turns) {
    const { snapshot, facts } = await withWorkerWorkspaceTransaction(
      { workspaceId: turn.workspaceId, userId: turn.userId },
      async (tx) => {
        const snapshot = await loadHereAndNow(tx, {
          workspaceId: turn.workspaceId,
          userId: turn.userId,
          conversationId: turn.conversationId ?? null,
          userText: turn.userText,
          pageContext: turn.pageContext,
        });
        // 与运行时同一次事务、同一个入口：重放台读到的就是线上会走的那份结果。
        const facts = await loadThisTurnFacts(tx, {
          workspaceId: turn.workspaceId,
          userId: turn.userId,
          conversationId: turn.conversationId ?? null,
          userText: turn.userText,
          liveView: snapshot.livePageView,
        });
        return { snapshot, facts };
      },
    );
    out.push({
      runId: turn.runId,
      // 与运行时一致：system 段里只有重算块算数字出处（companion-agent-runtime 的 contextText），
      // 而事实块也在那份块里（`keepRecomputedBlocks` 白名单），所以这里要一起拼上。
      systemText: [renderHereAndNow(snapshot), facts?.block ?? null].filter(Boolean).join("\n"),
      learningStats: snapshot.learningStats,
      ambient: snapshot,
      // P1 的真实结果：重放台的 G3 覆盖判定读它，不再自己用正则模拟。
      // 规则① 落在 `noteReference`（有它=服务端已经替她查过这个名字），②–⑤ 落在事实块。
      p1Definite: Boolean(facts?.definite) || snapshot.noteReference != null,
      p1Rule: facts?.rule ?? (snapshot.noteReference ? "bracket" : null),
      factsMs: facts?.ms ?? 0,
      factsDropped: facts?.dropped ?? false,
    });
  }
  emit(JSON.stringify({ turns: out }));
}

/**
 * 学习统计读数模式（`--stats`）：把**worker 侧真取数**（`readLearningStats`）暴露给
 * 跨包的对账测试。
 *
 * 为什么要走子进程而不是在 API 的测试里 import：两个包各有自己的 node_modules 与
 * 依赖图，跨包相对 import 会把对方的整条依赖链拖进来（AP psql/drizzle 都在，但那是
 * 巧合）。对账要的是"各自包里的真实现"，所以各跑各的进程——读的角色也随之各自成立
 * （这里是 `DATABASE_URL_WORKER`，受限角色）。
 */
async function runStats(turns: AmbientTurn[]): Promise<void> {
  const out: Array<{ runId: string; stats: unknown }> = [];
  for (const turn of turns) {
    const stats = await withWorkerWorkspaceTransaction(
      { workspaceId: turn.workspaceId, userId: turn.userId },
      (tx) => readLearningStats(tx, { workspaceId: turn.workspaceId, userId: turn.userId }),
    );
    out.push({ runId: turn.runId, stats });
  }
  emit(JSON.stringify({ turns: out }));
}

/**
 * 读数目录的**真实键表**（39d W2-5）：Python 侧不再自己写一份量词表。
 * 键与量词都来自 `companion-fact-spans.ts`，加键/改量词只动那一处。
 */
function runGates(): void {
  // 闸身份表与它的派生版本（39d #28）。台子拿这份**与自己那份 GATE_DISPOSITION 对质**：
  // 今天两边靠人对，改了判据或删了一道闸，台子不会知道。
  emit(JSON.stringify({ version: companionLeakGateVersionV1(), gates: COMPANION_LEAK_GATES_V1 }));
}

function runSpans(): void {
  emit(JSON.stringify({ keys: FACT_SPAN_KEYS }));
}

async function main(): Promise<void> {
  const input = JSON.parse(readStdin()) as ReplayInput;
  if (input.mode === "ambient") {
    await runAmbient((input.turns ?? []) as AmbientTurn[]);
    return;
  }
  if (input.mode === "stats") {
    await runStats((input.turns ?? []) as AmbientTurn[]);
    return;
  }
  if (input.mode === "spans") {
    runSpans();
    return;
  }
  if (input.mode === "gates") {
    runGates();
    return;
  }
  const activeness = input.activeness ?? "active";
  const minChars = TRUNCATED_REPLY_MIN_CHARS[activeness] ?? TRUNCATED_REPLY_MIN_CHARS.active;

  const out = (input.turns ?? []).map((turn) => {
    const systemBlocks = asStringArray(turn.systemTexts)
      .map((text) => keepRecomputedBlocks(text))
      .filter((text) => text.length > 0);
    let ambientBlock: string | null = null;
    if (turn.ambient) {
      const snapshot: HereAndNowSnapshot = {
        ...turn.ambient,
        dueReviews: turn.ambient.dueReviews ?? 0,
      } as HereAndNowSnapshot;
      ambientBlock = renderHereAndNow(snapshot);
    }
    const userTexts = asStringArray(turn.userTexts);
    const contextText = [...systemBlocks, ...(ambientBlock ? [ambientBlock] : []), ...userTexts].join("\n");
    const toolResultTexts = asStringArray(turn.toolResultTexts);
    const quoteSources = [contextText, ...toolResultTexts].join("\n");
    const said = turn.replyText ?? "";

    const numericClaims = unverifiedNumericClaims(said, contextText);
    const quoteClaims = unverifiedQuoteClaims(said, quoteSources);

    return {
      runId: turn.runId,
      contextText,
      quoteSources,
      // 念头链：G10／G11 的同名判据**已经在产出侧执行**（`validateThoughtExpression`
      // 与送达前的 `readsOutStatistics` 抑制）。这条字段回答的是"这条气泡在新机制下
      // 还会不会被交付"——`true` = 会被当场拒掉／抑制 ⇒ 后置闸的这次触发是重复的。
      thoughtGuardCovers: turn.isThought === true
        ? !validateThoughtExpression(said, [], turn.allowedNumberSource ?? "") || readsOutStatistics(said)
        : false,
      gates: {
        // A 类：只在"整轮零工具调用"时才有意义（调用方按硬前提筛选）。
        G1: { fired: numericClaims.length > 0, detail: numericClaims },
        G2: { fired: claimsNothingDueAgainstFacts(said, contextText) },
        G3: { fired: claimsLookupThatNeverRan(said) },
        G4: { fired: looksLikeUnfulfilledActionNarration(said) },
        G6: { fired: quoteClaims.length > 0, detail: quoteClaims },
        // A′：结构闸，前提是"这一步一个字都没下发过"。
        G5: { fired: looksTruncatedReply(said, minChars), minChars },
        // B 类：输出形状，与工具无关。
        G7: { fired: containsCompanionInternalToken(said) },
        G8: { fired: looksLikeJsonEnvelope(said) },
        G9: { fired: looksLikeJsonFragment(said) },
        // C 类：念头链（那里根本没有工具）。allowedSource 取用户原话 + 用户视图。
        G10: {
          fired: introducesUnverifiedNumbers(said, turn.allowedNumberSource ?? ""),
          sourceChars: (turn.allowedNumberSource ?? "").length,
        },
        G11: { fired: readsOutStatistics(said) },
      },
    };
  });

  emit(JSON.stringify({ activeness, minChars, turns: out }));
}

main().then(
  // 判据模式不连库；环境块模式连过库，池不释放事件循环 —— 显式收尾。
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
