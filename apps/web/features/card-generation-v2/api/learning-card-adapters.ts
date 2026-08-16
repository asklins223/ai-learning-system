/**
 * Card Generation V2 — Active Card / Reveal adapters (R7)。
 *
 * 把后端 `/v2/cards/:cardId` 与 reveal 的 public DTO 映射为
 * ActiveLearningCardV2 / LearningCardReveal 消费的 ui-contracts 形态。
 */

import type { PublicLearningCardV2, LearningCardRevealV2 } from "@ailearn/shared";
import type {
  LearningCardRevealContentV2,
  PublicLearningCardPreviewV2,
} from "../contracts/ui-contracts";

const LIFECYCLE_LABELS: Record<PublicLearningCardV2["lifecycle"], [string, string]> = {
  active: ["学习中", "这张卡在活跃学习队列中"],
  archived: ["已归档", "这张卡已退出学习队列，只保留历史记录"],
  superseded: ["已有新版", "学习目标已迁移到新版卡片"],
};

/** Backend front 没有 discriminated kind；默认按 recall 交互呈现正面。 */
function toFrontInteraction(card: PublicLearningCardV2): PublicLearningCardPreviewV2["front"] {
  return {
    kind: "recall",
    cue: card.front.cue,
    context: card.front.context,
    prompt: card.front.prompt,
    scratchpadPlaceholder: "写你的回忆…",
  };
}

/** 把后端 PublicLearningCardV2 映射为 ActiveLearningCardV2 的 preview。 */
export function toPublicLearningCardPreview(
  card: PublicLearningCardV2,
): PublicLearningCardPreviewV2 {
  const [lifecycleLabel, lifecycleDetail] =
    LIFECYCLE_LABELS[card.lifecycle] ?? LIFECYCLE_LABELS.active;
  const blocked = card.lifecycle !== "active";

  return {
    cardId: card.cardId,
    objectiveId: card.objectiveId,
    objective: {
      statement: "",
      publicSummary: card.publicSummary,
    },
    front: toFrontInteraction(card),
    lifecycle: {
      status: card.lifecycle,
      label: lifecycleLabel,
      detail: lifecycleDetail,
    },
    freshness: {
      status: "current",
      label: "内容是最新",
      detail: "正面与作答依据保持一致",
    },
    personalState: (() => {
      if (card.lifecycle !== "active") {
        return {
          status: "idle" as const,
          label: lifecycleLabel,
          detail: lifecycleDetail,
        };
      }
      const reviewAt = card.nextReviewAt ? new Date(card.nextReviewAt) : null;
      const hasValidReviewAt = Boolean(reviewAt && !Number.isNaN(reviewAt.getTime()));
      if (card.reviewStatus === "pending" && hasValidReviewAt) {
        const due = reviewAt!.getTime() <= Date.now();
        return due
          ? {
              status: "review_due" as const,
              label: "复习到期",
              detail: "复习时间已经到达，可以从回忆开始。",
            }
          : {
              status: "review_scheduled" as const,
              label: "已安排复习",
              detail: "已经安排下一次复习，仍可随时继续练习。",
            };
      }
      return {
        status: "initial_validation_ready" as const,
        label: "等待首次验证",
        detail: "尚未完成首次可信验证。",
      };
    })(),
    primaryAction: blocked
      ? { intent: "return", label: "返回学习卡库" }
      : { intent: "start", label: "开始学习" },
  };
}

/** 把后端 LearningCardRevealV2 映射为 LearningCardRevealContentV2。 */
export function toLearningCardRevealContent(
  reveal: LearningCardRevealV2,
): LearningCardRevealContentV2 {
  const answer =
    reveal.reveal.canonicalAnswer.kind === "text"
      ? reveal.reveal.canonicalAnswer.unit.text
      : reveal.reveal.canonicalAnswer.kind === "bullets"
        ? reveal.reveal.canonicalAnswer.items.map((i) => i.text).join("；")
        : reveal.reveal.canonicalAnswer.kind === "ordered_steps"
          ? reveal.reveal.canonicalAnswer.steps.map((s) => s.text).join("\n")
          : reveal.reveal.canonicalAnswer.kind === "mapping"
            ? reveal.reveal.canonicalAnswer.pairs.map((p) => `${p.left} → ${p.right}`).join("；")
            : reveal.reveal.canonicalAnswer.kind === "comparison"
              ? reveal.reveal.canonicalAnswer.rows.map((r) => `${r.dimension}: ${r.values.join(" / ")}`).join("\n")
              : reveal.reveal.canonicalAnswer.kind === "formula"
                ? reveal.reveal.canonicalAnswer.latex
                : reveal.reveal.canonicalAnswer.kind === "code"
                  ? reveal.reveal.canonicalAnswer.code
                  // 兜底：未知/缺失 kind 时不再把占位文本当答案展示（此前
                  // formula/code 会显示成字面"参考答案"）。
                  : JSON.stringify(reveal.reveal.canonicalAnswer) || "";

  return {
    exposureId: reveal.exposureId,
    exposedAt: reveal.exposedAt,
    exposurePolicyVersion: "learning-card-v2:1",
    canonicalAnswer: answer,
    explanation: reveal.reveal.explanation ?? "",
    misconception: reveal.reveal.misconception ?? "",
    evidence: reveal.evidencePreviews.map((e) => ({
      evidenceId: e.evidenceSnapshotId,
      sourceLabel: e.sourceLabel ?? "",
      preview: e.preview,
    })),
    practice: {
      label: "本次将作为练习",
      explanation: "你已查看答案，本次练习不会作为独立掌握证据。",
      primaryActionLabel: "开始练习",
    },
  };
}
