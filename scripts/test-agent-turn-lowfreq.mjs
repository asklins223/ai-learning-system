#!/usr/bin/env node
/**
 * 低频率验证（通用）：按固定间隔发流式请求（与 ai-worker 相同 body），
 * 估算平台当前可用的实际速率上限，并测量成功请求的 TTFT/总耗时/吞吐。
 *
 * 环境变量:
 *   TEST_BASE_URL TEST_MODEL TEST_KEY_ENV TEST_THINKING TEST_MAX_TOKENS TEST_TEMPERATURE
 *   INTERVAL_MS（默认 60000） ROUNDS（默认 3）
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const BASE_URL = process.env.TEST_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
const MODEL = process.env.TEST_MODEL ?? "GLM-4.7-Flash";
const KEY_ENV = process.env.TEST_KEY_ENV ?? "BIGMODEL_API_KEY";
const THINKING = (process.env.TEST_THINKING ?? "true") === "true";
const MAX_TOKENS = process.env.TEST_MAX_TOKENS ? Number(process.env.TEST_MAX_TOKENS) : null;
const TEMPERATURE = process.env.TEST_TEMPERATURE ? Number(process.env.TEST_TEMPERATURE) : 0.2;

const API_KEY = (() => {
  const env = {};
  try {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* 回退 process.env */ }
  return env[KEY_ENV] ?? process.env[KEY_ENV];
})();
if (!API_KEY) {
  console.error(`✗ 未找到 ${KEY_ENV}（.env 或环境变量）`);
  process.exit(1);
}

const body = {
  model: MODEL,
  messages: [{ role: "user", content: "你好，请用一句话回答：你现在可用吗？" }],
  temperature: TEMPERATURE,
  stream: true,
  stream_options: { include_usage: true },
};
if (THINKING) body.enable_thinking = true;
if (MAX_TOKENS != null) body.max_tokens = MAX_TOKENS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 60000);
const ROUNDS = Number(process.env.ROUNDS ?? 3);

console.log(`测试目标: model=${MODEL} (${BASE_URL}) key=${KEY_ENV} thinking=${THINKING} max_tokens=${MAX_TOKENS ?? "(不传)"}`);

for (let i = 1; i <= ROUNDS; i++) {
  const t0 = performance.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.log(`[${i}/${ROUNDS}] ✗ HTTP ${res.status} in ${((performance.now() - t0) / 1000).toFixed(2)}s: ${text.slice(0, 160)}`);
  } else {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", first = null, content = "", usage = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const now = performance.now() - t0;
      if (first === null) first = now;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const p = t.slice(5).trim();
        if (p === "[DONE]") continue;
        try {
          const c = JSON.parse(p);
          if (c.choices?.[0]?.delta?.content) content += c.choices[0].delta.content;
          if (c.usage) usage = c.usage;
        } catch {}
      }
    }
    const total = performance.now() - t0;
    const out = usage?.completion_tokens ?? Math.round(content.length / 2);
    console.log(`[${i}/${ROUNDS}] ✓ TTFT=${(first / 1000).toFixed(2)}s 总=${(total / 1000).toFixed(2)}s 输出=${out} tok ${(out / (total / 1000)).toFixed(1)} tok/s | ${content.slice(0, 30)}…`);
  }
  if (i < ROUNDS) {
    console.log(`  等待 ${INTERVAL_MS / 1000}s 后下一次…`);
    await sleep(INTERVAL_MS);
  }
}
