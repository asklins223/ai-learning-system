export const MAX_MARKDOWN_IMPORT_FILES = 100;
export const MAX_MARKDOWN_CHARACTERS = 500_000;
export const MAX_MARKDOWN_TITLE_CHARACTERS = 200;

// UTF-8 下 500,000 个 JS 字符最多约 1.5 MB；读取前留出 BOM 与编码余量。
const MAX_MARKDOWN_FILE_BYTES = 2_000_000;

export interface MarkdownImportItem {
  title: string;
  content: string;
}

export interface MarkdownReadableFile {
  name: string;
  size: number;
  lastModified: number;
  type?: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface MarkdownImportFileRecord {
  key: string;
  sourceKey: string;
  fingerprint: string | null;
  name: string;
  size: number;
  lastModified: number;
  characterCount: number;
  item: MarkdownImportItem | null;
  error: string | null;
}

export interface MarkdownImportSelectionSummary {
  files: number;
  ready: number;
  characters: number;
  errors: number;
}

export function markdownFileKey(file: Pick<MarkdownReadableFile, "name" | "size" | "lastModified">) {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

export function isMarkdownFileName(name: string) {
  return /\.(?:md|markdown)$/i.test(name.trim());
}

export function markdownTitleFromFilename(name: string) {
  return name.replace(/\.(?:md|markdown)$/i, "").trim();
}

export function extractMarkdownTitle(content: string): string | null {
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (const line of content.split(/\n/)) {
    const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
    const fenceMatch = normalizedLine.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const run = fenceMatch[1];
      const marker = run[0] as "`" | "~";
      if (!fence) {
        fence = { marker, length: run.length };
      } else if (
        marker === fence.marker &&
        run.length >= fence.length &&
        fenceMatch[2].trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;

    const heading = normalizedLine.match(/^ {0,3}#{1,6}[\t ]+(.+?)[\t ]*$/);
    if (!heading) continue;
    const title = heading[1].replace(/[\t ]+#+[\t ]*$/, "").trim();
    if (title) return title;
  }

  return null;
}

/**
 * 文件元数据无法区分来自不同目录、恰好同名同大小的文件；用标题与正文生成
 * 一个轻量内容指纹，仅用于选择器去重。服务端仍会使用 SHA-256 做最终幂等判断。
 */
export function markdownContentFingerprint(title: string, content: string) {
  const value = `${title}\u0000${content}`;
  let first = 0xdeadbeef ^ value.length;
  let second = 0x41c6ce57 ^ value.length;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function errorRecord(file: MarkdownReadableFile, error: string): MarkdownImportFileRecord {
  const sourceKey = markdownFileKey(file);
  return {
    key: `${sourceKey}\u0000error`,
    sourceKey,
    fingerprint: null,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    characterCount: 0,
    item: null,
    error,
  };
}

export async function readMarkdownFile(file: MarkdownReadableFile): Promise<MarkdownImportFileRecord> {
  if (!isMarkdownFileName(file.name)) {
    return errorRecord(file, "仅支持 .md 或 .markdown 文件");
  }
  if (file.size === 0) {
    return errorRecord(file, "文件为空，无法创建笔记");
  }
  if (file.size > MAX_MARKDOWN_FILE_BYTES) {
    return errorRecord(file, `文件过大；单篇最多 ${MAX_MARKDOWN_CHARACTERS.toLocaleString("zh-CN")} 个字符`);
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return errorRecord(file, "文件读取失败，请重新选择");
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return errorRecord(file, "文件不是有效的 UTF-8 编码");
  }

  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)) {
    return errorRecord(file, "文件包含二进制控制字符，不是有效的 Markdown 文本");
  }
  if (!content.trim()) {
    return errorRecord(file, "文件仅包含空白内容，无法创建笔记");
  }
  if (content.length > MAX_MARKDOWN_CHARACTERS) {
    return errorRecord(
      file,
      `共 ${content.length.toLocaleString("zh-CN")} 个字符，超过单篇 ${MAX_MARKDOWN_CHARACTERS.toLocaleString("zh-CN")} 字符限制`,
    );
  }

  const title = extractMarkdownTitle(content) ?? markdownTitleFromFilename(file.name);
  if (!title) return errorRecord(file, "无法从文件名或 Markdown 标题取得笔记标题");
  if (title.length > MAX_MARKDOWN_TITLE_CHARACTERS) {
    return errorRecord(
      file,
      `笔记标题共 ${title.length} 个字符，超过 ${MAX_MARKDOWN_TITLE_CHARACTERS} 字符限制`,
    );
  }

  const sourceKey = markdownFileKey(file);
  const fingerprint = markdownContentFingerprint(title, content);
  return {
    key: `${sourceKey}\u0000${fingerprint}`,
    sourceKey,
    fingerprint,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    characterCount: content.length,
    item: { title, content },
    error: null,
  };
}

export async function readMarkdownFiles(files: readonly MarkdownReadableFile[]) {
  // 限制并发读取，避免一次选择大量文件时形成明显的内存峰值；结果仍保持原顺序。
  const results = new Array<MarkdownImportFileRecord>(files.length);
  let nextIndex = 0;
  const workerCount = Math.min(6, files.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < files.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await readMarkdownFile(files[index]);
      }
    }),
  );
  return results;
}

export function summarizeMarkdownFiles(
  files: readonly MarkdownImportFileRecord[],
): MarkdownImportSelectionSummary {
  return files.reduce<MarkdownImportSelectionSummary>(
    (summary, file) => ({
      files: summary.files + 1,
      ready: summary.ready + (file.item ? 1 : 0),
      characters: summary.characters + file.characterCount,
      errors: summary.errors + (file.error ? 1 : 0),
    }),
    { files: 0, ready: 0, characters: 0, errors: 0 },
  );
}

export function markdownSelectionError(files: readonly MarkdownImportFileRecord[]) {
  if (files.length > MAX_MARKDOWN_IMPORT_FILES) {
    return `当前选择 ${files.length} 个文件，单次最多导入 ${MAX_MARKDOWN_IMPORT_FILES} 个。`;
  }
  const errors = files.filter((file) => file.error).length;
  if (errors > 0) return `有 ${errors} 个文件无法导入，请移除异常文件或重新选择。`;
  return null;
}

export function formatMarkdownFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
