/**
 * 评测脚本的 provider 解析（`v2-recall-judge` / 其他离线 LLM 判据共用）。
 *
 * 为什么需要它：评测脚本此前**硬编码** `opencode_go` + `muse-spark-1.3-contributor`。
 * 该套餐用量耗尽后（HTTP 429）整套离线判据直接失效——但**线上管线并不用这个
 * provider**：`card_generation` 经 task-router 映射到 `agent_turn` capability，
 * 由 `config/ai-platforms.json` 解析（当前为 tokenrhythm）。
 *
 * 因此评测脚本必须**跟随管线同一份平台配置**解析 provider，而不是各自写死：
 * 这样"评测用的模型"与"线上生成用的模型"不会漂移，prviders 换绑也不需要改代码。
 *
 * 覆盖顺序：
 *   1. `EVAL_PROVIDER` / `EVAL_MODEL` / `EVAL_BASE_URL` / `EVAL_API_KEY` 显式覆盖；
 *   2. `config/ai-platforms.json` 的 `agent_turn`（= 管线实际用的模型）；
 *   3. 抛错（不静默回退 mock——评测用 mock 分数没有意义）。
 */

import { readFileSync } from "node:fs";
import { createProvider, type AIProvider } from "../lib/ai-provider.ts";
import { resolveSystemPlatform } from "@ailearn/shared/platform-config-node";

/** 从仓库 .env 读取凭据（评测脚本在宿主运行，拿不到容器里的环境变量）。 */
export function loadEnvKey(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const fromFile = readDotEnv()[name];
  return fromFile;
}

/**
 * 把仓库 `.env` 里**尚未设置**的变量注入 process.env。
 *
 * 为什么必须做：`resolveSystemPlatform` 走的是 `config/ai-platforms.json` 的
 * `${VAR}` 引用，它从 process.env 解析。评测脚本在**宿主**运行（不是容器），
 * 环境里没有这些 key —— 不注入就会得到"key 未设置 → capability 不可用"，
 * 即使 `.env` 里明明配好了。
 *
 * 只填补缺失项，不覆盖已有的环境变量（显式传参优先）。
 */
function hydrateEnvFromDotEnv(): void {
  for (const [key, value] of Object.entries(readDotEnv())) {
    if (process.env[key] === undefined && value.length > 0) process.env[key] = value;
  }
}

let dotEnvCache: Record<string, string> | null = null;

function readDotEnv(): Record<string, string> {
  if (dotEnvCache) return dotEnvCache;
  const out: Record<string, string> = {};
  try {
    const env = readFileSync(".env", "utf8");
    for (const line of env.split("\n")) {
      if (/^\s*#/.test(line)) continue;
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // 读不到就是空表，由调用方给出清晰错误。
  }
  dotEnvCache = out;
  return out;
}

export interface EvalProviderInfo {
  provider: AIProvider;
  /** 用于在评测产物中记录"这份分数是哪个模型给的"。 */
  label: string;
}

export function resolveEvalProvider(): EvalProviderInfo {
  hydrateEnvFromDotEnv();
  const forcedProvider = process.env.EVAL_PROVIDER;
  const forcedModel = process.env.EVAL_MODEL;
  const forcedBaseUrl = process.env.EVAL_BASE_URL;
  const forcedKey = process.env.EVAL_API_KEY;

  if (forcedProvider) {
    const apiKey = forcedKey ?? loadEnvKey(envKeyNameForPlatform(forcedProvider));
    if (!apiKey) throw new Error(`EVAL_PROVIDER=${forcedProvider} 但找不到对应 API key（EVAL_API_KEY 未设置）`);
    return {
      provider: createProvider(forcedProvider, { apiKey, baseUrl: forcedBaseUrl, model: forcedModel }),
      label: `${forcedProvider}/${forcedModel ?? "(default model)"} (EVAL_PROVIDER 覆盖)`,
    };
  }

  // 跟随管线：card_generation → agent_turn capability。
  const platform = resolveSystemPlatform("agent_turn");
  if (!platform) {
    throw new Error(
      "agent_turn capability 未解析到可用平台（config/ai-platforms.json 缺配置或 key 未设置）。"
      + "评测需要真实 LLM：请配置 TOKENRHYTHM_API_KEY，或用 EVAL_PROVIDER/EVAL_MODEL/EVAL_API_KEY 显式指定。",
    );
  }
  const model = forcedModel ?? platform.model;
  return {
    provider: createProvider(platform.type, {
      apiKey: platform.apiKey,
      baseUrl: platform.baseUrl,
      model,
      options: platform.options,
    }),
    label: `${platform.type}/${model ?? "(default model)"}`,
  };
}

/** 平台 name → 环境变量名（仅用于 EVAL_PROVIDER 覆盖路径）。 */
function envKeyNameForPlatform(platformName: string): string {
  return `${platformName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}
