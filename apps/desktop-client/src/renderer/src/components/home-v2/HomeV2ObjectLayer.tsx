import {
  ArrowLeft,
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  MessageCircle,
  Orbit,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useHomeProjection } from "../../app/home-projection";
import { homePresentation } from "../../app/home-presentation";
import { useRoomStore } from "../../app/room-store";
import { resolveSceneMotionMode } from "../../scene/scene-motion";
import { useHomeV2 } from "./HomeV2Experience";
import { useHudPage } from "../hud/use-hud-page";
import { HOME_FEATURE_ICONS } from "./home-feature-icons";
import { homeFeaturesForRegion, type HomeFeatureRegionId } from "./home-feature-registry";
import type { HomeV2Zone } from "./home-v2";

type ObjectZone = Exclude<HomeV2Zone, "wide">;

const REGION_COPY: Readonly<Record<ObjectZone, Readonly<{
  id: string;
  label: string;
  detail: string;
  icon: LucideIcon;
}>>> = Object.freeze({
  desk: { id: "desk-book", label: "书桌", detail: "今日行动、复习与快速收录", icon: BookOpenText },
  shelf: { id: "magic-catalog", label: "书架", detail: "研究册、资料、学习卡与搜索", icon: Search },
  window: { id: "window-stars", label: "星窗", detail: "目标、理解星图与学习动态", icon: Orbit },
  rest: { id: "rest-cushion", label: "休息角", detail: "伴星、日记、人格与记忆", icon: MessageCircle },
});

function RoomRegion({ zone, onActivate }: { readonly zone: ObjectZone; readonly onActivate: () => void }) {
  const copy = REGION_COPY[zone];
  const Icon = copy.icon;
  return (
    <button
      id={`home-v2-object-${copy.id}`}
      type="button"
      className={`home-v2-object home-v2-object--${copy.id}`}
      data-room-object={copy.id}
      data-zone={zone}
      aria-label={`${copy.label}：${copy.detail}。按下后聚焦区域`}
      onClick={onActivate}
    >
      <span className="home-v2-object__focus-frame" aria-hidden="true" />
      <span className="home-v2-object__response" aria-hidden="true" />
      <span className="home-v2-object__label">
        <Icon size={17} strokeWidth={1.7} aria-hidden="true" />
        <span><strong>{copy.label}</strong><small>{copy.detail}</small></span>
      </span>
    </button>
  );
}

