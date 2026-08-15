"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/icons";
import { ActiveLearningCardV2 } from "@/features/learning-card-v2/ActiveLearningCardV2";
import { learningCardInteractionLabels } from "@/features/learning-card-v2/renderers/InteractionRendererRegistry";
import type { PublicLearningCardPreviewV2 } from "./contracts/ui-contracts";
import { demoPublicCardReveals, demoPublicCards } from "./demo/demo-data";

type CardScenarioKey =
  | "initial"
  | "revealed"
  | "deferred"
  | "in_progress"
  | "review_due"
  | "scheduled"
  | "idle"
  | "source_outdated"
  | "archived"
  | "superseded"
  | "stale"
  | "reveal_error";

const SCENARIOS: Array<{
  key: CardScenarioKey;
  label: string;
  description: string;
}> = [
  { key: "initial", label: "正面首次验证", description: "未看答案，可以开始第一次可信验证。" },
  { key: "revealed", label: "已揭示练习", description: "答案来自独立 Reveal receipt，本次进入练习语义。" },
  { key: "deferred", label: "验证延后", description: "首次验证已有延后安排，不冒充已掌握。" },
  { key: "in_progress", label: "学习进行中", description: "存在未完成的 LearningRun，主操作只继续本轮。" },
  { key: "review_due", label: "复习到期", description: "可信复习窗口已到，优先开始到期复习。" },
  { key: "scheduled", label: "复习已安排", description: "当前无需复习，可以查看下一次安排。" },
  { key: "idle", label: "自主练习", description: "没有强制任务，但允许进行不计首次验证的练习。" },
  { key: "source_outdated", label: "来源更新", description: "只提示来源已有更新，不阻塞当前学习。" },
  { key: "archived", label: "已归档", description: "只保留历史；不显示答案，也不能开始新学习。" },
  { key: "superseded", label: "已替代", description: "目标已迁移；唯一主操作是查看新版卡片。" },
  { key: "stale", label: "内容失效", description: "呈现契约已失效；刷新前不显示答案或开始学习。" },
  { key: "reveal_error", label: "揭示失败", description: "Exposure 未确认或读取失败，答案继续留在 DOM 之外。" },
];

function cardForScenario(
  source: PublicLearningCardPreviewV2,
  scenario: CardScenarioKey,
): PublicLearningCardPreviewV2 {
  const card: PublicLearningCardPreviewV2 = {
    ...source,
    lifecycle: { status: "active", label: "学习中", detail: "这张卡处于可学习状态。" },
    freshness: { status: "current", label: "内容最新", detail: "学习卡与来源版本一致。", sourceVersion: 12 },
    personalState: {
      status: "initial_validation_ready",
      label: "等待首次验证",
      detail: "还没有可信学习记录，也没有创建复习安排。",
    },
    primaryAction: { intent: "start", label: "开始首次验证" },
  };

  switch (scenario) {
    case "deferred":
      card.personalState = { status: "initial_validation_deferred", label: "首次验证已延后", detail: "明天 09:00 再进行首次验证；现在查看答案仍只算预习。" };
      card.primaryAction = { intent: "open_schedule", label: "查看首次验证安排" };
      break;
    case "in_progress":
      card.personalState = { status: "in_progress", label: "学习进行中", detail: "本轮已完成 2 / 5 个微任务，可以从上次位置继续。" };
      card.primaryAction = { intent: "continue", label: "继续本次学习" };
      break;
    case "review_due":
      card.personalState = { status: "review_due", label: "复习到期", detail: "今天是建议复习窗口；完成后才会更新下一次安排。" };
      card.primaryAction = { intent: "review", label: "开始到期复习" };
      break;
    case "scheduled":
      card.personalState = { status: "review_scheduled", label: "复习已安排", detail: "下一次复习安排在 8 月 18 日，目前无需重复消耗注意力。" };
      card.primaryAction = { intent: "open_schedule", label: "查看复习安排" };
      break;
    case "idle":
      card.personalState = { status: "idle", label: "当前无待办", detail: "没有到期任务；可以自由练习，但不会冒充到期复习。" };
      card.primaryAction = { intent: "start", label: "开始自由练习" };
      break;
    case "source_outdated":
      card.freshness = { status: "source_outdated", label: "来源笔记已有更新", detail: "当前卡仍可学习；完成后可基于 v13 检查是否需要修订。", sourceVersion: 13 };
      break;
    case "archived":
      card.lifecycle = { status: "archived", label: "已归档", detail: "这张卡已退出学习队列，只保留历史学习记录。" };
      card.primaryAction = { intent: "return", label: "返回学习卡库" };
      break;
    case "superseded":
      card.lifecycle = { status: "superseded", label: "已被新版替代", detail: "学习目标已迁移，旧卡不再产生新的学习记录。", replacementCardId: "card-osi-v3" };
      card.primaryAction = { intent: "open_replacement", label: "查看新版学习卡" };
      break;
    case "stale":
      card.freshness = { status: "stale_presentation", label: "内容呈现已失效", detail: "卡片格式或来源映射已变化，需要刷新后再继续。", sourceVersion: 13 };
      card.primaryAction = { intent: "refresh", label: "刷新学习卡内容" };
      break;
    case "initial":
    case "revealed":
    case "reveal_error":
      break;
  }
  return card;
}

