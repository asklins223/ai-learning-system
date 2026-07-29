/**
 * Privacy-safe operational error projection.
 *
 * Error messages and stacks can contain SQL parameters, prompts, questions,
 * answers, source URLs, provider responses, or credentials.  They must never
 * be copied into logs, telemetry, audit rows, or jobs.last_error.
 *
 * This module deliberately keeps only a coarse category, a bounded error
 * class name, and an optional machine-readable code.
 */

export type OperationalErrorCategory =
  | "aborted"
  | "timeout"
  | "database"
  | "provider"
  | "authentication"
  | "billing"
  | "configuration"
  | "validation"
  | "not_found"
  | "unknown";

export interface SanitizedOperationalError {
  category: OperationalErrorCategory;
  name: string;
  code: string | null;
}

const SAFE_ERROR_PREFIX = "operational_error";
const SAFE_ERROR_MESSAGE_PATTERN =
  /^operational_error:(aborted|timeout|database|provider|authentication|billing|configuration|validation|not_found|unknown):([A-Za-z][A-Za-z0-9_.-]{0,63})(?::([A-Za-z0-9_.-]{1,40}))?$/;
const SAFE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;

function rawMessage(value: unknown): string {
  if (value instanceof Error) {
    const cause = "cause" in value ? rawMessage(value.cause) : "";
    return `${value.name} ${value.message} ${cause}`.slice(0, 8_192);
  }
  if (typeof value === "string") return value.slice(0, 8_192);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [
      typeof record.name === "string" ? record.name : "",
      typeof record.message === "string" ? record.message : "",
      typeof record.code === "string" ? record.code : "",
      "cause" in record ? rawMessage(record.cause) : "",
    ].join(" ").slice(0, 8_192);
  }
  return "";
}

function safeName(value: unknown): string {
  const candidate = value instanceof Error
    ? value.name
    : value && typeof value === "object" && typeof (value as Record<string, unknown>).name === "string"
      ? String((value as Record<string, unknown>).name)
      : "Error";
  return SAFE_NAME_PATTERN.test(candidate) ? candidate : "Error";
}

function safeCode(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>).code;
  if (typeof candidate !== "string" && typeof candidate !== "number") return null;
  const normalized = String(candidate);
  return SAFE_CODE_PATTERN.test(normalized) ? normalized : null;
}

function categorize(message: string): OperationalErrorCategory {
  const normalized = message.toLowerCase();
  if (/\b(abort|aborted|aborterror|lease lost|lease expired)\b/.test(normalized)) {
    return "aborted";
  }
  if (/\b(timeout|timed out|deadline|etimedout)\b/.test(normalized)) {
    return "timeout";
  }
  if (/\b(postgres|postgreserror|drizzle|database|sqlstate|failed query|deadlock|constraint)\b/.test(normalized)) {
    return "database";
  }
  if (/\b(unauthorized|unauthenticated|authentication|invalid api key|forbidden|permission denied|401|403)\b/.test(normalized)) {
    return "authentication";
  }
  if (/\b(overdue|billing|payment|required quota|insufficient quota|credit balance|402)\b/.test(normalized)) {
    return "billing";
  }
  if (/\b(configuration|config|missing env|not configured|unsupported provider|consent not signed)\b/.test(normalized)) {
    return "configuration";
  }
  if (/\b(validation|schema|invalid|malformed|parse|contract violation)\b/.test(normalized)) {
    return "validation";
  }
  if (/\b(not found|missing resource|404)\b/.test(normalized)) {
    return "not_found";
  }
  if (/\b(provider|dashscope|openai|model|fetch|network|socket|econn|http)\b/.test(normalized)) {
    return "provider";
  }
  return "unknown";
}

export function sanitizeOperationalError(value: unknown): SanitizedOperationalError {
  if (typeof value === "string") {
    const alreadySafe = SAFE_ERROR_MESSAGE_PATTERN.exec(value);
    if (alreadySafe) {
      return {
        category: alreadySafe[1] as OperationalErrorCategory,
        name: alreadySafe[2],
        code: alreadySafe[3] ?? null,
      };
    }
  }

  return {
    category: categorize(rawMessage(value)),
    name: safeName(value),
    code: safeCode(value),
  };
}

/**
 * Stable, idempotent representation suitable for persistence.
 */
export function safeErrorMessage(value: unknown): string {
  if (typeof value === "string" && SAFE_ERROR_MESSAGE_PATTERN.test(value)) {
    return value;
  }
  const error = sanitizeOperationalError(value);
  const code = error.code ? `:${error.code}` : "";
  return `${SAFE_ERROR_PREFIX}:${error.category}:${error.name}${code}`;
}

/**
 * Pino serializer for every top-level error-shaped field.
 */
export function safeErrorSerializer(value: unknown): SanitizedOperationalError {
  return sanitizeOperationalError(value);
}
