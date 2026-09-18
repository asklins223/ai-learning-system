import { describe, expect, it } from "vitest";
import {
  MAX_CAPTURE_BYTES,
  TEXT_FILE_PATTERN,
  captureBytes,
  formatCaptureSize,
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
});
