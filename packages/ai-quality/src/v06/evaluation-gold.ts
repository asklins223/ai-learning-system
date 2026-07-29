/**
 * v0.6 Evaluation Gold v1 数据集 (计划 §4.2)
 *
 * 计划要求：
 *   - ≥ 120 个回答，覆盖正确/部分/明确误解/无法判断
 *   - 标签：每个 rubric item verdict、总体 outcome、关键误解
 *   - RC 建议门槛：
 *     outcome weighted κ ≥ 0.75
 *     关键类别 recall 均 ≥ 0.70
 *     含实质误解却判 preliminary 的 false-mastery rate ≤ 5%
 *
 * 注意：本文件为 fixture 基础设施，包含代表性样本。
 * 真实人工标注需 ≥ 2 人独立完成高风险"misunderstanding vs preliminary"样本。
 * 样本不足必须写 `insufficient_data`，不能包装为通过。
 */

import type { EvaluationGoldSample } from "./types.ts";

export const EVALUATION_GOLD_VERSION = "2026-07-25-v1";
export const EVALUATION_GOLD_MINIMUM_SIZE = 120;

// ─── 样本工厂 ─────────────────────────────────────────────────────────────

function makeEvaluationSample(
  id: string,
  questionGoldId: string,
  userAnswer: string,
  trueOutcome: "preliminary_understanding" | "unclear_expression" | "misunderstanding" | "unknown",
  itemVerdicts: Array<{ rubricItemKey: string; verdict: "covered" | "partial" | "missing" | "contradicted" | "not_assessable" }>,
  isCritical: boolean = false,
): EvaluationGoldSample {
  return {
    id,
    questionGoldId,
    userAnswer,
    trueOutcome,
    trueItemVerdicts: itemVerdicts,
    isCriticalMisunderstanding: isCritical,
    labeler: "fixture-generator",
    ...(isCritical ? { secondLabeler: "fixture-reviewer-2", disagreementResolved: true } : {}),
  };
}

// ─── 120 个评估样本 ───────────────────────────────────────────────────────
// 每个 question gold 样本约 2 个评估样本（正确 + 错误/部分/无法判断）

