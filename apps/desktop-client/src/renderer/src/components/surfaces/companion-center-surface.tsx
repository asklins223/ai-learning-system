import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, RotateCcw, Search, Sparkles, X } from "lucide-react";
import type { GatewayResultV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type {
  CompanionConversationListV1,
  CompanionDailyFactsV1,
  CompanionDailySummaryV1,
  CompanionMemoryListV1,
  CompanionPersonaProfileV1,
  CompanionPersonaPresetV1,
  CompanionPersonaV1,
} from "@ailearn/shared/companion-memory-desktop-contracts";
import {
  companionPersonaPatchFromPreset,
  companionPersonaPatchFromProfile,
} from "@ailearn/shared/companion-memory-desktop-contracts";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../../app/desktop-client";
import { HudPage } from "../hud/HudPage";
import { useHudPage } from "../hud/use-hud-page";
import { diaryDayLabel, diaryDayStrip, shiftIsoDate, todayIsoDate } from "./companion-diary-day";
import {
  MEMORY_FAMILIES,
  curveControlPoint,
  entityTypeLabel,
  memoryFamilyOf,
  memoryKindLabel,
  memoryScopeLabel,
  memorySourceLabel,
  memoryStateLabel,
  plotMemoryStars,
  skyDust,
  starLabel,
  type MemoryState,
  type MemoryView,
  type TrailState,
} from "./companion-star-trail";
import { SurfaceDataState, formatDate, formatRelative, useSurfaceProjection } from "./surface-data";

/**
 * Page 20 — the companion centre.
 *
 * The mockup draws one card of shared records beside a field of memory stars.
 * Both halves read real records: the card switches between the four families of
 * shared history (conversations, diary, memories, persona), and the field plots
 * the memories the companion has actually written, with the ones still waiting
 * for confirmation drawn as hollow stars.
 *
 * The two halves are one instrument, not two panels: the state legend on the sky
 * and the state chips in the memory list are the same filter, and a band on the
 * bottom strip filters the record list by the family of memory it stands for.
 * Filtering only dims stars — it never re-plots them — so a star that moved
 * always means the memory changed, never that the view did.
 *
 * Every section reads on its own. A workspace with the diary switched off still
 * gets its star trail; a section that fails says so inside the card, with its own
 * retry, instead of blanking the page; and nothing here invents a record to fill
 * a gap.
 */

const TABS = [
  ["dialogue", "对话"],
  ["diary", "日记"],
  ["memory", "记忆"],
  ["persona", "人格"],
] as const;

type TabId = (typeof TABS)[number][0];

/** One filter drives the sky legend and the memory list, so they cannot disagree. */
type MemoryFilter = "all" | TrailState | "archived";

type FamilyFilter = "all" | (typeof MEMORY_FAMILIES)[number]["id"];

type MemoryAction = "confirm" | "pin" | "unpin" | "archive" | "restore" | "remove";

type PersonaAction = "preset" | "activeness" | "boundary" | "reset";

/** The decisions that are legal for each state, in the order the card offers them. */
const MEMORY_ACTIONS: Record<MemoryState, ReadonlyArray<{ action: MemoryAction; label: string; tone: "primary" | "plain" | "danger" }>> = {
  candidate: [
    { action: "confirm", label: "确认写入", tone: "primary" },
    { action: "remove", label: "忽略", tone: "danger" },
  ],
  pinned: [
    { action: "unpin", label: "取消固定", tone: "plain" },
    { action: "archive", label: "归档", tone: "plain" },
    { action: "remove", label: "删除", tone: "danger" },
  ],
  active: [
    { action: "pin", label: "固定", tone: "primary" },
    { action: "archive", label: "归档", tone: "plain" },
    { action: "remove", label: "删除", tone: "danger" },
  ],
  archived: [
    { action: "restore", label: "恢复", tone: "primary" },
    { action: "remove", label: "删除", tone: "danger" },
  ],
};

/**
 * The four sky legend entries and the five list chips read as one vocabulary.
 * 已归档 can only be reached from the list, because archived records are the one
 * state the trail deliberately leaves off the plate.
 */
const STATE_FILTERS: ReadonlyArray<{ id: MemoryFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "candidate", label: "待确认" },
  { id: "pinned", label: "已固定" },
  { id: "active", label: "进行中" },
  { id: "archived", label: "已归档" },
];

const ACTIVE_NESS_LABEL: Record<string, string> = {
  quiet: "安静",
  moderate: "适度",
  active: "活跃",
};

const ACTIVE_NESS_ITEMS = [
  ["quiet", "安静", "只在被你叫到时开口"],
  ["moderate", "适度", "关键节点提醒一句"],
  ["active", "活跃", "主动陪你推进学习"],
] as const;

const DAILY_FACT_LABEL: Record<keyof CompanionDailyFactsV1, string> = {
  notesCreated: "新建笔记",
  notesUpdated: "更新笔记",
  cardsCreated: "生成学习卡",
  sourcesCreated: "采集来源",
  jobsCreated: "发起后台任务",
  jobsCompleted: "完成任务",
  learningRunsCreated: "开始测评",
  learningRunsCompleted: "完成测评",
  pageContexts: "到访页面",
  conversationMessages: "对话消息",
  userMessages: "你说的话",
  assistantMessages: "伴星回复",
};

/**
 * The 人格 tab's three switches. They sit in a three-column grid, so the labels
 * stay short enough to read whole — the section heading already says 边界.
 */
const BOUNDARY_ITEMS = [
  ["allowPlayful", "玩笑", "允许伴星在日常里开玩笑"],
  ["allowNudgeLearning", "学习提醒", "允许它提醒你该复习了"],
  ["allowVoiceTags", "语气标签", "允许它标注自己说话的语气"],
] as const;

/** A section that failed is reported where it belongs instead of failing the page. */
type Section<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

async function readSection<T>(pending: Promise<GatewayResultV1<T>>): Promise<Section<T>> {
  try {
    return { ok: true, value: unwrapGatewayResult(await pending) };
  } catch (error) {
    return { ok: false, message: gatewayErrorMessage(error) };
  }
}

