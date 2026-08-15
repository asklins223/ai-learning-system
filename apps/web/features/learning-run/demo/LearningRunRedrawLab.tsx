"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/ui/icons";
import type {
  LearningRunUiIntentV1,
  LearningTaskDraftV1,
  LearningTaskInteractionV1,
} from "../contracts";
import {
  LEARNING_RUN_DEMO_SCENARIOS,
  type LearningRunDemoScenarioV1,
} from "../demo-fixtures";
import { LearningRunPlayer } from "../player/LearningRunPlayer";
import { applyLearningRunDemoQuery, resolveLearningRunDemoQuery } from "./demo-context";

type FrameLocation = { scenarioId: string; frameIndex: number };

function initialFrameIndex(scenarioId: string, origin: ReturnType<typeof resolveLearningRunDemoQuery>["origin"]): number {
  if (scenarioId === "card-text") return 1;
  if (scenarioId === "low-friction-intents" && origin === "star_map") return 2;
  return 0;
}

function interactionKindForAlternative(
  alternativeId: string,
  activeTask: LearningRunDemoScenarioV1["frames"][number]["snapshot"]["activeTask"],
): LearningTaskInteractionV1["kind"] | null {
  const declared = activeTask?.alternatives.find((alternative) => alternative.alternativeId === alternativeId)?.interactionKind;
  if (declared) return declared;
  if (alternativeId === "text") return "text_response";
  if (alternativeId === "voice") return "voice_teachback";
  if (alternativeId === "ordering") return "ordering";
  if (alternativeId === "scenario") return "scenario";
  if (alternativeId === "relation") return "relation";
  return null;
}

function findInteractionFrame(kind: LearningTaskInteractionV1["kind"], currentScenarioId: string): FrameLocation | null {
  const preferredScenarios = [
    ...LEARNING_RUN_DEMO_SCENARIOS.filter((scenario) => scenario.scenarioId === currentScenarioId),
    ...LEARNING_RUN_DEMO_SCENARIOS.filter((scenario) => scenario.scenarioId !== currentScenarioId),
  ];
  for (const scenario of preferredScenarios) {
    const frameIndex = scenario.frames.findIndex((candidate) => {
      if (candidate.snapshot.activeTask?.interaction.kind !== kind || candidate.snapshot.phase !== "active") return false;
      if (kind === "voice_teachback") {
        const interaction = candidate.snapshot.activeTask.interaction;
        return interaction.kind === "voice_teachback" && (!interaction.availability || interaction.availability === "available");
      }
      return true;
    });
    if (frameIndex >= 0) return { scenarioId: scenario.scenarioId, frameIndex };
  }
  return null;
}

function findFrame(scenarioId: string, frameId: string): FrameLocation | null {
  const scenario = LEARNING_RUN_DEMO_SCENARIOS.find((candidate) => candidate.scenarioId === scenarioId);
  const frameIndex = scenario?.frames.findIndex((candidate) => candidate.frameId === frameId) ?? -1;
  return scenario && frameIndex >= 0 ? { scenarioId, frameIndex } : null;
}

