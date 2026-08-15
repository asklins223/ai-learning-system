import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icons";
import type { PublicLearningCardPreviewV2 } from "@/features/card-generation-v2/contracts/ui-contracts";

interface PublicCardFrontProps {
  card: PublicLearningCardPreviewV2;
  interactionLabel: string;
  children: ReactNode;
}

export function PublicCardFront({ card, interactionLabel, children }: PublicCardFrontProps) {
  return (
    <section className="learning-card-v2__front" aria-labelledby="learning-card-v2-prompt">
      <div className="learning-card-v2__objective">
        <span><Icon.Target />学习目标</span>
        <strong>{card.objective.statement}</strong>
      </div>

      <div className="learning-card-v2__prompt-block">
        {card.front.context && <p className="learning-card-v2__context">{card.front.context}</p>}
        <div className="learning-card-v2__interaction-meta">
          <span data-kind={card.front.kind}>{interactionLabel}</span>
          {card.front.cue && <p className="learning-card-v2__cue">{card.front.cue}</p>}
        </div>
        <h2 id="learning-card-v2-prompt">{card.front.prompt}</h2>
      </div>

      {children}

      <details className="learning-card-v2__why">
        <summary>为什么值得学 <Icon.Chevron /></summary>
        <p>{card.objective.publicSummary}</p>
      </details>
    </section>
  );
}
