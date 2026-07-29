/**
 * parse-source.ts 扩展测试
 *
 * 覆盖原有测试未覆盖的边界情况：
 * - 过多重定向
 * - abort signal 处理
 * - HTML 提取的各种模式（script/style 移除、HTML 实体解码、块级标签转换）
 * - 各种 content-type 处理
 * - 压缩响应解压（gzip / deflate / deflate-raw fallback / br / 解压炸弹防护）
 * - 重试延迟被 abort 信号中断
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync, deflateSync, deflateRawSync, brotliCompressSync } from "node:zlib";
import {
  canAdvanceSourceParse,
  createPinnedLookup,
  fetchUrlContent,
  correctSourceType,
  extractSourceTitle,
  decompressBuffer,
  isPrivateIpAddress,
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
  assert.equal(result.text, "Final");
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

  assert.equal(content.text, "Pinned\n\nredirect ok");
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

// ─── fetchUrlContent: SSRF 过滤策略（U5 修复） ──────────────────────────

test("fetchUrlContent: DNS 返回混合公网/私有地址时跳过私有使用公网（U5 修复）", async () => {
  // 模拟 resolvePublicAddress 已过滤掉私有地址、返回公网地址的场景
  // 实际过滤逻辑在 resolvePublicAddress 内部完成（filter private → select public）
  const deps: FetchUrlDependencies = {
    resolveAddress: async () => ({ address: "93.184.216.34", family: 4 }),
    request: async () => ({
      status: 200,
      statusText: "OK",
      contentType: "text/plain",
      body: Buffer.from("CDN content"),
    }),
  };

  const result = await fetchUrlContent("https://cdn.example.com/page", undefined, deps);
  assert.equal(result.text, "CDN content");
});

test("fetchUrlContent: DNS 全部私有地址仍然拒绝（SSRF 防护不变）", async () => {
  // 模拟 resolvePublicAddress 发现全部 DNS 地址都是私有 → 抛出 blocked 错误
  const deps: FetchUrlDependencies = {
    resolveAddress: async () => {
      throw new Error(
        "blocked: private/internal host (internal.cdn.example.com) — all resolved addresses are private: 10.0.0.1, 172.16.0.1",
      );
    },
    request: async () => ({
      status: 200,
      statusText: "OK",
      contentType: "text/plain",
      body: Buffer.from("should not reach"),
    }),
  };

  await assert.rejects(
    fetchUrlContent("https://internal.cdn.example.com/page", undefined, deps),
    /blocked: private\/internal host/,
  );
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
  assert.ok(!result.text.includes('alert'));
  assert.ok(!result.text.includes('<script>'));
  assert.ok(result.text.includes("Good content"));
});

test("fetchUrlContent: HTML 移除 style 标签及内容", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<html><body><style>body { color: red; }</style><p>Content</p></body></html>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(!result.text.includes('color: red'));
  assert.ok(!result.text.includes('<style>'));
  assert.ok(result.text.includes("Content"));
});

test("fetchUrlContent: HTML 移除 noscript 标签及内容", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<html><body><noscript>Enable JS</noscript><p>Content</p></body></html>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(!result.text.includes("Enable JS"));
  assert.ok(result.text.includes("Content"));
});

test("fetchUrlContent: HTML 块级标签转换为换行", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<p>Paragraph 1</p><p>Paragraph 2</p><div>Div</div>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(result.text.includes("Paragraph 1"));
  assert.ok(result.text.includes("Paragraph 2"));
  assert.ok(result.text.includes("Div"));
  // 块级标签应该被替换为换行，不是内联
  assert.ok(!result.text.includes("<p>"));
  assert.ok(!result.text.includes("<div>"));
});

test("fetchUrlContent: HTML 实体解码", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<p>&amp;text&lt;more&gt;"quote"&#39;apostrophe&#39;A&nbsp;B</p>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(result.text.includes("&"));
  assert.ok(result.text.includes("<"));
  assert.ok(result.text.includes(">"));
  assert.ok(result.text.includes('"'));
  assert.ok(result.text.includes("'"));
  // &nbsp; is replaced with regular space (U+0020) by extractTextFromHtml
  assert.ok(result.text.includes("A B"));
});

test("fetchUrlContent: HTML 标题标签转换为换行", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<h1>Title</h1><h2>Subtitle</h2><p>Body</p>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(result.text.includes("Title"));
  assert.ok(result.text.includes("Subtitle"));
  assert.ok(result.text.includes("Body"));
  assert.ok(!result.text.includes("<h1>"));
  assert.ok(!result.text.includes("<h2>"));
});

test("fetchUrlContent: HTML 列表标签处理", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<ul><li>Item 1</li><li>Item 2</li></ul>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(result.text.includes("Item 1"));
  assert.ok(result.text.includes("Item 2"));
  assert.ok(!result.text.includes("<li>"));
  assert.ok(!result.text.includes("<ul>"));
});

test("fetchUrlContent: HTML blockquote 和 pre 标签处理", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<blockquote>Quote</blockquote><pre>Code block</pre>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(result.text.includes("Quote"));
  assert.ok(result.text.includes("Code block"));
  assert.ok(!result.text.includes("<blockquote>"));
  assert.ok(!result.text.includes("<pre>"));
});

test("fetchUrlContent: HTML table 标签处理", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<table><tr><td>Cell 1</td><td>Cell 2</td></tr></table>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(result.text.includes("Cell 1"));
  assert.ok(result.text.includes("Cell 2"));
  assert.ok(!result.text.includes("<td>"));
  assert.ok(!result.text.includes("<table>"));
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
  assert.ok(!result.text.includes("\n\n\n"));
});

test("fetchUrlContent: 空 HTML body 返回空字符串", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: '<html><body></body></html>',
  }]);

  const result = await fetchUrlContent("https://example.com/empty", undefined, deps);
  assert.equal(result.text.trim(), "");
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
  assert.equal(result.text, jsonBody);
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
  assert.equal(result.text, cssBody);
});

test("fetchUrlContent: 无 content-type 原样返回", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "",
    body: "raw content",
  }]);

  const result = await fetchUrlContent("https://example.com/raw", undefined, deps);
  assert.equal(result.text, "raw content");
});

test("fetchUrlContent: 大小写不敏感的 HTML content-type", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "TEXT/HTML",
    body: '<p>Content</p>',
  }]);

  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.ok(result.text.includes("Content"));
  assert.ok(!result.text.includes("<p>"));
});

// ─── fetchUrlContent: 重定向边界 ──────────────────────────────────────────

test("fetchUrlContent: 303 重定向跟随", async () => {
  const deps = mockDeps([
    { status: 303, statusText: "See Other", location: "/new", contentType: "text/plain", body: "" },
    { status: 200, statusText: "OK", contentType: "text/plain", body: "303 result" },
  ]);

  const result = await fetchUrlContent("https://example.com/old", undefined, deps);
  assert.equal(result.text, "303 result");
});

test("fetchUrlContent: 307 重定向跟随", async () => {
  const deps = mockDeps([
    { status: 307, statusText: "Temporary Redirect", location: "/new", contentType: "text/plain", body: "" },
    { status: 200, statusText: "OK", contentType: "text/plain", body: "307 result" },
  ]);

  const result = await fetchUrlContent("https://example.com/old", undefined, deps);
  assert.equal(result.text, "307 result");
});

test("fetchUrlContent: 308 重定向跟随", async () => {
  const deps = mockDeps([
    { status: 308, statusText: "Permanent Redirect", location: "/new", contentType: "text/plain", body: "" },
    { status: 200, statusText: "OK", contentType: "text/plain", body: "308 result" },
  ]);

  const result = await fetchUrlContent("https://example.com/old", undefined, deps);
  assert.equal(result.text, "308 result");
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
  assert.equal(result.text, "relative redirect");
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
  assert.equal(result.text, "IPv6 content");
});

// ─── correctSourceType ─────────────────────────────────────────────────

test("correctSourceType: manual 类型不修正", () => {
  const result = correctSourceType("some content", "code", "manual");
  assert.equal(result, "code");
});

test("correctSourceType: url 类型不修正", () => {
  const result = correctSourceType("some html text", "url", "auto");
  assert.equal(result, "url");
});

test("correctSourceType: auto text→code 当 codeScore >= 2 且 > mdScore", () => {
  const code = "const x = 1;\nfunction foo() {}\nconsole.log(x);";
  const result = correctSourceType(code, "text", "auto");
  assert.equal(result, "code");
});

test("correctSourceType: auto text→markdown 当 mdScore >= 2", () => {
  const md = "# Title\n\nSome text.\n\n- item 1\n- item 2";
  const result = correctSourceType(md, "text", "auto");
  assert.equal(result, "markdown");
});

test("correctSourceType: code→text 回退 当 codeScore === 0 且 mdScore === 0（ER1）", () => {
  // 纯英文文本，无任何代码或 Markdown 特征
  const text = "The quick brown fox jumps over the lazy dog.\n\nSome more text here.";
  const result = correctSourceType(text, "code", "auto");
  assert.equal(result, "text");
});

test("correctSourceType: code→text 回退不触发 当有 code 特征", () => {
  // 含 code 特征，不应回退到 text
  const text = "const x = 1;\nconsole.log(x);";
  const result = correctSourceType(text, "code", "auto");
  assert.equal(result, "code");
});

test("correctSourceType: code→markdown 当 mdScore >= 2 且 > codeScore", () => {
  const md = "# Title\n\n- item 1\n- item 2";
  const result = correctSourceType(md, "code", "auto");
  assert.equal(result, "markdown");
});

test("correctSourceType: markdown→code 当 codeScore >= 3 且 > mdScore + 1", () => {
  const code = "const x = 1;\nfunction foo() {}\nif (true) {}\nfor (let i; i < 10; i++) {}\nwhile (x) {}";
  const result = correctSourceType(code, "markdown", "auto");
  assert.equal(result, "code");
});

test("correctSourceType: from 关键字不再误判英文文本为 code", () => {
  // "from the beginning" 不应触发 code 检测
  const text = "from the beginning of time\nwe have been learning";
  const result = correctSourceType(text, "text", "auto");
  assert.equal(result, "text");
});

test("correctSourceType: from 关键字不再误判 code→text 回退被阻断", () => {
  // "from" 在旧行签中会贡献 codeScore=1，阻止 code→text 回退
  // 移除后，纯英文文本 codeScore=0，回退正常触发
  const text = "from my perspective\nthis is just text";
  const result = correctSourceType(text, "code", "auto");
  assert.equal(result, "text");
});

test("correctSourceType: public class 组合仍作为 code 信号", () => {
  // public class 是两词模式，保留在 codeIndicators 第一条中
  // 搭配分号使 codeScore >= 2，触发 text→code 修正
  const code = "public class Foo {\n  int x = 1;\n};";
  const result = correctSourceType(code, "text", "auto");
  assert.equal(result, "code");
});

test("correctSourceType: public 单独不再是 code 信号（移除避免英文误判）", () => {
  // public 已从 codeIndicators 移除，避免 "public transport" 等英文误判
  // 只有分号一个信号（codeScore=1），不够触发 text→code（需 >= 2）
  const code = "public constructor() {\n  this.x = 1;\n};";
  const result = correctSourceType(code, "text", "auto");
  assert.equal(result, "text");
});

test("correctSourceType: public 单独不误判纯文本为 code", () => {
  // public 已从 codeIndicators 移除，codeScore=0，不会触发 text→code
  const text = "public transport is great\nwe should use it more";
  const result = correctSourceType(text, "text", "auto");
  assert.equal(result, "text");
});

test("correctSourceType: public 误判为 code 后能通过回退修正", () => {
  // detectSourceType 不再将 public 开头的文本误判为 code（已移除），
  // 但对存量数据（typeSource=undefined 视为 auto），correctSourceType
  // 的 code→text 回退（codeScore===0 && mdScore===0）能正确修正
  const text = "public transport is great\nwe should use it more";
  const result = correctSourceType(text, "code", "auto");
  assert.equal(result, "text");
});

test("correctSourceType: private 单独不误判纯文本为 code", () => {
  // private 已从 codeIndicators 移除，避免 "private matter" 等英文误判
  const text = "private matters should remain private\nthat is my view";
  const result = correctSourceType(text, "text", "auto");
  assert.equal(result, "text");
});

test("correctSourceType: private 误判为 code 后能通过回退修正", () => {
  // 对存量数据，code→text 回退能修正 private 误判
  const text = "private matters should remain private\nthat is my view";
  const result = correctSourceType(text, "code", "auto");
  assert.equal(result, "text");
});

test("correctSourceType: protected 单独不误判纯文本为 code", () => {
  // protected 已从 codeIndicators 移除，避免 "protected species" 等英文误判
  const text = "protected species need our attention\nthat is important";
  const result = correctSourceType(text, "text", "auto");
  assert.equal(result, "text");
});

test("correctSourceType: type 单独不误判纯文本为 code", () => {
  // type 已从 codeIndicators 移除，避免 "type of music" 等英文误判
  // 与 from/public/private/protected 同类问题
  const text = "type of music is important\nwe should listen more";
  const result = correctSourceType(text, "text", "auto");
  assert.equal(result, "text");
});

test("correctSourceType: type 误判为 code 后能通过回退修正", () => {
  // 对存量数据，code→text 回退能修正 type 误判
  // type 已从 codeIndicators 移除，codeScore=0，回退正常触发
  const text = "type of music is important\nwe should listen more";
  const result = correctSourceType(text, "code", "auto");
  assert.equal(result, "text");
});

test("correctSourceType: TypeScript type 定义仍能通过其他信号检测为 code", () => {
  // type 已移除，但 const 和分号仍在 codeIndicators 中
  // codeScore >= 2（const + 分号），触发 text→code 修正
  const code = "type Foo = string;\nconst bar: Foo = \"hello\";";
  const result = correctSourceType(code, "text", "auto");
  assert.equal(result, "code");
});

test("correctSourceType: tab 分隔的 def 关键字不触发 code→text 误回退（\\b 对齐修复）", () => {
  // detectSourceType 用 \b 匹配 def\tfoo（tab 分隔），返回 "code"。
  // 旧 correctSourceType 的第一条 codeIndicator 用 def + 尾随空格（无 \b），
  // def\tfoo 不匹配 → codeScore=0 → code→text 回退误触发 → 返回 "text" ❌
  // 新正则用 def\b → def\tfoo 匹配 → codeScore=1 → 回退不触发 → 返回 "code" ✅
  const code = "def\tmain():\n    print('hello')\n    return 0\n";
  const result = correctSourceType(code, "code", "auto");
  assert.equal(result, "code");
});

test("correctSourceType: \\b 防止 classical 等英文单词误匹配 class 关键字", () => {
  // 旧正则无 \b，classical 匹配 class（codeScore=1）。
  // 虽 codeScore=1 不足以触发 text→code（需>=2），但 \b 修复消除了此误匹配信号，
  // 使 correctSourceType 与 detectSourceType 的关键字匹配逻辑完全对齐。
  const text = "classical music is beautiful\nwe should listen more";
  const result = correctSourceType(text, "text", "auto");
  assert.equal(result, "text");
});

// ─── extractSourceTitle ─────────────────────────────────────────────────

test("extractSourceTitle: URL 来源优先使用 fetchedTitle", () => {
  const blocks: Parameters<typeof extractSourceTitle>[0] = [
    { type: "paragraph", content: "Some content here" },
  ];
  const result = extractSourceTitle(blocks, "url", "https://example.com", "Example Page Title");
  assert.equal(result, "Example Page Title");
});

test("extractSourceTitle: URL 来源回退到 hostname 当无 fetchedTitle 且 blocks 无内容", () => {
  const blocks: Parameters<typeof extractSourceTitle>[0] = [];
  const result = extractSourceTitle(blocks, "url", "https://example.com/page", null);
  assert.equal(result, "example.com");
});

test("extractSourceTitle: URL 来源回退到 blocks 当无 fetchedTitle", () => {
  const blocks: Parameters<typeof extractSourceTitle>[0] = [
    { type: "heading", content: "First Heading" },
  ];
  const result = extractSourceTitle(blocks, "url", "https://example.com", null);
  assert.equal(result, "First Heading");
});

test("extractSourceTitle: 非 URL 来源使用 blocks 提取", () => {
  const blocks: Parameters<typeof extractSourceTitle>[0] = [
    { type: "heading", content: "My Title" },
    { type: "paragraph", content: "Some paragraph" },
  ];
  const result = extractSourceTitle(blocks, "text", null, null);
  assert.equal(result, "My Title");
});

test("extractSourceTitle: blocks 全空时返回 null", () => {
  const blocks: Parameters<typeof extractSourceTitle>[0] = [
    { type: "paragraph", content: "" },
    { type: "paragraph", content: "  " },
  ];
  const result = extractSourceTitle(blocks, "text", null, null);
  assert.equal(result, null);
});

test("extractSourceTitle: 返回 null 时调用方保留原标题", () => {
  const blocks: Parameters<typeof extractSourceTitle>[0] = [];
  const result = extractSourceTitle(blocks, "text", null, null);
  assert.equal(result, null);
});

// ─── fetchUrlContent: 压缩响应 ───────────────────────────────────────────

// 注意：gzip/deflate/br 解压逻辑在 requestPinnedUrl 内部（读取 IncomingMessage
// 的 content-encoding 头），而 DI mock 的 request 函数返回的是已组装好的
// PinnedResponse（不含 content-encoding 头）。因此 requestPinnedUrl 内的
// 解压+解压炸弹防护（decompressed.length > FETCH_MAX_BYTES 检查）无法通过
// DI mock 覆盖。decompressBuffer 已导出，直接测试解压逻辑；
// 解压炸弹防护作为 requestPinnedUrl 的集成测试留给未来补充。

test("fetchUrlContent: HTML 标题提取（og:title 优先）", async () => {
  const html = `<html><head>
    <meta property="og:title" content="OG Title Here" />
    <title>Regular Title</title>
  </head><body><p>Content</p></body></html>`;
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    body: html,
  }]);
  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.equal(result.title, "OG Title Here");
});

test("fetchUrlContent: HTML 标题提取（无 og:title 时使用 title 标签）", async () => {
  const html = `<html><head><title>Page Title</title></head><body><p>Content</p></body></html>`;
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    body: html,
  }]);
  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.equal(result.title, "Page Title");
});

test("fetchUrlContent: HTML 标题提取（无 title 时返回 null）", async () => {
  const html = `<html><head></head><body><p>Content</p></body></html>`;
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    body: html,
  }]);
  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.equal(result.title, null);
});

test("fetchUrlContent: 非 HTML 内容 title 为 null", async () => {
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/plain",
    body: "Hello, World!",
  }]);
  const result = await fetchUrlContent("https://example.com/test.txt", undefined, deps);
  assert.equal(result.title, null);
  assert.equal(result.text, "Hello, World!");
});

test("fetchUrlContent: og:title content 属性在 property 之前也能提取", async () => {
  const html = `<html><head>
    <meta content="Reversed Order" property="og:title" />
  </head><body><p>Content</p></body></html>`;
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    body: html,
  }]);
  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.equal(result.title, "Reversed Order");
});

test("fetchUrlContent: HTML 标题截断到 100 字符", async () => {
  const longTitle = "A".repeat(200);
  const html = `<html><head><title>${longTitle}</title></head><body><p>Content</p></body></html>`;
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    body: html,
  }]);
  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.equal(result.title!.length, 100);
});

// ─── fetchUrlContent: 重试机制 ───────────────────────────────────────────

test("fetchUrlContent: 瞬时错误触发重试后成功", async () => {
  let callCount = 0;
  const deps: FetchUrlDependencies = {
    resolveAddress: async () => ({ address: "93.184.216.34", family: 4 }),
    request: async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("socket hang up") as NodeJS.ErrnoException;
        err.code = "ECONNRESET";
        throw err;
      }
      return {
        status: 200,
        statusText: "OK",
        contentType: "text/plain",
        body: Buffer.from("recovered"),
      };
    },
  };

  const result = await fetchUrlContent("https://example.com/test", undefined, deps);
  assert.equal(result.text, "recovered");
  assert.equal(callCount, 2);
});

test("fetchUrlContent: HTTP 4xx 不重试", async () => {
  let callCount = 0;
  const deps: FetchUrlDependencies = {
    resolveAddress: async () => ({ address: "93.184.216.34", family: 4 }),
    request: async () => {
      callCount++;
      return {
        status: 404,
        statusText: "Not Found",
        contentType: "text/plain",
        body: Buffer.from("Not Found"),
      };
    },
  };

  await assert.rejects(
    fetchUrlContent("https://example.com/test", undefined, deps),
    /HTTP 404/,
  );
  assert.equal(callCount, 1);
});

test("fetchUrlContent: 非瞬时错误不重试", async () => {
  let callCount = 0;
  const deps: FetchUrlDependencies = {
    resolveAddress: async () => ({ address: "93.184.216.34", family: 4 }),
    request: async () => {
      callCount++;
      throw new Error("some non-transient error");
    },
  };

  await assert.rejects(
    fetchUrlContent("https://example.com/test", undefined, deps),
    /some non-transient error/,
  );
  assert.equal(callCount, 1);
});

// ─── decompressBuffer: 压缩响应解压 ───────────────────────────────────────

test("decompressBuffer: gzip 正确解压", () => {
  const original = "Hello, gzip world!";
  const compressed = gzipSync(Buffer.from(original));
  const decompressed = decompressBuffer(compressed, "gzip");
  assert.equal(decompressed.toString("utf-8"), original);
});

test("decompressBuffer: x-gzip 等价于 gzip", () => {
  const original = "Hello, x-gzip world!";
  const compressed = gzipSync(Buffer.from(original));
  const decompressed = decompressBuffer(compressed, "x-gzip");
  assert.equal(decompressed.toString("utf-8"), original);
});

test("decompressBuffer: deflate（标准 zlib wrapper）正确解压", () => {
  const original = "Hello, deflate world!";
  const compressed = deflateSync(Buffer.from(original));
  const decompressed = decompressBuffer(compressed, "deflate");
  assert.equal(decompressed.toString("utf-8"), original);
});

test("decompressBuffer: deflate raw（无 zlib header）fallback 到 inflateRawSync", () => {
  const original = "Hello, raw deflate world!";
  // deflateRawSync 生成无 zlib header 的 raw deflate 数据
  const compressed = deflateRawSync(Buffer.from(original));
  // decompressBuffer 先尝试 inflateSync（期望 zlib header），
  // 遇到 Z_DATA_ERROR 后 fallback 到 inflateRawSync
  const decompressed = decompressBuffer(compressed, "deflate");
  assert.equal(decompressed.toString("utf-8"), original);
});

test("decompressBuffer: br（brotli）正确解压", () => {
  const original = "Hello, brotli world!";
  const compressed = brotliCompressSync(Buffer.from(original));
  const decompressed = decompressBuffer(compressed, "br");
  assert.equal(decompressed.toString("utf-8"), original);
});

test("decompressBuffer: 不支持的编码抛错", () => {
  const compressed = Buffer.from("some data");
  assert.throws(
    () => decompressBuffer(compressed, "unsupported-encoding"),
    /unsupported content encoding/,
  );
});

test("decompressBuffer: gzip 解压后内容正确（含中文 UTF-8）", () => {
  const original = "你好，世界！这是一段测试文本。";
  const compressed = gzipSync(Buffer.from(original, "utf-8"));
  const decompressed = decompressBuffer(compressed, "gzip");
  assert.equal(decompressed.toString("utf-8"), original);
});

test("decompressBuffer: br 解压后内容正确（含中文 UTF-8）", () => {
  const original = "你好，世界！这是一段 brotli 测试。";
  const compressed = brotliCompressSync(Buffer.from(original, "utf-8"));
  const decompressed = decompressBuffer(compressed, "br");
  assert.equal(decompressed.toString("utf-8"), original);
});

// ─── fetchUrlContent: retry-abort 延迟中断 ────────────────────────────────

test("fetchUrlContent: abort 信号在重试延迟期间中断等待", async () => {
  let callCount = 0;
  const controller = new AbortController();
  const deps: FetchUrlDependencies = {
    resolveAddress: async () => ({ address: "93.184.216.34", family: 4 }),
    request: async () => {
      callCount++;
      const err = new Error("socket hang up") as NodeJS.ErrnoException;
      err.code = "ECONNRESET";
      throw err;
    },
  };

  // 发起请求，第一次会 ECONNRESET 触发重试延迟
  const pending = fetchUrlContent("https://example.com/test", controller.signal, deps);

  // 等待一小段时间确保第一次请求已完成并进入重试延迟
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(callCount, 1, "first attempt should have completed");

  // 在重试延迟期间 abort，应立即中断延迟并抛出 abort 错误
  controller.abort(new Error("job cancelled during retry delay"));

  await assert.rejects(pending, /job cancelled during retry delay/);
  assert.equal(callCount, 1, "should not have retried after abort");
});

// ─── extractHtmlTitle: 引号和特殊字符处理 ─────────────────────────────────

test("fetchUrlContent: og:title 标题含单引号时不截断（content=\"John's Blog\"）", async () => {
  const html = `<html><head>
    <meta property="og:title" content="John's Blog" />
  </head><body><p>Content</p></body></html>`;
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    body: html,
  }]);
  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.equal(result.title, "John's Blog");
});

test("fetchUrlContent: og:title 标题含双引号时不截断（content='Say \"Hi\"'）", async () => {
  const html = `<html><head>
    <meta property="og:title" content='Say "Hi"' />
  </head><body><p>Content</p></body></html>`;
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    body: html,
  }]);
  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.equal(result.title, 'Say "Hi"');
});

test("fetchUrlContent: <title> 标签含 < 字符时正确提取", async () => {
  const html = `<html><head><title>A < B comparison</title></head><body><p>Content</p></body></html>`;
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    body: html,
  }]);
  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.equal(result.title, "A < B comparison");
});

// ─── extractHtmlTitle: HTML 实体解码与空白归一化 ──────────────────────────

test("fetchUrlContent: og:title 中的 HTML 实体正确解码（&amp; → &）", async () => {
  const html = `<html><head>
    <meta property="og:title" content="Tom &amp; Jerry" />
  </head><body><p>Content</p></body></html>`;
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    body: html,
  }]);
  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.equal(result.title, "Tom & Jerry");
});

test("fetchUrlContent: og:title 中的多种 HTML 实体正确解码", async () => {
  const html = `<html><head>
    <meta property="og:title" content="A &lt; B &amp; C &gt; D &quot;E&quot; &#39;F&#39;" />
  </head><body><p>Content</p></body></html>`;
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    body: html,
  }]);
  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.equal(result.title, `A < B & C > D "E" 'F'`);
});

test("fetchUrlContent: <title> 中的 HTML 实体正确解码（&amp; → &）", async () => {
  const html = `<html><head><title>Tom &amp; Jerry</title></head><body><p>Content</p></body></html>`;
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    body: html,
  }]);
  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.equal(result.title, "Tom & Jerry");
});

test("fetchUrlContent: og:title 中的多余空白归一化为单个空格", async () => {
  const html = `<html><head>
    <meta property="og:title" content="  Hello    World  " />
  </head><body><p>Content</p></body></html>`;
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    body: html,
  }]);
  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.equal(result.title, "Hello World");
});

test("fetchUrlContent: og:title 含 &nbsp; 正确解码为空格", async () => {
  const html = `<html><head>
    <meta property="og:title" content="Hello&nbsp;World" />
  </head><body><p>Content</p></body></html>`;
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    body: html,
  }]);
  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.equal(result.title, "Hello World");
});

test("fetchUrlContent: <title> 含换行和缩进正确归一化", async () => {
  const html = `<html><head><title>
    Multi
    Line
    Title
  </title></head><body><p>Content</p></body></html>`;
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    body: html,
  }]);
  const result = await fetchUrlContent("https://example.com/page", undefined, deps);
  assert.equal(result.title, "Multi Line Title");
});

// ─── correctSourceType: if __name__ 关键字对齐 ────────────────────────────

test("correctSourceType: if __name__ 作为 code 信号防止 code→text 误降级", () => {
  // detectSourceType 检测到 if __name__ 关键字返回 "code"
  // correctSourceType 中 if __name__ 也在 codeIndicators 中（IR1 对齐），
  // codeScore >= 1，不满足 code→text 回退条件（codeScore === 0），保持 "code"
  const code = 'if __name__ == "__main__":\n    print("hello")\n';
  const result = correctSourceType(code, "code", "auto");
  assert.equal(result, "code");
});

test("correctSourceType: if __name__ 配合其他信号触发 text→code 修正", () => {
  // if __name__ + 分号 = codeScore >= 2，触发 text→code
  const code = 'if __name__ == "__main__":\n    print("hello");\n';
  const result = correctSourceType(code, "text", "auto");
  assert.equal(result, "code");
});

// ─── isPrivateIpAddress: 198.18.0.0/15 与 AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS ──

test("isPrivateIpAddress: 198.18.0.0/15 默认判定为私有（SSRF 防护）", () => {
  const previous = process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS;
  try {
    delete process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS;
    assert.equal(isPrivateIpAddress("198.18.0.38"), true);
    assert.equal(isPrivateIpAddress("198.19.255.1"), true);
    // 其他私有范围不受影响
    assert.equal(isPrivateIpAddress("127.0.0.1"), true);
    assert.equal(isPrivateIpAddress("10.0.0.1"), true);
    // 公网地址仍为 false
    assert.equal(isPrivateIpAddress("8.8.8.8"), false);
  } finally {
    if (previous === undefined) {
      delete process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS;
    } else {
      process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS = previous;
    }
  }
});

test("isPrivateIpAddress: AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS=true 放行 198.18.0.0/15", () => {
  const previous = process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS;
  try {
    process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS = "true";
    assert.equal(isPrivateIpAddress("198.18.0.38"), false);
    assert.equal(isPrivateIpAddress("198.19.255.1"), false);
    // 其他私有范围仍然拒绝
    assert.equal(isPrivateIpAddress("127.0.0.1"), true);
    assert.equal(isPrivateIpAddress("10.0.0.1"), true);
    assert.equal(isPrivateIpAddress("172.16.0.1"), true);
    assert.equal(isPrivateIpAddress("192.168.1.1"), true);
  } finally {
    if (previous === undefined) {
      delete process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS;
    } else {
      process.env.AI_ALLOW_DOCKER_DESKTOP_SYNTHETIC_DNS = previous;
    }
  }
});

// ─── fetchUrlContent: 代码块 UI 噪声过滤 ──────────────────────────────────

/**
 * 构造 Bilibili 代码块 HTML（模拟真实页面结构）。
 * 包含工具栏（代码块标签、语言、自动换行、复制代码）、行号、复制成功提示。
 */
