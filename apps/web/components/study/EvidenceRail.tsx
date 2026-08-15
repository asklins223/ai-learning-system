"use client";

import { useMemo } from "react";
import {
  CardEvidenceGroup,
  effectiveAlignment,
  isHardEvidence,
} from "@/lib/api";
import { Icon } from "@/components/ui/icons";
import { normalizeKeyPointClaim } from "@/lib/card-display";

export function EvidenceRail({
  groups,
  selectedKeyPointId,
  loading,
  error,
  onSelect,
  onRetry,
}: {
  groups: CardEvidenceGroup[];
  selectedKeyPointId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (keyPointId: string) => void;
  onRetry?: () => void;
}) {
  // F19（round4）：三段 reduce（raw/total/hard）此前各自遍历全部 evidences，
  // 每渲重算；改为单趟 useMemo，groups 不变时复用，且一次遍历同时累计三类计数。
  const { rawEvidenceCount, totalEvidence, hardEvidence } = useMemo(() => {
    let raw = 0;
    let total = 0;
    let hard = 0;
    for (const group of groups) {
      for (const item of group.evidences) {
        raw += 1;
        if (
          effectiveAlignment(
            item.alignment,
            item.effectiveOverride ?? item.userOverride,
          ) !== null
        ) {
          total += 1;
        }
        if (
          isHardEvidence(
            item.alignment,
            item.effectiveOverride ?? item.userOverride,
          )
        ) {
          hard += 1;
        }
      }
    }
    return { rawEvidenceCount: raw, totalEvidence: total, hardEvidence: hard };
  }, [groups]);
  const rejectedEvidence = rawEvidenceCount - totalEvidence;

  return (
    <section
      className="evidence-rail evidence-thread"
      data-ui="evidence-rail"
      aria-labelledby="evidence-rail-title"
    >
      <header className="evidence-rail-header">
        <div className="evidence-rail-title">
          <span className="evidence-header-icon" aria-hidden="true">
            <Icon.Link />
          </span>
          <div>
            <h2 id="evidence-rail-title">证据线索</h2>
            <p>
              {loading
                ? "正在读取…"
                : `${hardEvidence} 条硬证据 · ${totalEvidence} 条证据记录${
                    rejectedEvidence > 0
                      ? ` · ${rejectedEvidence} 条已排除`
                      : ""
                  }`}
            </p>
          </div>
        </div>
      </header>

      {loading ? (
        <div className="evidence-rail-loading" role="status" aria-live="polite">
          <span className="evidence-loading-label">正在加载证据线索…</span>
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="evidence-loading-card" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="evidence-rail-state is-error" role="alert">
          <Icon.Warn aria-hidden="true" />
          <div>
            <strong>证据暂时无法读取</strong>
            <p>{error}</p>
            {onRetry && (
              <button type="button" onClick={onRetry}>
                重新加载证据
              </button>
            )}
          </div>
        </div>
      ) : groups.length === 0 ? (
        <div className="evidence-rail-state">
          <Icon.Quote aria-hidden="true" />
          <div>
            <strong>还没有证据</strong>
            <p>核心内容可以阅读，但暂时不能进行理解验证。</p>
          </div>
        </div>
      ) : (
        <ol className="evidence-thread-list">
          {groups.map((group, groupIndex) => {
            const availableEvidence = group.evidences.filter(
              (item) =>
                effectiveAlignment(
                  item.alignment,
                  item.effectiveOverride ?? item.userOverride,
                ) !== null,
            );
            const firstEvidence = availableEvidence[0];
            const hardCount = availableEvidence.filter((item) =>
              isHardEvidence(
                item.alignment,
                item.effectiveOverride ?? item.userOverride,
              ),
            ).length;
            const evidenceCount = availableEvidence.length;
            const rejectedCount =
              group.evidences.length - availableEvidence.length;
            const hasEvidenceRecords = group.evidences.length > 0;
            const sourceOrdinal = group.keyPoint.segmentRef?.blockOrdinal;
            const displayClaim = normalizeKeyPointClaim(
              group.keyPoint.claim,
            );
            const description =
              firstEvidence?.blockContent ||
              firstEvidence?.quoteText ||
              (firstEvidence
                ? displayClaim
                : rejectedCount > 0
                  ? "相关证据已被排除，可打开记录重新判断。"
                  : "这个要点暂时还没有可用证据。");
            const isSelected = selectedKeyPointId === group.keyPoint.id;

            return (
              <li
                key={group.keyPoint.id}
                className={`evidence-thread-card ${isSelected ? "is-selected" : ""}`}
              >
                <button
                  onClick={() => onSelect(group.keyPoint.id)}
                  className="evidence-card-button"
                  type="button"
                  disabled={!hasEvidenceRecords}
                  aria-pressed={isSelected}
                >
                  <div className="evidence-card-heading">
                    <span className="evidence-card-index">
                      {String(groupIndex + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <span>关键点 {groupIndex + 1}</span>
                      <h3>{compactText(displayClaim, 34)}</h3>
                    </div>
                    <Icon.Chevron className="evidence-card-more" aria-hidden="true" />
                  </div>

                  <p className="evidence-card-copy">
                    {compactText(description, 82)}
                  </p>

                  <div className="evidence-card-meta">
                    <span className="evidence-source-ref">
                      {!hasEvidenceRecords
                        ? "暂无原文引用"
                        : sourceOrdinal !== undefined
                        ? `原文第 ${sourceOrdinal + 1} 段`
                        : "原文片段"}
                    </span>
                    <span
                      className={`evidence-alignment ${
                        hardCount > 0
                          ? "is-aligned"
                          : evidenceCount > 0
                            ? "is-soft"
                            : "is-empty"
                      }`}
                    >
                      {hardCount > 0
                        ? `${hardCount} 条硬证据`
                        : evidenceCount > 0
                          ? `${evidenceCount} 条待确认`
                          : rejectedCount > 0
                            ? `${rejectedCount} 条已排除`
                            : "待补充"}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function compactText(text: string | null | undefined, limit: number): string {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3).trim()}...`;
}