export function LearningRunRedrawLab() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const context = useMemo(() => resolveLearningRunDemoQuery(new URLSearchParams(queryString)), [queryString]);
  const [scenarioId, setScenarioId] = useState(context.initialScenarioId);
  const [frameIndex, setFrameIndex] = useState(() => initialFrameIndex(context.initialScenarioId, context.origin));
  const [lastIntent, setLastIntent] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, LearningTaskDraftV1>>({});
  const pausedReturn = useRef<FrameLocation | null>(null);

  useEffect(() => {
    setScenarioId(context.initialScenarioId);
    setFrameIndex(initialFrameIndex(context.initialScenarioId, context.origin));
    setLastIntent(null);
  }, [context.initialScenarioId, context.origin, queryString]);

  const scenario = useMemo(
    () => LEARNING_RUN_DEMO_SCENARIOS.find((item) => item.scenarioId === scenarioId) ?? LEARNING_RUN_DEMO_SCENARIOS[0],
    [scenarioId],
  );
  const safeFrameIndex = Math.min(frameIndex, scenario.frames.length - 1);
  const frame = scenario.frames[safeFrameIndex];
  const contextualRun = useMemo(() => applyLearningRunDemoQuery(frame.snapshot, context), [context, frame.snapshot]);

  const moveTo = (location: FrameLocation | null) => {
    if (!location) return false;
    setScenarioId(location.scenarioId);
    setFrameIndex(location.frameIndex);
    return true;
  };

  const selectScenario = (next: LearningRunDemoScenarioV1) => {
    setScenarioId(next.scenarioId);
    setFrameIndex(initialFrameIndex(next.scenarioId, context.origin));
    setLastIntent(null);
    document.documentElement.removeAttribute("data-learning-run-lab-open");
  };

  const selectFrame = (nextFrameIndex: number) => {
    setFrameIndex(nextFrameIndex);
    document.documentElement.removeAttribute("data-learning-run-lab-open");
  };

  const dispatch = (intent: LearningRunUiIntentV1) => {
    setLastIntent(intentLabel(intent));
    if (intent.kind === "back" || intent.kind === "leave_while_waiting") {
      router.push(context.returnTo);
      return;
    }
    if (intent.kind === "switch_variant") {
      const interactionKind = interactionKindForAlternative(intent.alternativeId, contextualRun.activeTask);
      if (interactionKind) moveTo(findInteractionFrame(interactionKind, scenario.scenarioId));
      return;
    }
    if (
      intent.kind === "submit_text"
      || intent.kind === "submit_voice"
      || intent.kind === "submit_ordering"
      || intent.kind === "submit_repair"
      || intent.kind === "submit_choice_with_rationale"
      || intent.kind === "submit_scenario"
      || intent.kind === "submit_relation"
    ) {
      const assessingIndex = scenario.frames.findIndex((item) => item.snapshot.phase === "assessing");
      if (assessingIndex >= 0) setFrameIndex(assessingIndex);
      else if (contextualRun.activeTask?.purpose === "practice") moveTo(findFrame("result-semantics", "result-practice_completed"));
      else moveTo(findFrame("result-semantics", "result-demonstrated"));
      return;
    }
    if (intent.kind === "pause") {
      pausedReturn.current = { scenarioId: scenario.scenarioId, frameIndex: safeFrameIndex };
      moveTo(findFrame("pause-recovery", "paused"));
      return;
    }
    if (intent.kind === "declare_unable") {
      moveTo(findFrame("result-semantics", "result-declared_unable"));
      return;
    }
    if (intent.kind === "skip_task") {
      moveTo(findFrame("result-semantics", "result-skipped"));
      return;
    }
    if (intent.kind === "request_hint") {
      moveTo(dispatchLearningRunDemoIntent(intent, { scenarioId: scenario.scenarioId, frameIndex: safeFrameIndex }));
      return;
    }
    if (intent.kind === "resume") {
      const restore = pausedReturn.current ?? {
        scenarioId: context.initialScenarioId,
        frameIndex: initialFrameIndex(context.initialScenarioId, context.origin),
      };
      moveTo(restore);
      return;
    }
    if (intent.kind === "retry") {
      if (frame.frameId === "result-not_assessable") moveTo(findFrame("review-voice", "active-voice"));
      else if (safeFrameIndex > 0) setFrameIndex(safeFrameIndex - 1);
      return;
    }
    if (intent.kind === "checkpoint_primary") {
      if (frame.frameId === "result-partial" || frame.frameId === "result-needs_repair") {
        moveTo(findFrame("review-voice", "active-repair"));
      } else if (safeFrameIndex < scenario.frames.length - 1) {
        setFrameIndex(safeFrameIndex + 1);
      }
      return;
    }
    if (intent.kind === "finish_checkpoint") {
      moveTo(dispatchLearningRunDemoIntent(intent, {
        scenarioId: scenario.scenarioId,
        frameIndex: safeFrameIndex,
        checkpointKind: contextualRun.checkpoint?.kind,
      }));
      return;
    }
    if (intent.kind === "create_fresh_run") {
      setScenarioId(context.initialScenarioId);
      setFrameIndex(0);
      return;
    }
    if (intent.kind === "end") {
      const endedIndex = scenario.frames.findIndex((item) => item.snapshot.phase === "ended");
      if (endedIndex >= 0) setFrameIndex(endedIndex);
      else moveTo(findFrame("pause-recovery", "ended"));
    }
  };

  return (
    <div className="learning-run-redraw-lab">
      <div className="learning-run-prototype-banner" role="note">
        <span><Icon.Sparkle2 aria-hidden="true" />UI 重绘原型</span>
        <p>
          {context.explicitSource
            ? `${context.originLabel}来源已识别${context.targetReference ? "，目标标识已保留" : ""}；不读取真实内容，不写入学习结果。`
            : "使用与正式方案同形的前端 fixture；尚未接入 API、Assessment、Commit 或复习写入。"}
        </p>
        {context.consumedParameters.length > 0 ? <small>已消费：{context.consumedParameters.join(" · ")}</small> : null}
        <button type="button" onClick={() => document.documentElement.toggleAttribute("data-learning-run-lab-open")}>场景说明</button>
      </div>

      <LearningRunPlayer
        run={contextualRun}
        onIntent={dispatch}
        drafts={drafts}
        onDraftChange={(taskId, draft) => setDrafts((current) => ({ ...current, [taskId]: draft }))}
      />

      <aside className="learning-run-lab-dock" aria-label="UI 状态预览控制器">
        <div className="learning-run-lab-dock__heading">
          <span>状态预览</span>
          <strong>{scenario.title}</strong>
          <p>{frame.label} · {frame.note}</p>
          <button className="learning-run-lab-dock__close" type="button" onClick={() => document.documentElement.removeAttribute("data-learning-run-lab-open")}>收起</button>
        </div>
        <div className="learning-run-lab-dock__scenarios">
          {LEARNING_RUN_DEMO_SCENARIOS.map((item) => (
            <button key={item.scenarioId} type="button" className={item.scenarioId === scenario.scenarioId ? "is-active" : ""} onClick={() => selectScenario(item)}>
              {item.title}
            </button>
          ))}
        </div>
        <div className="learning-run-lab-dock__frames">
          <button type="button" disabled={safeFrameIndex === 0} onClick={() => setFrameIndex((current) => Math.max(0, current - 1))} aria-label="上一个状态"><PrevIcon /></button>
          <label>
            <span>当前状态</span>
            <select value={safeFrameIndex} onChange={(event) => selectFrame(Number(event.target.value))}>
              {scenario.frames.map((item, index) => <option key={item.frameId} value={index}>{index + 1}. {item.label}</option>)}
            </select>
          </label>
          <button type="button" disabled={safeFrameIndex === scenario.frames.length - 1} onClick={() => setFrameIndex((current) => Math.min(scenario.frames.length - 1, current + 1))} aria-label="下一个状态"><Icon.Chevron aria-hidden="true" /></button>
        </div>
        {lastIntent ? <p className="learning-run-lab-dock__intent" role="status">最近交互：{lastIntent}</p> : null}
      </aside>
    </div>
  );
}

