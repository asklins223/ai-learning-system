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

describe("multi-image upload queue contract", () => {
  it("bounds parallel uploads and tracks every file independently", () => {
    assert.ok(editorSource.includes("const MAX_CONCURRENT_IMAGE_UPLOADS = 3"));
    assert.ok(editorSource.includes("activeImageUploadsRef.current < MAX_CONCURRENT_IMAGE_UPLOADS"));
    assert.ok(editorSource.includes("imageUploadItemsRef"));
    assert.ok(editorSource.includes("imageUploadQueueRef"));
    assert.ok(editorSource.includes("imageUploads.map((upload)"));
    assert.ok(editorSource.includes('aria-label="图片上传队列"'));
    assert.ok(editorSource.includes('role="progressbar"'));
  });

  it("supports timeout, cancellation, retry, and failed-placeholder cleanup", () => {
    assert.ok(editorSource.includes("const IMAGE_UPLOAD_TIMEOUT_MS = 60_000"));
    assert.ok(editorSource.includes("new AbortController()"));
    assert.ok(editorSource.includes("task.controller?.abort()"));
    assert.ok(editorSource.includes("function retryImageUpload"));
    assert.ok(editorSource.includes("function cancelImageUpload"));
    assert.ok(editorSource.includes("removeImageUploadPlaceholder(task)"));
    assert.ok(editorSource.includes("请重试或移除上传失败的图片"));
    assert.ok(apiSource.includes("xhr.timeout = options.timeoutMs ?? 60_000"));
    assert.ok(apiSource.includes('"upload_timeout"'));
    assert.ok(apiSource.includes('"upload_cancelled"'));
  });

  it("renders actionable per-file states without hiding failures", () => {
    assert.ok(editorSource.includes('upload.status === "failed"'));
    assert.ok(editorSource.includes("重试"));
    assert.ok(editorSource.includes('"移除" : "取消"'));
    assert.match(editorStyles, /\.ne-upload-list\s*\{/);
    assert.match(editorStyles, /\.ne-upload-item\.is-failed\s*\{/);
    assert.match(editorStyles, /\.ne-upload-item-actions button\s*\{/);
  });
});
