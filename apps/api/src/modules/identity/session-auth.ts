import { randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "ailearn_session";
export const CSRF_COOKIE_NAME = "ailearn_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

export type AuthCredential = {
  token: string;
  source: "bearer" | "cookie";
};

type RequestHeaders = {
  authorization?: string;
  cookie?: string;
  [CSRF_HEADER_NAME]?: string | string[];
};

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(rawValue);
    } catch {
      // Ignore malformed cookie values instead of failing every authenticated request.
    }
  }
  return result;
}

/** Bearer remains the first-choice credential for backwards compatibility. */
export function extractAuthCredential(headers: RequestHeaders): AuthCredential | null {
  const bearerMatch = headers.authorization?.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch?.[1]) {
    return { token: bearerMatch[1], source: "bearer" };
  }
  const token = parseCookieHeader(headers.cookie)[SESSION_COOKIE_NAME];
  return token ? { token, source: "cookie" } : null;
}

export function generateCsrfToken(): string {
  return randomBytes(24).toString("base64url");
}

export function secureCookiesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return env.NODE_ENV === "production";
}

function cookieAttributes(maxAgeSeconds?: number): string {
  const secure = secureCookiesEnabled() ? "; Secure" : "";
  const maxAge = maxAgeSeconds === undefined ? "" : ` Max-Age=${maxAgeSeconds};`;
  return `Path=/;${maxAge} SameSite=Lax${secure}`;
}

export function createAuthCookieHeaders(
  sessionToken: string,
  maxAgeSeconds: number | undefined,
  csrfToken = generateCsrfToken(),
): { headers: string[]; csrfToken: string } {
  const attributes = cookieAttributes(maxAgeSeconds);
  return {
    headers: [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}; HttpOnly; ${attributes}`,
      `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}; ${attributes}`,
    ],
    csrfToken,
  };
}

export function createClearAuthCookieHeaders(): string[] {
  const attributes = cookieAttributes(0);
  const expired = "Expires=Thu, 01 Jan 1970 00:00:00 GMT";
  return [
    `${SESSION_COOKIE_NAME}=; HttpOnly; ${attributes}; ${expired}`,
    `${CSRF_COOKIE_NAME}=; ${attributes}; ${expired}`,
  ];
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Cookie-authenticated mutations use double-submit CSRF protection. Bearer
 * clients are not subject to this check because browsers do not attach their
 * Authorization header cross-site automatically.
 */
export function hasValidCookieCsrf(method: string, headers: RequestHeaders): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return true;
  const csrfCookie = parseCookieHeader(headers.cookie)[CSRF_COOKIE_NAME];
  const rawHeader = headers[CSRF_HEADER_NAME];
  const csrfHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  return Boolean(csrfCookie && csrfHeader && constantTimeEqual(csrfCookie, csrfHeader));
}
