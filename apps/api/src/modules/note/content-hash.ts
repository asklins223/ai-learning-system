import { createHash } from "node:crypto";

/**
 * 正文的规范哈希。整段从 `service.ts` 搬出来放在这里，是因为现在需要它的有两侧：
 * 建版本的接口要按它去重，而**文档落盘口**要跟着刷新当前版本的 `content_hash`
 * （正文改完之后那个哈希不能还停在旧内容上）。留在 service.ts 里就让落盘口反过来
 * import 上层，成环。
/**
 * Compute a stable MD5 hash of note content blocks for deduplication.
 *
 * The serialization format matches PostgreSQL's `jsonb::text` output exactly:
 *   - Object keys are sorted by length, then alphabetically (JSONB internal order)
 *   - Separators are `": "` and `", "` (with spaces, matching `jsonb::text`)
 *
 * This ensures the hash is consistent with the migration 0029 backfill
 * `md5(content_json::text)`, so deduplication works across pre-migration
 * and post-migration data.
 *
 * The integration test `content-hash-consistency-postgres.integration.ts`
 * validates this alignment across ASCII, Unicode, image, and empty-block
 * content. If this function or the migration is modified, update both
 * the migration and the integration test accordingly, and consider whether
 * existing data needs re-hashing.
 */
export function computeContentHash(contentJson: unknown): string {
  const canonical = pgJsonbSerialize(contentJson);
  return createHash("md5").update(canonical).digest("hex");
}

/**
 * Serialize a JavaScript value to text in PostgreSQL `jsonb::text` format.
 *
 * Key ordering: by length ascending, then by byte-wise comparison (matching
 * PostgreSQL's JSONB internal key ordering).  Separators: `": "` after keys,
 * `", "` between elements.  String values are JSON-encoded with `JSON.stringify`
 * to ensure correct escaping of special characters.
 */
function pgJsonbSerialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    // BUG-01 fix: PostgreSQL jsonb::text never uses exponential notation.
    // JavaScript's String() uses exponential notation for |value| >= 1e21
    // or |value| < 1e-6, which would cause md5(content_json::text) to
    // differ from computeContentHash. Convert exponential to fixed-point.
    // BUG-04 修复：toFixed(20) 对极大/极小数字仍会丢失精度。
    // 对于指数格式，使用 BigInt 精确转换（当数字为整数时），
    // 否则使用 toPrecision 并去除尾部零。非指数格式直接使用 String()。
    const str = String(value);
    // PERF: Fast path — the overwhelming majority of JSON numbers (integers and
    // in-range decimals) have no exponent, so avoid the regex engine on the
    // content-hash hot path. Only fall into the expensive BigInt/toPrecision
    // path for exponential edge cases (|value| >= 1e21 or < 1e-6).
    if (str.indexOf("e") === -1 && str.indexOf("E") === -1) {
      return str;
    }
    if (Number.isInteger(value)) {
      // 整数使用 BigInt 精确表示
      try {
        return BigInt(value).toString();
      } catch {
        // 超出 BigInt 安全范围时回退到 toFixed
        const fixed = value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
        return fixed || "0";
      }
    }
    const fixed = value.toPrecision(21).replace(/0+$/, "").replace(/\.$/, "");
    return fixed || "0";
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    // BUG-12: Each element is recursively serialized, so NaN/Infinity
    // inside arrays becomes "null" — matching PostgreSQL's jsonb behaviour
    // where NaN is never stored (it is silently converted to null on
    // input). This ensures md5(content_json::text) stays consistent.
    return "[" + value.map(pgJsonbSerialize).join(", ") + "]";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => {
        if (a.length !== b.length) return a.length - b.length;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    if (entries.length === 0) return "{}";
    return "{" + entries
      .map(([k, v]) => JSON.stringify(k) + ": " + pgJsonbSerialize(v))
      .join(", ") + "}";
  }
  return JSON.stringify(value);
}

/**
 * Strip image blocks that are still uploading placeholders.
 *
 * The NoteEditor inserts `![上传中…](uploading:${uuid})` as a temporary
 * placeholder while an image upload is in flight. If autosave triggers
 * before the upload completes (2.5 s interval), the placeholder would
 * be persisted as a broken image block. This function filters such
 * blocks out so they never reach the database.
 *
 * Ordinals are re-assigned by the caller after this filter, so gaps
 * are not a concern.
 */