export function dispatchLearningRunDemoIntent(
  intent: LearningRunUiIntentV1,
  state: {
    scenarioId: string;
    frameIndex: number;
    checkpointKind?: "partial" | "not_assessable" | "skipped_task" | null;
  },
): FrameLocation | null {
  if (intent.kind === "request_hint") return findFrame("card-text", "active-text-hint");
  if (intent.kind !== "finish_checkpoint") return null;
  if (state.checkpointKind === "not_assessable") return findFrame("result-semantics", "result-not_assessable");
  if (state.checkpointKind === "partial") return findFrame("result-semantics", "result-partial");
  if (state.checkpointKind === "skipped_task") return findFrame("result-semantics", "result-skipped");
  return findFrame("pause-recovery", "ended");
}

function intentLabel(intent: LearningRunUiIntentV1): string {
  switch (intent.kind) {
    case "submit_text": return "提交文字回答";
    case "submit_voice": return "提交确认后的逐字稿";
    case "submit_ordering": return "提交排序 Artifact";
    case "submit_repair": return "提交完整修复句";
    case "submit_choice_with_rationale": return "提交说法与理由";
    case "submit_scenario": return "提交场景应用判断";
    case "submit_relation": return "提交关系 Artifact";
    case "switch_variant": return `切换作答方式：${intent.alternativeId}`;
    case "request_hint": return "确认降级后查看一级提示";
    case "skip_task": return "跳过本题";
    case "declare_unable": return "声明暂时不会";
    case "leave_while_waiting": return "返回来源并等待结果";
    default: return intent.kind;
  }
}

function PrevIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>;
}
