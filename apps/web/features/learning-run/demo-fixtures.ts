import type {
  LearningRunOutcomeV1,
  LearningRunPublicV1,
  LearningRunResultV1,
  LearningTaskPublicV1,
} from "./contracts";

export type LearningRunDemoFrameV1 = {
  frameId: string;
  label: string;
  note: string;
  snapshot: LearningRunPublicV1;
};

export type LearningRunDemoScenarioV1 = {
  scenarioId: string;
  title: string;
  description: string;
  frames: LearningRunDemoFrameV1[];
};

const TEXT_TASK: LearningTaskPublicV1 = {
  taskId: "task-explain-retrieval",
  sequence: 1,
  intent: "explain",
  purpose: "formal",
  title: "解释其中的机制",
  prompt: "为什么主动回忆通常比重复阅读更能帮助长期记忆？",
  targetSummary: "说明主动提取如何加强记忆线索，以及反馈在其中的作用。",
  interaction: {
    kind: "text_response",
    maxChars: 600,
    placeholder: "不用写得完整，先说清最关键的因果关系……",
  },
  alternatives: [
    {
      alternativeId: "voice",
      label: "直接说",
      detail: "用 20–40 秒口头讲清楚",
      interactionKind: "voice_teachback",
      trustCeiling: "mastery_eligible",
    },
    {
      alternativeId: "ordering",
      label: "排出因果链",
      detail: "用几个步骤重建关键机制",
      interactionKind: "ordering",
      trustCeiling: "facet_eligible",
    },
  ],
  trustCeiling: "mastery_eligible",
  estimatedActiveSeconds: 58,
  status: "active",
  revision: 1,
};

const VOICE_TASK: LearningTaskPublicV1 = {
  ...TEXT_TASK,
  taskId: "task-voice-retrieval",
  title: "像教别人一样说一遍",
  interaction: {
    kind: "voice_teachback",
    maxSeconds: 45,
    language: "zh-CN",
  },
  alternatives: [
    {
      alternativeId: "text",
      label: "写一小段",
      detail: "用两三句话说明因果关系",
      interactionKind: "text_response",
      trustCeiling: "mastery_eligible",
    },
    {
      alternativeId: "ordering",
      label: "排出因果链",
      detail: "不说话，重建三个关键步骤",
      interactionKind: "ordering",
      trustCeiling: "facet_eligible",
    },
  ],
};

const VOICE_ERROR_TASK: LearningTaskPublicV1 = {
  ...VOICE_TASK,
  taskId: "task-voice-permission-error",
  interaction: {
    kind: "voice_teachback",
    maxSeconds: 45,
    language: "zh-CN",
    availability: "permission_denied",
  },
};

const ORDERING_TASK: LearningTaskPublicV1 = {
  ...TEXT_TASK,
  taskId: "task-ordering-retrieval",
  intent: "procedure",
  purpose: "facet",
  title: "重建主动回忆的学习链",
  prompt: "把下面三个动作排成更有效的学习顺序。",
  targetSummary: "区分提取、核对和间隔再次提取之间的关系。",
  interaction: {
    kind: "ordering",
    publicTokenIds: ["compare", "recall", "repeat"],
    publicTokenLabels: {
      compare: "对照材料，定位遗漏或错误",
      recall: "先合上材料，主动尝试回忆",
      repeat: "隔一段时间再次主动提取",
    },
  },
  alternatives: [
    {
      alternativeId: "voice",
      label: "直接说",
      detail: "口头解释这三个动作的顺序",
      interactionKind: "voice_teachback",
      trustCeiling: "mastery_eligible",
    },
    {
      alternativeId: "text",
      label: "写一小段",
      detail: "用两三句话说明顺序",
      interactionKind: "text_response",
      trustCeiling: "mastery_eligible",
    },
  ],
  trustCeiling: "facet_eligible",
  estimatedActiveSeconds: 36,
};

