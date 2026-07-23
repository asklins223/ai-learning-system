import { eq } from "drizzle-orm";
import { decryptAiCredential } from "@ailearn/shared/ai-credentials";
import {
  resolveDashScopeTextEndpoint,
  resolveOpenAIChatCompletionsUrl,
} from "@ailearn/shared/ai-endpoints";
import {
  postJsonToPublicEndpoint,
  type PublicJsonRequester,
  type PublicJsonResponse,
} from "@ailearn/shared/public-json-http";
import { db } from "../../db/client.ts";
import { userAIModelConfigs } from "../../db/schema/identity.ts";
import {
  AIModelConfigError,
  hasSamePersonalAIEndpointOrigin,
  normalizePersonalAIBaseUrl,
  normalizePersonalAIModel,
  type PersonalAIModelConfigInput,
  type PersonalAIProvider,
} from "./ai-model-config.ts";

const DEFAULT_TEST_TIMEOUT_MS = 15_000;
const FIXED_TEST_PROMPT = "Reply with exactly the single word: OK";

export type ExternalPersonalAIProvider = Exclude<PersonalAIProvider, "mock">;
export type AIModelConnectionErrorCode =
  | "invalid_configuration"
  | "invalid_credentials"
  | "endpoint_or_model_not_found"
  | "provider_rate_limited"
  | "provider_rejected"
  | "incompatible_response"
  | "connection_failed"
  | "connection_timeout";

export interface AIModelConnectionTestResult {
  ok: true;
  provider: ExternalPersonalAIProvider;
  model: string;
  latencyMs: number;
  checkedAt: string;
}

export interface AIModelConnectionRuntime {
  provider: ExternalPersonalAIProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export class AIModelConnectionError extends Error {
  constructor(
    message: string,
    public readonly code: AIModelConnectionErrorCode,
    public readonly statusCode: 400 | 422 | 429 | 502 | 503 | 504,
    public readonly provider?: ExternalPersonalAIProvider,
    public readonly model?: string,
    public readonly durationMs?: number,
    public readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "AIModelConnectionError";
  }
}

function timeoutFromEnv(): number {
  const raw = process.env.AI_MODEL_TEST_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TEST_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 60_000) {
    throw new Error("AI_MODEL_TEST_TIMEOUT_MS must be an integer between 1000 and 60000");
  }
  return parsed;
}

function validateApiKey(value: string | undefined): string | null {
  const apiKey = value?.trim() ?? "";
  if (!apiKey) return null;
  if (apiKey.length < 8 || apiKey.length > 4096) {
    throw new AIModelConfigError("apiKey must be between 8 and 4096 characters");
  }
  return apiKey;
}

/** Build a runtime config from the current form without persisting the draft. */
export async function resolvePersonalAIConnectionRuntime(
  userId: string,
  input: PersonalAIModelConfigInput,
): Promise<AIModelConnectionRuntime> {
  if (input.provider === "mock") {
    throw new AIModelConnectionError(
      "本地 Mock 不需要测试外部连接",
      "invalid_configuration",
      400,
    );
  }

  const baseUrl = normalizePersonalAIBaseUrl(input.provider, input.baseUrl);
  const model = normalizePersonalAIModel(input.model);
  let apiKey = validateApiKey(input.apiKey);

  if (!apiKey) {
    const existing = await db.query.userAIModelConfigs.findFirst({
      where: eq(userAIModelConfigs.userId, userId),
    });
    if (
      existing?.provider !== input.provider ||
      !hasSamePersonalAIEndpointOrigin(existing.baseUrl, baseUrl) ||
      !existing.apiKeyEncrypted
    ) {
      throw new AIModelConnectionError(
        "请填写 API Key 后再测试连接；更换接口域名时不能复用已保存的 Key",
        "invalid_configuration",
        400,
        input.provider,
        model,
      );
    }
    try {
      apiKey = decryptAiCredential(existing.apiKeyEncrypted, userId);
    } catch {
      throw new AIModelConnectionError(
        "服务端无法解密已保存的 API Key，请重新填写并保存",
        "invalid_configuration",
        503,
        input.provider,
        model,
      );
    }
  }

  return { provider: input.provider, baseUrl, model, apiKey };
}

