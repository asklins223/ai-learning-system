import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Image as ImageIcon, LoaderCircle } from "lucide-react";
import {
  NOTE_IMAGE_UPLOAD_MAX_BYTES,
  NOTE_IMAGE_UPLOAD_MIME_TYPES,
  noteImageUploadFailureMessage,
} from "@ailearn/shared/note-image-upload-contracts";
import { createRequestMeta, unwrapGatewayResult } from "../../app/desktop-client";
import type { NoteMarkdownEditorHandle } from "./note-markdown-editor";

/**
 * 编辑器里粘贴/拖进来的图片，从文件到站内地址的那一段。
 *
 * Web 端那套交互照搬过来：先在正文里落一个 `![上传中…](uploading:{id})` 占位，
 * 上传成功后**原位**换成服务端确认的 `/api/uploads/…`，失败留给用户重试或移除。
 * 差别只有一处——浏览器那边是渲染层直接 POST，能拿到字节进度；桌面端走 main 的
 * IPC，没有进度事件，所以这里不画进度条，只报状态。编造一个假的百分比不如不说。
 */
export type NoteImageUploadStatus = "queued" | "uploading" | "succeeded" | "failed";

export type NoteImageUploadView = {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly status: NoteImageUploadStatus;
  readonly error: string | null;
};

/** 同时上传的图片数上限：再多也只是把同一条链路的队列拉长。 */
const MAX_CONCURRENT_UPLOADS = 3;
/** 一张图成功后，它的那一行状态在列表里再留多久。 */
const RESULT_VISIBLE_MS = 2_000;

/**
 * 队列里的一条。`status` / `error` 要在上传过程中就地改（这个任务的整个生命周期
 * 都在这一个模块里），列表对外投影出来的 `NoteImageUploadView` 仍是只读的。
 */
type UploadTask = {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  status: NoteImageUploadStatus;
  error: string | null;
  readonly file: File;
  /** 正文里的占位地址，成功后就地替换成真地址。 */
  readonly placeholder: string;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
};

/** 把一段 base64 之外的 `data:` 前缀剥掉：合同里要的是纯 base64。 */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read_failed"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export type UseNoteImageUploadsOptions = {
  /** 上传目标笔记；null 表示还没有服务端确认的笔记身份。 */
  readonly noteId: string | null;
  readonly editorRef: React.RefObject<NoteMarkdownEditorHandle | null>;
  /** 正文被这次上传改动之后的当前 Markdown（用于让草稿跟上）。 */
  readonly onContentChange: (markdown: string) => void;
  /** 当前草稿的 Markdown，编辑器尚未就绪时的退路。 */
  readonly getContent: () => string;
  /** 不可写时（只读身份、保存中、非编辑态）不接受新图片。 */
  readonly disabled: boolean;
};

export type NoteImageUploadsHandle = {
  readonly uploads: readonly NoteImageUploadView[];
  readonly error: string | null;
  readonly fileInputRef: React.RefObject<HTMLInputElement | null>;
  readonly queueFile: (file: File) => void;
  readonly queueFiles: (files: FileList | null) => void;
  readonly retry: (id: string) => void;
  readonly dismiss: (id: string) => void;
};

