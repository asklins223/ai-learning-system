"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { Icon } from "@/components/ui/icons";
import {
  formatMarkdownFileSize,
  MAX_MARKDOWN_IMPORT_FILES,
  markdownSelectionError,
  readMarkdownFiles,
  summarizeMarkdownFiles,
  type MarkdownImportFileRecord,
} from "@/lib/markdown-import-files";

export function useMarkdownFileSelection() {
  const [files, setFiles] = useState<MarkdownImportFileRecord[]>([]);
  const [reading, setReading] = useState(false);
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const readingRef = useRef(false);

  const addFiles = useCallback(async (incoming: readonly File[]) => {
    if (incoming.length === 0 || readingRef.current) return;
    const replaceableErrors = files.filter((file) => file.error).length;
    const availableSlots = MAX_MARKDOWN_IMPORT_FILES - files.length + replaceableErrors;
    if (incoming.length > availableSlots) {
      setSelectionMessage(
        availableSlots > 0
          ? `单次最多导入 ${MAX_MARKDOWN_IMPORT_FILES} 个文件，本次还可选择 ${availableSlots} 个。`
          : `单次最多导入 ${MAX_MARKDOWN_IMPORT_FILES} 个文件，请先移除部分文件。`,
      );
      return;
    }
    readingRef.current = true;
    setReading(true);
    setSelectionMessage(null);
    try {
      const parsed = await readMarkdownFiles(incoming);
      const next = [...files];
      const knownFingerprints = new Set(
        next.flatMap((file) => (file.fingerprint ? [file.fingerprint] : [])),
      );
      let duplicateCount = 0;
      for (const file of parsed) {
        if (file.fingerprint && knownFingerprints.has(file.fingerprint)) {
          duplicateCount += 1;
          continue;
        }
        const previousErrorIndex = next.findIndex(
          (current) => Boolean(current.error) && current.sourceKey === file.sourceKey,
        );
        if (previousErrorIndex >= 0) next.splice(previousErrorIndex, 1);
        if (file.fingerprint) knownFingerprints.add(file.fingerprint);
        next.push(file);
      }
      setSelectionMessage(
        duplicateCount > 0 ? `已忽略 ${duplicateCount} 个内容相同的重复文件。` : null,
      );
      setFiles(next);
    } finally {
      readingRef.current = false;
      setReading(false);
    }
  }, [files]);

  const removeFile = useCallback((key: string) => {
    setFiles((current) => current.filter((file) => file.key !== key));
    setSelectionMessage(null);
  }, []);

  const clearFiles = useCallback(() => {
    setFiles([]);
    setSelectionMessage(null);
  }, []);

  const retainFiles = useCallback((keys: readonly string[]) => {
    const retained = new Set(keys);
    setFiles((current) => current.filter((file) => retained.has(file.key)));
    setSelectionMessage(null);
  }, []);

  const summary = useMemo(() => summarizeMarkdownFiles(files), [files]);
  const validationError = useMemo(() => markdownSelectionError(files), [files]);
  const items = useMemo(
    () => files.flatMap((file) => (file.item ? [file.item] : [])),
    [files],
  );
  const validFiles = useMemo(() => files.filter((file) => file.item), [files]);

  return {
    files,
    validFiles,
    items,
    summary,
    validationError,
    selectionMessage,
    reading,
    addFiles,
    removeFile,
    clearFiles,
    retainFiles,
  };
}

export type MarkdownFileSelection = ReturnType<typeof useMarkdownFileSelection>;

export function MarkdownFilePicker({
  id,
  selection,
  disabled = false,
  autoFocus = false,
  className = "",
  onSelectionChange,
}: {
  id: string;
  selection: MarkdownFileSelection;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  onSelectionChange?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const unavailable = disabled || selection.reading;
  const hasFiles = selection.files.length > 0;
  const helpId = `${id}-help`;

  useEffect(() => {
    if (autoFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, [autoFocus]);

  const openPicker = useCallback(() => {
    if (!unavailable) inputRef.current?.click();
  }, [unavailable]);

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (unavailable) return;
    dragDepth.current += 1;
    setDragging(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (unavailable) return;
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (unavailable) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (unavailable) return;
    dragDepth.current = 0;
    setDragging(false);
    onSelectionChange?.();
    void selection.addFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <div
      className={`markdown-file-picker${hasFiles ? " has-files" : ""}${dragging ? " is-dragging" : ""}${unavailable ? " is-disabled" : ""}${className ? ` ${className}` : ""}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      aria-busy={selection.reading}
    >
      <input
        ref={inputRef}
        id={id}
        className="markdown-file-input"
        type="file"
        accept=".md,.markdown,text/markdown"
        multiple
        disabled={unavailable}
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          onSelectionChange?.();
          void selection.addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />

      <div className="markdown-file-dropzone">
        <span className="markdown-file-dropzone-icon" aria-hidden="true">
          {selection.reading ? <Icon.Refresh className="markdown-file-spin" /> : <Icon.Upload />}
        </span>
        <div className="markdown-file-dropzone-copy">
          <strong>
            {selection.reading
              ? "正在读取 Markdown 文件"
              : hasFiles
                ? "继续添加 Markdown 文件"
                : "把 Markdown 文件拖到这里"}
          </strong>
          <span id={helpId}>支持 UTF-8 编码的 .md / .markdown，可一次多选；每个文件创建一篇笔记。</span>
        </div>
        <button
          ref={triggerRef}
          className="markdown-file-select-button"
          type="button"
          onClick={openPicker}
          disabled={unavailable}
          aria-describedby={helpId}
        >
          <Icon.Folder aria-hidden="true" />
          {hasFiles ? "继续选择" : "选择文件"}
        </button>
      </div>

      {hasFiles && (
        <div className="markdown-file-selection">
          <div className="markdown-file-selection-heading">
            <div>
              <span>本地导入</span>
              <strong>已选择文件</strong>
            </div>
            <small aria-live="polite">
              {selection.summary.files} 个文件 · {selection.summary.ready} 个可导入
            </small>
          </div>
          <ul className="markdown-file-list">
            {selection.files.map((file) => (
              <li key={file.key} className={`markdown-file-card${file.error ? " has-error" : ""}`}>
                <span className="markdown-file-card-icon" aria-hidden="true">
                  {file.error ? <Icon.Warn /> : <Icon.FileText />}
                </span>
                <div className="markdown-file-card-copy">
                  <strong title={file.name}>{file.name}</strong>
                  {file.error ? (
                    <span className="markdown-file-card-error">{file.error}</span>
                  ) : (
                    <span>
                      {formatMarkdownFileSize(file.size)} · {file.characterCount.toLocaleString("zh-CN")} 字符
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="markdown-file-remove"
                  onClick={() => {
                    onSelectionChange?.();
                    selection.removeFile(file.key);
                  }}
                  disabled={unavailable}
                  aria-label={`移除 ${file.name}`}
                  title="移除文件"
                >
                  <Icon.Close aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {selection.selectionMessage && (
        <p className="markdown-file-selection-message" role="status">
          <Icon.Warn aria-hidden="true" />{selection.selectionMessage}
        </p>
      )}
    </div>
  );
}
