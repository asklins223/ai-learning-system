import { and, eq, ne } from "drizzle-orm";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { logger } from "../lib/logger.ts";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import { SourceStatus } from "@ailearn/shared";
import { parseContent } from "../lib/markdown-parser.ts";
import {
  assertJobLease,
  isJobLeaseActive,
  lockJobLease,
  throwIfJobAborted,
  withJobTransaction,
} from "../lib/job-lease.ts";
import type { JobPayload } from "./index.ts";

// R-014: URL 抓取限制
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 500_000; // 500KB
const FETCH_MAX_REDIRECTS = 5;
const FETCH_ALLOWED_PROTOCOLS = ["http:", "https:"];

/**
 * An archived source is terminal for parse jobs. Every database write also
 * repeats this guard in SQL; keeping the predicate exported makes the state
 * rule explicit and independently testable.
 */
export function canAdvanceSourceParse(status: string): boolean {
  return status !== SourceStatus.ARCHIVED;
}

/**
 * Parse an IPv4 address into bytes. Invalid text is treated as non-public by
 * the caller rather than being allowed to reach the network.
 */
function parseIpv4Bytes(ip: string): [number, number, number, number] | null {
  const match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const bytes = match.slice(1).map(Number);
  if (bytes.some((byte) => byte < 0 || byte > 255)) return null;
  return bytes as [number, number, number, number];
}

