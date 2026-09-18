import type { CardGenerationActiveSummaryV1 } from "@ailearn/shared/card-generation-desktop-contracts";
import { isCardGenerationReviewOpen } from "@ailearn/shared/card-generation-desktop-contracts";

export { isCardGenerationReviewOpen };

/**
 * Shared language for the Card Generation workbench (mockup pages 12 / 13) and
 * the note page's generation entry. Both pages describe the *same* server run,
 * so the status vocabulary lives here once — a label change lands on both.
 */

export const cardGenerationStatusLabels: Record<string, string> = {
  queued: "排队中",
  source_sealing: "正在封存来源",
  planning: "正在规划候选",
  authoring: "正在编写候选",
  checking: "正在做质量检查",
  review_ready: "等待审核",
  no_cards_recommended: "没有推荐候选",
  needs_attention: "需要处理",
  activating: "正在提交激活",
  activated: "已收到激活结果",
  closed_without_activation: "已结束，未激活",
  failed: "生成失败",
  cancelled: "已取消",
  stale: "来源已过期",
};

export function cardGenerationStatusLabel(status: string): string {
  return cardGenerationStatusLabels[status] ?? "服务端处理中";
}

/** The four press stages of mockup page 12 and the run statuses they cover. */
export function cardGenerationStage(status: string): number {
  if (status === "queued" || status === "source_sealing") return 0;
  if (status === "planning" || status === "authoring") return 1;
  if (status === "checking") return 2;
  return 3;
}

/** The board draws four press stages; the meter counts the same four. */
export const cardGenerationStageCount = 4;

/**
 * Whether "第 N / 4 步" says anything true. A stopped run keeps whatever stage
 * number its status maps to, and `needs_attention` maps to the review stage it
 * never reached — so the meter is only shown while the server is still working
 * or has actually delivered the deck to review.
 */
export function cardGenerationShowsProgress(status: string): boolean {
  return status === "review_ready" || isCardGenerationInFlight(status);
}

/** The manual-resync receipt: re-reading status must say what re-reading found. */
export function cardGenerationSyncReportText(status: string | null, changed: boolean): string {
  if (!status) return "这次同步没有读到服务端状态，页面仍是上一次的结果。";
  const label = cardGenerationStatusLabel(status);
  return changed
    ? `已同步 · 服务端把这次生成推进到「${label}」。`
    : `已同步 · 服务端仍是「${label}」，这一步还没有新的进展。`;
}

/**
 * A run that stopped without a recovery contract. The stage track cannot say
 * anything true about it — it does not record how far the run got — so the board
 * shows this instead of lighting up "等待审核" for work that already stopped.
 */
export function isCardGenerationStopped(status: string): boolean {
  return status === "cancelled";
}

/** Statuses where the server is still working — the chip spins, buttons wait. */
const inFlightStatuses = new Set([
  "queued",
  "source_sealing",
  "planning",
  "authoring",
  "checking",
  "activating",
]);

export function isCardGenerationInFlight(status: string): boolean {
  return inFlightStatuses.has(status);
}

const reviewStageStatuses = new Set([
  "review_ready",
  "no_cards_recommended",
  "needs_attention",
  "activating",
  "activated",
  "closed_without_activation",
]);

export function isCardGenerationReviewStage(status: string): boolean {
  return reviewStageStatuses.has(status);
}

export const cardGenerationRecoveryReasonLabels: Record<string, string> = {
  provider_unavailable: "生成服务暂时不可用",
  quality_gate_failed: "候选没有通过质量检查",
  source_outdated: "生成来源已经过期",
  run_failed: "这次生成任务已经失败",
  attention_required: "服务端需要进一步处理",
  unknown: "服务端暂时无法说明这次生成状态",
};

export function cardGenerationRecoveryReasonLabel(reasonCode: string): string {
  return cardGenerationRecoveryReasonLabels[reasonCode] ?? "服务端需要进一步处理";
}

/**
 * What the note page's one button says for a run of this note. The button no
 * longer starts a second run — an active run means the action is *going to*
 * the workbench, so the copy names the destination, never "生成学习卡".
 */
export function cardGenerationEntryLabel(status: string): string {
  if (status === "review_ready") return "审核学习卡";
  if (status === "needs_attention") return "处理生成任务";
  if (status === "activating") return "查看激活进度";
  return "查看生成进度";
}

/** A run the note page should surface as "this note's generation is live". */
export function isNoteGenerationLive(status: string): boolean {
  return [
    "queued",
    "source_sealing",
    "planning",
    "authoring",
    "checking",
    "review_ready",
    "needs_attention",
    "activating",
  ].includes(status);
}

export function isLiveGenerationForNote(
  generation: CardGenerationActiveSummaryV1 | null | undefined,
  noteId: string,
): generation is CardGenerationActiveSummaryV1 {
  return Boolean(generation && generation.noteId === noteId && isNoteGenerationLive(generation.status));
}