const REPAIR_TASK: LearningTaskPublicV1 = {
  ...TEXT_TASK,
  taskId: "task-repair-familiarity",
  intent: "repair",
  purpose: "facet",
  title: "修复一个常见误解",
  prompt: "哪一句把“看着熟悉”误当成了“能够独立提取”？",
  targetSummary: "区分材料带来的熟悉感与离开材料后的可提取性。",
  interaction: {
    kind: "repair",
    publicElementIds: ["s1", "s2", "s3"],
    allowedOperationKinds: ["replace"],
    replacementOptionIds: ["opt-a", "opt-b", "opt-c"],
    publicElementLabels: {
      s1: "重复阅读会让内容越来越熟悉，所以最后自然就能独立回忆。",
      s2: "主动回忆先暴露提取缺口，再通过反馈修正错误线索。",
      s3: "间隔后的再次提取可以检验线索是否真的稳定。",
    },
    replacementOptionLabels: {
      "opt-a": "熟悉感只能说明再次看到时容易辨认；是否掌握，还要看离开材料后能否主动提取。",
      "opt-b": "重复阅读只有在之后能离开材料主动提取，并根据反馈修正遗漏时，才更可能形成稳定记忆。",
      "opt-c": "看着熟悉依赖材料提供线索，而真正会了意味着不看材料也能把关键内容提取出来。",
    },
  },
  alternatives: [
    {
      alternativeId: "voice",
      label: "直接解释",
      detail: "口头指出哪里有问题",
      interactionKind: "voice_teachback",
      trustCeiling: "mastery_eligible",
    },
    {
      alternativeId: "text",
      label: "写下修复",
      detail: "用一两句话改写错误解释",
      interactionKind: "text_response",
      trustCeiling: "mastery_eligible",
    },
  ],
  trustCeiling: "facet_eligible",
  estimatedActiveSeconds: 42,
};

const PARAPHRASE_TASK: LearningTaskPublicV1 = {
  ...TEXT_TASK,
  taskId: "task-paraphrase-choice",
  intent: "paraphrase",
  purpose: "facet",
  title: "换成日常说法，但别丢掉机制",
  prompt: "哪一种说法最接近“主动回忆强化可访问的记忆线索”？",
  targetSummary: "用更自然的表达保留“主动提取”与“之后更容易访问”这层关系。",
  interaction: {
    kind: "choice_with_rationale",
    choices: [
      { id: "c1", label: "每次把答案从脑中找出来，都在把下次找到它的路走得更清楚。", detail: "强调提取路径会因使用而更可访问" },
      { id: "c2", label: "把同一页多看几遍，字看熟了就会自动记住。", detail: "把熟悉感当成独立提取" },
      { id: "c3", label: "只要第一次理解得足够深，以后就不需要再回想。", detail: "忽略后续提取与间隔" },
    ],
    rationales: [
      { id: "r1", label: "保留了主动从记忆中找答案" },
      { id: "r2", label: "说明了对下一次访问的影响" },
      { id: "r3", label: "没有把看熟当成会了" },
      { id: "r4", label: "使用了更多专业术语" },
    ],
    minRationales: 2,
  },
  alternatives: [
    { alternativeId: "text", label: "自己说一句", detail: "写一句更自然的改写", interactionKind: "text_response", trustCeiling: "mastery_eligible" },
    { alternativeId: "voice", label: "直接说", detail: "口头换一种说法", interactionKind: "voice_teachback", trustCeiling: "mastery_eligible" },
  ],
  trustCeiling: "facet_eligible",
  estimatedActiveSeconds: 38,
};

