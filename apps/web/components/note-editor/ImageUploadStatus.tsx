"use client";

/**
 * PERF-04 拆分（第十二轮）：图片上传状态组件。
 *
 * 从 NoteEditor.tsx 提取图片上传进度列表和隐藏文件输入，
 * 减少主文件约 90 行 JSX。
 */
import type { ChangeEvent, RefObject } from "react";
import {
  type ImageUploadView,
  MAX_CONCURRENT_IMAGE_UPLOADS,
} from "./note-editor-types";
import {
  imageUploadStatusLabel,
  imageUploadProgress,
} from "./note-editor-utils";

/** 图片上传状态组件属性 */
export interface ImageUploadStatusProps {
  /** 上传队列视图列表 */
  imageUploads: ImageUploadView[];
  /** 正在上传的数量 */
  uploadingCount: number;
  /** 上传失败的数量 */
  failedImageUploadCount: number;
  /** 上传错误信息 */
  uploadError: string | null;
  /** 隐藏文件输入引用 */
  imageFileInputRef: RefObject<HTMLInputElement | null>;
  /** 重试上传回调 */
  onRetry: (id: string) => void;
  /** 取消/移除上传回调 */
  onCancel: (id: string) => void;
  /** 文件选择回调 */
  onFileSelect: (event: ChangeEvent<HTMLInputElement>) => void;
}

/**
 * 图片上传状态面板。
 *
 * 渲染上传队列摘要、每张图片的进度条和操作按钮，
 * 以及隐藏的文件输入元素。
 */
export function ImageUploadStatus({
  imageUploads,
  uploadingCount,
  failedImageUploadCount,
  uploadError,
  imageFileInputRef,
  onRetry,
  onCancel,
  onFileSelect,
}: ImageUploadStatusProps) {
  return (
    <>
      {imageUploads.length > 0 && (
        <div className="ne-upload-status" aria-live="polite">
          <div className="ne-upload-summary">
            <span>
              {uploadingCount > 0
                ? `正在处理 ${uploadingCount} 张图片`
                : failedImageUploadCount > 0
                  ? `${failedImageUploadCount} 张图片需要处理`
                  : "图片上传已完成"}
            </span>
            <span>最多同时上传 {MAX_CONCURRENT_IMAGE_UPLOADS} 张</span>
          </div>
          <ul className="ne-upload-list" aria-label="图片上传队列">
            {imageUploads.map((upload) => {
              const progress = imageUploadProgress(upload);
              return (
                <li
                  key={upload.id}
                  className={`ne-upload-item is-${upload.status}`}
                >
                  <div className="ne-upload-item-header">
                    <span className="ne-upload-file-name" title={upload.name}>
                      {upload.name}
                    </span>
                    <span className="ne-upload-item-status">
                      {imageUploadStatusLabel(upload.status)}
                    </span>
                  </div>
                  {(upload.status === "uploading" || upload.status === "succeeded") && (
                    <span
                      className="ne-upload-progress-bar"
                      role="progressbar"
                      aria-label={`${upload.name} 上传进度`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progress}
                    >
                      <span
                        className="ne-upload-progress-fill"
                        style={{ width: `${progress}%` }}
                      />
                      <span className="ne-upload-progress-text">{progress}%</span>
                    </span>
                  )}
                  {upload.error && (
                    <span className="ne-upload-item-error" role="alert">
                      {upload.error}
                    </span>
                  )}
                  <span className="ne-upload-item-actions">
                    {upload.status === "failed" && (
                      <button
                        type="button"
                        onClick={() => onRetry(upload.id)}
                      >
                        重试
                      </button>
                    )}
                    {(upload.status === "queued" ||
                      upload.status === "uploading" ||
                      upload.status === "failed") && (
                      <button
                        type="button"
                        onClick={() => onCancel(upload.id)}
                      >
                        {upload.status === "failed" ? "移除" : "取消"}
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {uploadError && (
        <div className="ne-upload-error" role="alert">
          {uploadError}
        </div>
      )}
      {/* 隐藏文件输入 — 由工具栏"插入图片"按钮触发 click */}
      <input
        ref={imageFileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        style={{ display: "none" }}
        onChange={onFileSelect}
      />
    </>
  );
}
