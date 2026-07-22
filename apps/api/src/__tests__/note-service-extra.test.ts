/**
 * note/service.ts 纯函数补充测试
 *
 * 覆盖 cleanTitleCandidate 和 deriveNoteTitle 的各种输入场景，
 * 以及 RevisionConflictError 类行为。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanTitleCandidate,
  deriveNoteTitle,
  RevisionConflictError,
} from "../modules/note/service.ts";

// ─── cleanTitleCandidate ─────────────────────────────────────────────────

test("cleanTitleCandidate 去除首尾空白", () => {
  assert.equal(cleanTitleCandidate("  hello  "), "hello");
});

test("cleanTitleCandidate 去除 HTML heading 标签", () => {
  assert.equal(cleanTitleCandidate("<h1>标题</h1>"), "标题");
  assert.equal(cleanTitleCandidate("<h2>副标题</h2>"), "副标题");
  assert.equal(cleanTitleCandidate("<H3>大写标签</H3>"), "大写标签");
});

test("cleanTitleCandidate 去除 Markdown heading 前缀", () => {
  assert.equal(cleanTitleCandidate("# 标题"), "标题");
  assert.equal(cleanTitleCandidate("## 副标题"), "副标题");
  assert.equal(cleanTitleCandidate("###### 六级标题"), "六级标题");
});

test("cleanTitleCandidate 去除引用前缀", () => {
  assert.equal(cleanTitleCandidate("> 引用内容"), "引用内容");
  assert.equal(cleanTitleCandidate(">引用无空格"), "引用无空格");
});

test("cleanTitleCandidate 去除列表前缀", () => {
  assert.equal(cleanTitleCandidate("- 无序列表项"), "无序列表项");
  assert.equal(cleanTitleCandidate("* 无序列表项"), "无序列表项");
  assert.equal(cleanTitleCandidate("+ 无序列表项"), "无序列表项");
  assert.equal(cleanTitleCandidate("1. 有序列表项"), "有序列表项");
  assert.equal(cleanTitleCandidate("99. 多位有序列表"), "多位有序列表");
});

test("cleanTitleCandidate 去除中点前缀", () => {
  assert.equal(cleanTitleCandidate("· 中点开头"), "中点开头");
});

test("cleanTitleCandidate 去除反引号", () => {
  assert.equal(cleanTitleCandidate("`inline code`"), "inline code");
  assert.equal(cleanTitleCandidate("```code block```"), "code block");
});

test("cleanTitleCandidate 合并多余空白", () => {
  assert.equal(cleanTitleCandidate("hello   world   test"), "hello world test");
  assert.equal(cleanTitleCandidate("多\n行\n文本"), "多 行 文本");
});

test("cleanTitleCandidate 组合前缀去除", () => {
  assert.equal(cleanTitleCandidate("# `标题`"), "标题");
  assert.equal(cleanTitleCandidate("> 1. **引用列表**"), "**引用列表**");
});

test("cleanTitleCandidate 空字符串返回空", () => {
  assert.equal(cleanTitleCandidate(""), "");
  assert.equal(cleanTitleCandidate("   "), "");
});

// ─── deriveNoteTitle ─────────────────────────────────────────────────────

test("deriveNoteTitle 优先使用 heading block", () => {
  const blocks = [
    { type: "paragraph" as const, content: "段落内容" },
    { type: "heading" as const, content: "标题内容" },
    { type: "paragraph" as const, content: "另一段落" },
  ];
  assert.equal(deriveNoteTitle(blocks), "标题内容");
});

test("deriveNoteTitle 无 heading 时使用第一个有内容的 block", () => {
  const blocks = [
    { type: "paragraph" as const, content: "" },
    { type: "paragraph" as const, content: "第一个有内容的段落" },
    { type: "paragraph" as const, content: "第二个段落" },
  ];
  assert.equal(deriveNoteTitle(blocks), "第一个有内容的段落");
});

test("deriveNoteTitle 无内容时返回无标题笔记", () => {
  assert.equal(deriveNoteTitle([]), "无标题笔记");
  assert.equal(deriveNoteTitle([{ type: "paragraph", content: "" }]), "无标题笔记");
  assert.equal(deriveNoteTitle([{ type: "paragraph", content: "   " }]), "无标题笔记");
});

test("deriveNoteTitle 标题截断到60字符", () => {
  const longTitle = "这是一个非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的标题";
  const blocks = [{ type: "heading" as const, content: longTitle }];
  const result = deriveNoteTitle(blocks);
  assert.ok(result.length <= 60, `标题应截断到60字符，实际 ${result.length}`);
});

test("deriveNoteTitle 清理 heading 的 Markdown 前缀", () => {
  const blocks = [{ type: "heading" as const, content: "## Markdown 标题" }];
  assert.equal(deriveNoteTitle(blocks), "Markdown 标题");
});

test("deriveNoteTitle 处理 code block", () => {
  const blocks = [{ type: "code" as const, content: "const x = 1;" }];
  assert.equal(deriveNoteTitle(blocks), "const x = 1;");
});

test("deriveNoteTitle 处理 image block", () => {
  const blocks = [{ type: "image" as const, content: "图片描述" }];
  assert.equal(deriveNoteTitle(blocks), "图片描述");
});

test("deriveNoteTitle 跳过空内容的 heading 使用下一个 block", () => {
  const blocks = [
    { type: "heading" as const, content: "" },
    { type: "paragraph" as const, content: "段落内容" },
  ];
  assert.equal(deriveNoteTitle(blocks), "段落内容");
});

test("deriveNoteTitle 接受 NoteBlock 类型（含 ordinal）", () => {
  const blocks = [
    { ordinal: 0, type: "heading" as const, content: "带序号的标题" },
  ];
  assert.equal(deriveNoteTitle(blocks), "带序号的标题");
});

// ─── RevisionConflictError ───────────────────────────────────────────────

test("RevisionConflictError 包含正确的 name 和 message", () => {
  const err = new RevisionConflictError("version-123");
  assert.equal(err.name, "RevisionConflictError");
  assert.equal(err.message, "note version conflict");
});

test("RevisionConflictError 包含 currentVersionId", () => {
  const err = new RevisionConflictError("version-123");
  assert.equal(err.currentVersionId, "version-123");
});

test("RevisionConflictError currentVersionId 可为 null", () => {
  const err = new RevisionConflictError(null);
  assert.equal(err.currentVersionId, null);
});

test("RevisionConflictError 是 Error 的实例", () => {
  const err = new RevisionConflictError("v1");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof RevisionConflictError);
});