export function useNoteImageUploads(options: UseNoteImageUploadsOptions): NoteImageUploadsHandle {
  const [uploads, setUploads] = useState<readonly NoteImageUploadView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tasksRef = useRef(new Map<string, UploadTask>());
  const queueRef = useRef<string[]>([]);
  const activeRef = useRef(0);
  const pumpRef = useRef<() => void>(() => {});

  /**
   * 每次都读最新的 props：上传是异步的，闭包里那份 `disabled` / `noteId` 可能已经
   * 是上一轮渲染的值。这样这些回调不需要随 props 重建，队列也就不会被打断。
   */
  const latestRef = useRef(options);
  latestRef.current = options;

  const editorMarkdown = () => {
    const editor = latestRef.current.editorRef.current;
    return editor?.getMarkdown() ?? latestRef.current.getContent();
  };

  const publish = (markdown: string, flush?: boolean) => {
    const editor = latestRef.current.editorRef.current;
    editor?.setMarkdown(markdown, flush);
    latestRef.current.onContentChange(markdown);
  };

  const sync = useCallback(() => {
    setUploads(Array.from(tasksRef.current.values()).map(({ id, name, size, status, error: failure }) => ({
      id, name, size, status, error: failure,
    })));
  }, []);

  /** 上传成功后那一行留一会儿再消失，让作者看到"已插入"。 */
  const scheduleRemoval = useCallback((task: UploadTask) => {
    if (task.cleanupTimer) clearTimeout(task.cleanupTimer);
    task.cleanupTimer = setTimeout(() => {
      const current = tasksRef.current.get(task.id);
      if (current !== task || task.status !== "succeeded") return;
      tasksRef.current.delete(task.id);
      sync();
    }, RESULT_VISIBLE_MS);
  }, [sync]);

  const dropPlaceholder = useCallback((task: UploadTask) => {
    const current = editorMarkdown();
    const cleaned = current.replace(task.placeholder, "");
    if (cleaned === current) return;
    publish(cleaned, true);
  }, []);

  const insertPlaceholder = useCallback((task: UploadTask) => {
    const editor = latestRef.current.editorRef.current;
    if (editorMarkdown().includes(`uploading:${task.id}`)) return;
    if (!editor) {
      const current = editorMarkdown();
      const separator = current && !current.endsWith("\n") ? "\n\n" : "";
      publish(`${current}${separator}${task.placeholder}`, true);
      return;
    }
    // 走 insertText 而不是整体替换：占位落在光标处，撤销栈和后续输入都不受影响。
    editor.insertText(task.placeholder);
    const updated = editor.getMarkdown();
    if (updated !== null) latestRef.current.onContentChange(updated);
  }, []);

  const runUpload = useCallback(async (task: UploadTask) => {
    task.status = "uploading";
    sync();
    const noteId = latestRef.current.noteId;
    try {
      if (!noteId) throw new Error("no_note");
      const api = typeof window === "undefined" ? undefined : window.ailearn;
      if (!api) throw new Error("no_api");
      const bytesBase64 = await readFileAsBase64(task.file);
      const result = unwrapGatewayResult(await api.note.uploadImage({
        meta: createRequestMeta(),
        noteId,
        request: {
          version: 1,
          fileName: task.file.name || "粘贴的图片",
          mimeType: task.file.type as typeof NOTE_IMAGE_UPLOAD_MIME_TYPES[number],
          bytesBase64,
        },
      }));
      const editor = latestRef.current.editorRef.current;
      editor?.replaceImageSrc(`uploading:${task.id}`, result.url);
      // 节点视图把属性变化落成 DOM，正文这边同步读回来，草稿才是真的改过了。
      const current = editor?.getMarkdown() ?? null;
      if (current === null || current.includes(`uploading:${task.id}`)) {
        publish(editorMarkdown().replace(task.placeholder, result.url));
      } else {
        latestRef.current.onContentChange(current);
      }
      task.status = "succeeded";
      task.error = null;
    } catch (failure) {
      task.status = "failed";
      task.error = noteImageUploadFailureMessage({
        httpStatus: (failure as { readonly httpStatus?: number }).httpStatus,
        fileName: task.file.name,
      });
    } finally {
      activeRef.current = Math.max(0, activeRef.current - 1);
      sync();
      if (task.status === "succeeded") scheduleRemoval(task);
      pumpRef.current();
    }
  }, [publish, scheduleRemoval, sync]);

  const pump = useCallback(() => {
    while (activeRef.current < MAX_CONCURRENT_UPLOADS && queueRef.current.length > 0) {
      const id = queueRef.current.shift();
      if (!id) continue;
      const task = tasksRef.current.get(id);
      if (!task || task.status !== "queued") continue;
      activeRef.current += 1;
      void runUpload(task);
    }
  }, [runUpload]);
  pumpRef.current = pump;

  /** 入队前先把合同能说的那两种拒绝说清楚，不必等一次往返。 */
  const queueFile = useCallback((file: File) => {
    const reject = (message: string) => {
      setError(message);
      sync();
    };
    if (latestRef.current.disabled) {
      setError("当前暂不能添加图片，请稍后重试。");
      return;
    }
    if (!(NOTE_IMAGE_UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)) {
      reject("只支持 PNG / JPEG / GIF / WebP 图片。");
      return;
    }
    if (file.size > NOTE_IMAGE_UPLOAD_MAX_BYTES) {
      reject(`「${file.name || "粘贴的图片"}」超过 5MB，请压缩后重试。`);
      return;
    }

    const id = crypto.randomUUID();
    const task: UploadTask = {
      id,
      name: file.name || "粘贴的图片",
      size: file.size,
      status: "queued",
      error: null,
      file,
      placeholder: `![上传中…](uploading:${id})`,
      cleanupTimer: null,
    };
    tasksRef.current.set(id, task);
    queueRef.current.push(id);
    insertPlaceholder(task);
    setError(null);
    sync();
    pump();
  }, [insertPlaceholder, pump, sync]);

  const retry = useCallback((id: string) => {
    const task = tasksRef.current.get(id);
    if (!task || task.status !== "failed") return;
    if (task.cleanupTimer) {
      clearTimeout(task.cleanupTimer);
      task.cleanupTimer = null;
    }
    task.status = "queued";
    task.error = null;
    insertPlaceholder(task);
    queueRef.current.push(id);
    setError(null);
    sync();
    pump();
  }, [insertPlaceholder, pump, sync]);

  const dismiss = useCallback((id: string) => {
    const task = tasksRef.current.get(id);
    if (!task || task.status === "succeeded") return;
    if (task.status !== "uploading") dropPlaceholder(task);
    if (task.cleanupTimer) clearTimeout(task.cleanupTimer);
    tasksRef.current.delete(id);
    queueRef.current = queueRef.current.filter((queued) => queued !== id);
    sync();
  }, [dropPlaceholder, sync]);

  const queueFiles = useCallback((files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) queueFile(file);
  }, [queueFile]);

  // 离开这一页时不再更新状态，也不再让结果写回一篇已经换掉的笔记。
  useEffect(() => {
    const tasks = tasksRef.current;
    return () => {
      queueRef.current = [];
      for (const task of tasks.values()) {
        if (task.cleanupTimer) clearTimeout(task.cleanupTimer);
      }
      tasks.clear();
      activeRef.current = 0;
    };
  }, []);

  return { uploads, error, fileInputRef, queueFile, queueFiles, retry, dismiss };
}