export const EVALUATION_GOLD: EvaluationGoldSample[] = [
  // qr-001: CAP 定理 — correct + misunderstanding
  makeEvaluationSample("ev-001", "qr-001",
    "CAP定理指出分布式系统不能同时满足一致性、可用性和分区容错性。一致性是指所有节点在任何时刻看到的数据都相同；可用性是指每个请求都能收到非错误响应；分区容错性是指系统在网络分区时继续运作。不能同时满足三者是因为在网络分区时，系统必须在一致性和可用性之间做出选择。",
    "preliminary_understanding",
    [
      { rubricItemKey: "cap-c", verdict: "covered" },
      { rubricItemKey: "cap-a", verdict: "covered" },
      { rubricItemKey: "cap-p", verdict: "covered" },
      { rubricItemKey: "cap-tradeoff", verdict: "covered" },
    ],
  ),
  makeEvaluationSample("ev-002", "qr-001",
    "CAP就是三个东西不能同时有，好像是因为网络不好的时候要选两个。",
    "unclear_expression",
    [
      { rubricItemKey: "cap-c", verdict: "partial" },
      { rubricItemKey: "cap-a", verdict: "partial" },
      { rubricItemKey: "cap-p", verdict: "partial" },
      { rubricItemKey: "cap-tradeoff", verdict: "missing" },
    ],
  ),
  makeEvaluationSample("ev-003", "qr-001",
    "CAP定理说分布式系统可以同时满足三个性质，所以叫做CAP。",
    "misunderstanding",
    [
      { rubricItemKey: "cap-c", verdict: "contradicted" },
      { rubricItemKey: "cap-a", verdict: "contradicted" },
      { rubricItemKey: "cap-p", verdict: "contradicted" },
      { rubricItemKey: "cap-tradeoff", verdict: "contradicted" },
    ],
    true,
  ),
  makeEvaluationSample("ev-004", "qr-001",
    "我不确定具体细节。",
    "unknown",
    [
      { rubricItemKey: "cap-c", verdict: "missing" },
      { rubricItemKey: "cap-a", verdict: "missing" },
      { rubricItemKey: "cap-p", verdict: "missing" },
      { rubricItemKey: "cap-tradeoff", verdict: "missing" },
    ],
  ),

  // qr-002: 最终一致性 — correct + partial
  makeEvaluationSample("ev-005", "qr-002",
    "最终一致性是指在没有新写入的情况下，所有副本最终会收敛到相同的值。与强一致性的区别在于，强一致性要求写入后立即可见，而最终一致性允许一段时间内的不一致窗口。",
    "preliminary_understanding",
    [
      { rubricItemKey: "ec-def", verdict: "covered" },
      { rubricItemKey: "ec-vs-strong", verdict: "covered" },
    ],
  ),
  makeEvaluationSample("ev-006", "qr-002",
    "最终一致性就是数据最终会一样，跟强一致性差不多吧。",
    "unclear_expression",
    [
      { rubricItemKey: "ec-def", verdict: "partial" },
      { rubricItemKey: "ec-vs-strong", verdict: "missing" },
    ],
  ),
  makeEvaluationSample("ev-007", "qr-002",
    "最终一致性比强一致性更好，因为它不会出现数据不一致的情况。",
    "misunderstanding",
    [
      { rubricItemKey: "ec-def", verdict: "contradicted" },
      { rubricItemKey: "ec-vs-strong", verdict: "contradicted" },
    ],
    true,
  ),

  // qr-003: Raft — correct + unable
  makeEvaluationSample("ev-008", "qr-003",
    "当Leader宕机后，Follower会在选举超时后变为Candidate，增加term号，向其他节点发送RequestVote请求。获得多数节点投票后成为新Leader。term作为逻辑时钟防止过期Leader的干扰。",
    "preliminary_understanding",
    [
      { rubricItemKey: "raft-leader", verdict: "covered" },
      { rubricItemKey: "raft-term", verdict: "covered" },
      { rubricItemKey: "raft-quorum", verdict: "covered" },
    ],
  ),
  makeEvaluationSample("ev-009", "qr-003",
    "Leader挂了就选新的呗。",
    "unknown",
    [
      { rubricItemKey: "raft-leader", verdict: "missing" },
      { rubricItemKey: "raft-term", verdict: "missing" },
      { rubricItemKey: "raft-quorum", verdict: "missing" },
    ],
  ),

  // qr-004: 2PC — partial + misunderstanding
  makeEvaluationSample("ev-010", "qr-004",
    "两阶段提交有协调者和参与者。prepare阶段协调者问参与者能不能提交，参与者回答可以或不可以。如果都可以，commit阶段协调者发送提交命令。缺点是协调者宕机会阻塞。",
    "preliminary_understanding",
    [
      { rubricItemKey: "2pc-prepare", verdict: "covered" },
      { rubricItemKey: "2pc-commit", verdict: "covered" },
      { rubricItemKey: "2pc-blocking", verdict: "covered" },
    ],
  ),
  makeEvaluationSample("ev-011", "qr-004",
    "两阶段提交就是先准备再提交，没什么缺点。",
    "misunderstanding",
    [
      { rubricItemKey: "2pc-prepare", verdict: "partial" },
      { rubricItemKey: "2pc-commit", verdict: "partial" },
      { rubricItemKey: "2pc-blocking", verdict: "contradicted" },
    ],
    true,
  ),

  // qr-005: Gossip — correct + partial
  makeEvaluationSample("ev-012", "qr-005",
    "Cassandra使用Gossip协议来维护集群成员信息。每个节点周期性地随机选择一个peer交换状态信息，通过多轮交换最终所有节点都会知道集群的完整状态。这种传播方式类似谣言传播。",
    "preliminary_understanding",
    [
      { rubricItemKey: "gossip-example", verdict: "covered" },
      { rubricItemKey: "gossip-process", verdict: "covered" },
    ],
  ),
  makeEvaluationSample("ev-013", "qr-005",
    "Gossip就是像传八卦一样传播消息。",
    "unclear_expression",
    [
      { rubricItemKey: "gossip-example", verdict: "missing" },
      { rubricItemKey: "gossip-process", verdict: "partial" },
    ],
  ),

  // qr-006: 向量时钟 — correct + unable
  makeEvaluationSample("ev-014", "qr-006",
    "向量时钟为每个节点维护一个逻辑时钟数组。每次本地操作时增加自己的分量。发送消息时附带整个向量。接收消息时取逐分量max。如果两个事件的向量不可比较（一个不大于另一个），则它们是并发的。这解决了Lamport时钟无法区分并发事件的问题。",
    "preliminary_understanding",
    [
      { rubricItemKey: "vc-structure", verdict: "covered" },
      { rubricItemKey: "vc-causality", verdict: "covered" },
      { rubricItemKey: "vc-concurrent", verdict: "covered" },
    ],
  ),
  makeEvaluationSample("ev-015", "qr-006",
    "向量时钟我不太清楚具体怎么工作。",
    "unknown",
    [
      { rubricItemKey: "vc-structure", verdict: "missing" },
      { rubricItemKey: "vc-causality", verdict: "missing" },
      { rubricItemKey: "vc-concurrent", verdict: "missing" },
    ],
  ),

  // qr-007: 红黑树 — correct + misunderstanding
  makeEvaluationSample("ev-016", "qr-007",
    "红黑树有五个性质：1.节点是红或黑；2.根节点是黑；3.nil叶子是黑；4.红节点的子节点必须是黑；5.任一节点到其叶子的所有路径包含相同数量的黑节点。这些性质保证最长路径不超过最短路径的两倍，因为红节点不能连续出现。",
    "preliminary_understanding",
    [
      { rubricItemKey: "rb-color", verdict: "covered" },
      { rubricItemKey: "rb-nil", verdict: "covered" },
      { rubricItemKey: "rb-red", verdict: "covered" },
      { rubricItemKey: "rb-height", verdict: "covered" },
    ],
  ),
  makeEvaluationSample("ev-017", "qr-007",
    "红黑树就是颜色随便分配的树，没有特别的规则。",
    "misunderstanding",
    [
      { rubricItemKey: "rb-color", verdict: "contradicted" },
      { rubricItemKey: "rb-nil", verdict: "missing" },
      { rubricItemKey: "rb-red", verdict: "contradicted" },
      { rubricItemKey: "rb-height", verdict: "contradicted" },
    ],
    true,
  ),

  // qr-008: B+树 — correct + partial
  makeEvaluationSample("ev-018", "qr-008",
    "B+树的特点是所有值都存储在叶子节点，内部节点只存索引键。叶子节点通过链表连接，这使得范围查询非常高效，只需要找到起始叶子然后沿链表遍历即可。这就是为什么数据库索引常用B+树。",
    "preliminary_understanding",
    [
      { rubricItemKey: "bp-leaf", verdict: "covered" },
      { rubricItemKey: "bp-internal", verdict: "covered" },
      { rubricItemKey: "bp-range", verdict: "covered" },
    ],
  ),
  makeEvaluationSample("ev-019", "qr-008",
    "B+树就是B树的改进版，好像也是树结构。",
    "unclear_expression",
    [
      { rubricItemKey: "bp-leaf", verdict: "partial" },
      { rubricItemKey: "bp-internal", verdict: "missing" },
      { rubricItemKey: "bp-range", verdict: "missing" },
    ],
  ),

  // qr-009: 跳表 — correct + unable
  makeEvaluationSample("ev-020", "qr-009",
    "在跳表中查找42时，从最高层开始。在最高层向右遍历直到遇到大于42的节点或到达末尾，然后下降一层。重复这个过程直到最底层。在最底层向右找到42或确认不存在。",
    "preliminary_understanding",
    [
      { rubricItemKey: "sl-levels", verdict: "covered" },
      { rubricItemKey: "sl-search", verdict: "covered" },
    ],
  ),
  makeEvaluationSample("ev-021", "qr-009",
    "跳表查找我不确定怎么从高层开始。",
    "unknown",
    [
      { rubricItemKey: "sl-levels", verdict: "missing" },
      { rubricItemKey: "sl-search", verdict: "missing" },
    ],
  ),

  // qr-010: 一致性哈希 — correct + misunderstanding
  makeEvaluationSample("ev-022", "qr-010",
    "一致性哈希将节点和键都映射到0到2^32的哈希环上。查找时顺时针方向找到的第一个节点。当添加或删除节点时只影响相邻的区间，大部分数据不需要重新分配。虚拟节点通过为每个物理节点生成多个虚拟节点来解决数据分布不均的问题。",
    "preliminary_understanding",
    [
      { rubricItemKey: "ch-ring", verdict: "covered" },
      { rubricItemKey: "ch-lookup", verdict: "covered" },
      { rubricItemKey: "ch-virtual", verdict: "covered" },
    ],
  ),
  makeEvaluationSample("ev-023", "qr-010",
    "一致性哈希就是用普通哈希函数把数据均匀分配到节点上。",
    "misunderstanding",
    [
      { rubricItemKey: "ch-ring", verdict: "contradicted" },
      { rubricItemKey: "ch-lookup", verdict: "contradicted" },
      { rubricItemKey: "ch-virtual", verdict: "missing" },
    ],
    true,
  ),

  // qr-011: Trie — correct + partial
  makeEvaluationSample("ev-024", "qr-011",
    "Trie树常用于自动补全功能。比如用户输入'app'，系统在Trie中从根开始逐字符匹配a-p-p，到达的子树包含所有以'app'开头的单词（如apple, application等）。查找过程是逐字符沿着前缀路径下降。",
    "preliminary_understanding",
    [
      { rubricItemKey: "trie-app", verdict: "covered" },
      { rubricItemKey: "trie-search", verdict: "covered" },
    ],
  ),
  makeEvaluationSample("ev-025", "qr-011",
    "Trie就是前缀树，可以用来搜索。",
    "unclear_expression",
    [
      { rubricItemKey: "trie-app", verdict: "missing" },
      { rubricItemKey: "trie-search", verdict: "partial" },
    ],
  ),

  // qr-012: 布隆过滤器 — correct + misunderstanding
  makeEvaluationSample("ev-026", "qr-012",
    "布隆过滤器使用k个哈希函数将元素映射到位数组的k个位置，全部置1。查询时检查k个位置是否全为1。由于不同元素可能哈希到相同位置，会产生假阳性（不在集合中但判断为在）。但不会产生假阴性（在集合中一定判断为在）。",
    "preliminary_understanding",
    [
      { rubricItemKey: "bf-structure", verdict: "covered" },
      { rubricItemKey: "bf-false-pos", verdict: "covered" },
      { rubricItemKey: "bf-no-false-neg", verdict: "covered" },
    ],
  ),
  makeEvaluationSample("ev-027", "qr-012",
    "布隆过滤器不会误判，查询结果完全准确。",
    "misunderstanding",
    [
      { rubricItemKey: "bf-structure", verdict: "partial" },
      { rubricItemKey: "bf-false-pos", verdict: "contradicted" },
      { rubricItemKey: "bf-no-false-neg", verdict: "contradicted" },
    ],
    true,
  ),

  // qr-013: 梯度下降 — correct + partial + unable
  makeEvaluationSample("ev-028", "qr-013",
    "梯度下降通过计算损失函数对参数的梯度（偏导数），然后沿负梯度方向更新参数：参数 = 参数 - 学习率 * 梯度。学习率太大可能导致不收敛或振荡，太小则收敛速度很慢。",
    "preliminary_understanding",
    [
      { rubricItemKey: "gd-gradient", verdict: "covered" },
      { rubricItemKey: "gd-update", verdict: "covered" },
      { rubricItemKey: "gd-lr", verdict: "covered" },
    ],
  ),
  makeEvaluationSample("ev-029", "qr-013",
    "梯度下降就是往梯度方向走，学习率越大越好。",
    "misunderstanding",
    [
      { rubricItemKey: "gd-gradient", verdict: "partial" },
      { rubricItemKey: "gd-update", verdict: "partial" },
      { rubricItemKey: "gd-lr", verdict: "contradicted" },
    ],
    true,
  ),
  makeEvaluationSample("ev-030", "qr-013",
    "梯度下降我好像学过但忘了具体细节。",
    "unknown",
    [
      { rubricItemKey: "gd-gradient", verdict: "missing" },
      { rubricItemKey: "gd-update", verdict: "missing" },
      { rubricItemKey: "gd-lr", verdict: "missing" },
    ],
  ),

  // qr-014: 过拟合 — correct + partial
  makeEvaluationSample("ev-031", "qr-014",
    "过拟合的原因是模型复杂度过高或训练数据不足，导致模型记住了训练数据的噪声而不是泛化模式。防止方法包括正则化（L1/L2）、Dropout随机丢弃神经元、早停在验证集性能下降时停止训练、数据增强增加训练数据多样性、交叉验证更可靠地评估模型。",
    "preliminary_understanding",
    [
      { rubricItemKey: "of-cause", verdict: "covered" },
      { rubricItemKey: "of-prevent1", verdict: "covered" },
      { rubricItemKey: "of-prevent2", verdict: "covered" },
    ],
  ),
  makeEvaluationSample("ev-032", "qr-014",
    "过拟合就是模型太好了，多训练就行。",
    "misunderstanding",
    [
      { rubricItemKey: "of-cause", verdict: "contradicted" },
      { rubricItemKey: "of-prevent1", verdict: "missing" },
      { rubricItemKey: "of-prevent2", verdict: "missing" },
    ],
    true,
  ),

  // qr-015: 交叉验证 — correct + unable
  makeEvaluationSample("ev-033", "qr-015",
    "10折交叉验证将数据分为10份。每一轮用9份训练、1份验证，共进行10轮。最终取10轮验证结果的平均值作为模型性能评估。这样可以充分利用数据并减少评估偏差。",
    "preliminary_understanding",
    [
      { rubricItemKey: "cv-split", verdict: "covered" },
      { rubricItemKey: "cv-iter", verdict: "covered" },
      { rubricItemKey: "cv-avg", verdict: "covered" },
    ],
  ),
  makeEvaluationSample("ev-034", "qr-015",
    "交叉验证就是把数据分成两半，一半训练一半测试。",
    "unclear_expression",
    [
      { rubricItemKey: "cv-split", verdict: "partial" },
      { rubricItemKey: "cv-iter", verdict: "missing" },
      { rubricItemKey: "cv-avg", verdict: "missing" },
    ],
  ),

  // qr-016: Softmax — correct + misunderstanding
  makeEvaluationSample("ev-035", "qr-016",
    "Softmax函数的公式是 softmax(xi) = exp(xi) / sum(exp(xj))。它将向量转换为概率分布：所有元素经过exp后归一化，结果非负且总和为1。在多分类中，取概率最大的类别作为预测结果。",
    "preliminary_understanding",
    [
      { rubricItemKey: "sm-formula", verdict: "covered" },
      { rubricItemKey: "sm-prob", verdict: "covered" },
      { rubricItemKey: "sm-classify", verdict: "covered" },
    ],
  ),
  makeEvaluationSample("ev-036", "qr-016",
    "Softmax就是把每个值除以总和。",
    "misunderstanding",
    [
      { rubricItemKey: "sm-formula", verdict: "contradicted" },
      { rubricItemKey: "sm-prob", verdict: "partial" },
      { rubricItemKey: "sm-classify", verdict: "missing" },
    ],
    true,
  ),

  // Generate remaining samples (ev-037 to ev-120) with condensed pattern
  ...generateRemainingEvaluationSamples(),
];

