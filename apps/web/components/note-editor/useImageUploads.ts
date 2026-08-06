/**
 * PERF-04 拆分（第九轮）：图片上传逻辑提取为自定义 Hook。
 *
 * 从 NoteEditor.tsx 中提取图片上传相关的状态管理和操作函数，
 * 包括：
 * - 并发上传队列管理（最多 3 个并发）
 * - 上传进度跟踪和 UI 状态同步
 * - 占位符插入/移除/替换
 * - 重试和取消逻辑
 * - 错误处理和用户提示
 *
 * 提取后 NoteEditor.tsx 减少约 230 行代码。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { MilkdownEditorHandle } from "@/components/MilkdownEditor";
import {
  type ImageUploadTask,
  type ImageUploadView,
  MAX_CONCURRENT_IMAGE_UPLOADS,
  IMAGE_UPLOAD_TIMEOUT_MS,
  IMAGE_UPLOAD_RESULT_VISIBLE_MS,
} from "./note-editor-types";

/** useImageUploads 的参数 */
export interface UseImageUploadsParams {
  /** 笔记 ID，用于上传 API */
  noteId: string;
  /** Milkdown 编辑器引用 */
  editorRef: React.RefObject<MilkdownEditorHandle | null>;
  /** 最新草稿引用（包含 source 字段） */
  latestDraftRef: React.RefObject<{ source: string }>;
  /** 组件挂载标志引用 */
  mountedRef: React.RefObject<boolean>;
  /** 更新源文本的回调 */
  updateSource: (next: string) => void;
  /** 检查是否处于锁定状态（生成中/恢复中/删除中/已删除） */
  isLocked: () => boolean;
}

