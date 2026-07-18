export type JsonRecord = Record<string, unknown>;

export function asJsonRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

export function readString(record: JsonRecord | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

export function readProviderCode(value: unknown): string | number | undefined {
  const code = asJsonRecord(value)?.code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

export function readProviderErrorMessage(value: unknown): string | undefined {
  const payload = asJsonRecord(value);
  const nestedMessage = readString(asJsonRecord(payload?.error), "message");
  return nestedMessage ?? readString(payload, "message");
}

export function readChatCompletionContent(value: unknown): string | undefined {
  const choices = asJsonRecord(value)?.choices;
  if (!Array.isArray(choices)) return undefined;
  const firstChoice = asJsonRecord(choices[0]);
  return readString(asJsonRecord(firstChoice?.message), "content");
}
