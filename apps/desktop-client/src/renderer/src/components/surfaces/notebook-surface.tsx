import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import type { CapabilityProjectionV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type {
  CardGenerationActiveSummaryV1,
  CardGenerationRunSnapshotV1,
  DesktopCardDetailThresholdV2,
  DesktopCardGenerationFeedbackReasonV2,
  DesktopCardLearningGoalV2,
  DesktopCardStrategyV2,
} from "@ailearn/shared/card-generation-desktop-contracts";
import type { RoomProjectionV1 } from "@ailearn/shared/room-projection-contracts";
import type { DesktopNoteVersionItem, DesktopSourceDetail } from "@ailearn/shared/desktop-surface-contracts";
import type { LearningObjectiveSurfaceV3 } from "@ailearn/shared/learning-objective-surface-contracts";
import type { NoteBlockProjectionV1, NoteDetailV1 } from "@ailearn/shared/note-projection-contracts";
import { useRoomStore } from "../../app/room-store";
import {
  createCommandId,
  createRequestMeta,
  gatewayErrorMessage,
  unwrapGatewayResult,
} from "../../app/desktop-client";
import { HudPage } from "../hud/HudPage";
import { useHudPage } from "../hud/use-hud-page";
import type { HudPageId } from "../hud/hud-pages";
import {
  SurfaceDataState,
  formatRelative,
  noteBlockText,
  parseImageBlock,
  useSurfaceProjection,
} from "./surface-data";
import {
  cardGenerationEntryLabel,
  cardGenerationStatusLabel,
  isCardGenerationInFlight,
  isLiveGenerationForNote,
} from "./card-generation-status";
import {
  blocksMatchMarkdown,
  blocksToMarkdown,
  markdownToBlocks,
  parseMarkdownTable,
} from "./note-blocks";
import { useSourceImage } from "./source-image";
import { ImageGalleryLightbox, useImageLightbox, ZoomableReadingImage, type GalleryImage } from "./image-viewer";
import { NoteMarkdownEditor, type NoteMarkdownEditorHandle } from "./note-markdown-editor";
import { useNoteDocLiveView } from "./use-note-doc-live-view";
import { NoteImageUploads, useNoteImageUploads } from "./note-image-uploads";

/**
 * Pages 08 / 09: one committed note as a paper notebook.
 *
 * Reading (`note-read`) and writing (`note-edit`) are the same server record in
 * two modes. Every field on this page comes from `room.getProjection` /
 * `note.get` / `source.get` / `capabilities.get`; nothing about the note is
 * written locally before the server confirms it.
 *
 * 正文在编辑器里是**真 Markdown**（Milkdown 所见即所得），在服务端是分类型的块，
 * 两边只经 `note-blocks.ts` 那一份换算，所以"打开一篇没改过的笔记就显示未提交"
 * 这种漂移不存在。撤销由编辑器自己的 history 承担，这一页不再维护第二套。
 */
type NotebookProjection = {
  readonly note: NoteDetailV1;
  readonly source: DesktopSourceDetail | null;
  readonly sourceFailure: string | null;
  readonly objective: LearningObjectiveSurfaceV3 | null;
  readonly capabilities: CapabilityProjectionV1;
  /**
   * The workspace's one live Card Generation run (owner only; Member sees an
   * empty section). The note page reads it so "生成学习卡" becomes a status
   * sync instead of a duplicate start.
   */
  readonly activeGeneration: RoomProjectionV1["activeGenerationSummary"];
  /**
   * The note's most recent run, finished or not. A regeneration that answers the
   * last one has to name it, and no other projection says which run that was.
   */
  readonly latestGenerationRun: CardGenerationRunSnapshotV1 | null;
};

const AUTOSAVE_DELAY_MS = 1_200;

/**
 * How many blocks the reading page draws before it asks. The note contract
 * allows 10,000 blocks in one version, and every block is parsed for markdown
 * tables while rendering — a window keeps a long note's first paint bounded
 * without hiding anything: the rest is one click away.
 */
const READING_WINDOW = 200;

/**
 * What a generation run is asked for. These are the run contract's own knobs —
 * the page used to hard-code all four, so every run was "理解 / 均衡 / 最多 8 张 /
 * 主动回忆+机制解释" with no way to say otherwise, and only two of the seven
 * strategies the contract accepts were ever reachable.
 */
type GenerationOptions = {
  readonly learningGoal: DesktopCardLearningGoalV2;
  readonly detailThreshold: DesktopCardDetailThresholdV2;
  readonly hardMaxCards: number;
  readonly preferredStrategies: readonly DesktopCardStrategyV2[];
};

/**
 * 题型是「系统按知识形态分配」的候选集合，不是优先级：勾掉某种即表示不要它，
 * 全勾即完全交给 planner 决定（planner-service.allocateStrategies）。
 * 默认值必须是全集——曾经默认 ["recall","why"] 时，即便题型真正生效，
 * 事实类知识也会被压成清一色的回忆题。
 */
const STRATEGIES: readonly { readonly value: DesktopCardStrategyV2; readonly label: string }[] = [
  { value: "recall", label: "主动回忆" },
  { value: "cloze", label: "关键补全" },
  { value: "compare", label: "对比辨析" },
  { value: "sequence", label: "顺序重建" },
  { value: "why", label: "机制解释" },
  { value: "boundary", label: "边界判断" },
  { value: "application", label: "情境应用" },
];

const DEFAULT_GENERATION_OPTIONS: GenerationOptions = {
  learningGoal: "understand",
  detailThreshold: "balanced",
  hardMaxCards: 8,
  preferredStrategies: STRATEGIES.map((item) => item.value),
};

/** Session scope, like the library's view choice: a page visit keeps the writer's pick. */
let persistedGenerationOptions: GenerationOptions = DEFAULT_GENERATION_OPTIONS;

const LEARNING_GOALS: readonly { readonly value: DesktopCardLearningGoalV2; readonly label: string }[] = [
  { value: "remember", label: "记住" },
  { value: "understand", label: "理解" },
  { value: "apply", label: "应用" },
  { value: "exam", label: "应试" },
];

const DETAIL_THRESHOLDS: readonly { readonly value: DesktopCardDetailThresholdV2; readonly label: string }[] = [
  { value: "concise", label: "精简" },
  { value: "balanced", label: "均衡" },
  { value: "deep", label: "深入" },
];

const CARD_LIMITS = [4, 8, 12] as const;

/** Statuses where the run has stopped; only those can be answered with feedback. */
const FINISHED_RUN_STATUSES = new Set(["activated", "closed_without_activation", "cancelled", "failed", "stale"]);

const FEEDBACK_REASONS: readonly { readonly value: DesktopCardGenerationFeedbackReasonV2; readonly label: string }[] = [
  { value: "too_many", label: "卡片太多" },
  { value: "missing_key_objective", label: "漏掉关键目标" },
  { value: "surface_paraphrase", label: "只是换了个说法" },
  { value: "wrong_learning_goal", label: "学习目标不符" },
  { value: "duplicate_existing_card", label: "与已有卡片重复" },
  { value: "not_worth_reviewing", label: "不值得复习" },
];

function generationOptionSummary(options: GenerationOptions): string {
  const goal = LEARNING_GOALS.find((item) => item.value === options.learningGoal)?.label ?? options.learningGoal;
  const detail = DETAIL_THRESHOLDS.find((item) => item.value === options.detailThreshold)?.label ?? options.detailThreshold;
  const strategies = options.preferredStrategies
    .map((value) => STRATEGIES.find((item) => item.value === value)?.label ?? value)
    .join("+");
  return `${goal} · ${detail} · 最多 ${options.hardMaxCards} 张 · ${strategies}`;
}

/**
 * 工具栏：每个按钮直接调 Milkdown 的命令，光标所在的块自己变形状，不再往纯文本
 * 里拼标记。这是 Web 端工具栏的做法，也是"所见即所得"与"纯文本标记"的分界线——
 * 按钮改的是文档结构，不是字符串。
 *
 * `onMouseDown` 一律 `preventDefault`：命令作用在**当前选区**上，按下去的那一下
 * 若把焦点抢走，加粗就会落到空处。字形沿用纸面原本的写法（`H`、`“`、`⌁`、`fx`），
 * 只是同一批字形现在指挥的是真文档。
 */
type EditorToolSpec = {
  readonly glyph: string;
  readonly label: string;
  readonly title: string;
  readonly run: (editor: NoteMarkdownEditorHandle) => void;
};

const EDITOR_TOOLS: readonly EditorToolSpec[] = [
  { glyph: "H", label: "标题", title: "把这一段变成标题", run: (editor) => editor.toggleHeading(2) },
  { glyph: "B", label: "加粗", title: "加粗（⌘/Ctrl+B）", run: (editor) => editor.toggleStrong() },
  { glyph: "I", label: "斜体", title: "斜体（⌘/Ctrl+I）", run: (editor) => editor.toggleEmphasis() },
  { glyph: "``", label: "行内代码", title: "行内代码", run: (editor) => editor.toggleInlineCode() },
  { glyph: "“", label: "引用", title: "把这一段变成引用", run: (editor) => editor.toggleBlockquote() },
  { glyph: "⌁", label: "无序列表", title: "变成无序列表", run: (editor) => editor.toggleBulletList() },
  { glyph: "1.", label: "有序列表", title: "变成有序列表", run: (editor) => editor.toggleOrderedList() },
  { glyph: "fx", label: "代码块", title: "插入代码区块", run: (editor) => editor.insertCodeBlock() },
  { glyph: "—", label: "分隔线", title: "插入分隔线", run: (editor) => editor.insertHr() },
  { glyph: "⛓", label: "链接", title: "插入链接（⌘/Ctrl+K）", run: (editor) => editor.toggleLink("https://") },
];

function desktopApi() {
  return typeof window === "undefined" ? undefined : window.ailearn;
}

function formatClock(value: string | null | undefined): string {
  if (!value) return "时间未提供";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return "时间未提供";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(parsed);
}

function excerpt(value: string, max = 96): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

/**
 * The sentence the reading page marks: the one that names the concept this note
 * is bound to. The mockup marked the opening clause of the first paragraph, but
 * nothing in the note record says the first paragraph is the claim — that was a
 * typographic guess presented as emphasis. The linked objective's concept label
 * is real data, so the mark follows it and disappears when there is nothing to
 * follow.
 */
function conceptMark(
  blocks: readonly NoteBlockProjectionV1[],
  conceptLabel: string | null | undefined,
): { readonly ordinal: number; readonly range: readonly [number, number] } | null {
  const label = conceptLabel?.trim();
  if (!label) return null;
  for (const block of blocks) {
    if (block.type !== "paragraph") continue;
    const text = noteBlockText(block.content);
    const at = text.indexOf(label);
    if (at < 0) continue;
    return { ordinal: block.ordinal, range: sentenceRange(text, at, label.length) };
  }
  return null;
}

/** The sentence around `[at, at + length)`, punctuation included. */
function sentenceRange(text: string, at: number, length: number): readonly [number, number] {
  const stops = /[。！？!?\n]/;
  let start = 0;
  for (let index = at - 1; index >= 0; index -= 1) {
    if (stops.test(text[index] ?? "")) {
      start = index + 1;
      break;
    }
  }
  let end = text.length;
  for (let index = at + length; index < text.length; index += 1) {
    if (stops.test(text[index] ?? "")) {
      end = index + 1;
      break;
    }
  }
  return [start, end];
}

/** Page 08 / 09 / 22 — the note as one paper, read, written or discussed. */
export function NotebookSurface() {
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveCardGenerationRunId = useRoomStore((state) => state.setActiveCardGenerationRunId);
  const activeNoteRef = useRoomStore((state) => state.activeNoteRef);
  // 协同流只在协作空间里存在（personal 按门控不建长连接），所以订阅与否看它。
  const spaceIdentity = useRoomStore((state) => state.spaceIdentity);
  const setReturnTarget = useRoomStore((state) => state.setReturnTarget);
  const editorRef = useRef<NoteMarkdownEditorHandle | null>(null);
  const editorPaneRef = useRef<HTMLDivElement>(null);
  const epochRef = useRef<number | undefined>(undefined);
  const syncedNoteRef = useRef<string | null>(null);
  const saveRef = useRef<() => void>(() => {});
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [draft, setDraft] = useState({ title: "", content: "" });
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "committed" | "error">("idle");
  const [receipt, setReceipt] = useState<{
    savedAt: string;
    isAutosave: boolean;
    /**
     * 这一次走的是长连接还是 HTTP。它不是装饰：流式那条只说明"本机已并进文档"，
     * 服务端落盘还要等 Hocuspocus 的 debounce，保存行不能说成"已保存"。
     */
    via: "stream" | "uploaded" | "unchanged" | "queued";
  } | null>(null);
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const [startingGeneration, setStartingGeneration] = useState(false);
  const [generationFailure, setGenerationFailure] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [options, setOptions] = useState<GenerationOptions>(persistedGenerationOptions);
  const [showAllBlocks, setShowAllBlocks] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [feedbackReasons, setFeedbackReasons] = useState<readonly DesktopCardGenerationFeedbackReasonV2[]>([]);
  const [feedbackNote, setFeedbackNote] = useState("");
  const [versions, setVersions] = useState<readonly DesktopNoteVersionItem[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsFailure, setVersionsFailure] = useState<string | null>(null);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);
  /**
   * The draft lives in a ref as well as in state: the autosave needs the current
   * text outside a render, and the unmount flush has to close over the latest
   * draft without a render-phase read.
   */
  const draftRef = useRef({ title: "", content: "" });

  /** The one way the draft changes, so state and ref cannot drift apart. */
  const applyDraft = useCallback((next: { title: string; content: string }) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  /** 正文变了而标题没变时只替换正文那一半：编辑器输入与上传回填都走这里。 */
  const applyContent = useCallback((content: string) => {
    applyDraft({ ...draftRef.current, content });
  }, [applyDraft]);

  const { data, loading, failure, reload } = useSurfaceProjection(async ({ workspaceEpoch }) => {
    const api = desktopApi();
    if (!api) throw new Error("桌面端 API 不可用，无法读取真实笔记。");
    const projectionResponse = await api.room.getProjection({ meta: createRequestMeta(workspaceEpoch) });
    if (projectionResponse.workspaceEpoch) epochRef.current = projectionResponse.workspaceEpoch;
    const projection = unwrapGatewayResult(projectionResponse);
    const focus = projection.primaryFocus.state === "data" ? projection.primaryFocus.data : null;
    const primaryNote = focus?.objective.sources.primaryNote ?? null;
    const noteId = activeNoteRef?.noteId ?? primaryNote?.noteId;
    if (!noteId) {
      throw new Error("这一篇笔记还没定下来是哪一篇，不能编辑，也不能生成学习卡。");
    }
    const noteResponse = await api.note.get({ meta: createRequestMeta(epochRef.current), noteId });
    if (noteResponse.workspaceEpoch) epochRef.current = noteResponse.workspaceEpoch;
    const note = unwrapGatewayResult(noteResponse);

    const capabilityResponse = await api.capabilities.get({ meta: createRequestMeta(epochRef.current) });
    if (capabilityResponse.workspaceEpoch) epochRef.current = capabilityResponse.workspaceEpoch;

    let source: DesktopSourceDetail | null = null;
    let sourceFailure: string | null = null;
    if (note.sourceId) {
      try {
        const sourceResponse = await api.source.get({
          meta: createRequestMeta(epochRef.current),
          sourceId: note.sourceId,
        });
        if (sourceResponse.workspaceEpoch) epochRef.current = sourceResponse.workspaceEpoch;
        source = unwrapGatewayResult(sourceResponse);
      } catch (error) {
        sourceFailure = gatewayErrorMessage(error);
      }
    }

    // A note that has never been generated answers 404, which is an ordinary
    // state: the page then simply has no previous run to respond to.
    let latestGenerationRun: CardGenerationRunSnapshotV1 | null = null;
    if ((api.contract.enabledRoutes ?? []).includes("note.cardGeneration")) {
      try {
        latestGenerationRun = unwrapGatewayResult(await api.note.cardGeneration.latestRun({
          meta: createRequestMeta(epochRef.current),
          noteId: note.noteId,
        }));
      } catch {
        latestGenerationRun = null;
      }
    }

    return {
      note,
      source,
      sourceFailure,
      objective: focus && focus.objective.sources.primaryNote?.noteId === note.noteId
        ? focus.objective
        : null,
      capabilities: unwrapGatewayResult(capabilityResponse),
      activeGeneration: projection.activeGenerationSummary,
      latestGenerationRun,
    } satisfies NotebookProjection;
  }, [activeNoteRef?.noteId]);

  // The pill returns to whatever opened this note: the library, the
  // card-generation workbench the reader stepped out of, or the star map a
  // star was clicked on. It never skips a level up to the study room.
  useEffect(() => {
    const returnTo = useRoomStore.getState().noteReturnTo;
    setReturnTarget(returnTo === "generation"
      ? { label: "返回生成任务", run: () => invoke("open-card-generation") }
      : returnTo === "graph"
        ? { label: "返回星图", run: () => invoke("graph") }
        : { label: "返回笔记库", run: () => invoke("open-notes") });
    return () => setReturnTarget(null);
  }, [invoke, setReturnTarget]);

  const note = data?.note ?? null;
  const source = data?.source ?? null;
  const sourceFailure = data?.sourceFailure ?? null;
  const objective = data?.objective ?? null;
  const capabilities = data?.capabilities ?? null;
  const activeGenerations = data?.activeGeneration?.state === "data" ? data.activeGeneration.data : [];
  // 这篇笔记自己的在制批次。一个工作区可以同时有多篇笔记各自在制一批卡，所以
  // 必须按 noteId 找，不能取「最近更新的那一个」——此前取的是后者，于是第二篇
  // 笔记的在制 run 一出现，这篇笔记的守卫就失效，「生成学习卡」可以再点一次
  // （2026-09-20 实走复盘 #5）。run 在服务端跑，页面必须显示它的步骤而不是
  // 对同一个版本再开一次。
  const noteGeneration: CardGenerationActiveSummaryV1 | null = note
    ? activeGenerations.find((generation) => isLiveGenerationForNote(generation, note.noteId)) ?? null
    : null;
  const latestRun = data?.latestGenerationRun ?? null;
  // Only a run that has stopped can be answered; while one is live the page
  // offers the status sync instead of a second start.
  const feedbackTarget = latestRun && FINISHED_RUN_STATUSES.has(latestRun.status) ? latestRun : null;
  const segments = source?.segments ?? [];
  // Every block type — including images, which the editor writes as one
  // markdown line — has a text form now, so editability is a pure permission.
  const editable = Boolean(note?.permissions.canEdit);
  // A draft that has not been seeded for this note yet is not a local edit. The
  // first paint after a note arrives carried an empty draft, so the page flashed
  // 草稿/有未提交编辑 and disabled the generation entry for one frame before the
  // sync effect ran.
  const draftSeeded = Boolean(note && syncedNoteRef.current === note.noteId);
  // Dirty is a statement about versions: the editor's Markdown must save into a
  // different block list than the committed one. Whitespace the block model
  // cannot represent (a trailing newline, a collapsed blank line) must not keep
  // the page dirty forever — that re-saved the same version on every autosave
  // tick. Both sides go through `blockBody`, so a version written by the Web
  // client also compares as clean instead of looking edited the moment it opens.
  const dirty = Boolean(
    draftSeeded && note
    && (draft.title !== note.title || (editable && !blocksMatchMarkdown(draft.content, note.currentVersion.blocks))),
  );
  const mark = useMemo(
    () => conceptMark(note?.currentVersion.blocks ?? [], objective?.content.conceptLabel),
    [note, objective],
  );
  const allBlocks = note?.currentVersion.blocks ?? [];
  const readingBlocks = showAllBlocks || allBlocks.length <= READING_WINDOW
    ? allBlocks
    : allBlocks.slice(0, READING_WINDOW);
  const hiddenBlockCount = allBlocks.length - readingBlocks.length;

  // 这篇笔记的全部图片，按正文顺序排好；顺带记下每个图片块在画廊里的序号，
  // 让正文里的缩略图点击时知道自己该打开第几张。块列表来自已提交版本，
  // 一次渲染内不变，memo 只是让这张索引表不随无关状态重算。
  const noteImages = useMemo(() => {
    const images: GalleryImage[] = [];
    const ordinalToIndex = new Map<number, number>();
    for (const block of allBlocks) {
      if (block.type !== "image") continue;
      const image = parseImageBlock(block.content);
      if (!image) continue;
      ordinalToIndex.set(block.ordinal, images.length);
      // 笔记块里存的是站内地址：画廊切到哪张才取哪张的字节。
      images.push({ kind: "internal", url: image.url, alt: image.alt || "笔记图片" });
    }
    return { images, ordinalToIndex };
  }, [allBlocks]);
  // 画廊的开关状态收在通用钩子里（本页只负责 openAt/close 的接线）。
  const noteGallery = useImageLightbox(noteImages.images.length);

  // The server record is the source of truth, but local keystrokes win while a
  // save is still in flight: the draft is only replaced when nothing is pending.
  useEffect(() => {
    if (!note) return;
    const firstLoadForNote = syncedNoteRef.current !== note.noteId;
    if (firstLoadForNote) {
      syncedNoteRef.current = note.noteId;
      // Reading is the page a note opens on; only an explicit "继续写" — or a
      // home entry that asks for it — lands in the editor.
      setMode(note.permissions.canEdit && activeNoteRef?.mode === "edit" ? "edit" : "read");
      setReceipt(null);
      setSaveState("idle");
      setHistoryOpen(false);
      setVersions(null);
      setVersionsFailure(null);
      setShowAllBlocks(false);
      noteGallery.close();
    }
    const pendingLocalEdit = !firstLoadForNote
      && (draft.title !== note.title || (editable && !blocksMatchMarkdown(draft.content, note.currentVersion.blocks)));
    if (pendingLocalEdit) return;
    // A server-confirmed version is not an undo step: it is where the draft is
    // supposed to be.
    const content = blocksToMarkdown(note.currentVersion.blocks);
    applyDraft({ title: note.title, content });
    // 编辑器只在正文确实与这一版不同时才被整体替换。每次自动保存之后的回读都会
    // 走到这里，而那时的正文本来就一致——整体替换会把作者刚敲下的撤销栈一起抹掉。
    const current = editorRef.current?.getMarkdown() ?? null;
    if (current === null || !blocksMatchMarkdown(current, note.currentVersion.blocks)) {
      editorRef.current?.setMarkdown(content, firstLoadForNote);
    }
  }, [note, editable, activeNoteRef?.mode, applyDraft]);

  const save = useCallback(async (reason: "auto" | "manual") => {
    const api = desktopApi();
    const current = data?.note ?? null;
    if (!api || !current || !current.permissions.canSave || saving || !dirty) return;
    const nextTitle = draft.title;
    const nextContent = draft.content;
    setSaving(true);
    setSaveState("saving");
    setSaveFailure(null);
    try {
      // 正文与标题都交给文档增量（批次 4.4）。原来一次保存同时提交**整篇正文**和一个
      // 版本指针：两扇窗口都还在编辑时，后提交的那一次把前一次的正文原地改掉，而且
      // 没有版本可回去。现在交的是"我改了哪些块"，合并由 CRDT 负责——内容这条路上
      // 不再存在"覆盖"这个动作。（谁先「提交并确认」仍然会先推进版本指针，后一次
      // 确认拿旧令牌会被 409 挡下来，那是版本历史的顺序问题，与正文覆盖是两回事。）
      const submitted = await api.note.doc.syncBlocks({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId("note-doc"),
        noteId: current.noteId,
        ...(editable ? { blocks: markdownToBlocks(nextContent) } : {}),
        // 屏幕上写的是什么就定成什么（与改造前一致：手动提交的标题按 manual 记）。
        title: { title: nextTitle, titleSource: "manual" as const },
      });
      if (submitted.workspaceEpoch) epochRef.current = submitted.workspaceEpoch;
      const written = unwrapGatewayResult(submitted);
      if (reason === "manual") {
        // 「提交并确认」多走一步：把文档此刻定成一个可回去的版本。它不再带正文。
        const response = await api.note.save({
          meta: createRequestMeta(epochRef.current),
          commandId: createCommandId("note-save"),
          noteId: current.noteId,
          request: {
            version: 1,
            baseVersionId: current.currentVersionId,
          },
        });
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        const committed = unwrapGatewayResult(response);
        setReceipt({ savedAt: committed.savedAt, isAutosave: false, via: "uploaded" });
      } else {
        setReceipt({ savedAt: written.savedAt, isAutosave: true, via: written.via });
      }
      setSaveState("committed");
      await reload();
    } catch (error) {
      setSaveState("error");
      setSaveFailure(gatewayErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [data, dirty, draft, editable, reload, saving]);

  // The writer's generation settings are a session choice, like the library's view.
  useEffect(() => {
    persistedGenerationOptions = options;
  }, [options]);

  // Debounced autosave: the save-line reports the server receipt, never a local guess.
  // A failed save is sticky: the effect must not re-arm, or every AUTOSAVE_DELAY_MS
  // would flip the save-line between "正在提交…" and the failure notice — the
  // flicker. Recovery paths: the "重试保存" button, or a new keystroke (the
  // effect below clears the error so the debounce restarts naturally).
  useEffect(() => {
    if (mode !== "edit" || !note?.permissions.canSave || !dirty || saving || saveState === "error") {
      return undefined;
    }
    const timer = window.setTimeout(() => { void save("auto"); }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft, mode, note, save, saving, dirty, saveState]);

  // Editing again after a failed save clears the sticky error so autosave can
  // resume. Keyed on the draft object, which only changes on real input — the
  // failed save itself leaves the draft untouched and the error stays put.
  useEffect(() => {
    setSaveState((current) => (current === "error" ? "idle" : current));
  }, [draft]);

  // Leaving the page while the debounce is still pending must not drop keystrokes.
  // The ref is refreshed in an effect (not during render) so the unmount save
  // always closes over the latest draft without a render-phase side effect.
  useEffect(() => {
    saveRef.current = () => { void save("auto"); };
  });
  useEffect(() => () => saveRef.current(), []);

  /**
   * 粘贴/拖进来、或经工具栏选中的图片。只在可写时开放：只读身份连正文都改不了，
   * 更不该往对象存储里写东西。
   */
  const imageUploads = useNoteImageUploads({
    noteId: note?.noteId ?? null,
    editorRef,
    onContentChange: applyContent,
    getContent: () => draftRef.current.content,
    disabled: !editable || !note?.permissions.canSave,
  });

  const api = desktopApi();
  const routes = api?.contract.enabledRoutes ?? [];
  const generationRoutes = routes.includes("note.detail") && routes.includes("note.cardGeneration");
  const generationEnabled = Boolean(
    capabilities
    && generationRoutes
    && capabilities.actionCapabilities["card_generation.start"] === "allowed"
    && capabilities.featureAvailability.card_generation_v2.state === "enabled",
  );
  const generationReason = generationEnabled
    ? null
    : !capabilities
      ? "正在确认 Card Generation 能力。"
      : !generationRoutes
        ? "这台电脑还没有开放生成学习卡的入口。"
        : capabilities.featureAvailability.card_generation_v2.state !== "enabled"
          ? "学习卡生成现在没有开放。"
          // 能力位被拒和开关没开是两件事：把前者说成后者，读者会以为去找管理员
          // 开功能，而真实原因是在这个空间里自己是只读身份。
          : "生成学习卡由空间所有者发起，你在这个空间是成员。";

  const startGeneration = async () => {
    if (!api || !note || dirty || startingGeneration || !generationEnabled) return;
    setStartingGeneration(true);
    setGenerationFailure(null);
    try {
      const response = await api.note.cardGeneration.start({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId("card-generation-start"),
        noteId: note.noteId,
        request: {
          version: 2,
          noteVersionId: note.currentVersionId,
          sourceScope: { kind: "whole_note" },
          learningGoal: options.learningGoal,
          detailThreshold: options.detailThreshold,
          quantity: { kind: "adaptive", hardMaxCards: options.hardMaxCards },
          preferredStrategies: [...options.preferredStrategies],
          ...(feedbackTarget && feedbackReasons.length
            ? {
                feedbackContext: {
                  previousRunId: feedbackTarget.runId,
                  reasonCodes: [...feedbackReasons],
                  ...(feedbackNote.trim() ? { optionalNote: feedbackNote.trim() } : {}),
                },
              }
            : {}),
          clientRequestId: createCommandId("card-generation-request"),
        },
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const accepted = unwrapGatewayResult(response);
      setActiveCardGenerationRunId(accepted.runId);
      setFeedbackReasons([]);
      setFeedbackNote("");
      invoke("open-card-generation");
    } catch (error) {
      setGenerationFailure(gatewayErrorMessage(error));
      // 被服务端拒绝说明页面看到的是过期状态（这篇笔记已有一批在制，或配额已满）。
      // 不重读的话入口会一直停在「生成学习卡」，用户点一次撞一次 409。
      reload();
    } finally {
      setStartingGeneration(false);
    }
  };

  // Live status sync while this page stays open: one cardGeneration
  // subscription per known run. Each event triggers a silent re-read of the
  // projection — the entry button and status line follow the run's real step
  // without a loading paper over the writer's text, and without offering a
  // second start for the same note version.
  const noteGenerationRunId = noteGeneration?.runId ?? null;
  // 别人（同机另一个窗口、另一台机器、另一个人）改了这一篇：帧只负责"叫醒一次回读"，
  // 要不要替换正文仍由上面那条回读效应判——作者手上有未提交的改动时不替换。
  const noteDocLive = useNoteDocLiveView(
    note?.noteId ?? null,
    spaceIdentity !== null && !spaceIdentity.isPersonal,
    () => {
      void reload({ silent: true });
    },
  );

  useEffect(() => {
    if (!noteGenerationRunId || !window.ailearn) return undefined;
    let disposed = false;
    let subscriptionId: string | null = null;
    let unsubscribeEvent: (() => void) | undefined;
    const subscribe = async () => {
      try {
        const response = await window.ailearn.subscriptions.subscribe({
          meta: createRequestMeta(),
          topic: { kind: "cardGeneration", runId: noteGenerationRunId },
        });
        if (disposed) return;
        subscriptionId = unwrapGatewayResult(response).subscriptionId;
        unsubscribeEvent = window.ailearn.subscriptions.onEvent(subscriptionId, () => {
          void reload({ silent: true });
        });
      } catch {
        // Streaming is progressive enhancement: the status still refreshes on
        // remount, on focus of another page, and through the workbench itself.
      }
    };
    void subscribe();
    return () => {
      disposed = true;
      unsubscribeEvent?.();
      if (subscriptionId) {
        void window.ailearn.subscriptions.unsubscribe({
          meta: createRequestMeta(),
          subscriptionId,
        });
      }
    };
  }, [noteGenerationRunId, reload]);

  const openGeneration = () => {
    if (!noteGeneration) return;
    setActiveCardGenerationRunId(noteGeneration.runId);
    invoke("open-card-generation");
  };

  /**
   * 编辑器里的键盘约定。加粗、斜体、行内代码、撤销、重做都归 Milkdown 自己的
   * 快捷键；这一层只管纸张语境里的两条：⌘S 立即提交、⌘K 插入链接。
   */
  const onEditorKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      void save("manual");
    } else if (key === "k") {
      event.preventDefault();
      editorRef.current?.toggleLink("https://");
    }
  };

  const runTool = (tool: EditorToolSpec) => {
    const editor = editorRef.current;
    if (editor) tool.run(editor);
  };

  const page: HudPageId = mode === "edit" ? "note-edit" : "note-read";
  useHudPage(page);

  const sourceTitle = source?.source.title ?? (note?.sourceId ? "来源暂时不可读" : "没有关联来源");
  const validationLabel = objective?.personal.lastCanonicalAt
    ? formatRelative(objective.personal.lastCanonicalAt)
    : "尚未开始";
  const firstSegment = segments[0] ?? null;
  // Dirty outranks the last receipt: after a save the state stays "committed"
  // until the next one starts, so checking the receipt first made the line claim
  // "已自动保存" while keystrokes were still uncommitted — and the page's own
  // 草稿 tag said the opposite.
  const saveLabel = saving || saveState === "saving"
    ? "● 正在提交…"
    : saveState === "error"
      ? "● 这次提交没成功，你写的还在本机"
      : dirty
        ? "● 有未提交编辑"
        : saveState === "committed" && receipt
          ? // 流式那条只能说"已写入、正在同步"：服务端落盘还要等 Hocuspocus 的空闲
            // 刷写。把本机接受说成已保存，就是这次审查里"看起来存下来了"那一类错觉。
            `● ${receipt.isAutosave
              ? receipt.via === "queued"
                ? "没网，已记在本机，联网后自动交上去"
                : receipt.via === "stream" ? "已写入，正在同步" : "已自动保存"
              : "已提交并确认"} · ${formatClock(receipt.savedAt)}`
          : "● 已经存好，和服务器上的版本一致";

  const openSource = () => {
    if (!note?.sourceId) return;
    useRoomStore.getState().setActiveSourceId(note.sourceId);
    invoke("open-source");
  };

  // 模式跟随 activeNoteRef 走：从工作台"返回笔记"时，用户回到的是离开时的
  // 编辑/阅读模式，而不是每次都被重置成阅读页。
  const switchMode = (next: "read" | "edit") => {
    // The reading page renders the server version, so a draft still waiting for
    // the debounce has to be committed first — otherwise switching to 只读查看
    // looked exactly like losing the last sentence.
    if (next === "read" && dirty && note?.permissions.canSave && !saving) void save("auto");
    setMode(next);
    const store = useRoomStore.getState();
    if (note && store.activeNoteRef?.noteId === note.noteId && store.activeNoteRef.mode !== next) {
      store.setActiveNoteRef({ ...store.activeNoteRef, mode: next });
    }
  };

  /**
   * The immutable versions of this note, read on demand. The list carries no
   * bodies: a version is read by making it current again, which is also the only
   * way back to text a save or a tool edit replaced.
   */
  const loadVersions = async () => {
    const api = desktopApi();
    const current = data?.note ?? null;
    if (!api || !current) return;
    setVersionsLoading(true);
    setVersionsFailure(null);
    try {
      const response = await api.note.versions({
        meta: createRequestMeta(epochRef.current),
        noteId: current.noteId,
        currentVersionId: current.currentVersionId,
        limit: 50,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setVersions(unwrapGatewayResult(response).items);
    } catch (error) {
      setVersionsFailure(gatewayErrorMessage(error));
    } finally {
      setVersionsLoading(false);
    }
  };

  const restoreVersion = async (version: DesktopNoteVersionItem) => {
    const api = desktopApi();
    const current = data?.note ?? null;
    if (!api || !current || restoringVersionId) return;
    setRestoringVersionId(version.versionId);
    setVersionsFailure(null);
    try {
      const response = await api.note.restoreVersion({
        meta: createRequestMeta(epochRef.current),
        noteId: current.noteId,
        versionId: version.versionId,
        baseVersionId: current.currentVersionId,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      await reload();
      await loadVersions();
    } catch (error) {
      setVersionsFailure(`恢复未确认：${gatewayErrorMessage(error)}`);
    } finally {
      setRestoringVersionId(null);
    }
  };

  const statePaper = loading ? (
    <SurfaceDataState kind="loading" message="正在读取真实笔记" detail="先确认工作区、Note identity 与当前版本。" />
  ) : failure ? (
    <SurfaceDataState kind="error" message="研究册暂时不可用" detail={failure} onRetry={() => void reload()} />
  ) : !note ? (
    <SurfaceDataState kind="empty" message="当前书房还没有主笔记" detail="这篇笔记没有给出可编辑的版本，这一页不会在本机另存草稿。" />
  ) : null;

  const clips = (
    <div className="source-clips">
      <div className="clip">
        {/* The projection exposes the source's parsed fragments, not a
            note-level evidence binding, so this clip names what it really is:
            the source's first fragment. Calling it 证据 claimed an alignment
            nothing in the record provides. */}
        <b>{firstSegment ? `来源片段 ${String(firstSegment.ordinal).padStart(2, "0")}` : "来源片段"}</b>
        <br />
        {firstSegment
          ? excerpt(firstSegment.text)
          : sourceFailure
            ? `来源暂时不可读：${sourceFailure}`
            : "当前笔记尚未关联来源"}
      </div>
      <div className="clip">
        <b>来源关系</b>
        <br />
        {source
          ? `${source.source.title} · ${segments.length} 段已解析片段`
          : note?.sourceId
            ? "来源暂时读不到"
            : "未关联来源"}
      </div>
    </div>
  );

  // One generation entry shared by the reading and editor action rows. With a
  // live run it navigates to the workbench (never starts a second run, so it
  // ignores `dirty` — viewing progress needs no clean save); without one it
  // starts a generation from the committed whole-note version.
  const generationAction = noteGeneration ? (
    <button
      type="button"
      className="button primary"
      title="这次生成在后台进行，来回翻看不会打断它"
      onClick={openGeneration}
    >
      {isCardGenerationInFlight(noteGeneration.status)
        ? <LoaderCircle className="run-spinner" size={15} aria-hidden="true" />
        : <Sparkles size={15} aria-hidden="true" />}
      {cardGenerationEntryLabel(noteGeneration.status)}
    </button>
  ) : (
    <button
      type="button"
      className="button primary"
      disabled={!generationEnabled || dirty || startingGeneration}
      title={generationReason ?? "用已经存好的整篇版本生成学习卡"}
      onClick={() => void startGeneration()}
    >
      <Sparkles size={15} aria-hidden="true" />
      {startingGeneration ? "正在创建生成任务…" : "生成学习卡"}
    </button>
  );

  const generationLiveNote = noteGeneration ? (
    <p className="small notebook-note notebook-generation-live" role="status">
      学习卡{cardGenerationStatusLabel(noteGeneration.status)} · 后台进行中，可随时回到本页，进度不会丢失。
    </p>
  ) : null;

  // The reading page splits into a scrolling body and the pinned action row:
  // the paper is the scroll container's child, so the buttons stay reachable on
  // a note longer than one screen.
  /**
   * 版本历史 + 生成设置两个面板。此前只有阅读页能拉开它们，编辑页里同样的 state
   * （`historyOpen` / `optionsOpen`）就在同一个组件中，却没有任何入口（复盘 #15）。
   * 恢复历史版本在草稿未提交时仍然被按钮自己的 `dirty` 判断挡住。
   */
  const historyAndOptionsPapers = (
    <>
      {historyOpen ? (
        <section className="version-history" aria-label="笔记版本历史">
          <h3 className="serif">版本历史</h3>
          <p className="small">
            每次提交都会留下一个不可变版本。恢复会把这篇笔记切回那一版，不会删除任何版本。
          </p>
          {versionsLoading ? <p className="small" role="status">正在读取版本历史…</p> : null}
          {!versionsLoading && versionsFailure ? (
            <p className="small notebook-note" role="alert">
              {versionsFailure}
              <button type="button" className="text-action text-action--strong" onClick={() => void loadVersions()}>
                重新读取
              </button>
            </p>
          ) : null}
          {!versionsLoading && !versionsFailure && versions?.length === 0 ? (
            <p className="small">这篇笔记还没有可列出的版本。</p>
          ) : null}
          {!versionsLoading && !versionsFailure && versions?.length ? (
            <ul className="version-list">
              {versions.map((version) => (
                <li key={version.versionId} className={version.current ? "current" : undefined}>
                  <span className="version-no">v{version.versionNo}</span>
                  <span className="version-time">{formatRelative(version.createdAt)}</span>
                  {version.current ? (
                    <span className="version-tag">当前版本</span>
                  ) : (
                    <button
                      type="button"
                      className="text-action text-action--strong"
                      disabled={!editable || dirty || restoringVersionId !== null}
                      title={!editable
                        ? "你在这个空间是只读身份，不能改写这篇笔记的版本"
                        : dirty
                          ? "先提交或撤销当前编辑，再恢复历史版本"
                          : "把这篇笔记切回这一版，不删除任何版本"}
                      onClick={() => void restoreVersion(version)}
                    >
                      {restoringVersionId === version.versionId ? "正在恢复…" : "恢复这一版"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {/* The knobs the run contract accepts, so a generation is not silently
          fixed to one goal, one depth, one limit and two of seven strategies. */}
      {optionsOpen && generationEnabled ? (
        <fieldset className="generation-options">
          <legend>这次生成怎么出题</legend>
          <div className="generation-options__row">
            <span className="generation-options__label">学习目标</span>
            {LEARNING_GOALS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={options.learningGoal === item.value ? "chip on" : "chip"}
                aria-pressed={options.learningGoal === item.value}
                onClick={() => setOptions((current) => ({ ...current, learningGoal: item.value }))}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="generation-options__row">
            <span className="generation-options__label">详略</span>
            {DETAIL_THRESHOLDS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={options.detailThreshold === item.value ? "chip on" : "chip"}
                aria-pressed={options.detailThreshold === item.value}
                onClick={() => setOptions((current) => ({ ...current, detailThreshold: item.value }))}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="generation-options__row">
            <span className="generation-options__label">卡片上限</span>
            {CARD_LIMITS.map((limit) => (
              <button
                key={limit}
                type="button"
                className={options.hardMaxCards === limit ? "chip on" : "chip"}
                aria-pressed={options.hardMaxCards === limit}
                onClick={() => setOptions((current) => ({ ...current, hardMaxCards: limit }))}
              >
                {limit} 张
              </button>
            ))}
          </div>
          <div className="generation-options__row">
            <span className="generation-options__label">题型</span>
            {STRATEGIES.map((item) => {
              const on = options.preferredStrategies.includes(item.value);
              return (
                <button
                  key={item.value}
                  type="button"
                  className={on ? "chip on" : "chip"}
                  aria-pressed={on}
                  // The run contract wants at least one strategy; the last one on
                  // stays on rather than sending an empty list.
                  disabled={on && options.preferredStrategies.length === 1}
                  title={on && options.preferredStrategies.length === 1 ? "至少保留一种题型" : undefined}
                  onClick={() => setOptions((current) => ({
                    ...current,
                    preferredStrategies: on
                      ? current.preferredStrategies.filter((value) => value !== item.value)
                      : [...current.preferredStrategies, item.value],
                  }))}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
          {/* 让勾选成为筛选。顺序由 planner-service.allocateStrategies 按适配度定，
              与勾选顺序无关——这里说清，是因为默认值就是全勾选。 */}
          <p className="small">
            已默认全选：每张卡用哪种题型由系统按笔记内容决定。取消某种即不要它，
            但每种知识只有少数几种题型问得自然，系统会在这些范围内挑。
          </p>
          {feedbackTarget ? (
            <>
              <div className="generation-options__row">
                <span className="generation-options__label">针对上次</span>
                <span className="small">
                  上次生成{cardGenerationStatusLabel(feedbackTarget.status)} · {formatRelative(feedbackTarget.updatedAt)}
                  {feedbackReasons.length ? "" : "（选原因即按反馈重生成）"}
                </span>
              </div>
              <div className="generation-options__row">
                {FEEDBACK_REASONS.map((item) => {
                  const on = feedbackReasons.includes(item.value);
                  return (
                    <button
                      key={item.value}
                      type="button"
                      className={on ? "chip on" : "chip"}
                      aria-pressed={on}
                      onClick={() => setFeedbackReasons((current) => (on
                        ? current.filter((value) => value !== item.value)
                        : [...current, item.value]))}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
              {feedbackReasons.length ? (
                <div className="generation-options__row">
                  <span className="generation-options__label">补充说明</span>
                  <input
                    className="generation-options__note"
                    value={feedbackNote}
                    maxLength={2000}
                    placeholder="可选，写给下一次生成的说明"
                    aria-label="重新生成的补充说明"
                    onChange={(event) => setFeedbackNote(event.currentTarget.value)}
                  />
                </div>
              ) : null}
            </>
          ) : null}
          <p className="small">
            本次：{generationOptionSummary(options)}
            {feedbackTarget && feedbackReasons.length
              ? ` · 按反馈重生成（${feedbackReasons
                .map((value) => FEEDBACK_REASONS.find((item) => item.value === value)?.label ?? value)
                .join("+")}）`
              : ""}
          </p>
        </fieldset>
      ) : null}
    </>
  );

  const readPageBody = note ? (
    <>
      <div className="version-ribbon">
        <span>阅读</span>
        <span>版本 v{note.currentVersion.versionNo}</span>
        <span>来源片段 {segments.length}</span>
      </div>
      <h2 className="title">{note.title || "未命名笔记"}</h2>
      <div className="meta">
        <span>{formatRelative(note.currentVersion.updatedAt)}</span>
        <span>{note.sourceId ? `关联来源 ${source?.source.title ?? "暂时读不到"}` : "未关联来源"}</span>
        <span>{objective ? `理解目标：${objective.content.conceptLabel ?? "未命名目标"}` : "未关联理解目标"}</span>
      </div>
      <div className="rule" />
      <div className="reading-body">
        {note.currentVersion.blocks.length ? readingBlocks.map((block) => (
          <ReadingBlock
            key={block.ordinal}
            block={block}
            mark={mark?.ordinal === block.ordinal ? mark.range : null}
            workspaceEpoch={epochRef.current}
            imageIndex={noteImages.ordinalToIndex.get(block.ordinal)}
            imageOpen={noteGallery.openIndex !== null
              && noteImages.ordinalToIndex.get(block.ordinal) === noteGallery.openIndex}
            onOpenImage={(open) => {
              const index = noteImages.ordinalToIndex.get(block.ordinal);
              if (open && index !== undefined) noteGallery.openAt(index);
              else noteGallery.close();
            }}
          />
        )) : <p className="small">这一版正文还没有段落。</p>}
        {hiddenBlockCount > 0 ? (
          <div className="actions reading-more">
            <button type="button" className="button" onClick={() => setShowAllBlocks(true)}>
              展开剩余 {hiddenBlockCount} 段
            </button>
          </div>
        ) : null}
      </div>
      <div className="provenance-line">
        <span>来源：{sourceTitle}</span>
        <span>不可变版本：v{note.currentVersion.versionNo} · {note.currentVersion.contentHash.slice(0, 8)}</span>
        <span>最近验证：{validationLabel}</span>
      </div>
      {/* The pasted source clips read as part of the provenance cluster, so they
          sit in the flow right after it. They used to hang absolute off the
          paper's right edge; real excerpts ran long and the sticky notes
          covered body text and table columns. */}
      {clips}
      {/* Leaving the editor now commits the pending draft first, so a reader who
          lands here must be told what happened to it instead of seeing the older
          server text with no explanation. */}
      {saving || dirty ? (
        <p className="small notebook-note" role="status">
          {saving ? "正在提交刚才的编辑…" : "有未提交编辑，切回编辑继续写。"}
        </p>
      ) : null}
      {saveState === "error" ? (
        <p className="small notebook-note" role="alert">
          保存没成功：{saveFailure}
          <button
            type="button"
            className="text-action text-action--strong"
            disabled={saving}
            onClick={() => void save("manual")}
          >
            重试保存
          </button>
        </p>
      ) : null}
      {generationReason ? <p className="small notebook-note">{generationReason}</p> : null}
      {generationFailure ? <p className="small notebook-note" role="alert">{generationFailure}</p> : null}
      {generationLiveNote}
      {historyAndOptionsPapers}
    </>
  ) : null;

  /**
   * 「版本历史」「生成设置」两个开关。阅读页与编辑页共用同一对：面板已经在同一
   * 个组件里了（`historyAndOptionsPapers`），此前只有阅读页摆出按钮，编辑态摸不到
   * （复盘 #15）。
   */
  const versionAndOptionsToggles = note ? (
    <>
      <button
        type="button"
        className="button"
        aria-expanded={historyOpen}
        onClick={() => {
          const next = !historyOpen;
          setHistoryOpen(next);
          if (next) void loadVersions();
        }}
      >
        版本历史
      </button>
      {generationEnabled && !noteGeneration ? (
        <button
          type="button"
          className="button"
          aria-expanded={optionsOpen}
          title={`生成设置 · 本次：${generationOptionSummary(options)}`}
          onClick={() => setOptionsOpen((open) => !open)}
        >
          生成设置
        </button>
      ) : null}
    </>
  ) : null;

  const readPageActions = note ? (
    <div className="actions notebook-actions">
      {!note.permissions.canEdit ? <span className="tag">只读</span> : null}
      {note.permissions.canEdit ? (
        <button type="button" className="button primary" onClick={() => switchMode("edit")}>
          编辑这篇笔记
        </button>
      ) : null}
      <button type="button" className="button" onClick={openSource} disabled={!note.sourceId}>
        查看关联来源
      </button>
      {versionAndOptionsToggles}
      {generationAction}
    </div>
  ) : null;

  /**
   * 编辑页固定在纸面顶部的两条：状态/版本那一行，和格式工具栏。
   *
   * 它们原先随正文一起滚——一篇两屏的笔记里，写到第二屏就再够不到"只读查看"，
   * 也看不到这一版提交没有。现在纸面是一个纵向 flex：这两条装进
   * `.notebook-chrome`（不参与滚动），只有 `.notebook-scroll` 里的正文滚动。
   */
  const editChrome = note ? (
    <div className="notebook-chrome">
      <div className="editor-head">
        <div>
          <span className="tag red">{dirty || saveState === "error" ? "草稿" : "已同步"}</span>
      {noteDocLive.presenceCount > 0 ? (
        <span className="tag" title="这几个人也开着这一篇">
          {noteDocLive.presenceCount + 1} 人在看
        </span>
      ) : null}
          <span className="small">标题和正文每次改动都会存成一个版本</span>
        </div>
        <div className="meta">
          <span>{note.permissions.canSave ? "自动保存开启" : "当前身份不能保存"}</span>
          <span>版本 v{note.currentVersion.versionNo}</span>
          <button
            type="button"
            className="ribbon-action"
            onClick={() => switchMode("read")}
          >
            只读查看
          </button>
        </div>
      </div>
      <div className="editor-tools" role="toolbar" aria-label="Markdown 格式工具">
        {EDITOR_TOOLS.map((tool) => (
          <button
            key={tool.label}
            type="button"
            className="tool"
            disabled={!editable}
            aria-label={tool.label}
            title={tool.title}
            // 命令作用在当前选区上，按下去那一下不能把焦点从正文抢走。
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runTool(tool)}
          >
            {tool.glyph}
          </button>
        ))}
        <button
          type="button"
          className="tool"
          disabled={!editable || !note.permissions.canSave}
          aria-label="插入图片"
          title="插入图片 · 也可以直接把图片粘贴或拖进正文"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => imageUploads.fileInputRef.current?.click()}
        >
          图
        </button>
        <span className="editor-tools-legend">
          支持 Markdown · 所见即所得 · 停顿 1.2 秒自动保存 · 图片可粘贴或拖入
        </span>
        <input
          ref={imageUploads.fileInputRef}
          className="note-image-upload-input"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            imageUploads.queueFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
      </div>
    </div>
  ) : null;

  // The editor page, like the reading one: scrolling body, pinned actions and
  // receipt line. The fields stay editable while a save is in flight — the
  // save snapshots the draft, so typing during the round trip is safe.
  const editPageBody = note && draftSeeded ? (
    // Milkdown 的 defaultValueCtx 只在创建时读一次，所以编辑器按 noteId 重建：
    // 换一篇笔记就是换一个编辑器，而"恢复历史版本"这类同一篇里的整体替换走 ref 的
    // setMarkdown（见上面那个回读效应）。首帧不等 draftSeeded 就会用空正文建文档。
    <div className="editor-copy" ref={editorPaneRef} onKeyDown={onEditorKeyDown}>
      <h2>
        <label className="sr-only" htmlFor="notebook-surface-title">笔记标题</label>
        <input
          id="notebook-surface-title"
          value={draft.title}
          maxLength={200}
          disabled={!note.permissions.canEdit}
          placeholder="未命名笔记"
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              void save("manual");
            }
          }}
          onChange={(event) => {
            // Read the value during dispatch: `currentTarget` is nulled once
            // the event finishes, so the snapshot is taken here and handed to
            // the one draft setter.
            const { value } = event.currentTarget;
            applyDraft({ ...draftRef.current, title: value });
          }}
        />
      </h2>
      <label className="sr-only" htmlFor="notebook-surface-body">笔记正文</label>
      <div id="notebook-surface-body" data-surface-initial-focus={mode === "edit" ? "true" : undefined}>
        <NoteMarkdownEditor
          key={note.noteId}
          ref={editorRef}
          initialMarkdown={draft.content}
          onChange={applyContent}
          disabled={!editable}
          onImagePaste={imageUploads.queueFile}
        />
      </div>
      <NoteImageUploads
        uploads={imageUploads.uploads}
        error={imageUploads.error}
        onRetry={imageUploads.retry}
        onDismiss={imageUploads.dismiss}
      />
      {saveFailure ? <p className="small notebook-note" role="alert">保存没成功：{saveFailure}</p> : null}
      {generationReason ? <p className="small notebook-note">{generationReason}</p> : null}
      {generationFailure ? <p className="small notebook-note" role="alert">{generationFailure}</p> : null}
      {generationLiveNote}
      {historyAndOptionsPapers}
    </div>
  ) : null;

  const editPageActions = note ? (
    <div className="actions notebook-actions notebook-actions--editor">
      {/* 撤销/重做归编辑器自己的 history：正文里按 ⌘Z 就是它的原生行为，这一行
          不再替它摆一对按钮。 */}
      {note.permissions.canSave && dirty ? (
        <button type="button" className="button" disabled={saving} onClick={() => void save("manual")}>
          {saving ? "正在提交…" : "立即保存"}
        </button>
      ) : null}
      {saveState === "error" ? (
        <button type="button" className="button danger" disabled={saving} onClick={() => void save("manual")}>
          <RefreshCw size={15} aria-hidden="true" />重试保存
        </button>
      ) : null}
      {versionAndOptionsToggles}
      {generationAction}
    </div>
  ) : null;

  return (
    <>
      <HudPage page={page}>
        <article className="notebook" aria-busy={loading || undefined} data-mode={mode}>
          {statePaper ? <div className="notebook-scroll">{statePaper}</div> : null}
          {!loading && !failure && note ? (
            <>
              {mode === "edit" ? editChrome : null}
              <div className="notebook-scroll">{mode === "edit" ? editPageBody : readPageBody}</div>
              {mode === "edit" ? (
                <>
                  {editPageActions}
                  <div className="save-line">
                    <span role="status" aria-live="polite">{saveLabel}</span>
                    <span>当前版本 v{note.currentVersion.versionNo} · 来源片段 {segments.length}</span>
                  </div>
                </>
              ) : readPageActions}
            </>
          ) : null}
          {/* 阅读页的图片画廊：点击正文任一张图进入，左右切换整篇的图。
              variant="card"：遮罩只盖住这张纸面，不铺满整个窗口。 */}
          {noteGallery.isOpen && noteImages.images.length ? (
            <ImageGalleryLightbox
              images={noteImages.images}
              index={noteGallery.openIndex ?? 0}
              variant="card"
              workspaceEpoch={epochRef.current}
              onClose={noteGallery.close}
              onIndexChange={noteGallery.setIndex}
            />
          ) : null}
        </article>
      </HudPage>
    </>
  );
}

/** One stored block, drawn with the weight its own type carries on paper. */
function ReadingBlock({
  block,
  mark,
  workspaceEpoch,
  imageIndex,
  imageOpen,
  onOpenImage,
}: {
  readonly block: NoteBlockProjectionV1;
  /** Character range of the sentence this block contributes, when it has one. */
  readonly mark: readonly [number, number] | null;
  /** 站内图片的字节请求要带上它，工作区换了就不该再回旧图。 */
  readonly workspaceEpoch?: number;
  /** 这张图在整篇笔记图片画廊里的序号；不是图片块时为 undefined。 */
  readonly imageIndex?: number;
  /** 画廊此刻是否正开在这张图上（受控灯箱）。 */
  readonly imageOpen?: boolean;
  readonly onOpenImage?: (open: boolean) => void;
}) {
  if (block.type === "image") {
    // 图片块要先取字节再画图，所以由自己的组件承载状态：hook 不能排在这一串
    // 按块类型分叉的早返回之后。
    return (
      <ReadingImage
        block={block}
        workspaceEpoch={workspaceEpoch}
        imageOpen={imageOpen}
        onOpenImage={onOpenImage}
      />
    );
  }
  const text = noteBlockText(block.content);
  if (block.type === "heading") return <h3 className="serif">{text}</h3>;
  if (block.type === "code") return <pre className="code-block"><code>{text}</code></pre>;
  if (block.type === "list") return <p className="list-block">{text}</p>;
  if (block.type === "quote") return <p className="quote">{text}</p>;
  // Tables have no block type; a paragraph of pipe rows renders as one.
  const table = parseMarkdownTable(text);
  if (table) {
    const [header, ...rows] = table;
    return (
      <table className="md-table">
        <thead>
          <tr>{header.map((cell, index) => <th key={index}>{cell}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (!mark) return <p>{text}</p>;
  const [start, end] = mark;
  if (start >= end) return <p>{text}</p>;
  return (
    <p>
      {text.slice(0, start)}
      <span className="mark">{text.slice(start, end)}</span>
      {text.slice(end)}
    </p>
  );
}

/**
 * A stored image block (`![alt](url)`).
 *
 * 从来源起稿的笔记里，这个地址是 `/api/uploads/{objectKey}`：解析把网页内嵌图片
 * 下载进对象存储后改写的站内引用。渲染层的 origin 是 `ailearn-app://`，相对路径
 * 会落到应用包内，所以图由 main 带会话令牌取回字节，这里用 blob URL 画出来。
 * 站外地址仍原样交给 `<img>`；取不回来时只这一张缺位，正文照旧读下去。
 */
function ReadingImage({
  block,
  workspaceEpoch,
  imageOpen,
  onOpenImage,
}: {
  readonly block: NoteBlockProjectionV1;
  readonly workspaceEpoch?: number;
  readonly imageOpen?: boolean;
  readonly onOpenImage?: (open: boolean) => void;
}) {
  const image = parseImageBlock(block.content);
  const { state, retry } = useSourceImage(image?.url ?? "", workspaceEpoch);

  if (!image) return <p className="small">图片片段无法解析：{block.content}</p>;

  const alt = image.alt || "笔记图片";
  if (state.status === "external" || state.status === "ready") {
    return (
      <ZoomableReadingImage
        src={state.src}
        alt={alt}
        retryable={state.status === "ready"}
        onRetry={retry}
        open={imageOpen}
        onOpenChange={onOpenImage}
      />
    );
  }
  if (state.status === "loading") return <p className="small notebook-note">正在载入图片…</p>;
  return <p className="small notebook-note">这张图片没能取回：{alt}</p>;
}
