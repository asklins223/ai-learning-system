#!/usr/bin/env node
/**
 * agent_turn 平台可用性 + 延迟 + 吞吐测试（通用）
 *
 * 模拟 ai-worker openai-compatible provider 的真实调用方式，支持任意平台：
 *   - 默认: bigmodel / GLM-4.7-Flash（enable_thinking: true，不传 max_tokens）
 *   - 通过环境变量覆盖: TEST_BASE_URL TEST_MODEL TEST_KEY_ENV TEST_THINKING TEST_MAX_TOKENS TEST_TEMPERATURE
 *
 * 用法:
 *   node scripts/test-agent-turn.mjs
 *   TEST_BASE_URL=https://tokenrhythm.studio/v1 TEST_MODEL=deepseek-v4-flash-0731 \
 *     TEST_KEY_ENV=TOKENRHYTHM_API_KEY TEST_THINKING=true TEST_MAX_TOKENS=4096 \
 *     node scripts/test-agent-turn.mjs
 *
 * 输出: 非流式/流式各 3 轮，报告 TTFT、总耗时、tokens/s、429/503 等错误统计。
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const BASE_URL = process.env.TEST_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
const MODEL = process.env.TEST_MODEL ?? "GLM-4.7-Flash";
const KEY_ENV = process.env.TEST_KEY_ENV ?? "BIGMODEL_API_KEY";
const THINKING = (process.env.TEST_THINKING ?? "true") === "true";
const MAX_TOKENS = process.env.TEST_MAX_TOKENS ? Number(process.env.TEST_MAX_TOKENS) : null;
const TEMPERATURE = process.env.TEST_TEMPERATURE ? Number(process.env.TEST_TEMPERATURE) : 0.2;

// ---------- 读取 .env 中的 API key ----------
function loadEnv(path = ".env") {
  const env = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      env[m[1]] = v;
    }
  } catch {
    /* 无 .env 时回退 process.env */
  }
  return { ...env, ...process.env };
}

const API_KEY = loadEnv()[KEY_ENV];
if (!API_KEY) {
  console.error(`✗ 未找到 ${KEY_ENV}（.env 或环境变量）`);
  process.exit(1);
}

// ---------- 工具 ----------
const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 单次请求（非流式），带 429/503 退避重试。返回 { status, body, ms } */
async function callChat(messages, { stream = false, maxAttempts = 4 } = {}) {
  const body = { model: MODEL, messages, temperature: TEMPERATURE };
  if (THINKING) body.enable_thinking = true;
  if (MAX_TOKENS != null) body.max_tokens = MAX_TOKENS;
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const t0 = performance.now();
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
    });
    const ms = performance.now() - t0;
    const text = await res.text();
    if (res.status === 429 || res.status === 503) {
      last = { status: res.status, body: text, ms, attempt };
      const wait = Math.min(1000 * 2 ** attempt, 15000);
      console.log(`  ⚠ HTTP ${res.status}（第 ${attempt} 次），退避 ${wait / 1000}s 后重试…`);
      await sleep(wait);
      continue;
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, body: parsed ?? text, ms, attempt };
  }
  return last;
}

/** 流式请求：逐 chunk 计时，返回 { ttftMs, totalMs, content, usage, status, error } */
async function callChatStream(messages) {
  const body = {
    model: MODEL,
    messages,
    temperature: TEMPERATURE,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (THINKING) body.enable_thinking = true;
  if (MAX_TOKENS != null) body.max_tokens = MAX_TOKENS;
  const t0 = performance.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    return { status: res.status, error: text.slice(0, 300), totalMs: performance.now() - t0 };
  }
  if (!res.body) return { status: -1, error: "no response body", totalMs: performance.now() - t0 };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstChunkMs = null;
  let firstContentChunkMs = null;
  let content = "";
  let thinking = "";
  let usage = null;
  let totalMs = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = performance.now() - t0;
    if (firstChunkMs === null) firstChunkMs = now;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta ?? {};
        if (delta.reasoning_content) {
          thinking += delta.reasoning_content;
        }
        if (delta.content) {
          if (firstContentChunkMs === null) firstContentChunkMs = now;
          content += delta.content;
        }
        if (chunk.usage) usage = chunk.usage;
      } catch { /* 跳过无法解析的 chunk */ }
    }
  }
  totalMs = performance.now() - t0;
  return {
    status: res.status,
    ttftMs: firstChunkMs,          // 网络首 chunk 到达
    ttftContentMs: firstContentChunkMs, // 首个正文内容 chunk（不含思考）
    totalMs,
    content,
    thinking,
    usage,
  };
}

