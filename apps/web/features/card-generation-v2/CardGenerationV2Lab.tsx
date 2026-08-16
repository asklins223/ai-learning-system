"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icons";
import { CandidateReview } from "./CandidateReview";
import { GenerationControls } from "./GenerationControls";
import { LearningCardV2Showcase } from "./LearningCardV2Showcase";
import { ZeroCardResult } from "./ZeroCardResult";
import {
  demoCandidateReveals,
  demoCandidates,
  demoCandidateSummary,
  demoGenerationControls,
  demoZeroCard,
} from "./demo/demo-data";
import type { GenerationControlsDraftV2 } from "./contracts/ui-contracts";

type LabView = "settings" | "progress" | "review" | "zero" | "activation" | "card";

const LAB_VIEWS: Array<{ value: LabView; label: string }> = [
  { value: "settings", label: "生成设置" },
  { value: "progress", label: "生成过程" },
  { value: "review", label: "候选审核" },
  { value: "zero", label: "零卡结果" },
  { value: "activation", label: "启用反馈" },
  { value: "card", label: "学习卡" },
];

export function CardGenerationV2Lab() {
  const [view, setView] = useState<LabView>("review");
  const [controls, setControls] = useState<GenerationControlsDraftV2>(demoGenerationControls);
  const [progressStep, setProgressStep] = useState(2);
  const [activationMode, setActivationMode] = useState<"formal" | "practice">("formal");

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("view");
    if (LAB_VIEWS.some((item) => item.value === requested)) {
      setView(requested as LabView);
    }
  }, []);

  const updateView = (next: LabView) => {
    setView(next);
    window.history.replaceState(null, "", `?view=${next}`);
  };

  return (
    <main className="card-v2-lab">
      <header className="card-v2-lab__header">
        <div>
          <p>LEARNING CARD V2 · UI REDRAW</p>
          <h1>把笔记变成值得练的目标</h1>
          <span>开发预览 · 当前生产后端仍使用 legacy auto-publish，V2 mutation 全部关闭</span>
        </div>
        <nav aria-label="学习卡 V2 预览状态">
          {LAB_VIEWS.map((item) => (
            <button
              type="button"
              key={item.value}
              aria-current={view === item.value ? "page" : undefined}
              onClick={() => updateView(item.value)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="card-v2-lab__stage" data-view={view}>
        {view === "settings" && (
          <GenerationControls
            value={controls}
            noteVersion={12}
            sourceLabel="网络基础 · OSI 七层模型"
            onChange={setControls}
            onSubmit={() => updateView("progress")}
            capability="preview"
          />
        )}

        {view === "progress" && (
          <section className="card-v2-progress-demo" aria-labelledby="card-v2-progress-title">
            <header>
              <div className="card-v2-progress-demo__symbol"><Icon.Sparkle /></div>
              <div>
                <p>正在整理学习目标</p>
                <h2 id="card-v2-progress-title">只留下值得以后回忆的内容</h2>
                <span>基于网络基础 v12 · 可以关闭窗口继续编辑</span>
              </div>
              <button type="button" aria-label="关闭"><Icon.Close /></button>
            </header>
            <ol className="card-v2-progress-demo__steps">
              {[
                ["判断什么值得练", "已完成"],
                ["设计回忆线索", "正在进行"],
                ["核对答案与来源", "接下来"],
                ["准备候选审核", "等待中"],
              ].map(([label, status], index) => (
                <li data-state={index < progressStep ? "done" : index === progressStep ? "active" : "waiting"} key={label}>
                  <span>{index < progressStep ? <Icon.Check /> : index + 1}</span>
                  <p><strong>{label}</strong><small>{status}</small></p>
                </li>
              ))}
            </ol>
            <div className="card-v2-progress-demo__working">
              <span className="card-v2-progress-demo__pulse" aria-hidden="true" />
              <p><strong>正在把相关信息合并为一个学习目标</strong><small>不会为了覆盖每句话而增加卡片</small></p>
            </div>
            <footer>
              <p><Icon.Lock />笔记版本已封存，生成过程不会读取你之后的修改。</p>
              <button type="button" className="card-v2-button card-v2-button--quiet" onClick={() => setProgressStep((step) => (step + 1) % 4)}>预览下一阶段</button>
              <button type="button" className="card-v2-button card-v2-button--secondary" onClick={() => updateView("review")}>查看完成状态</button>
            </footer>
          </section>
        )}

        {view === "review" && (
          <CandidateReview
            summary={demoCandidateSummary}
            initialCandidates={demoCandidates}
            onReveal={async (candidate) => demoCandidateReveals[candidate.candidateId]!}
            onActivate={(selected, exposed) => {
              setActivationMode(exposed ? "practice" : "formal");
              if (selected.length > 0) updateView("activation");
            }}
          />
        )}

        {view === "zero" && <ZeroCardResult result={demoZeroCard} onRetry={() => updateView("settings")} />}

        {view === "activation" && (
          <section className="activation-result" aria-labelledby="activation-result-title">
            <p className="activation-result__eyebrow">2 张学习卡已启用</p>
            <div className="activation-result__heading">
              <div className="activation-result__seal"><Icon.Check /></div>
              <h2 id="activation-result-title">
                {activationMode === "formal" ? "现在可以开始第一次验证" : "内容已保存，先从练习开始"}
              </h2>
            </div>
            <p>
              {activationMode === "formal"
                ? "你还没有查看答案。完成一次可信验证后，系统才会安排后续复习。"
                : "你刚刚查看了候选答案，本次会作为练习；到可验证时系统会提醒你。"}
            </p>
            <div className="activation-result__facts">
              <span><strong>2</strong>张已启用</span>
              <span><strong>0</strong>个复习安排</span>
              <span><strong>1</strong>次首次验证待完成</span>
            </div>
            <footer>
              <button type="button" className="card-v2-button card-v2-button--quiet">稍后再学</button>
              <button type="button" className="card-v2-button card-v2-button--primary">
                <Icon.Play />{activationMode === "formal" ? "用三分钟开始验证" : "现在练一下"}
              </button>
            </footer>
          </section>
        )}

        {view === "card" && <LearningCardV2Showcase />}
      </div>
    </main>
  );
}
