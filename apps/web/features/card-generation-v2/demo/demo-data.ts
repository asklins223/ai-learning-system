import type {
  CandidateReviewItemV2,
  CandidateRevealContentV2,
  CandidateSetSummaryV2,
  GenerationControlsDraftV2,
  LearningCardRevealContentV2,
  PublicLearningCardPreviewV2,
  ZeroCardResultV2,
} from "../contracts/ui-contracts";

export const demoGenerationControls: GenerationControlsDraftV2 = {
  sourceScope: "whole_note",
  learningGoal: "understand",
  detailThreshold: "balanced",
  hardMaxCards: null,
  preferredStrategies: ["recall", "compare"],
};

export const demoCandidateSummary: CandidateSetSummaryV2 = {
  sourceLabel: "网络基础 · OSI 七层模型",
  sourceVersion: 12,
  atomCount: 7,
  candidateCount: 2,
  supportOnlyCount: 3,
  mergedCount: 2,
  estimatedReviewSeconds: 92,
};

export const demoCandidates: CandidateReviewItemV2[] = [
  {
    candidateId: "candidate-osi-order",
    revision: 1,
    revisionHash: "demo-rev-hash",
    objective: "从低到高重建 OSI 七层顺序",
    prompt: "不看笔记，从物理层开始写出 OSI 七层的完整顺序。",
    reason: "顺序本身是后续定位协议与故障层级的骨架，值得独立提取。",
    sourceLabel: "网络基础 · 第 2 段",
    knowledgeForm: "顺序",
    strategyLabel: "主动回忆",
    estimatedSeconds: 38,
    selected: true,
    reviewState: "ready",
    mergeEligibility: {
      semanticGroupId: "osi-sequence",
      rationale: "只与同一层级顺序目标合并",
    },
  },
  {
    candidateId: "candidate-osi-match",
    revision: 1,
    revisionHash: "demo-rev-hash",
    objective: "把关键职责匹配到 OSI 层级",
    prompt: "帧与纠错、路由、端到端传输分别属于哪一层？说明你的判断线索。",
    reason: "把原文列表转换为职责匹配，能检验是否真正理解每层分工。",
    sourceLabel: "网络基础 · 第 3–5 段",
    knowledgeForm: "映射",
    strategyLabel: "职责匹配",
    estimatedSeconds: 54,
    selected: true,
    reviewState: "ready",
    mergeEligibility: {
      semanticGroupId: "osi-responsibility",
      rationale: "只与同一职责匹配目标合并",
    },
  },
];

export const demoCandidateReveals: Record<string, CandidateRevealContentV2> = {
  "candidate-osi-order": {
    candidateId: "candidate-osi-order",
    revision: 1,
    exposureId: "demo-exposure-osi-order",
    answer: "物理层 → 数据链路层 → 网络层 → 传输层 → 会话层 → 表示层 → 应用层。",
    explanation: "先记住层级骨架，再把协议、数据单元与职责挂到对应位置。",
    evidencePreview: "OSI 模型从低到高分为：物理层、数据链路层、网络层……",
  },
  "candidate-osi-match": {
    candidateId: "candidate-osi-match",
    revision: 1,
    exposureId: "demo-exposure-osi-match",
    answer: "帧与纠错属于数据链路层；路由属于网络层；端到端传输属于传输层。",
    explanation: "判断时分别抓住相邻节点传输、跨网络寻址和端到端可靠性三个尺度。",
    evidencePreview: "数据链路层负责帧与差错控制；网络层负责路由……",
  },
};

export const demoZeroCard: ZeroCardResultV2 = {
  title: "这段笔记暂时不需要单独做学习卡",
  explanation:
    "内容主要是本周网络课程的待办安排，没有可以离开上下文后反复回忆的独立目标。直接保留在笔记里会更轻松。",
  reasonLabel: "更适合直接阅读",
  decisions: [
    { label: "识别到", value: "3 条待办信息" },
    { label: "学习目标", value: "0 个" },
    { label: "新增负担", value: "0 张卡" },
  ],
};