export function CompanionCenterSurface() {
  useHudPage("companion");
  const [tab, setTab] = useState<TabId>("dialogue");
  const [memoryFilter, setMemoryFilter] = useState<MemoryFilter>("all");
  const [familyFilter, setFamilyFilter] = useState<FamilyFilter>("all");
  const [query, setQuery] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [busy, setBusy] = useState<MemoryAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [diaryDate, setDiaryDate] = useState<string | null>(null);
  const [expandedConversationId, setExpandedConversationId] = useState<string | null>(null);
  const [conversationOrder, setConversationOrder] = useState<"recent" | "oldest">("recent");
  const [personaBusy, setPersonaBusy] = useState<PersonaAction | null>(null);
  const [personaError, setPersonaError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  /**
   * Scrolling to a record has to wait for the memory tab to render, so the
   * request is a token plus an id rather than a `requestAnimationFrame`.
   */
  const pendingScroll = useRef({ id: "", token: 0 });
  const [scrollToken, setScrollToken] = useState(0);
  const recordScrollRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const { data, loading, failure, reload, epochRef } = useSurfaceProjection(async ({ workspaceEpoch }) => {
    const meta = () => createRequestMeta(workspaceEpoch);
    // Four independent reads: the star trail must survive a diary that is
    // switched off, and the card must survive a star map that is switched off.
    // The diary is read separately, below, because it is addressed by day.
    const [starMap, memories, persona, conversations] = await Promise.all([
      readSection(window.ailearn.companion.memory.starMap({ meta: meta() })),
      readSection(window.ailearn.companion.memory.list({
        meta: meta(),
        query: { includeCandidates: true, includeArchived: true },
      })),
      readSection(window.ailearn.companion.persona.get({ meta: meta() })),
      readSection(window.ailearn.companion.conversations.list({ meta: meta(), limit: 20 })),
    ]);
    return { starMap, memories, persona, conversations };
  });

  /**
   * The diary owns its own read: it is addressed by a calendar day, so stepping
   * the day is a new read of the same section rather than a reload of the page.
   * `null` asks the server for the most recent day it actually wrote.
   */
  const diary = useSurfaceProjection(
    async ({ workspaceEpoch }) => readSection(window.ailearn.companion.daily.get({
      meta: createRequestMeta(workspaceEpoch),
      date: diaryDate ?? undefined,
    })),
    [diaryDate],
  );

  const memories = data?.memories.ok ? data.memories.value : null;
  const starMap = data?.starMap.ok ? data.starMap.value : null;
  const persona = data?.persona.ok ? data.persona.value : null;

  /**
   * The trail and the list describe the same records from two sides, so they are
   * merged once here: the star map owns provenance and the pinned/active split,
   * the list owns scores, scope and the records the trail deliberately omits.
   */
  const views = useMemo<readonly MemoryView[]>(() => {
    const byId = new Map<string, MemoryView>();
    for (const node of starMap?.nodes ?? []) {
      byId.set(node.memoryId, {
        id: node.memoryId,
        content: node.content,
        kind: node.kind,
        state: node.state,
        importance: null,
        confidence: null,
        scope: null,
        sourceType: null,
        updatedAt: null,
        createdAt: null,
        links: node.entityLinks,
        onTrail: true,
      });
    }
    for (const item of memories?.items ?? []) {
      const existing = byId.get(item.memoryItemId);
      const state: MemoryState = item.archived
        ? "archived"
        : item.candidate
          ? "candidate"
          : item.pinned
            ? "pinned"
            : "active";
      byId.set(item.memoryItemId, {
        id: item.memoryItemId,
        content: item.content,
        kind: item.kind,
        state,
        importance: item.importance,
        confidence: item.confidence,
        scope: item.scope,
        sourceType: item.sourceType,
        updatedAt: item.updatedAt,
        createdAt: item.createdAt,
        links: existing?.links ?? [],
        // Archived records leave the trail; everything else is plotted, whether
        // the star map already knows about it (written) or not (a candidate).
        onTrail: !item.archived,
      });
    }
    return [...byId.values()];
  }, [memories, starMap]);

  const trail = useMemo(() => views.filter((view) => view.onTrail), [views]);
  const candidates = useMemo(() => trail.filter((view) => view.state === "candidate"), [trail]);

  /** One predicate for both halves of the page: state × family × the search box. */
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (view: MemoryView): boolean => {
      if (memoryFilter !== "all" && view.state !== memoryFilter) return false;
      if (familyFilter !== "all" && MEMORY_FAMILIES[memoryFamilyOf(view.kind)].id !== familyFilter) return false;
      if (needle && !view.content.toLowerCase().includes(needle)) return false;
      return true;
    };
  }, [familyFilter, memoryFilter, query]);

  const mutedIds = useMemo(
    () => new Set(views.filter((view) => !matches(view)).map((view) => view.id)),
    [matches, views],
  );

  const counts = useMemo(() => ({
    all: views.filter((view) => view.state !== "archived").length,
    candidate: views.filter((view) => view.state === "candidate").length,
    pinned: views.filter((view) => view.state === "pinned").length,
    active: views.filter((view) => view.state === "active").length,
    archived: views.filter((view) => view.state === "archived").length,
  }), [views]);

  const focus = useMemo(() => {
    if (focusId) {
      const chosen = views.find((view) => view.id === focusId);
      if (chosen) return chosen;
    }
    return candidates[0]
      ?? trail.find((view) => view.state === "pinned")
      ?? trail[0]
      ?? views[0]
      ?? null;
  }, [candidates, focusId, trail, views]);

  const focusMemory = (memoryId: string) => {
    setFocusId(memoryId);
    setConfirmRemove(false);
    setActionError(null);
  };

  /**
   * A record the current conditions hide is still a record the user asked
   * about, so the card is allowed to show it, but the conditions are what the
   * list is about: following a record into the list retunes the state filter,
   * the family filter and the search box instead of fighting them.
   */
  const revealConditions = (view: MemoryView) => {
    if (memoryFilter !== "all" && view.state !== memoryFilter) setMemoryFilter("all");
    if (familyFilter !== "all" && MEMORY_FAMILIES[memoryFamilyOf(view.kind)].id !== familyFilter) {
      setFamilyFilter("all");
    }
    const needle = query.trim().toLowerCase();
    if (needle && !view.content.toLowerCase().includes(needle)) setQuery("");
  };

  const focusFromTrail = (memoryId: string) => {
    focusMemory(memoryId);
    const view = views.find((item) => item.id === memoryId);
    if (view) revealConditions(view);
  };

  const runAction = async (action: MemoryAction, memoryId: string) => {
    if (busy) return;
    setBusy(action);
    setActionError(null);
    try {
      const meta = () => createRequestMeta(epochRef.current);
      switch (action) {
        case "confirm":
          await window.ailearn.companion.memory.confirm({ meta: meta(), memoryId });
          break;
        case "pin":
          await window.ailearn.companion.memory.pin({ meta: meta(), memoryId });
          break;
        case "unpin":
          await window.ailearn.companion.memory.unpin({ meta: meta(), memoryId });
          break;
        case "archive":
          await window.ailearn.companion.memory.archive({ meta: meta(), memoryId });
          break;
        case "restore":
          await window.ailearn.companion.memory.restore({ meta: meta(), memoryId });
          break;
        case "remove":
          await window.ailearn.companion.memory.remove({ meta: meta(), memoryId });
          break;
      }
      setConfirmRemove(false);
      // One write, one reread: the trail and the counts are re-derived from the
      // server rather than patched locally into a shape the server never sent.
      await reload();
    } catch (error) {
      setActionError(gatewayErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Persona writes follow the same rule as memory verdicts: one write, one
   * reread. The request body is always the whole profile, because the server
   * replaces every field it is sent rather than merging what changed.
   */
  const runPersona = async (action: PersonaAction, request: () => Promise<unknown>) => {
    if (personaBusy) return;
    setPersonaBusy(action);
    setPersonaError(null);
    try {
      await request();
      setConfirmReset(false);
      await reload();
    } catch (error) {
      setPersonaError(gatewayErrorMessage(error));
    } finally {
      setPersonaBusy(null);
    }
  };

  const applyPreset = (preset: CompanionPersonaPresetV1) => void runPersona("preset", () =>
    window.ailearn.companion.persona.patch({
      meta: createRequestMeta(epochRef.current),
      request: companionPersonaPatchFromPreset(preset, persona?.profile?.revision),
    }));

  const setActiveness = (activeness: CompanionPersonaProfileV1["activeness"]) => {
    if (!persona?.profile) return;
    void runPersona("activeness", () => window.ailearn.companion.persona.patch({
      meta: createRequestMeta(epochRef.current),
      request: companionPersonaPatchFromProfile(persona.profile!, { activeness }),
    }));
  };

  const toggleBoundary = (key: (typeof BOUNDARY_ITEMS)[number][0]) => {
    const profile = persona?.profile;
    if (!profile) return;
    const current = profile.boundaries[key];
    void runPersona("boundary", () => window.ailearn.companion.persona.patch({
      meta: createRequestMeta(epochRef.current),
      request: companionPersonaPatchFromProfile(profile, {
        boundaries: { ...profile.boundaries, [key]: current === true ? false : true },
      }),
    }));
  };

  const resetPersona = () => void runPersona("reset", () =>
    window.ailearn.companion.persona.reset({ meta: createRequestMeta(epochRef.current) }));

  const companionName = persona?.profile?.name ?? persona?.activePreset?.name ?? "Mao";

  /**
   * The card's closing line counts the section the reader is in, not the whole
   * archive: memory totals over the dialogue list read as a misplaced footnote.
   * Every figure here is already held by a section that rendered above — no new
   * read, and a failed section says so in its own words. Empty while the page
   * itself is still empty; the JSX only reads it once `data` exists.
   */
  const recordFoot = !data ? "" : (() => {
    if (tab === "dialogue") {
      if (!data.conversations.ok) return "对话记录当前不可用";
      const items = data.conversations.value.items;
      const base = items.length === 0
        ? "还没有对话记录"
        : data.conversations.value.nextCursor
          ? `最近 ${items.length} 段对话 · 更早的尚未加载`
          : `共 ${items.length} 段对话`;
      return persona?.profile ? `${base} · 累计互动 ${persona.profile.interactionCount} 次` : base;
    }
    if (tab === "diary") {
      if (diary.data && diary.data.ok) {
        const daily = diary.data.value;
        if (daily.status === "generated" && daily.date) {
          const factCount = Object.values(daily.facts)
            .reduce((sum, count) => sum + (typeof count === "number" ? count : 0), 0);
          return `${diaryDayLabel(daily.date)} · 记下 ${factCount} 件事`;
        }
        return `${diaryDayLabel(daily.date ?? todayIsoDate())}还没有日记`;
      }
      return diary.failure ? "日记当前不可用" : "正在读取日记";
    }
    if (tab === "memory") {
      return memories
        ? `共 ${views.length} 条记忆 · ${candidates.length} 条待确认`
        : "记忆列表当前不可用";
    }
    return persona ? `人格预设 ${persona.presets.length} 套` : "人格档案当前不可用";
  })();
  /**
   * The card speaks for the section it is showing: a headline about looking
   * back over the trail made no sense over the dialogue list or the persona
   * settings. Only the memory section tracks the records — a candidate count
   * is the one line that must rise above any fixed copy.
   */
  const headline = tab === "dialogue"
    ? "你们说过的每一句话。"
    : tab === "diary"
      ? "伴星把一天写成日记。"
      : tab === "persona"
        ? "她的性格与边界。"
        : candidates.length > 0
          ? `${candidates.length} 条记忆等你确认`
          : trail.length > 0
            ? "今晚想回看哪段经历？"
            : "还没有可以回看的经历";

  const scrollToRecord = (memoryId: string) => {
    if (!memoryId) return;
    pendingScroll.current = { id: memoryId, token: pendingScroll.current.token + 1 };
    setScrollToken(pendingScroll.current.token);
  };

  const revealHidden = (ids: readonly string[]) => {
    setTab("memory");
    setMemoryFilter("all");
    setFamilyFilter("all");
    setQuery("");
    scrollToRecord(ids[0] ?? "");
  };

  const openMemoryInList = (memoryId: string) => {
    // The same retune the trail applies: a diary link into a memory the current
    // conditions would hide must still land on its row, not scroll to nothing.
    const view = views.find((item) => item.id === memoryId);
    if (view) revealConditions(view);
    setTab("memory");
    focusMemory(memoryId);
    scrollToRecord(memoryId);
  };

  useEffect(() => {
    const { id } = pendingScroll.current;
    if (tab !== "memory" || !id) return;
    const row = recordScrollRef.current?.querySelector<HTMLElement>(`[data-memory-id="${id}"]`);
    row?.scrollIntoView({ block: "center" });
    // `views` is in the deps because a record only has a row once the list has
    // been reread after the write that produced it.
  }, [tab, views, scrollToken]);

  /** Arrow keys move between the four record families, as a tablist should. */
  const onTabKeyDown = (event: React.KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const jump = event.key === "Home" ? -index : event.key === "End" ? TABS.length - 1 - index : 0;
    const delta = step || jump;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + TABS.length) % TABS.length;
    setTab(TABS[next][0]);
    tabRefs.current[next]?.focus();
  };

  return (
    <HudPage page="companion">
      {loading && !data ? (
        <SurfaceDataState kind="loading" message="正在读取伴星档案" detail="共同记录与记忆星轨都来自当前工作区的真实数据。" />
      ) : null}
      {!loading && failure ? (
        <SurfaceDataState kind="error" message="伴星档案暂时不可用" detail={failure} onRetry={() => void reload()} />
      ) : null}

      {data ? (
        <>
          <aside className="companion-room" aria-label="与伴星的共同记录">
            <span className="tag">与 {companionName} 的共同记录</span>
            <h2>{headline}</h2>

            <div className="memory-tabs" role="tablist" aria-label="共同记录分区">
              {TABS.map(([id, label], index) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`companion-tab-${id}`}
                  ref={(element) => { tabRefs.current[index] = element; }}
                  tabIndex={tab === id ? 0 : -1}
                  aria-selected={tab === id}
                  aria-controls="companion-record-body"
                  onClick={() => setTab(id)}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                >
                  <span className={tab === id ? "on" : undefined}>{label}</span>
                </button>
              ))}
            </div>

            <div className="record-scroll" id="companion-record-body" role="tabpanel" aria-labelledby={`companion-tab-${tab}`} ref={recordScrollRef}>
              {tab === "dialogue" ? (
                <DialogueRecords
                  section={data.conversations}
                  onRetry={() => void reload()}
                  order={conversationOrder}
                  onOrder={setConversationOrder}
                  expandedId={expandedConversationId}
                  onExpand={(id) => setExpandedConversationId((current) => (current === id ? null : id))}
                />
              ) : tab === "diary" ? (
                <DiaryRecords
                  section={diary.data}
                  loading={diary.loading}
                  failure={diary.failure}
                  date={diaryDate}
                  onDate={setDiaryDate}
                  onRetry={() => void diary.reload()}
                  onFocusMemory={openMemoryInList}
                />
              ) : tab === "memory" ? (
                <MemoryRecords
                  memories={memories}
                  failure={data.memories.ok ? null : data.memories.message}
                  onRetry={() => void reload()}
                  views={views}
                  filter={memoryFilter}
                  familyFilter={familyFilter}
                  query={query}
                  onQuery={setQuery}
                  counts={counts}
                  matches={matches}
                  focusId={focus?.id ?? null}
                  onFilter={(next) => { setMemoryFilter(next); setConfirmRemove(false); }}
                  onFamily={(next) => { setFamilyFilter(next); setConfirmRemove(false); }}
                  onFocus={focusMemory}
                />
              ) : (
                <PersonaRecords
                  section={data.persona}
                  onRetry={() => void reload()}
                  busy={personaBusy}
                  error={personaError}
                  confirmReset={confirmReset}
                  onConfirmReset={setConfirmReset}
                  onApplyPreset={applyPreset}
                  onActiveness={setActiveness}
                  onToggleBoundary={toggleBoundary}
                  onReset={resetPersona}
                />
              )}
            </div>

            <p className="record-foot">{recordFoot}</p>
          </aside>

          <main className="memory-field" aria-label="记忆星轨">
            <StarTrail
              views={trail}
              focus={focus}
              mutedIds={mutedIds}
              filter={memoryFilter}
              familyFilter={familyFilter}
              counts={counts}
              onFilter={setMemoryFilter}
              onFamily={setFamilyFilter}
              onFocus={focusFromTrail}
              onRevealHidden={revealHidden}
            />
            <MemoryFocusCard
              focus={focus}
              busy={busy}
              error={actionError}
              confirmRemove={confirmRemove}
              onRequestRemove={() => setConfirmRemove(true)}
              onCancelRemove={() => setConfirmRemove(false)}
              onAction={runAction}
              hasStarMap={starMap !== null}
              starMapFailure={data.starMap.ok ? null : data.starMap.message}
              onRetry={() => void reload()}
            />
          </main>
        </>
      ) : null}
    </HudPage>
  );
}

