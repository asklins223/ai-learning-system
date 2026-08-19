import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DomainError } from "@ailearn/shared";

export const INVITATION_TOKEN_ENTROPY_BYTES = 32;
export const INVITATION_TOKEN_LENGTH = 43;
export const INVITATION_TOKEN_HASH_LENGTH = 64;
export const INVITATION_TOKEN_HINT_LENGTH = 8;

const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INVITATION_TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const INVITATION_TOKEN_HINT_DOMAIN = "ailearn:invitation-token-hint:v1\0";

export type InvitationTokenRandomBytes = (size: number) => Uint8Array;

export type InvitationTokenErrorCode = "generation_failed" | "invalid_token";

export interface InvitationTokenStorage {
  tokenHash: string;
  tokenHint: string;
}

export class InvitationTokenError extends DomainError {
  readonly code: InvitationTokenErrorCode;

  constructor(code: InvitationTokenErrorCode) {
    super({
      name: "InvitationTokenError",
      code,
      message: code === "generation_failed" ? "invitation token generation failed" : "invalid invitation token",
      statusCode: 400,
    });
    this.code = code;
  }
}

const secureRandomBytes: InvitationTokenRandomBytes = (size) => randomBytes(size);

/**
 * Strictly accepts the canonical, unpadded base64url encoding of exactly
 * INVITATION_TOKEN_ENTROPY_BYTES bytes.
 */
export function isValidInvitationToken(value: unknown): value is string {
  if (typeof value !== "string" || !INVITATION_TOKEN_PATTERN.test(value)) return false;

  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === INVITATION_TOKEN_ENTROPY_BYTES && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

export function isValidInvitationTokenHash(value: unknown): value is string {
  return typeof value === "string" && INVITATION_TOKEN_HASH_PATTERN.test(value);
}

/**
 * This is the only helper that intentionally returns the plaintext token. The
 * caller must deliver it once and persist only createInvitationTokenStorage().
 */
export function generateInvitationToken(
  rng: InvitationTokenRandomBytes = secureRandomBytes,
): string {
  let entropy: Uint8Array;
  try {
    entropy = rng(INVITATION_TOKEN_ENTROPY_BYTES);
  } catch {
    // Never propagate an injected/provider error that could contain secret data.
    throw new InvitationTokenError("generation_failed");
  }

  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== INVITATION_TOKEN_ENTROPY_BYTES) {
    throw new InvitationTokenError("generation_failed");
  }

  const token = Buffer.from(entropy).toString("base64url");
  if (!isValidInvitationToken(token)) {
    throw new InvitationTokenError("generation_failed");
  }
  return token;
}

export function hashInvitationToken(token: unknown): string {
  if (!isValidInvitationToken(token)) {
    throw new InvitationTokenError("invalid_token");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * A domain-separated, truncated digest is suitable only as a UI/audit hint.
 * It is not a credential and must never be used to accept a candidate token.
 */
export function createInvitationTokenHint(token: unknown): string {
  if (!isValidInvitationToken(token)) {
    throw new InvitationTokenError("invalid_token");
  }
  return createHash("sha256")
    .update(INVITATION_TOKEN_HINT_DOMAIN, "utf8")
    .update(token, "utf8")
    .digest("hex")
    .slice(0, INVITATION_TOKEN_HINT_LENGTH);
}

/** Returns the complete database representation without the plaintext token. */
export function createInvitationTokenStorage(token: unknown): InvitationTokenStorage {
  if (!isValidInvitationToken(token)) {
    throw new InvitationTokenError("invalid_token");
  }
  return {
    tokenHash: hashInvitationToken(token),
    tokenHint: createInvitationTokenHint(token),
  };
}

/**
 * Compares canonical fixed-length SHA-256 hashes in constant time. Invalid or
 * differently sized values fail closed before timingSafeEqual can throw.
 */
export function constantTimeInvitationTokenHashEqual(left: unknown, right: unknown): boolean {
  if (!isValidInvitationTokenHash(left) || !isValidInvitationTokenHash(right)) return false;

  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

/** Hashes a strictly formatted candidate and compares it with a stored hash. */
export function invitationTokenMatchesHash(candidateToken: unknown, storedHash: unknown): boolean {
  if (!isValidInvitationToken(candidateToken) || !isValidInvitationTokenHash(storedHash)) return false;
  return constantTimeInvitationTokenHashEqual(hashInvitationToken(candidateToken), storedHash);
}
