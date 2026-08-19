/**
 * 前端 WebCrypto 版 canonical hash（方案 20 §9.5）。
 *
 * 2026-08-16（实机验证修复）：clientReviewHash 必须与服务端
 * computeClientReviewHashV2 完全一致——服务端用 node:crypto 的
 * hashCanonicalV2（canonical JSON + SHA-256），浏览器不能直接 import
 * （node:crypto 惰性约定）。本文件用 WebCrypto 复刻同一算法：
 *   SHA-256("ailearn-hash-canonical-v2" \n "1" \n domain \n canonicalJson)
 * 与 packages/shared/src/hash-canonical-v2.ts 逐字节一致（NFC、LF、UTF-8
 * 字节序 key 排序、safe-int、set element hash 排序）。
 */

const HASH_CANONICAL_V2_DOMAIN = "ailearn-hash-canonical-v2";
const HASH_CANONICAL_V2_VERSION = 1;
const DOMAIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-._/]*$/;

import { sha256Hex } from "./sha256.ts";

/** UTF-8 字节序比较（object key 排序；对合法 Unicode 与 code point 序一致）。 */
function compareUtf8(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len) {
    const ca = a.codePointAt(i);
    const cb = b.codePointAt(i);
    if (ca !== cb) return ca! < cb! ? -1 : 1;
    i += ca! > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

/** 递归 canonicalize（与服务端 canonicalizeV2 一致）。 */
export function canonicalizeV2Web(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`hash canonicalization V2: non-safe-integer number ${value} is not serializable`);
    }
    return value === 0 ? 0 : value;
  }
  if (typeof value === "string") {
    return value.normalize("NFC").replace(/\r\n?/g, "\n");
  }
  if (Array.isArray(value)) {
    return value.map((v) => canonicalizeV2Web(v));
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("hash canonicalization V2: non-plain object is not serializable");
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(compareUtf8)) {
      const v = source[key];
      if (v === undefined) continue;
      out[key] = canonicalizeV2Web(v);
    }
    return out;
  }
  throw new Error(`hash canonicalization V2: unsupported value type ${typeof value}`);
}

/** 版本化 canonical hash（与服务端 hashCanonicalV2 一致）。 */
export async function hashCanonicalV2Web(domain: string, value: unknown): Promise<string> {
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new Error(`hash canonicalization V2: invalid domain separator ${JSON.stringify(domain)}`);
  }
  const canonicalJson = JSON.stringify(canonicalizeV2Web(value));
  const payload = [
    HASH_CANONICAL_V2_DOMAIN,
    String(HASH_CANONICAL_V2_VERSION),
    domain,
    canonicalJson,
  ].join("\n");
  return sha256Hex(payload);
}

/** set 元素稳定 hash 列表（与服务端 hashSetElementsV2 一致）。 */
export async function hashSetElementsV2Web(elements: unknown[]): Promise<string[]> {
  const hashes: string[] = [];
  for (const el of elements) {
    const canonical = canonicalizeV2Web(el);
    const json = JSON.stringify(canonical);
    hashes.push(await sha256Hex(json));
  }
  hashes.sort(compareUtf8);
  return hashes;
}

/** 去重 set element hash（ID 集合语义，与服务端 hashIdSetV2 一致）。 */
export async function hashIdSetV2Web(ids: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const unique = ids.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return hashSetElementsV2Web(unique);
}

/** 与服务端 computeClientReviewHashV2 完全一致。 */
export async function computeClientReviewHashV2Web(input: {
  runId: string;
  expectedReviewDraftRevision: number;
  selected: Array<{
    candidateId: string;
    revision: number;
    revisionHash: string;
  }>;
  reviewUiContractVersion: string;
}): Promise<string> {
  const selectedSet = await hashIdSetV2Web(
    input.selected.map((s) => `${s.candidateId}:${s.revision}:${s.revisionHash}`),
  );
  return hashCanonicalV2Web("card-generation-v2/client-review", {
    runId: input.runId,
    expectedReviewDraftRevision: input.expectedReviewDraftRevision,
    selectedSet,
    reviewUiContractVersion: input.reviewUiContractVersion,
  });
}