/** The one retry control every section uses when only that section failed. */
function SectionRetry({ onRetry, label = "重新读取" }: { readonly onRetry: () => void; readonly label?: string }) {
  return (
    <button type="button" className="record-retry" onClick={onRetry}>
      <RefreshCw size={11} aria-hidden="true" />
      {label}
    </button>
  );
}

/**
 * 对话 — what was talked about. Read-only, and it says so: there is no message
 * body and no send channel behind it, so a row opens the record's own details
 * instead of pretending to be a chat.
 */
function DialogueRecords({
  section,
  onRetry,
  order,
  onOrder,
  expandedId,
  onExpand,
}: {
  readonly section: Section<CompanionConversationListV1>;
  readonly onRetry: () => void;
  readonly order: "recent" | "oldest";
  readonly onOrder: (next: "recent" | "oldest") => void;
  readonly expandedId: string | null;
  readonly onExpand: (conversationId: string) => void;
}) {
  if (!section.ok) {
    return <p className="record-empty"><b>对话记录暂时不可用</b>{section.message}<SectionRetry onRetry={onRetry} /></p>;
  }
  if (section.value.items.length === 0) {
    return (
      <p className="record-empty">
        <b>还没有对话记录</b>
        伴星的窗口内对话尚未在这里留下记录。这一栏只读，不会替你在别处续写对话。
      </p>
    );
  }

  const ordered = [...section.value.items].sort((a, b) => {
    const left = a.lastMessageAt ?? a.updatedAt;
    const right = b.lastMessageAt ?? b.updatedAt;
    return order === "recent" ? right.localeCompare(left) : left.localeCompare(right);
  });

  return (
    <>
      <div className="record-chips" role="group" aria-label="对话排序">
        {/* 排序方向由文字表意：两枚按钮共用同一个双向箭头图标时不携带任何信息。 */}
        <button
          type="button"
          className={order === "recent" ? "is-on" : undefined}
          aria-pressed={order === "recent"}
          onClick={() => onOrder("recent")}
        >
          最近
        </button>
        <button
          type="button"
          className={order === "oldest" ? "is-on" : undefined}
          aria-pressed={order === "oldest"}
          onClick={() => onOrder("oldest")}
        >
          最早
        </button>
      </div>

      {ordered.map((conversation) => {
        const open = expandedId === conversation.id;
        return (
          <button
            key={conversation.id}
            type="button"
            className={`diary-entry${open ? " is-selected" : ""}`}
            aria-expanded={open}
            onClick={() => onExpand(conversation.id)}
          >
            <span className="diary-entry__top">
              <b>{conversation.title}</b>
              <time dateTime={conversation.lastMessageAt ?? conversation.updatedAt}>
                {formatRelative(conversation.lastMessageAt ?? conversation.updatedAt)}
              </time>
            </span>
            <small>开始于 {formatDate(conversation.createdAt)}</small>
            {open ? (
              <span className="diary-entry__detail">
                <small>状态 {conversation.status === "active" ? "进行中" : "已归档"}</small>
                <small>标题由{conversation.titleSource === "user" ? "你" : conversation.titleSource === "auto" ? "伴星自动" : conversation.titleSource === "system" ? "系统" : "占位符生成"}</small>
                <small>首次记录 {formatDate(conversation.createdAt)}</small>
                <small>
                  {conversation.lastMessageAt
                    ? `最后一条消息 ${formatRelative(conversation.lastMessageAt)}`
                    : "还没有消息"}
                </small>
                <small>会话更新于 {formatDate(conversation.updatedAt)}</small>
              </span>
            ) : null}
          </button>
        );
      })}
      <p className="record-foot">
        这里只陈列已发生的对话，不提供发送入口。{section.value.nextCursor ? "最近 20 段之外的更早会话尚未接入翻页。" : ""}
      </p>
    </>
  );
}