const EXAMPLE_TASK: LearningTaskPublicV1 = {
  ...TEXT_TASK,
  taskId: "task-example-scenario",
  intent: "example",
  purpose: "facet",
  title: "从具体情境里认出一个真正的例子",
  prompt: "下面这种复习时刻，哪一步最能形成主动回忆？",
  targetSummary: "识别“先离开材料尝试提取，再核对”的具体行为，而不是只看结果像不像。",
  interaction: {
    kind: "scenario",
    scenario: "小林明天要考概念定义。今晚她打开笔记，发现这页内容看起来已经非常熟悉。",
    choices: [
      { id: "open-read", label: "继续从头读三遍", consequence: "材料始终提供完整线索" },
      { id: "close-recall", label: "合上笔记，先说出定义再核对", consequence: "先暴露提取缺口，再获得反馈" },
      { id: "highlight", label: "把关键词换一种颜色标亮", consequence: "增强视觉显著性，但没有检验能否提取" },
    ],
    cues: [
      { id: "cue-no-source", label: "先离开原材料" },
      { id: "cue-retrieve", label: "主动尝试说出答案" },
      { id: "cue-feedback", label: "之后核对遗漏" },
      { id: "cue-familiar", label: "看起来很熟悉" },
    ],
    minCues: 2,
  },
  alternatives: [
    { alternativeId: "voice", label: "举另一个例子", detail: "直接说一个你自己的场景", interactionKind: "voice_teachback", trustCeiling: "mastery_eligible" },
    { alternativeId: "text", label: "写一个例子", detail: "用一两句话描述具体情境", interactionKind: "text_response", trustCeiling: "mastery_eligible" },
  ],
  trustCeiling: "facet_eligible",
  estimatedActiveSeconds: 44,
};

const APPLY_RELATION_TASK: LearningTaskPublicV1 = {
  ...TEXT_TASK,
  taskId: "task-apply-relation",
  intent: "apply",
  purpose: "practice",
  title: "把当前信号连接到下一步动作",
  prompt: "如果你发现“答案一看就认识，但合上材料说不出”，下一步应该连接到什么动作？",
  targetSummary: "根据熟悉感与可提取性的差异，选择能直接暴露并修补缺口的动作。",
  interaction: {
    kind: "relation",
    publicNodeIds: ["signal", "target-recall"],
    allowedEdgeKinds: ["therefore", "contrast", "example"],
    publicNodeLabels: {
      signal: "看着熟悉，合上后说不出",
      "target-recall": "先回忆，再对照修补",
    },
  },
  alternatives: [
    { alternativeId: "scenario", label: "换个应用情境", detail: "在具体场景里选行动", interactionKind: "scenario", trustCeiling: "practice_only" },
    { alternativeId: "text", label: "写下做法", detail: "用一句话说下一步", interactionKind: "text_response", trustCeiling: "mastery_eligible" },
  ],
  trustCeiling: "practice_only",
  estimatedActiveSeconds: 32,
};

const BASE_RUN: LearningRunPublicV1 = {
  runId: "run-ui-redraw-demo",
  origin: "card",
  originLabel: "学习卡",
  returnLabel: "返回学习卡",
  keyPointTitle: "主动回忆与长期记忆",
  keyPointContext: "学习方法 · 记忆策略",
  phase: "active",
  timeBudgetSeconds: 180,
  plannedActiveSeconds: 132,
  activeSecondsUsed: 18,
  progressLabel: "第 1 个动作 · 预计还需约 2 分钟",
  activeTask: TEXT_TASK,
  activeAssessment: null,
  checkpoint: null,
  failure: null,
  result: null,
  revision: 1,
};

