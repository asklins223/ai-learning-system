import type { LearningTaskDraftV1, LearningTaskPublicV1, LearningRunUiIntentV1 } from "../contracts";
import { ChoiceWithRationaleTask } from "./ChoiceWithRationaleTask";
import { StructuredBundleTask } from "./StructuredBundleTask";
import { OrderingTask } from "./OrderingTask";
import { RelationTask } from "./RelationTask";
import { RepairTask } from "./RepairTask";
import { ScenarioTask } from "./ScenarioTask";
import { TextResponseTask } from "./TextResponseTask";
import { VoiceTeachbackTask } from "./VoiceTeachbackTask";

type TaskRendererProps = {
  task: LearningTaskPublicV1;
  onIntent: (intent: LearningRunUiIntentV1) => void;
  draft?: LearningTaskDraftV1;
  onDraftChange?: (draft: LearningTaskDraftV1) => void;
};

export function TaskRenderer({ task, onIntent, draft, onDraftChange }: TaskRendererProps) {
  const sharedProps = { onIntent, draft, onDraftChange };
  switch (task.interaction.kind) {
    case "text_response":
      return <TextResponseTask task={task as LearningTaskPublicV1 & { interaction: Extract<LearningTaskPublicV1["interaction"], { kind: "text_response" }> }} {...sharedProps} />;
    case "voice_teachback":
      return <VoiceTeachbackTask task={task as LearningTaskPublicV1 & { interaction: Extract<LearningTaskPublicV1["interaction"], { kind: "voice_teachback" }> }} {...sharedProps} />;
    case "ordering":
      return <OrderingTask task={task as LearningTaskPublicV1 & { interaction: Extract<LearningTaskPublicV1["interaction"], { kind: "ordering" }> }} {...sharedProps} />;
    case "repair":
      return <RepairTask task={task as LearningTaskPublicV1 & { interaction: Extract<LearningTaskPublicV1["interaction"], { kind: "repair" }> }} {...sharedProps} />;
    case "choice_with_rationale":
      return <ChoiceWithRationaleTask task={task as LearningTaskPublicV1 & { interaction: Extract<LearningTaskPublicV1["interaction"], { kind: "choice_with_rationale" }> }} {...sharedProps} />;
    case "scenario":
      return <ScenarioTask task={task as LearningTaskPublicV1 & { interaction: Extract<LearningTaskPublicV1["interaction"], { kind: "scenario" }> }} {...sharedProps} />;
    case "relation":
      return <RelationTask task={task as LearningTaskPublicV1 & { interaction: Extract<LearningTaskPublicV1["interaction"], { kind: "relation" }> }} {...sharedProps} />;
    case "structured_bundle":
      return <StructuredBundleTask task={task as LearningTaskPublicV1 & { interaction: Extract<LearningTaskPublicV1["interaction"], { kind: "structured_bundle" }> }} {...sharedProps} />;
  }
}