function connectionErrorForResponse(
  response: PublicJsonResponse,
  runtime: AIModelConnectionRuntime,
  durationMs: number,
): AIModelConnectionError {
  if (response.status === 401 || response.status === 403) {
    return new AIModelConnectionError(
      "API Key 无效、已过期，或没有调用该模型的权限",
      "invalid_credentials",
      422,
      runtime.provider,
      runtime.model,
      durationMs,
      response.status,
    );
  }
  if (response.status === 404) {
    return new AIModelConnectionError(
      "接口地址或模型名称不存在，请核对 Base URL 与 model id",
      "endpoint_or_model_not_found",
      422,
      runtime.provider,
      runtime.model,
      durationMs,
      response.status,
    );
  }
  if (response.status === 429) {
    return new AIModelConnectionError(
      "服务商拒绝了测试请求：请求过于频繁、余额不足或配额已用尽",
      "provider_rate_limited",
      429,
      runtime.provider,
      runtime.model,
      durationMs,
      response.status,
    );
  }
  return new AIModelConnectionError(
    `服务商拒绝了测试请求（HTTP ${response.status}），请核对接口协议、模型权限和账户状态`,
    "provider_rejected",
    502,
    runtime.provider,
    runtime.model,
    durationMs,
    response.status,
  );
}

function hasExpectedContent(body: unknown): boolean {
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  const firstChoiceContent = (value: unknown): unknown => {
    if (!Array.isArray(value)) return undefined;
    const firstChoice = asRecord(value[0]);
    const message = asRecord(firstChoice?.message);
    return message?.content;
  };

  const payload = asRecord(body);
  if (!payload) return false;
  const content = firstChoiceContent(payload.choices);
  return typeof content === "string" && Boolean(content.trim());
}

/** Send one fixed, content-free prompt and discard the provider's text response. */
export async function testAIModelRuntimeConnection(
  runtime: AIModelConnectionRuntime,
  requester: PublicJsonRequester = postJsonToPublicEndpoint,
  timeoutMs = timeoutFromEnv(),
): Promise<AIModelConnectionTestResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutError = new AIModelConnectionError(
    `连接测试超过 ${Math.ceil(timeoutMs / 1000)} 秒，请检查接口地址或网络`,
    "connection_timeout",
    504,
    runtime.provider,
    runtime.model,
  );
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);

  const dashScopeEndpoint = runtime.provider === "dashscope"
    ? resolveDashScopeTextEndpoint(runtime.baseUrl, runtime.model)
    : null;
  const endpoint = dashScopeEndpoint?.url ?? resolveOpenAIChatCompletionsUrl(runtime.baseUrl);
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${runtime.apiKey}`,
  };
  const messages = [{ role: "user", content: FIXED_TEST_PROMPT }];
  const body = { model: runtime.model, messages, temperature: 0 };

  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(timeoutError), { once: true });
    });
    const response = await Promise.race([
      requester(endpoint, headers, body, controller.signal),
      timeoutPromise,
    ]);
    const durationMs = Math.max(0, Date.now() - startedAt);
    if (response.status < 200 || response.status >= 300) {
      throw connectionErrorForResponse(response, runtime, durationMs);
    }
    if (!hasExpectedContent(response.body)) {
      throw new AIModelConnectionError(
        "接口已响应，但返回格式与所选 Provider 不兼容",
        "incompatible_response",
        502,
        runtime.provider,
        runtime.model,
        durationMs,
        response.status,
      );
    }
    return {
      ok: true,
      provider: runtime.provider,
      model: runtime.model,
      latencyMs: durationMs,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof AIModelConnectionError) throw error;
    const durationMs = Math.max(0, Date.now() - startedAt);
    if (controller.signal.aborted) {
      throw new AIModelConnectionError(
        timeoutError.message,
        "connection_timeout",
        504,
        runtime.provider,
        runtime.model,
        durationMs,
      );
    }
    throw new AIModelConnectionError(
      "无法连接模型接口，请检查公网 HTTPS 地址、DNS、证书和网络状态",
      "connection_failed",
      502,
      runtime.provider,
      runtime.model,
      durationMs,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function testPersonalAIModelConnection(
  userId: string,
  input: PersonalAIModelConfigInput,
): Promise<AIModelConnectionTestResult> {
  const runtime = await resolvePersonalAIConnectionRuntime(userId, input);
  return testAIModelRuntimeConnection(runtime);
}
