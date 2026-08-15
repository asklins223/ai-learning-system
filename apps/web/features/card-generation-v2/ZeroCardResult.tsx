import Link from "next/link";
import { Icon } from "@/components/ui/icons";
import type { ZeroCardResultV2 } from "./contracts/ui-contracts";

export interface ZeroCardResultProps {
  result: ZeroCardResultV2;
  onRetry?: () => void;
}

export function ZeroCardResult({ result, onRetry }: ZeroCardResultProps) {
  return (
    <section className="zero-card-result" aria-labelledby="zero-card-result-title">
      <div className="zero-card-result__glyph" aria-hidden="true">
        <Icon.Check />
      </div>
      <p className="zero-card-result__eyebrow">分析已完成 · 0 张学习卡</p>
      <h2 id="zero-card-result-title">{result.title}</h2>
      <p className="zero-card-result__copy">{result.explanation}</p>
      <span className="zero-card-result__reason">{result.reasonLabel}</span>

      <dl className="zero-card-result__decisions">
        {result.decisions.map((decision) => (
          <div key={decision.label}>
            <dt>{decision.label}</dt>
            <dd>{decision.value}</dd>
          </div>
        ))}
      </dl>

      {result.coveredCard && (
        <Link className="zero-card-result__covered" href={`/cards/${result.coveredCard.cardId}`}>
          <Icon.Card />
          <span><small>已被现有学习目标覆盖</small><strong>{result.coveredCard.title}</strong></span>
          <Icon.Arrow />
        </Link>
      )}

      <footer className="zero-card-result__actions">
        <Link href="/notes" className="card-v2-button card-v2-button--quiet">返回笔记</Link>
        {onRetry && (
          <button type="button" className="card-v2-button card-v2-button--secondary" onClick={onRetry}>
            <Icon.Refresh />换个学习目标再分析
          </button>
        )}
      </footer>
      <p className="zero-card-result__footnote">没有生成卡不是失败：系统避免为不值得反复练习的内容增加负担。</p>
    </section>
  );
}

