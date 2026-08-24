import {
  actionCapabilityValues,
  capabilityProjectionSchema,
  featureNameValues,
  type CapabilityProjectionV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import { isCardGenerationV2Enabled, isLearningRunV1Enabled } from "../../config/learning-companion-flags.ts";

type CapabilityRole = "owner" | "member";

const unavailableFeature = { state: "disabled" as const, reason: "error.feature_disabled" as const };

export function buildDesktopCapabilityProjection(role: CapabilityRole): CapabilityProjectionV1 {
  const learningRunEnabled = isLearningRunV1Enabled();
  const cardGenerationEnabled = isCardGenerationV2Enabled();
  const actionCapabilities = Object.fromEntries(
    actionCapabilityValues.map((capability) => [capability, "denied" as const]),
  ) as Record<(typeof actionCapabilityValues)[number], "allowed" | "denied" | "conditional">;

  for (const capability of ["note.read", "objective.read"] as const) actionCapabilities[capability] = "allowed";
  actionCapabilities["review.read"] = learningRunEnabled ? "allowed" : "denied";
  actionCapabilities["learning_run.read"] = learningRunEnabled ? "allowed" : "denied";
  if (learningRunEnabled) {
    actionCapabilities["learning_run.start"] = "allowed";
    actionCapabilities["learning_run.saveDraft"] = "allowed";
    actionCapabilities["learning_run.submit"] = "allowed";
    actionCapabilities["learning_run.action"] = "allowed";
  }

  if (role === "owner") {
    for (const capability of ["source.create", "source.update", "source.archive", "source.createNote", "note.create", "note.save", "note.delete", "note.restore", "note.permanentDelete"] as const) {
      actionCapabilities[capability] = "allowed";
    }
    if (cardGenerationEnabled) {
      for (const capability of ["card_generation.start", "card_generation.review", "card_generation.reveal", "card_generation.activate", "card_generation.cancel", "card_generation.close"] as const) {
        actionCapabilities[capability] = "allowed";
      }
    }
  }

  const featureAvailability = Object.fromEntries(
    featureNameValues.map((feature) => [feature, unavailableFeature]),
  ) as Record<(typeof featureNameValues)[number], { state: "enabled" | "disabled" | "conditional" | "unavailable"; reason?: "error.feature_disabled" }>;
  featureAvailability.learning_objective_system_v3 = { state: "enabled" };
  featureAvailability.learning_run_v1 = learningRunEnabled ? { state: "enabled" } : unavailableFeature;
  featureAvailability.learning_run_v2 = learningRunEnabled ? { state: "enabled" } : unavailableFeature;
  featureAvailability.card_generation_v2 = cardGenerationEnabled && role === "owner"
    ? { state: "enabled" }
    : unavailableFeature;

  return capabilityProjectionSchema.parse({
    version: 1,
    revision: `desktop-capability-v1:${role}:run-${learningRunEnabled ? "on" : "off"}:card-${cardGenerationEnabled ? "on" : "off"}`,
    // The desktop main process owns the workspace epoch. The server value is
    // a positive placeholder and is replaced after the trusted response is
    // received at the desktop boundary.
    workspaceEpoch: 1,
    actionCapabilities,
    featureAvailability,
    nativeCapabilities: {
      filePicker: "unavailable",
      clipboard: "unavailable",
      notifications: "unavailable",
      asr: "unavailable",
      updates: "unavailable",
      live2d: "unavailable",
    },
  });
}
