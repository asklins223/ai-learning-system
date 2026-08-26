import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  CalendarCheck2,
  CornerDownLeft,
  FileSearch,
  Link2,
  RotateCcw,
  Search,
  Sparkles,
} from "lucide-react";
import { useRoomStore } from "../app/room-store";
import { createCommandId, createRequestMeta, gatewayErrorMessage, RendererGatewayError, unwrapGatewayResult } from "../app/desktop-client";
import { LearningRunPlayer } from "./LearningRunPlayer";
import { CardGenerationSurface } from "./CardGenerationSurface";
import { ReviewSurface } from "./surfaces/ReviewSurface";
import { StudySurface } from "./surfaces/StudySurface";
import {
  roomActionReasonLabel,
  studyActionDescription,
  studyActionLabel,
  studyStatusLabel,
} from "./surfaces/room-primary-action-presentation";
import type { DesktopRouteV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { NoteDetailV1, NoteBlockProjectionV1 } from "@ailearn/shared/note-projection-contracts";
import type { RoomProjectionV1 } from "@ailearn/shared/room-projection-contracts";

gsap.registerPlugin(useGSAP);

type ResolvedMotionMode = "full" | "lite" | "off";

function useResolvedMotionMode(): ResolvedMotionMode {
  const motionMode = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  return reducedMotion ? "off" : motionMode;
}

function PanelHeader({ title, detail }: { title: string; detail: string }) {
  const invoke = useRoomStore((state) => state.invoke);
  const surface = useRoomStore((state) => state.surface);
  const sceneLabel = surface === "card-generation"
    ? "卡片生成台"
    : surface === "notebook"
      ? "研究册"
      : surface === "review"
        ? "复习桌"
        : surface === "search"
          ? "书柜检索"
          : surface === "graph"
            ? "理解星图"
            : surface === "validation"
              ? "三分钟旅程"
              : surface === "card"
                ? "学习卡"
                : "书桌任务面";
  return (
    <header className="task-surface__header task-artifact task-artifact--header" data-surface={surface ?? "room"}>
      <span className="task-surface__paper-stack" aria-hidden="true" />
      <div className="task-surface__header-copy">
        <span className="task-surface__header-kicker"><span aria-hidden="true" />{sceneLabel}</span>
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
      <button className="surface-close" type="button" onClick={() => invoke("home")} aria-label="关闭任务面并返回房间" data-surface-initial-focus="true">
        <ArrowLeft size={17} aria-hidden="true" />
        <span>返回书房</span>
      </button>
    </header>
  );
}

async function navigateThroughMainResolver(route: DesktopRouteV1, learningRunId?: string): Promise<DesktopRouteV1> {
  if (!window.ailearn) throw new Error("desktop API is unavailable");
  const resolveResponse = await window.ailearn.navigation.resolve({
    meta: createRequestMeta(),
    route,
    ...(learningRunId ? { learningRunId } : {}),
  });
  const resolved = unwrapGatewayResult(resolveResponse);
  if (resolved.current.scope !== "workspace") throw new Error("navigation did not resolve to the current workspace");
  const goResponse = await window.ailearn.navigation.go({
    meta: createRequestMeta(resolved.current.workspaceEpoch),
    route: resolved.current.route,
    entryKind: "user",
    ...(learningRunId ? { learningRunId } : {}),
  });
  const navigated = unwrapGatewayResult(goResponse);
  if (navigated.current.scope !== "workspace") throw new Error("navigation did not commit to the current workspace");
  return navigated.current.route;
}

function noteText(blocks: NoteBlockProjectionV1[]): string {
  return blocks.map((block) => block.content).join("\n\n");
}

function paragraphBlocks(value: string): Array<{ type: "paragraph"; content: string }> {
  return value
    .split(/\n\s*\n/)
    .map((content) => content.trim())
    .filter(Boolean)
    .map((content) => ({ type: "paragraph" as const, content }));
}

function primaryNoteFromProjection(projection: RoomProjectionV1) {
  if (projection.primaryFocus.state !== "data") return null;
  return projection.primaryFocus.data.objective.sources.primaryNote;
}

function NotebookSurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveCardGenerationRunId = useRoomStore((state) => state.setActiveCardGenerationRunId);
  const activeNoteRef = useRoomStore((state) => state.activeNoteRef);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const epochRef = useRef<number | undefined>(undefined);
  const [note, setNote] = useState<NoteDetailV1 | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [selectedExcerpt, setSelectedExcerpt] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [startingGeneration, setStartingGeneration] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "committed" | "error">("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [generationCapability, setGenerationCapability] = useState<"unknown" | "allowed" | "disabled">("unknown");
  const [generationReason, setGenerationReason] = useState<string | null>(null);

  const loadNote = useCallback(async () => {
    if (!window.ailearn) {
      setFailure("桌面端 API 不可用，无法读取真实笔记。");
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailure(null);
    setGenerationCapability("unknown");
    try {
      const sessionResponse = await window.ailearn.auth.getState({ meta: createRequestMeta(epochRef.current) });
      if (sessionResponse.workspaceEpoch) epochRef.current = sessionResponse.workspaceEpoch;
      const session = unwrapGatewayResult(sessionResponse);
      if (session.status !== "authenticated" || !session.workspace) {
        throw new RendererGatewayError({ code: "auth_required", safeMessageKey: "error.auth_required", retry: "user_action" });
      }
      const projectionResponse = await window.ailearn.room.getProjection({ meta: createRequestMeta(session.workspaceEpoch) });
      if (projectionResponse.workspaceEpoch) epochRef.current = projectionResponse.workspaceEpoch;
      const primaryNote = primaryNoteFromProjection(unwrapGatewayResult(projectionResponse));
      const noteId = activeNoteRef?.noteId ?? primaryNote?.noteId;
      if (!noteId) {
        throw new Error("当前书房没有服务端确认的主笔记身份，不能编辑或生成学习卡。");
      }
      const noteResponse = await window.ailearn.note.get({ meta: createRequestMeta(epochRef.current), noteId });
      if (noteResponse.workspaceEpoch) epochRef.current = noteResponse.workspaceEpoch;
      const nextNote = unwrapGatewayResult(noteResponse);
      setNote(nextNote);
      setTitle(nextNote.title);
      setContent(noteText(nextNote.currentVersion.blocks));
      setSelectedExcerpt("");

      const capabilitiesResponse = await window.ailearn.capabilities.get({ meta: createRequestMeta(epochRef.current) });
      if (capabilitiesResponse.workspaceEpoch) epochRef.current = capabilitiesResponse.workspaceEpoch;
      const capabilities = unwrapGatewayResult(capabilitiesResponse);
      const routeAvailable = window.ailearn.contract.enabledRoutes.includes("note.detail") && window.ailearn.contract.enabledRoutes.includes("note.cardGeneration");
      const allowed = routeAvailable
        && capabilities.actionCapabilities["card_generation.start"] === "allowed"
        && capabilities.featureAvailability.card_generation_v2.state === "enabled";
      setGenerationCapability(allowed ? "allowed" : "disabled");
      setGenerationReason(allowed ? null : routeAvailable ? "当前工作区没有启用 Card Generation 能力。" : "当前桌面合同尚未开放 Note Card Generation 路由。");
    } catch (error) {
      setFailure(error instanceof Error && error.message.startsWith("当前书房") ? error.message : gatewayErrorMessage(error));
      setGenerationCapability("disabled");
    } finally {
      setLoading(false);
    }
  }, [activeNoteRef]);

  useEffect(() => {
    void loadNote();
  }, [loadNote]);

  const editable = Boolean(note?.permissions.canEdit && note.currentVersion.blocks.every((block) => block.type === "paragraph"));
  const dirty = Boolean(note && (title !== note.title || (editable && content !== noteText(note.currentVersion.blocks))));

  const captureSelection = () => {
    const editor = editorRef.current;
    if (!editor) return;
    setSelectedExcerpt(editor.value.slice(editor.selectionStart, editor.selectionEnd));
  };

  const save = async () => {
    if (!note || !note.permissions.canSave || saving || !window.ailearn || !dirty) return;
    setSaving(true);
    setSaveState("idle");
    setFailure(null);
    try {
      const response = await window.ailearn.note.save({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId("note-save"),
        noteId: note.noteId,
        request: {
          version: 1,
          title,
          ...(editable ? { blocks: paragraphBlocks(content) } : {}),
          baseVersionId: note.currentVersionId,
          isAutosave: false,
        },
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      setSaveState("committed");
      await loadNote();
    } catch (error) {
      setSaveState("error");
      setFailure(gatewayErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const startGeneration = async () => {
    if (!note || dirty || generationCapability !== "allowed" || startingGeneration || !window.ailearn) return;
    setStartingGeneration(true);
    setFailure(null);
    try {
      const response = await window.ailearn.note.cardGeneration.start({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId("card-generation-start"),
        noteId: note.noteId,
        request: {
          version: 2,
          noteVersionId: note.currentVersionId,
          sourceScope: { kind: "whole_note" },
          learningGoal: "understand",
          detailThreshold: "balanced",
          quantity: { kind: "adaptive", hardMaxCards: 8 },
          preferredStrategies: ["recall", "why"],
          clientRequestId: createCommandId("card-generation-request"),
        },
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const accepted = unwrapGatewayResult(response);
      setActiveCardGenerationRunId(accepted.runId);
      invoke("open-card-generation");
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
    } finally {
      setStartingGeneration(false);
    }
  };

  return (
    <>
      <PanelHeader title={note?.title || "研究册"} detail={note ? `服务端笔记 · 版本 ${note.currentVersion.versionNo}` : "读取服务端笔记身份"} />
      <div className="notebook-surface task-artifact task-artifact--notebook">
        {loading ? <div className="notebook-state" role="status"><BookOpenText size={26} aria-hidden="true" /><strong>正在读取真实笔记…</strong><p>先确认工作区、Note identity 与当前版本。</p></div> : null}
        {!loading && failure && !note ? <div className="notebook-state notebook-state--error" role="alert"><BookOpenText size={26} aria-hidden="true" /><strong>研究册暂时不可用</strong><p>{failure}</p><div className="surface-action-pair"><button type="button" className="surface-primary" onClick={() => void loadNote()}>重新读取</button><button type="button" className="text-action" onClick={() => invoke("validate")}>验证这段理解</button></div></div> : null}
        {!loading && note ? <>
          <div className="notebook-surface__meta">
            <span>服务端当前版本 · {note.currentVersion.versionId.slice(0, 8)}</span>
            <span role="status" aria-live="polite">{saving ? "正在提交…" : saveState === "committed" ? "服务端回执已确认" : saveState === "error" ? "提交未确认" : dirty ? "有未提交编辑" : "已同步"}</span>
          </div>
          <label className="notebook-title-field"><span>标题</span><input value={title} maxLength={200} disabled={!note.permissions.canEdit || saving} onChange={(event) => setTitle(event.target.value)} /></label>
          {editable ? <textarea ref={editorRef} value={content} onChange={(event) => setContent(event.target.value)} onSelect={captureSelection} onKeyUp={captureSelection} onPointerUp={captureSelection} aria-label="真实笔记内容" spellCheck /> : <div className="notebook-readonly" aria-label="真实笔记内容">{note.currentVersion.blocks.map((block) => <p key={`${block.ordinal}-${block.type}`}>{block.content}</p>)}</div>}
          <aside className="note-provenance-slip">
            <strong>来源版本</strong>
            <p>{note.sourceId ? "该笔记关联了服务端来源。" : "该笔记没有可公开的来源标签。"}</p>
            <small>生成范围：整篇笔记 · noteVersionId {note.currentVersionId.slice(0, 8)}</small>
          </aside>
          <div className="selection-preview" role="status" aria-live="polite">{selectedExcerpt ? <><span>已选内容</span><q>{selectedExcerpt}</q></> : <span>选择文字只用于阅读定位；Card Generation 使用服务端确认的整篇笔记版本。</span>}</div>
          <div className="notebook-actions">
            {note.permissions.canSave ? <button type="button" className="surface-secondary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "正在提交…" : "提交笔记编辑"}</button> : null}
            {generationCapability === "allowed" ? <button type="button" className="surface-primary" disabled={dirty || startingGeneration} onClick={() => void startGeneration()}><Sparkles size={17} aria-hidden="true" />{startingGeneration ? "正在创建生成任务…" : "根据整篇笔记生成学习卡"}</button> : null}
          </div>
          {generationReason ? <p className="notebook-capability-note">{generationReason}</p> : null}
          {failure && note ? <p className="notebook-inline-error" role="alert">{failure}</p> : null}
        </> : null}
      </div>
      <p className="prototype-note task-artifact task-artifact--provenance">笔记、保存回执与 Card Generation 均来自主进程合同；没有真实 identity 或回执时不会生成本机候选。</p>
    </>
  );
}

function LearningCardSurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const epochRef = useRef<number | undefined>(undefined);
  const [projection, setProjection] = useState<RoomProjectionV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  const loadProjection = useCallback(async () => {
    if (!window.ailearn) throw new Error("桌面端 API 不可用，无法读取真实学习目标。");
    const sessionResponse = await window.ailearn.auth.getState({ meta: createRequestMeta(epochRef.current) });
    if (sessionResponse.workspaceEpoch) epochRef.current = sessionResponse.workspaceEpoch;
    const session = unwrapGatewayResult(sessionResponse);
    if (session.status !== "authenticated" || !session.workspace) {
      throw new RendererGatewayError({ code: "auth_required", safeMessageKey: "error.auth_required", retry: "user_action" });
    }
    const projectionResponse = await window.ailearn.room.getProjection({ meta: createRequestMeta(session.workspaceEpoch) });
    if (projectionResponse.workspaceEpoch) epochRef.current = projectionResponse.workspaceEpoch;
    setProjection(unwrapGatewayResult(projectionResponse));
    setFailure(null);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadProjection()
      .catch((error) => active && setFailure(gatewayErrorMessage(error)))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [loadProjection]);

  const focus = projection?.primaryFocus.state === "data" ? projection.primaryFocus.data : null;
  const objective = focus?.objective ?? null;
  const action = focus?.action ?? null;
  const title = objective?.content.conceptLabel ?? objective?.sources.primaryNote?.title ?? "学习目标详情";
  const sourceLabel = objective?.content.sourceLabel ?? objective?.sources.primaryNote?.title ?? "来源标签未公开";
  const lifecycleLabel = objective ? {
    active: "活跃",
    archived: "已归档",
    superseded: "已被替代",
    blocked_content_upgrade: "等待内容更新",
  }[objective.lifecycle.status] : null;
  const knowledgeFormLabel = objective ? {
    fact: "事实",
    definition: "定义",
    relationship: "关系",
    comparison: "比较",
    sequence: "顺序",
    procedure: "步骤",
    causal_model: "因果模型",
    boundary: "边界",
    application_rule: "应用规则",
  }[objective.content.knowledgeForm] ?? objective.content.knowledgeForm : null;

  const reload = () => {
    setLoading(true);
    void loadProjection().catch((error) => setFailure(gatewayErrorMessage(error))).finally(() => setLoading(false));
  };

  return (
    <>
      <PanelHeader title={title} detail={objective ? `服务端 Objective · ${studyStatusLabel(objective)}` : "读取服务端 Objective projection"} />
      <div className="card-editor objective-detail task-artifact task-artifact--objective">
        {loading ? <div className="objective-detail__state" role="status"><BookOpenText size={26} aria-hidden="true" /><strong>正在读取真实学习目标…</strong><p>先确认身份、工作区与主焦点。</p></div> : null}
        {!loading && failure ? <div className="objective-detail__state objective-detail__state--error" role="alert"><BookOpenText size={26} aria-hidden="true" /><strong>学习目标暂时不可用</strong><p>{failure}</p><button type="button" className="surface-primary" onClick={reload}><RotateCcw size={16} aria-hidden="true" />重新读取</button></div> : null}
        {!loading && !failure && projection?.primaryFocus.state === "empty" ? <div className="objective-detail__state" role="status"><BookOpenText size={26} aria-hidden="true" /><strong>当前没有服务端主焦点</strong><p>桌面不会用本机草稿填充学习目标详情。</p><button type="button" className="surface-primary" onClick={reload}>重新读取</button></div> : null}
        {!loading && !failure && projection?.primaryFocus.state === "error" ? <div className="objective-detail__state objective-detail__state--error" role="alert"><BookOpenText size={26} aria-hidden="true" /><strong>主焦点读取未完成</strong><p>服务端 projection 暂时不可用，请稍后重试。</p><button type="button" className="surface-primary" onClick={reload}>重新读取</button></div> : null}
        {!loading && !failure && objective && action && lifecycleLabel && knowledgeFormLabel ? (
          <>
            <div className="objective-detail__main">
              <h3>{title}</h3>
              <p className="objective-detail__summary">{objective.content.publicSummary}</p>
              <blockquote>
                <strong>服务端主行动</strong>
                <span>{studyActionLabel(action.action)}</span>
                <small>{studyActionDescription(action.action)}</small>
              </blockquote>
            </div>
            <aside className="objective-detail__facts" aria-label="学习目标公开信息">
              <dl>
                <div><dt>来源</dt><dd>{sourceLabel}</dd></div>
                <div><dt>知识形态</dt><dd>{knowledgeFormLabel}</dd></div>
                <div><dt>生命周期</dt><dd>{lifecycleLabel}</dd></div>
                <div><dt>目标身份</dt><dd>{objective.objectiveId.slice(0, 8)}</dd></div>
              </dl>
              {roomActionReasonLabel(action) ? <p className="objective-detail__unavailable">{roomActionReasonLabel(action)}</p> : null}
              <div className="surface-action-pair">
                <button type="button" className="surface-primary" disabled={action.availability !== "available"} onClick={() => invoke("continue")}>{studyActionLabel(action.action)}<ArrowRight size={16} aria-hidden="true" /></button>
                {objective.sources.primaryNote ? <button type="button" className="surface-secondary" onClick={() => invoke("open-notebook")}><BookOpenText size={16} aria-hidden="true" />回研究册</button> : null}
                {action.action.kind === "refresh" ? <button type="button" className="text-action" onClick={reload}>重新读取 projection</button> : null}
              </div>
            </aside>
          </>
        ) : null}
      </div>
      <p className="prototype-note task-artifact task-artifact--provenance">详情只显示服务端公开 Objective projection；canonical answer、rubric 与完整证据不会进入桌面渲染边界。</p>
    </>
  );
}

type SearchProjectionItem = {
  id: string;
  title: string;
  meta: string;
  terms: string;
  focus: boolean;
};

function searchItemsFromProjection(projection: RoomProjectionV1): SearchProjectionItem[] {
  const items: SearchProjectionItem[] = [];
  const seen = new Set<string>();
  const append = (item: SearchProjectionItem) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  };
  if (projection.primaryFocus.state === "data") {
    const objective = projection.primaryFocus.data.objective;
    const title = objective.content.conceptLabel ?? objective.sources.primaryNote?.title ?? `学习目标 · ${objective.objectiveId.slice(0, 8)}`;
    const source = objective.content.sourceLabel ?? objective.sources.primaryNote?.title ?? "公开来源未标注";
    append({
      id: objective.objectiveId,
      title,
      meta: `主焦点 · ${source}`,
      terms: `${title} ${objective.content.publicSummary} ${source}`,
      focus: true,
    });
  }
  const appendSummaryItems = (section: RoomProjectionV1["queueSummary"] | RoomProjectionV1["recentObjectiveSummary"]) => {
    if (section.state !== "data") return;
    for (const item of section.data.items) {
      const title = item.conceptLabel ?? `学习目标 · ${item.objectiveId.slice(0, 8)}`;
      append({
        id: item.objectiveId,
        title,
        meta: `Objective · ${item.personalState}`,
        terms: `${title} ${item.publicSummary} ${item.personalState}`,
        focus: false,
      });
    }
  };
  appendSummaryItems(projection.queueSummary);
  appendSummaryItems(projection.recentObjectiveSummary);
  return items;
}

function SearchSurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const [query, setQuery] = useState("");
  const [projection, setProjection] = useState<RoomProjectionV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const epochRef = useRef<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const loadProjection = useCallback(async () => {
    if (!window.ailearn) throw new Error("桌面端 API 不可用，无法读取真实搜索范围。");
    const sessionResponse = await window.ailearn.auth.getState({ meta: createRequestMeta(epochRef.current) });
    if (sessionResponse.workspaceEpoch) epochRef.current = sessionResponse.workspaceEpoch;
    const session = unwrapGatewayResult(sessionResponse);
    if (session.status !== "authenticated" || !session.workspace) {
      throw new RendererGatewayError({ code: "auth_required", safeMessageKey: "error.auth_required", retry: "user_action" });
    }
    const projectionResponse = await window.ailearn.room.getProjection({ meta: createRequestMeta(session.workspaceEpoch) });
    if (projectionResponse.workspaceEpoch) epochRef.current = projectionResponse.workspaceEpoch;
    setProjection(unwrapGatewayResult(projectionResponse));
    setFailure(null);
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadProjection()
      .catch((error) => active && setFailure(gatewayErrorMessage(error)))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [loadProjection]);
  const searchItems = useMemo(() => projection ? searchItemsFromProjection(projection) : [], [projection]);
  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    return searchItems.filter((item) => `${item.title} ${item.meta} ${item.terms}`.toLowerCase().includes(normalized));
  }, [query, searchItems]);
  const visibleItems = query ? results : searchItems;
  const retry = () => {
    setLoading(true);
    void loadProjection().catch((error) => setFailure(gatewayErrorMessage(error))).finally(() => setLoading(false));
  };

  return (
    <>
      <PanelHeader title="在理解里查找" detail="只检索服务端公开 Objective 与来源标签" />
      <div className="search-surface task-artifact task-artifact--search-ledger">
        <label className="search-field">
          <Search size={19} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing || !results[0]) return;
              event.preventDefault();
              if (results[0].focus) invoke("continue");
            }}
            placeholder="输入概念、问题或来源…"
          />
          <kbd>↵</kbd>
        </label>
        {loading ? (
          <div className="surface-empty surface-empty--compact" role="status"><Search size={24} aria-hidden="true" /><h3>正在读取服务端搜索范围…</h3><p>先确认身份与 RoomProjection，再显示可检索的公开目标。</p></div>
        ) : failure ? (
          <div className="surface-empty surface-empty--compact" role="alert"><Search size={24} aria-hidden="true" /><h3>搜索范围暂时不可用</h3><p>{failure}</p><button type="button" className="surface-primary" onClick={retry}>重新读取</button></div>
        ) : query && !results.length ? (
          <div className="surface-empty surface-empty--compact" aria-live="polite">
            <Search size={24} aria-hidden="true" /><h3>没有找到“{query}”</h3><p>当前搜索只覆盖服务端公开 Objective；没有本机样本可以补齐结果。</p>
          </div>
        ) : !visibleItems.length ? (
          <div className="surface-empty surface-empty--compact" aria-live="polite"><Search size={24} aria-hidden="true" /><h3>当前没有可搜索的公开目标</h3><p>完成身份校验并由服务端提供主焦点后，这里才会出现真实结果。</p></div>
        ) : (
          <div className="shelf-catalog" aria-live="polite">
            <div className="shelf-catalog__heading">
              <strong>{query ? `与“${query}”有关` : "最近整理进书柜"}</strong>
              <span>{visibleItems.length} 份理解材料</span>
            </div>
            <div className="shelf-books" aria-label={query ? "搜索结果" : "最近整理的内容"}>
              {visibleItems.map((item, index) => (
                <button
                  type="button"
                  className={`shelf-book shelf-book--${index % 4}`}
                  key={item.title}
                  disabled={!item.focus}
                  onClick={() => { if (item.focus) invoke("continue"); }}
                >
                  <FileSearch size={17} aria-hidden="true" />
                  <span><strong>{item.title}</strong><small>{item.meta}{item.focus ? " · 可继续" : " · 仅供检索"}</small></span>
                  <CornerDownLeft size={15} aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <p className="prototype-note task-artifact task-artifact--provenance">搜索范围来自 RoomProjection 的公开 Objective 摘要；未接入的笔记全文、证据与关系索引不会被本机样本伪造。</p>
    </>
  );
}

function GraphSurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const motionMode = useResolvedMotionMode();
  const epochRef = useRef<number | undefined>(undefined);
  const [projection, setProjection] = useState<RoomProjectionV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const graphMotionRef = useRef<HTMLDivElement>(null);
  const loadProjection = useCallback(async () => {
    if (!window.ailearn) throw new Error("桌面端 API 不可用，无法读取理解拓扑的真实范围。");
    const sessionResponse = await window.ailearn.auth.getState({ meta: createRequestMeta(epochRef.current) });
    if (sessionResponse.workspaceEpoch) epochRef.current = sessionResponse.workspaceEpoch;
    const session = unwrapGatewayResult(sessionResponse);
    if (session.status !== "authenticated" || !session.workspace) {
      throw new RendererGatewayError({ code: "auth_required", safeMessageKey: "error.auth_required", retry: "user_action" });
    }
    const projectionResponse = await window.ailearn.room.getProjection({ meta: createRequestMeta(session.workspaceEpoch) });
    if (projectionResponse.workspaceEpoch) epochRef.current = projectionResponse.workspaceEpoch;
    setProjection(unwrapGatewayResult(projectionResponse));
    setFailure(null);
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadProjection()
      .catch((error) => active && setFailure(gatewayErrorMessage(error)))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [loadProjection]);
  useGSAP(() => {
    const nodes = graphMotionRef.current?.querySelectorAll<HTMLElement>(".graph-boundary__code-node");
    if (!nodes?.length) return;
    gsap.killTweensOf(nodes);
    gsap.set(nodes, {
      autoAlpha: motionMode === "off" ? 0.76 : 0.42,
      scale: motionMode === "off" ? 1 : 0.72,
      transformOrigin: "50% 50%",
    });
    if (motionMode === "off") return;
    const timeline = gsap.timeline({ repeat: motionMode === "full" ? -1 : 0, defaults: { ease: "sine.inOut" } });
    timeline.to(nodes, { autoAlpha: 0.95, scale: 1, duration: 1.15, stagger: 0.18 })
      .to(nodes, {
        autoAlpha: motionMode === "lite" ? 0.76 : 0.42,
        scale: motionMode === "lite" ? 1 : 0.72,
        duration: 1.35,
        stagger: 0.18,
      });
    return () => timeline.kill();
  }, { scope: graphMotionRef, dependencies: [motionMode] });
  const objective = projection?.primaryFocus.state === "data" ? projection.primaryFocus.data.objective : null;
  const title = objective?.content.conceptLabel ?? objective?.sources.primaryNote?.title ?? "理解星图";
  const retry = () => {
    setLoading(true);
    void loadProjection().catch((error) => setFailure(gatewayErrorMessage(error))).finally(() => setLoading(false));
  };
  return (
    <>
      <PanelHeader title="理解星图" detail="理解拓扑 · 等待服务端 understanding.graph 能力" />
      <div className="graph-boundary task-artifact task-artifact--graph-projection" role={failure ? "alert" : "status"}>
        <div ref={graphMotionRef} className="graph-boundary__code-motion" aria-hidden="true">
          <span className="graph-boundary__code-orbit" />
          <span className="graph-boundary__code-node graph-boundary__code-node--one" />
          <span className="graph-boundary__code-node graph-boundary__code-node--two" />
          <span className="graph-boundary__code-node graph-boundary__code-node--three" />
        </div>
        <Link2 size={31} aria-hidden="true" />
        {loading ? <><h3>正在读取真实理解拓扑…</h3><p>先确认身份、工作区与当前主焦点。</p></> : null}
        {!loading && failure ? <><h3>理解拓扑暂时不可用</h3><p>{failure}</p></> : null}
        {!loading && !failure ? <><h3>真实理解拓扑尚未接入桌面</h3><p>当前窗口只拿到了 Objective projection；关系、节点与 lens 必须来自 understanding.graph 服务端合同，桌面不会用本机关系图填充。</p>{objective ? <div className="graph-boundary__focus"><strong>当前服务端主焦点</strong><span>{title}</span></div> : null}</> : null}
        {!loading ? <div className="surface-action-pair"><button type="button" className="surface-primary" onClick={retry}><RotateCcw size={16} aria-hidden="true" />重新读取</button>{objective ? <button type="button" className="text-action" onClick={() => invoke("continue")}>回到继续学习</button> : null}</div> : null}
      </div>
      <p className="prototype-note task-artifact task-artifact--provenance">理解星图只在服务端拓扑合同可用时渲染节点与关系；当前安全状态不包含本机示例数据。</p>
    </>
  );
}

function ValidationSurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const activeRunId = useRoomStore((state) => state.activeRunId);
  const clearActiveRun = useRoomStore((state) => state.setActiveRunId);
  const setNavigationGuard = useRoomStore((state) => state.setNavigationGuard);
  const handleRunExit = useCallback(async (runId: string) => {
    // Remove the sensitive Player tree before asking main to resolve the
    // return route. Main may then complete FormalAssessmentGuard release only
    // after the renderer has yielded a frame with the task context unmounted.
    clearActiveRun(null);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    let resolvedRoute: DesktopRouteV1 = { kind: "review.queue" };
    try {
      resolvedRoute = await navigateThroughMainResolver({ kind: "review.queue" }, runId);
    } catch {
      // A deleted, forbidden, disabled, or otherwise unresolvable server target
      // must not be replayed by the renderer. Resolve the current Room route
      // through main as the single safe fallback.
      try {
        resolvedRoute = await navigateThroughMainResolver({ kind: "room.home" });
      } catch {
        resolvedRoute = { kind: "room.home" };
      }
    }
    invoke(resolvedRoute.kind === "review.queue" ? "review" : "home");
  }, [clearActiveRun, invoke]);

  useEffect(() => {
    if (!activeRunId) {
      setNavigationGuard(null);
      return;
    }
    const runId = activeRunId;
    setNavigationGuard(() => { void handleRunExit(runId); });
    return () => setNavigationGuard(null);
  }, [activeRunId, handleRunExit, setNavigationGuard]);

  return (
    <>
      <PanelHeader title="三分钟学习旅程" detail="LearningRun · 只显示服务端公开任务与真实结果" />
      {activeRunId ? (
        <LearningRunPlayer runId={activeRunId} onExit={() => { void handleRunExit(activeRunId); }} />
      ) : (
        <div className="run-entry-block task-artifact task-artifact--validation-sheet">
          <span className="run-entry-block__mark"><CalendarCheck2 size={20} aria-hidden="true" /></span>
          <h3>请从真实复习队列开始</h3>
          <p>这个表面不再根据回答长度本地评分。先读取服务端确认的到期项，再由 LearningRun 冻结目标、接收答案并返回可信结果。</p>
          <button className="surface-primary" type="button" onClick={() => invoke("review")}>打开今日复习队列<ArrowRight size={17} aria-hidden="true" /></button>
          <p className="prototype-note">如果队列或服务不可用，页面会停在安全状态，不会生成假结果。</p>
        </div>
      )}
    </>
  );
}

function fallbackIntentForSurface(surface: NonNullable<ReturnType<typeof useRoomStore.getState>["surface"]>) {
  if (surface === "review") return "review";
  if (surface === "search") return "search";
  if (surface === "graph") return "graph";
  return "continue";
}

export function TaskSurface() {
  const surface = useRoomStore((state) => state.surface);
  const motionMode = useResolvedMotionMode();
  const [renderedSurface, setRenderedSurface] = useState(surface);
  const [transition, setTransition] = useState<"entering" | "entered" | "leaving">(surface ? "entering" : "entered");
  const surfaceRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<{ element: HTMLElement; fallbackSelector: string } | null>(null);
  const lastSurfaceRef = useRef(surface);

  useEffect(() => {
    if (surface && !renderedSurface) {
      setRenderedSurface(surface);
      setTransition("entering");
    }
  }, [renderedSurface, surface]);

  useEffect(() => {
    if (surface) {
      lastSurfaceRef.current = surface;
      if (!returnFocusRef.current && document.activeElement instanceof HTMLElement) {
        const element = document.activeElement;
        const fallbackIntent = fallbackIntentForSurface(surface);
        returnFocusRef.current = {
          element,
          fallbackSelector: `[data-focus-return="${element.dataset.focusReturn ?? fallbackIntent}"]`,
        };
      }
    }
  }, [surface]);

  useEffect(() => {
    if (renderedSurface) {
      if (renderedSurface !== surface || transition !== "entered") return;
      const frame = window.requestAnimationFrame(() => {
        const selector = renderedSurface === "search"
          ? ".search-field input"
          : renderedSurface === "review"
            ? "[data-review-return-focus='true'], [data-surface-initial-focus], .surface-close"
            : "[data-surface-initial-focus], .surface-close";
        surfaceRef.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
      });
      return () => window.cancelAnimationFrame(frame);
    }

    const lastSurface = lastSurfaceRef.current;
    if (!lastSurface) return;
    const returnFocus = returnFocusRef.current;
    const fallbackSelector = returnFocus?.fallbackSelector ?? `[data-focus-return="${fallbackIntentForSurface(lastSurface)}"]`;
    returnFocusRef.current = null;
    lastSurfaceRef.current = null;
    window.requestAnimationFrame(() => {
      const element = returnFocus?.element;
      const canRestoreElement = element
        && element.isConnected
        && element !== document.body
        && element !== document.documentElement
        && !element.closest("[inert], [aria-hidden='true']");
      const target = canRestoreElement ? element : document.querySelector<HTMLElement>(fallbackSelector);
      target?.focus();
    });
  }, [renderedSurface, surface, transition]);

  useGSAP(
    (_context, contextSafe) => {
      const root = surfaceRef.current;
      if (!root || !renderedSurface) return;

      const content = root.querySelector<HTMLElement>(".surface-content");
      const header = root.querySelector<HTMLElement>(".task-artifact--header");
      const artifacts = root.querySelectorAll<HTMLElement>(".task-artifact:not(.task-artifact--header)");
      const allAnimated = [content, header, ...artifacts].filter((target): target is HTMLElement => Boolean(target));
      const lite = motionMode === "lite";
      const isObjectSurface = renderedSurface === "study" || renderedSurface === "review";

      if (surface !== renderedSurface) {
        setTransition("leaving");
        const finishExit = contextSafe?.(() => {
          setRenderedSurface(surface);
          setTransition(surface ? "entering" : "entered");
        }) ?? (() => {
          setRenderedSurface(surface);
          setTransition(surface ? "entering" : "entered");
        });

        if (motionMode === "off") {
          gsap.set(allAnimated, { autoAlpha: 0 });
          finishExit();
          return;
        }

        const exitTimeline = gsap.timeline({
          defaults: {
            duration: lite ? 0.14 : 0.25,
            ease: "power2.in",
          },
          onComplete: finishExit,
        });
        if (artifacts.length) {
          exitTimeline.to(
            artifacts,
            {
              autoAlpha: 0,
              y: lite ? 4 : 13,
              scale: lite ? 1 : 0.99,
              stagger: lite ? 0 : { each: 0.025, from: "end" },
            },
            0,
          );
        }
        if (header) {
          exitTimeline.to(header, { autoAlpha: 0, y: lite ? -3 : -9 }, 0);
        }
        if (content) {
          exitTimeline.to(content, { autoAlpha: 0, scale: lite ? 1 : 0.992 }, lite ? 0.04 : 0.1);
        }
        return;
      }

      setTransition("entering");
      const finishEnter = contextSafe?.(() => setTransition("entered")) ?? (() => setTransition("entered"));
      if (motionMode === "off") {
        gsap.set(allAnimated, { autoAlpha: 1, clearProps: "transform" });
        finishEnter();
        return;
      }

      const enterTimeline = gsap.timeline({
        defaults: {
          duration: lite ? 0.2 : 0.46,
          ease: "power3.out",
        },
        onComplete: finishEnter,
      });
      enterTimeline.addLabel("artifact-rise", 0);
      if (content) {
        enterTimeline.fromTo(
          content,
          { autoAlpha: 0, y: lite ? 5 : 18, scale: lite ? 1 : 0.988 },
          { autoAlpha: 1, y: 0, scale: 1 },
          "artifact-rise",
        );
      }
      if (header) {
        enterTimeline.fromTo(
          header,
          { autoAlpha: 0, y: lite ? -4 : -12 },
          { autoAlpha: 1, y: 0, duration: lite ? 0.16 : 0.34 },
          "artifact-rise",
        );
      }
      if (artifacts.length && isObjectSurface) {
        const studyEntrance = renderedSurface === "study";
        enterTimeline.fromTo(
          artifacts,
          studyEntrance
            ? {
                autoAlpha: 0,
                y: lite ? 6 : 26,
                scale: lite ? 1 : 0.955,
                rotateX: lite ? 0 : -3.2,
                transformOrigin: "50% 100%",
                clipPath: lite ? "inset(0% 0% 0% 0% round 0px)" : "inset(7% 2% 0% 2% round 28px)",
              }
            : {
                autoAlpha: 0,
                x: lite ? -5 : -22,
                y: lite ? 5 : 18,
                scale: lite ? 1 : 0.97,
                rotateZ: lite ? 0 : -1.2,
                transformOrigin: "20% 100%",
                clipPath: lite ? "inset(0% 0% 0% 0% round 0px)" : "inset(0% 7% 5% 4% round 24px)",
              },
          {
            autoAlpha: 1,
            x: 0,
            y: 0,
            scale: 1,
            rotateX: 0,
            rotateZ: 0,
            clipPath: "inset(0% 0% 0% 0% round 0px)",
            duration: lite ? 0.18 : studyEntrance ? 0.52 : 0.47,
          },
          lite ? "artifact-rise" : "artifact-rise+=0.05",
        );
      } else if (artifacts.length) {
        enterTimeline.fromTo(
          artifacts,
          { autoAlpha: 0, y: lite ? 6 : 22, scale: lite ? 1 : 0.982 },
          {
            autoAlpha: 1,
            y: 0,
            scale: 1,
            duration: lite ? 0.18 : 0.42,
            stagger: lite ? 0 : 0.055,
          },
          lite ? "artifact-rise" : "artifact-rise+=0.08",
        );
      }
    },
    {
      scope: surfaceRef,
      dependencies: [renderedSurface, surface],
      revertOnUpdate: true,
    },
  );

  if (!renderedSurface) return null;

  return (
    <section
      ref={surfaceRef}
      className={`task-surface task-surface--spatial task-surface--${renderedSurface}`}
      data-surface={renderedSurface}
      data-transition={transition}
      data-motion-mode={motionMode}
      role="region"
      aria-label="当前学习任务"
      aria-hidden={transition === "leaving" || undefined}
      inert={transition === "leaving" || undefined}
      tabIndex={-1}
    >
      <div className="surface-content task-surface__spatial-layer" key={renderedSurface}>
        {renderedSurface === "study" ? <StudySurface /> : null}
        {renderedSurface === "notebook" ? <NotebookSurface /> : null}
        {renderedSurface === "card" ? <LearningCardSurface /> : null}
        {renderedSurface === "card-generation" ? <CardGenerationSurface /> : null}
        {renderedSurface === "review" ? <ReviewSurface /> : null}
        {renderedSurface === "search" ? <SearchSurface /> : null}
        {renderedSurface === "graph" ? <GraphSurface /> : null}
        {renderedSurface === "validation" ? <ValidationSurface /> : null}
      </div>
    </section>
  );
}
