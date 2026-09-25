/**
 * 伴星泄露闸的**身份表**（39d #28 的第一步）。
 *
 * 为什么先立表、后加列：G1..G11 这串号今天**只存在于重放台的 python 里**
 * （`scripts/companion-gate-counterfactual.py` 的 `GATE_DISPOSITION`），代码里没有这串号——
 * 判据是一段段导出的函数。于是台子与代码之间的对应**靠人对质**：改了判据、删了一道闸，
 * 台子不会知道，只会拿着旧的号继续读。要落"这一发产出于哪一版闸"那一列，
 * 前提是有一份代码读、台子也读的表。
 *
 * 版本**由表内容派生**，不是手写的 `v3`：没人 bump 的版本号比没有版本更坏
 * （它给出一个看似可归因、实则不动的标签）。
 *
 * `judge` 必须是真存在的导出名（用例逐条 import 去验）。这条钉子当场抓到一处：
 * 39b §10.1 写的是 `looksLikeTruncatedReply`，代码里其实叫 `looksTruncatedReply`。
 */
import { createHash } from "node:crypto";

export type CompanionLeakGateDispositionV1 = "keep" | "delete" | "conditional";

/** 判据所在的模块代号（worker 侧的用例把它映射到真文件去验导出名）。 */
export type CompanionLeakGateModuleV1 = "companion-dialogue-content" | "companion-thought";

export interface CompanionLeakGateV1 {
  readonly id: string;
  /** 判据函数的导出名。 */
  readonly judge: string;
  /**
   * 判据住在哪一个模块的**稳定代号**（不是文件路径）：这张表要给 API（写那一列）与
   * worker（跑判据、台子对质）共读，写死相对路径会让 shared 里出现 worker 路径；
   * "这些代号确实对应哪个文件"由 worker 侧那条用例把名字映射过去核。
   */
  readonly judgeModule: CompanionLeakGateModuleV1;
  /** 一句话：这一道管的是什么说法。 */
  readonly scope: string;
  readonly disposition: CompanionLeakGateDispositionV1;
  /** 处置的理由（从 39b §10.1 搬进来，不留两份）。 */
  readonly because: string;
}

const DIALOGUE = "companion-dialogue-content" as const;
const THOUGHT = "companion-thought" as const;

export const COMPANION_LEAK_GATES_V1: readonly CompanionLeakGateV1[] = [
  { id: "G1", judge: "unverifiedNumericClaims", judgeModule: DIALOGUE, scope: "正文里的数字与量词，比上下文集", disposition: "delete", because: "事实 span 落地后她能填的数字只剩服务端给的（W2-5）" },
  { id: "G2", judge: "claimsNothingDueAgainstFacts", judgeModule: DIALOGUE, scope: "谎称没有到期的", disposition: "keep", because: "环境块没解析出实体时仍会假阴性，属已知会漏" },
  { id: "G3", judge: "claimsLookupThatNeverRan", judgeModule: DIALOGUE, scope: "谎称我查过了", disposition: "delete", because: "假阴性的动机是手上什么都没有，P1 之后那句不再成立" },
  { id: "G4", judge: "looksLikeUnfulfilledActionNarration", judgeModule: DIALOGUE, scope: "答应了却没做", disposition: "conditional", because: "要与结构化分类器合判，删分类器那一步（P3）未做" },
  { id: "G5", judge: "looksTruncatedReply", judgeModule: DIALOGUE, scope: "半句或短到不成一句", disposition: "keep", because: "结构判据，且是 repair ladder 的唯一入口" },
  { id: "G6", judge: "unverifiedQuoteClaims", judgeModule: DIALOGUE, scope: "逐字引号对比来源集", disposition: "keep", because: "不因换措辞失效；来源集随 P2 多一项 fact_spans" },
  { id: "G7", judge: "containsCompanionInternalToken", judgeModule: DIALOGUE, scope: "内部标记、uuid、工具名漏到屏上", disposition: "keep", because: "词表应改成从注册表生成，防线本身留着" },
  { id: "G8", judge: "looksLikeJsonEnvelope", judgeModule: DIALOGUE, scope: "整封 JSON 信封当回复", disposition: "keep", because: "结构判据" },
  { id: "G9", judge: "looksLikeJsonFragment", judgeModule: DIALOGUE, scope: "半截 JSON", disposition: "keep", because: "流式路径唯一的防线" },
  { id: "G10", judge: "introducesUnverifiedNumbers", judgeModule: THOUGHT, scope: "念头里自己带出来的数字", disposition: "delete", because: "念头链也走 span，她不再抄数字" },
  { id: "G11", judge: "readsOutStatistics", judgeModule: THOUGHT, scope: "把统计量词念出来", disposition: "delete", because: "形状判据的极限：作品名里的数字必须放过" },
];

function canonical(gates: readonly CompanionLeakGateV1[]): string {
  return gates.map((gate) => [gate.id, gate.judge, gate.judgeModule, gate.scope, gate.disposition, gate.because]
    .join("\u0000")).join("\u0001");
}

/**
 * 闸版本：表内容 sha256 的前 16 位。落库时写它，读的人就知道那一发产出于哪一版闸。
 * 传别的表进来（台子做对照时用）也算得出来，所以它是纯函数、不藏全局状态。
 */
export function companionLeakGateVersionV1(
  gates: readonly CompanionLeakGateV1[] = COMPANION_LEAK_GATES_V1,
): string {
  return createHash("sha256").update(canonical(gates), "utf8").digest("hex").slice(0, 16);
}

export const COMPANION_LEAK_GATE_IDS_V1: readonly string[] = COMPANION_LEAK_GATES_V1.map((gate) => gate.id);
