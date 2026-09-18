import { useCallback, useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ArrowRight, Check, CircleAlert, FileText, Link2, X } from "lucide-react";
import { extractCandidateLinks } from "@ailearn/shared/desktop-ipc-contracts";
import { useRoomStore } from "../app/room-store";
import { createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../app/desktop-client";
import { resolveSceneMotionMode } from "../scene/scene-motion";
import {
  MAX_CAPTURE_BYTES,
  MAX_DROP_FILES,
  TEXT_FILE_PATTERN,
  captureBytes,
  dispatchSourceCaptured,
  formatCaptureSize,
  hasOpenModal,
  isEditableTarget,
  markLinkSeen,
  readSeenLinks,
  titleFromFileName,
} from "../app/source-intake";

gsap.registerPlugin(useGSAP);

/** 采集栏已有自己的投放格：落在它头上就归它，别再铺全局浮层抢。 */
const OWNED_DROP_SELECTOR = ".capture-strip, .capture-form";

function isOwnedDropTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(OWNED_DROP_SELECTOR));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

async function canCaptureSource(): Promise<"allowed" | "denied" | "unknown"> {
  try {
    const response = await window.ailearn.capabilities.get({ meta: createRequestMeta() });
    if (!response.ok) return "unknown";
    return response.data.actionCapabilities["source.create"] === "allowed" ? "allowed" : "denied";
  } catch {
    return "unknown";
  }
}

/** 剪贴板弹窗挂载在已登录的房间里：盖子（DesktopAccessGate）外面不问。 */
export function SourceIntakeHost() {
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);

  useClipboardLinkWatcher(setPendingUrl);

  return (
    <>
      {pendingUrl ? (
        <ClipboardLinkPrompt
          key={pendingUrl}
          url={pendingUrl}
          onClose={(seen) => {
            if (seen) markLinkSeen(pendingUrl);
            setPendingUrl(null);
          }}
        />
      ) : null}
      <GlobalDropOverlay />
    </>
  );
}

/**
 * 外部复制 → 回到书房 → 问一次。只在窗口重新得焦时查，
 * 应用内复制、高频切换都不会被打扰；问过（收或略）的链接记下来不再问。
 */