function RegionFeatureMenu({ zone, onBack }: { readonly zone: ObjectZone; readonly onBack: () => void }) {
  const firstFeatureRef = useRef<HTMLButtonElement>(null);
  const { featurePresentation, runFeature } = useHomeV2();
  const features = homeFeaturesForRegion(zone as HomeFeatureRegionId);
  const copy = REGION_COPY[zone];

  useEffect(() => {
    window.requestAnimationFrame(() => firstFeatureRef.current?.focus({ preventScroll: true }));
  }, [zone]);

  return (
    <nav className="home-v2-region-menu" data-region={zone} aria-label={`${copy.label}功能`}>
      <header>
        <span><strong>{copy.label}</strong><small>{copy.detail}</small></span>
        <button type="button" onClick={onBack} aria-label={`退出${copy.label}`} title="回到房间总览"><X size={18} aria-hidden="true" /></button>
      </header>
      <div className="home-v2-region-menu__features">
        {features.map((definition, index) => {
          const feature = featurePresentation(definition.id);
          const Icon = HOME_FEATURE_ICONS[definition.icon];
          return (
            <button
              ref={index === 0 ? firstFeatureRef : undefined}
              key={definition.id}
              id={`home-v2-region-feature-${definition.id}`}
              type="button"
              data-feature={definition.id}
              data-feature-state={feature.state}
              disabled={feature.state === "loading"}
              onClick={() => runFeature(definition.id)}
            >
              <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
              <span><strong>{feature.title}</strong><small>{feature.meta}</small></span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function CompactZoneNavigation({ onZone }: { readonly onZone: (zone: ObjectZone) => void }) {
  return (
    <nav className="home-v2-compact-nav" aria-label="小屋功能区域">
      <p>去哪里看看？</p>
      <div className="home-v2-compact-nav__zones">
        {(Object.keys(REGION_COPY) as ObjectZone[]).map((zone) => {
          const copy = REGION_COPY[zone];
          const Icon = copy.icon;
          return (
            <button id={`home-v2-compact-zone-${zone}`} key={zone} type="button" onClick={() => onZone(zone)}>
              <Icon size={19} strokeWidth={1.7} aria-hidden="true" />
              <span>{copy.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function HomeV2Hud({ introVisible, loading, state, title, primaryLabel, theme, motionMode, onPrimary, onCatalog }: {
  readonly introVisible: boolean;
  readonly loading: boolean;
  readonly state: string;
  readonly title: string;
  readonly primaryLabel: string;
  readonly theme: "day" | "night";
  readonly motionMode: "full" | "lite" | "off";
  readonly onPrimary: () => void;
  readonly onCatalog: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hudTitle = introVisible ? "先从桌上的书开始" : primaryLabel;
  const hudDetail = introVisible ? "它会带你回到今天真正停下的位置。" : title;

  useEffect(() => { setExpanded(introVisible); }, [introVisible]);
  useEffect(() => {
    if (!expanded) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      const restoreFocus = rootRef.current?.contains(document.activeElement);
      setExpanded(false);
      if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
    };
    window.addEventListener("pointerdown", closeFromOutside, true);
    return () => window.removeEventListener("pointerdown", closeFromOutside, true);
  }, [expanded]);

  const collapse = () => {
    setExpanded(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  };

  // The home HUD only mounts on the room overview, so it owns the mockup 01 page
  // identity; every business page publishes its own number instead.
  useHudPage("home");

  return (
    <aside ref={rootRef} className={`home-v2-hud${expanded ? " home-v2-hud--expanded" : ""}`} data-state={loading ? "loading" : state} data-intro={introVisible || undefined} data-theme={theme} data-motion-mode={motionMode} aria-labelledby="home-v2-hud-title" aria-describedby="home-v2-hud-detail" onKeyDown={(event) => { if (event.key === "Escape" && expanded) { event.preventDefault(); event.stopPropagation(); collapse(); } }}>
      <button ref={triggerRef} type="button" className="home-v2-hud__trigger" aria-expanded={expanded} aria-label={expanded ? "收起今日下一步" : `展开今日下一步：${hudTitle}`} onClick={() => setExpanded((current) => !current)}>
        <span className="home-v2-hud__signal" aria-hidden="true" />
        <span className="home-v2-hud__trigger-copy"><small>{loading ? "正在同步" : introVisible ? "从这里开始" : "今日下一步"}</small><strong id="home-v2-hud-title">{hudTitle}</strong></span>
        {expanded ? <ChevronLeft size={16} strokeWidth={1.8} aria-hidden="true" /> : <ChevronRight size={16} strokeWidth={1.8} aria-hidden="true" />}
      </button>
      <div className="home-v2-hud__panel" aria-hidden={!expanded} inert={!expanded}>
        <p id="home-v2-hud-detail" aria-live="polite">{hudDetail}</p>
        <div className="home-v2-hud__actions">
          <button type="button" className="home-v2-hud__primary" disabled={loading} onClick={() => { setExpanded(false); onPrimary(); }}><BookOpenText size={17} strokeWidth={1.8} aria-hidden="true" /><span>{introVisible ? "去书桌" : primaryLabel}</span></button>
          <button type="button" aria-label="打开魔法目录" title="魔法目录" onClick={() => { setExpanded(false); onCatalog(); }}><Search size={17} strokeWidth={1.8} aria-hidden="true" /></button>
        </div>
      </div>
    </aside>
  );
}

export function HomeV2ObjectLayer() {
  const { projection, loading, failure, reload } = useHomeProjection();
  const home = homePresentation(projection, loading, failure);
  const theme = useRoomStore((state) => state.theme);
  const surface = useRoomStore((state) => state.surface);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const viewPreset = useRoomStore((state) => state.viewPreset);
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const motionMode = resolveSceneMotionMode(motionPreference, reducedMotion);
  const { zone, focusRegion, exitRegion, runFeature, introVisible } = useHomeV2();
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setPortalHost(document.querySelector<HTMLElement>(".desktop-app"));
  }, []);

  if (surface || onboardingOpen || viewPreset !== "room") return null;

  const portalTarget = portalHost ?? document.body;
  const runPrimary = () => {
    if (home.retry) {
      reload();
      return;
    }
    if (home.primaryIntent === "continue") {
      runFeature("continue");
      return;
    }
    if (home.primaryIntent === "open-card") {
      runFeature("current-target");
      return;
    }
    if (home.primaryLabel === "查看书房目录") {
      runFeature("catalog");
      return;
    }
    focusRegion("desk");
  };

  return (
    <>
      <div className="home-v2-objects" aria-label="小屋功能区域" data-active-zone={zone}>
        {zone !== "wide" ? <div className="home-v2-room-backdrop" aria-hidden="true" onPointerDown={exitRegion} /> : null}
        {zone === "wide" ? (Object.keys(REGION_COPY) as ObjectZone[]).map((region) => <RoomRegion key={region} zone={region} onActivate={() => focusRegion(region)} />) : null}
      </div>
      {createPortal(<HomeV2Hud introVisible={introVisible} loading={home.blockingLoading} state={home.notebookState} title={home.title} primaryLabel={home.primaryLabel} theme={theme} motionMode={motionMode} onPrimary={runPrimary} onCatalog={() => runFeature("catalog")} />, portalTarget)}
      {zone === "wide"
        ? createPortal(<CompactZoneNavigation onZone={focusRegion} />, portalTarget)
        : createPortal(<RegionFeatureMenu zone={zone} onBack={exitRegion} />, portalTarget)}
    </>
  );
}
