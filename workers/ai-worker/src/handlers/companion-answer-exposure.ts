/**
 * 她自己就是泄露源时，服务端替她记账（39b §9.7 / D7 §6；39d W2-6）。
 *
 * 补的是那条**无损绕过**：用户在作答页问她一句"这道题的条件是什么"，她把题面复述一遍，
 * 然后回主页面把题答完——那条回答在记录上仍然是"未借助"。答案暴露在本项目里**早就有表**
 * （`learning_exposures_v2`，7 个写入方），缺的只有她这一头没往里写。
 *
 * 三条设计约束（都写在 D7 §6，这里逐条落地）：
 *
 *   1. **写入门在服务端，不在她嘴里**——她不持有"我泄露了"这个工具；那等于让她决定
 *      要不要记账。这里在她这一轮的终答落到历史的同时判、同时写。
 *   2. **判据是集合关系**（G6 逐字比对的**反向用法**）：不是"她引的话在不在上下文里"，
 *      而是"这一题的题面/答案有多少连续出现在她这句话里"。
 *   3. **幂等直接用现成唯一键** `lex_v2_idem_unique (workspace_id, user_id, idempotency_key)`
 *      ——重发、job 重试都不许记成两次暴露，不另建去重。
 *
 * 已知会漏的那一半（诚实登记，不是遗漏）：**改述、图示、语音**同样可能给出帮助，而这里
 * 判的是连续重合。39b §5 明说"不用『答案原文是回复的子串』当唯一判据"，所以本模块给的是
 * **判据形状 + 阈值常量**（D7 §10 的未决项：阈值由台账读数标定），漏报由两处读点兜住：
 * 提示按钮那条路本来就有自己的写入方。
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { computeExposureScopeIdV2 } from "@ailearn/shared/card-generation-v2-hashing";
import type { WorkerTransaction } from "../db.ts";
import type { FormalAnswerTarget } from "../lib/formal-answer-signal.ts";
import type { LivePageView } from "./companion-live-view.ts";

/** 连续重合多少个字算"把话递到用户眼前了"（D7 §10 的未决项，先给确定形状再拿读数标定）。 */
/**
 * 「用户此刻在作答页」——记账的**入口条件**（D7 §6 的 `interactionState ===
 * "formal_answer"`）。
 *
 * 判据取自实时那一行（`assistant_page_contexts`，经 `readLivePageView` 一次读），
 * **不取** `run.page_context`：那一列是 API `sanitizeContext` 收窄后的审计字段，
 * 只有 pageKind/sharing/revision 三个键，从来没有 `interactionState`。拿它当入口
 * 条件的写法会一直"绿"，因为那个字段永远读不到——而它一旦读到假的，就是把
 * "在笔记页引用原文"记成泄露。
 *
 * 为什么不能只看服务端"有没有正式题目在进行"：那会把**在笔记页引用原文**也记成泄露。
 * 学习卡题面是从笔记里抽出来的，她照实念一段原文就可能与题面重合 8 个字——
 * 记一笔就会压低用户下一次独立作答的资格，那是"误判"方向，D7 §3 明写不允许
 * （"普通鼓励、重复题面不自动算答案暴露"）。
 *
 * `expectedRunId` 给了就必须对上：页面说自己在那一轮作答，就得是**那一轮**的题，
 * 不然会把暴露记到另一道题的目标版本上。
 */
export function isFormalAnswerLivePage(
  view: Pick<LivePageView, "pageKind" | "interactionState" | "learningRunId"> | null,
  expectedRunId?: string | null,
): boolean {
  if (!view) return false;
  if (view.pageKind !== "learning_run" || view.interactionState !== "formal_answer") return false;
  if (!expectedRunId) return true;
  return view.learningRunId === expectedRunId;
}

export const EXPOSURE_OVERLAP_MIN_CHARS = 8;

/** 题面被复述掉多少算"条件本体给了"——短题面按比例判，长题面按上面那条字数判。 */
export const EXPOSURE_PROMPT_COVERAGE_MIN = 0.6;

export type AnswerExposureKind = "answer_reveal" | "evidence_reveal";

export interface AnswerExposure {
  readonly kind: AnswerExposureKind;
  readonly overlapChars: number;
  readonly promptCoverage: number;
}

/**
 * 比之前先归一化：空白、标点、大小写都不算差异。
 *
 * 她复述题面时几乎不可能逐字——多一个空格、换个破折号就该判成"没重合"的话，
 * 这台记账基本不会响。数字与拉丁字母保留（它们是条件的实质内容）。
 */