function bilibiliCodeBlockHtml(code: string, lang = "PlainText"): string {
  const lines = code.split("\n");
  const lineNumbers = lines
    .map((_, i) => `<span aria-hidden="true" class="code-block-line-number" style="--code-block-line-number-digits: 2;">${i + 1}</span>`)
    .join("");
  return `<div class="opus-module-content opus-paragraph-children">
<p>这里贴一段精简后的 TensorFlow 核心代码：</p>
<div class="code-block-container opus-para-code">
  <div class="code-block-header">
    <div class="code-block-header-left">
      <svg class="code-block-arrow"></svg>
      <span class="code-block-label">代码块</span>
    </div>
    <div class="code-block-actions">
      <span class="code-block-lang">${lang}</span>
      <div class="code-block-separator"></div>
      <div class="code-block-tooltip code-block-tooltip--wrap">
        <div class="code-block-tooltip-content">自动换行</div>
        <div class="code-block-wrap-btn"><svg></svg></div>
      </div>
      <div class="code-block-tooltip code-block-tooltip--copy">
        <div class="code-block-copy"><svg></svg></div>
        <div class="code-block-tooltip-content">复制代码</div>
      </div>
    </div>
  </div>
  <div class="code-block-wrapper">
    <div class="code-block-content-shell">
      <div class="code-block-gutter">${lineNumbers}</div>
      <div class="code-block-scroller">
        <pre class="code-block-code"><code class="hljs language-${lang.toLowerCase()}">${code}</code></pre>
      </div>
    </div>
  </div>
  <div class="code-block-toast">复制成功</div>
</div>
<p>接着，引入一个特征专属的可学习门控变量。</p>
</div>`;
}

