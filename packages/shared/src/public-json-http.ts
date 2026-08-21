import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;
// 2026-08-12（模型调用面审计）：生产路径此前只有 10s connect 超时，响应体
// 读取无任何上限——provider 半挂时请求无限挂起（http-pool 的 300s 只作用于
// undici dispatcher 路径，node:https 直连不经它）。总超时 = connect + 响应
// 体读取，默认 300s（长生成场景），可 AI_ENDPOINT_RESPONSE_TIMEOUT_MS 覆盖。
const TOTAL_RESPONSE_TIMEOUT_MS = envTimeoutMs("AI_ENDPOINT_RESPONSE_TIMEOUT_MS", 300_000);

function envTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1_000 ? value : fallback;
}

type PinnedAddress = { address: string; family: 4 | 6 };

function allowsDockerDesktopSyntheticDns(): boolean {
  return process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS?.trim().toLowerCase() === "true";
}

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const bytes = parts.map(Number);
  return bytes.some((byte) => byte < 0 || byte > 255)
    ? null
    : bytes as [number, number, number, number];
}

function parseIpv6(ip: string): number[] | null {
  let value = ip.split("%")[0];
  if (value.includes(".")) {
    const split = value.lastIndexOf(":");
    const bytes = split >= 0 ? parseIpv4(value.slice(split + 1)) : null;
    if (!bytes) return null;
    value = `${value.slice(0, split)}:${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
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
  return missing >= 1 ? [...left, ...Array<number>(missing).fill(0), ...right] : null;
}

export function isNonPublicAIEndpointAddress(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isNonPublicAIEndpointAddress(mapped[1]);

  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19) && !allowsDockerDesktopSyntheticDns()) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113);
  }

  const ipv6 = parseIpv6(normalized);
  if (!ipv6) return true;
  const first = ipv6[0];
  // Loopback (::1)
  if (ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] <= 1) return true;
  // Link-local (fe80::/10), Unique Local Address (fc00::/7), Multicast (ff00::/8)
  // When AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS is true, also allow Clash/VPN
  // fake-IP IPv6 addresses (fdfe:dcba:9876::/64 pattern used by Clash).
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if ((first & 0xfe00) === 0xfc00) {
    // ULA range (fc00::/7). Clash fake-IP uses fdfe:dcba:9876::/64.
    // When Docker Desktop synthetic DNS is allowed, skip ULA addresses
    // instead of rejecting the entire hostname.
    if (allowsDockerDesktopSyntheticDns()) return false;
    return true;
  }
  // Only globally routed unicast space (2000::/3) is eligible.
  if ((first & 0xe000) !== 0x2000) return true;
  const second = ipv6[1];
  const third = ipv6[2];
  return (first === 0x2001 && (
    second === 0 || (second === 2 && third === 0) || second === 3 ||
    (second === 4 && third === 0x0112) || (second & 0xfff0) === 0x0010 ||
    (second & 0xfff0) === 0x0020 || second === 0x0db8
  )) || first === 0x2002 || (first === 0x3fff && (second & 0xf000) === 0);
}

async function resolvePublicAddress(hostname: string): Promise<PinnedAddress> {
  const clean = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!clean || clean === "localhost" || clean.endsWith(".local") || clean.endsWith(".internal")) {
    throw new Error("AI endpoint is not a public hostname");
  }
  const family = isIP(clean);
  if (family === 4 || family === 6) {
    if (isNonPublicAIEndpointAddress(clean)) throw new Error("AI endpoint resolved to a non-public address");
    return { address: clean, family };
  }
  // G-007: DNS 解析 hostname，检查 A/AAAA 记录。
  // 策略（与 parse-source.ts U5 修复一致）：过滤掉私有/内网地址，
  // 只从公网地址中选择。如果全部地址都是私有/内网，仍然拒绝。
  // CDN 域名 DNS 可能返回混合公网/内网地址（如负载均衡器内部地址），
  // 旧策略"任何一个私有就拒绝整个 hostname"会误杀合法 CDN 域名。
  const addresses = await dnsLookup(clean, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("AI endpoint hostname has no address");

  const publicAddresses = addresses.filter(
    (entry) => !isNonPublicAIEndpointAddress(entry.address),
  );

  if (publicAddresses.length === 0) {
    const blockedIps = addresses.map((a) => a.address).join(", ");
    throw new Error(
      `AI endpoint resolved to a non-public address — all resolved addresses are private: ${blockedIps}`,
    );
  }

  const selected = publicAddresses[0];
  if (selected.family !== 4 && selected.family !== 6) {
    throw new Error("AI endpoint has an unsupported address family");
  }
  return { address: selected.address, family: selected.family };
}

/**
 * Validate a custom AI endpoint URL without sending a request:
 * HTTPS-only, no inline credentials, and the hostname must resolve to a
 * public address. Used by transports (e.g. the DashScope fetch client) that
 * do not route through postJsonToPublicEndpoint's pinned request path.
 */
export async function assertPublicHttpsAIEndpoint(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("AI endpoints must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("AI endpoint URL credentials are not allowed");
  await resolvePublicAddress(parsed.hostname);
}

function pinnedLookup(pinned: PinnedAddress): LookupFunction {
  return (_hostname, _options, callback) => callback(null, pinned.address, pinned.family);
}

export interface PublicJsonResponse {
  status: number;
  statusText: string;
  body: unknown;
}

export type PublicJsonRequester = (
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
) => Promise<PublicJsonResponse>;

export interface PublicStreamingResponse {
  status: number;
  statusText: string;
  body: AsyncIterable<Uint8Array>;
  /** Stop reading and close the underlying socket. */
  cancel: () => void;
}

export type PublicStreamingRequester = (
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
) => Promise<PublicStreamingResponse>;

/** HTTPS-only JSON POST with DNS validation and connection-time IP pinning. */
export const postJsonToPublicEndpoint: PublicJsonRequester = async (
  url,
  headers,
  body,
  signal,
) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("AI endpoints must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("AI endpoint URL credentials are not allowed");
  const pinned = await resolvePublicAddress(parsed.hostname);
  const encodedBody = Buffer.from(JSON.stringify(body));
  const options: RequestOptions = {
    method: "POST",
    family: pinned.family,
    lookup: pinnedLookup(pinned),
    signal,
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "Content-Length": String(encodedBody.length),
      "Accept-Encoding": "identity",
    },
  };
  if (!isIP(parsed.hostname)) {
    (options as RequestOptions & { servername: string }).servername = parsed.hostname;
  }

  return new Promise((resolve, reject) => {
    const request = httpsRequest(parsed, options, (response) => {
      response.once("error", (error) => {
        clearTimeout(totalTimer);
        reject(error);
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new Error(`AI endpoint response exceeded ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        chunks.push(buffer);
      });
      response.once("end", () => {
        clearTimeout(totalTimer);
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsedBody: unknown = null;
        try {
          parsedBody = raw ? JSON.parse(raw) : null;
        } catch (error) {
          reject(new Error(`AI endpoint returned invalid JSON (${response.statusCode ?? 0})`, { cause: error }));
          return;
        }
        resolve({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? "",
          body: parsedBody,
        });
      });
    });
    // A hung TCP/TLS connect (blocked container egress, required proxy, or a
    // fake-IP VPN resolver handing out 198.18.x.x) would otherwise silently
    // burn the caller's entire provider budget and read as a model timeout.
    // Fail fast with a pointed, distinguishable error instead.
    const connectTimer = setTimeout(() => {
      request.destroy(new Error(
        `AI endpoint TCP/TLS connection could not be established within ${CONNECT_TIMEOUT_MS}ms — check container network egress/proxy, or a fake-IP VPN DNS resolver (198.18.x.x)`,
      ));
    }, CONNECT_TIMEOUT_MS);
    // 2026-08-12：整体响应超时（connect + 响应体读取）——provider 半挂时
    // 不再无限挂起；触发后 destroy 走 request error 路径清理两个 timer。
    const totalTimer = setTimeout(() => {
      request.destroy(new Error(
        `AI endpoint request exceeded total timeout ${TOTAL_RESPONSE_TIMEOUT_MS}ms (connect + response body)`,
      ));
    }, TOTAL_RESPONSE_TIMEOUT_MS);
    request.on("socket", (socket) => {
      if (!socket.connecting) {
        clearTimeout(connectTimer);
        return;
      }
      socket.once("secureConnect", () => clearTimeout(connectTimer));
    });
    request.once("response", () => clearTimeout(connectTimer));
    request.once("error", (error) => {
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      reject(error);
    });
    request.end(encodedBody);
  });
};

