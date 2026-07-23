"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { Icon } from "@/components/ui/icons";

const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB

export interface AvatarUploaderProps {
  currentUrl: string | null;
  displayName?: string | null;
  email?: string | null;
  /** 上传成功后回调（已认证场景，组件内部自动上传） */
  onUploaded?: (url: string) => void;
  /** 仅选择文件回调（未认证场景，如注册页面。父组件负责后续上传） */
  onFileSelected?: (file: File) => void;
  onError: (message: string) => void;
  disabled?: boolean;
  size?: number;
}

export function AvatarUploader({
  currentUrl,
  displayName,
  email,
  onUploaded,
  onFileSelected,
  onError,
  disabled = false,
  size = 80,
}: AvatarUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const fallbackLetter = (displayName?.trim() || email?.trim() || "")
    .charAt(0)
    .toUpperCase();
  const hasFallbackLetter = fallbackLetter.length > 0;

  const handleFile = useCallback(
    async (file: File) => {
      if (disabled || uploading) return;

      if (!ALLOWED_MIME_TYPES.includes(file.type)) {
        onError("仅支持 PNG、JPEG、WebP、GIF 格式");
        return;
      }
      if (file.size > MAX_AVATAR_SIZE) {
        onError("头像文件不能超过 2MB");
        return;
      }

      // onFileSelected 模式：仅返回 File 对象，不执行上传（用于未认证场景如注册页面）
      if (onFileSelected) {
        setAvatarFailed(false);
        onFileSelected(file);
        return;
      }

      if (!onUploaded) return;
      setUploading(true);
      try {
        const result = await api.uploadAvatar(file);
        setAvatarFailed(false);
        onUploaded(result.url);
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.status === 413
              ? "头像文件不能超过 2MB"
              : err.status === 415
                ? "仅支持 PNG、JPEG、WebP、GIF 格式"
                : err.status === 503
                  ? "存储服务暂不可用，请稍后重试"
                  : err.message
            : "头像上传失败，请重试";
        onError(message);
      } finally {
        setUploading(false);
      }
    },
    [disabled, uploading, onError, onUploaded, onFileSelected],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file);
      // Reset so selecting the same file again still triggers onChange
      e.target.value = "";
    },
    [handleFile],
  );

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      if (disabled || uploading) return;
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [disabled, uploading, handleFile],
  );

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!disabled && !uploading) setDragOver(true);
  }, [disabled, uploading]);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const triggerFilePicker = useCallback(() => {
    if (disabled || uploading) return;
    fileInputRef.current?.click();
  }, [disabled, uploading]);

  return (
    <div className="avatar-uploader" style={{ "--avatar-size": `${size}px` } as React.CSSProperties}>
      <div
        className={`avatar-uploader-zone${dragOver ? " is-drag-over" : ""}${uploading ? " is-uploading" : ""}`}
        onClick={triggerFilePicker}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="上传头像"
        aria-disabled={disabled || uploading}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            triggerFilePicker();
          }
        }}
      >
        {uploading ? (
          <span className="avatar-uploader-loading" aria-label="正在上传">
            <Icon.Refresh className="avatar-uploader-spin" />
          </span>
        ) : currentUrl && !avatarFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={currentUrl}
            alt="当前头像"
            width={size}
            height={size}
            onError={() => setAvatarFailed(true)}
          />
        ) : (
          <span className="avatar-uploader-fallback" aria-label="默认头像">
            {hasFallbackLetter ? (
              fallbackLetter
            ) : (
              <Icon.User className="avatar-uploader-placeholder-icon" />
            )}
          </span>
        )}
        {!uploading && (
          <span className="avatar-uploader-overlay">
            <Icon.Image />
            <span>上传</span>
          </span>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={handleInputChange}
        disabled={disabled || uploading}
        className="avatar-uploader-input"
        aria-hidden="true"
        tabIndex={-1}
      />
      <p className="avatar-uploader-hint">
        点击或拖拽图片上传 · PNG / JPEG / WebP / GIF · 最大 2MB
      </p>
    </div>
  );
}
