/**
 * CONC-02 / CONC-06: NoteEditor 404 "deleted" 状态处理测试
 *
 * 验证 NoteEditor 组件在保存/删除操作收到 404 时：
 * - 正确设置 SavingState = "deleted"（而非 "error"）
 * - 阻止后续保存（noteDeletedRef）
 * - 显示专用提示条（而非通用"保存失败"）
 * - DELETE 操作收到 404 时直接导航返回
 *
 * 采用源码检查方式，与 CONC-01 测试一致。
 * PERF-04 拆分：保存逻辑已提取到 useNoteSave.ts，冲突解决已提取到
 * useConflictResolution.ts，通知横幅已提取到 NoticeBanners.tsx。
 * 测试需要检查所有拆分后的文件。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const noteEditorDir = resolve(
  (import.meta.dirname ?? __dirname),
  "../../components/note-editor",
);
function readSubFile(name: string): string {
  return readFileSync(resolve(noteEditorDir, name), "utf8");
}

const editorSource = readFileSync(
  resolve((import.meta.dirname ?? __dirname), "../../components/NoteEditor.tsx"),
  "utf8",
);
const useNoteSaveSource = readSubFile("useNoteSave.ts");
const useConflictResolutionSource = readSubFile("useConflictResolution.ts");
const noticeBannersSource = readSubFile("NoticeBanners.tsx");
const noteEditorTypesSource = readSubFile("note-editor-types.ts");

// 合并所有源码
const allSources = [
  editorSource,
  useNoteSaveSource,
  useConflictResolutionSource,
  noticeBannersSource,
  noteEditorTypesSource,
].join("\n");

describe("NoteEditor 404 handling (CONC-02, CONC-06)", () => {
  it("CONC-02: SavingState 类型应包含 'deleted'", () => {
    assert.ok(
      allSources.includes('"deleted"'),
      "SavingState 类型应包含 'deleted' 状态",
    );
  });

  it("CONC-02: save() catch 块应区分 404 与普通错误", () => {
    // save 函数已提取到 useNoteSave.ts
    const saveStart = useNoteSaveSource.indexOf("const save = useCallback");
    assert.ok(saveStart !== -1, "应在 useNoteSave.ts 中找到 save 函数定义");
    const saveEnd = useNoteSaveSource.indexOf("}, [", saveStart);
    const saveSection = useNoteSaveSource.slice(saveStart, saveEnd);

    assert.ok(
      saveSection.includes('err.status === 404'),
      "save() catch 块应检查 err.status === 404",
    );
    assert.ok(
      saveSection.includes('setSaving("deleted")'),
      "save() 收到 404 时应设置 setSaving('deleted')",
    );
    assert.ok(
      saveSection.includes('noteDeletedRef.current = true'),
      "save() 收到 404 时应设置 noteDeletedRef.current = true 阻止后续保存",
    );
  });

  it("CONC-02: 应有 'deleted' 状态的提示条 UI", () => {
    assert.ok(
      allSources.includes('saving === "deleted"'),
      "应有 saving === 'deleted' 的条件渲染",
    );
    assert.ok(
      allSources.includes("已被其他成员删除"),
      "应有'已被其他成员删除'的提示文案",
    );
  });

  it("CONC-06: DELETE 操作 catch 块应处理 404", () => {
    // 删除操作的 onConfirm 回调仍在 NoteEditor.tsx 中（ConfirmDialogs 内联）
    const deleteSection = editorSource.slice(
      editorSource.indexOf("isDeletingRef.current = true"),
    );
    const deleteEnd = deleteSection.indexOf("finally");
    const deleteBody = deleteSection.slice(0, deleteEnd);

    assert.ok(
      deleteBody.includes('err.status === 404'),
      "DELETE 操作 catch 块应检查 err.status === 404",
    );
    assert.ok(
      deleteBody.includes("router.replace") || deleteBody.includes("router.push"),
      "DELETE 收到 404 时应导航返回",
    );
  });

  it("CONC-04: 应有轮询检测笔记被删除/修改的逻辑", () => {
    assert.ok(
      allSources.includes("CONC-04"),
      "应有 CONC-04 轮询逻辑",
    );
    assert.ok(
      allSources.includes("POLL_INTERVAL") || allSources.includes("30_000"),
      "应定义轮询间隔",
    );
    assert.ok(
      allSources.includes("setInterval"),
      "应使用 setInterval 设置轮询",
    );
  });

  it("CONC-04: 应丢弃保存期间已经过期的轮询响应", () => {
    const pollStart = useNoteSaveSource.indexOf("const checkNoteStatus");
    assert.ok(pollStart !== -1, "应在 useNoteSave.ts 中找到 checkNoteStatus");
    const pollEnd = useNoteSaveSource.indexOf("const intervalId", pollStart);
    const pollSection = useNoteSaveSource.slice(pollStart, pollEnd);

    assert.ok(
      pollSection.includes("const pollBaseline"),
      "轮询发起前应记录已保存状态快照",
    );
    assert.ok(
      pollSection.includes("savedVersionIdRef.current !== pollBaseline.versionId"),
      "轮询返回后应检查版本基线是否已推进",
    );
    assert.ok(
      pollSection.includes("lastSavedSourceRef.current !== pollBaseline.source"),
      "会话内自动保存复用版本 ID 时仍应检查正文基线",
    );
    assert.ok(
      pollSection.includes("saveInFlightRef.current"),
      "保存正在进行时不应应用轮询响应",
    );
  });

  it("标题-only 保存不应重建正文块并丢失来源引用", () => {
    const saveStart = useNoteSaveSource.indexOf("const save = useCallback");
    const saveEnd = useNoteSaveSource.indexOf("const flushLatestDraft", saveStart);
    const saveSection = useNoteSaveSource.slice(saveStart, saveEnd);

    assert.ok(
      saveSection.includes("const sourceChanged"),
      "保存前应独立判断正文是否改变",
    );
    assert.ok(
      saveSection.includes("...(blocks ? { blocks } : {})"),
      "标题-only 保存不应发送 blocks",
    );

    // beforeunload 保存也在 useNoteSave.ts 中
    const unloadStart = useNoteSaveSource.indexOf("const onBeforeUnload");
    if (unloadStart !== -1) {
      const unloadEnd = useNoteSaveSource.indexOf("window.addEventListener", unloadStart);
      const unloadSection = useNoteSaveSource.slice(unloadStart, unloadEnd);
      assert.ok(
        unloadSection.includes("const sourceChanged"),
        "beforeunload 保存也应独立判断正文是否改变",
      );
      assert.ok(
        unloadSection.includes("...(blocks"),
        "beforeunload 的标题-only 请求不应发送 blocks",
      );
    } else {
      // beforeunload 可能以不同方式命名，检查所有源码
      assert.ok(
        allSources.includes("const sourceChanged"),
        "保存前应独立判断正文是否改变（在任意文件中）",
      );
    }
  });

  it("CONC-05: restoreNoteVersion 应传递 baseVersionId", () => {
    // handleRestoreVersion 已提取到 useConflictResolution.ts
    const restoreStart = useConflictResolutionSource.indexOf("handleRestoreVersion");
    assert.ok(restoreStart !== -1, "应在 useConflictResolution.ts 中找到 handleRestoreVersion");
    const restoreBody = useConflictResolutionSource.slice(restoreStart);

    assert.ok(
      restoreBody.includes("baseVersionId"),
      "handleRestoreVersion 应传递 baseVersionId",
    );
    assert.ok(
      restoreBody.includes("savedVersionIdRef.current"),
      "应使用 savedVersionIdRef.current 作为 baseVersionId",
    );
    assert.ok(
      restoreBody.includes('err.status === 409'),
      "应处理 409 冲突",
    );
  });
});
