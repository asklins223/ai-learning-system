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
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EDITOR_PATH = resolve(
  import.meta.dirname,
  "../../components/NoteEditor.tsx",
);

const SOURCE = readFileSync(EDITOR_PATH, "utf-8");

describe("NoteEditor 404 handling (CONC-02, CONC-06)", () => {
  it("CONC-02: SavingState 类型应包含 'deleted'", () => {
    assert.ok(
      SOURCE.includes('"deleted"'),
      "SavingState 类型应包含 'deleted' 状态",
    );
  });

  it("CONC-02: save() catch 块应区分 404 与普通错误", () => {
    // 提取 save 函数体
    const saveStart = SOURCE.indexOf("const save = useCallback");
    assert.ok(saveStart !== -1, "应找到 save 函数定义");
    const saveEnd = SOURCE.indexOf("}, [", saveStart);
    const saveSection = SOURCE.slice(saveStart, saveEnd);

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
      SOURCE.includes('saving === "deleted"') || SOURCE.includes('saving === "deleted"'),
      "应有 saving === 'deleted' 的条件渲染",
    );
    assert.ok(
      SOURCE.includes("已被其他成员删除"),
      "应有'已被其他成员删除'的提示文案",
    );
  });

  it("CONC-06: DELETE 操作 catch 块应处理 404", () => {
    // 找到删除操作的 onConfirm 回调
    const deleteSection = SOURCE.slice(
      SOURCE.indexOf("isDeletingRef.current = true"),
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
      SOURCE.includes("CONC-04"),
      "应有 CONC-04 轮询逻辑",
    );
    assert.ok(
      SOURCE.includes("POLL_INTERVAL") || SOURCE.includes("30_000"),
      "应定义轮询间隔",
    );
    assert.ok(
      SOURCE.includes("setInterval"),
      "应使用 setInterval 设置轮询",
    );
  });

  it("CONC-05: restoreNoteVersion 应传递 baseVersionId", () => {
    const restoreSection = SOURCE.slice(
      SOURCE.indexOf("handleRestoreVersion"),
    );
    const restoreEnd = restoreSection.indexOf("function jumpToPreviewHeading");
    const restoreBody = restoreSection.slice(0, restoreEnd);

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