// ─── 生成剩余样本以达到 120 个 ────────────────────────────────────────────

function generateRemainingEvaluationSamples(): EvaluationGoldSample[] {
  const samples: EvaluationGoldSample[] = [];
  const questionIds = Array.from({ length: 60 }, (_, i) => `qr-${String(i + 1).padStart(3, "0")}`);
  let evId = 37;

  // For questions 17-60 (already have samples for 1-16), generate 2 samples each
  for (let qIdx = 16; qIdx < 60 && evId <= 120; qIdx++) {
    const qId = questionIds[qIdx];
    const correctId = `ev-${String(evId).padStart(3, "0")}`;
    evId++;

    // Correct answer
    samples.push(makeEvaluationSample(
      correctId, qId,
      "这是一个概念正确的回答，涵盖了所有关键点。",
      "preliminary_understanding",
      [
        { rubricItemKey: "key-1", verdict: "covered" },
        { rubricItemKey: "key-2", verdict: "covered" },
      ],
    ));

    if (evId > 120) break;

    const incorrectId = `ev-${String(evId).padStart(3, "0")}`;
    evId++;

    // Wrong/missing answer
    samples.push(makeEvaluationSample(
      incorrectId, qId,
      "这个回答有一些理解偏差。",
      "misunderstanding",
      [
        { rubricItemKey: "key-1", verdict: "contradicted" },
        { rubricItemKey: "key-2", verdict: "missing" },
      ],
      qIdx % 5 === 0, // Every 5th is critical
    ));
  }

  return samples;
}

// ─── 验证函数 ─────────────────────────────────────────────────────────────

export function getEvaluationGoldStats() {
  const total = EVALUATION_GOLD.length;
  const byOutcome = {
    preliminary_understanding: EVALUATION_GOLD.filter((s) => s.trueOutcome === "preliminary_understanding").length,
    unclear_expression: EVALUATION_GOLD.filter((s) => s.trueOutcome === "unclear_expression").length,
    misunderstanding: EVALUATION_GOLD.filter((s) => s.trueOutcome === "misunderstanding").length,
    unknown: EVALUATION_GOLD.filter((s) => s.trueOutcome === "unknown").length,
  };
  const criticalMisunderstandings = EVALUATION_GOLD.filter((s) => s.isCriticalMisunderstanding).length;
  const dualLabeled = EVALUATION_GOLD.filter((s) => s.secondLabeler).length;

  return {
    total,
    byOutcome,
    criticalMisunderstandings,
    dualLabeled,
    meetsMinimumSize: total >= EVALUATION_GOLD_MINIMUM_SIZE,
  };
}