function resultFor(outcome: LearningRunOutcomeV1): LearningRunResultV1 {
  switch (outcome) {
    case "demonstrated":
      return {
        outcome,
        eyebrow: "这次证明有效",
        title: "你已经讲清了主动回忆为什么有效",
        summary: "你的回答同时覆盖了主动提取、记忆线索强化和反馈修正三个关键点。",
        demonstratedFacets: ["解释了主动提取的作用", "说明了反馈如何修正错误"],
        gapFacets: [],
        scheduleImpact: {
          kind: "created",
          dueLabel: "预计 3 天后",
          explanation: "已根据这次可信回答创建第一次复习。",
        },
        nextStep: "现在可以回到卡片；到期时系统会提醒你再次独立回忆。",
      };
    case "partial":
      return {
        outcome,
        eyebrow: "已经证明一部分",
        title: "主动提取说清楚了，反馈的作用还不够具体",
        summary: "你已经说明了“从记忆中找答案”的价值，但还没有解释为什么核对错误会帮助下次提取。",
        demonstratedFacets: ["主动提取会强化可访问的记忆线索"],
        gapFacets: ["反馈如何修正错误线索"],
        scheduleImpact: { kind: "none", explanation: "这次只形成局部证据，复习时间没有改变。" },
        nextStep: "可以结束，也可以用 30 秒完成一个针对反馈机制的小修补。",
      };
    case "needs_repair":
      return {
        outcome,
        eyebrow: "发现一个需要修补的点",
        title: "重复阅读和主动回忆的作用被混在了一起",
        summary: "熟悉感不等于能独立提取。这里更需要区分“看着觉得懂”和“不看材料能说出来”。",
        demonstratedFacets: ["知道需要多次接触材料"],
        gapFacets: ["熟悉感与可提取性的区别"],
        scheduleImpact: { kind: "none", explanation: "存在关键混淆，本轮没有改变正式复习安排。" },
        nextStep: "下一步建议做一个正反例辨析，不需要重新写长答案。",
      };
    case "not_assessable":
      return {
        outcome,
        eyebrow: "这次无法可靠评估",
        title: "录音里有一段没有转写清楚",
        summary: "系统无法确认关键因果关系，因此不会把这次输入当成答对或答错。",
        demonstratedFacets: [],
        gapFacets: ["关键内容不可辨"],
        scheduleImpact: { kind: "none", explanation: "没有可评估证据，掌握状态和复习时间都没有变化。" },
        nextStep: "可以重录、换成两三句话，或今天先结束。",
      };
    case "practice_completed":
      return {
        outcome,
        eyebrow: "练习完成",
        title: "你已经借助提示理清了这条因果链",
        summary: "因为本题使用了提示，这次只记录为练习，不作为独立理解证明。",
        demonstratedFacets: [],
        gapFacets: ["仍需在没有提示时独立说明"],
        scheduleImpact: { kind: "none", explanation: "提示后练习不会改变正式掌握状态或复习时间。" },
        nextStep: "下次遇到这条内容时，系统会优先让你无提示再试一次。",
      };
    case "skipped":
      return {
        outcome,
        eyebrow: "本轮已跳过",
        title: "这次没有形成理解证据",
        summary: "跳过只是表示现在不想做，不会被记录成不会，也不会产生负面评价。",
        demonstratedFacets: [],
        gapFacets: [],
        scheduleImpact: { kind: "none", explanation: "原有复习安排保持不变。" },
        nextStep: "可以回到原页面，之后再从同一条内容开始。",
      };
    case "declared_unable":
      return {
        outcome,
        eyebrow: "已记录为暂时不会",
        title: "已经诚实记下这一处理解缺口",
        summary: "这不是失败，也不算复习通过；当前 UI 只记录你现在还无法独立解释，不会自行承诺改动复习时间。",
        demonstratedFacets: [],
        gapFacets: ["主动提取与反馈之间的机制"],
        scheduleImpact: { kind: "none", explanation: "本 UI 预览没有调度授权，因此原有复习安排保持不变。" },
        nextStep: "现在不需要继续答题；可以回到来源页面查看材料，之后再决定何时修补。",
      };
  }
}

function frame(
  frameId: string,
  label: string,
  note: string,
  patch: Partial<LearningRunPublicV1>,
): LearningRunDemoFrameV1 {
  return {
    frameId,
    label,
    note,
    snapshot: { ...BASE_RUN, ...patch, revision: BASE_RUN.revision + 1 },
  };
}

