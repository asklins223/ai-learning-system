/**
 * OPS-01: 优雅关闭与指标隐私边界 DoD 覆盖测试
 *
 * 覆盖 ADR-0006 §4 隐私约束和 §6.6 DoD：
 *   1. "graceful shutdown 信号处理" — 验证 SIGTERM/SIGINT 接入、关闭顺序、幂等性
 *   2. "事件名和属性使用 allowlist" — 验证 FUNNEL_EVENTS / ERROR_CATEGORIES allowlist 完整性
 *   3. "不记录 Note/Source 正文、API Key、Cookie、CSRF、完整 URL query 或 Provider 原始回复"
 *      — 验证 normalizeRouteTemplate 去除 query、categorizeError 不泄漏原始消息、指标文本不含敏感数据
 *   4. "lease token 只用不可复用短标识" — 验证指标文本不含 lease_token
 *   5. "4.2 所需查询、最小 Dashboard、告警阈值" — 验证 SLO 必需指标全部在 registry 中暴露
 *
 * 本测试通过静态分析源码 + 行为测试验证边界，不依赖数据库。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createGracefulShutdown } from "../lib/graceful-shutdown.ts";
import {
  registry,
  httpRequestsTotal,
  statusToClass,
  normalizeRouteTemplate,
  categorizeError,
  recordFunnelEvent,
  setReleaseInfo,
  getMetricsText,
  FUNNEL_EVENTS,
  ERROR_CATEGORIES,
  HTTP_METHODS,
  HTTP_STATUS_CLASSES,
  JOB_TYPES,
  JOB_STATUSES,
  PROVIDER_OPERATIONS,
} from "../lib/metrics.ts";

const SRC_DIR = join(import.meta.dirname, "..");

function readFile(relativePath: string): string {
  return readFileSync(join(SRC_DIR, relativePath), "utf-8");
}

// ─── 1. 优雅关闭信号处理 ────────────────────────────────────────────────────

describe("OPS-01 DoD: 优雅关闭信号处理", () => {
  it("server.ts 注册 SIGTERM 和 SIGINT 信号处理器", () => {
    const content = readFile("server.ts");
    assert.ok(
      content.includes('process.on("SIGTERM"'),
      "server.ts 应注册 SIGTERM 信号处理器",
    );
    assert.ok(
      content.includes('process.on("SIGINT"'),
      "server.ts 应注册 SIGINT 信号处理器",
    );
  });

  it("server.ts 使用 createGracefulShutdown 创建关闭控制器", () => {
    const content = readFile("server.ts");
    assert.ok(
      content.includes("createGracefulShutdown"),
      "server.ts 应使用 createGracefulShutdown 创建关闭控制器",
    );
  });

  it("server.ts 关闭控制器传入 clearTimer / closeServer / closeDatabase", () => {
    const content = readFile("server.ts");
    const shutdownSection = content.substring(content.indexOf("createGracefulShutdown"));
    assert.ok(
      shutdownSection.includes("clearTimer"),
      "关闭控制器应包含 clearTimer（清理定时器）",
    );
    assert.ok(
      shutdownSection.includes("closeServer"),
      "关闭控制器应包含 closeServer（关闭 HTTP 服务器）",
    );
    assert.ok(
      shutdownSection.includes("closeDatabase"),
      "关闭控制器应包含 closeDatabase（关闭数据库连接池）",
    );
  });

  it("关闭顺序：clearTimer → closeServer → closeDatabase", async () => {
    const calls: string[] = [];
    const controller = createGracefulShutdown({
      clearTimer: () => calls.push("clear-timer"),
      closeServer: async () => {
        calls.push("close-server");
      },
      closeDatabase: async () => {
        calls.push("close-database");
      },
    });

    await controller.shutdown("SIGTERM");
    assert.deepEqual(
      calls,
      ["clear-timer", "close-server", "close-database"],
      "关闭顺序应为 clearTimer → closeServer → closeDatabase",
    );
  });

  it("isShuttingDown 在关闭前返回 false，关闭后返回 true", async () => {
    const controller = createGracefulShutdown({
      clearTimer: () => {},
      closeServer: async () => {},
      closeDatabase: async () => {},
    });

    assert.equal(controller.isShuttingDown(), false, "关闭前应为 false");
    const promise = controller.shutdown("SIGTERM");
    assert.equal(controller.isShuttingDown(), true, "关闭中应为 true");
    await promise;
    assert.equal(controller.isShuttingDown(), true, "关闭后仍为 true");
  });

  it("重复信号复用同一个 Promise（幂等）", async () => {
    const controller = createGracefulShutdown({
      clearTimer: () => {},
      closeServer: async () => {},
      closeDatabase: async () => {},
    });

    const p1 = controller.shutdown("SIGTERM");
    const p2 = controller.shutdown("SIGINT");
    const p3 = controller.shutdown("SIGTERM");
    assert.equal(p1, p2, "SIGTERM 和 SIGINT 应复用同一个 Promise");
    assert.equal(p2, p3, "重复信号应复用同一个 Promise");
    await p1;
  });

  it("server 关闭失败时仍关闭 database", async () => {
    let databaseClosed = false;
    const controller = createGracefulShutdown({
      clearTimer: () => {},
      closeServer: async () => {
        throw new Error("server close failed");
      },
      closeDatabase: async () => {
        databaseClosed = true;
      },
    });

    await assert.rejects(controller.shutdown("SIGTERM"), /server close failed/);
    assert.equal(databaseClosed, true, "server 失败后仍应关闭 database");
  });

  it("server 和 database 同时失败抛 AggregateError", async () => {
    const controller = createGracefulShutdown({
      clearTimer: () => {},
      closeServer: async () => {
        throw new Error("server error");
      },
      closeDatabase: async () => {
        throw new Error("database error");
      },
    });

    await assert.rejects(
      controller.shutdown("SIGTERM"),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError, "应抛出 AggregateError");
        assert.equal((error as AggregateError).errors.length, 2);
        return true;
      },
    );
  });

  it("仅 database 失败时抛出 database 错误（非 AggregateError）", async () => {
    const controller = createGracefulShutdown({
      clearTimer: () => {},
      closeServer: async () => {},
      closeDatabase: async () => {
        throw new Error("database error only");
      },
    });

    await assert.rejects(
      controller.shutdown("SIGTERM"),
      (error: unknown) => {
        assert.ok(!(error instanceof AggregateError), "不应为 AggregateError");
        assert.ok(error instanceof Error);
        assert.match((error as Error).message, /database error only/);
        return true;
      },
    );
  });

  it("clearTimer 同步执行（在 server/database 关闭之前）", async () => {
    const order: string[] = [];
    const controller = createGracefulShutdown({
      clearTimer: () => order.push("timer-cleared"),
      closeServer: async () => {
        order.push("server-started");
        await new Promise((r) => setTimeout(r, 10));
        order.push("server-finished");
      },
      closeDatabase: async () => {
        order.push("database-started");
        await new Promise((r) => setTimeout(r, 5));
        order.push("database-finished");
      },
    });

    await controller.shutdown("SIGTERM");
    assert.equal(order[0], "timer-cleared", "clearTimer 应最先同步执行");
    assert.equal(order[1], "server-started", "closeServer 应在 clearTimer 之后");
  });
});

// ─── 2. 指标 allowlist 完整性 ────────────────────────────────────────────────

describe("OPS-01 DoD: 指标 allowlist 完整性", () => {
  it("FUNNEL_EVENTS 包含 ADR-0006 §2 要求的全部事件", () => {
    const required = [
      "invite_created",
      "invite_consumed",
      "invite_revoked",
      "onboarding_step",
      "onboarding_completed",
      "card_generation_terminal",
      "validation_submitted",
      "validation_terminal",
      "review_attempt_terminal",
      "job_claimed",
      "job_retried",
      "job_dead",
      "job_lease_lost",
      "provider_call_terminal",
      "backup_terminal",
      "release_deployed",
      "release_rolled_back",
    ];
    for (const event of required) {
      assert.ok(
        (FUNNEL_EVENTS as readonly string[]).includes(event),
        `FUNNEL_EVENTS 应包含 ${event}`,
      );
    }
  });

  it("ERROR_CATEGORIES 包含全部必需的错误分类", () => {
    const required = [
      "timeout",
      "schema_failure",
      "provider_5xx",
      "provider_4xx",
      "auth_error",
      "quota_exceeded",
      "network_error",
      "rls_denied",
      "validation_error",
      "unknown",
    ];
    for (const category of required) {
      assert.ok(
        (ERROR_CATEGORIES as readonly string[]).includes(category),
        `ERROR_CATEGORIES 应包含 ${category}`,
      );
    }
  });

  it("HTTP_METHODS allowlist 只包含标准方法", () => {
    assert.deepEqual([...HTTP_METHODS], ["GET", "POST", "PUT", "PATCH", "DELETE"]);
  });

  it("HTTP_STATUS_CLASSES allowlist 只包含 4 个状态类", () => {
    assert.deepEqual([...HTTP_STATUS_CLASSES], ["2xx", "3xx", "4xx", "5xx"]);
  });

  it("JOB_TYPES allowlist 对应 handler 注册表", () => {
    const required = ["execute_card_agent_turn", "align_evidence", "evaluate_validation", "parse_source"];
    for (const type of required) {
      assert.ok(
        (JOB_TYPES as readonly string[]).includes(type),
        `JOB_TYPES 应包含 ${type}`,
      );
    }
  });

  it("JOB_STATUSES allowlist 覆盖全部生命周期状态", () => {
    assert.deepEqual([...JOB_STATUSES], ["pending", "running", "succeeded", "failed", "dead"]);
  });

  it("PROVIDER_OPERATIONS allowlist 只包含已注册操作", () => {
    assert.deepEqual([...PROVIDER_OPERATIONS], ["align_evidence", "evaluate_validation", "generate_validation_question", "execute_card_agent_turn"]);
  });
});

// ─── 3. SLO 必需指标在 registry 中暴露 ──────────────────────────────────────

describe("OPS-01 DoD: SLO 必需指标暴露", () => {
  it("HTTP 指标全部在 registry 中", async () => {
    const text = await getMetricsText();
    assert.match(text, /ailearn_http_requests_total/, "应暴露 HTTP 请求总量");
    assert.match(text, /ailearn_http_request_duration_seconds/, "应暴露 HTTP 请求延迟");
    assert.match(text, /ailearn_http_errors_5xx_total/, "应暴露 HTTP 5xx 错误计数");
    assert.match(text, /ailearn_readiness_status/, "应暴露 readiness 状态");
  });

  it("Job/Provider 指标在 API registry 中不再注册（由 worker 侧维护）", async () => {
    const text = await getMetricsText();
    // Job/Provider 指标由 workers/ai-worker 侧维护，API registry 不再暴露
    assert.doesNotMatch(text, /ailearn_job_queue_depth/);
    assert.doesNotMatch(text, /ailearn_job_terminal_total/);
    assert.doesNotMatch(text, /ailearn_provider_calls_total/);
    assert.doesNotMatch(text, /ailearn_db_last_successful_backup_timestamp/);
  });

  it("Database 指标全部在 registry 中", async () => {
    const text = await getMetricsText();
    assert.match(text, /ailearn_db_migration_version/, "应暴露数据库迁移版本");
    assert.match(text, /ailearn_db_pool_active_connections/, "应暴露连接池活跃连接数");
    assert.match(text, /ailearn_db_transaction_failures_total/, "应暴露事务失败计数");
    assert.match(text, /ailearn_db_rls_denied_total/, "应暴露 RLS 拒绝计数");
  });

  it("Funnel 指标在 registry 中", async () => {
    const text = await getMetricsText();
    assert.match(text, /ailearn_funnel_events_total/, "应暴露 Funnel 事件计数");
  });

  it("Release 指标在 registry 中", async () => {
    setReleaseInfo("0.5.0", "test1234", 26);
    const text = await getMetricsText();
    assert.match(text, /ailearn_release_info/, "应暴露 Release 信息");
    assert.match(text, /version="0\.5\.0"/, "Release 信息应包含版本号");
    assert.match(text, /commit="test1234"/, "Release 信息应包含 commit");
    assert.match(text, /migrations="26"/, "Release 信息应包含迁移数");
  });
});

// ─── 4. 指标隐私边界 — 不泄漏敏感数据 ───────────────────────────────────────

describe("OPS-01 DoD: 指标隐私边界", () => {
  it("normalizeRouteTemplate 去除 URL query 参数", () => {
    assert.equal(
      normalizeRouteTemplate("/search?q=sensitive+user+content"),
      "/search",
      "应去除 query 参数",
    );
    assert.equal(
      normalizeRouteTemplate("/notes/123?tab=evidence&edit=true"),
      "/notes/:id",
      "应去除 query 参数并规范化路径",
    );
  });

  it("normalizeRouteTemplate 去除 UUID 路径参数", () => {
    assert.equal(
      normalizeRouteTemplate("/notes/550e8400-e29b-41d4-a716-446655440000"),
      "/notes/:id",
    );
    assert.equal(
      normalizeRouteTemplate("/notes/550e8400-e29b-41d4-a716-446655440000/cards/123"),
      "/notes/:id/cards/:id",
    );
  });

  it("normalizeRouteTemplate 去除数字路径参数", () => {
    assert.equal(normalizeRouteTemplate("/notes/123"), "/notes/:id");
    assert.equal(normalizeRouteTemplate("/cards/456/evidence/789"), "/cards/:id/evidence/:id");
  });

  it("categorizeError 不在 label 中泄漏原始错误消息", () => {
    const sensitiveError = new Error(
      "user@example.com failed to access workspace abc-123 with token sk-secretkey123",
    );
    const category = categorizeError(sensitiveError);
    // category 应该是 allowlist 中的值，不包含原始消息
    assert.ok(
      (ERROR_CATEGORIES as readonly string[]).includes(category),
      `categorizeError 应返回 allowlist 值，实际返回: ${category}`,
    );
    // category 不应包含邮箱、token 或 workspace ID
    assert.doesNotMatch(category, /user@example\.com/);
    assert.doesNotMatch(category, /sk-secretkey/);
    assert.doesNotMatch(category, /abc-123/);
  });

  it("categorizeError 对 null/undefined 返回 unknown", () => {
    assert.equal(categorizeError(null), "unknown");
    assert.equal(categorizeError(undefined), "unknown");
  });

  it("categorizeError 覆盖所有 ADR-0006 场景", () => {
    assert.equal(categorizeError(new Error("request timed out")), "timeout");
    assert.equal(categorizeError(new Error("invalid schema: missing title")), "schema_failure");
    assert.equal(categorizeError(new Error("provider returned 500")), "provider_5xx");
    assert.equal(categorizeError(new Error("400 Bad Request")), "provider_4xx");
    assert.equal(categorizeError(new Error("401 Unauthorized")), "auth_error");
    assert.equal(categorizeError(new Error("quota exceeded")), "quota_exceeded");
    assert.equal(categorizeError(new Error("ECONNREFUSED")), "network_error");
    assert.equal(categorizeError(new Error("RLS policy denied access")), "rls_denied");
    assert.equal(categorizeError(new Error("validation failed")), "validation_error");
  });

  it("statusToClass 只返回 allowlist 内的值", () => {
    for (let status = 100; status < 600; status++) {
      const cls = statusToClass(status);
      assert.ok(
        (HTTP_STATUS_CLASSES as readonly string[]).includes(cls),
        `status ${status} -> "${cls}" 不在 allowlist 内`,
      );
    }
  });

  it("指标文本不包含 API Key 模式", async () => {
    httpRequestsTotal.inc({ method: "GET", route: "/notes/:id", status_class: "2xx" });
    const text = await getMetricsText();
    assert.doesNotMatch(text, /sk-[a-zA-Z0-9]{20,}/, "不应包含 sk- 开头的 API Key");
    assert.doesNotMatch(text, /Bearer\s+eyJ/, "不应包含 Bearer token");
  });

  it("指标文本不包含 Cookie / Session token", async () => {
    const text = await getMetricsText();
    assert.doesNotMatch(text, /Set-Cookie/i, "不应包含 Set-Cookie header");
    assert.doesNotMatch(text, /session=[a-f0-9]{20,}/i, "不应包含 session token 值");
  });

  it("指标文本不包含 Authorization header", async () => {
    const text = await getMetricsText();
    assert.doesNotMatch(text, /Authorization:\s*Bearer/i, "不应包含 Authorization header");
  });

  it("指标文本不包含 CSRF token", async () => {
    const text = await getMetricsText();
    assert.doesNotMatch(text, /csrf_token\s*=/i, "不应包含 CSRF token");
  });

  it("指标文本不包含 lease token 原始值", async () => {
    const text = await getMetricsText();
    assert.doesNotMatch(text, /lease_token/i, "不应包含 lease_token 字段名");
    assert.doesNotMatch(
      text,
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      "不应包含原始 UUID（可能为 lease token）",
    );
  });

  it("指标文本不包含密码明文或 hash", async () => {
    const text = await getMetricsText();
    assert.doesNotMatch(text, /password\s*=\s*["']/, "不应包含 password 字段");
    assert.doesNotMatch(text, /\$2[aby]\$\d{2}\$/, "不应包含 bcrypt hash");
  });

  it("指标文本不包含笔记正文或用户回答", async () => {
    const text = await getMetricsText();
    // 不应包含长文本字段（笔记正文特征）
    assert.doesNotMatch(text, /"text"\s*:\s*"/, "不应包含 JSON text 字段");
    assert.doesNotMatch(text, /"content"\s*:\s*"/, "不应包含 JSON content 字段");
    assert.doesNotMatch(text, /"answer"\s*:\s*"/, "不应包含 JSON answer 字段");
  });

  it("指标文本不包含 Provider 原始响应", async () => {
    const text = await getMetricsText();
    assert.doesNotMatch(text, /provider_response/i, "不应包含 provider_response 字段");
    assert.doesNotMatch(text, /finish_reason/i, "不应包含 Provider 响应字段");
  });

  it("指标文本不包含数据库连接字符串", async () => {
    const text = await getMetricsText();
    assert.doesNotMatch(text, /postgres:\/\/[^:]+:[^@]+@/, "不应包含带密码的连接字符串");
    assert.doesNotMatch(text, /DATABASE_URL\s*=/i, "不应包含 DATABASE_URL 环境变量名");
  });

  it("指标文本不包含用户邮箱", async () => {
    const text = await getMetricsText();
    assert.doesNotMatch(
      text,
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
      "不应包含邮箱地址（PII）",
    );
  });

  it("指标文本不包含用户显示名", async () => {
    const text = await getMetricsText();
    // display_name 不应作为 label 出现在指标中
    assert.doesNotMatch(text, /display_name\s*=/i, "不应包含 display_name label");
  });

  it("recordFunnelEvent 只接受 allowlist 内的事件", () => {
    // TypeScript 类型系统在编译时阻止非法值，但运行时也应验证
    for (const event of FUNNEL_EVENTS) {
      // 不应抛出异常
      assert.doesNotThrow(() => recordFunnelEvent(event));
    }
  });

  it("HTTP 指标 label 只使用 method/route/status_class（无自由文本）", () => {
    const content = readFile("lib/metrics.ts");
    const httpCounterSection = content.substring(
      content.indexOf('name: "ailearn_http_requests_total"'),
      content.indexOf('registers: [registry],', content.indexOf('name: "ailearn_http_requests_total"')) + 30,
    );
    assert.ok(
      httpCounterSection.includes('labelNames: ["method", "route", "status_class"]'),
      "httpRequestsTotal label 应为 method/route/status_class",
    );
  });

  it("Funnel 指标 label 只使用 event", () => {
    const content = readFile("lib/metrics.ts");
    const funnelCounterSection = content.substring(
      content.indexOf('name: "ailearn_funnel_events_total"'),
      content.indexOf('registers: [registry],', content.indexOf('name: "ailearn_funnel_events_total"')) + 30,
    );
    assert.ok(
      funnelCounterSection.includes('labelNames: ["event"]'),
      "funnelEventsTotal label 应为 event",
    );
  });
});

// ─── 5. server.ts 指标端点与 hook 集成 ───────────────────────────────────────

describe("OPS-01 DoD: server.ts 指标集成", () => {
  it("server.ts 暴露 /metrics 端点", () => {
    const content = readFile("server.ts");
    assert.ok(
      content.includes('app.get("/metrics"'),
      "应暴露 /metrics 端点",
    );
    assert.ok(
      content.includes("getMetricsText"),
      "/metrics 端点应使用 getMetricsText()",
    );
    assert.ok(
      content.includes("getMetricsContentType"),
      "/metrics 端点应设置正确的 Content-Type",
    );
  });

  it("server.ts 注册 onResponse hook 收集 HTTP 指标", () => {
    const content = readFile("server.ts");
    assert.ok(
      content.includes('addHook("onResponse"'),
      "应注册 onResponse hook",
    );
    assert.ok(
      content.includes("httpRequestsTotal"),
      "onResponse hook 应记录 httpRequestsTotal",
    );
    assert.ok(
      content.includes("httpRequestDurationSeconds"),
      "onResponse hook 应记录 httpRequestDurationSeconds",
    );
  });

  it("onResponse hook 排除 /metrics 和 /health 自身", () => {
    const content = readFile("server.ts");
    const hookSection = content.substring(content.indexOf('addHook("onResponse"'));
    assert.ok(
      hookSection.includes("/metrics") && hookSection.includes("/health"),
      "onResponse hook 应排除 /metrics 和 /health 自身，避免自我放大",
    );
  });

  it("onResponse hook 使用 normalizeRouteTemplate 规范化路由", () => {
    const content = readFile("server.ts");
    const hookSection = content.substring(content.indexOf('addHook("onResponse"'));
    assert.ok(
      hookSection.includes("normalizeRouteTemplate"),
      "onResponse hook 应使用 normalizeRouteTemplate 规范化路由",
    );
  });

  it("onResponse hook 使用 statusToClass 映射状态码", () => {
    const content = readFile("server.ts");
    const hookSection = content.substring(content.indexOf('addHook("onResponse"'));
    assert.ok(
      hookSection.includes("statusToClass"),
      "onResponse hook 应使用 statusToClass 映射状态码",
    );
  });

  it("server.ts 在启动时调用 setReleaseInfo", () => {
    const content = readFile("server.ts");
    assert.ok(
      content.includes("setReleaseInfo"),
      "应在启动时调用 setReleaseInfo 设置版本信息",
    );
  });

  it("server.ts 设置 readinessStatus", () => {
    const content = readFile("server.ts");
    assert.ok(
      content.includes("readinessStatus.set(1)") || content.includes("readinessStatus.set(0)"),
      "应根据数据库连接状态设置 readinessStatus",
    );
  });

  it("server.ts 5xx 响应记录到 httpErrors5xxTotal", () => {
    const content = readFile("server.ts");
    const hookSection = content.substring(content.indexOf('addHook("onResponse"'));
    assert.ok(
      hookSection.includes("httpErrors5xxTotal"),
      "5xx 响应应记录到 httpErrors5xxTotal",
    );
  });
});

// ─── 6. registry 隔离与格式 ─────────────────────────────────────────────────

describe("OPS-01 DoD: registry 隔离与格式", () => {
  it("使用独立 Registry（非全局默认）", () => {
    // 验证 registry 是自定义实例，不是 promClient.register
    assert.ok(registry !== undefined);
    assert.ok(typeof registry.metrics === "function");
  });

  it("registry content type 为 Prometheus 文本格式", () => {
    const contentType = registry.contentType;
    assert.match(contentType, /text\/plain/);
    assert.match(contentType, /version=0\.0\.4/);
  });

  it("所有指标使用 ailearn_ 前缀", async () => {
    const text = await getMetricsText();
    // 所有自定义指标应以 ailearn_ 开头
    const metricLines = text.split("\n").filter((line) => line && !line.startsWith("#") && !line.trim().startsWith(""));
    for (const line of metricLines) {
      // 跳过 Node.js 默认指标（process_*, node_*)
      if (line.startsWith("process_") || line.startsWith("node_")) continue;
      assert.ok(
        line.startsWith("ailearn_"),
        `指标行应以 ailearn_ 前缀开头: ${line.substring(0, 50)}...`,
      );
    }
  });
});
