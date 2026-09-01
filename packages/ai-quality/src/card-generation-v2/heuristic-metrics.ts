/**
 * AI 设计审查 §4.5 修复（2026-08-24）：中文启发式规则误判面量化。
 *
 * 背景：确定性校验里两处依赖中文表面特征的启发式，其假阳/假阴率此前从未被
 * 量化（审查原文 §4.5）。本模块建立一批人工标注的中文样本，直接调用仓库内
 * 真实的启发式实现度量准确率，并用测试钉住：
 *
 * 1. objective atomicity 连词规则（card-generation-v2-pipeline/
 *    deterministic-gates.ts 的 objectiveAtomicityGate）：2026-08-24 起**降级
 *    为 soft 风险信号**——「是否拼接多个独立学习目标」是语义判断，正则残余
 *    假阳不可归零（首轮量化实测裸匹配 8/12 假阳；按样本收紧只是循环论证）。
 *    hard 裁决归 Pedagogy Critic（multiple_learning_objectives）。本集现在
 *    度量的是软信号的**查准率**（应拦截样本中命中风险信号的比例，越高越好）
 *    与**误报率**（应放行样本中的命中比例——允许非零，但钉住上限防恶化）。
 *
 * 2. front 泄题：hard 判定只保留「逐字照抄」（压缩标点后 ≥12 连续字符同一，
 *    语言无关的机械事实）；改写式泄漏归 Pedagogy Critic。本集钉住：leak 类
 *    （含照抄与近抄）hard 命中率、clean 类零 issue、soft-only 类不得触发 hard。
 *
 * 夹具全部人工标注；指标劣化时测试直接失败，形成回归门禁。
 */

import { objectiveAtomicityGate, frontLeakageGate } from "./heuristic-adapters.ts";

// ─── 样本类型 ────────────────────────────────────────────────────────────

export interface AtomicitySample {
  id: string;
  statement: string;
  /** 人工标注：true = 应判为非原子（拼接多目标），false = 应放行（原子）。 */
  expectConcatenated: boolean;
  /** 标注理由（可读性；不参与计算）。 */
  note: string;
}

export interface LeakSample {
  id: string;
  /** 卡片正面（cue + prompt 拼接后的小写规范化文本）。 */
  frontText: string;
  /** 答案全文（canonical answer 文本）。 */
  answerText: string;
  /**
   * 人工标注的期望结果：
   * - "leak"：应产生 front_leaks_answer（hard）；
   * - "clean"：应无任何 issue；
   * - "soft-only"：至多 surface_paraphrase_only（soft 风险信号），不得 hard。
   */
  expectation: "leak" | "clean" | "soft-only";
  note: string;
}

export interface HeuristicMetric {
  /** 人工标注应拦截（expect=true）且确实拦截 → 正确。 */
  truePositive: number;
  /** 人工标注应放行（expect=false）但被拦截 → 假阳（误杀）。 */
  falsePositive: number;
  /** 人工标注应拦截但被放行 → 假阴（漏放）。 */
  falseNegative: number;
  /** 人工标注应放行且确实放行 → 正确。 */
  trueNegative: number;
}

export interface HeuristicReport {
  samples: number;
  metric: HeuristicMetric;
  /** 假阳率 = FP / (FP + TN)（应放行样本中被误杀的比例）。 */
  falsePositiveRate: number;
  /** 假阴率 = FN / (FN + TP)（应拦截样本中漏掉的比例）。 */
  falseNegativeRate: number;
  /** 每个 mismatch 的样本 ID 与方向（调试用）。 */
  mismatches: Array<{ id: string; direction: "fp" | "fn" }>;
}

function summarize(
  samples: number,
  metric: HeuristicMetric,
  mismatches: Array<{ id: string; direction: "fp" | "fn" }>,
): HeuristicReport {
  const passTotal = metric.falsePositive + metric.trueNegative;
  const blockTotal = metric.falseNegative + metric.truePositive;
  return {
    samples,
    metric,
    falsePositiveRate: passTotal === 0 ? 0 : metric.falsePositive / passTotal,
    falseNegativeRate: blockTotal === 0 ? 0 : metric.falseNegative / blockTotal,
    mismatches,
  };
}

// ─── 样本集 1：objective atomicity 连词规则 ─────────────────────────────

/**
 * 全部人工标注。「以及/分别/同时/和」在中文里的正常用法（并列名词短语、
 * 时间状语、物理量符号列举等）是主要假阳来源；真阳性则是真正的多目标拼接。
 */
