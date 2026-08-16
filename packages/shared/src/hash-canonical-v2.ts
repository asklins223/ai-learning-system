import { createRequire } from "node:module";

/**
 * 方案 20（learning-card-v2）§9.5 Hash Canonicalization V2。
 *
 * 所有方案 20 的 hash 共用一个版本化 canonical serializer；不得由各模块直接
 * `JSON.stringify`。规则（§9.5 冻结）：
 *
 * - 算法 SHA-256，输入前加 domain separator 与 schema version；
 * - object key 按 UTF-8 字节序排序；array 默认保序，只有合同明确标注 set 的
 *   数组才按稳定 element hash 排序（见 hashSetElementsV2）；
 * - 字符串使用 Unicode NFC；换行统一 LF；不做同义改写或空白折叠；
 * - integer 十进制无前导零；禁止浮点序列化（遇非 safe integer 直接 throw）；
 * - `null`、字段缺失和空数组严格区分；unknown field 由各合同 zod `.strict()`
 *   在 parse 阶段 fail closed；
 * - ID 一律 canonical lowercase UUID/string form（由 zod `.uuid()` 保证）；
 *   时间为 UTC RFC3339 固定毫秒精度（由 zod `datetime({ offset: true })` 保证）；
 * - serializer 版本变化必须改变 domain separator，不能重算历史 hash。
 *
 * 只服务端调用（node:crypto 惰性获取，客户端 bundle 中 createRequire 为
 * undefined —— 与 content-hash.ts 同一约定）。
 */

const nodeRequire =
  typeof createRequire === "function" ? createRequire(import.meta.url) : null;

export const HASH_CANONICAL_V2_DOMAIN = "ailearn-hash-canonical-v2";
export const HASH_CANONICAL_V2_VERSION = 1;

/** hash domain 白名单：字母数字与 `-._/`，防止调用方拼接造成域混淆。 */
const DOMAIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-._/]*$/;

function sha256Hex(value: string): string {
  if (!nodeRequire) {
    throw new Error("node:crypto unavailable in this environment");
  }
  const { createHash } = nodeRequire("node:crypto");
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** UTF-8 字节序比较（object key 排序；对合法 Unicode 与 code point 序一致）。 */
function compareUtf8(a: string, b: string): number {
  // 对合法 Unicode，UTF-8 字节序 == code point 序。直接按 code point 比较，
  // 避免排序比较器每次分配两个 Buffer（hash 热路径上的常见开销）。
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

/**
 * 递归 canonicalize：返回一个只剩 null/boolean/integer/string/array/plain
 * object 的值。规则见文件头。任何浮点、非整数、undefined 或非 plain object
 * 都会 throw —— hash 输入必须先经 zod strict parse。
 */
export function canonicalizeV2(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `hash canonicalization V2: non-safe-integer number ${value} is not serializable`,
      );
    }
    return value === 0 ? 0 : value; // -0 规范为 0
  }
  if (typeof value === "string") {
    // NFC + 换行统一 LF；不 trim、不折叠空白。
    return value.normalize("NFC").replace(/\r\n?/g, "\n");
  }
  if (Array.isArray(value)) {
    return value.map((v) => canonicalizeV2(v));
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(
        "hash canonicalization V2: non-plain object is not serializable",
      );
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(compareUtf8)) {
      const v = source[key];
      if (v === undefined) {
        // 字段缺失与 null 严格区分：undefined 不入 canonical form。
        continue;
      }
      out[key] = canonicalizeV2(v);
    }
    return out;
  }
  throw new Error(
    `hash canonicalization V2: unsupported value type ${typeof value}`,
  );
}

/** canonical JSON 字符串：无额外空白、末尾无换行。 */
export function canonicalJsonV2(value: unknown): string {
  return JSON.stringify(canonicalizeV2(value));
}

/**
 * 版本化 canonical hash：
 * `SHA-256("ailearn-hash-canonical-v2" \n version \n domain \n canonicalJson)`
 */
export function hashCanonicalV2(domain: string, value: unknown): string {
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new Error(
      `hash canonicalization V2: invalid domain separator ${JSON.stringify(domain)}`,
    );
  }
  const payload = [
    HASH_CANONICAL_V2_DOMAIN,
    String(HASH_CANONICAL_V2_VERSION),
    domain,
    canonicalJsonV2(value),
  ].join("\n");
  return sha256Hex(payload);
}

/**
 * set 语义数组的规范化（§9.5：只有合同明确标注 set 的数组才按稳定 element
 * hash 排序）。调用方把 ID/hash 集合字段映射为排序后的 element hash 列表后
 * 再参与 canonical hash —— 顺序不敏感、重复元素幂等。
 */
export function hashSetElementsV2(elements: unknown[]): string[] {
  const hashes = elements.map((el) => {
    const canonical = canonicalizeV2(el);
    const json = JSON.stringify(canonical);
    return sha256Hex(json);
  });
  hashes.sort(compareUtf8);
  return hashes;
}

/** 去重后的 set element hash（ID 集合语义）。 */
export function hashIdSetV2(ids: string[]): string[] {
  const seen = new Set<string>();
  return hashSetElementsV2(
    ids.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  );
}
