import { useRef } from "react";
import { BookOpenText, CalendarCheck2, Search } from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { useRoomStore } from "../app/room-store";

gsap.registerPlugin(useGSAP);

const actions = [
  {
    intent: "continue" as const,
    title: "继续学习",
    detail: "服务端主焦点",
    shortcut: "Mod ↵",
    icon: BookOpenText,
    primary: true,
  },
  {
    intent: "review" as const,
    title: "今日复习",
    detail: "服务端到期队列",
    shortcut: "R",
    icon: CalendarCheck2,
    primary: false,
  },
  {
    intent: "search" as const,
    title: "查找内容",
    detail: "公开 Objective 与来源",
    shortcut: "Mod K",
    icon: Search,
    primary: false,
  },
];

export function ActionRail() {
  const invoke = useRoomStore((state) => state.invoke);
  const surface = useRoomStore((state) => state.surface);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const motionMode = useRoomStore((state) => state.motionMode);
  const modifier = window.ailearnDesktop?.platform === "darwin" ? "⌘" : "Ctrl";
  const recessed = Boolean(surface) || onboardingOpen;
  const railRef = useRef<HTMLElement>(null);

  useGSAP(() => {
    if (!railRef.current) return;
    const duration = motionMode === "off" ? 0 : motionMode === "lite" ? 0.2 : 0.36;
    gsap.to(railRef.current, {
      autoAlpha: recessed ? 0 : 1,
      y: recessed ? 14 : 0,
      scale: recessed ? 0.97 : 1,
      duration,
      ease: recessed ? "power2.in" : "power3.out",
      overwrite: "auto",
      pointerEvents: recessed ? "none" : "auto",
    });
  }, { scope: railRef, dependencies: [recessed, motionMode] });

  return (
    <nav
      ref={railRef}
      id="primary-actions"
      className={`action-rail${recessed ? " action-rail--recessed" : ""}`}
      aria-label="学习主动作"
      aria-hidden={recessed ? true : undefined}
      inert={recessed ? true : undefined}
      tabIndex={-1}
    >
      {actions.map(({ intent, title, detail, shortcut, icon: Icon, primary }) => (
        <button
          key={intent}
          type="button"
          className={`rail-action${primary ? " rail-action--primary" : ""}`}
          onClick={() => invoke(intent)}
          aria-label={`${title}：${detail}`}
          title={primary ? detail : title}
          data-testid={`action-${intent}`}
          data-focus-return={intent}
        >
          <span className="rail-action__icon" aria-hidden="true"><Icon size={20} strokeWidth={1.65} /></span>
          <span className="rail-action__copy">
            <strong>{title}</strong>
            <span>{detail}</span>
          </span>
          <kbd>{shortcut.replace("Mod", modifier)}</kbd>
        </button>
      ))}
    </nav>
  );
}
