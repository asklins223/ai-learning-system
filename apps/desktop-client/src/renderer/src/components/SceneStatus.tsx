import { useEffect, useState } from "react";
import { AlertTriangle, Check, LoaderCircle, X } from "lucide-react";
import { useRoomStore } from "../app/room-store";

const phaseCopy = {
  booting: "学习命令已可用，正在准备房间",
  "poster-ready": "当前使用安静的静态房间",
  "media-loading": "静态房间已就绪，正在载入窗景",
  "media-ready": "窗景已就绪",
  "media-fallback": "装饰媒体不可用，任务仍可继续",
} as const;

export function SceneStatus() {
  const phase = useRoomStore((state) => state.phase);
  const mediaMessage = useRoomStore((state) => state.mediaMessage);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const loading = phase === "booting" || phase === "media-loading";
  const failed = phase === "media-fallback";
  const statusKey = `${phase}:${mediaMessage ?? ""}`;
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => {
    if (dismissedKey !== statusKey) return;
    if (!failed) setDismissedKey(null);
  }, [dismissedKey, failed, statusKey]);

  if (phase === "media-ready" || phase === "poster-ready" || dismissedKey === statusKey) return null;

  const title = failed ? "已切换为静态窗景" : loading ? "正在准备书房" : "书房状态已更新";

  return (
    <div
      className={`scene-status${failed ? " scene-status--error" : ""}`}
      role={failed ? "alert" : "status"}
      aria-live={failed ? "assertive" : "polite"}
      aria-atomic="true"
      aria-hidden={onboardingOpen || undefined}
      inert={onboardingOpen || undefined}
    >
      {loading ? <LoaderCircle className="scene-status__spinner" size={14} aria-hidden="true" /> : failed ? <AlertTriangle size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
      <span className="scene-status__copy"><strong>{title}</strong><small>{mediaMessage || phaseCopy[phase]}</small></span>
      {failed ? (
        <button type="button" className="scene-status__dismiss" onClick={() => setDismissedKey(statusKey)} aria-label="关闭这条通知">
          <X size={13} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