/** HTTPS-only streaming POST with the same DNS validation and connection-time IP pinning. */
export const postSseToPublicEndpoint: PublicStreamingRequester = async (
  url,
  headers,
  body,
  signal,
) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("AI endpoints must use HTTPS");
  if (parsed.username || parsed.password) throw new Error("AI endpoint URL credentials are not allowed");
  const pinned = await resolvePublicAddress(parsed.hostname);
  const encodedBody = Buffer.from(JSON.stringify(body));
  const options: RequestOptions = {
    method: "POST",
    family: pinned.family,
    lookup: pinnedLookup(pinned),
    signal,
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "Content-Length": String(encodedBody.length),
      "Accept-Encoding": "identity",
    },
  };
  if (!isIP(parsed.hostname)) {
    (options as RequestOptions & { servername: string }).servername = parsed.hostname;
  }

  return new Promise((resolve, reject) => {
    const request = httpsRequest(parsed, options, (response) => {
      clearTimeout(connectTimer);
      resolve({
        status: response.statusCode ?? 0,
        statusText: response.statusMessage ?? "",
        body: response,
        cancel: () => {
          clearTimeout(totalTimer);
          response.destroy();
        },
      });
    });
    const connectTimer = setTimeout(() => {
      request.destroy(new Error(
        `AI endpoint TCP/TLS connection could not be established within ${CONNECT_TIMEOUT_MS}ms — check container network egress/proxy, or a fake-IP VPN DNS resolver (198.18.x.x)`,
      ));
    }, CONNECT_TIMEOUT_MS);
    // 2026-08-12+（15a 根因修复）：流式通道补整体响应超时（此前只有
    // connect 超时）。非流式 postJsonToPublicEndpoint 有 TOTAL_RESPONSE_TIMEOUT_MS
    // 兜底，流式漏了——"TCP 已连但 HTTP 响应头永不返回"时 Promise 永不
    // settle，worker 无限卡在 provider 调用 → run 永久 running → 前端永久
    // "伴星正在想"（且无 failed 事件）。totalTimer 在 resolve（响应头到达）
    // 后保留，同时覆盖"响应头到了但 body 永不推流"的挂起：触发 destroy →
    // error → reject → 调用方（chatCompletionStream）抛错 → 标记 run failed。
    // 2026-08-16（性能专项）：健康流正常结束或 cancel() 时清理 totalTimer 防
    // 泄漏；且每收到一个 data chunk 就重置该计时器（body-stall 语义），使
    // 合法长流（总时长 > TOTAL_RESPONSE_TIMEOUT_MS）不会被残留定时器误杀。
    let totalTimer = setTimeout(() => {
      request.destroy(new Error(
        `AI endpoint SSE request exceeded total timeout ${TOTAL_RESPONSE_TIMEOUT_MS}ms (connect + response body)`,
      ));
    }, TOTAL_RESPONSE_TIMEOUT_MS);
    request.on("socket", (socket) => {
      if (!socket.connecting) {
        clearTimeout(connectTimer);
        return;
      }
      socket.once("secureConnect", () => clearTimeout(connectTimer));
    });
    request.once("response", (response) => {
      clearTimeout(connectTimer);
      // 正常收尾与显式取消都清掉残留定时器，避免每连接泄漏一个 300s 定时器。
      response.once("end", () => clearTimeout(totalTimer));
      response.once("close", () => clearTimeout(totalTimer));
      // body-stall：每次收到数据说明流仍在推进，重置整体超时。
      response.on("data", () => {
        clearTimeout(totalTimer);
        totalTimer = setTimeout(() => {
          request.destroy(new Error(
            `AI endpoint SSE request exceeded total timeout ${TOTAL_RESPONSE_TIMEOUT_MS}ms (connect + response body)`,
          ));
        }, TOTAL_RESPONSE_TIMEOUT_MS);
      });
    });
    request.once("error", (error) => {
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      reject(error);
    });
    request.end(encodedBody);
  });
};
