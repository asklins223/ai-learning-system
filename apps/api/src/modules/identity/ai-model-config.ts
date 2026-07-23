import { eq } from "drizzle-orm";
import {
  aiCredentialHint,
  encryptAiCredential,
  validateAiCredentialEncryptionKey,
} from "@ailearn/shared/ai-credentials";
import { db } from "../../db/client.ts";
import { userAIModelConfigs } from "../../db/schema/identity.ts";

export const PERSONAL_AI_PROVIDERS = ["mock", "dashscope", "openai_compatible"] as const;
export type PersonalAIProvider = (typeof PERSONAL_AI_PROVIDERS)[number];

export interface PersonalAIModelConfigInput {
  provider: PersonalAIProvider;
  baseUrl?: string | null;
  model?: string | null;
  apiKey?: string;
}

export interface PersonalAIModelConfigView {
  configured: boolean;
  provider: PersonalAIProvider | null;
  baseUrl: string | null;
  model: string | null;
  apiKeyHint: string | null;
  updatedAt: Date | null;
  encryptionReady: boolean;
  fallbackProvider: string;
}

export class AIModelConfigError extends Error {
  constructor(message: string, public readonly statusCode: 400 | 503 = 400) {
    super(message);
    this.name = "AIModelConfigError";
  }
}

function encryptionReady(): boolean {
  try {
    validateAiCredentialEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

export function normalizePersonalAIModel(value: string | null | undefined): string {
  const model = value?.trim() ?? "";
  if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new AIModelConfigError("model is required and must be at most 200 printable characters");
  }
  return model;
}

/**
 * Personal endpoints are intentionally public HTTPS only. The Worker repeats
 * DNS/IP validation immediately before connecting to OpenAI-compatible hosts.
 */
export function normalizePersonalAIBaseUrl(
  provider: Exclude<PersonalAIProvider, "mock">,
  value: string | null | undefined,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value?.trim() ?? "");
  } catch {
    throw new AIModelConfigError("baseUrl must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw new AIModelConfigError("personal AI endpoints must use HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AIModelConfigError("baseUrl cannot contain credentials, query parameters, or fragments");
  }
  const hostname = parsed.hostname.replace(/\.$/, "").toLowerCase();
  if (
    !hostname || hostname === "localhost" || hostname.endsWith(".local") ||
    hostname.endsWith(".internal") || /^\d+(?:\.\d+){3}$/.test(hostname) || hostname.includes(":")
  ) {
    throw new AIModelConfigError("baseUrl must use a public DNS hostname");
  }
  if (provider === "dashscope" && !/^dashscope(?:-[a-z0-9]+)?\.aliyuncs\.com$/.test(hostname)) {
    throw new AIModelConfigError("DashScope personal endpoints must use an official aliyuncs.com hostname");
  }
  parsed.hostname = hostname;
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

/** A saved bearer credential may never be silently forwarded to a new origin. */
export function hasSamePersonalAIEndpointOrigin(
  previousBaseUrl: string | null | undefined,
  nextBaseUrl: string,
): boolean {
  if (!previousBaseUrl) return false;
  try {
    return new URL(previousBaseUrl).origin === new URL(nextBaseUrl).origin;
  } catch {
    return false;
  }
}

export async function getPersonalAIModelConfig(userId: string): Promise<PersonalAIModelConfigView> {
  const row = await db.query.userAIModelConfigs.findFirst({
    where: eq(userAIModelConfigs.userId, userId),
  });
  return {
    // Legacy `mock` rows represented a local override. The UI now treats
    // system-default as the absence of a personal override.
    configured: Boolean(row && row.provider !== "mock"),
    provider: (row?.provider as PersonalAIProvider | undefined) ?? null,
    baseUrl: row?.baseUrl ?? null,
    model: row?.model ?? null,
    apiKeyHint: row?.apiKeyHint ?? null,
    updatedAt: row?.updatedAt ?? null,
    encryptionReady: encryptionReady(),
    fallbackProvider: (process.env.AI_PROVIDER_CARD ?? "mock").toLowerCase(),
  };
}

export async function savePersonalAIModelConfig(
  userId: string,
  input: PersonalAIModelConfigInput,
): Promise<PersonalAIModelConfigView> {
  if (input.provider === "mock") {
    await db.delete(userAIModelConfigs).where(eq(userAIModelConfigs.userId, userId));
    return getPersonalAIModelConfig(userId);
  }

  const now = new Date();
  const existing = await db.query.userAIModelConfigs.findFirst({
    where: eq(userAIModelConfigs.userId, userId),
  });

  let baseUrl: string | null = null;
  let model: string | null = null;
  let apiKeyEncrypted: string | null = null;
  let apiKeyHintValue: string | null = null;

  baseUrl = normalizePersonalAIBaseUrl(input.provider, input.baseUrl);
  model = normalizePersonalAIModel(input.model);
  const apiKey = input.apiKey?.trim();
  if (apiKey) {
    if (apiKey.length < 8 || apiKey.length > 4096) {
      throw new AIModelConfigError("apiKey must be between 8 and 4096 characters");
    }
    try {
      apiKeyEncrypted = encryptAiCredential(apiKey, userId);
    } catch (error) {
      throw new AIModelConfigError(
        error instanceof Error ? error.message : "AI credential encryption is unavailable",
        503,
      );
    }
    apiKeyHintValue = aiCredentialHint(apiKey);
  } else {
    // A saved key may only be reused for the same provider and HTTPS origin.
    // Otherwise a URL edit could silently forward the credential elsewhere.
    const canReuse = existing?.provider === input.provider &&
      hasSamePersonalAIEndpointOrigin(existing.baseUrl, baseUrl);
    apiKeyEncrypted = canReuse ? existing.apiKeyEncrypted : null;
    apiKeyHintValue = canReuse ? existing.apiKeyHint : null;
    if (!apiKeyEncrypted || !apiKeyHintValue) {
      throw new AIModelConfigError(
        "apiKey is required when configuring an external provider or changing the endpoint origin",
      );
    }
  }

  await db
    .insert(userAIModelConfigs)
    .values({
      userId,
      provider: input.provider,
      baseUrl,
      model,
      apiKeyEncrypted,
      apiKeyHint: apiKeyHintValue,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userAIModelConfigs.userId,
      set: {
        provider: input.provider,
        baseUrl,
        model,
        apiKeyEncrypted,
        apiKeyHint: apiKeyHintValue,
        updatedAt: now,
      },
    });
  return getPersonalAIModelConfig(userId);
}

export async function deletePersonalAIModelConfig(userId: string): Promise<void> {
  await db.delete(userAIModelConfigs).where(eq(userAIModelConfigs.userId, userId));
}