const initialState: PublicLearningCardPreviewV2["personalState"] = {
  status: "initial_validation_ready",
  label: "等待首次验证",
  detail: "还没有可信学习记录，也没有创建复习安排。",
};

const startAction: PublicLearningCardPreviewV2["primaryAction"] = {
  intent: "start",
  label: "开始三分钟巩固",
};

const activeLifecycle: PublicLearningCardPreviewV2["lifecycle"] = {
  status: "active",
  label: "学习中",
  detail: "这张卡处于可学习状态。",
};

const currentFreshness: PublicLearningCardPreviewV2["freshness"] = {
  status: "current",
  label: "内容最新",
  detail: "学习卡与来源版本一致。",
  sourceVersion: 12,
};

/**
 * Seven answer-free public examples for the same note family. These are default
 * card interactions only; a future LearningRun may choose another interaction
 * for the same objective without changing objectiveId.
 */
export const demoPublicCards: PublicLearningCardPreviewV2[] = [
  {
    cardId: "card-osi-recall",
    objectiveId: "objective-osi-encapsulation",
    objective: {
      statement: "用自己的话解释分层封装",
      publicSummary: "能离开原文重建机制，比复述一句定义更能检验理解。",
    },
    front: {
      kind: "recall",
      context: "网络基础 · 分层与封装",
      cue: "先讲数据向下走时发生什么，再讲接收端",
      prompt: "不看笔记，向刚入门的同学解释“封装”是怎样完成一次通信的。",
      scratchpadPlaceholder: "先写出你的解释，不必追求原文措辞……",
      reflectionPrompts: ["发送端", "每层职责", "接收端"],
    },
    lifecycle: activeLifecycle,
    freshness: currentFreshness,
    personalState: initialState,
    primaryAction: startAction,
  },
  {
    cardId: "card-osi-cloze",
    objectiveId: "objective-osi-data-units",
    objective: {
      statement: "在封装语境中准确使用数据单元名称",
      publicSummary: "把术语放回完整过程，避免只会孤立背名称。",
    },
    front: {
      kind: "cloze",
      context: "网络基础 · 数据单元",
      cue: "根据所在层级和动作补全，不提供词库",
      prompt: "补全这段封装过程中的三个关键术语。",
      passage: [
        { kind: "text", text: "传输层把应用数据组织为" },
        { kind: "blank", blankId: "transport-unit", label: "传输层数据单元", width: "medium" },
        { kind: "text", text: "，网络层继续加入寻址信息形成" },
        { kind: "blank", blankId: "network-unit", label: "网络层数据单元", width: "medium" },
        { kind: "text", text: "，数据链路层再把它封装成" },
        { kind: "blank", blankId: "link-unit", label: "链路层数据单元", width: "short" },
        { kind: "text", text: "后交给物理介质。" },
      ],
    },
    lifecycle: activeLifecycle,
    freshness: currentFreshness,
    personalState: initialState,
    primaryAction: startAction,
  },
  {
    cardId: "card-transport-compare",
    objectiveId: "objective-tcp-udp-tradeoff",
    objective: {
      statement: "从需求约束比较 TCP 与 UDP",
      publicSummary: "不是背两列特征，而是按相同维度说明取舍。",
    },
    front: {
      kind: "compare",
      context: "网络基础 · 传输层",
      cue: "每一行都写出差异，以及它对应用的影响",
      prompt: "沿着三个决策维度比较 TCP 与 UDP。",
      subjects: [
        { subjectId: "tcp", label: "TCP" },
        { subjectId: "udp", label: "UDP" },
      ],
      dimensions: [
        { dimensionId: "delivery", label: "交付保证", prompt: "是否保证，代价是什么？" },
        { dimensionId: "ordering", label: "顺序与重传", prompt: "谁负责处理？" },
        { dimensionId: "latency", label: "延迟取舍", prompt: "适合怎样的场景？" },
      ],
    },
    lifecycle: activeLifecycle,
    freshness: currentFreshness,
    personalState: initialState,
    primaryAction: startAction,
  },
  {
    cardId: "card-osi-sequence",
    objectiveId: "objective-osi-order",
    objective: {
      statement: "从低到高重建 OSI 七层顺序",
      publicSummary: "层级顺序是定位协议、职责和故障范围的骨架。",
    },
    front: {
      kind: "sequence",
      context: "网络基础 · OSI 七层模型",
      cue: "使用上下按钮，把步骤排成从低到高",
      prompt: "重排层级，建立完整的协议栈路径。",
      steps: [
        { stepId: "network", label: "网络层" },
        { stepId: "physical", label: "物理层" },
        { stepId: "presentation", label: "表示层" },
        { stepId: "transport", label: "传输层" },
        { stepId: "application", label: "应用层" },
        { stepId: "link", label: "数据链路层" },
        { stepId: "session", label: "会话层" },
      ],
    },
    lifecycle: activeLifecycle,
    freshness: currentFreshness,
    personalState: initialState,
    primaryAction: startAction,
  },
  {
    cardId: "card-network-cause",
    objectiveId: "objective-congestion-cause-chain",
    objective: {
      statement: "重建拥塞从负载到超时的因果链",
      publicSummary: "把相关现象连成机制链，才能定位应该干预哪一环。",
    },
    front: {
      kind: "why",
      context: "网络基础 · 拥塞",
      cue: "点选节点搭链；再次点选已放入的节点可以撤回",
      prompt: "用这些现象搭出一条最能解释超时的因果路径。",
      nodes: [
        { nodeId: "timeout", label: "请求超时" },
        { nodeId: "queue", label: "队列持续增长" },
        { nodeId: "load", label: "到达速率超过处理能力" },
        { nodeId: "delay", label: "排队时延上升" },
      ],
      chainSlotCount: 4,
    },
    lifecycle: activeLifecycle,
    freshness: currentFreshness,
    personalState: initialState,
    primaryAction: startAction,
  },
  {
    cardId: "card-network-boundary",
    objectiveId: "objective-reliability-boundary",
    objective: {
      statement: "判断“可靠传输”职责的适用边界",
      publicSummary: "区分相邻节点与端到端尺度，避免看见可靠二字就选同一层。",
    },
    front: {
      kind: "boundary",
      context: "网络基础 · 职责边界",
      cue: "逐项判断它是否仍属于端到端可靠性的讨论范围",
      prompt: "下面哪些情况仍在传输层目标内，哪些已经越过边界？",
      cases: [
        { caseId: "lost-segment", statement: "跨越多个路由器后，接收端发现一个报文段缺失" },
        { caseId: "local-frame", statement: "同一条物理链路上的帧校验失败" },
        { caseId: "reorder", statement: "接收端拿到的报文段顺序与发送顺序不同" },
      ],
      labels: {
        within: "仍在目标内",
        outside: "超出边界",
      },
    },
    lifecycle: activeLifecycle,
    freshness: currentFreshness,
    personalState: initialState,
    primaryAction: startAction,
  },
  {
    cardId: "card-network-apply",
    objectiveId: "objective-protocol-choice",
    objective: {
      statement: "根据实时性与完整性约束选择传输策略",
      publicSummary: "把层级知识迁移到真实产品决策，而不是停留在名词匹配。",
    },
    front: {
      kind: "application",
      context: "网络基础 · 情境迁移",
      cue: "先锁定不能牺牲的约束，再做选择",
      prompt: "你会怎样设计第一版传输策略？",
      scenario: "一款实时语音应用允许偶尔丢失很短的音频片段，但不能因为重传让对话不断卡顿。",
      options: [
        { optionId: "reliable-stream", label: "可靠字节流", description: "优先保证每段数据完整到达" },
        { optionId: "low-latency", label: "低延迟数据报", description: "优先让新音频及时到达" },
        { optionId: "hybrid", label: "分层混合", description: "媒体与控制消息采用不同策略" },
      ],
    },
    lifecycle: activeLifecycle,
    freshness: currentFreshness,
    personalState: initialState,
    primaryAction: startAction,
  },
];

