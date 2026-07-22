/**
 * parse-source.ts 扩展测试
 *
 * 覆盖原有测试未覆盖的边界情况：
 * - 过多重定向
 * - abort signal 处理
 * - HTML 提取的各种模式（script/style 移除、HTML 实体解码、块级标签转换）
 * - 各种 content-type 处理
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canAdvanceSourceParse,
  createPinnedLookup,
  fetchUrlContent,
  type AddressResolver,
  type FetchUrlDependencies,
  type PinnedAddress,
  type PinnedRequester,
} from "../handlers/parse-source.ts";
import { SourceStatus } from "@ailearn/shared";

function mockDeps(
  responses: Array<{
    status: number;
    statusText: string;
    location?: string;
    contentType: string;
    body: string;
  }>,
  pinnedAddress: PinnedAddress = { address: "93.184.216.34", family: 4 },
): FetchUrlDependencies {
  let callIndex = 0;
  return {
    resolveAddress: async () => pinnedAddress,
    request: async () => {
      const res = responses[callIndex++] ?? responses[responses.length - 1]!;
      return {
        status: res.status,
        statusText: res.statusText,
        location: res.location,
        contentType: res.contentType,
        body: Buffer.from(res.body),
      };
    },
  };
}

// ─── canAdvanceSourceParse 补充 ──────────────────────────────────────────

test("canAdvanceSourceParse: 所有 SourceStatus 值中只有 archived 返回 false", () => {
  const allStatuses = Object.values(SourceStatus);
  for (const status of allStatuses) {
    if (status === SourceStatus.ARCHIVED) {
      assert.equal(canAdvanceSourceParse(status), false, `${status} should be false`);
    } else {
      assert.equal(canAdvanceSourceParse(status), true, `${status} should be true`);
    }
  }
});

// ─── createPinnedLookup 补充 ─────────────────────────────────────────────

test("createPinnedLookup: 忽略 hostname 参数始终返回固定地址", () => {
  const pinned: PinnedAddress = { address: "1.2.3.4", family: 4 };
  const lookup = createPinnedLookup(pinned);
  let resultAddress: string | undefined;
  let resultFamily: number | undefined;
  lookup("any-host.com", {}, (_err, address, family) => {
    resultAddress = address as string;
    resultFamily = family;
  });
  assert.equal(resultAddress, "1.2.3.4");
  assert.equal(resultFamily, 4);
});

test("createPinnedLookup: 忽略 options 参数", () => {
  const pinned: PinnedAddress = { address: "::1", family: 6 };
  const lookup = createPinnedLookup(pinned);
  let resultAddress: string | undefined;
  lookup("host", { all: true }, (_err, address) => {
    resultAddress = address as string;
  });
  assert.equal(resultAddress, "::1");
});

// ─── fetchUrlContent: 过多重定向 ──────────────────────────────────────────

test("fetchUrlContent: 超过最大重定向次数（6次）抛错", async () => {
  const redirectResponse = {
    status: 301,
    statusText: "Moved",
    location: "/next",
    contentType: "text/plain",
    body: "",
  };
  // 6 redirects + 1 final = 7 responses, but max is 5
  const deps = mockDeps([
    redirectResponse,
    redirectResponse,
    redirectResponse,
    redirectResponse,
    redirectResponse,
    redirectResponse,
  ]);

  await assert.rejects(
    fetchUrlContent("https://example.com/start", undefined, deps),
    /too many redirects/,
  );
});

test("fetchUrlContent: 正好 5 次重定向后成功", async () => {
  const deps = mockDeps([
    { status: 301, statusText: "Moved", location: "/r1", contentType: "text/plain", body: "" },
    { status: 301, statusText: "Moved", location: "/r2", contentType: "text/plain", body: "" },
    { status: 301, statusText: "Moved", location: "/r3", contentType: "text/plain", body: "" },
    { status: 301, statusText: "Moved", location: "/r4", contentType: "text/plain", body: "" },
    { status: 301, statusText: "Moved", location: "/r5", contentType: "text/plain", body: "" },
    { status: 200, statusText: "OK", contentType: "text/plain", body: "Final" },
  ]);

  const result = await fetchUrlContent("https://example.com/start", undefined, deps);
  assert.equal(result, "Final");
});

test("fetchUrlContent: 每次重定向都重新校验主机并固定已校验的 IP", async () => {
  const resolvedHosts: string[] = [];
  const requestedHops: Array<{ hostname: string; address: string }> = [];
  const resolveAddress: AddressResolver = async (hostname) => {
    resolvedHosts.push(hostname);
    return hostname === "origin.invalid"
      ? { address: "203.0.113.10", family: 4 }
      : { address: "203.0.113.11", family: 4 };
  };
  const request: PinnedRequester = async (parsed, pinned) => {
    requestedHops.push({ hostname: parsed.hostname, address: pinned.address });
    if (parsed.hostname === "origin.invalid") {
      return {
        status: 302,
        statusText: "Found",
        location: "https://redirect.invalid/final",
        contentType: "",
        body: Buffer.alloc(0),
      };
    }
    return {
      status: 200,
      statusText: "OK",
      contentType: "Text/HTML; charset=utf-8",
      body: Buffer.from("<h1>Pinned</h1><p>redirect ok</p>"),
    };
  };

  const content = await fetchUrlContent("https://origin.invalid/start", undefined, {
    resolveAddress,
    request,
  });

  assert.equal(content, "Pinned\n\nredirect ok");
  assert.deepEqual(resolvedHosts, ["origin.invalid", "redirect.invalid"]);
  assert.deepEqual(requestedHops, [
    { hostname: "origin.invalid", address: "203.0.113.10" },
    { hostname: "redirect.invalid", address: "203.0.113.11" },
  ]);
});

// ─── fetchUrlContent: abort signal ───────────────────────────────────────

test("fetchUrlContent: 预先 abort 的 signal 立即抛错", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/plain",
    body: "content",
  }]);

  const controller = new AbortController();
  controller.abort(new Error("cancelled before start"));

  await assert.rejects(
    fetchUrlContent("https://example.com/test", controller.signal, deps),
    /cancelled before start/,
  );
});

test("fetchUrlContent: 父级取消会中断尚未完成的 DNS 解析", async () => {
  const controller = new AbortController();
  let requestCalled = false;
  const pending = fetchUrlContent("https://origin.invalid/start", controller.signal, {
    resolveAddress: async () => new Promise<PinnedAddress>(() => {}),
    request: async () => {
      requestCalled = true;
      throw new Error("request must not start after cancellation");
    },
  });

  controller.abort(new Error("job cancelled"));

  await assert.rejects(pending, /job cancelled/);
  assert.equal(requestCalled, false);
});

test("fetchUrlContent: 父级取消会中断尚未完成的 HTTP 请求", async () => {
  const controller = new AbortController();
  let markRequestStarted!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  const pending = fetchUrlContent("https://origin.invalid/start", controller.signal, {
    resolveAddress: async () => ({ address: "203.0.113.10", family: 4 }),
    request: async () => {
      markRequestStarted();
      return new Promise<never>(() => {});
    },
  });

  await requestStarted;
  controller.abort(new Error("job cancelled during request"));

  await assert.rejects(pending, /job cancelled during request/);
});

test("fetchUrlContent: 打开 socket 前拒绝私网及保留地址字面量", async () => {
  for (const url of [
    "http://127.0.0.1/metadata",
    "http://[::1]/metadata",
    "http://[::ffff:127.0.0.1]/metadata",
    "http://[fe90::1]/metadata",
    "http://[2001:db8::1]/metadata",
    "http://[2002:7f00:1::]/metadata",
  ]) {
    await assert.rejects(fetchUrlContent(url), /blocked: private\/internal host/);
  }
});

// ─── fetchUrlContent: HTML 提取各种模式 ──────────────────────────────────

test("fetchUrlContent: HTML 移除 script 标签及内容", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<html><body><script>alert("evil")</script><p>Good content</p></body></html>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(!result.includes('alert'));
  assert.ok(!result.includes('<script>'));
  assert.ok(result.includes("Good content"));
});

test("fetchUrlContent: HTML 移除 style 标签及内容", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<html><body><style>body { color: red; }</style><p>Content</p></body></html>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(!result.includes('color: red'));
  assert.ok(!result.includes('<style>'));
  assert.ok(result.includes("Content"));
});

test("fetchUrlContent: HTML 移除 noscript 标签及内容", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<html><body><noscript>Enable JS</noscript><p>Content</p></body></html>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(!result.includes("Enable JS"));
  assert.ok(result.includes("Content"));
});

test("fetchUrlContent: HTML 块级标签转换为换行", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<p>Paragraph 1</p><p>Paragraph 2</p><div>Div</div>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(result.includes("Paragraph 1"));
  assert.ok(result.includes("Paragraph 2"));
  assert.ok(result.includes("Div"));
  // 块级标签应该被替换为换行，不是内联
  assert.ok(!result.includes("<p>"));
  assert.ok(!result.includes("<div>"));
});

test("fetchUrlContent: HTML 实体解码", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<p>&amp;text&lt;more&gt;"quote"&#39;apostrophe&#39;A&nbsp;B</p>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(result.includes("&"));
  assert.ok(result.includes("<"));
  assert.ok(result.includes(">"));
  assert.ok(result.includes('"'));
  assert.ok(result.includes("'"));
  // &nbsp; is replaced with regular space (U+0020) by extractTextFromHtml
  assert.ok(result.includes("A B"));
});

test("fetchUrlContent: HTML 标题标签转换为换行", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<h1>Title</h1><h2>Subtitle</h2><p>Body</p>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(result.includes("Title"));
  assert.ok(result.includes("Subtitle"));
  assert.ok(result.includes("Body"));
  assert.ok(!result.includes("<h1>"));
  assert.ok(!result.includes("<h2>"));
});

test("fetchUrlContent: HTML 列表标签处理", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<ul><li>Item 1</li><li>Item 2</li></ul>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(result.includes("Item 1"));
  assert.ok(result.includes("Item 2"));
  assert.ok(!result.includes("<li>"));
  assert.ok(!result.includes("<ul>"));
});

test("fetchUrlContent: HTML blockquote 和 pre 标签处理", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<blockquote>Quote</blockquote><pre>Code block</pre>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(result.includes("Quote"));
  assert.ok(result.includes("Code block"));
  assert.ok(!result.includes("<blockquote>"));
  assert.ok(!result.includes("<pre>"));
});

test("fetchUrlContent: HTML table 标签处理", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<table><tr><td>Cell 1</td><td>Cell 2</td></tr></table>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(result.includes("Cell 1"));
  assert.ok(result.includes("Cell 2"));
  assert.ok(!result.includes("<td>"));
  assert.ok(!result.includes("<table>"));
});

test("fetchUrlContent: 压缩多余换行", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<p>A</p><p>B</p><p>C</p><p>D</p><p>E</p>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  // 不应该有 3 个以上连续换行
  assert.ok(!result.includes("\n\n\n"));
});

test("fetchUrlContent: 空 HTML body 返回空字符串", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<html><body></body></html>',
  }]);

  const result = await fetchUrlContent("https://example.com/empty", undefined, deps);
  assert.equal(result.trim(), "");
});

// ─── fetchUrlContent: 各种 content-type ──────────────────────────────────

test("fetchUrlContent: application/json 原样返回", async () => {
  const jsonBody = '{"key": "value"}';
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "application/json",
    body: jsonBody,
  }]);

  const result = await fetchUrlContent("https://example.com/data.json", undefined, deps);
  assert.equal(result, jsonBody);
});

test("fetchUrlContent: text/css 原样返回", async () => {
  const cssBody = "body { color: red; }";
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/css",
    body: cssBody,
  }]);

  const result = await fetchUrlContent("https://example.com/style.css", undefined, deps);
  assert.equal(result, cssBody);
});

test("fetchUrlContent: 无 content-type 原样返回", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "",
    body: "raw content",
  }]);

  const result = await fetchUrlContent("https://example.com/raw", undefined, deps);
  assert.equal(result, "raw content");
});

test("fetchUrlContent: 大小写不敏感的 HTML content-type", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "TEXT/HTML",
    body: '<p>Content</p>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(result.includes("Content"));
  assert.ok(!result.includes("<p>"));
});

// ─── fetchUrlContent: 重定向边界 ──────────────────────────────────────────

test("fetchUrlContent: 303 重定向跟随", async () => {
  const deps = mockDeps([
    { status: 303, statusText: "See Other", location: "/new", contentType: "text/plain", body: "" },
    { status: 200, statusText: "OK", contentType: "text/plain", body: "303 result" },
  ]);

  const result = await fetchUrlContent("https://example.com/old", undefined, deps);
  assert.equal(result, "303 result");
});

test("fetchUrlContent: 307 重定向跟随", async () => {
  const deps = mockDeps([
    { status: 307, statusText: "Temporary Redirect", location: "/new", contentType: "text/plain", body: "" },
    { status: 200, statusText: "OK", contentType: "text/plain", body: "307 result" },
  ]);

  const result = await fetchUrlContent("https://example.com/old", undefined, deps);
  assert.equal(result, "307 result");
});

test("fetchUrlContent: 308 重定向跟随", async () => {
  const deps = mockDeps([
    { status: 308, statusText: "Permanent Redirect", location: "/new", contentType: "text/plain", body: "" },
    { status: 200, statusText: "OK", contentType: "text/plain", body: "308 result" },
  ]);

  const result = await fetchUrlContent("https://example.com/old", undefined, deps);
  assert.equal(result, "308 result");
});

test("fetchUrlContent: 3xx 无 location 头不跟随重定向", async () => {
  const deps = mockDeps([{
    status: 302,
    statusText: "Found",
    contentType: "text/plain",
    body: "no location header",
  }]);

  // 3xx without location should fall through to status check
  await assert.rejects(
    fetchUrlContent("https://example.com/old", undefined, deps),
    /HTTP 302/,
  );
});

test("fetchUrlContent: 相对路径重定向正确解析", async () => {
  const deps = mockDeps([
    { status: 302, statusText: "Found", location: "../parent/page.txt", contentType: "text/plain", body: "" },
    { status: 200, statusText: "OK", contentType: "text/plain", body: "relative redirect" },
  ]);

  const result = await fetchUrlContent("https://example.com/sub/current.txt", undefined, deps);
  assert.equal(result, "relative redirect");
});

// ─── fetchUrlContent: HTTP 错误状态 ───────────────────────────────────────

test("fetchUrlContent: 403 抛出 HTTP 错误", async () => {
  const deps = mockDeps([{
    status: 403,
    statusText: "Forbidden",
    contentType: "text/plain",
    body: "Forbidden",
  }]);

  await assert.rejects(
    fetchUrlContent("https://example.com/forbidden", undefined, deps),
    /HTTP 403/,
  );
});

test("fetchUrlContent: 502 抛出 HTTP 错误", async () => {
  const deps = mockDeps([{
    status: 502,
    statusText: "Bad Gateway",
    contentType: "text/plain",
    body: "Bad Gateway",
  }]);

  await assert.rejects(
    fetchUrlContent("https://example.com/bad", undefined, deps),
    /HTTP 502/,
  );
});

// ─── fetchUrlContent: IPv6 pinned address ────────────────────────────────

test("fetchUrlContent: IPv6 pinned address 成功", async () => {
  const deps = mockDeps(
    [{
      status: 200,
      statusText: "OK",
      contentType: "text/plain",
      body: "IPv6 content",
    }],
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  );

  const result = await fetchUrlContent("https://example.com/test", undefined, deps);
  assert.equal(result, "IPv6 content");
});