/** 日记 — the companion's own record of one day, written by the server. */
function DiaryRecords({
  section,
  loading,
  failure,
  date,
  onDate,
  onRetry,
  onFocusMemory,
}: {
  readonly section: Section<CompanionDailySummaryV1> | null;
  readonly loading: boolean;
  readonly failure: string | null;
  /** null = whatever day the server most recently wrote. */
  readonly date: string | null;
  readonly onDate: (next: string | null) => void;
  readonly onRetry: () => void;
  readonly onFocusMemory: (memoryId: string) => void;
}) {
  const today = todayIsoDate();
  // The strip is anchored to today so its labels stay meaningful, and a day
  // reached with the arrows is appended as its own chip instead of shifting it.
  const strip = diaryDayStrip(today);

  if (loading && !section) {
    return <p className="record-empty"><b>正在读取这一天</b>日记来自服务端每天写下的记录。</p>;
  }
  if (failure) {
    return <p className="record-empty"><b>日记暂时不可用</b>{failure}<SectionRetry onRetry={onRetry} /></p>;
  }
  if (!section) {
    return <p className="record-empty"><b>正在读取这一天</b>服务端还没有返回记录。</p>;
  }
  if (!section.ok) {
    return <p className="record-empty"><b>日记暂时不可用</b>{section.message}<SectionRetry onRetry={onRetry} /></p>;
  }

  const daily = section.value;
  // The server answers with the day it actually served; a day with no row comes
  // back as `not_generated` carrying the day that was asked for.
  const servedDate = daily.date;
  const cursor = date ?? servedDate ?? today;
  const offStrip = !strip.includes(cursor);

  const dayPicker = (
    <div className="diary-days" role="group" aria-label="选择日记日期">
      <button type="button" aria-label="前一天" onClick={() => onDate(shiftIsoDate(cursor, -1))}>
        <ChevronLeft size={11} aria-hidden="true" />
      </button>
      {strip.map((day) => (
        <button
          key={day}
          type="button"
          className={day === cursor ? "is-on" : undefined}
          aria-pressed={day === cursor}
          onClick={() => onDate(day)}
        >
          {diaryDayLabel(day, today)}
        </button>
      ))}
      {offStrip ? (
        <button type="button" className="is-on is-away" aria-pressed onClick={() => onDate(cursor)}>
          {diaryDayLabel(cursor, today)}
        </button>
      ) : null}
      <button type="button" aria-label="后一天" disabled={cursor >= today} onClick={() => onDate(shiftIsoDate(cursor, 1))}>
        <ChevronRight size={11} aria-hidden="true" />
      </button>
      {date !== null ? (
        <button type="button" className="diary-days__reset" onClick={() => onDate(null)}>回到最近</button>
      ) : null}
    </div>
  );

  if (daily.status !== "generated" || !servedDate) {
    return (
      <>
        {dayPicker}
        <p className="record-empty">
          <b>{daily.status === "failed" ? "这一天的日记没有写成" : `${diaryDayLabel(cursor, today)}还没有日记`}</b>
          {daily.status === "failed"
            ? "服务端尝试记录这一天时失败了；已发生的学习记录本身没有受影响。"
            : "伴星会在一天结束时，把当天真正发生过的学习写成一篇日记。换一天看看，或先继续今天的学习。"}
        </p>
      </>
    );
  }

  const facts = (Object.entries(daily.facts) as Array<[keyof CompanionDailyFactsV1, number | undefined]>)
    .filter(([, count]) => typeof count === "number" && count > 0);

  return (
    <>
      {dayPicker}

      <div className="diary-entry">
        <span className="diary-entry__top">
          <b>{diaryDayLabel(servedDate, today)}</b>
          <time dateTime={daily.generatedAt ?? undefined}>{formatRelative(daily.generatedAt)}</time>
        </span>
        <small className="diary-entry__body">{daily.summary || "这一天没有需要写下来的事。"}</small>
      </div>

      {facts.length > 0 ? (
        <div className="record-facts">
          {facts.map(([key, count]) => (
            <div key={key}>
              <b>{count}</b>
              <small>{DAILY_FACT_LABEL[key]}</small>
            </div>
          ))}
        </div>
      ) : null}

      {daily.conversationHighlights.length > 0 ? (
        <>
          <p className="record-heading">当天留下的原话</p>
          {daily.conversationHighlights.map((highlight, index) => (
            <div key={`${highlight.role}-${index}`} className="diary-entry">
              <small className="diary-entry__body">
                <b>{highlight.role === "user" ? "你" : "伴星"}</b>：{highlight.text || "（无文字内容）"}
              </small>
            </div>
          ))}
        </>
      ) : null}

      {daily.memory ? (
        <button
          type="button"
          className="diary-entry"
          onClick={() => onFocusMemory(daily.memory!.memoryItemId)}
        >
          <span className="diary-entry__top">
            <b>这一天写成了一条记忆</b>
            <ChevronRight size={11} aria-hidden="true" />
          </span>
          <small>{daily.memory.candidate ? "尚未写入 · 去记忆栏确认" : "已写入长期记忆 · 去记忆栏查看"}</small>
        </button>
      ) : null}
    </>
  );
}

