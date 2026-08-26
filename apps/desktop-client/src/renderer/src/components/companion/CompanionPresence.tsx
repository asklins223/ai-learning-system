import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { GripVertical, MessageCircle, Orbit, RotateCcw, Sparkles, X } from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { useRoomStore, type CompanionPosition } from "../../app/room-store";
import { WindowLive2D, type WindowLive2DStatus } from "./WindowLive2D";

gsap.registerPlugin(useGSAP);

// The bundled Live2D research model is not redistributable. V1 therefore
// exposes only the licensed orb until a package capability explicitly enables
// a replacement model with release approval.
const LIVE2D_RUNTIME_ALLOWED = false;

const SCENE_COPY = {
  room: {
    kicker: "一直在桌边",
    title: "现在想从哪里继续？",
    body: "可以沿着服务端主焦点继续，也可以先读取今天的到期队列。",
    primary: "陪我继续",
    primaryIntent: "continue" as const,
    secondary: "先去复习",
    secondaryIntent: "review" as const,
  },
  study: {
    kicker: "研究进行中",
    title: "慢一点也没关系",
    body: "我会留在台灯旁。先把证据和自己的判断分开写，卡住时再点我。",
    primary: "验证这段理解",
    primaryIntent: "validate" as const,
    secondary: "看看星图",
    secondaryIntent: "graph" as const,
  },
  notebook: {
    kicker: "笔记展开了",
    title: "先留下真正改变判断的句子",
    body: "选中一段证据，就能把它折成一张以后会再遇见的学习卡。",
    primary: "继续研究",
    primaryIntent: "continue" as const,
    secondary: "查看星图",
    secondaryIntent: "graph" as const,
  },
  card: {
    kicker: "卡片正在成形",
    title: "问题要能让未来的你重新想一遍",
    body: "别只抄结论，把当时依赖的证据也留在背面。",
    primary: "回研究册",
    primaryIntent: "continue" as const,
    secondary: "今日复习",
    secondaryIntent: "review" as const,
  },
  "card-generation": {
    kicker: "候选正在整理",
    title: "先审核问题，再决定留下什么",
    body: "公开候选只负责让你判断是否值得复习；答案和激活回执仍由服务端控制。",
    primary: "回研究册",
    primaryIntent: "open-notebook" as const,
    secondary: "回到书房",
    secondaryIntent: "home" as const,
  },
  review: {
    kicker: "安静陪练",
    title: "先回忆，再翻面",
    body: "不会也没关系。真实标记模糊和不会，下一次出现的节奏才会更合适。",
    primary: "回到研究册",
    primaryIntent: "continue" as const,
    secondary: "查看星图",
    secondaryIntent: "graph" as const,
  },
  search: {
    kicker: "在资料边等你",
    title: "搜索的是证据，不只是关键词",
    body: "打开结果后，看看它来自笔记、学习卡还是原始来源。",
    primary: "回到研究册",
    primaryIntent: "continue" as const,
    secondary: "看看星图",
    secondaryIntent: "graph" as const,
  },
  graph: {
    kicker: "一起看见关系",
    title: "亮点之间的线，才是理解",
    body: "先找最孤单的概念；它通常就是下一步值得补证据的地方。",
    primary: "回到研究册",
    primaryIntent: "continue" as const,
    secondary: "查找证据",
    secondaryIntent: "search" as const,
  },
  validation: {
    kicker: "正在听你的解释",
    title: "先说清为什么，再说答案",
    body: "如果证据能支持因果链，我会和你一起把这次理解收好。",
    primary: "继续研究",
    primaryIntent: "continue" as const,
    secondary: "查看星图",
    secondaryIntent: "graph" as const,
  },
} as const;

function durationFor(mode: "full" | "lite" | "off", full: number) {
  return mode === "off" ? 0 : mode === "lite" ? full * 0.55 : full;
}