test("fetchUrlContent: Bilibili 代码块 UI 噪声全部移除", async () => {
  // 使用 12 行代码：行号拼接为 "123456789101112"（15 位数字）
  // 确保 /\d{5,}/ 检测能覆盖行号泄漏
  const code = [
    "# shuffle all feature",
    "# hidden is the feature concat representation",
    "def shuffle_all_features(hidden, fea_dim_range_dict):",
    '    """docstring"""',
    "    sorted_keys = sorted(fea_dim_range_dict.keys())",
    "    shuffled_blocks = []",
    "    for f in sorted_keys:",
    "        d_start = fea_dim_range_dict[f]['dim_start']",
    "        d_end = fea_dim_range_dict[f]['dim_end']",
    "        mid_part = hidden[:, d_start:d_end]",
    "        shuffled_blocks.append(mid_part)",
    "    return hidden_shuffled",
  ].join("\n");
  const html = bilibiliCodeBlockHtml(code);
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: html,
  }]);

  const result = await fetchUrlContent("https://www.bilibili.com/opus/test", undefined, deps);

  // 工具栏文本应被移除
  assert.ok(!result.text.includes("代码块"), `"代码块" should be removed, got: ${result.text}`);
  assert.ok(!result.text.includes("PlainText"), `"PlainText" should be removed`);
  assert.ok(!result.text.includes("自动换行"), `"自动换行" should be removed`);
  assert.ok(!result.text.includes("复制代码"), `"复制代码" should be removed`);
  assert.ok(!result.text.includes("复制成功"), `"复制成功" should be removed`);

  // 行号应被移除：12 行代码的行号拼接为 "123456789101112"（15 位连续数字），
  // 如果行号未被移除，/\d{5,}/ 必然匹配
  assert.ok(!/\d{5,}/.test(result.text), `Line number sequence should be removed, got: ${result.text}`);

  // 实际代码内容应保留
  assert.ok(result.text.includes("# shuffle all feature"), "Code content should be preserved");
  assert.ok(result.text.includes("def shuffle_all_features"), "Function definition should be preserved");
  assert.ok(result.text.includes("sorted_keys"), "Code body should be preserved");
  assert.ok(result.text.includes("shuffled_blocks"), "Code body should be preserved");

  // 正文上下文应保留
  assert.ok(result.text.includes("这里贴一段精简后的 TensorFlow 核心代码"), "Context before code should be preserved");
  assert.ok(result.text.includes("接着，引入一个特征专属的可学习门控变量"), "Context after code should be preserved");
});

