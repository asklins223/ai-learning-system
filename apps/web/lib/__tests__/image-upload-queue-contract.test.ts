import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const editorSource = readFileSync(
  resolve((import.meta.dirname ?? __dirname), "../../components/NoteEditor.tsx"),
  "utf8",
);
const editorStyles = readFileSync(
  resolve((import.meta.dirname ?? __dirname), "../../app/styles/note-editor.css"),
  "utf8",
);
const apiSource = readFileSync(
  resolve((import.meta.dirname ?? __dirname), "../api.ts"),
  "utf8",
);

// PERF-04 拆分：图片上传逻辑已提取到 note-editor/ 目录下的独立模块。
// 测试需要同时检查主文件和拆分后的文件。
const noteEditorDir = resolve((import.meta.dirname ?? __dirname), "../../components/note-editor");
function readSubFile(name: string): string {
  return readFileSync(resolve(noteEditorDir, name), "utf8");
}
const useImageUploadsSource = readSubFile("useImageUploads.ts");
const useGenerationActionsSource = readSubFile("useGenerationActions.ts");
const imageUploadStatusSource = readSubFile("ImageUploadStatus.tsx");
const noteEditorTypesSource = readSubFile("note-editor-types.ts");

// 合并所有源码
const allSources = [
  editorSource,
  useImageUploadsSource,
  useGenerationActionsSource,
  imageUploadStatusSource,
  noteEditorTypesSource,
].join("\n");

describe("multi-image upload queue contract", () => {
  it("bounds parallel uploads and tracks every file independently", () => {
    assert.ok(allSources.includes("MAX_CONCURRENT_IMAGE_UPLOADS = 3"));
    assert.ok(allSources.includes("activeImageUploadsRef.current < MAX_CONCURRENT_IMAGE_UPLOADS"));
    assert.ok(allSources.includes("imageUploadItemsRef"));
    assert.ok(allSources.includes("imageUploadQueueRef"));
    assert.ok(allSources.includes("imageUploads.map((upload)"));
    assert.ok(allSources.includes('aria-label="图片上传队列"'));
    assert.ok(allSources.includes('role="progressbar"'));
  });

  it("supports timeout, cancellation, retry, and failed-placeholder cleanup", () => {
    assert.ok(allSources.includes("IMAGE_UPLOAD_TIMEOUT_MS = 60_000"));
    assert.ok(allSources.includes("new AbortController()"));
    assert.ok(allSources.includes("task.controller?.abort()"));
    assert.ok(allSources.includes("retryImageUpload"));
    assert.ok(allSources.includes("cancelImageUpload"));
    assert.ok(allSources.includes("removeImageUploadPlaceholder"));
    assert.ok(allSources.includes("请重试或移除上传失败的图片"));
    assert.ok(apiSource.includes("xhr.timeout = options.timeoutMs ?? 60_000"));
    assert.ok(apiSource.includes('"upload_timeout"'));
    assert.ok(apiSource.includes('"upload_cancelled"'));
  });

  it("renders actionable per-file states without hiding failures", () => {
    assert.ok(allSources.includes('upload.status === "failed"'));
    assert.ok(allSources.includes("重试"));
    assert.ok(allSources.includes('"移除" : "取消"'));
    assert.match(editorStyles, /\.ne-upload-list\s*\{/);
    assert.match(editorStyles, /\.ne-upload-item\.is-failed\s*\{/);
    assert.match(editorStyles, /\.ne-upload-item-actions button\s*\{/);
  });
});