/** 记忆 — the same records the trail plots, with the states the trail omits. */
function MemoryRecords({
  memories,
  failure,
  onRetry,
  views,
  filter,
  familyFilter,
  query,
  onQuery,
  counts,
  matches,
  focusId,
  onFilter,
  onFamily,
  onFocus,
}: {
  readonly memories: CompanionMemoryListV1 | null;
  readonly failure: string | null;
  readonly onRetry: () => void;
  readonly views: readonly MemoryView[];
  readonly filter: MemoryFilter;
  readonly familyFilter: FamilyFilter;
  readonly query: string;
  readonly onQuery: (next: string) => void;
  readonly counts: Readonly<Record<MemoryFilter, number>>;
  readonly matches: (view: MemoryView) => boolean;
  readonly focusId: string | null;
  readonly onFilter: (next: MemoryFilter) => void;
  readonly onFamily: (next: FamilyFilter) => void;
  readonly onFocus: (memoryId: string) => void;
}) {
  if (failure) {
    return <p className="record-empty"><b>记忆列表暂时不可用</b>{failure}<SectionRetry onRetry={onRetry} /></p>;
  }
  if (!memories) return <p className="record-empty"><b>正在读取记忆</b>服务端还没有返回记录。</p>;

  const visible = views
    .filter(matches)
    .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
  const family = familyFilter === "all" ? null : MEMORY_FAMILIES.find((item) => item.id === familyFilter) ?? null;
  const filtering = filter !== "all" || family !== null || query.trim() !== "";

  return (
    <>
      <label className="record-search">
        <Search size={12} aria-hidden="true" />
        <span className="sr-only">在当前记忆里搜索</span>
        <input
          type="search"
          value={query}
          placeholder="搜索记忆正文"
          onChange={(event) => onQuery(event.target.value)}
        />
        {query ? (
          <button type="button" className="record-search__clear" onClick={() => onQuery("")}>
            <X size={10} aria-hidden="true" />
            <span className="sr-only">清空搜索词</span>
          </button>
        ) : null}
      </label>

      <div className="record-chips" role="group" aria-label="记忆筛选">
        {STATE_FILTERS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={filter === id ? "is-on" : undefined}
            aria-pressed={filter === id}
            onClick={() => onFilter(id)}
          >
            {label} <b>{counts[id]}</b>
          </button>
        ))}
        {family ? (
          <button type="button" className="is-on is-family" aria-pressed onClick={() => onFamily("all")}>
            {family.label}
            <X size={10} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <p className="record-empty">
          <b>{views.length === 0 ? "还没有写入任何记忆" : "当前条件下没有记忆"}</b>
          {views.length === 0
            ? "伴星只会在你确认之后，把一条候选记忆写进长期记忆。"
            : "换一个筛选或清空搜索词；记忆本身没有被改动。"}
        </p>
      ) : null}

      {visible.map((view) => (
        <button
          key={view.id}
          type="button"
          data-memory-id={view.id}
          className={`diary-entry${focusId === view.id ? " is-selected" : ""}`}
          aria-pressed={focusId === view.id}
          onClick={() => onFocus(view.id)}
        >
          <span className="diary-entry__top">
            <b>{memoryKindLabel(view.kind)}</b>
            <time dateTime={view.updatedAt ?? undefined}>{formatRelative(view.updatedAt)}</time>
          </span>
          <small className="diary-entry__body">{view.content}</small>
          <small>
            {memoryStateLabel(view.state)}
            {view.importance !== null ? ` · 重要度 ${Math.round(view.importance * 100)}%` : ""}
            {view.links.length > 0 ? ` · 关联 ${view.links.length} 处` : ""}
          </small>
        </button>
      ))}

      {filtering ? (
        <p className="record-foot">
          当前显示 {visible.length} / {views.length} 条。
        </p>
      ) : null}
    </>
  );
}

