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
  const { keyPoints } = data;
  const misunderstandings = latestFeedback?.misunderstandings ?? [];
  const missingPoints = latestFeedback?.missingPoints ?? [];

  return (
    <div className="study-card-stack" data-ui="study-paper">
      <div className="study-card-tab" aria-hidden="true">
        <span>学习卡</span>
        <span className="study-card-tab-mark">✦</span>
      </div>

      <article className="study-card-page" aria-labelledby="study-paper-title">
        <span className="binder-ring" aria-hidden="true">
          <i />
          <i />
        </span>
        <header className="study-card-paper-header">
          <div>
            <span className="paper-section-kicker">UNDERSTANDING NOTES</span>
            <h2 id="study-paper-title">理解要点</h2>
            <p>把核心理解拆成可以回看、核对和验证的小单元。</p>
          </div>
          <span className="study-card-paper-count">
            <strong>{String(keyPoints.length).padStart(2, "0")}</strong>
            个要点
          </span>
        </header>

        <section className="paper-key-points" aria-labelledby="study-paper-title">
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
                      <h3>{displayClaim}</h3>
                      {sourceCopy && (
                        <div className="paper-key-point-source">
                          <span>
                            <Icon.Quote aria-hidden="true" />
                            原文依据
                          </span>
                          <blockquote>
                            {compactText(sourceCopy, 140)}
                          </blockquote>
                        </div>
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
