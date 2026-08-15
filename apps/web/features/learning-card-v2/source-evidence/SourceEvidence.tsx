import { Icon } from "@/components/ui/icons";
import type { LearningCardRevealContentV2 } from "@/features/card-generation-v2/contracts/ui-contracts";

interface SourceEvidenceProps {
  evidence: LearningCardRevealContentV2["evidence"];
}

export function SourceEvidence({ evidence }: SourceEvidenceProps) {
  return (
    <details className="learning-card-v2__evidence">
      <summary><Icon.Quote />来源与依据 <span>{evidence.length} 处</span><Icon.Chevron /></summary>
      <div>
        {evidence.map((item) => (
          <blockquote key={item.evidenceId}>
            <p>{item.preview}</p>
            <cite>{item.sourceLabel}</cite>
          </blockquote>
        ))}
      </div>
    </details>
  );
}
