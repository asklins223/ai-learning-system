import { BookOpenText, CalendarDays, Headphones, LampDesk, Search, Sparkles } from "lucide-react";
import { useRoomStore } from "../app/room-store";

export function HotspotLayer({ ambientAvailable }: { ambientAvailable: boolean }) {
  const viewPreset = useRoomStore((state) => state.viewPreset);
  const surface = useRoomStore((state) => state.surface);
  const invoke = useRoomStore((state) => state.invoke);
  const toggleTheme = useRoomStore((state) => state.toggleTheme);
  const ambientRequested = useRoomStore((state) => state.ambientRequested);
  const toggleAmbient = useRoomStore((state) => state.toggleAmbient);

  if (surface || viewPreset !== "room") return null;

  return (
    <div className="hotspot-layer" aria-label="房间物件快捷入口">
      <button className="hotspot hotspot--notebook" type="button" onClick={() => invoke("continue")} aria-label="打开桌上的研究册" data-focus-return="continue">
        <span className="hotspot__pin"><BookOpenText size={14} aria-hidden="true" /></span>
        <span className="hotspot__label">研究册</span>
      </button>
      <button className="hotspot hotspot--calendar" type="button" onClick={() => invoke("review")} aria-label="从书堆进入今日复习" data-focus-return="review">
        <span className="hotspot__pin"><CalendarDays size={14} aria-hidden="true" /></span>
        <span className="hotspot__label">今日复习</span>
      </button>
      <button className="hotspot hotspot--lamp" type="button" onClick={toggleTheme} aria-label="切换书房灯光">
        <span className="hotspot__pin"><LampDesk size={14} aria-hidden="true" /></span>
        <span className="hotspot__label">灯光</span>
      </button>
      <button className="hotspot hotspot--shelf" type="button" onClick={() => invoke("search")} aria-label="在书架、笔记和证据中查找" data-focus-return="search">
        <span className="hotspot__pin"><Search size={14} aria-hidden="true" /></span>
        <span className="hotspot__label">查找内容</span>
      </button>
      <button className="hotspot hotspot--graph" type="button" onClick={() => invoke("graph")} aria-label="从窗户进入理解星图" data-focus-return="graph">
        <span className="hotspot__pin"><Sparkles size={14} aria-hidden="true" /></span>
        <span className="hotspot__label">理解星图</span>
      </button>
      {ambientAvailable ? (
        <button
          className="hotspot hotspot--listen"
          type="button"
          onClick={toggleAmbient}
          aria-label={ambientRequested ? "关闭环境音" : "聆听窗外"}
          aria-pressed={ambientRequested}
        >
          <span className="hotspot__pin"><Headphones size={14} aria-hidden="true" /></span>
          <span className="hotspot__label hotspot__label--always">{ambientRequested ? "关闭环境音" : "聆听窗外"}</span>
        </button>
      ) : null}
    </div>
  );
}
