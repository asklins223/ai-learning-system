import { ArrowLeft } from "lucide-react";
import { useRoomStore } from "../../app/room-store";

type SurfaceReturnControlProps = {
  readonly className: string;
  readonly label?: string;
  readonly disabled?: boolean;
};

export function SurfaceReturnControl({ className, label = "返回书房", disabled = false }: SurfaceReturnControlProps) {
  const invoke = useRoomStore((state) => state.invoke);

  return (
    <button
      className={`surface-return-control ${className}`}
      type="button"
      disabled={disabled}
      onClick={() => invoke("home")}
      aria-label="关闭任务面并返回房间"
      data-surface-initial-focus="true"
    >
      <ArrowLeft size={17} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
