import { Icon } from "@/components/ui/icons";
import type { LearningCardRevealContentV2 } from "@/features/card-generation-v2/contracts/ui-contracts";
import { SourceEvidence } from "../source-evidence/SourceEvidence";

interface LearningCardRevealProps {
  content: LearningCardRevealContentV2;
  capability: "preview" | "available";
}

export function LearningCardReveal({ content, capability }: LearningCardRevealProps) {
  return (
    <section className="learning-card-v2__reveal" aria-labelledby="learning-card-v2-answer">
      <div className="learning-card-v2__exposure-status">
        <Icon.Eye />
        <div>
          <strong>
            {capability === "available" ? "Exposure 已记录 · 本次进入练习语义" : "Exposure-first 交互预览"}
          </strong>
          <span>
            {capability === "available"
              ? `${content.practice.label} · ${content.exposurePolicyVersion}`
              : "生产接口未接通；当前没有写入真实 Exposure Ledger。"}
          </span>
        </div>
      </div>

      {/* §17.3/§20: Trust 降级提示——已 reveal 的卡片进入练习时 Trust Class 降级 */}
      {capability === "available" && (
        <div className="learning-card-v2__trust-degradation" role="status">
          <Icon.AlertCircle />
          <div>
            <strong>Trust 降级提示</strong>
            <span>
              你已查看过答案，本次练习将标记为「辅助后练习」，不作为独立掌握的证据。
              24 小时后可恢复独立评估资格。
            </span>
          </div>
        </div>
      )}

      <div className="learning-card-v2__answer">
        <p>参考答案</p>
        <h3 id="learning-card-v2-answer">{content.canonicalAnswer}</h3>
      </div>

      <div className="learning-card-v2__support-grid">
        <article>
          <span>理解线索</span>
          <p>{content.explanation}</p>
        </article>
        <article>
          <span>常见误区</span>
          <p>{content.misconception}</p>
        </article>
      </div>

      <SourceEvidence evidence={content.evidence} />
    </section>
  );
}