export const ATOMICITY_SAMPLES: AtomicitySample[] = [
  // —— 应放行（原子目标，含正常连词用法）——
  { id: "a-pass-01", statement: "解释力和运动的关系", expectConcatenated: false, note: "「力和运动」是名词并列，非目标拼接" },
  { id: "a-pass-02", statement: "说明光合作用与呼吸作用的区别", expectConcatenated: false, note: "对比类目标是单一稳定 Objective" },
  { id: "a-pass-03", statement: "同时满足两个约束条件时系统的状态", expectConcatenated: false, note: "「同时」是条件状语" },
  { id: "a-pass-04", statement: "分别讨论气体温度与体积不变时的规律", expectConcatenated: false, note: "「分别」修饰同一目标的两种情形" },
  { id: "a-pass-05", statement: "质量以及能量的守恒定律", expectConcatenated: false, note: "「以及」连接的是同一概念的别名" },
  { id: "a-pass-06", statement: "判断下列反应能否同时进行", expectConcatenated: false, note: "「同时」是副词性成分" },
  { id: "a-pass-07", statement: "力对物体的作用效果取决于力的三要素", expectConcatenated: false, note: "无连词的原子命题" },
  { id: "a-pass-08", statement: "分别写出 F、m、a 的单位", expectConcatenated: false, note: "实机验证中的经典误杀句（§13.1 注释）" },
  { id: "a-pass-09", statement: "植物同时需要光照和水分", expectConcatenated: false, note: "「和」连接宾语并列" },
  { id: "a-pass-10", statement: "理解导数以及微分的几何意义", expectConcatenated: false, note: "「以及」连接同一主题的两个侧面" },
  { id: "a-pass-11", statement: "分别从宏观与微观角度解释压强", expectConcatenated: false, note: "「分别」引出视角而非独立目标" },
  { id: "a-pass-12", statement: "同时性是相对论的核心概念之一", expectConcatenated: false, note: "「同时性」是术语，不是连词" },

  // —— 应拦截（真拼接多个独立学习目标）——
  { id: "a-block-01", statement: "解释光合作用原理以及细胞呼吸的完整过程", expectConcatenated: true, note: "两个独立知识点用「以及」拼接" },
  { id: "a-block-02", statement: "分别掌握牛顿第一定律和第二定律的应用场景", expectConcatenated: true, note: "两条定律各自成目标" },
  { id: "a-block-03", statement: "同时理解动量守恒与能量守恒的适用条件及其推导过程", expectConcatenated: true, note: "「同时理解 X 与 Y」典型拼接" },
  { id: "a-block-04", statement: "说明欧姆定律的内容以及并联电路和串联电路的特点", expectConcatenated: true, note: "三段独立内容拼接" },
  { id: "a-block-05", statement: "掌握化学平衡移动原理，同时学会勒夏特列定理的计算应用", expectConcatenated: true, note: "理解+应用双目标" },
  { id: "a-block-06", statement: "分别描述有丝分裂与减数分裂各期特征", expectConcatenated: true, note: "两种分裂各自成卡" },
];

/**
 * 度量 objectiveAtomicityGate（soft 风险信号）在样本集上的表现。
 * 返回的混淆矩阵语义：TP = 应拦截且命中信号（查准），FP = 应放行但命中信号
 * （误报，允许少量但钉上限）；gate 为 soft 后不再有"漏杀"，FN 仅表示真拼接
 * 未命中信号（Critic 兜底，仍记录以便观察信号覆盖率）。
 */
export function measureAtomicityGate(samples: AtomicitySample[] = ATOMICITY_SAMPLES): HeuristicReport {
  const metric: HeuristicMetric = { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0 };
  const mismatches: Array<{ id: string; direction: "fp" | "fn" }> = [];
  for (const s of samples) {
    const issues = objectiveAtomicityGate(s.statement);
    const blocked = issues.length > 0;
    if (s.expectConcatenated && blocked) metric.truePositive++;
    else if (!s.expectConcatenated && blocked) {
      metric.falsePositive++;
      mismatches.push({ id: s.id, direction: "fp" });
    } else if (s.expectConcatenated && !blocked) {
      metric.falseNegative++;
      mismatches.push({ id: s.id, direction: "fn" });
    } else metric.trueNegative++;
  }
  return summarize(samples.length, metric, mismatches);
}

// ─── 样本集 2：front 泄题启发式（子串匹配 + 字符集重合度） ────────────────

/**
 * 全部人工标注。三类覆盖：
 * - leak：正面照抄/近乎照抄答案（hard 应命中）；
 * - clean：正常教学改写的问答（不得有任何 issue）；
 * - soft-only：字符重合度高但确属教学转换不足的边缘样本（只允许 soft 信号）。
 */