function parseIpv6Hextets(ip: string): number[] | null {
  let value = ip.split("%")[0];
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon < 0) return null;
    const bytes = parseIpv4Bytes(value.slice(lastColon + 1));
    if (!bytes) return null;
    const high = (bytes[0] << 8) | bytes[1];
    const low = (bytes[2] << 8) | bytes[3];
    value = `${value.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string) => half
    ? half.split(":").map((part) => /^[0-9a-f]{1,4}$/i.test(part) ? Number.parseInt(part, 16) : -1)
    : [];
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  if ([...left, ...right].some((part) => part < 0)) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

/**
 * G-007: SSRF 防护 — IP 级别非公网地址检测。
 * 检查 IPv4 和 IPv6 地址是否属于私有、保留、环回、链路本地等范围。
 */
function isPrivateIpAddress(ip: string): boolean {
  const normalizedIp = ip.toLowerCase().replace(/^\[|\]$/g, "");

  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const mappedMatch = normalizedIp.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedMatch) {
    return isPrivateIpAddress(mappedMatch[1]);
  }

  // IPv4
  const ipv4 = parseIpv4Bytes(normalizedIp);
  if (ipv4) {
    const [a, b, c] = ipv4;
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 127) return true;                         // 127.0.0.0/8 (loopback)
    if (a === 0) return true;                           // 0.0.0.0/8
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16 (link-local)
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (CGNAT)
    if (a === 192 && b === 0 && c === 0) return true;   // IETF protocol assignments
    if (a === 192 && b === 0 && c === 2) return true;   // TEST-NET-1
    if (a === 192 && b === 88 && c === 99) return true; // deprecated 6to4 relay anycast
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmark network
    if (a === 198 && b === 51 && c === 100) return true;  // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true;   // TEST-NET-3
    if (a >= 224) return true;                           // multicast / reserved
    return false;
  }

  // IPv6
  const hextets = parseIpv6Hextets(normalizedIp);
  if (!hextets) return true;
  const first = hextets[0];
  if (hextets.slice(0, 7).every((part) => part === 0) && hextets[7] <= 1) return true; // :: / ::1
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8

  // IPv4-mapped and deprecated IPv4-compatible forms written with hexadecimal
  // hextets (URL parsing canonicalizes ::ffff:127.0.0.1 to ::ffff:7f00:1).
  const leadingZeroes = hextets.slice(0, 5).every((part) => part === 0);
  if (leadingZeroes && (hextets[5] === 0 || hextets[5] === 0xffff)) {
    const embedded = [
      hextets[6] >> 8,
      hextets[6] & 0xff,
      hextets[7] >> 8,
      hextets[7] & 0xff,
    ].join(".");
    return isPrivateIpAddress(embedded);
  }

  // Only globally routed unicast space (2000::/3) is eligible. This rejects
  // discard-only, NAT64/local translation and currently reserved ranges by
  // default instead of assuming every syntactically valid IPv6 is public.
  if ((first & 0xe000) !== 0x2000) return true;

  const second = hextets[1];
  const third = hextets[2];
  if (first === 0x2001 && second === 0x0000) return true; // Teredo 2001::/32
  if (first === 0x2001 && second === 0x0002 && third === 0) return true; // benchmarking /48
  if (first === 0x2001 && second === 0x0003) return true; // AMT /32
  if (first === 0x2001 && second === 0x0004 && third === 0x0112) return true; // AS112 /48
  if (first === 0x2001 && (second & 0xfff0) === 0x0010) return true; // ORCHID /28
  if (first === 0x2001 && (second & 0xfff0) === 0x0020) return true; // ORCHIDv2 /28
  if (first === 0x2001 && second === 0x0db8) return true; // documentation /32
  if (first === 0x2002) return true; // 6to4 can encode private IPv4 targets
  if (first === 0x3fff && (second & 0xf000) === 0) return true; // documentation /20
  return false;
}

/**
 * G-007: SSRF 防护 — 通过 DNS 解析检查 hostname 是否指向私有/内网地址。
 * 替代旧的字符串黑名单，防止 localhost.、[::1]、Docker 服务名等绕过。
 */
export type PinnedAddress = { address: string; family: 4 | 6 };
export type AddressResolver = (hostname: string) => Promise<PinnedAddress>;
type PinnedResponse = {
  status: number;
  statusText: string;
  location?: string;
  contentType: string;
  body: Buffer;
};
export type PinnedRequester = (
  parsed: URL,
  pinned: PinnedAddress,
  signal: AbortSignal,
) => Promise<PinnedResponse>;
export type FetchUrlDependencies = {
  resolveAddress?: AddressResolver;
  request?: PinnedRequester;
};

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("URL fetch aborted", { cause: signal.reason });
}

/** Race an otherwise non-cancellable operation (notably DNS lookup) with a signal. */
async function awaitWithAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  const task = operation();

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    task.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/**
 * Resolve once, reject the whole answer set if any address is non-public, and
 * return the exact address that the HTTP client must use. The request must not
 * perform another system DNS lookup after this function returns.
 */
async function resolvePublicAddress(hostname: string): Promise<PinnedAddress> {
  const cleanHostname = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();

  // 常见私有 hostname 模式
  if (cleanHostname === "localhost" || cleanHostname.endsWith(".local") || cleanHostname.endsWith(".internal")) {
    throw new Error(`blocked: private/internal host (${hostname})`);
  }

  // 如果已经是 IP 地址，直接检查
  const literalFamily = isIP(cleanHostname);
  if (literalFamily === 4 || literalFamily === 6) {
    if (isPrivateIpAddress(cleanHostname)) {
      throw new Error(`blocked: private/internal host (${hostname})`);
    }
    return { address: cleanHostname, family: literalFamily };
  }

  // G-007: DNS 解析 hostname，检查所有 A/AAAA 记录。
  // Any private answer rejects the hostname; selecting only the public subset
  // would still let an attacker influence which destination is reached.
  try {
    const addresses = await dnsLookup(cleanHostname, { all: true, verbatim: true });
    if (addresses.length === 0) {
      throw new Error(`blocked: hostname has no address (${hostname})`);
    }
    for (const addr of addresses) {
      if (isPrivateIpAddress(addr.address)) {
        throw new Error(`blocked: private/internal host (${hostname})`);
      }
    }
    const selected = addresses[0];
    if (selected.family !== 4 && selected.family !== 6) {
      throw new Error(`blocked: unsupported address family (${selected.family})`);
    }
    return { address: selected.address, family: selected.family };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("blocked:")) throw err;
    throw new Error(`blocked: DNS resolution failed (${hostname})`, { cause: err });
  }
}

function getHeader(response: IncomingMessage, name: string): string | undefined {
  const value = response.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function createPinnedLookup(pinned: PinnedAddress): LookupFunction {
  return (_hostname, _options, callback) => {
    callback(null, pinned.address, pinned.family);
  };
}

/**
 * Issue one GET request to a previously validated address. The URL hostname is
 * retained for the Host header and HTTPS SNI/certificate validation, while the
 * custom lookup callback always returns the pinned IP. This closes the DNS
 * validation/connect TOCTOU window.
 */
async function requestPinnedUrl(
  parsed: URL,
  pinned: PinnedAddress,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  const options: RequestOptions = {
    method: "GET",
    family: pinned.family,
    lookup: createPinnedLookup(pinned),
    signal,
    headers: {
      "User-Agent": "AILearnBot/0.3 (+https://github.com/ailearn)",
      Accept: "text/html,text/plain,application/json,*/*",
      // Avoid accepting a compressed response whose expanded body can bypass
      // the byte limit. Servers that ignore this header are rejected below.
      "Accept-Encoding": "identity",
    },
  };
  if (parsed.protocol === "https:" && !isIP(parsed.hostname)) {
    // RequestOptions is shared by http/https at runtime. Keep the original DNS
    // name for TLS SNI and certificate hostname verification.
    (options as RequestOptions & { servername: string }).servername = parsed.hostname;
  }

  return new Promise((resolve, reject) => {
    const onResponse = (response: IncomingMessage) => {
      // Install this before any early return (including redirects) so a socket
      // error while draining the response is never emitted without a listener.
      response.once("error", reject);
      const status = response.statusCode ?? 0;
      const statusText = response.statusMessage ?? "";
      const location = getHeader(response, "location");

      if (status >= 300 && status < 400 && location) {
        response.resume();
        resolve({ status, statusText, location, contentType: "", body: Buffer.alloc(0) });
        return;
      }

      const rawLength = getHeader(response, "content-length");
      const contentLength = rawLength === undefined ? 0 : Number(rawLength);
      if (Number.isFinite(contentLength) && contentLength > FETCH_MAX_BYTES) {
        response.destroy();
        reject(new Error(`content too large: ${contentLength} bytes (max ${FETCH_MAX_BYTES})`));
        return;
      }

      const contentEncoding = (getHeader(response, "content-encoding") ?? "identity").toLowerCase();
      if (contentEncoding !== "identity") {
        response.destroy();
        reject(new Error(`unsupported content encoding: ${contentEncoding}`));
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > FETCH_MAX_BYTES) {
          response.destroy(new Error(`content exceeded max size (${FETCH_MAX_BYTES} bytes)`));
          return;
        }
        chunks.push(buffer);
      });
      response.once("end", () => {
        resolve({
          status,
          statusText,
          contentType: getHeader(response, "content-type") ?? "",
          body: Buffer.concat(chunks),
        });
      });
    };

    const request = parsed.protocol === "https:"
      ? httpsRequest(parsed, options, onResponse)
      : httpRequest(parsed, options, onResponse);
    request.once("error", reject);
    request.end();
  });
}

/**
 * R-014: 从 HTML 中提取纯文本（简易版）。
 * 去除 script/style 标签及其内容，去除其他 HTML 标签，保留文本和换行。
 */
function extractTextFromHtml(html: string): string {
  return html
    // 移除 script 和 style 标签及其内容
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    // 块级标签转换为换行
    .replace(/<\/?(p|div|br|h[1-6]|li|ul|ol|blockquote|pre|tr|table)[^>]*>/gi, "\n")
    // 移除所有其他 HTML 标签
    .replace(/<[^>]+>/g, "")
    // 解码常见 HTML 实体
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // 压缩空白
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * R-014: 受控 HTTP 抓取 — 含 SSRF 防护、超时、大小限制和重定向控制。
 */
export async function fetchUrlContent(
  url: string,
  signal?: AbortSignal,
  dependencies: FetchUrlDependencies = {},
): Promise<string> {
  const resolveAddress = dependencies.resolveAddress ?? resolvePublicAddress;
  const request = dependencies.request ?? requestPinnedUrl;
  let currentUrl = url;
  let redirectCount = 0;

  while (true) {
    const parsed = new URL(currentUrl);
    if (!FETCH_ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      throw new Error(`unsupported protocol: ${parsed.protocol}`);
    }
    if (parsed.username || parsed.password) {
      throw new Error("URL credentials are not allowed");
    }

    const ac = new AbortController();
    const timeout = setTimeout(
      () => ac.abort(new Error(`URL fetch timed out after ${FETCH_TIMEOUT_MS}ms`)),
      FETCH_TIMEOUT_MS,
    );
    const abortFromParent = () => ac.abort(signal?.reason);
    if (signal?.aborted) abortFromParent();
    else signal?.addEventListener("abort", abortFromParent, { once: true });

    try {
      // Resolve and validate immediately before this hop, then force the
      // socket to use that exact address. DNS is not natively cancellable, so
      // race it with the same per-hop deadline used by the request.
      const pinned = await awaitWithAbort(() => resolveAddress(parsed.hostname), ac.signal);
      const res = await awaitWithAbort(() => request(parsed, pinned, ac.signal), ac.signal);

      if (res.status >= 300 && res.status < 400 && res.location) {
        if (redirectCount >= FETCH_MAX_REDIRECTS) {
          throw new Error(`too many redirects (max ${FETCH_MAX_REDIRECTS})`);
        }
        const location = res.location;
        const redirectUrl = new URL(location, currentUrl).href;
        const redirectParsed = new URL(redirectUrl);
        if (!FETCH_ALLOWED_PROTOCOLS.includes(redirectParsed.protocol)) {
          throw new Error(`redirect to unsupported protocol: ${redirectParsed.protocol}`);
        }
        redirectCount++;
        currentUrl = redirectUrl;
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const decoder = new TextDecoder("utf-8", { fatal: false });
      const rawText = decoder.decode(res.body);

      if (res.contentType.toLowerCase().includes("text/html")) {
        return extractTextFromHtml(rawText);
      }
      return rawText;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromParent);
    }
  }
}

/**
 * parse_source job handler。
 * 纯规则分段（V0.3 不调模型）：
 * - text：按双换行分段
 * - markdown：按标题和段落分段，保留代码块完整性
 * - code：整段作为一个 segment
 * - url：R-014 已实现 HTTP 抓取，会获取 URL 正文并分段
 */
export async function runParseSource(job: JobPayload) {
  const sourceId = job.payload.sourceId as string | undefined;
  if (!sourceId) throw new Error("missing sourceId in payload");
  await assertJobLease(job);
  logger.info({ sourceId }, "running parse_source");

  const source = await db.query.sources.findFirst({
    where: and(
      eq(schema.sources.id, sourceId),
      eq(schema.sources.workspaceId, job.workspaceId),
    ),
  });
  if (!source) throw new Error(`source ${sourceId} not found in workspace`);

  // R-014: 检查 source 是否已归档，避免旧 job 把归档来源改回 ready。
  // The conditional UPDATE below repeats this check atomically, because an
  // archive may commit after this initial read.
  if (!canAdvanceSourceParse(source.status)) {
    logger.info({ sourceId }, "source is archived, skipping parse");
    return;
  }

  // Every state transition is workspace-scoped and refuses to move an
  // archived row. RETURNING also refreshes the source snapshot after any lock
  // wait, so later parsing does not rely on the initial TOCTOU-prone read.
  const [processingSource] = await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, job);
    const rows = await tx
      .update(schema.sources)
      .set({ status: SourceStatus.PROCESSING, updatedAt: new Date() })
      .where(
        and(
          eq(schema.sources.id, sourceId),
          eq(schema.sources.workspaceId, job.workspaceId),
          ne(schema.sources.status, SourceStatus.ARCHIVED),
        ),
      )
      .returning();
    throwIfJobAborted(job);
    return rows;
  });
  if (!processingSource) {
    logger.info({ sourceId }, "source was archived before processing started, skipping parse");
    return;
  }

  let failureProjection: { body: string; metadata: Record<string, unknown> } | null = null;

  try {
    const metadata = (processingSource.metadata ?? {}) as Record<string, unknown>;
    if (metadata.rawContent != null && typeof metadata.rawContent !== "string") {
      throw new Error("source metadata.rawContent must be a string");
    }
    if (metadata.url != null && typeof metadata.url !== "string") {
      throw new Error("source metadata.url must be a string");
    }
    let rawContent = metadata.rawContent ?? "";
    const fetchUrlContentFlag = job.payload.fetchUrlContent === true;
    const url = metadata.url ?? processingSource.origin ?? "";

    // R-014: 如果标记了 fetchUrlContent，执行 HTTP 抓取
    if (fetchUrlContentFlag && url && !rawContent.trim()) {
      logger.info({ sourceId, url }, "fetching URL content");
      try {
        const fetchedContent = await fetchUrlContent(url, job.signal);
        rawContent = fetchedContent;

        // Merge fetched content while holding the source row lock. If archive
        // won the race, do not restore metadata or continue toward ready.
        const metadataStored = await withJobTransaction(job, async (tx) => {
          await lockJobLease(tx, job);
          const [lockedSource] = await tx
            .select()
            .from(schema.sources)
            .where(
              and(
                eq(schema.sources.id, sourceId),
                eq(schema.sources.workspaceId, job.workspaceId),
              ),
            )
            .for("update");
          if (!lockedSource || !canAdvanceSourceParse(lockedSource.status)) return false;

          const [updated] = await tx
            .update(schema.sources)
            .set({
              metadata: {
                ...((lockedSource.metadata ?? {}) as Record<string, unknown>),
                rawContent: fetchedContent,
                fetchedAt: new Date().toISOString(),
              },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.sources.id, sourceId),
                eq(schema.sources.workspaceId, job.workspaceId),
                ne(schema.sources.status, SourceStatus.ARCHIVED),
              ),
            )
            .returning({ id: schema.sources.id });
          throwIfJobAborted(job);
          return Boolean(updated);
        });

        if (!metadataStored) {
          logger.info({ sourceId }, "source was archived during URL fetch, skipping parse");
          return;
        }

        logger.info({ sourceId, contentLength: fetchedContent.length }, "URL content fetched");
      } catch (fetchErr) {
        logger.error({ sourceId, url, err: fetchErr }, "URL fetch failed");
        const fetchError = fetchErr instanceof Error ? fetchErr.message : "unknown";
        failureProjection = {
          body: url,
          metadata: { type: processingSource.type, fetchError },
        };
        throw new Error(
          `URL fetch failed: ${fetchErr instanceof Error ? fetchErr.message : "unknown error"}`,
          { cause: fetchErr },
        );
      }
    }

    // 如果仍然没有内容，设为 ready 但标记需要后续处理
    if (!rawContent.trim()) {
      // Ready and its search projection share the same row lock/transaction.
      // Whichever operation wins against archive determines the final state:
      // worker first => archive subsequently deletes the projection; archive
      // first => this transaction observes archived and writes nothing.
      const committed = await withJobTransaction(job, async (tx) => {
        await lockJobLease(tx, job);
        const [lockedSource] = await tx
          .select()
          .from(schema.sources)
          .where(
            and(
              eq(schema.sources.id, sourceId),
              eq(schema.sources.workspaceId, job.workspaceId),
            ),
          )
          .for("update");
        if (!lockedSource || !canAdvanceSourceParse(lockedSource.status)) return false;

        const [updated] = await tx
          .update(schema.sources)
          .set({ status: SourceStatus.READY, updatedAt: new Date() })
          .where(
            and(
              eq(schema.sources.id, sourceId),
              eq(schema.sources.workspaceId, job.workspaceId),
              ne(schema.sources.status, SourceStatus.ARCHIVED),
            ),
          )
          .returning({ id: schema.sources.id });
        if (!updated) return false;

        const lockedMetadata = (lockedSource.metadata ?? {}) as Record<string, unknown>;
        const projectionBody = [lockedSource.origin, lockedMetadata.url]
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .join("\n");
        const indexedAt = new Date();
        await tx
          .insert(schema.searchDocuments)
          .values({
            workspaceId: job.workspaceId,
            objectType: "source",
            objectId: sourceId,
            title: lockedSource.title,
            body: projectionBody,
            metadata: { type: lockedSource.type, needsContentFetch: true },
            indexedAt,
          })
          .onConflictDoUpdate({
            target: [
              schema.searchDocuments.workspaceId,
              schema.searchDocuments.objectType,
              schema.searchDocuments.objectId,
            ],
            set: {
              title: lockedSource.title,
              body: projectionBody,
              metadata: { type: lockedSource.type, needsContentFetch: true },
              indexedAt,
            },
          });
        throwIfJobAborted(job);
        return true;
      });

      if (!committed) {
        logger.info({ sourceId }, "source was archived before ready commit, skipping projection");
        return;
      }
      logger.info({ sourceId }, "source ready (no content to parse)");
      return;
    }

    // 解析内容
    const segments = parseContent(
      rawContent,
      processingSource.type as "text" | "markdown" | "code" | "url",
    );

    const sourceBody = segments.map((s) => s.text).join("\n");
    // Recheck the terminal archived state under a row lock, then replace
    // segments, set ready, and write the projection atomically. This prevents
    // a parse job that started earlier from resurrecting an archived source.
    const committed = await withJobTransaction(job, async (tx) => {
      await lockJobLease(tx, job);
      const [lockedSource] = await tx
        .select()
        .from(schema.sources)
        .where(
          and(
            eq(schema.sources.id, sourceId),
            eq(schema.sources.workspaceId, job.workspaceId),
          ),
        )
        .for("update");
      if (!lockedSource || !canAdvanceSourceParse(lockedSource.status)) return false;

      await tx
        .delete(schema.sourceSegments)
        .where(
          and(
            eq(schema.sourceSegments.sourceId, sourceId),
            eq(schema.sourceSegments.workspaceId, job.workspaceId),
          ),
        );

      if (segments.length > 0) {
        await tx.insert(schema.sourceSegments).values(
          segments.map((seg, idx) => ({
            sourceId,
            workspaceId: job.workspaceId,
            ordinal: idx,
            text: seg.text,
            charStart: seg.charStart,
            charEnd: seg.charEnd,
            segmentType: seg.segmentType,
          })),
        );
      }

      const [updated] = await tx
        .update(schema.sources)
        .set({ status: SourceStatus.READY, updatedAt: new Date() })
        .where(
          and(
            eq(schema.sources.id, sourceId),
            eq(schema.sources.workspaceId, job.workspaceId),
            ne(schema.sources.status, SourceStatus.ARCHIVED),
          ),
        )
        .returning({ id: schema.sources.id });
      if (!updated) return false;

      const indexedAt = new Date();
      await tx
        .insert(schema.searchDocuments)
        .values({
          workspaceId: job.workspaceId,
          objectType: "source",
          objectId: sourceId,
          title: lockedSource.title,
          body: sourceBody,
          metadata: { type: lockedSource.type },
          indexedAt,
        })
        .onConflictDoUpdate({
          target: [
            schema.searchDocuments.workspaceId,
            schema.searchDocuments.objectType,
            schema.searchDocuments.objectId,
          ],
          set: {
            title: lockedSource.title,
            body: sourceBody,
            metadata: { type: lockedSource.type },
            indexedAt,
          },
        });
      throwIfJobAborted(job);
      return true;
    });

    if (!committed) {
      logger.info({ sourceId }, "source was archived before segment commit, skipping parse result");
      return;
    }

    logger.info(
      { sourceId, segmentCount: segments.length },
      "source parsed successfully",
    );
  } catch (err) {
    // A timed-out/aborted handler must never project a failure from an old
    // attempt after the worker has released its lease for retry.
    if (!await isJobLeaseActive(job)) {
      logger.warn({ sourceId, err }, "skipping parse failure projection after lease loss");
      throw err;
    }
    // Failed and its optional fetch-error projection use the same source row
    // lock. If archive won the race, both writes are skipped and the archived
    // source remains absent from search.
    const committed = await withJobTransaction(job, async (tx) => {
      await lockJobLease(tx, job);
      const [lockedSource] = await tx
        .select()
        .from(schema.sources)
        .where(
          and(
            eq(schema.sources.id, sourceId),
            eq(schema.sources.workspaceId, job.workspaceId),
          ),
        )
        .for("update");
      if (!lockedSource || !canAdvanceSourceParse(lockedSource.status)) return false;

      const [updated] = await tx
        .update(schema.sources)
        .set({ status: SourceStatus.FAILED, updatedAt: new Date() })
        .where(
          and(
            eq(schema.sources.id, sourceId),
            eq(schema.sources.workspaceId, job.workspaceId),
            ne(schema.sources.status, SourceStatus.ARCHIVED),
          ),
        )
        .returning({ id: schema.sources.id });
      if (!updated) return false;

      if (failureProjection) {
        const indexedAt = new Date();
        await tx
          .insert(schema.searchDocuments)
          .values({
            workspaceId: job.workspaceId,
            objectType: "source",
            objectId: sourceId,
            title: lockedSource.title,
            body: failureProjection.body,
            metadata: failureProjection.metadata,
            indexedAt,
          })
          .onConflictDoUpdate({
            target: [
              schema.searchDocuments.workspaceId,
              schema.searchDocuments.objectType,
              schema.searchDocuments.objectId,
            ],
            set: {
              title: lockedSource.title,
              body: failureProjection.body,
              metadata: failureProjection.metadata,
              indexedAt,
            },
        });
      }
      throwIfJobAborted(job);
      return true;
    });

    if (!committed) {
      logger.info({ sourceId }, "source was archived during parse failure, preserving archived state");
      return;
    }
    throw err;
  }
}
