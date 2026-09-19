import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type SVGProps } from "react";
import {
  ArrowRight,
  BrainCircuit,
  BookOpenText,
  CalendarCheck2,
  CalendarDays,
  CircleAlert,
  Gauge,
  House,
  MessageCircle,
  Orbit,
  Search,
  Sparkles,
  SquareStack,
  UserRoundCog,
  X,
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { createPortal } from "react-dom";
import { useRoomStore } from "../app/room-store";
import { resolveSceneMotionMode } from "../scene/scene-motion";
import { useHomeProjection } from "../app/home-projection";
import { homePresentation } from "../app/home-presentation";
import { RunRecoveryNotice } from "./RunRecoveryNotice";

gsap.registerPlugin(useGSAP);

type CatalogIcon = ComponentType<SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }>;
type EntryState = "ready" | "context" | "pending";

type CatalogEntryProps = {
  readonly icon: CatalogIcon;
  readonly title: string;
  readonly detail: string;
  readonly meta?: string;
  readonly state: EntryState;
  readonly onClick: () => void;
};

function CatalogEntry({ icon: Icon, title, detail, meta, state, onClick }: CatalogEntryProps) {
  return (
    <button type="button" className="home-catalog-entry" data-entry-state={state} onClick={onClick}>
      <span className="home-catalog-entry__icon" aria-hidden="true"><Icon size={17} strokeWidth={1.7} /></span>
      <span className="home-catalog-entry__copy"><strong>{title}</strong><small>{detail}</small></span>
      <span className="home-catalog-entry__meta">{meta ?? (state === "pending" ? "待迁移" : state === "context" ? "按当前内容" : "可进入")}</span>
    </button>
  );
}

function countLabel(value: number | null, suffix = "") {
  return value === null ? "—" : `${value}${suffix}`;
}

function snapshotLabel(value: string | null) {
  if (!value) return "等待同步";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "已同步";
  return `${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date)} 同步`;
}