export const LEAK_SAMPLES: LeakSample[] = [
  // —— 应判泄题（hard）——
  { id: "l-leak-01",
    frontText: "请回答：光合作用把光能转化为化学能，并释放氧气",
    answerText: "光合作用把光能转化为化学能，并释放氧气。",
    expectation: "leak", note: "正面整句照抄答案" },
  { id: "l-leak-02",
    frontText: "牛顿第二定律的内容是什么？f=ma，加速度与合外力成正比",
    answerText: "F=ma，加速度与合外力成正比，与质量成反比。",
    expectation: "leak", note: "正面提前给出结论片段" },
  { id: "l-leak-03",
    frontText: "简述细胞膜的结构特点：磷脂双分子层构成基本骨架，蛋白质镶嵌流动",
    answerText: "细胞膜的磷脂双分子层构成基本骨架，蛋白质分子镶嵌、贯穿或覆盖其上，具有流动性。",
    expectation: "leak", note: "正面长片段复制答案开头 200 字符内" },

  // —— 干净（教学转换已发生，不得报任何 issue）——
  { id: "l-clean-01",
    frontText: "绿色植物在光照下释放的气体是什么？为什么？",
    answerText: "光合作用把光能转化为化学能，并释放氧气。",
    expectation: "clean", note: "问法与答案零重合" },
  { id: "l-clean-02",
    frontText: "一个 3kg 的物体受 9N 合外力，加速度多大？",
    answerText: "F=ma，加速度与合外力成正比，与质量成反比。代入得 a=3 m/s²。",
    expectation: "clean", note: "数值题，正面不含结论" },
  { id: "l-clean-03",
    frontText: "如果把细胞膜看成一座城的城墙，城门口的卫兵对应什么结构？",
    answerText: "细胞膜的磷脂双分子层构成基本骨架，蛋白质分子镶嵌、贯穿或覆盖其上，控制物质进出。",
    expectation: "clean", note: "比喻式提问，字面几乎无重叠" },
  { id: "l-clean-04",
    frontText: "为什么冬天摸铁比摸木头更觉得冷？",
    answerText: "铁的导热系数远大于木头，带走手部热量的速度更快，所以感觉更冷。",
    expectation: "clean", note: "生活化提问与答案用词差异大" },
  { id: "l-clean-05",
    frontText: "《岳阳楼记》里表达作者旷达胸怀的名句是？",
    answerText: "不以物喜，不以己悲；先天下之忧而忧，后天下之乐而乐。",
    expectation: "clean", note: "提问指向名句但不泄露内容" },

  // —— 边缘：高字符重合但只允许 soft（教学转换不足信号，不是硬泄题）——
  { id: "l-soft-01",
    frontText: "请用自己的话说明：光能如何转化为化学能并释放氧气",
    answerText: "光合作用把光能转化为化学能，并释放氧气。",
    expectation: "soft-only", note: "几乎复述答案但加了转述指令——重合度会过阈，属 soft" },
  { id: "l-soft-02",
    frontText: "加速的物体受力情况如何用公式表达？（提示：考虑 f=ma 的形式）",
    answerText: "F=ma，加速度与合外力成正比，与质量成反比。",
    expectation: "soft-only", note: "提示里带出公式，重合度中等" },
];

/** 构造泄漏 gate 所需的最小候选投影（仅字段相关部分）。 */
export interface LeakProbeCandidate {
  presentation: { front: { cue: string; prompt: string } };
  objective: {
    canonicalAnswer:
      | { kind: "text"; unit: { unitId: string; text: string } }
      | Record<string, never>;
  };
}

/**
 * 度量 frontLeakageGate 的 hard 判定与 soft 信号在样本集上的表现。
 * adapter 负责把样本包装成 gate 输入（见 heuristic-adapters.ts）。
 */
export function measureFrontLeakageGate(samples: LeakSample[] = LEAK_SAMPLES): HeuristicReport {
  const metric: HeuristicMetric = { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0 };
  const mismatches: Array<{ id: string; direction: "fp" | "fn" }> = [];
  for (const s of samples) {
    const issues = frontLeakageGate(s);
    const hardHit = issues.some((i) => i.code === "front_leaks_answer");
    const softHit = issues.some((i) => i.code === "surface_paraphrase_only");
    const blocked = s.expectation === "leak" ? hardHit : (s.expectation === "clean" ? (hardHit || softHit) : hardHit);
    if (s.expectation === "leak") {
      if (blocked) metric.truePositive++;
      else { metric.falseNegative++; mismatches.push({ id: s.id, direction: "fn" }); }
    } else if (!blocked) {
      metric.trueNegative++;
    } else {
      metric.falsePositive++;
      mismatches.push({ id: s.id, direction: "fp" });
    }
    // soft-only 样本的额外断言在测试层做（soft 允许存在，hard 必须缺席）。
  }
  return summarize(samples.length, metric, mismatches);
}