/** 人格 — the persona the server stores, and the presets it offers to replace it. */
function PersonaRecords({
  section,
  onRetry,
  busy,
  error,
  confirmReset,
  onConfirmReset,
  onApplyPreset,
  onActiveness,
  onToggleBoundary,
  onReset,
}: {
  readonly section: Section<CompanionPersonaV1>;
  readonly onRetry: () => void;
  readonly busy: PersonaAction | null;
  readonly error: string | null;
  readonly confirmReset: boolean;
  readonly onConfirmReset: (next: boolean) => void;
  readonly onApplyPreset: (preset: CompanionPersonaPresetV1) => void;
  readonly onActiveness: (next: CompanionPersonaProfileV1["activeness"]) => void;
  readonly onToggleBoundary: (key: (typeof BOUNDARY_ITEMS)[number][0]) => void;
  readonly onReset: () => void;
}) {
  if (!section.ok) {
    return <p className="record-empty"><b>人格档案暂时不可用</b>{section.message}<SectionRetry onRetry={onRetry} /></p>;
  }
  const persona = section.value;
  const profile = persona.profile;
  const shown = profile ?? persona.activePreset;
  const locked = busy !== null;

  return (
    <>
      {error ? <p className="record-alert" role="alert">{error}</p> : null}

      {shown ? (
        <>
          <div className="diary-entry">
            <span className="diary-entry__top">
              <b>{shown.name}</b>
              <span className="entry-flag">{ACTIVE_NESS_LABEL[shown.activeness] ?? shown.activeness}</span>
            </span>
            <small>{profile ? "已保存为你的档案" : "来自系统预设，还没有保存成你的档案"}</small>
          </div>

          <div className="record-tags">
            {shown.personalityTags.map((tag) => <span key={tag}>{tag}</span>)}
          </div>

          <p className="record-quote">{shown.speakingStyle}</p>

          {shown.examples.length > 0 ? (
            <>
              <p className="record-heading">它平时会这样说</p>
              {shown.examples.map((example, index) => (
                <div key={`${example.text}-${index}`} className="diary-entry">
                  <small className="diary-entry__body">{example.text}</small>
                </div>
              ))}
            </>
          ) : null}

          {profile ? (
            <p className="record-foot">
              熟悉度 {Math.round(profile.familiarity * 100)}% · 累计互动 {profile.interactionCount} 次
            </p>
          ) : null}
        </>
      ) : (
        <p className="record-empty">
          <b>还没有人格档案</b>
          当前账号没有保存过人格设定。服务端提供 {persona.presets.length} 套预设，选定后才会写入。
        </p>
      )}

      {profile ? (
        <>
          <p className="record-heading">伴星的活跃度 · 选定即保存</p>
          <div className="record-chips" role="group" aria-label="活跃度">
            {ACTIVE_NESS_ITEMS.map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                className={profile.activeness === value ? "is-on" : undefined}
                aria-pressed={profile.activeness === value}
                disabled={locked}
                title={hint}
                onClick={() => onActiveness(value)}
              >
                {label}
              </button>
            ))}
          </div>

          <p className="record-heading">边界 · 改动会立即保存</p>
          <div className="record-switches" role="group" aria-label="边界">
            {BOUNDARY_ITEMS.map(([key, label, hint]) => {
              const value = profile.boundaries[key];
              return (
                <button
                  key={key}
                  type="button"
                  className={value === true ? "is-on" : value === false ? "is-off" : undefined}
                  aria-pressed={value === true}
                  disabled={locked}
                  title={hint}
                  onClick={() => onToggleBoundary(key)}
                >
                  <i aria-hidden="true" />
                  <span>{label}</span>
                  <small>{value === true ? "开" : value === false ? "关" : "未设定"}</small>
                </button>
              );
            })}
          </div>
        </>
      ) : null}

      <p className="record-heading">人格预设{persona.presets.length > 0 ? " · 选定即保存为你的档案" : ""}</p>
      {persona.presets.length === 0 ? (
        <p className="record-empty"><b>服务端没有提供预设</b>当前环境没有可选的预设人格。</p>
      ) : (
        <div className="persona-presets">
          {persona.presets.map((preset) => {
            const active = profile?.presetId === preset.presetId;
            return (
              <button
                key={preset.presetId}
                type="button"
                className={active ? "is-on" : undefined}
                aria-pressed={active}
                disabled={locked}
                onClick={() => onApplyPreset(preset)}
              >
                <span className="diary-entry__top">
                  <b>{preset.name}</b>
                  <span className="entry-flag">{ACTIVE_NESS_LABEL[preset.activeness] ?? preset.activeness}</span>
                </span>
                <small className="diary-entry__body">{preset.speakingStyle}</small>
                {/* 保存中所有预设一并禁用，这里的标签只区分「在用 / 未用」，
                    不假装知道哪一套正在保存。 */}
                <small>{active ? "当前使用" : "使用这套预设"}</small>
              </button>
            );
          })}
        </div>
      )}

      {profile ? (
        <div className="persona-reset">
          {confirmReset ? (
            <>
              <button type="button" className="danger" disabled={locked} onClick={onReset}>
                {busy === "reset" ? "正在恢复…" : "确认恢复默认"}
              </button>
              <button type="button" disabled={locked} onClick={() => onConfirmReset(false)}>取消</button>
            </>
          ) : (
            <button type="button" disabled={locked} onClick={() => onConfirmReset(true)}>
              <RotateCcw size={11} aria-hidden="true" />恢复系统默认人格
            </button>
          )}
        </div>
      ) : null}
    </>
  );
}

/**
 * The star trail. Each star is one memory the companion holds; the orbit it sits
 * on is the family of memory, its colour is whether it is pinned, and a hollow
 * star is a candidate that has not been written yet.
 *
 * Positions are derived from the records, never randomised: the same memories
 * always draw the same sky, so a star that moved means the memory changed.
 *
 * The plate is a centred square, so every orbit is a real circle. Filtering dims
 * a star rather than removing it, for the same reason: the sky is a map of what
 * the companion knows, and a filter must not redraw the map.
 */