function normalizeForOverlap(text: string): string {
  return text
    .replace(/[\s　]+/g, "")
    // 注意**不**剥下划线与连字符：`created_at` 这种标识符里的 `_` 是有意义的，
    // 剥掉会把两个标识符粘成一个（createdat），凭空多出 9 个字符的"重合"，
    // 于是题面与答案只要都提到同一个列名就互相判成泄露。
    .replace(/[，。、；：！？,.;:!?“”"'`·—–~～()（）《》〈〉「」【】[\]{}<>|*-]/g, "")
    .toLowerCase();
}

/** 两段文本的**最长连续重合**长度（归一化后按字符计）。 */
export function longestOverlap(haystack: string, needle: string): number {
  const a = normalizeForOverlap(haystack).slice(0, 1_200);
  const b = normalizeForOverlap(needle).slice(0, 1_200);
  if (a.length === 0 || b.length === 0) return 0;
  let best = 0;
  // 上一行的匹配长度滚动数组：每格是"a 的前 i 个 与 b 的前 j 个 的公共后缀长度"。
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] !== b[j - 1]) continue;
      current[j] = previous[j - 1] + 1;
      if (current[j] > best) best = current[j];
    }
    previous = current;
  }
  return best;
}

/**
 * 她这句话算不算把这一题的东西说出去了，以及算哪一档。
 *
 * 两档的分别照 39b §9.7：**答案本体**（canonical answer 原文，或题面/条件被整句复述）
 * 记 `answer_reveal`；只碰到**线索级**（这一题在学什么的粗描述，屏上本来就写着）
 * 记 `evidence_reveal`。两档的信任后果都已在库里，不发明新语义。
 */
export function assessAnswerExposure(args: {
  replyText: string;
  taskPrompt: string | null;
  publicSummary: string | null;
  canonicalAnswer: string | null;
}): AnswerExposure | null {
  const reply = args.replyText;
  const answerOverlap = args.canonicalAnswer ? longestOverlap(reply, args.canonicalAnswer) : 0;
  const promptOverlap = args.taskPrompt ? longestOverlap(reply, args.taskPrompt) : 0;
  const promptChars = normalizeForOverlap(args.taskPrompt ?? "").length;
  const promptCoverage = promptChars > 0 ? promptOverlap / promptChars : 0;
  // 只有**答案原文**被复述才记答案本体那一档。题面/条件被念回去记线索那一档：
  // D7 §3 明写"重复题面不自动算答案暴露"，而 §6 的分档也是"给出本题答案本体"才算
  // answer_reveal（两处措辞在源文档里就不一致，这里按更严的判据走，差异已登记进 39d）。
  if (answerOverlap >= EXPOSURE_OVERLAP_MIN_CHARS) {
    return { kind: "answer_reveal", overlapChars: answerOverlap, promptCoverage };
  }
  if (promptOverlap >= EXPOSURE_OVERLAP_MIN_CHARS || promptCoverage >= EXPOSURE_PROMPT_COVERAGE_MIN) {
    return { kind: "evidence_reveal", overlapChars: promptOverlap, promptCoverage };
  }
  // 线索级按"整句被念回去"判，不按固定字数：publicSummary 天生就短（"索引的选择性"
  // 只有 6 个字），拿 8 字当阈值等于这一档永远不会成立。
  const summaryChars = normalizeForOverlap(args.publicSummary ?? "").length;
  const summaryOverlap = args.publicSummary ? longestOverlap(reply, args.publicSummary) : 0;
  if (summaryChars >= 4 && summaryOverlap >= summaryChars) {
    return { kind: "evidence_reveal", overlapChars: summaryOverlap, promptCoverage };
  }
  return null;
}

export interface RecordExposureArgs {
  workspaceId: string;
  userId: string;
  /** 伴星这一轮的 id：幂等键用它，所以 job 重试与"同一条消息重发"都只记一笔。 */
  companionRunId: string;
  target: FormalAnswerTarget;
  kind: AnswerExposureKind;
}

/**
 * 写一行暴露账目。返回 false = 撞了幂等键（这一轮已经记过）。
 *
 * 两个不能省的细节：
 *   - **RLS 对 `ailearn_worker` 形同不存在**（该表策略带 `CURRENT_USER='ailearn_worker'`
 *     分支），所以 workspace/user 条件必须由 SQL 自己带——这里的值全部来自
 *     调用方按 (workspace, user) 取到的那一行，不接受任何外部传入的 id。
 *   - 没有 objective 身份（快照缺失）时**不写**：这一列是 NOT NULL，硬塞一个假目标
 *     等于往"这一题的独立判定资格"里注水（那张表会被读回去算冷却窗口）。
 */
export async function recordCompanionAnswerExposure(
  tx: WorkerTransaction,
  args: RecordExposureArgs,
): Promise<boolean> {
  const { objectiveId, objectiveRevision } = args.target;
  if (!objectiveId || objectiveRevision == null) return false;
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO learning_exposures_v2
      (id, workspace_id, exposure_id, user_id, objective_id, objective_revision,
       card_id, card_revision, exposure_kind, context_hash, idempotency_key, exposed_at)
    VALUES
      (${randomUUID()}, ${args.workspaceId}, ${randomUUID()}, ${args.userId},
       ${objectiveId}, ${objectiveRevision}, ${args.target.cardId}, ${args.target.cardRevision},
       ${args.kind},
       ${computeExposureScopeIdV2({ workspaceId: args.workspaceId, objectiveId })},
       ${`companion-turn:${args.companionRunId}`}, now())
    ON CONFLICT (workspace_id, user_id, idempotency_key) DO NOTHING
    RETURNING id
  `);
  return (Array.isArray(inserted) ? inserted : []).length > 0;
}