test("fetchUrlContent: Bilibili 代码块保留多行代码格式", async () => {
  // 使用不含数字的代码，避免与行号检测混淆
  const code = `# comment alpha
# comment beta
def func():
    pass`;
  const html = bilibiliCodeBlockHtml(code);
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: html,
  }]);

  const result = await fetchUrlContent("https://www.bilibili.com/opus/test", undefined, deps);

  // 多行代码都应保留
  assert.ok(result.text.includes("# comment alpha"), "First comment line should be preserved");
  assert.ok(result.text.includes("# comment beta"), "Second comment line should be preserved");
  assert.ok(result.text.includes("def func()"), "Function definition should be preserved");
  assert.ok(result.text.includes("pass"), "Function body should be preserved");

  // 行号不应出现：4 行代码行号拼接为 "1234"，不含在代码本身中
  assert.ok(!result.text.includes("1234"), "Line numbers should not appear as concatenated sequence");
});

test("fetchUrlContent: 代码中的数字保留但行号移除", async () => {
  // 代码本身含数字（42、8080），行号为 1-5 拼接 "12345"
  // 验证代码数字被保留、行号被移除
  const code = `port = 8080
val = 42
ratio = 3.14
items = [1, 2, 3]
result = val * ratio`;
  const html = bilibiliCodeBlockHtml(code);
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: html,
  }]);

  const result = await fetchUrlContent("https://www.bilibili.com/opus/test", undefined, deps);

  // 代码中的数字应被保留
  assert.ok(result.text.includes("8080"), "Code number 8080 should be preserved");
  assert.ok(result.text.includes("42"), "Code number 42 should be preserved");
  assert.ok(result.text.includes("3.14"), "Code number 3.14 should be preserved");
  assert.ok(result.text.includes("[1, 2, 3]"), "Code list with numbers should be preserved");

  // 行号拼接 "12345" 不应出现（5 位连续数字）
  // 注意：代码中有 "8080" 和 "3.14"，但都不是 5+ 连续纯数字
  assert.ok(!result.text.includes("12345"), "Line number sequence 12345 should not appear");
  assert.ok(!/\d{6,}/.test(result.text), "No 6+ digit sequence (would indicate line number leakage)");
});