const reveal = (
  cardId: string,
  canonicalAnswer: string,
  explanation: string,
  misconception: string,
): LearningCardRevealContentV2 => ({
  exposureId: `demo-exposure-${cardId}`,
  exposedAt: "2026-08-14T08:00:00.000Z",
  exposurePolicyVersion: "pre-run-reveal-v1",
  canonicalAnswer,
  explanation,
  misconception,
  evidence: [
    {
      evidenceId: `evidence-${cardId}`,
      sourceLabel: "网络基础 · 已保存版本 v12",
      preview: "此处由 Reveal DTO 按 Exposure 返回对应原文依据；Public Card 不携带该内容。",
    },
  ],
  practice: {
    label: "已预习 · 进入练习语义",
    explanation: "你刚看过参考内容，立即开始不会作为首次可信验证；到可验证时系统会提醒你。",
    primaryActionLabel: "现在练一下",
  },
});

export const demoPublicCardReveals: Record<string, LearningCardRevealContentV2> = {
  "card-osi-recall": reveal(
    "card-osi-recall",
    "发送端的数据逐层向下，每层加入完成本层职责所需的控制信息；接收端再按相反方向逐层解析。",
    "关键不是背“加首部”，而是理解每层只处理自己的职责，并向相邻层交付。",
    "封装不是把数据加密；它描述的是跨层添加和解析控制信息。",
  ),
  "card-osi-cloze": reveal(
    "card-osi-cloze",
    "三个空依次是报文段、数据包（分组）和帧。",
    "名称随所在层级变化，反映每层加入了不同的控制信息。",
    "不要把物理层的比特流提前当成数据链路层的帧。",
  ),
  "card-transport-compare": reveal(
    "card-transport-compare",
    "TCP 提供有序、重传与拥塞控制，通常以额外握手和等待换可靠性；UDP 保留报文边界且不承诺交付，更适合由应用自行处理实时性取舍。",
    "比较应沿相同维度展开，最后落回应用约束，而不是罗列孤立标签。",
    "UDP 并不天然更快；网络、实现和应用策略共同决定实际延迟。",
  ),
  "card-osi-sequence": reveal(
    "card-osi-sequence",
    "物理层 → 数据链路层 → 网络层 → 传输层 → 会话层 → 表示层 → 应用层。",
    "从通信介质向用户应用上升，职责逐步从信号、相邻节点、跨网寻址过渡到端到端与应用语义。",
    "TCP/IP 实际协议栈与 OSI 教学模型的层数并不完全相同。",
  ),
  "card-network-cause": reveal(
    "card-network-cause",
    "到达速率超过处理能力 → 队列持续增长 → 排队时延上升 → 请求超时。",
    "拥塞是持续的供需失衡；超时是这条链末端可观察到的结果。",
    "一次偶发超时不能单独证明网络发生了拥塞。",
  ),
  "card-network-boundary": reveal(
    "card-network-boundary",
    "报文段缺失与乱序仍属于端到端传输目标；单条链路的帧校验失败属于数据链路层尺度。",
    "先问故障发生在相邻节点还是通信两端，再判断职责层级。",
    "“可靠”不是某一层独占的词，必须同时看通信尺度。",
  ),
  "card-network-apply": reveal(
    "card-network-apply",
    "媒体流优先采用低延迟数据报；若存在必须可靠到达的控制消息，可再用可靠通道形成分层混合方案。",
    "语音片段过期后再到达的价值很低，因此媒体数据的实时性通常优先于逐片完整。",
    "选择 UDP 不等于放弃所有可靠性，应用仍可为关键消息增加确认机制。",
  ),
};

export const demoPublicCard = demoPublicCards[2]!;
export const demoPublicCardReveal = demoPublicCardReveals[demoPublicCard.cardId]!;
