/**
 * Keep the account revocation stream on an explicit server route.
 *
 * Next rewrites are sufficient for ordinary JSON requests, but they may hold
 * an external rewrite open while waiting for a buffered response. This route
 * forwards the upstream ReadableStream directly so EventSource receives the
 * SSE headers and heartbeat immediately.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const UPSTREAM_HEADERS = [
  "accept",
  "authorization",
  "cookie",
  "last-event-id",
] as const;

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const upstreamBase = process.env.INTERNAL_API_URL ?? "http://localhost:4000";
  const headers = new Headers();
  for (const name of UPSTREAM_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const upstream = await fetch(`${upstreamBase}/me/companion/events${requestUrl.search}`, {
    method: "GET",
    headers,
    cache: "no-store",
    signal: request.signal,
  });

  const responseHeaders = new Headers();
  for (const name of ["cache-control", "content-type", "x-accel-buffering"] as const) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