const RESULT_FRAMES = (
  [
    "demonstrated",
    "partial",
    "needs_repair",
    "not_assessable",
    "practice_completed",
    "skipped",
    "declared_unable",
  ] as const
).map((outcome) =>
  frame(
    `result-${outcome}`,
    outcome,
    "七种结果语义逐一检查；只有 Commit 成功的结果可以显示调度变化。",
    {
      phase: "completed",
      activeTask: null,
      progressLabel: "本轮已结算",
      result: resultFor(outcome),
    },
  ),
);

export const LEARNING_RUN_DEMO_SCENARIOS: LearningRunDemoScenarioV1[] = [
  {
    scenarioId: "card-text",
    title: "学习卡 · 文字解释",
    description: "从准备、独立回答、评估到创建首次复习的完整主路径。",
    frames: [
      frame("prepare", "准备任务", "不显示空白页，也不使用压迫式倒计时。", {
        phase: "preparing",
        activeTask: null,
        progressLabel: "正在准备适合当前内容的学习动作",
      }),
      frame("active-text", "文字作答", "题型意图与输入方式解耦；用户可换方式、跳过或声明不会。", {
        phase: "active",
        activeTask: TEXT_TASK,
      }),
      frame("active-text-hint", "提示后练习", "提示只缩小观察范围；用户仍需完成作答，提交后才算练习完成。", {
        phase: "active",
        activeTask: {
          ...TEXT_TASK,
          purpose: "practice",
          trustCeiling: "practice_only",
          hint: "先想两个时刻：不看材料时，你必须自己找到答案；核对材料时，你会发现并修正刚才没有提取出来的部分。",
        },
        progressLabel: "提示已显示 · 完成本题后只记录为练习",
      }),
      frame("assessing", "独立评估", "Artifact 已锁定；禁止重复提交，等待时允许离开。", {
        phase: "assessing",
        activeTask: { ...TEXT_TASK, status: "answered" },
        activeAssessment: {
          assessmentId: "assessment-demo",
          status: "running",
          statusDetail: "正在逐项核对解释中的因果关系",
        },
        progressLabel: "回答已锁定 · 正在独立评估",
      }),
      frame("committing", "写入结果", "Result 仍为空，不能提前声称已安排复习。", {
        phase: "committing",
        activeTask: null,
        activeAssessment: {
          assessmentId: "assessment-demo",
          status: "completed",
          statusDetail: "评估完成，正在确认学习记录与复习安排",
        },
        progressLabel: "评估完成 · 正在确认最终结果",
      }),
      frame("completed", "可信结算", "结算只回答证明点、缺口、调度影响与下一步。", {
        phase: "completed",
        activeTask: null,
        activeAssessment: null,
        progressLabel: "本轮已结算",
        result: resultFor("demonstrated"),
      }),
    ],
  },
  {
    scenarioId: "review-voice",
    title: "到期复习 · 语音失败降级",
    description: "语音是低摩擦正式路径；不可辨时诚实降级，不消费复习。",
    frames: [
      frame("active-voice", "语音回答", "麦克风只在用户主动点击后开启，逐字稿必须确认。", {
        origin: "review",
        originLabel: "到期复习",
        returnLabel: "返回复习队列",
        activeTask: VOICE_TASK,
      }),
      frame("active-voice-error", "麦克风错误", "权限或设备错误会被解释清楚，并提供不带惩罚的降级入口。", {
        origin: "review",
        originLabel: "到期复习",
        returnLabel: "返回复习队列",
        activeTask: VOICE_ERROR_TASK,
      }),
      frame("active-text-fallback", "文字降级", "语音转文字会进入真正的文字题，而不是误跳到排序题。", {
        origin: "review",
        originLabel: "到期复习",
        returnLabel: "返回复习队列",
        activeTask: { ...TEXT_TASK, taskId: "task-review-text-fallback" },
      }),
      frame("checkpoint-voice", "无法评估", "保留到期项，提供重录、换方式或结束。", {
        origin: "review",
        originLabel: "到期复习",
        returnLabel: "返回复习队列",
        phase: "checkpoint",
        activeTask: null,
        checkpoint: {
          kind: "not_assessable",
          title: "关键内容没有转写清楚",
          detail: "这次不会记为答错，也不会消耗当前复习。你可以换成文字或重新录一遍。",
          primaryAction: "换成两三句话",
        },
      }),
      frame("active-ordering", "无键盘结构题", "点选与键盘均可完成；单个结构题只形成 facet 证据。", {
        origin: "review",
        originLabel: "到期复习",
        returnLabel: "返回复习队列",
        activeTask: ORDERING_TASK,
      }),
      frame("active-repair", "错误解释修复", "选择问题句与修复动作；全部使用原生单选控件。", {
        origin: "review",
        originLabel: "到期复习",
        returnLabel: "返回复习队列",
        activeTask: REPAIR_TASK,
      }),
    ],
  },
  {
    scenarioId: "low-friction-intents",
    title: "低摩擦主观题",
    description: "复述、举例与应用都提供不依赖长文本的结构化作答路径。",
    frames: [
      frame("active-paraphrase-choice", "复述 · 选说法与理由", "不是替用户答题：选择与理由一起构成可检查的 Artifact。", {
        activeTask: PARAPHRASE_TASK,
        progressLabel: "复述理解 · 预计还需约 40 秒",
      }),
      frame("active-example-scenario", "举例 · 具体情境", "用场景行动与判断线索替代开放式长答案。", {
        activeTask: EXAMPLE_TASK,
        progressLabel: "识别具体例子 · 预计还需约 45 秒",
      }),
      frame("active-apply-relation", "应用 · 关系连接", "把观察到的信号连接到行动，形成结构化应用 Artifact。", {
        origin: "star_map",
        originLabel: "理解星图",
        returnLabel: "返回理解星图",
        activeTask: APPLY_RELATION_TASK,
        progressLabel: "应用判断 · 预计还需约 30 秒",
      }),
    ],
  },
  {
    scenarioId: "pause-recovery",
    title: "暂停、错误与过期",
    description: "覆盖恢复、重试、目标过期以及明确终止状态。",
    frames: [
      frame("paused", "已暂停", "草稿和当前交互保留；暂停不等于跳过。", {
        phase: "paused",
        activeTask: TEXT_TASK,
        progressLabel: "已为你保留当前进度",
      }),
      frame("recoverable", "评估可恢复错误", "按失败阶段给出明确重试，不伪造结果。", {
        phase: "recoverable_error",
        activeTask: { ...TEXT_TASK, status: "answered" },
        failure: {
          stage: "assessment",
          title: "评估暂时没有完成",
          detail: "回答已经锁定且不会重复提交。可以重新读取评估，也可以安全结束。",
          retryLabel: "重新读取评估",
        },
      }),
      frame("stale", "运行已过期", "内容或 schedule 变化后必须创建新 Run。", {
        phase: "stale",
        activeTask: null,
        progressLabel: "这次运行已经过期",
      }),
      frame("ended", "主动结束", "未提交内容取消，已完成的结果仍保留。", {
        phase: "ended",
        activeTask: null,
        progressLabel: "本轮已结束",
      }),
      frame("skipped-phase", "整轮跳过", "Run 进入 skipped 终态；不会生成 Assessment 或调度变化。", {
        phase: "skipped",
        activeTask: null,
        progressLabel: "本轮已跳过",
      }),
      frame("cancelled", "运行取消", "运行时退出不会生成学习或调度副作用。", {
        phase: "cancelled",
        activeTask: null,
        progressLabel: "本轮已取消",
      }),
    ],
  },
  {
    scenarioId: "result-semantics",
    title: "结果语义全景",
    description: "逐帧检查七种结果是否诚实表达掌握、练习、跳过与调度变化。",
    frames: RESULT_FRAMES,
  },
];
