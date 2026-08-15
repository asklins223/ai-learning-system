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
const notePageSource = readFileSync(
  resolve((import.meta.dirname ?? __dirname), "../../app/(workspace)/(focus)/notes/[id]/page.tsx"),
  "utf8",
);

// PERF-04 拆分（第十二轮）：部分 UI 逻辑已提取到 note-editor/ 目录下的独立组件和 Hook。
// 测试需要同时检查主文件和拆分后的文件，确保关键代码未被意外遗漏。
const noteEditorDir = resolve((import.meta.dirname ?? __dirname), "../../components/note-editor");
function readSubFile(name: string): string {
  return readFileSync(resolve(noteEditorDir, name), "utf8");
}
const editorToolbarSource = readSubFile("EditorToolbar.tsx");
const editorFooterSource = readSubFile("EditorFooter.tsx");
const imageUploadStatusSource = readSubFile("ImageUploadStatus.tsx");
const useGenerationActionsSource = readSubFile("useGenerationActions.ts");
const generationOverlaySource = readSubFile("GenerationOverlay.tsx");
const generationFailureDialogSource = readSubFile("GenerationFailureDialog.tsx");
const generationPanelSource = readSubFile("GenerationPanel.tsx");
const outlinePanelSource = readSubFile("OutlinePanel.tsx");
const conflictDialogSource = readSubFile("ConflictDialog.tsx");
// PERF-04 拆分（第十三轮）：新增提取的 hook 和组件
const useNoteSaveSource = readSubFile("useNoteSave.ts");
const useGenerationPollingSource = readSubFile("useGenerationPolling.ts");
const useConflictResolutionSource = readSubFile("useConflictResolution.ts");
const useEditorNavigationSource = readSubFile("useEditorNavigation.ts");
const noticeBannersSource = readSubFile("NoticeBanners.tsx");
// PERF-04 拆分（第十四轮）：新增提取的 hook 和组件
const useGenerationPresentationSource = readSubFile("useGenerationPresentation.ts");
const useNoteActionsSource = readSubFile("useNoteActions.ts");
const previewOutlineSidebarSource = readSubFile("PreviewOutlineSidebar.tsx");
const editorSectionSource = readSubFile("EditorSection.tsx");

// 合并所有源码，用于检查代码是否存在于任意文件中
const allSources = [
  editorSource,
  editorToolbarSource,
  editorFooterSource,
  imageUploadStatusSource,
  useGenerationActionsSource,
  generationOverlaySource,
  generationFailureDialogSource,
  generationPanelSource,
  outlinePanelSource,
  conflictDialogSource,
  useNoteSaveSource,
  useGenerationPollingSource,
  useConflictResolutionSource,
  useEditorNavigationSource,
  noticeBannersSource,
  useGenerationPresentationSource,
  useNoteActionsSource,
  previewOutlineSidebarSource,
  editorSectionSource,
].join("\n");

describe("NoteEditor reading and generation UI contract", () => {
  it("keeps edit mode viewport-locked across the desktop shell breakpoint", () => {
    assert.match(
      editorStyles,
      /@media \(min-width: 960px\) and \(min-height: 620px\)/,
    );
    assert.match(
      editorStyles,
      /\.note-workbench \.ne-editor-pane \.milkdown-editor\s*\{[\s\S]*?min-height: 0;[\s\S]*?overflow-y: auto;/,
    );
    assert.match(
      editorStyles,
      /\.note-workbench\[data-editor-mode="preview"\]\s*\{[\s\S]*?overflow-y: auto;/,
    );
    assert.ok(
      editorStyles.includes(
        '.app-canvas[data-page="note-editor"] .note-workbench[data-editor-mode="preview"] .ne-editor-pane',
      ),
      "preview overflow override must outrank the fixed editor-pane rule",
    );
  });

  it("keeps a dedicated preview outline visible by default and persists auto-hide", () => {
    assert.match(editorSource, /useState<PreviewOutlineMode>\("pinned"\)/);
    assert.ok(editorSource.includes("PREVIEW_OUTLINE_PREFERENCE_KEY"));
    // PERF-04 拆分（第十四轮）：预览目录 JSX 提取到 PreviewOutlineSidebar.tsx
    assert.ok(allSources.includes('className="ne-preview-outline"'));
    assert.ok(allSources.includes("aria-expanded={outlineOpen}"));
    assert.ok(allSources.includes("inert={!outlineOpen ? true : undefined}"));
    assert.ok(allSources.includes('aria-label="收起文章目录"') || allSources.includes('aria-label="显示文章目录"'));
    assert.ok(allSources.includes("!event.currentTarget.contains(document.activeElement)"));
    assert.ok(allSources.includes('event.pointerType !== "mouse"'));
    assert.ok(allSources.includes('event.pointerType === "mouse"'));
    assert.ok(allSources.includes("tabIndex={outlineOpen ? -1 : 0}"));
    assert.match(editorStyles, /data-preview-outline-mode="auto"/);
    assert.match(editorStyles, /@media \(min-width: 1100px\) and \(pointer: coarse\)/);
    assert.match(editorStyles, /\.ne-outline-item\s*\{[\s\S]*?display: block;[\s\S]*?border: 0;[\s\S]*?padding: 0;/);
  });

  it("marks and tracks the active article heading", () => {
    assert.ok(allSources.includes('aria-current={activeOutlineKey === blockKey ? "location" : undefined}'));
    assert.ok(allSources.includes("updateActiveHeading"));
    assert.ok(allSources.includes('scrollIntoView({ behavior: "smooth", block: "start" })'));
    assert.match(editorStyles, /\.ne-outline-link\[aria-current="location"\]/);
  });

  it("only blocks the save-and-accept handshake, then exposes resumable run progress", () => {
    assert.ok(editorSource.includes("useModalIsolation(generationOverlayRef, generationOverlayActive)"));
    assert.ok(editorSource.includes("useFocusTrap(generationOverlayRef, generationOverlayActive)"));
    assert.ok(editorSource.includes('genState === "generating" && generationPhase === "saving"'));
    assert.ok(editorSource.includes("generationOverlayActive = isOwner && generationLocked"));
    assert.ok(allSources.includes('className="ne-generation-dialog lcg-dialog"'));
    assert.ok(allSources.includes('aria-modal={active ? "true" : "false"}'));
    assert.ok(allSources.includes("api.createCardGenerationRun"));
    assert.ok(allSources.includes("api.getCardGenerationRun"));
    assert.ok(allSources.includes("api.getLatestCardGenerationRun"));
    assert.ok(allSources.includes("api.cancelCardGenerationRun"));
    assert.ok(allSources.includes("accepted.canContinueEditing"));
    assert.ok(allSources.includes("endSession();"));
    assert.ok(allSources.includes('className="note-editor-generation-progress lcgp-progress"'));
    assert.ok(allSources.includes('className="note-editor-generation-cancel"'));
    assert.ok(allSources.includes("generationRun?.sourceSnapshot.versionNo"));
    assert.ok(allSources.includes("GenerationPhaseRail"));
    assert.ok(allSources.includes("uploadingCount") && allSources.includes("generationLockedRef.current"));
    assert.ok(notePageSource.includes('state: "checking"'));
    assert.ok(!editorSource.includes("生成完成前已暂停编辑"));
    assert.ok(!editorSource.includes('aria-busy="true"'));
    assert.match(editorStyles, /\.ne-generation-overlay\s*\{/);
    assert.match(editorStyles, /\.lcgp-progress\.note-editor-generation-progress\s*\{/);
    assert.match(editorStyles, /\.note-editor-generation-cancel\s*\{/);
  });
});
