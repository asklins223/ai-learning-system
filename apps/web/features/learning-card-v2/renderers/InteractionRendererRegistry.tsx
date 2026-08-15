"use client";

import { useState, type ComponentType } from "react";
import { Icon } from "@/components/ui/icons";
import type {
  CardStrategyV2,
  PublicApplyInteractionV2,
  PublicBoundaryInteractionV2,
  PublicWhyInteractionV2,
  PublicClozeInteractionV2,
  PublicCompareInteractionV2,
  PublicLearningCardInteractionV2,
  PublicRecallInteractionV2,
  PublicSequenceInteractionV2,
} from "@/features/card-generation-v2/contracts/ui-contracts";

interface InteractionRendererProps {
  interaction: PublicLearningCardInteractionV2;
}

export const learningCardInteractionLabels: Record<CardStrategyV2, string> = {
  recall: "开放回忆",
  cloze: "语境填空",
  compare: "维度比较",
  sequence: "顺序重建",
  why: "因果搭链",
  boundary: "边界判断",
  application: "情境迁移",
};

function RecallInteraction({ interaction }: { interaction: PublicRecallInteractionV2 }) {
  const [draft, setDraft] = useState("");

  return (
    <div className="learning-card-interaction learning-card-interaction--recall">
      {interaction.reflectionPrompts && (
        <div className="learning-card-interaction__thinking-lens" aria-label="思考线索">
          {interaction.reflectionPrompts.map((prompt, index) => (
            <span key={prompt}><i>{index + 1}</i>{prompt}</span>
          ))}
        </div>
      )}
      <label className="learning-card-interaction__scratchpad">
        <span>我的重建</span>
        <textarea
          value={draft}
          rows={4}
          placeholder={interaction.scratchpadPlaceholder}
          onChange={(event) => setDraft(event.target.value)}
        />
        <small>{draft.trim() ? `已记录 ${draft.trim().length} 字，答案仍保持隐藏` : "先完整说一遍，再决定是否查看参考内容"}</small>
      </label>
    </div>
  );
}

function ClozeInteraction({ interaction }: { interaction: PublicClozeInteractionV2 }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const blankCount = interaction.passage.filter((part) => part.kind === "blank").length;
  const filledCount = Object.values(values).filter((value) => value.trim()).length;

  return (
    <div className="learning-card-interaction learning-card-interaction--cloze">
      <div className="learning-card-cloze__passage">
        {interaction.passage.map((part, index) => (
          part.kind === "text" ? (
            <span key={`text-${index}`}>{part.text}</span>
          ) : (
            <label className="learning-card-cloze__blank" data-width={part.width} key={part.blankId}>
              <span className="sr-only">{part.label}</span>
              <input
                value={values[part.blankId] ?? ""}
                aria-label={part.label}
                autoComplete="off"
                onChange={(event) => setValues((current) => ({
                  ...current,
                  [part.blankId]: event.target.value,
                }))}
              />
              <i aria-hidden="true" />
            </label>
          )
        ))}
      </div>
      <div className="learning-card-cloze__status">
        <span>{filledCount}/{blankCount} 个空位已填写</span>
        <div aria-hidden="true">{Array.from({ length: blankCount }, (_, index) => <i data-filled={index < filledCount} key={index} />)}</div>
      </div>
    </div>
  );
}

