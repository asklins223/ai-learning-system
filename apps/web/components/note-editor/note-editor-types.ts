/**
 * PERF-04 拆分：NoteEditor 类型定义、接口和常量。
 *
 * 此模块从 NoteEditor.tsx 中提取所有类型声明、接口定义和模块级常量，
 * 使主组件文件专注于状态管理和渲染逻辑。
 */

import type {
  Block,
  CardGenerationRunStatus,
  CardGenerationStatus,
} from "@/lib/api";

// ─── 编辑器类型 ────────────────────────────────────────────────────

export type EditorMode = "edit" | "preview";
export type ViewMode = "normal" | "wide" | "fullscreen";
export type InspectorView = "overview" | "versions";
export type PreviewOutlineMode = "pinned" | "auto";
export type GenerationPhase = "saving" | "queued" | "running";
export type GenerationState =
  | "idle"
  | "checking"
  | "status-error"
  | "generating"
  | "generated"
  | "partial-ready";
export type GenerationResolutionAction = "retrying" | "restarting" | null;
export type SavingState = "idle" | "saving" | "saved" | "error" | "conflict" | "deleted";
export type ImageUploadStatus = "queued" | "uploading" | "failed" | "succeeded" | "cancelled";

// ─── 组件 Props ────────────────────────────────────────────────────

export interface NoteEditorProps {
  noteId: string;
  draftScope: string;
  noteVersionId: string;
  versionNo: number;
  initialTitle: string;
  titleSource?: "auto" | "manual";
  initialBlocks: Block[];
  initialGenerationStatus: CardGenerationStatus;
  returnHref?: string;
  returnLabel?: string;
}

// ─── 图片上传相关类型 ──────────────────────────────────────────────

export interface ImageUploadView {
  id: string;
  name: string;
  size: number;
  status: ImageUploadStatus;
  loaded: number;
  total: number;
  error: string | null;
}

export interface ImageUploadTask extends ImageUploadView {
  file: File;
  placeholder: string;
  controller: AbortController | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

// ─── 生成失败相关类型 ──────────────────────────────────────────────

export interface FailedGenerationUnit {
  unitId: string;
  kind: string;
  ordinal: number | null;
  status: string;
  errorCode: string | null;
}

export type FailedGenerationImage = FailedGenerationUnit;

// ─── 模块级常量 ────────────────────────────────────────────────────

export const LOCAL_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const PREVIEW_OUTLINE_PREFERENCE_KEY = "note-editor:preview-outline-mode";
export const CARD_GENERATION_RUN_STORAGE_PREFIX = "note-editor-card-generation-run:";
export const MAX_CONCURRENT_IMAGE_UPLOADS = 3;
export const IMAGE_UPLOAD_TIMEOUT_MS = 60_000;
export const IMAGE_UPLOAD_RESULT_VISIBLE_MS = 2_000;

/** Phase 2: 编辑会话超时——30 秒无编辑后封存当前会话版本。 */
export const SESSION_TIMEOUT_MS = 30_000;

/**
 * QUAL-07 修复说明：前端状态映射已从 NoteEditor.tsx 提取到独立模块。
 * CardGenerationRunStatus 类型从 @/lib/api 导入，与后端共享类型定义。
 * 此 Set 是运行时常量，无法从 TypeScript 类型自动派生。
 * 后端新增状态时，需同步更新此 Set 和 generationStageLabel 映射。
 * 建议在 CI 中添加 exhaustiveness 检查，确保前端覆盖所有后端状态。
 */
export const ACTIVE_GENERATION_RUN_STATUSES = new Set<CardGenerationRunStatus>([
  "queued",
  "preparing",
  "running",
  "validating",
  "publishing",
]);
