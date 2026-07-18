"use client";

import {
  CardDetailResponse,
  CardEvidenceGroup,
  ValidationFeedback,
  effectiveAlignment,
  isHardEvidence,
} from "@/lib/api";
import { Icon } from "@/components/ui/icons";
import { normalizeKeyPointClaim } from "@/lib/card-display";

export function StudyPaper({
  data,
  groups,
  latestFeedback,
  onOpenEvidence,
}: {
  data: CardDetailResponse;
  groups: CardEvidenceGroup[];
  latestFeedback: ValidationFeedback | null;
  onOpenEvidence?: (keyPointId: string) => void;
}) {
  const { card, keyPoints } = data;
  const title = card.schemaJson.title?.trim() || "未命名学习卡";
  const summary =
    card.schemaJson.summary?.trim() || "这张学习卡还没有核心理解摘要。";
  const misunderstandings = latestFeedback?.misunderstandings ?? [];
  const missingPoints = latestFeedback?.missingPoints ?? [];
  const createdAt = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(card.createdAt));
  const statusLabel =
    card.status === "active"
      ? "使用中"
      : card.status === "superseded"
        ? "已被新版本替代"
        : "已归档";

  return (
    <div className="study-card-stack" data-ui="study-paper">
      <div className="study-card-tab" aria-hidden="true">
        <span>学习卡</span>
        <span className="study-card-tab-mark">✦</span>
      </div>

      <article className="study-card-page">
        <span className="binder-ring" aria-hidden="true">
          <i />
          <i />
        </span>

        <header className="study-card-paper-header">
          <div className="study-card-meta">
            <span className={`study-card-status study-card-status--${card.status}`}>
              {statusLabel}
            </span>
            <span aria-hidden="true">·</span>
            <time dateTime={card.createdAt}>{createdAt}</time>
          </div>
          <h1 className="study-card-paper-title">{title}</h1>
        </header>

        <section className="paper-section paper-core-section">
          <div className="paper-section-heading">
            <span className="paper-star" aria-hidden="true">
              ★
            </span>
            <h2>核心理解</h2>
          </div>
          <p className="paper-core-copy">{summary}</p>
        </section>

        <section className="paper-key-points" aria-labelledby="paper-key-points-title">
          <div className="paper-key-points-heading">
            <div>
              <span className="paper-section-kicker">UNDERSTANDING NOTES</span>
              <h2 id="paper-key-points-title">理解要点</h2>
            </div>
            <span>{keyPoints.length} 个要点</span>
          </div>

          {keyPoints.length === 0 ? (
            <div className="paper-key-point-empty">
              暂无关键要点，重新生成学习卡后再查看。
            </div>
          ) : (
            <ol className="paper-key-point-list">
              {keyPoints.map((keyPoint, index) => {
                const group = groups.find(
                  (item) => item.keyPoint.id === keyPoint.id,
                );
                const rawEvidenceCount = group?.evidences.length ?? 0;
                const availableEvidence =
                  group?.evidences.filter(
                    (item) =>
                      effectiveAlignment(
                        item.alignment,
                        item.effectiveOverride ?? item.userOverride,
                      ) !== null,
                  ) ?? [];
                const evidenceCount = availableEvidence.length;
                const rejectedCount = rawEvidenceCount - evidenceCount;
                const hardCount =
                  availableEvidence.filter((item) =>
                    isHardEvidence(
                      item.alignment,
                      item.effectiveOverride ?? item.userOverride,
                    ),
                  ).length ?? 0;
                const sourceCopy = keyPoint.quoteText?.trim();
                const displayClaim = normalizeKeyPointClaim(keyPoint.claim);

                return (
                  <li key={keyPoint.id} className="paper-key-point">
                    <div className="paper-key-point-index" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </div>
                    <div className="paper-key-point-content">
                      <h3>关键要点 {index + 1}</h3>
                      <p>{displayClaim}</p>
                      {sourceCopy && (
                        <blockquote>
                          {compactText(sourceCopy, 100)}
                        </blockquote>
                      )}
                    </div>
                    <button
                      type="button"
                      className="paper-evidence-link"
                      disabled={!group || rawEvidenceCount === 0}
                      onClick={() => onOpenEvidence?.(keyPoint.id)}
                      aria-label={
                        rawEvidenceCount > 0
                          ? `查看关键要点 ${index + 1} 的 ${rawEvidenceCount} 条证据记录`
                          : `关键要点 ${index + 1} 暂无证据`
                      }
                    >
                      <Icon.Link aria-hidden="true" />
                      <span>
                        {hardCount > 0
                          ? `${hardCount} 条硬证据`
                          : evidenceCount > 0
                            ? `${evidenceCount} 条候选证据`
                            : rejectedCount > 0
                              ? `${rejectedCount} 条已排除`
                              : "等待证据"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {(misunderstandings.length > 0 || missingPoints.length > 0) && (
          <section className="paper-notes-grid" aria-label="验证反馈摘要">
            {misunderstandings.length > 0 && (
              <InsightNote
                tone="rose"
                title="需要纠正"
                items={misunderstandings}
              />
            )}
            {missingPoints.length > 0 && (
              <InsightNote
                tone="amber"
                title="待补充"
                items={missingPoints}
              />
            )}
          </section>
        )}
      </article>
    </div>
  );
}

function InsightNote({
  tone,
  title,
  items,
}: {
  tone: "rose" | "amber";
  title: string;
  items: string[];
}) {
  return (
    <div className={`insight-note ${tone}`}>
      {tone === "amber" && <span className="note-pin" aria-hidden="true" />}
      <h3>{title}</h3>
      <ul>
        {items.slice(0, 4).map((item, index) => (
          <li key={`${tone}-${index}`}>
            <span aria-hidden="true">{tone === "rose" ? "×" : "!"}</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function compactText(text: string | null | undefined, limit: number): string {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3).trim()}...`;
}