function useClipboardLinkWatcher(onFreshUrl: (url: string) => void) {
  const busyRef = useRef(false);
  const pendingRef = useRef(false);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const onboardingRef = useRef(onboardingOpen);
  onboardingRef.current = onboardingOpen;

  const check = useCallback(async () => {
    if (busyRef.current || pendingRef.current) return;
    if (document.hidden || onboardingRef.current || hasOpenModal()) return;
    if (!window.ailearn?.clipboard) return;
    busyRef.current = true;
    try {
      const response = await window.ailearn.clipboard.readLinks({ meta: createRequestMeta() });
      // 后台轮询不进网关错误广播：不通就等下一次回到书房，不打扰。
      if (!response.ok) return;
      const fresh = response.data.urls.find((url) => !readSeenLinks().has(url));
      if (!fresh) return;
      // IPC 回来这一下里可能弹出了别的窗，让新窗先说。
      if (document.hidden || onboardingRef.current || hasOpenModal()) return;
      pendingRef.current = true;
      onFreshUrl(fresh);
    } catch {
      // 剪贴板不可读（极少）同样等下一轮，不弹错误。
    } finally {
      busyRef.current = false;
    }
  }, [onFreshUrl]);

  // 弹窗关掉才允许问下一条，避免叠窗。
  useEffect(() => {
    pendingRef.current = false;
  });

  useEffect(() => {
    if (document.hasFocus() && !document.hidden) void check();
    const onFocus = () => void check();
    const onVisibility = () => {
      if (!document.hidden) void check();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [check]);
}

type PromptPhase =
  | { kind: "checking" }
  | { kind: "ready"; capture: "allowed" | "denied" }
  | { kind: "importing" }
  | { kind: "done"; title: string }
  | { kind: "failed"; message: string };

export function ClipboardLinkPrompt({ url, onClose }: { readonly url: string; readonly onClose: (seen: boolean) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closedRef = useRef(false);
  const invoke = useRoomStore((state) => state.invoke);
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const motionMode = resolveSceneMotionMode(motionPreference, reducedMotion);
  const [phase, setPhase] = useState<PromptPhase>({ kind: "checking" });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    window.requestAnimationFrame(() => primaryRef.current?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => {
    let active = true;
    void canCaptureSource().then((capture) => {
      if (!active) return;
      // 服务端问不到就收声等下一轮：不断言、也不把链接记成问过。
      if (capture === "unknown") onClose(false);
      else setPhase({ kind: "ready", capture });
    });
    return () => { active = false; };
  }, []);

  // 目录弹窗同款进入再加一点动森弹跳：纸面从下方浮起、冒点头再坐稳；
  // lite 只留 hud-pop 式浮起，off 即时。
  useGSAP(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (motionMode === "off") {
      gsap.set(dialog, { clearProps: "opacity,transform,filter" });
      return;
    }
    if (motionMode === "lite") {
      gsap.fromTo(
        dialog,
        { autoAlpha: 0, y: 12, scale: 0.97 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.2, ease: "power3.out", clearProps: "transform,opacity,visibility" },
      );
      return;
    }
    const timeline = gsap.timeline();
    timeline.fromTo(
      dialog,
      { autoAlpha: 0, y: 16, scale: 0.94 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.3, ease: "back.out(1.5)", clearProps: "transform,opacity,visibility" },
      0,
    );
  }, { scope: dialogRef, dependencies: [motionMode], revertOnUpdate: true });

  const dismiss = useCallback((seen: boolean) => {
    if (closedRef.current) return;
    closedRef.current = true;
    dialogRef.current?.close();
    const target = returnFocusRef.current;
    onClose(seen);
    window.requestAnimationFrame(() => {
      if (target?.isConnected) target.focus({ preventScroll: true });
    });
  }, [onClose]);

  const doImport = useCallback(async () => {
    setPhase({ kind: "importing" });
    try {
      const response = await window.ailearn.source.create({
        meta: createRequestMeta(),
        request: { url },
      });
      const created = unwrapGatewayResult(response);
      dispatchSourceCaptured(created.source.id, created.source.title);
      setPhase({ kind: "done", title: created.source.title });
    } catch (error) {
      setPhase({ kind: "failed", message: gatewayErrorMessage(error) });
    }
  }, [url]);

  const denied = phase.kind === "ready" && phase.capture === "denied";
  const busy = phase.kind === "checking" || phase.kind === "importing";

  return (
    <dialog
      ref={dialogRef}
      className="source-intake-dialog"
      aria-labelledby="source-intake-title"
      onCancel={(event) => { event.preventDefault(); dismiss(true); }}
      onClick={(event) => {
        if (event.target === dialogRef.current && phase.kind !== "importing") dismiss(true);
      }}
      onClose={() => dismiss(true)}
    >
      <div className="source-intake-dialog__body">
        <button
          type="button"
          className="source-intake-dialog__close"
          aria-label="忽略这条链接"
          disabled={busy}
          onClick={() => dismiss(true)}
        >
          <X size={17} aria-hidden="true" />
        </button>
        <h2 id="source-intake-title">{phase.kind === "done" ? "已经收下啦" : "收进来源库吗？"}</h2>
        <p className="source-intake-dialog__url" aria-label={`链接地址：${url}`}>
          <strong>{hostOf(url)}</strong>
          <small>{url}</small>
        </p>
        {phase.kind === "done" ? (
          <p className="source-intake-dialog__hint" role="status">《{phase.title}》正在解析，解析完会出现在来源库里。</p>
        ) : (
          <p className="source-intake-dialog__hint">由服务端抓取正文并解析，和采集栏里填链接走的是同一条路。</p>
        )}
        {denied ? <p className="source-intake-dialog__locked">只有工作区所有者可以采集来源，这条链接先不收。</p> : null}
        {phase.kind === "failed" ? <p className="source-intake-dialog__error" role="alert">{phase.message}</p> : null}
        <div className="source-intake-dialog__actions">
          {phase.kind === "done" ? (
            <>
              <button
                ref={primaryRef}
                type="button"
                className="button primary"
                onClick={() => { invoke("open-sources"); dismiss(true); }}
              >
                去来源库看看
              </button>
              <button type="button" className="button" onClick={() => dismiss(true)}>好</button>
            </>
          ) : phase.kind === "failed" ? (
            <>
              <button ref={primaryRef} type="button" className="button primary" onClick={() => void doImport()}>
                重试
              </button>
              <button type="button" className="button" onClick={() => dismiss(true)}>忽略</button>
            </>
          ) : (
            <>
              <button
                ref={primaryRef}
                type="button"
                className="button primary"
                disabled={busy || denied}
                onClick={() => void doImport()}
              >
                {phase.kind === "importing" ? "正在收进…" : "开始解析"}
              </button>
              <button type="button" className="button" disabled={busy} onClick={() => dismiss(true)}>忽略</button>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}

type DropOutcome = { readonly name: string; readonly ok: boolean; readonly message: string };

type DropPhase =
  | { kind: "armed" }
  | { kind: "working"; done: number; total: number }
  | { kind: "report"; outcomes: readonly DropOutcome[]; overflow: boolean; created: { readonly sourceId: string; readonly title: string } | null };

export function GlobalDropOverlay() {
  const [phase, setPhase] = useState<DropPhase | null>(null);
  const dragDepthRef = useRef(0);
  const phaseRef = useRef<DropPhase | null>(null);
  phaseRef.current = phase;
  const invoke = useRoomStore((state) => state.invoke);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const onboardingRef = useRef(onboardingOpen);
  onboardingRef.current = onboardingOpen;
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const reportPrimaryRef = useRef<HTMLButtonElement>(null);

  const reset = useCallback(() => {
    dragDepthRef.current = 0;
    setPhase(null);
  }, []);

  const processDrop = useCallback(async (transfer: DataTransfer) => {
    const files = [...transfer.files];
    const overflow = files.length > MAX_DROP_FILES;
    const kept = files.slice(0, MAX_DROP_FILES);

    type Task = { name: string; request: { content: string; title?: string } | { url: string } };
    const tasks: Task[] = [];
    const outcomes: DropOutcome[] = [];

    if (kept.length === 0) {
      // 浏览器里拖出来的链接：没有文件，只有地址文本。
      const text = `${transfer.getData("text/uri-list")}\n${transfer.getData("text/plain")}`;
      const urls = extractCandidateLinks(text);
      if (urls.length === 0) return;
      for (const url of urls) tasks.push({ name: hostOf(url), request: { url } });
    } else {
      for (const file of kept) {
        if (!TEXT_FILE_PATTERN.test(file.name)) {
          outcomes.push({ name: file.name, ok: false, message: `采集通道目前接收文本、Markdown 与代码文件，暂不解析 ${file.name}。` });
          continue;
        }
        if (file.size > MAX_CAPTURE_BYTES) {
          outcomes.push({ name: file.name, ok: false, message: `这份材料约 ${formatCaptureSize(file.size)}，超过单次采集的 900 KB 上限，请分段采集。` });
          continue;
        }
        let text: string;
        try {
          text = await file.text();
        } catch {
          outcomes.push({ name: file.name, ok: false, message: "这份文件读不出来，换一种方式粘贴试试。" });
          continue;
        }
        if (!text.trim()) {
          outcomes.push({ name: file.name, ok: false, message: "这份文件是空的，没有可收的内容。" });
          continue;
        }
        const bytes = captureBytes(text);
        if (bytes > MAX_CAPTURE_BYTES) {
          outcomes.push({ name: file.name, ok: false, message: `这份材料约 ${formatCaptureSize(bytes)}，超过单次采集的 900 KB 上限，请分段采集。` });
          continue;
        }
        const title = titleFromFileName(file.name);
        tasks.push({ name: file.name, request: { content: text, ...(title ? { title } : {}) } });
      }
    }

    const total = tasks.length + outcomes.length;
    if (total === 0) return;
    setPhase({ kind: "working", done: 0, total });

    if (tasks.length > 0) {
      const capture = await canCaptureSource();
      if (capture !== "allowed") {
        outcomes.push({
          name: tasks.length === 1 ? tasks[0].name : `这 ${tasks.length} 份材料`,
          ok: false,
          message: capture === "denied" ? "只有工作区所有者可以采集来源。" : "来源库暂时不可用，稍后再拖一次。",
        });
      } else {
        let created: { readonly sourceId: string; readonly title: string } | null = null;
        let done = 0;
        for (const task of tasks) {
          try {
            const response = await window.ailearn.source.create({
              meta: createRequestMeta(),
              request: task.request,
            });
            const detail = unwrapGatewayResult(response);
            created = { sourceId: detail.source.id, title: detail.source.title };
            outcomes.push({ name: task.name, ok: true, message: "已收下，正在解析。" });
          } catch (error) {
            outcomes.push({ name: task.name, ok: false, message: gatewayErrorMessage(error) });
          }
          done += 1;
          setPhase({ kind: "working", done, total });
        }
        if (created) dispatchSourceCaptured(created.sourceId, created.title);
        setPhase({ kind: "report", outcomes, overflow, created });
        return;
      }
    }
    setPhase({ kind: "report", outcomes, overflow, created: null });
  }, []);

  useEffect(() => {
    const hasFiles = (transfer: DataTransfer | null) =>
      Boolean(transfer && (transfer.types.includes("Files") || transfer.types.includes("text/uri-list")));

    const onDragEnter = (event: DragEvent) => {
      if (onboardingRef.current || isEditableTarget(event.target) || isOwnedDropTarget(event.target) || hasOpenModal()) {
        dragDepthRef.current = 0;
        if (phaseRef.current?.kind === "armed") setPhase(null);
        return;
      }
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      if (!phaseRef.current) {
        returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setPhase({ kind: "armed" });
      }
    };
    const onDragOver = (event: DragEvent) => {
      // 放行这次拖放：preventDefault 之后 drop 事件才会进来。
      if (phaseRef.current && !isEditableTarget(event.target) && !isOwnedDropTarget(event.target)) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      }
    };
    const onDragLeave = (event: DragEvent) => {
      if (!phaseRef.current) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0 && phaseRef.current.kind === "armed") setPhase(null);
    };
    const onDrop = (event: DragEvent) => {
      // 采集栏、编辑器各有自己的投放格：它们 preventDefault 过的，这层不碰。
      if (onboardingRef.current || event.defaultPrevented || isEditableTarget(event.target) || isOwnedDropTarget(event.target)) {
        dragDepthRef.current = 0;
        return;
      }
      if (!phaseRef.current || !event.dataTransfer || !hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      void processDrop(event.dataTransfer);
    };
    const onDragEnd = () => {
      if (phaseRef.current?.kind === "armed") reset();
      else dragDepthRef.current = 0;
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", onDragEnd);
    };
  }, [processDrop, reset]);

  useEffect(() => {
    if (phase?.kind === "report") {
      window.requestAnimationFrame(() => reportPrimaryRef.current?.focus({ preventScroll: true }));
    }
  }, [phase]);

  useEffect(() => {
    if (!phase) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || phaseRef.current?.kind === "working") return;
      event.preventDefault();
      reset();
      const target = returnFocusRef.current;
      window.requestAnimationFrame(() => {
        if (target?.isConnected) target.focus({ preventScroll: true });
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase, reset]);

  if (!phase) return null;

  const working = phase.kind === "working" ? phase : null;
  const report = phase.kind === "report" ? phase : null;
  const succeeded = report?.outcomes.some((outcome) => outcome.ok) ?? false;

  return (
    <div className="source-intake-drop" aria-hidden={report ? undefined : true}>
      <div
        className="source-intake-drop__card"
        role={report ? "alertdialog" : undefined}
        aria-modal={report ? true : undefined}
        aria-labelledby="source-intake-drop-title"
      >
        <span className="source-intake-drop__icon" aria-hidden="true">
          {report ? <FileText size={24} /> : <Link2 size={24} />}
        </span>
        <h2 id="source-intake-drop-title">
          {working ? `正在收进第 ${Math.min(working.done + 1, working.total)}/${working.total} 份…`
            : report ? (succeeded ? "收好了" : "这次没收进来")
            : "松开，收进来源库"}
        </h2>
        {working ? (
          <>
            <p>直接解析到来源库，完成后索引会自动更新。</p>
            <div className="source-intake-drop__progress" aria-hidden="true">
              <span style={{ transform: `scaleX(${working.total === 0 ? 0 : working.done / working.total})` }} />
            </div>
          </>
        ) : report ? (
          <>
            {report.overflow ? <p>一次最多收 {MAX_DROP_FILES} 份，多出的那几份请分批拖入。</p> : null}
            <ul className="source-intake-drop__report">
              {report.outcomes.map((outcome) => (
                <li key={outcome.name} data-ok={outcome.ok}>
                  {outcome.ok
                    ? <Check size={16} aria-hidden="true" />
                    : <CircleAlert size={16} aria-hidden="true" />}
                  <span>
                    <strong>{outcome.name}</strong>
                    <small>{outcome.message}</small>
                  </span>
                </li>
              ))}
            </ul>
            <div className="source-intake-drop__actions">
              {succeeded ? (
                <button
                  ref={reportPrimaryRef}
                  type="button"
                  className="button primary"
                  onClick={() => { invoke("open-sources"); reset(); }}
                >
                  去来源库看看 <ArrowRight size={15} aria-hidden="true" />
                </button>
              ) : null}
              <button
                ref={succeeded ? undefined : reportPrimaryRef}
                type="button"
                className={succeeded ? "button" : "button primary"}
                onClick={reset}
              >
                知道了
              </button>
            </div>
          </>
        ) : (
          <p>文本、Markdown、代码文件，或一条网页链接。</p>
        )}
      </div>
    </div>
  );
}
