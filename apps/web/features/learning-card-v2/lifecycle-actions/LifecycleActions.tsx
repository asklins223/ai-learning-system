import { Icon } from "@/components/ui/icons";

export type LearningCardLifecycleActionV2 = "edit" | "archive" | "regenerate";

interface LifecycleActionsProps {
  capability: "preview" | "available";
  onAction?: (action: LearningCardLifecycleActionV2) => void;
}

const ACTIONS = [
  { action: "edit", label: "编辑", Icon: Icon.Edit },
  { action: "regenerate", label: "重新生成", Icon: Icon.Refresh },
  { action: "archive", label: "归档", Icon: Icon.Archive },
] as const;

export function LifecycleActions({ capability, onAction }: LifecycleActionsProps) {
  const enabled = capability === "available" && Boolean(onAction);

  return (
    <section className="learning-card-v2__lifecycle" aria-label="学习卡管理">
      <div>
        {ACTIONS.map(({ action, label, Icon: ActionIcon }) => (
          <button
            key={action}
            type="button"
            disabled={!enabled}
            title={enabled ? label : `${label}尚未接通生产 API`}
            onClick={() => onAction?.(action)}
          >
            <ActionIcon />{label}
          </button>
        ))}
      </div>
      {!enabled && <p><Icon.Lock />开发预览：编辑、重新生成和归档均未执行。</p>}
    </section>
  );
}
