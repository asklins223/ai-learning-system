"use client";

import { useEffect, useRef, useState } from "react";
import {
  EvidenceAlignment,
  EvidenceOverride,
  EvidenceRow,
} from "@/lib/api";
import { StatusChip } from "@/components/ui/StatusChip";
import type { StatusTone } from "@/lib/status-map";
import { Icon } from "@/components/ui/icons";
import { useBodyScrollLock } from "@/lib/use-body-scroll-lock";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { useModalIsolation } from "@/lib/use-modal-isolation";

export function EvidenceDrawer({
  open,
  onClose,
  claim,
  chips,
  onOverride,
  error = null,
}: {
  open: boolean;
  onClose: () => void;
  claim: string;
  chips: EvidenceRow[];
  onOverride?: (
    evidenceId: string,
    override: EvidenceOverride,
  ) => Promise<void> | void;
  error?: string | null;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalIsolation(dialogRef, open);
  useFocusTrap(dialogRef, open);
  useBodyScrollLock(open);

  useEffect(() => {
    if (!open) return;
    setActiveId((current) =>
      chips.some((item) => item.id === current)
        ? current
        : chips[0]?.id ?? null,
    );
  }, [chips, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const active = chips.find((item) => item.id === activeId) ?? chips[0];

  async function handleOverride(override: EvidenceOverride) {
    if (!active || !onOverride || busy) return;
    setBusy(true);
    try {
      await onOverride(active.id, override);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="evidence-detail-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="evidence-detail-title"
        onClick={(event) => event.stopPropagation()}
        className="evidence-detail-drawer"
      >
        <header className="evidence-detail-header">
          <div>
            <p>证据回溯</p>
            <h2 id="evidence-detail-title">这条理解由什么支持？</h2>
            <span>核对原文，并决定这条引用是否足够可信。</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭证据详情"
          >
            <Icon.Close aria-hidden="true" />
          </button>
        </header>

        <section className="evidence-detail-claim">
          <span>当前结论</span>
          <p>{claim}</p>
        </section>

        {error && (
          <div className="evidence-detail-error" role="alert">
            <Icon.Warn aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        {chips.length === 0 ? (
          <div className="evidence-detail-empty">
            <Icon.Quote aria-hidden="true" />
            <strong>暂无可核对的证据</strong>
            <p>等待证据对齐完成后再回来查看。</p>
          </div>
        ) : (
          <div className="evidence-detail-workspace">
            <nav className="evidence-detail-list" aria-label="候选证据">
              {chips.map((item, index) => {
                const override =
                  item.effectiveOverride ?? item.userOverride ?? null;
                const isActive = item.id === active?.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveId(item.id)}
                    className={isActive ? "is-active" : undefined}
                    aria-pressed={isActive}
                  >
                    <span className="evidence-detail-list-index">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="evidence-detail-list-copy">
                      <strong>{alignmentLabel(item.alignment, override)}</strong>
                      <small>
                        {item.blockOrdinal !== null
                          ? `原文第 ${item.blockOrdinal + 1} 段`
                          : "原文片段"}
                      </small>
                    </span>
                    <Icon.Chevron aria-hidden="true" />
                  </button>
                );
              })}
            </nav>

            <section className="evidence-detail-content">
              {active && (
                <>
                  <div className="evidence-detail-content-heading">
                    <div>
                      <span>原文证据</span>
                      <h3>
                        {alignmentLabel(
                          active.alignment,
                          active.effectiveOverride ??
                            active.userOverride ??
                            null,
                        )}
                      </h3>
                    </div>
                    {active.effectiveOverride || active.userOverride ? (
                      <StatusChip
                        tone={overrideTone(
                          (active.effectiveOverride ??
                            active.userOverride)!,
                        )}
                        size="sm"
                      >
                        {overrideLabel(
                          (active.effectiveOverride ??
                            active.userOverride)!,
                        )}
                      </StatusChip>
                    ) : null}
                  </div>

                  <blockquote>
                    {active.blockContent ??
                      active.quoteText ??
                      "未在原文中找到对应片段。"}
                  </blockquote>

                  <dl className="evidence-detail-meta">
                    <div>
                      <dt>对齐方法</dt>
                      <dd>{active.alignmentMethod}</dd>
                    </div>
                    <div>
                      <dt>对齐分数</dt>
                      <dd>{formatScore(active.alignmentScore)}</dd>
                    </div>
                    <div>
                      <dt>内容位置</dt>
                      <dd>
                        {active.blockOrdinal !== null
                          ? `第 ${active.blockOrdinal + 1} 段`
                          : "未定位"}
                      </dd>
                    </div>
                  </dl>

                  {active.quoteText &&
                    active.quoteText !== active.blockContent && (
                      <div className="evidence-detail-model-quote">
                        <span>模型引用文本</span>
                        <p>{active.quoteText}</p>
                      </div>
                    )}
                </>
              )}
            </section>
          </div>
        )}

        {active && onOverride && (
          <footer className="evidence-detail-footer">
            <p>你的判断会写入证据历史，并影响后续验证资格。</p>
            <div>
              <button
                type="button"
                onClick={() => void handleOverride("downgraded")}
                disabled={busy}
              >
                降级为软引用
              </button>
              <button
                type="button"
                className="is-danger"
                onClick={() => void handleOverride("rejected")}
                disabled={busy}
              >
                标记错误
              </button>
              <button
                type="button"
                className="is-primary"
                onClick={() => void handleOverride("confirmed")}
                disabled={busy}
              >
                <Icon.Check aria-hidden="true" />
                {busy ? "处理中…" : "确认引用"}
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}

function alignmentLabel(
  alignment: EvidenceAlignment,
  override: EvidenceOverride | null,
): string {
  if (override === "confirmed") return "硬证据";
  if (override === "downgraded") return "软引用";
  if (override === "rejected") return "已排除";
  switch (alignment) {
    case "aligned":
      return "硬证据";
    case "soft":
      return "软引用";
    case "stale_alignment":
      return "需要复核";
    default:
      return "未对齐";
  }
}

function overrideTone(override: EvidenceOverride): StatusTone {
  switch (override) {
    case "confirmed":
      return "success";
    case "downgraded":
      return "warning";
    case "rejected":
      return "danger";
  }
}

function overrideLabel(override: EvidenceOverride): string {
  switch (override) {
    case "confirmed":
      return "已确认";
    case "downgraded":
      return "已降级";
    case "rejected":
      return "已排除";
  }
}

function formatScore(score: number): string {
  if (!Number.isFinite(score)) return "—";
  return score <= 1 ? `${Math.round(score * 100)}%` : String(score);
}
