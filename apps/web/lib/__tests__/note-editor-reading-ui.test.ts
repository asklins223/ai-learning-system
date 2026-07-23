import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const editorSource = readFileSync(
  resolve(import.meta.dirname, "../../components/NoteEditor.tsx"),
  "utf8",
);
const editorStyles = readFileSync(
  resolve(import.meta.dirname, "../../app/styles/note-editor.css"),
  "utf8",
);
const notePageSource = readFileSync(
  resolve(import.meta.dirname, "../../app/(workspace)/(focus)/notes/[id]/page.tsx"),
  "utf8",
);

describe("NoteEditor reading and generation UI contract", () => {
  it("keeps a dedicated preview outline visible by default and persists auto-hide", () => {
    assert.match(editorSource, /useState<PreviewOutlineMode>\("pinned"\)/);
    assert.ok(editorSource.includes("note-editor:preview-outline-mode"));
    assert.ok(editorSource.includes('className="ne-preview-outline"'));
    assert.ok(editorSource.includes("aria-expanded={previewOutlineOpen}"));
    assert.ok(editorSource.includes("inert={!previewOutlineOpen ? true : undefined}"));
    assert.ok(editorSource.includes('aria-label="收起文章目录"'));
    assert.ok(editorSource.includes("!event.currentTarget.contains(document.activeElement)"));
    assert.ok(editorSource.includes('event.pointerType !== "mouse"'));
    assert.ok(editorSource.includes('event.pointerType === "mouse"'));
    assert.ok(editorSource.includes("tabIndex={previewOutlineOpen ? -1 : 0}"));
    assert.match(editorStyles, /data-preview-outline-mode="auto"/);
    assert.match(editorStyles, /@media \(min-width: 1100px\) and \(pointer: coarse\)/);
    assert.match(editorStyles, /\.ne-outline-item\s*\{[\s\S]*?display: block;[\s\S]*?border: 0;[\s\S]*?padding: 0;/);
  });

  it("marks and tracks the active article heading", () => {
    assert.ok(editorSource.includes('aria-current={activeOutlineKey === blockKey ? "location" : undefined}'));
    assert.ok(editorSource.includes("updateActiveHeading"));
    assert.ok(editorSource.includes('scrollIntoView({ behavior: "smooth", block: "start" })'));
    assert.match(editorStyles, /\.ne-outline-link\[aria-current="location"\]/);
  });

  it("blocks editing with an accessible modal while card generation is active", () => {
    assert.ok(editorSource.includes("useModalIsolation(generationOverlayRef, generationOverlayActive)"));
    assert.ok(editorSource.includes("useFocusTrap(generationOverlayRef, generationOverlayActive)"));
    assert.ok(editorSource.includes('className="ne-generation-dialog"'));
    assert.ok(editorSource.includes('aria-modal="true"'));
    assert.ok(editorSource.includes('genState === "generating"'));
    assert.ok(editorSource.includes('genState === "checking"'));
    assert.ok(editorSource.includes('genState === "status-error"'));
    assert.ok(editorSource.includes("uploadingCountRef.current > 0"));
    assert.ok(editorSource.includes("generationLockedRef.current"));
    assert.ok(notePageSource.includes('state: "checking"'));
    assert.ok(!editorSource.includes('aria-busy="true"'));
    assert.match(editorStyles, /\.ne-generation-overlay\s*\{/);
  });
});