function StarTrail({
  views,
  focus,
  mutedIds,
  filter,
  familyFilter,
  counts,
  onFilter,
  onFamily,
  onFocus,
  onRevealHidden,
}: {
  readonly views: readonly MemoryView[];
  readonly focus: MemoryView | null;
  readonly mutedIds: ReadonlySet<string>;
  readonly filter: MemoryFilter;
  readonly familyFilter: FamilyFilter;
  readonly counts: Readonly<Record<MemoryFilter, number>>;
  readonly onFilter: (next: MemoryFilter) => void;
  readonly onFamily: (next: FamilyFilter) => void;
  readonly onFocus: (memoryId: string) => void;
  readonly onRevealHidden: (ids: readonly string[]) => void;
}) {
  const sky = useMemo(() => plotMemoryStars(views), [views]);
  const { points, hidden, hiddenIds } = sky;
  const focused = focus ? points.find((point) => point.view.id === focus.id) ?? null : null;
  const outer = MEMORY_FAMILIES[MEMORY_FAMILIES.length - 1];
  const starRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Dust is the sky's own weather, not a property of the records: fixed count,
  // deterministic layout, so it never reshuffles under a re-render. A grain
  // that lands on a real star (or its caption) is dropped at render time —
  // there it reads as a second, fake memory rather than as depth.
  const dust = useMemo(
    () => skyDust(56).filter((star) =>
      points.every((point) => Math.hypot(point.x - star.x, point.y - star.y) > 5),
    ),
    [points],
  );
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    starRefs.current = starRefs.current.slice(0, points.length);
  }, [points.length]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const hovered = hoverId && hoverId !== focus?.id
    ? points.find((point) => point.view.id === hoverId) ?? null
    : null;

  /** Arrow keys walk the trail in its own order, so 40 stars stay reachable. */
  const onStarKeyDown = (event: ReactKeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1
        : 0;
    const jump = event.key === "Home" ? -index : event.key === "End" ? points.length - 1 - index : 0;
    const delta = step || jump;
    if (!delta || points.length === 0) return;
    event.preventDefault();
    const next = (index + delta + points.length) % points.length;
    starRefs.current[next]?.focus();
  };

  return (
    <>
      {/* The sky's own atmosphere, inherited from the web star map: a deep
          gradient, two nebula glows (CSS) and a field of twinkling dust that is
          never interactive and never a record. The mask fades it into the room
          scene instead of drawing a hard panel over the night. */}
      <div className="sky-backdrop" aria-hidden="true" />
      <div className="memory-sky">
        <svg className="sky-dust" viewBox="0 0 100 100" aria-hidden="true" preserveAspectRatio="none">
          {dust.map((star, index) => (
            <circle
              key={index}
              cx={star.x}
              cy={star.y}
              r={star.size * 0.28}
              style={{
                ["--twinkle-max" as string]: `${Math.min(0.6, 0.14 + star.alpha).toFixed(2)}`,
                ["--twinkle-duration" as string]: `${star.duration}s`,
                ["--twinkle-delay" as string]: `${star.delay}s`,
              }}
            />
          ))}
        </svg>
        <svg className="memory-orbits" viewBox="0 0 100 100" aria-hidden="true">
          <defs>
            <radialGradient id="memoryCore" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(255, 228, 150, 0.20)" />
              <stop offset="70%" stopColor="rgba(255, 214, 130, 0.06)" />
              <stop offset="100%" stopColor="rgba(255, 214, 130, 0)" />
            </radialGradient>
            <linearGradient id="memoryRing" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(158, 216, 228, 0.30)" />
              <stop offset="62%" stopColor="rgba(158, 216, 228, 0.17)" />
              <stop offset="100%" stopColor="rgba(158, 216, 228, 0.05)" />
            </linearGradient>
          </defs>

          {/* The band the companion knows you on is a warm core, not a hard ring:
              the focus card lives on it, and a ring through a card reads as a
              collision while a glow reads as a seat. */}
          <circle cx="50" cy="50" r={MEMORY_FAMILIES[0].radius} fill="url(#memoryCore)" />

          {MEMORY_FAMILIES.slice(1).map((family) => (
            <circle
              key={family.id}
              className="is-band"
              cx="50"
              cy="50"
              r={family.radius}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* Every memory that is anchored in real learning content gets one faint
              tick out to the rim, so "which memories came from somewhere" reads at
              a glance. The selected memory replaces its tick with one bright line
              per link, which is as much provenance as the plate can carry. */}
          {points.map((point) => {
            const links = point.view.links;
            if (links.length === 0 || focus?.id === point.view.id) return null;
            const radians = (point.angle * Math.PI) / 180;
            const orphaned = links.every((link) => link.orphaned);
            return (
              <line
                key={`anchor-${point.view.id}`}
                className={`is-anchor${orphaned ? " is-orphan" : ""}`}
                x1={point.x}
                y1={point.y}
                x2={50 + outer.radius * Math.cos(radians)}
                y2={50 + outer.radius * Math.sin(radians)}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          {focused?.view.links.map((link, index) => {
            const count = focused.view.links.length;
            const spread = (index - (count - 1) / 2) * (count > 1 ? 7 : 0);
            const radians = ((focused.angle + spread) * Math.PI) / 180;
            const rim = {
              x: 50 + outer.radius * Math.cos(radians),
              y: 50 + outer.radius * Math.sin(radians),
            };
            // The web map bent every relation edge off the straight line so
            // parallel links stayed readable, and ran a bright particle along
            // the highlighted ones. Same curve here, and the comet only rides
            // it when motion is welcome.
            const seed = `${link.entityType}-${link.entityId}`;
            const control = curveControlPoint({ x: focused.x, y: focused.y }, rim, seed);
            const path = `M ${focused.x} ${focused.y} Q ${control.x} ${control.y} ${rim.x} ${rim.y}`;
            return (
              <g key={seed} className={`is-live${link.orphaned ? " is-orphan" : ""}`}>
                <path d={path} vectorEffect="non-scaling-stroke" fill="none" />
                {!reducedMotion ? (
                  <circle className="is-comet" r={0.85}>
                    <animateMotion dur="3.4s" repeatCount="indefinite" path={path} />
                  </circle>
                ) : null}
              </g>
            );
          })}
          {/* The selection crown is the web map's drawSelectionOrbit: a slow
              dashed orbit around the chosen star with one bright satellite
              riding it, so "this is the memory you are working on" reads even
              in peripheral vision. */}
          {focused ? (
            <g
              className="is-crown"
              style={{ transformOrigin: `${focused.x}px ${focused.y}px` }}
            >
              <circle
                cx={focused.x}
                cy={focused.y}
                r={5.2}
                vectorEffect="non-scaling-stroke"
              />
              <circle className="is-crown-satellite" cx={focused.x + 5.2} cy={focused.y} r={0.7} />
            </g>
          ) : null}
        </svg>

        {points.map((point, index) => {
          const view = point.view;
          const classes = [
            "star-node",
            view.state === "pinned" ? "warm is-pinned" : "",
            view.state === "candidate" ? "is-candidate" : "",
            point.size === "major" ? "is-major" : point.size === "minor" ? "is-minor" : "",
            focus?.id === view.id ? "is-selected" : "",
            hoverId === view.id ? "is-hover" : "",
            mutedIds.has(view.id) ? "is-muted" : "",
          ].filter(Boolean).join(" ");
          return (
            <button
              key={view.id}
              type="button"
              ref={(element) => { starRefs.current[index] = element; }}
              className={`${classes}${point.captionAbove ? " caption-above" : ""}`}
              style={{ left: `${point.x}%`, top: `${point.y}%` }}
              aria-pressed={focus?.id === view.id}
              aria-label={`${memoryStateLabel(view.state)}记忆：${view.content}`}
              onClick={() => onFocus(view.id)}
              onKeyDown={(event) => onStarKeyDown(event, index)}
              onPointerEnter={() => setHoverId(view.id)}
              onPointerLeave={() => setHoverId((current) => (current === view.id ? null : current))}
              onFocus={() => setHoverId(view.id)}
              onBlur={() => setHoverId((current) => (current === view.id ? null : current))}
            >
              <i aria-hidden="true" />
              <span aria-hidden="true">{starLabel(view.content)}</span>
            </button>
          );
        })}

        {/* Hover replaces the browser tooltip with the same drawn card the
            records use: state and kind first, content under it. It steps aside
            while a star is selected, exactly as the web map did. */}
        {hovered ? (
          <div
            className={`sky-tip${hovered.captionAbove ? " is-below" : ""}`}
            style={{ left: `${hovered.x}%`, top: `${hovered.y}%` }}
            role="tooltip"
          >
            <b>{starLabel(hovered.view.content)}</b>
            <span>
              {memoryStateLabel(hovered.view.state)} · {memoryKindLabel(hovered.view.kind)}
              {hovered.view.links.length > 0 ? ` · 关联 ${hovered.view.links.length} 处` : ""}
            </span>
          </div>
        ) : null}

        <p className="sr-only" aria-live="polite">
          {focus
            ? `已选择${memoryStateLabel(focus.state)}记忆：${starLabel(focus.content)}`
            : "未选择记忆"}
        </p>
      </div>

      <div className="memory-legend" role="group" aria-label="按状态筛选记忆星轨">
        {STATE_FILTERS.filter(({ id }) => id !== "archived").map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={`is-${id}${filter === id ? " is-on" : ""}`}
            aria-pressed={filter === id}
            onClick={() => onFilter(id)}
          >
            {id !== "all" ? <i aria-hidden="true" /> : null}
            {label}
            <b>{counts[id]}</b>
          </button>
        ))}
      </div>

      <div className="memory-bands" role="group" aria-label="按记忆家族筛选">
        <button
          type="button"
          className={familyFilter === "all" ? "is-on" : undefined}
          aria-pressed={familyFilter === "all"}
          onClick={() => onFamily("all")}
        >
          全部星轨<b>{views.length}</b>
        </button>
        {MEMORY_FAMILIES.map((family, index) => (
          <button
            key={family.id}
            type="button"
            className={familyFilter === family.id ? "is-on" : undefined}
            aria-pressed={familyFilter === family.id}
            onClick={() => onFamily(family.id)}
          >
            {family.label}
            <b>{points.filter((point) => point.familyIndex === index).length}</b>
          </button>
        ))}
        {hidden > 0 ? (
          <button type="button" className="memory-bands__more" onClick={() => onRevealHidden(hiddenIds)}>
            另有 {hidden} 条没画上星轨 · 去记忆栏查看
          </button>
        ) : null}
      </div>

      <p className="memory-field__foot">
        {views.length === 0
          ? "星轨上还没有记忆。"
          : "按离中心远近读取：内环 关于你 · 中环 学习观察 · 外环 共同经历"}
      </p>
    </>
  );
}

/**
 * The focus card is the mockup's `.memory-focus`, now carrying the selected
 * memory and the decisions that are legal for its state. Removing a memory is
 * the only irreversible action here, so it asks once before it goes.
 */
function MemoryFocusCard({
  focus,
  busy,
  error,
  confirmRemove,
  onRequestRemove,
  onCancelRemove,
  onAction,
  hasStarMap,
  starMapFailure,
  onRetry,
}: {
  readonly focus: MemoryView | null;
  readonly busy: MemoryAction | null;
  readonly error: string | null;
  readonly confirmRemove: boolean;
  readonly onRequestRemove: () => void;
  readonly onCancelRemove: () => void;
  readonly onAction: (action: MemoryAction, memoryId: string) => void;
  readonly hasStarMap: boolean;
  readonly starMapFailure: string | null;
  readonly onRetry: () => void;
}) {
  if (!focus) {
    return (
      <article className="memory-focus">
        <span className="memory-focus__kicker">记忆星轨</span>
        <b>{hasStarMap ? "星轨上还没有星" : "记忆星轨当前不可用"}</b>
        <span>
          {hasStarMap
            ? "当伴星确认第一条关于你的记忆，它就会在这里亮起来。"
            : starMapFailure ?? "服务端没有返回记忆星图。"}
        </span>
        {hasStarMap ? null : <SectionRetry onRetry={onRetry} />}
      </article>
    );
  }

  const actions = MEMORY_ACTIONS[focus.state];
  const kicker = focus.state === "candidate"
    ? "一段待确认的记忆"
    : focus.state === "pinned"
      ? "一条已固定的记忆"
      : focus.state === "archived"
        ? "一条已归档的记忆"
        : "一条已写入的记忆";

  return (
    <article className="memory-focus">
      <span className="memory-focus__kicker">{kicker}</span>
      <b>{focus.content}</b>
      <span>
        {memoryKindLabel(focus.kind)}
        {focus.sourceType ? ` · ${memorySourceLabel(focus.sourceType)}` : ""}
        {focus.scope ? ` · ${memoryScopeLabel(focus.scope)}` : ""}
      </span>
      <span className="memory-focus__meta">
        {focus.importance !== null ? `重要度 ${Math.round(focus.importance * 100)}%` : "重要度未提供"}
        {focus.confidence !== null ? ` · 置信度 ${Math.round(focus.confidence * 100)}%` : ""}
        {focus.updatedAt ? ` · 更新于 ${formatRelative(focus.updatedAt)}` : ""}
      </span>
      <span className="memory-focus__links">
        {focus.links.length > 0
          ? `关联：${focus.links.map((link) => `${entityTypeLabel(link.entityType)}${link.orphaned ? "（已断开）" : ""}`).join(" · ")}`
          : "尚未关联任何学习内容"}
      </span>
      {focus.state === "candidate" ? <span>尚未写入 · 由你确认</span> : null}

      {error ? <span className="memory-focus__error" role="alert">{error}</span> : null}

      <div className="memory-focus__actions">
        {confirmRemove ? (
          <>
            <button type="button" className="danger" disabled={busy !== null} onClick={() => onAction("remove", focus.id)}>
              {busy === "remove" ? "正在删除…" : "确认删除"}
            </button>
            <button type="button" disabled={busy !== null} onClick={onCancelRemove}>取消</button>
          </>
        ) : (
          actions.map((entry) => (
            <button
              key={entry.action}
              type="button"
              className={entry.tone === "plain" ? undefined : entry.tone}
              disabled={busy !== null}
              title={MEMORY_ACTION_HINT[entry.action]}
              onClick={() => {
                if (entry.action === "remove") onRequestRemove();
                else onAction(entry.action, focus.id);
              }}
            >
              {busy === entry.action ? "处理中…" : entry.label}
            </button>
          ))
        )}
      </div>

      <span className="memory-focus__hint">
        <Sparkles size={10} aria-hidden="true" />
        共 {actions.length} 个可用动作
      </span>
    </article>
  );
}

const MEMORY_ACTION_HINT: Record<MemoryAction, string> = {
  confirm: "把这条候选记忆写进长期记忆",
  pin: "固定后一直留在星轨内环的视野里",
  unpin: "取消固定，仍保留在星轨上",
  archive: "移出星轨，但仍可以在记忆栏里找到",
  restore: "把这条记忆放回星轨",
  remove: "删除这条记忆，需要再确认一次",
};
