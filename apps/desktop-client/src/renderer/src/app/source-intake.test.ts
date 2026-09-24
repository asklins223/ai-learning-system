// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  MAX_CAPTURE_BYTES,
  NOTE_PAPER_IMAGE_DROP_ATTR,
  TEXT_FILE_PATTERN,
  captureBytes,
  formatCaptureSize,
  imageOnlyFiles,
  isOwnedDropTarget,
  markLinkSeen,
  readSeenLinks,
  titleFromFileName,
} from "./source-intake";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => { data.delete(key); },
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

describe("source-intake", () => {
  it("文本后缀白名单与来源库采集栏一致", () => {
    expect(TEXT_FILE_PATTERN.test("note.md")).toBe(true);
    expect(TEXT_FILE_PATTERN.test("app.tsx")).toBe(true);
    expect(TEXT_FILE_PATTERN.test("data.csv")).toBe(true);
    expect(TEXT_FILE_PATTERN.test("photo.png")).toBe(false);
    expect(TEXT_FILE_PATTERN.test("deck.pdf")).toBe(false);
    expect(TEXT_FILE_PATTERN.test("archive.zip")).toBe(false);
  });

  it("900 KB 上限与中文尺寸文案", () => {
    expect(MAX_CAPTURE_BYTES).toBe(900_000);
    expect(captureBytes("a".repeat(1024))).toBe(1024);
    expect(formatCaptureSize(512)).toBe("512 字节");
    expect(formatCaptureSize(2048)).toBe("2.0 KB");
  });

  it("文件名去后缀做标题，无后缀原样返回", () => {
    expect(titleFromFileName("study-notes.md")).toBe("study-notes");
    expect(titleFromFileName("README")).toBe("README");
    expect(titleFromFileName("  ")).toBe("");
  });

  it("问过的链接只记最近 100 个", () => {
    const storage = memoryStorage();
    expect(readSeenLinks(storage).size).toBe(0);
    markLinkSeen("https://a.test/1", storage);
    expect(readSeenLinks(storage).has("https://a.test/1")).toBe(true);
    for (let index = 0; index < 120; index += 1) {
      markLinkSeen(`https://a.test/${index}`, storage);
    }
    const seen = readSeenLinks(storage);
    expect(seen.size).toBeLessThanOrEqual(100);
    expect(seen.has("https://a.test/119")).toBe(true);
  });

  it("坏掉的存储不炸，退回空集合", () => {
    const broken = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    };
    expect(readSeenLinks(broken)).toEqual(new Set());
    expect(markLinkSeen("https://a.test/1", broken).has("https://a.test/1")).toBe(true);
    expect(readSeenLinks(null)).toEqual(new Set());
  });

  /** jsdom 造不出真 DataTransfer，而这两条判据只读 `files` 一项。 */
  function transferOf(...files: { name: string; type: string }[]): DataTransfer {
    return {
      files: files.map((file) => new File(["内容"], file.name, { type: file.type })),
    } as unknown as DataTransfer;
  }
  const PNG = { name: "截屏.png", type: "image/png" };
  const MARKDOWN = { name: "note.md", type: "text/markdown" };

  it("整份都是图片才算「往正文里放图」，混进别的文件就交回采集器", () => {
    expect(imageOnlyFiles(transferOf(PNG)).map((file) => file.name)).toEqual(["截屏.png"]);
    expect(imageOnlyFiles(transferOf(PNG, { name: "b.jpg", type: "image/jpeg" }))).toHaveLength(2);
    expect(imageOnlyFiles(transferOf(PNG, MARKDOWN))).toEqual([]);
    expect(imageOnlyFiles(transferOf(MARKDOWN))).toEqual([]);
    expect(imageOnlyFiles(null)).toEqual([]);
    expect(imageOnlyFiles({ files: [] } as unknown as DataTransfer)).toEqual([]);
  });

  it("落点归属：编辑器与表单收文字，笔记纸面只收整份图片", () => {
    const paper = document.createElement("div");
    paper.setAttribute(NOTE_PAPER_IMAGE_DROP_ATTR, "");
    const spot = document.createElement("span");
    paper.appendChild(spot);
    const input = document.createElement("input");
    const chrome = document.createElement("div");

    expect(isOwnedDropTarget(spot, transferOf(PNG))).toBe(true);
    // 同一处落点，拖的是文本文件：纸面不认领，全局浮层该照常 arm 去收来源。
    expect(isOwnedDropTarget(spot, transferOf(MARKDOWN))).toBe(false);
    expect(isOwnedDropTarget(chrome, transferOf(PNG))).toBe(false);
    expect(isOwnedDropTarget(input, transferOf(PNG))).toBe(true);
    expect(isOwnedDropTarget(document.body, null)).toBe(false);
  });
});
