/**
 * 从 image block 的 content（格式为 ![alt](url)）中提取 objectKey。
 * 仅提取 /api/uploads/ 前缀的站内 URL，外部 URL 不处理。
 * 返回 null 表示该图片不是站内上传的（如外部 URL），无需清理。
 */
export function extractObjectKeyFromMarkdownImage(content: string): string | null {
  const m = /^!\[[^\]]*\]\(([^)]+)\)/.exec(content.trim());
  if (!m) return null;
  const url = m[1];
  if (!url.startsWith("/api/uploads/")) return null;
  return url.replace("/api/uploads/", "");
}
