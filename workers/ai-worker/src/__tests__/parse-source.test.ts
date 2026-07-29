/**
 * parse-source.ts 单元测试
 *
 * 覆盖 canAdvanceSourceParse, createPinnedLookup, fetchUrlContent
 * （fetchUrlContent 通过依赖注入实现无网络测试）
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canAdvanceSourceParse,
  createPinnedLookup,
  fetchUrlContent,
  type PinnedAddress,
  type FetchUrlDependencies,
} from "../handlers/parse-source.ts";

// ─── canAdvanceSourceParse ───────────────────────────────────────────────

test("canAdvanceSourceParse: archived 状态返回 false", () => {
  assert.equal(canAdvanceSourceParse("archived"), false);
});

test("canAdvanceSourceParse: ready 状态返回 true", () => {
  assert.equal(canAdvanceSourceParse("ready"), true);
});

test("canAdvanceSourceParse: processing 状态返回 true", () => {
  assert.equal(canAdvanceSourceParse("processing"), true);
});

test("canAdvanceSourceParse: pending 状态返回 true", () => {
  assert.equal(canAdvanceSourceParse("pending"), true);
});

test("canAdvanceSourceParse: 空字符串返回 true", () => {
  assert.equal(canAdvanceSourceParse(""), true);
});

// ─── createPinnedLookup ─────────────────────────────────────────────────

test("createPinnedLookup: 返回一个函数", () => {
  const lookup = createPinnedLookup({ address: "1.2.3.4", family: 4 });
  assert.equal(typeof lookup, "function");
});

test("createPinnedLookup: 回调返回固定的 address 和 family", (_t) => {
  const pinned: PinnedAddress = { address: "93.184.216.34", family: 4 };
  const lookup = createPinnedLookup(pinned);
  lookup("example.com", {}, (err, address, family) => {
    assert.equal(err, null);
    assert.equal(address, "93.184.216.34");
    assert.equal(family, 4);
  });
});

test("createPinnedLookup: IPv6 地址正确返回", (_t) => {
  const pinned: PinnedAddress = { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 };
  const lookup = createPinnedLookup(pinned);
  lookup("example.com", {}, (err, address, family) => {
    assert.equal(err, null);
    assert.equal(address, "2606:2800:220:1:248:1893:25c8:1946");
    assert.equal(family, 6);
  });
});

// ─── fetchUrlContent ────────────────────────────────────────────────────

function mockDependencies(
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

test("fetchUrlContent: 200 纯文本成功返回", async () => {
  const deps = mockDependencies([{
    status: 200,
    statusText: "OK",
    contentType: "text/plain",
    body: "Hello, World!",
  }]);

  const result = await fetchUrlContent("https://example.com/test.txt", undefined, deps);
  assert.equal(result.text, "Hello, World!");
});

test("fetchUrlContent: 200 markdown 成功返回", async () => {
  const deps = mockDependencies([{
    status: 200,
    statusText: "OK",
    contentType: "text/markdown",
    body: "# Title\n\nContent here.",
  }]);

  const result = await fetchUrlContent("https://example.com/test.md", undefined, deps);
  assert.equal(result.text, "# Title\n\nContent here.");
});

test("fetchUrlContent: 200 HTML 内容被提取为纯文本", async () => {
  const deps = mockDependencies([{
    status: 200,
    statusText: "OK",
    contentType: "text/html; charset=utf-8",
    body: "<html><body><h1>Title</h1><p>Content</p></body></html>",
  }]);

  const result = await fetchUrlContent("https://example.com/page.html", undefined, deps);
  assert.ok(result.text.includes("Title"));
  assert.ok(result.text.includes("Content"));
  assert.ok(!result.text.includes("<html>"));
});

test("fetchUrlContent: 301 重定向后跟随", async () => {
  const deps = mockDependencies([
    {
      status: 301,
      statusText: "Moved Permanently",
      location: "https://example.com/final.txt",
      contentType: "text/plain",
      body: "",
    },
    {
      status: 200,
      statusText: "OK",
      contentType: "text/plain",
      body: "Redirected content",
    },
  ]);

  const result = await fetchUrlContent("https://example.com/old.txt", undefined, deps);
  assert.equal(result.text, "Redirected content");
});

test("fetchUrlContent: 302 重定向后跟随", async () => {
  const deps = mockDependencies([
    {
      status: 302,
      statusText: "Found",
      location: "/new-path.txt",
      contentType: "text/plain",
      body: "",
    },
    {
      status: 200,
      statusText: "OK",
      contentType: "text/plain",
      body: "Found content",
    },
  ]);

  const result = await fetchUrlContent("https://example.com/old.txt", undefined, deps);
  assert.equal(result.text, "Found content");
});

test("fetchUrlContent: 404 抛出 HTTP 错误", async () => {
  const deps = mockDependencies([{
    status: 404,
    statusText: "Not Found",
    contentType: "text/plain",
    body: "Not Found",
  }]);

  await assert.rejects(
    fetchUrlContent("https://example.com/missing.txt", undefined, deps),
    /HTTP 404/,
  );
});

test("fetchUrlContent: 500 抛出 HTTP 错误", async () => {
  const deps = mockDependencies([{
    status: 500,
    statusText: "Internal Server Error",
    contentType: "text/plain",
    body: "Server Error",
  }]);

  await assert.rejects(
    fetchUrlContent("https://example.com/error.txt", undefined, deps),
    /HTTP 500/,
  );
});

test("fetchUrlContent: 不支持的协议抛错", async () => {
  const deps = mockDependencies([{
    status: 200,
    statusText: "OK",
    contentType: "text/plain",
    body: "content",
  }]);

  await assert.rejects(
    fetchUrlContent("ftp://example.com/test.txt", undefined, deps),
    /unsupported protocol/,
  );
});

test("fetchUrlContent: file 协议抛错", async () => {
  const deps = mockDependencies([{
    status: 200,
    statusText: "OK",
    contentType: "text/plain",
    body: "content",
  }]);

  await assert.rejects(
    fetchUrlContent("file:///etc/passwd", undefined, deps),
    /unsupported protocol/,
  );
});

test("fetchUrlContent: URL 含用户名密码抛错", async () => {
  const deps = mockDependencies([{
    status: 200,
    statusText: "OK",
    contentType: "text/plain",
    body: "content",
  }]);

  await assert.rejects(
    fetchUrlContent("https://user:pass@example.com/test.txt", undefined, deps),
    /credentials/i,
  );
});

test("fetchUrlContent: 重定向到不支持的协议抛错", async () => {
  const deps = mockDependencies([
    {
      status: 301,
      statusText: "Moved Permanently",
      location: "ftp://example.com/final.txt",
      contentType: "text/plain",
      body: "",
    },
  ]);

  await assert.rejects(
    fetchUrlContent("https://example.com/old.txt", undefined, deps),
    /unsupported protocol/,
  );
});

test("fetchUrlContent: resolveAddress 抛错时传播", async () => {
  const deps: FetchUrlDependencies = {
    resolveAddress: async () => {
      throw new Error("blocked: private/internal host (localhost)");
    },
    request: async () => ({
      status: 200,
      statusText: "OK",
      contentType: "text/plain",
      body: Buffer.from(""),
    }),
  };

  await assert.rejects(
    fetchUrlContent("https://localhost/test.txt", undefined, deps),
    /blocked/,
  );
});

test("fetchUrlContent: request 抛错时传播", async () => {
  const deps: FetchUrlDependencies = {
    resolveAddress: async () => ({ address: "93.184.216.34", family: 4 }),
    request: async () => {
      throw new Error("connection refused");
    },
  };

  await assert.rejects(
    fetchUrlContent("https://example.com/test.txt", undefined, deps),
    /connection refused/,
  );
});

test("fetchUrlContent: 多次重定向后成功", async () => {
  const deps = mockDependencies([
    { status: 301, statusText: "Moved", location: "/step2", contentType: "text/plain", body: "" },
    { status: 302, statusText: "Found", location: "/step3", contentType: "text/plain", body: "" },
    { status: 200, statusText: "OK", contentType: "text/plain", body: "Final content" },
  ]);

  const result = await fetchUrlContent("https://example.com/start", undefined, deps);
  assert.equal(result.text, "Final content");
});