// ---------- 测试用例 ----------
const SHORT_PROMPT = "你好，请用一句话回答：你现在可用吗？";
const LONG_PROMPT = "请写一段约 300 字的中文介绍，说明什么是机会成本，并给出一个生活中的例子。";

async function runNonStream(messages, label, rounds = 3) {
  console.log(`\n━━━ 非流式: ${label} ━━━`);
  let errors = 0;
  for (let i = 1; i <= rounds; i++) {
    const r = await callChat(messages);
    if (r.status !== 200) {
      errors++;
      console.log(`  [${i}/${rounds}] ✗ HTTP ${r.status} ${typeof r.body === "string" ? r.body.slice(0, 150) : JSON.stringify(r.body?.error ?? r.body).slice(0, 150)}`);
      continue;
    }
    const u = r.body.usage ?? {};
    const tokens = (u.completion_tokens ?? 0) + (u.prompt_tokens ?? 0);
    const outTok = u.completion_tokens ?? 0;
    const tps = r.ms > 0 ? ((outTok / r.ms) * 1000).toFixed(1) : "n/a";
    console.log(
      `  [${i}/${rounds}] ✓ ${fmt(r.ms)}  | prompt=${u.prompt_tokens ?? "?"} out=${outTok} total=${tokens} | ${tps} tok/s` +
      (u.completion_tokens ? ` | 回复: ${(r.body.choices?.[0]?.message?.content ?? "").slice(0, 40).replace(/\n/g, " ")}…` : "")
    );
    await sleep(1500);
  }
  return errors;
}

async function runStream(messages, label, rounds = 3) {
  console.log(`\n━━━ 流式: ${label} ━━━`);
  let errors = 0;
  for (let i = 1; i <= rounds; i++) {
    const r = await callChatStream(messages);
    if (r.status !== 200 && r.status !== undefined) {
      errors++;
      console.log(`  [${i}/${rounds}] ✗ HTTP ${r.status} ${String(r.error).slice(0, 150)}`);
      await sleep(1500);
      continue;
    }
    if (r.error) {
      errors++;
      console.log(`  [${i}/${rounds}] ✗ ${r.error}`);
      continue;
    }
    const outTok = r.usage?.completion_tokens ?? Math.round(r.content.length / 2);
    const tps = r.totalMs > 0 ? ((outTok / r.totalMs) * 1000).toFixed(1) : "n/a";
    console.log(
      `  [${i}/${rounds}] ✓ 总耗时 ${fmt(r.totalMs)} | TTFT(首chunk) ${fmt(r.ttftMs)} | TTFT(首正文) ${fmt(r.ttftContentMs)}` +
      ` | 输出 ${outTok} tok (${r.content.length} 字符, 思考 ${r.thinking.length} 字符) | ${tps} tok/s`
    );
    await sleep(1500);
  }
  return errors;
}

// ---------- main ----------
console.log(`测试目标: model=${MODEL} (baseUrl=${BASE_URL})`);
console.log(`key=${KEY_ENV} enable_thinking=${THINKING} max_tokens=${MAX_TOKENS ?? "(不传)"} temperature=${TEMPERATURE}\n`);

const errShortNon = await runNonStream([{ role: "user", content: SHORT_PROMPT }], "短对话");
const errShortStream = await runStream([{ role: "user", content: SHORT_PROMPT }], "短对话");
const errLongStream = await runStream([{ role: "user", content: LONG_PROMPT }], "长输出(~300字)");
const errLongNon = await runNonStream([{ role: "user", content: LONG_PROMPT }], "长输出(~300字)");

const totalErrors = errShortNon + errShortStream + errLongStream + errLongNon;
console.log(`\n━━━ 汇总 ━━━`);
console.log(`请求轮次: 非流式 6 + 流式 6 = 12 | 失败: ${totalErrors}`);
console.log(totalErrors === 0 ? "✅ agent_turn (bigmodel/GLM-4.7-Flash) 可用" : `⚠ 存在 ${totalErrors} 次失败，详见上方输出`);