function CompareInteraction({ interaction }: { interaction: PublicCompareInteractionV2 }) {
  const [notes, setNotes] = useState<Record<string, string>>({});

  return (
    <div className="learning-card-interaction learning-card-interaction--compare">
      <div className="learning-card-compare__head" aria-hidden="true">
        <span>比较维度</span>
        {interaction.subjects.map((subject) => <strong key={subject.subjectId}>{subject.label}</strong>)}
      </div>
      <div className="learning-card-compare__body">
        {interaction.dimensions.map((dimension) => (
          <section key={dimension.dimensionId}>
            <div><strong>{dimension.label}</strong><small>{dimension.prompt}</small></div>
            {interaction.subjects.map((subject) => {
              const fieldId = `${dimension.dimensionId}-${subject.subjectId}`;
              return (
                <label key={fieldId}>
                  <span className="sr-only">{subject.label}：{dimension.label}</span>
                  <textarea
                    rows={2}
                    value={notes[fieldId] ?? ""}
                    placeholder={`写下 ${subject.label} 的取舍…`}
                    onChange={(event) => setNotes((current) => ({ ...current, [fieldId]: event.target.value }))}
                  />
                </label>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

function SequenceInteraction({ interaction }: { interaction: PublicSequenceInteractionV2 }) {
  const [steps, setSteps] = useState(interaction.steps);

  const move = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= steps.length) return;
    setSteps((current) => {
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
      return next;
    });
  };

  return (
    <div className="learning-card-interaction learning-card-interaction--sequence">
      <ol className="learning-card-sequence__track">
        {steps.map((step, index) => (
          <li key={step.stepId}>
            <span className="learning-card-sequence__index">{index + 1}</span>
            <Icon.GripVertical />
            <strong>{step.label}</strong>
            <div>
              <button type="button" disabled={index === 0} aria-label={`将${step.label}上移`} onClick={() => move(index, -1)}>↑</button>
              <button type="button" disabled={index === steps.length - 1} aria-label={`将${step.label}下移`} onClick={() => move(index, 1)}>↓</button>
            </div>
          </li>
        ))}
      </ol>
      <button type="button" className="learning-card-interaction__reset" onClick={() => setSteps(interaction.steps)}>
        <Icon.Refresh />恢复题目顺序
      </button>
    </div>
  );
}

function WhyInteraction({ interaction }: { interaction: PublicWhyInteractionV2 }) {
  const [chain, setChain] = useState<string[]>([]);
  const nodeById = new Map(interaction.nodes.map((node) => [node.nodeId, node]));
  const toggleNode = (nodeId: string) => {
    setChain((current) => {
      if (current.includes(nodeId)) return current.filter((id) => id !== nodeId);
      if (current.length >= interaction.chainSlotCount) return current;
      return [...current, nodeId];
    });
  };

  return (
    <div className="learning-card-interaction learning-card-interaction--why">
      <div className="learning-card-why__pool" aria-label="可用因果节点">
        {interaction.nodes.map((node) => (
          <button
            type="button"
            key={node.nodeId}
            data-selected={chain.includes(node.nodeId)}
            aria-pressed={chain.includes(node.nodeId)}
            onClick={() => toggleNode(node.nodeId)}
          >
            <span>{chain.indexOf(node.nodeId) + 1 || "+"}</span>{node.label}
          </button>
        ))}
      </div>
      <div className="learning-card-why__chain" aria-label="你的因果链">
        {Array.from({ length: interaction.chainSlotCount }, (_, index) => {
          const node = chain[index] ? nodeById.get(chain[index]!) : null;
          return (
            <div key={index}>
              <span data-empty={!node}>{node?.label ?? `第 ${index + 1} 环`}</span>
              {index < interaction.chainSlotCount - 1 && <Icon.Arrow />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BoundaryInteraction({ interaction }: { interaction: PublicBoundaryInteractionV2 }) {
  const [decisions, setDecisions] = useState<Record<string, "within" | "outside">>({});

  return (
    <div className="learning-card-interaction learning-card-interaction--boundary">
      {interaction.cases.map((item, index) => (
        <section key={item.caseId}>
          <span>{String(index + 1).padStart(2, "0")}</span>
          <p>{item.statement}</p>
          <div role="group" aria-label={`判断：${item.statement}`}>
            {(["within", "outside"] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={decisions[item.caseId] === value}
                data-selected={decisions[item.caseId] === value}
                onClick={() => setDecisions((current) => ({ ...current, [item.caseId]: value }))}
              >
                {decisions[item.caseId] === value && <Icon.Check />}{interaction.labels[value]}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ApplyInteraction({ interaction }: { interaction: PublicApplyInteractionV2 }) {
  const [selection, setSelection] = useState<string | null>(null);

  return (
    <div className="learning-card-interaction learning-card-interaction--apply">
      <blockquote><span>情境</span><p>{interaction.scenario}</p></blockquote>
      <div className="learning-card-apply__options" role="radiogroup" aria-label="选择你的策略">
        {interaction.options.map((option, index) => (
          <button
            type="button"
            role="radio"
            aria-checked={selection === option.optionId}
            data-selected={selection === option.optionId}
            key={option.optionId}
            onClick={() => setSelection(option.optionId)}
          >
            <span>{String.fromCharCode(65 + index)}</span>
            <div><strong>{option.label}</strong><small>{option.description}</small></div>
            <i aria-hidden="true">{selection === option.optionId && <Icon.Check />}</i>
          </button>
        ))}
      </div>
      {selection && <p className="learning-card-apply__commitment">已记录你的初始判断；查看参考内容前，先说出取舍理由。</p>}
    </div>
  );
}

const recallRenderer: ComponentType<InteractionRendererProps> = ({ interaction }) =>
  interaction.kind === "recall" ? <RecallInteraction interaction={interaction} /> : null;
const clozeRenderer: ComponentType<InteractionRendererProps> = ({ interaction }) =>
  interaction.kind === "cloze" ? <ClozeInteraction interaction={interaction} /> : null;
const compareRenderer: ComponentType<InteractionRendererProps> = ({ interaction }) =>
  interaction.kind === "compare" ? <CompareInteraction interaction={interaction} /> : null;
const sequenceRenderer: ComponentType<InteractionRendererProps> = ({ interaction }) =>
  interaction.kind === "sequence" ? <SequenceInteraction interaction={interaction} /> : null;
const whyRenderer: ComponentType<InteractionRendererProps> = ({ interaction }) =>
  interaction.kind === "why" ? <WhyInteraction interaction={interaction} /> : null;
const boundaryRenderer: ComponentType<InteractionRendererProps> = ({ interaction }) =>
  interaction.kind === "boundary" ? <BoundaryInteraction interaction={interaction} /> : null;
const applicationRenderer: ComponentType<InteractionRendererProps> = ({ interaction }) =>
  interaction.kind === "application" ? <ApplyInteraction interaction={interaction} /> : null;

export const learningCardInteractionRendererRegistry: Record<
  CardStrategyV2,
  ComponentType<InteractionRendererProps>
> = {
  recall: recallRenderer,
  cloze: clozeRenderer,
  compare: compareRenderer,
  sequence: sequenceRenderer,
  why: whyRenderer,
  boundary: boundaryRenderer,
  application: applicationRenderer,
};