export function LearningCardV2Showcase() {
  const [cardIndex, setCardIndex] = useState(0);
  const [scenario, setScenario] = useState<CardScenarioKey>("initial");
  const [notice, setNotice] = useState("");
  const sourceCard = demoPublicCards[cardIndex] ?? demoPublicCards[0]!;
  const card = useMemo(() => cardForScenario(sourceCard, scenario), [sourceCard, scenario]);
  const scenarioMeta = SCENARIOS.find((item) => item.key === scenario) ?? SCENARIOS[0]!;
  const receipt = scenario === "revealed" ? demoPublicCardReveals[card.cardId] ?? null : null;
  const revealError = scenario === "reveal_error" ? "Exposure receipt 未确认：答案保持隐藏，请稍后重试。" : null;

  const previewAction = (message: string) => {
    setNotice(`合成预览：${message}；待 V2 后端接通，本次没有写入任何学习记录。`);
  };

  return (
    <section className="learning-card-showcase" aria-label="Active Learning Card V2 双轴状态预览">
      <header className="learning-card-showcase__header">
        <div>
          <p>ORTHOGONAL STATE MATRIX</p>
          <h2>卡型 × 学习状态</h2>
          <span>每个组合都是合成预览 · 待 V2 后端；不是生产数据。</span>
        </div>
        <span><Icon.Lock />0 次真实写入</span>
      </header>

      <div className="learning-card-showcase__axis">
        <div className="learning-card-showcase__axis-title">
          <span>01</span><div><strong>练习结构</strong><small>七种都不是同一个问答模板</small></div>
        </div>
        <div className="learning-card-showcase__type-picker" role="tablist" aria-label="学习卡练习结构">
          {demoPublicCards.map((item, index) => (
            <button
              key={item.cardId}
              type="button"
              role="tab"
              aria-selected={cardIndex === index}
              data-selected={cardIndex === index}
              onClick={() => { setCardIndex(index); setNotice(""); }}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              {learningCardInteractionLabels[item.front.kind]}
            </button>
          ))}
        </div>
      </div>

      <div className="learning-card-showcase__axis">
        <div className="learning-card-showcase__axis-title">
          <span>02</span><div><strong>生命周期与学习状态</strong><small>正交组合按阻塞优先级呈现</small></div>
        </div>
        <div className="learning-card-showcase__state-picker" role="tablist" aria-label="学习卡状态">
          {SCENARIOS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={scenario === item.key}
              data-selected={scenario === item.key}
              onClick={() => { setScenario(item.key); setNotice(""); }}
            >
              <i aria-hidden="true" />{item.label}
            </button>
          ))}
        </div>
        <p className="learning-card-showcase__scenario-note">
          <strong>{scenarioMeta.label}</strong><span>{scenarioMeta.description}</span>
        </p>
      </div>

      <div className="learning-card-showcase__canvas">
        <ActiveLearningCardV2
          key={`${card.cardId}-${scenario}`}
          card={card}
          capability="preview"
          initialReveal={receipt}
          initialRevealError={revealError}
          onReveal={async () => demoPublicCardReveals[card.cardId]!}
          onStartLearning={() => previewAction("将创建对应语义的 LearningRun")}
          onStateAction={({ intent }) => previewAction(`将执行状态操作 ${intent}`)}
        />
      </div>

      <p className="learning-card-showcase__notice" aria-live="polite">
        {notice || "合成预览 · 待 V2 后端：Card、Reveal receipt、Exposure、LearningRun 与个人状态均未写入。"}
      </p>
    </section>
  );
}
