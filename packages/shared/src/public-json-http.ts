import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

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
  if (ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] <= 1) return true;
  if ((first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00 || (first & 0xff00) === 0xff00) return true;
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
  const addresses = await dnsLookup(clean, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("AI endpoint hostname has no address");
  if (addresses.some((entry) => isNonPublicAIEndpointAddress(entry.address))) {
    throw new Error("AI endpoint resolved to a non-public address");
  }
  const selected = addresses[0];
  if (selected.family !== 4 && selected.family !== 6) {
    throw new Error("AI endpoint has an unsupported address family");
  }
  return { address: selected.address, family: selected.family };
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

/** HTTPS-only JSON POST with DNS validation and connection-time IP pinning. */
export const postJsonToPublicEndpoint: PublicJsonRequester = async (
  url,
  headers,
  body,
  signal,
) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("personal AI endpoints must use HTTPS");
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
      response.once("error", reject);
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
    request.once("error", reject);
    request.end(encodedBody);
  });
};