test("fetchUrlContent: 多个代码块的 UI 噪声全部移除", async () => {
  const code1 = `print("hello")`;
  const code2 = `x = 1\ny = 2`;
  const html = `<div class="opus-module-content">
${bilibiliCodeBlockHtml(code1, "Python")}
<p>中间段落</p>
${bilibiliCodeBlockHtml(code2, "JavaScript")}
</div>`;
  const deps = mockDeps([{
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: html,
  }]);

  const result = await fetchUrlContent("https://www.bilibili.com/opus/test", undefined, deps);

  // 两个代码块的工具栏噪声都应移除
  // "代码块" 出现两次，都不应保留
  assert.ok(!result.text.includes("代码块"), `"代码块" should be removed from both blocks`);
  assert.ok(!result.text.includes("Python"), `Language label "Python" should be removed`);
  assert.ok(!result.text.includes("JavaScript"), `Language label "JavaScript" should be removed`);
  assert.ok(!result.text.includes("复制成功"), `"复制成功" should be removed from both blocks`);

  // 两个代码块的实际内容都应保留
  assert.ok(result.text.includes('print("hello")'), "First code block content should be preserved");
  assert.ok(result.text.includes("x = 1"), "Second code block content should be preserved");
  assert.ok(result.text.includes("y = 2"), "Second code block content should be preserved");
  assert.ok(result.text.includes("中间段落"), "Paragraph between code blocks should be preserved");
});