export function ActionRail() {
  const { projection, loading, failure, reload } = useHomeProjection();
  const home = homePresentation(projection, loading, failure);
  const invoke = useRoomStore((state) => state.invoke);
  const surface = useRoomStore((state) => state.surface);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const motionMode = resolveSceneMotionMode(motionPreference, reducedMotion);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [notice, setNotice] = useState<{ title: string; detail: string } | null>(null);
  const recessed = Boolean(surface) || onboardingOpen;
  const railRef = useRef<HTMLElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const catalogToggleRef = useRef<HTMLButtonElement>(null);
  const enabledRoutes = useMemo(() => new Set(window.ailearn?.contract.enabledRoutes ?? []), []);
  const closeCatalog = useCallback(() => {
    setCatalogOpen(false);
    window.requestAnimationFrame(() => catalogToggleRef.current?.focus({ preventScroll: true }));
  }, []);
  const openCatalog = useCallback(() => {
    setCatalogOpen(true);
    window.requestAnimationFrame(() => drawerRef.current?.querySelector<HTMLButtonElement>(".home-catalog__close")?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => {
    if (!surface) return;
    setCatalogOpen(false);
    setNotice(null);
  }, [surface]);

  useEffect(() => {
    const onUnavailable = (event: Event) => {
      const detail = (event as CustomEvent<{ title?: string; detail?: string }>).detail;
      openCatalog();
      setNotice({
        title: detail?.title || "这项功能还在搬进书房",
        detail: detail?.detail || "入口已经保留，桌面端链路完成后会从这里进入。",
      });
    };
    window.addEventListener("ailearn:home-unavailable", onUnavailable);
    return () => window.removeEventListener("ailearn:home-unavailable", onUnavailable);
  }, [openCatalog]);

  useEffect(() => {
    if (!catalogOpen || recessed) return;
    const keepCatalogModal = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeCatalog();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = drawerRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
      )).filter((element) => !element.inert && getComputedStyle(element).visibility !== "hidden");
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", keepCatalogModal, true);
    return () => window.removeEventListener("keydown", keepCatalogModal, true);
  }, [catalogOpen, closeCatalog, recessed]);

  useEffect(() => {
    if (!catalogOpen || recessed) return;
    const background = [
      document.querySelector<HTMLElement>(".scene-stage"),
      document.querySelector<HTMLElement>(".companion-presence"),
      document.querySelector<HTMLElement>(".room-control"),
      // The space menu the control pill opens is its sibling, not its child, so
      // it has to be named here as well or an open menu would stay clickable
      // above the catalog dialog.
      document.querySelector<HTMLElement>(".room-control-menu"),
    ].filter((element): element is HTMLElement => Boolean(element));
    const otherRailActions = Array.from(railRef.current?.querySelectorAll<HTMLElement>(":scope > .rail-action") ?? [])
      .filter((element) => element !== catalogToggleRef.current);
    const targets = [...background, ...otherRailActions];
    const previous = targets.map((element) => ({ element, inert: element.inert }));
    targets.forEach((element) => { element.inert = true; });
    return () => previous.forEach(({ element, inert }) => { element.inert = inert; });
  }, [catalogOpen, recessed]);

  useGSAP(() => {
    if (!railRef.current) return;
    const duration = motionMode === "off" ? 0 : motionMode === "lite" ? 0.18 : 0.34;
    gsap.to(railRef.current, {
      autoAlpha: recessed ? 0 : 1,
      y: recessed ? 18 : 0,
      scale: recessed ? 0.985 : 1,
      duration,
      ease: recessed ? "power2.in" : "power3.out",
      overwrite: "auto",
      pointerEvents: recessed ? "none" : "auto",
    });
  }, { scope: railRef, dependencies: [recessed, motionMode] });

  useGSAP(() => {
    if (!drawerRef.current) return;
    const duration = motionMode === "off" ? 0 : motionMode === "lite" ? 0.18 : 0.32;
    gsap.fromTo(
      drawerRef.current,
      { autoAlpha: catalogOpen ? 0 : 1, y: catalogOpen ? 18 : 0, rotateX: catalogOpen ? -3 : 0 },
      {
        autoAlpha: catalogOpen ? 1 : 0,
        y: catalogOpen ? 0 : 18,
        rotateX: catalogOpen ? 0 : -3,
        duration,
        ease: catalogOpen ? "power3.out" : "power2.in",
        pointerEvents: catalogOpen ? "auto" : "none",
        overwrite: "auto",
      },
    );
  }, { scope: railRef, dependencies: [catalogOpen, motionMode], revertOnUpdate: true });

  useGSAP(() => {
    if (!notice || !noticeRef.current || motionMode === "off") return;
    gsap.fromTo(noticeRef.current, { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.24, ease: "power3.out" });
  }, { scope: railRef, dependencies: [notice, motionMode], revertOnUpdate: true });

  const showPending = (title: string, detail: string) => {
    if (!catalogOpen) openCatalog();
    setNotice({ title, detail });
  };
  const openCompanion = () => {
    setCatalogOpen(false);
    window.dispatchEvent(new CustomEvent("ailearn:companion-open"));
    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".companion-hud__composer textarea")?.focus({ preventScroll: true }));
  };
  const openNote = () => {
    if (!home.note || !enabledRoutes.has("note.detail")) {
      showPending("研究册暂时没有可打开的书签", "首页只会打开服务端确认过身份的笔记；完整笔记库仍在迁移中。");
      return;
    }
    setActiveNoteRef({ noteId: home.note.noteId, noteVersionId: home.note.noteVersionId });
    invoke("open-notebook");
  };
  const openReview = () => {
    if (!enabledRoutes.has("review.queue")) {
      showPending("复习台尚未开放", "复习入口已经保留，当前桌面合同还没有签发可用路由。");
      return;
    }
    invoke("review");
  };
  const openCurrentTarget = () => {
    if (!home.hasFocus) {
      showPending("当前还没有学习目标", "先从研究册或来源资料形成目标，服务端确认后会出现在这里。");
      return;
    }
    const objectiveId = projection?.primaryFocus.state === "data"
      ? projection.primaryFocus.data.objective.objectiveId
      : null;
    if (!objectiveId) {
      invoke("open-objectives");
      return;
    }
    setActiveObjectiveId(objectiveId);
    invoke("open-objective");
  };
  const runPrimary = () => {
    if (loading) return;
    if (home.retry) {
      reload();
      return;
    }
    if (home.primaryIntent === "open-notebook") {
      openNote();
      return;
    }
    if (home.primaryIntent === "open-objective") {
      openCurrentTarget();
      return;
    }
    if (home.primaryIntent) {
      invoke(home.primaryIntent);
      return;
    }
    openCatalog();
  };

  return (
    <nav
      ref={railRef}
      id="primary-actions"
      className={`action-rail home-command-deck${recessed ? " action-rail--recessed" : ""}`}
      aria-label="学习总控台"
      aria-hidden={recessed ? true : undefined}
      inert={recessed ? true : undefined}
      tabIndex={-1}
    >
      {catalogOpen ? createPortal(
        <button className="home-catalog-scrim" type="button" tabIndex={-1} aria-hidden="true" onClick={closeCatalog} />,
        railRef.current?.closest<HTMLElement>(".desktop-access-gate__room-content")
          ?? document.querySelector<HTMLElement>(".desktop-access-gate__room-content")
          ?? document.body,
      ) : null}
      <div
        id="home-catalog"
        ref={drawerRef}
        className="home-catalog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="home-catalog-title"
        aria-hidden={!catalogOpen}
        inert={!catalogOpen || undefined}
      >
        <header className="home-catalog__header">
          <div className="home-catalog__title">
            <strong id="home-catalog-title">书房目录</strong>
            <span>{snapshotLabel(home.snapshotAt)}{home.degraded ? " · 部分信息待恢复" : ""}</span>
          </div>
          <dl className="home-catalog__ledger" aria-label="真实学习概览">
            <div><dt>研究册</dt><dd>{countLabel(home.noteCount)}</dd></div>
            <div><dt>学习目标</dt><dd>{countLabel(home.objectiveCount)}</dd></div>
            <div><dt>待复习</dt><dd>{countLabel(home.dueCount)}</dd></div>
            <div><dt>进行中</dt><dd>{countLabel(home.activeRunCount)}</dd></div>
            {home.repairCount ? <div data-tone="attention"><dt>待修补</dt><dd>{home.repairCount}</dd></div> : null}
          </dl>
          <button type="button" className="home-catalog__close" onClick={closeCatalog} aria-label="收起书房目录"><X size={17} aria-hidden="true" /></button>
        </header>

        <div className="home-catalog__status">
          {notice ? (
            <div ref={noticeRef} className="home-capability-notice" role="status" aria-live="polite">
              <span className="home-capability-notice__mark" aria-hidden="true"><CircleAlert size={18} /></span>
              <span className="home-capability-notice__copy"><strong>{notice.title}</strong><small>{notice.detail}</small></span>
              <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示"><X size={15} aria-hidden="true" /></button>
            </div>
          ) : null}
          <RunRecoveryNotice />
        </div>

        <div className="home-catalog__groups">
          <section className="home-catalog-group" aria-labelledby="home-group-today">
            <h2 id="home-group-today">今天</h2>
            <CatalogEntry icon={BookOpenText} title={home.primaryLabel} detail={home.title} meta={loading ? "同步中" : home.retry ? "重试" : "主任务"} state={home.retry ? "context" : "ready"} onClick={runPrimary} />
            <CatalogEntry icon={CalendarCheck2} title="今日复习" detail={home.reviewLabel} meta={home.dueCount === null ? "待同步" : `${home.dueCount} 项`} state="ready" onClick={openReview} />
            <CatalogEntry icon={Sparkles} title="当前学习目标" detail={home.hasFocus ? "查看公开目标与下一步" : "等待服务端主焦点"} state={home.hasFocus ? "ready" : "context"} onClick={openCurrentTarget} />
          </section>

          <section className="home-catalog-group" aria-labelledby="home-group-organize">
            <h2 id="home-group-organize">整理</h2>
            <CatalogEntry icon={BookOpenText} title="当前研究册" detail={home.note ? home.note.title : "尚无可打开的书签"} meta={home.note ? "可编辑" : "待内容"} state="context" onClick={openNote} />
            <CatalogEntry icon={BookOpenText} title="全部笔记" detail="新建、导入、回收与版本" state="pending" onClick={() => showPending("完整笔记库正在迁移", "当前可以进入服务端确认的研究册；新建、导入、回收站和版本列表尚未接入桌面端。")}/>
            <CatalogEntry icon={Search} title="来源资料" detail="收录、解析与归档" state="pending" onClick={() => showPending("来源资料库正在迁移", "资料列表、处理状态和转为笔记的桌面链路尚未开放。")}/>
            <CatalogEntry icon={Sparkles} title="快速收录" detail="文本、Markdown、代码或链接" meta={home.captureState === "enabled" ? "后端允许" : "待授权"} state="pending" onClick={() => showPending("快速收录尚未接入桌面", home.captureState === "enabled" ? "后端已经确认当前身份可以收录资料，但桌面创建链路尚未开放。" : "当前身份或桌面合同尚未开放资料收录。")}/>
          </section>

          <section className="home-catalog-group" aria-labelledby="home-group-explore">
            <h2 id="home-group-explore">探索</h2>
            <CatalogEntry icon={Search} title="房内查找" detail="查当前公开目标与摘要" meta="可进入" state="ready" onClick={() => invoke("search")} />
            <CatalogEntry icon={SquareStack} title="学习卡" detail="目标库、版本与证据" state="pending" onClick={() => showPending("学习卡库正在迁移", "当前可以查看服务端主焦点；完整目标库、历史版本与证据浏览尚未接入桌面端。")}/>
            <CatalogEntry icon={Search} title="全局搜索" detail="笔记、来源与全部目标" state="pending" onClick={() => showPending("全局搜索正在迁移", "当前可用的是房内查找；完整的跨来源、笔记与目标搜索尚未接入桌面 IPC。")}/>
            <CatalogEntry icon={Orbit} title="理解星图" detail="来源、目标与证据关系" state="ready" onClick={() => invoke("graph")} />
            <CatalogEntry icon={CalendarDays} title="学习动态" detail="回看真实学习轨迹" state="pending" onClick={() => showPending("学习动态正在迁移", "当前投影没有稳定的活动账本数据；首页不会用本机记录拼出一条假时间线。")}/>
          </section>

          <section className="home-catalog-group" aria-labelledby="home-group-room">
            <h2 id="home-group-room">伴星与系统</h2>
            <CatalogEntry icon={MessageCircle} title="唤醒伴星" detail="打开当前 Live2D 伴星" state="ready" onClick={openCompanion} />
            <CatalogEntry icon={CalendarDays} title="伴星日记" detail="每日总结与历史日期" state="pending" onClick={() => showPending("伴星日记正在迁移", "日总结服务仍受功能门控，桌面端页面尚未开放。")}/>
            <CatalogEntry icon={UserRoundCog} title="伴星人格" detail="语气、关系与边界" state="pending" onClick={() => showPending("伴星人格正在迁移", "人格档案和关系边界会保留，桌面端设置页面尚未开放。")}/>
            <CatalogEntry icon={Orbit} title="记忆星图" detail="查看记忆之间的联系" state="pending" onClick={() => showPending("记忆星图正在迁移", "伴星记忆的真实拓扑接口尚未进入当前桌面合同。")}/>
            <CatalogEntry icon={BrainCircuit} title="伴星记忆" detail="查看、确认与管理记忆" state="pending" onClick={() => showPending("伴星记忆正在迁移", "记忆确认与管理页面尚未接入桌面端，首页不会展示本机推测的记忆。")}/>
            <CatalogEntry icon={Gauge} title="设置" detail="账户、工作区、隐私与数据" state="pending" onClick={() => showPending("桌面设置正在迁移", "账户、工作区、AI 数据政策和导入导出入口尚未接入当前桌面端。")}/>
          </section>
        </div>
      </div>

      <button
        type="button"
        className="rail-action rail-action--primary"
        onClick={runPrimary}
        disabled={loading}
        aria-label={`${home.primaryLabel}：${home.title}`}
        title={home.title}
        data-testid="action-continue"
        data-focus-return="continue"
      >
        <span className="rail-action__icon" aria-hidden="true"><BookOpenText size={21} strokeWidth={1.65} /></span>
        <span className="rail-action__copy"><strong>{home.primaryLabel}</strong><span>{home.title}</span></span>
        <ArrowRight className="rail-action__arrow" size={17} aria-hidden="true" />
      </button>
      <button type="button" className="rail-action rail-action--shortcut" onClick={openReview} aria-label={home.reviewLabel} data-testid="action-review" data-focus-return="review">
        <span className="rail-action__icon" aria-hidden="true"><CalendarCheck2 size={19} /></span><span className="rail-action__shortcut-copy"><strong>复习</strong><small>{home.dueCount === null ? "待同步" : `${home.dueCount} 项`}</small></span>
      </button>
      <button type="button" className="rail-action rail-action--shortcut" onClick={openNote} aria-label="打开当前研究册" data-focus-return="open-notebook">
        <span className="rail-action__icon" aria-hidden="true"><BookOpenText size={19} /></span><span className="rail-action__shortcut-copy"><strong>研究册</strong><small>{home.note ? "已定位" : "待书签"}</small></span>
      </button>
      <button type="button" className="rail-action rail-action--shortcut" onClick={() => invoke("search")} aria-label="在当前书房内容中查找" data-focus-return="search">
        <span className="rail-action__icon" aria-hidden="true"><Search size={19} /></span><span className="rail-action__shortcut-copy"><strong>查找</strong><small>房内范围</small></span>
      </button>
      <button
        ref={catalogToggleRef}
        type="button"
        className="rail-action rail-action--catalog"
        aria-label={catalogOpen ? "收起目录" : "全部功能"}
        aria-expanded={catalogOpen}
        aria-controls="home-catalog"
        onClick={() => catalogOpen ? closeCatalog() : openCatalog()}
      >
        <span className="rail-action__icon" aria-hidden="true">{catalogOpen ? <X size={19} /> : <House size={19} />}</span>
        <span className="rail-action__catalog-label">{catalogOpen ? "收起目录" : "全部功能"}</span>
        <span className="rail-action__catalog-label--compact" aria-hidden="true">{catalogOpen ? "收起" : "功能"}</span>
      </button>

    </nav>
  );
}