const STATUS_LABEL: Record<NoteImageUploadStatus, string> = {
  queued: "排队中",
  uploading: "上传中…",
  succeeded: "已插入正文",
  failed: "上传未成功",
};

/**
 * 上传状态。它读书面语的 9px 小字，和纸面上的其它说明行同一档，所以放一小行
 * 列表就够——正文里那块虚线占位才是作者真正在看的东西。
 */
export function NoteImageUploads({
  uploads,
  error,
  onRetry,
  onDismiss,
}: {
  readonly uploads: readonly NoteImageUploadView[];
  readonly error: string | null;
  readonly onRetry: (id: string) => void;
  readonly onDismiss: (id: string) => void;
}) {
  if (!uploads.length && !error) return null;
  return (
    <div className="note-image-uploads">
      {error ? <p className="small notebook-note" role="alert">{error}</p> : null}
      {uploads.length ? (
        <ul className="note-image-upload-list" aria-label="图片上传">
          {uploads.map((upload) => (
            <li key={upload.id} className="note-image-upload" data-status={upload.status}>
              {upload.status === "uploading" || upload.status === "queued" ? (
                <LoaderCircle className="note-image-upload__mark run-spinner" size={12} aria-hidden="true" />
              ) : upload.status === "succeeded" ? (
                <Check className="note-image-upload__mark" size={12} aria-hidden="true" />
              ) : (
                <AlertTriangle className="note-image-upload__mark" size={12} aria-hidden="true" />
              )}
              <ImageIcon className="note-image-upload__kind" size={12} aria-hidden="true" />
              <span className="note-image-upload__name">{upload.name}</span>
              <span className="note-image-upload__size">{formatSize(upload.size)}</span>
              <span className="note-image-upload__state" role="status">
                {upload.status === "failed" && upload.error ? upload.error : STATUS_LABEL[upload.status]}
              </span>
              {upload.status === "failed" ? (
                <>
                  <button type="button" className="text-action text-action--strong" onClick={() => onRetry(upload.id)}>
                    重试
                  </button>
                  <button type="button" className="text-action" onClick={() => onDismiss(upload.id)}>
                    移出正文
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