/** useImageUploads 的返回值 */
export interface UseImageUploadsReturn {
  /** 正在上传的数量 */
  uploadingCount: number;
  /** 上传任务列表（用于 UI 展示） */
  imageUploads: ImageUploadView[];
  /** 上传错误信息 */
  uploadError: string | null;
  /** 设置上传错误信息 */
  setUploadError: (error: string | null) => void;
  /** 文件输入框引用 */
  imageFileInputRef: React.RefObject<HTMLInputElement | null>;
  /** 将文件加入上传队列 */
  queueImageUpload: (file: File) => void;
  /** 重试失败的上传 */
  retryImageUpload: (id: string) => void;
  /** 取消上传 */
  cancelImageUpload: (id: string) => void;
  /** 文件选择事件处理 */
  handleImageFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

/**
 * 图片上传管理 Hook。
 *
 * 管理图片上传的完整生命周期：排队 → 上传 → 成功/失败/取消 → 清理。
 * 使用稳定占位符策略：先在编辑器中插入 `![上传中…](uploading:id)` 占位符，
 * 上传成功后原位替换为实际 URL。
 */
export function useImageUploads(params: UseImageUploadsParams): UseImageUploadsReturn {
  const { noteId, editorRef, latestDraftRef, mountedRef, updateSource, isLocked } = params;

  const [uploadingCount, setUploadingCount] = useState(0);
  const [imageUploads, setImageUploads] = useState<ImageUploadView[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const imageFileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadingCountRef = useRef(0);
  const imageUploadItemsRef = useRef(new Map<string, ImageUploadTask>());
  const imageUploadQueueRef = useRef<string[]>([]);
  const activeImageUploadsRef = useRef(0);
  // runImageUpload 与 pumpImageUploads 相互递归调度上传队列，
  // 通过 ref 持有 pump 的最新实现，避免 useCallback 依赖环。
  const pumpImageUploadsRef = useRef<() => void>(() => {});

  /** 同步上传状态到 React state（触发 UI 更新） */
  const syncImageUploadState = useCallback(() => {
    const uploads = Array.from(imageUploadItemsRef.current.values());
    const pendingCount = uploads.filter(
      (upload) => upload.status === "queued" || upload.status === "uploading",
    ).length;
    uploadingCountRef.current = pendingCount;
    if (!mountedRef.current) return;
    setUploadingCount(pendingCount);
    setImageUploads(uploads.map(({
      id, name, size, status, loaded, total, error,
    }) => ({
      id, name, size, status, loaded, total, error,
    })));
  }, [mountedRef]);

  /** 从编辑器中移除上传占位符 */
  const removeImageUploadPlaceholder = useCallback((task: ImageUploadTask) => {
    const editor = editorRef.current;
    const currentSource = editor?.getMarkdown() ?? latestDraftRef.current.source;
    const cleaned = currentSource.replace(task.placeholder, "");
    if (cleaned === currentSource) return;
    updateSource(cleaned);
    editor?.setMarkdown(cleaned);
  }, [editorRef, latestDraftRef, updateSource]);

  /** 在编辑器中插入上传占位符 */
  const insertImageUploadPlaceholder = useCallback((task: ImageUploadTask) => {
    const editor = editorRef.current;
    const currentSource = editor?.getMarkdown() ?? latestDraftRef.current.source;
    if (currentSource.includes(`uploading:${task.id}`)) return;
    if (editor) {
      editor.insertText(task.placeholder);
      const updatedSource = editor.getMarkdown();
      if (updatedSource != null) updateSource(updatedSource);
      return;
    }
    const separator = currentSource && !currentSource.endsWith("\n") ? "\n\n" : "";
    updateSource(`${currentSource}${separator}${task.placeholder}`);
  }, [editorRef, latestDraftRef, updateSource]);

  /** 调度上传结果的延迟清理 */
  const scheduleImageUploadRemoval = useCallback((task: ImageUploadTask) => {
    if (task.cleanupTimer) clearTimeout(task.cleanupTimer);
    task.cleanupTimer = setTimeout(() => {
      const current = imageUploadItemsRef.current.get(task.id);
      if (
        current !== task ||
        (task.status !== "succeeded" && task.status !== "cancelled")
      ) return;
      imageUploadItemsRef.current.delete(task.id);
      imageUploadQueueRef.current = imageUploadQueueRef.current.filter((id) => id !== task.id);
      syncImageUploadState();
    }, IMAGE_UPLOAD_RESULT_VISIBLE_MS);
  }, [syncImageUploadState]);

  /** 将 API 错误转换为用户友好的错误消息 */
  const imageUploadErrorMessage = useCallback((error: unknown): string => {
    if (error instanceof ApiError) {
      if (error.code === "upload_timeout") return "上传超时，请重试";
      if (error.status === 413) return "图片过大，请压缩后重试";
      if (error.status === 422 || error.status === 400) {
        return error.message || "图片格式或尺寸不受支持";
      }
    }
    return "上传失败，请重试";
  }, []);

  /** 执行单个上传任务 */
  const runImageUpload = useCallback(async (task: ImageUploadTask, controller: AbortController) => {
    try {
      const result = await api.uploadImage(task.file, noteId, {
        signal: controller.signal,
        timeoutMs: IMAGE_UPLOAD_TIMEOUT_MS,
        onProgress: (loaded, total) => {
          if (task.status !== "uploading") return;
          task.loaded = loaded;
          task.total = total > 0 ? total : task.size;
          syncImageUploadState();
        },
      });
      if (task.status === "cancelled") return;

      const editor = editorRef.current;
      editor?.replaceImageSrc(`uploading:${task.id}`, result.url);
      let updatedSource = editor?.getMarkdown() ?? latestDraftRef.current.source;
      if (updatedSource.includes(`uploading:${task.id}`)) {
        updatedSource = updatedSource.replace(`uploading:${task.id}`, result.url);
        editor?.setMarkdown(updatedSource);
      }
      updateSource(updatedSource);
      task.status = "succeeded";
      task.loaded = task.total || task.size;
      task.error = null;
    } catch (error) {
      if (
        task.status === "cancelled" ||
        (error instanceof ApiError && error.code === "upload_cancelled")
      ) {
        task.status = "cancelled";
        task.error = null;
      } else {
        task.status = "failed";
        task.error = imageUploadErrorMessage(error);
      }
    } finally {
      task.controller = null;
      activeImageUploadsRef.current = Math.max(0, activeImageUploadsRef.current - 1);
      syncImageUploadState();
      if (!mountedRef.current) return;
      if (task.status === "succeeded" || task.status === "cancelled") {
        scheduleImageUploadRemoval(task);
      }
      pumpImageUploadsRef.current();
    }
  }, [noteId, editorRef, latestDraftRef, updateSource, syncImageUploadState, mountedRef, scheduleImageUploadRemoval, imageUploadErrorMessage]);

  /** 从队列中取出任务并启动上传（维持并发上限） */
  const pumpImageUploads = useCallback(() => {
    if (!mountedRef.current) return;
    while (
      activeImageUploadsRef.current < MAX_CONCURRENT_IMAGE_UPLOADS &&
      imageUploadQueueRef.current.length > 0
    ) {
      const nextId = imageUploadQueueRef.current.shift();
      if (!nextId) continue;
      const task = imageUploadItemsRef.current.get(nextId);
      if (!task || task.status !== "queued") continue;

      const controller = new AbortController();
      task.status = "uploading";
      task.controller = controller;
      activeImageUploadsRef.current += 1;
      syncImageUploadState();
      void runImageUpload(task, controller);
    }
  }, [mountedRef, syncImageUploadState, runImageUpload]);
  pumpImageUploadsRef.current = pumpImageUploads;

  /** 将文件加入上传队列 */
  const queueImageUpload = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      setUploadError("仅支持上传图片文件。");
      return;
    }
    if (isLocked()) {
      setUploadError("当前暂不能添加图片，请稍后重试。");
      return;
    }

    const id = crypto.randomUUID();
    const task: ImageUploadTask = {
      id,
      name: file.name || "粘贴的图片",
      size: file.size,
      status: "queued",
      loaded: 0,
      total: file.size,
      error: null,
      file,
      placeholder: `![上传中…](uploading:${id})`,
      controller: null,
      cleanupTimer: null,
    };
    imageUploadItemsRef.current.set(id, task);
    imageUploadQueueRef.current.push(id);
    insertImageUploadPlaceholder(task);
    setUploadError(null);
    syncImageUploadState();
    pumpImageUploads();
  }, [isLocked, insertImageUploadPlaceholder, syncImageUploadState, pumpImageUploads]);

  /** 重试失败的上传 */
  const retryImageUpload = useCallback((id: string) => {
    const task = imageUploadItemsRef.current.get(id);
    if (!task || task.status !== "failed" || isLocked()) return;
    if (task.cleanupTimer) {
      clearTimeout(task.cleanupTimer);
      task.cleanupTimer = null;
    }
    task.status = "queued";
    task.loaded = 0;
    task.total = task.size;
    task.error = null;
    insertImageUploadPlaceholder(task);
    imageUploadQueueRef.current.push(task.id);
    syncImageUploadState();
    pumpImageUploads();
  }, [isLocked, insertImageUploadPlaceholder, syncImageUploadState, pumpImageUploads]);

  /** 取消上传 */
  const cancelImageUpload = useCallback((id: string) => {
    const task = imageUploadItemsRef.current.get(id);
    if (
      !task ||
      task.status === "succeeded" ||
      task.status === "cancelled"
    ) return;

    imageUploadQueueRef.current = imageUploadQueueRef.current.filter((queuedId) => queuedId !== id);
    task.status = "cancelled";
    task.error = null;
    removeImageUploadPlaceholder(task);
    task.controller?.abort();
    syncImageUploadState();
    if (!task.controller) scheduleImageUploadRemoval(task);
  }, [removeImageUploadPlaceholder, syncImageUploadState, scheduleImageUploadRemoval]);

  /** 文件选择事件处理（工具栏按钮触发） */
  const handleImageFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      queueImageUpload(file);
    }
    e.target.value = "";
  }, [queueImageUpload]);

  // PERF-04: 组件卸载时取消所有飞行中上传，避免孤儿请求和资源泄漏。
  // 与 NoteEditor 中的 mountedRef 清理同步：mountedRef 在卸载时置 false，
  // 此 effect 在同一轮 cleanup 中取消所有未完成的上传任务。
  useEffect(() => {
    // imageUploadItemsRef 从不被整体重新赋值（仅 set/delete/clear），
    // 在 effect setup 时快照等价于清理时刻读取。
    const uploads = imageUploadItemsRef.current;
    return () => {
      imageUploadQueueRef.current = [];
      for (const upload of uploads.values()) {
        upload.status = "cancelled";
        upload.controller?.abort();
        if (upload.cleanupTimer) clearTimeout(upload.cleanupTimer);
      }
      uploads.clear();
      activeImageUploadsRef.current = 0;
    };
  }, []);

  return {
    uploadingCount,
    imageUploads,
    uploadError,
    setUploadError,
    imageFileInputRef,
    queueImageUpload,
    retryImageUpload,
    cancelImageUpload,
    handleImageFileSelect,
  };
}