export function CompanionPresence() {
  const surface = useRoomStore((state) => state.surface);
  const theme = useRoomStore((state) => state.theme);
  const motionMode = useRoomStore((state) => state.motionMode);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const companionOpen = useRoomStore((state) => state.companionOpen);
  const companionForm = useRoomStore((state) => state.companionForm);
  const companionMoment = useRoomStore((state) => state.companionMoment);
  const companionPosition = useRoomStore((state) => state.companionPosition);
  const toggleCompanion = useRoomStore((state) => state.toggleCompanion);
  const closeCompanion = useRoomStore((state) => state.closeCompanion);
  const setCompanionForm = useRoomStore((state) => state.setCompanionForm);
  const setCompanionPosition = useRoomStore((state) => state.setCompanionPosition);
  const resetCompanionPosition = useRoomStore((state) => state.resetCompanionPosition);
  const invoke = useRoomStore((state) => state.invoke);
  const rootRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const visualRef = useRef<HTMLDivElement>(null);
  const motionRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startPosition: CompanionPosition;
  } | null>(null);
  const canonicalLampRef = useRef<{ xRatio: number; yRatio: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<WindowLive2DStatus>("fallback");
  const [inviteTrigger, setInviteTrigger] = useState(0);
  const renderedCompanionForm = LIVE2D_RUNTIME_ALLOWED && companionForm === "live2d" ? "live2d" : "orb";
  const sceneKey = surface ?? "room";
  const copy = SCENE_COPY[sceneKey];
  const formalAssessmentSilent = surface === "validation" && companionMoment !== "confirm";
  const presenceHidden = onboardingOpen || formalAssessmentSilent;

  useEffect(() => {
    // Position is deliberately not part of the persisted room slice. Every
    // app mount starts from the visual owner's canonical anchor.
    resetCompanionPosition();
  }, [resetCompanionPosition]);

  useEffect(() => {
    if (!LIVE2D_RUNTIME_ALLOWED && companionForm !== "orb") setCompanionForm("orb");
  }, [companionForm, setCompanionForm]);

  useEffect(() => {
    const root = rootRef.current;
    const anchor = anchorRef.current;
    const visual = visualRef.current;
    if (!root || !anchor || !visual) return;

    let frame = 0;
    const syncCanonicalAnchor = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const rootRect = root.getBoundingClientRect();
        if (rootRect.width <= 0 || rootRect.height <= 0) return;

        const lamp = document.querySelector<HTMLElement>(".hotspot--lamp");
        const lampRect = lamp?.getBoundingClientRect();
        if (lampRect && lampRect.width > 0 && lampRect.height > 0) {
          // The orb lives just below and to the left of the actual lamp hotspot.
          // Store a ratio so the same measured relationship survives task entry
          // (the hotspot is deliberately unmounted while an L2 surface is open).
          const targetX = lampRect.left + lampRect.width / 2 - rootRect.left - rootRect.width * 0.08;
          const targetY = lampRect.top + lampRect.height / 2 - rootRect.top + rootRect.height * 0.15;
          canonicalLampRef.current = {
            xRatio: targetX / rootRect.width,
            yRatio: targetY / rootRect.height,
          };
        }

        const target = canonicalLampRef.current ?? { xRatio: 0.56, yRatio: 0.58 };
        const anchorWidth = anchor.offsetWidth;
        const anchorHeight = anchor.offsetHeight;
        const visualWidth = visual.offsetWidth;
        const visualHeight = visual.offsetHeight;
        const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
        const left = target.xRatio * rootRect.width - (anchorWidth - visualWidth / 2);
        const top = target.yRatio * rootRect.height - (anchorHeight - visualHeight / 2);

        anchor.style.left = `${Math.round(clamp(left, 0, Math.max(0, rootRect.width - anchorWidth)))}px`;
        anchor.style.top = `${Math.round(clamp(top, 0, Math.max(0, rootRect.height - anchorHeight)))}px`;
      });
    };

    const observer = new ResizeObserver(syncCanonicalAnchor);
    observer.observe(root);
    observer.observe(anchor);
    observer.observe(visual);
    window.addEventListener("resize", syncCanonicalAnchor);
    syncCanonicalAnchor();
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", syncCanonicalAnchor);
    };
  }, [renderedCompanionForm, surface]);

  useGSAP(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    gsap.to(anchor, {
      xPercent: 0,
      yPercent: 0,
      x: companionPosition.x,
      y: companionPosition.y,
      scale: renderedCompanionForm === "live2d" ? (surface ? 0.78 : 0.9) : (surface ? 0.82 : 1),
      duration: dragging ? 0 : durationFor(motionMode, 0.82),
      ease: motionMode === "off" ? "none" : "power3.inOut",
      overwrite: "auto",
      force3D: true,
    });
  }, { scope: rootRef, dependencies: [surface, renderedCompanionForm, motionMode, companionPosition.x, companionPosition.y, dragging] });

  useGSAP(() => {
    const panel = panelRef.current;
    if (!panel) return;
    gsap.to(panel, {
      autoAlpha: companionOpen ? 1 : 0,
      y: companionOpen ? 0 : 12,
      scale: companionOpen ? 1 : 0.97,
      duration: durationFor(motionMode, 0.36),
      ease: companionOpen ? "power3.out" : "power2.in",
      overwrite: "auto",
      transformOrigin: "82% 100%",
    });
  }, { scope: rootRef, dependencies: [companionOpen, motionMode] });

  useGSAP(() => {
    const visual = visualRef.current;
    if (!visual) return;
    const orb = visual.querySelector<HTMLImageElement>(".window-live2d img");
    if (!orb) return;
    gsap.killTweensOf(orb);
    gsap.set(orb, { y: 0 });
    if (motionMode !== "full" || renderedCompanionForm !== "orb" || companionOpen) return;
    gsap.to(orb, {
      y: -6,
      duration: 2.1,
      repeat: -1,
      yoyo: true,
      ease: "sine.inOut",
    });
  }, { scope: rootRef, dependencies: [motionMode, renderedCompanionForm, companionOpen, status] });

  useGSAP(() => {
    const rings = motionRef.current?.querySelectorAll<HTMLElement>(".companion-motion-ring");
    if (!rings?.length) return;
    gsap.killTweensOf(rings);
    gsap.set(rings, { autoAlpha: 0, scale: 0.62, rotation: 0 });
    if (motionMode === "off") return;

    const timeline = gsap.timeline({ defaults: { ease: "power2.out" } });
    const motionPresentation = presentationForMotion(companionMoment, companionOpen);
    if (motionPresentation === "confirm") {
      timeline
        .to(rings, { autoAlpha: 0.82, scale: 0.94, rotation: 10, duration: durationFor(motionMode, 0.34), stagger: 0.06 })
        .to(rings, { autoAlpha: 0, scale: 1.28, rotation: 22, duration: durationFor(motionMode, 0.58), stagger: 0.07 }, "-=0.12");
    } else if (motionPresentation === "invite") {
      timeline.to(rings, { autoAlpha: 0.74, scale: 1, duration: durationFor(motionMode, 0.42), stagger: 0.08 })
        .to(rings, { autoAlpha: 0, scale: 1.2, duration: durationFor(motionMode, 0.5), stagger: 0.08 }, "-=0.18");
    } else if (companionMoment === "lamp") {
      timeline.to(rings, { autoAlpha: 0.46, scale: 1.04, duration: durationFor(motionMode, 0.46), stagger: 0.06 })
        .to(rings, { autoAlpha: 0, scale: 1.22, duration: durationFor(motionMode, 0.65), stagger: 0.07 }, "-=0.12");
    }
    return () => timeline.kill();
  }, { scope: rootRef, dependencies: [companionMoment, companionOpen, motionMode, surface] });

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPosition: companionPosition,
    };
    setDragging(true);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    const bounds = surface
      ? { minX: -90, maxX: 105, minY: -82, maxY: 72 }
      : { minX: -150, maxX: 180, minY: -120, maxY: 105 };
    setCompanionPosition({
      x: clamp(drag.startPosition.x + event.clientX - drag.startX, bounds.minX, bounds.maxX),
      y: clamp(drag.startPosition.y + event.clientY - drag.startY, bounds.minY, bounds.maxY),
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(false);
  };

  const presentation = companionMoment === "lamp" || companionMoment === "confirm"
    ? "celebrate"
    : companionOpen
      ? "invite"
      : "idle";

  const rendererLabel = renderedCompanionForm === "live2d"
    ? status === "ready"
      ? "Live2D 形态"
      : motionMode === "full"
        ? "正在准备 Live2D"
        : "低动效使用星光形态"
    : "星光形态 · Live2D 待许可";

  const interactionCopy = companionMoment === "confirm"
    ? "服务端结果已经确认。这次学习已安全写入，可以回到复习队列继续。"
    : companionMoment === "lamp"
    ? theme === "night"
      ? "台灯亮了。光只落在桌面上，我们可以安静地继续。"
      : "窗边的自然光回来了，眼睛也能松一点。"
    : companionMoment === "ambient"
      ? "窗外的声音会在你进入任务时自动安静下来。"
      : copy.body;

  return (
    <div
      ref={rootRef}
      className="companion-presence"
      data-open={companionOpen}
      data-form={renderedCompanionForm}
      data-live2d-available={LIVE2D_RUNTIME_ALLOWED}
      data-surface={sceneKey}
      data-formal-silent={formalAssessmentSilent || undefined}
      aria-hidden={presenceHidden || undefined}
    >
      <div ref={anchorRef} className="companion-scene-anchor">
        <aside
          ref={panelRef}
          className="companion-whisper"
          aria-label="AI 伴星建议"
          aria-hidden={!companionOpen}
          inert={!companionOpen}
        >
          <button className="companion-whisper__close" type="button" onClick={closeCompanion} aria-label="收起伴星">
            <X size={15} aria-hidden="true" />
          </button>
          <span className="companion-whisper__kicker"><Sparkles size={13} aria-hidden="true" />{copy.kicker}</span>
          <h2>{copy.title}</h2>
          <p>{interactionCopy}</p>
          <div className="companion-whisper__actions">
            <button type="button" className="companion-action companion-action--primary" onClick={() => invoke(copy.primaryIntent)}>{copy.primary}</button>
            <button type="button" className="companion-action" onClick={() => invoke(copy.secondaryIntent)}>{copy.secondary}</button>
          </div>
          <details className="companion-whisper__settings">
            <summary>形态与位置 <small>{rendererLabel}</small></summary>
            <div className="companion-form-switch" role="group" aria-label="伴星形态">
              <button type="button" aria-pressed={renderedCompanionForm === "orb"} onClick={() => setCompanionForm("orb")}>
                <Orbit size={14} aria-hidden="true" />星光
              </button>
              <button type="button" aria-pressed="false" disabled title="许可与打包能力尚未开放">
                <MessageCircle size={14} aria-hidden="true" />Live2D 待许可
              </button>
            </div>
            <div className="companion-whisper__footer">
              <span>位置只保留到本次打开</span>
              <button type="button" className="companion-reset-position" onClick={resetCompanionPosition}>
                <RotateCcw size={12} aria-hidden="true" />重置位置
              </button>
            </div>
          </details>
        </aside>

        <div ref={visualRef} className={`companion-visual-shell${dragging ? " companion-visual-shell--dragging" : ""}`}>
          <div ref={motionRef} className="companion-motion-rings" aria-hidden="true">
            <span className="companion-motion-ring companion-motion-ring--one" />
            <span className="companion-motion-ring companion-motion-ring--two" />
            <span className="companion-motion-ring companion-motion-ring--three" />
          </div>
          <button
            type="button"
            className="companion-drag-handle"
            data-companion-drag-handle="true"
            aria-label="拖动伴星位置"
            title="拖动伴星；重新打开应用会回到标准位置"
            onPointerDown={beginDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <GripVertical size={13} aria-hidden="true" />
          </button>
          <WindowLive2D
            active={!presenceHidden}
            motionMode={renderedCompanionForm === "live2d" ? motionMode : "off"}
            presentation={presentation}
            inviteTrigger={inviteTrigger}
            onStatus={setStatus}
            onInviteRequest={() => {
              if (companionOpen) setInviteTrigger((value) => value + 1);
              else toggleCompanion();
            }}
            ariaLabel="书桌上的 AI 伴星"
          />
          {!companionOpen ? <span className="companion-invite-label" aria-hidden="true">我在这里</span> : null}
        </div>
      </div>
    </div>
  );
}

function presentationForMotion(companionMoment: "idle" | "lamp" | "ambient" | "confirm", companionOpen: boolean) {
  if (companionMoment === "confirm") return "confirm";
  if (companionMoment === "lamp") return "celebrate";
  if (companionOpen) return "invite";
  return "idle";
}
