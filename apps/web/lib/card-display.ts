const KEY_POINT_PREFIX =
  /^(?:(?:关键)?要点)\s*(?:\d+|[一二三四五六七八九十]+)\s*[：:、.．)）\-]\s*/u;

/**
 * 卡片数据有时已自带“要点 1：”前缀，界面外层又会显示要点序号。
 * 展示层统一移除重复前缀，原始数据保持不变。
 */
export function normalizeKeyPointClaim(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  const normalized = trimmed.replace(KEY_POINT_PREFIX, "").trim();
  return normalized || trimmed;
}
