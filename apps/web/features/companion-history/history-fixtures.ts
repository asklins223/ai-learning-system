import type {
  CompanionHistoryEntry,
} from "./history-model";

export type CompanionHistoryConversationFixture = {
  id: string;
  title: string;
  createdAt: string;
  lastMessageAt: string | null;
  entries: CompanionHistoryEntry[];
};

/**
 * 只用于 ?preview=full 的显式开发预览。
 * 其中 route_ref / error_detail / recovery_detail 尚不是生产 Message V1 block，
 * 不会传入真实读取链，也不会写入账户数据。
 */
export const COMPANION_HISTORY_FIXTURES: CompanionHistoryConversationFixture[] = [
  {
    id: "preview-review-session",
    title: "遗忘曲线：从疑问到完成复习",
    createdAt: "2026-08-13T01:05:00.000Z",
    lastMessageAt: "2026-08-13T02:02:00.000Z",
    entries: [
      {
        id: "preview-voice",
        role: "user",
        kind: "voice_transcript",
        seq: 1,
        createdAt: "2026-08-13T01:05:00.000Z",
        sourceLabel: "桌面伴星 · 语音",
        blocks: [
          { type: "text", text: "我理解遗忘曲线是记忆会随时间下降，但为什么间隔复习反而比连续背更有效？" },
        ],
      },
      {
        id: "preview-answer",
        role: "assistant",
        kind: "text",
        seq: 2,
        createdAt: "2026-08-13T01:05:08.000Z",
        sourceLabel: "桌面伴星",
        blocks: [
          {
            type: "text",
            text: "因为每次在**快要忘记时重新提取**，都在加固下一次提取所需的线索。连续背诵看起来更流畅，但这种流畅常常来自短时记忆，并不等于之后还能独立想起。",
          },
          {
            type: "citation",
            label: "来源：学习笔记《记忆与复习》",
            entityRef: "note:memory-and-review",
          },
        ],
      },
      {
        id: "preview-proactive",
        role: "assistant",
        kind: "proactive",
        seq: 3,
        createdAt: "2026-08-13T01:42:00.000Z",
        sourceLabel: "系统级主动提醒",
        blocks: [
          {
            type: "text",
            text: "你刚完成了这一节的阅读，但“提取练习为什么有效”还没有形成自己的解释。现在要不要用 3 分钟做一次轻量巩固？",
          },
        ],
      },
      {
        id: "preview-action",
        role: "assistant",
        kind: "action",
        seq: 4,
        createdAt: "2026-08-13T01:43:11.000Z",
        sourceLabel: "桌面伴星 · 经你确认",
        runId: "73e34f8d-4ae6-457a-a4ec-22d5b818e604",
        blocks: [
          { type: "text", text: "已按你的选择创建一轮“用自己的话解释”，预计 3 分钟。" },
          {
            type: "action_ref",
            proposalId: "5ac82082-fc20-4d3e-b44f-b4ed9f24f6d8",
            label: "创建 LearningRun",
            status: "succeeded",
          },
        ],
      },
      {
        id: "preview-route",
        role: "system",
        kind: "route",
        seq: 5,
        createdAt: "2026-08-13T01:43:12.000Z",
        sourceLabel: "系统路由",
        blocks: [
          {
            type: "route_ref",
            route: "/learning-runs/ui-redraw",
            label: "进入 3 分钟学习旅程",
            detail: "来源、上下文和返回位置已随本轮冻结",
          },
        ],
      },
      {
        id: "preview-result",
        role: "assistant",
        kind: "result",
        seq: 6,
        createdAt: "2026-08-13T01:46:37.000Z",
        sourceLabel: "桌面伴星 · 学习结果",
        runId: "73e34f8d-4ae6-457a-a4ec-22d5b818e604",
        blocks: [
          {
            type: "text",
            text: "你已经说清楚了核心机制：**间隔制造了真实提取难度，而成功提取会加强长期线索。** 这一轮记为“已展示理解”。",
          },
          {
            type: "result_ref",
            actionRunId: "73e34f8d-4ae6-457a-a4ec-22d5b818e604",
            label: "LearningRun 结果",
            status: "committed",
          },
        ],
      },
      {
        id: "preview-error",
        role: "system",
        kind: "error",
        seq: 7,
        createdAt: "2026-08-13T01:46:39.000Z",
        sourceLabel: "系统回执",
        blocks: [
          {
            type: "error_detail",
            code: "STAR_PROJECTION_DELAYED",
            detail: "学习结果已安全提交，但星图显影暂时延迟。掌握度与复习调度没有丢失。",
            retryable: true,
          },
        ],
      },
      {
        id: "preview-recovery",
        role: "assistant",
        kind: "recovery",
        seq: 8,
        createdAt: "2026-08-13T02:02:00.000Z",
        sourceLabel: "桌面伴星 · 恢复通知",
        blocks: [
          {
            type: "recovery_detail",
            label: "星图显影已恢复",
            detail: "刚才的结果已经投影到“记忆与复习”路径，无需重新作答。",
          },
          {
            type: "route_ref",
            route: "/graph",
            label: "查看这次变化",
            detail: "只定位本次 Commit 产生的变化",
          },
        ],
      },
    ],
  },
  {
    id: "preview-onboarding",
    title: "第一次进入：认识学习路径",
    createdAt: "2026-08-12T00:20:00.000Z",
    lastMessageAt: "2026-08-12T00:28:00.000Z",
    entries: [
      {
        id: "preview-welcome",
        role: "assistant",
        kind: "proactive",
        seq: 1,
        createdAt: "2026-08-12T00:20:00.000Z",
        sourceLabel: "新用户旅程",
        blocks: [
          { type: "text", text: "欢迎来到你的学习空间。我会先陪你完成一条真实学习路径：导入内容、理解一个要点，再把变化带回星图。" },
        ],
      },
      {
        id: "preview-onboarding-route",
        role: "system",
        kind: "route",
        seq: 2,
        createdAt: "2026-08-12T00:20:05.000Z",
        sourceLabel: "系统路由",
        blocks: [
          { type: "route_ref", route: "/", label: "前往学习空间", detail: "旅程会在你返回后继续" },
        ],
      },
    ],
  },
  {
    id: "preview-concept",
    title: "光合作用：概念解释与例子",
    createdAt: "2026-08-10T07:31:00.000Z",
    lastMessageAt: "2026-08-10T07:42:00.000Z",
    entries: [
      {
        id: "preview-concept-user",
        role: "user",
        kind: "text",
        seq: 1,
        createdAt: "2026-08-10T07:31:00.000Z",
        sourceLabel: "桌面伴星",
        blocks: [{ type: "text", text: "能不能用一个生活里的例子解释光合作用中的能量转换？" }],
      },
      {
        id: "preview-concept-answer",
        role: "assistant",
        kind: "text",
        seq: 2,
        createdAt: "2026-08-10T07:31:06.000Z",
        sourceLabel: "桌面伴星",
        blocks: [{ type: "text", text: "可以把叶片想成一间利用太阳供电的微型厨房：光能驱动加工过程，二氧化碳和水被组织成储存化学能的糖。" }],
      },
    ],
  },
  {
    id: "preview-action-states",
    title: "行动提案：状态如何被记录",
    createdAt: "2026-08-09T03:20:00.000Z",
    lastMessageAt: "2026-08-09T03:28:00.000Z",
    entries: [
      {
        id: "preview-action-awaiting",
        role: "assistant",
        kind: "action",
        seq: 1,
        createdAt: "2026-08-09T03:20:00.000Z",
        sourceLabel: "桌面伴星 · 行动提案",
        blocks: [
          { type: "text", text: "我可以把“牛顿第二定律”加入今天的轻量复习，但需要你先确认。" },
          { type: "action_ref", proposalId: "proposal-awaiting", label: "加入今日复习", status: "awaiting_authorization" },
        ],
      },
      {
        id: "preview-user-confirmation",
        role: "user",
        kind: "action",
        seq: 2,
        createdAt: "2026-08-09T03:21:00.000Z",
        sourceLabel: "桌面伴星 · 用户确认",
        blocks: [{ type: "text", text: "先不要，今天保持原计划。" }],
      },
      {
        id: "preview-action-expired",
        role: "assistant",
        kind: "action",
        seq: 3,
        createdAt: "2026-08-09T03:26:00.000Z",
        sourceLabel: "桌面伴星 · 行动提案",
        blocks: [
          { type: "action_ref", proposalId: "proposal-expired", label: "旧的复习建议", status: "expired" },
        ],
      },
      {
        id: "preview-result-unknown",
        role: "system",
        kind: "result",
        seq: 4,
        createdAt: "2026-08-09T03:28:00.000Z",
        sourceLabel: "系统回执",
        blocks: [
          { type: "result_ref", actionRunId: "run-status-unavailable", label: "历史结果引用" },
        ],
      },
    ],
  },
];
