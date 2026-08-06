/**
 * OPS-01: Prometheus 指标模块单元测试（ADR-0006）
 *
 * 验证指标注册、label allowlist、路由模板规范化和错误分类的正确性。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  registry,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  jobQueueDepth,
  jobTerminalTotal,
  providerCallsTotal,
  statusToClass,
  normalizeRouteTemplate,
  categorizeError,
  recordFunnelEvent,
  setReleaseInfo,
  getMetricsText,
  FUNNEL_EVENTS,
  ERROR_CATEGORIES,
} from "./metrics.ts";

test("metrics registry 暴露所有定义的指标", async () => {
  const text = await getMetricsText();
  // 验证关键指标存在
  assert.match(text, /ailearn_http_requests_total/);
  assert.match(text, /ailearn_http_request_duration_seconds/);
  assert.match(text, /ailearn_job_queue_depth/);
  assert.match(text, /ailearn_job_terminal_total/);
  assert.match(text, /ailearn_provider_calls_total/);
  assert.match(text, /ailearn_funnel_events_total/);
  assert.match(text, /ailearn_release_info/);
  assert.match(text, /ailearn_db_migration_version/);
  assert.match(text, /ailearn_db_last_successful_backup_timestamp/);
});

test("HTTP 请求计数器按 method/route/status_class 正确递增", async () => {
  const before = registry.getSingleMetric("ailearn_http_requests_total");
  assert.ok(before);

  httpRequestsTotal.inc({ method: "GET", route: "/notes/:id", status_class: "2xx" });
  httpRequestsTotal.inc({ method: "GET", route: "/notes/:id", status_class: "2xx" });
  httpRequestsTotal.inc({ method: "POST", route: "/notes", status_class: "4xx" });

  const text = await getMetricsText();
  // 应包含两条 GET /notes/:id 2xx 和一条 POST /notes 4xx
  assert.match(text, /ailearn_http_requests_total\{method="GET",route="\/notes\/:id",status_class="2xx"\} 2/);
  assert.match(text, /ailearn_http_requests_total\{method="POST",route="\/notes",status_class="4xx"\} 1/);
});

test("HTTP 延迟直方图正确记录观察值", async () => {
  httpRequestDurationSeconds.observe({ method: "GET", route: "/health" }, 0.05);
  httpRequestDurationSeconds.observe({ method: "GET", route: "/health" }, 0.15);

  const text = await getMetricsText();
  assert.match(text, /ailearn_http_request_duration_seconds_count\{method="GET",route="\/health"\} 2/);
});

test("Job 队列深度 gauge 正确设置值", async () => {
  jobQueueDepth.set({ status: "pending" }, 5);
  jobQueueDepth.set({ status: "running" }, 2);
  jobQueueDepth.set({ status: "dead" }, 1);

  const text = await getMetricsText();
  assert.match(text, /ailearn_job_queue_depth\{status="pending"\} 5/);
  assert.match(text, /ailearn_job_queue_depth\{status="running"\} 2/);
  assert.match(text, /ailearn_job_queue_depth\{status="dead"\} 1/);
});

test("Job 终态计数器按 type/status 正确递增", async () => {
  jobTerminalTotal.inc({ type: "execute_card_agent_turn", status: "succeeded" });
  jobTerminalTotal.inc({ type: "execute_card_agent_turn", status: "succeeded" });
  jobTerminalTotal.inc({ type: "parse_source", status: "dead" });

  const text = await getMetricsText();
  assert.match(text, /ailearn_job_terminal_total\{type="execute_card_agent_turn",status="succeeded"\} 2/);
  assert.match(text, /ailearn_job_terminal_total\{type="parse_source",status="dead"\} 1/);
});

test("Provider 调用计数器按 operation/status 正确递增", async () => {
  providerCallsTotal.inc({ operation: "execute_card_agent_turn", status: "success" });
  providerCallsTotal.inc({ operation: "execute_card_agent_turn", status: "error" });

  const text = await getMetricsText();
  assert.match(text, /ailearn_provider_calls_total\{operation="execute_card_agent_turn",status="success"\} 1/);
  assert.match(text, /ailearn_provider_calls_total\{operation="execute_card_agent_turn",status="error"\} 1/);
});

test("Funnel 事件通过 recordFunnelEvent 正确记录", async () => {
  recordFunnelEvent("invite_created");
  recordFunnelEvent("invite_consumed");
  recordFunnelEvent("card_generation_terminal");
  recordFunnelEvent("backup_terminal");

  const text = await getMetricsText();
  assert.match(text, /ailearn_funnel_events_total\{event="invite_created"\} 1/);
  assert.match(text, /ailearn_funnel_events_total\{event="invite_consumed"\} 1/);
  assert.match(text, /ailearn_funnel_events_total\{event="card_generation_terminal"\} 1/);
  assert.match(text, /ailearn_funnel_events_total\{event="backup_terminal"\} 1/);
});

test("Release 信息 gauge 正确设置 label", async () => {
  setReleaseInfo("0.5.0", "abc1234", 24);

  const text = await getMetricsText();
  assert.match(text, /ailearn_release_info\{version="0\.5\.0",commit="abc1234",migrations="24"\} 1/);
});

test("statusToClass 正确映射 HTTP 状态码到 status class", () => {
  assert.equal(statusToClass(200), "2xx");
  assert.equal(statusToClass(201), "2xx");
  assert.equal(statusToClass(301), "3xx");
  assert.equal(statusToClass(304), "3xx");
  assert.equal(statusToClass(400), "4xx");
  assert.equal(statusToClass(401), "4xx");
  assert.equal(statusToClass(403), "4xx");
  assert.equal(statusToClass(404), "4xx");
  assert.equal(statusToClass(500), "5xx");
  assert.equal(statusToClass(502), "5xx");
  assert.equal(statusToClass(503), "5xx");
});

test("normalizeRouteTemplate 将 UUID 和数字路径参数替换为 :id", () => {
  assert.equal(
    normalizeRouteTemplate("/notes/550e8400-e29b-41d4-a716-446655440000"),
    "/notes/:id",
  );
  assert.equal(
    normalizeRouteTemplate("/notes/550e8400-e29b-41d4-a716-446655440000/cards/123"),
    "/notes/:id/cards/:id",
  );
  assert.equal(normalizeRouteTemplate("/health"), "/health");
  assert.equal(normalizeRouteTemplate("/api/notes"), "/api/notes");
  assert.equal(normalizeRouteTemplate("/notes/123"), "/notes/:id");
  assert.equal(normalizeRouteTemplate("/"), "/");
  assert.equal(normalizeRouteTemplate("/notes/"), "/notes");
});

test("categorizeError 正确分类常见错误", () => {
  assert.equal(categorizeError(new Error("request timed out")), "timeout");
  assert.equal(categorizeError(new Error("operation timed out after 90s")), "timeout");
  assert.equal(categorizeError(new Error("invalid schema: missing title")), "schema_failure");
  assert.equal(categorizeError(new Error("failed to parse JSON response")), "schema_failure");
  assert.equal(categorizeError(new Error("provider returned 500")), "provider_5xx");
  assert.equal(categorizeError(new Error("HTTP 502: Bad Gateway")), "provider_5xx");
  assert.equal(categorizeError(new Error("401 Unauthorized")), "auth_error");
  assert.equal(categorizeError(new Error("quota exceeded")), "quota_exceeded");
  assert.equal(categorizeError(new Error("rate limit exceeded")), "quota_exceeded");
  assert.equal(categorizeError(new Error("ECONNREFUSED")), "network_error");
  assert.equal(categorizeError(new Error("ENOTFOUND")), "network_error");
  assert.equal(categorizeError(new Error("RLS policy denied access")), "rls_denied");
  assert.equal(categorizeError(new Error("validation failed")), "validation_error");
  assert.equal(categorizeError(new Error("400 Bad Request")), "provider_4xx");
  assert.equal(categorizeError(new Error("unknown issue")), "unknown");
  assert.equal(categorizeError(null), "unknown");
  assert.equal(categorizeError(undefined), "unknown");
});

test("FUNNEL_EVENTS allowlist 包含所有必需的事件类型", () => {
  // ADR-0006 §2 要求的事件
  const requiredEvents = [
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
  for (const event of requiredEvents) {
    assert.ok(
      (FUNNEL_EVENTS as readonly string[]).includes(event),
      `FUNNEL_EVENTS 应包含 ${event}`,
    );
  }
});

test("ERROR_CATEGORIES allowlist 包含所有必需的错误分类", () => {
  const requiredCategories = [
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
  for (const category of requiredCategories) {
    assert.ok(
      (ERROR_CATEGORIES as readonly string[]).includes(category),
      `ERROR_CATEGORIES 应包含 ${category}`,
    );
  }
});

test("registry content type 为 Prometheus 文本格式", () => {
  const contentType = registry.contentType;
  // prom-client 返回 'text/plain; version=0.0.4; charset=utf-8'
  assert.match(contentType, /text\/plain/);
  assert.match(contentType, /version=0\.0\.4/);
});

test("指标文本不包含原始 URL query 参数", async () => {
  // normalizeRouteTemplate 会去除 query 参数
  const route = normalizeRouteTemplate("/search?q=sensitive+content");
  // 路由模板不应包含 query 参数
  assert.equal(route, "/search");

  httpRequestsTotal.inc({
    method: "GET",
    route,
    status_class: "2xx",
  });

  const text = await getMetricsText();
  // 不应在指标中包含 query 参数内容
  assert.doesNotMatch(text, /sensitive\+content/);
  assert.doesNotMatch(text, /q=/);
});

test("指标文本不包含 lease token 原始值", async () => {
  // 验证 job 指标不暴露 lease token
  jobTerminalTotal.inc({ type: "execute_card_agent_turn", status: "succeeded" });

  const text = await getMetricsText();
  // 不应包含 "lease_token" 或类似敏感字段
  assert.doesNotMatch(text, /lease_token/);
});
