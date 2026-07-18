import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const FORMAT_VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function parseEncryptionKey(value: string | undefined): Buffer {
  const raw = value?.trim();
  if (!raw) {
    throw new Error("AI_CREDENTIAL_ENCRYPTION_KEY is required to store or use personal AI credentials");
  }

  const key = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("AI_CREDENTIAL_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters or base64");
  }
  return key;
}

function aadForUser(userId: string): Buffer {
  if (!userId.trim()) throw new Error("userId is required for AI credential encryption");
  return Buffer.from(`ailearn:user-ai-model-config:${userId}`, "utf8");
}

/** Encrypt one provider secret. The user id is authenticated but not stored in the blob. */
export function encryptAiCredential(
  plaintext: string,
  userId: string,
  encryptionKey = process.env.AI_CREDENTIAL_ENCRYPTION_KEY,
): string {
  if (!plaintext) throw new Error("AI credential cannot be empty");
  const key = parseEncryptionKey(encryptionKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aadForUser(userId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    FORMAT_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/** Decrypt one provider secret and reject copied/tampered blobs. */
export function decryptAiCredential(
  blob: string,
  userId: string,
  encryptionKey = process.env.AI_CREDENTIAL_ENCRYPTION_KEY,
): string {
  const [version, encodedIv, encodedTag, encodedCiphertext, extra] = blob.split(".");
  if (
    version !== FORMAT_VERSION || !encodedIv || !encodedTag ||
    !encodedCiphertext || extra !== undefined
  ) {
    throw new Error("unsupported AI credential ciphertext format");
  }

  const key = parseEncryptionKey(encryptionKey);
  const iv = Buffer.from(encodedIv, "base64url");
  const tag = Buffer.from(encodedTag, "base64url");
  const ciphertext = Buffer.from(encodedCiphertext, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES || ciphertext.length === 0) {
    throw new Error("invalid AI credential ciphertext");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(aadForUser(userId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (error) {
    throw new Error("AI credential could not be decrypted", { cause: error });
  }
}

export function aiCredentialHint(secret: string): string {
  const suffix = secret.slice(-4);
  return suffix ? `••••${suffix}` : "••••";
}

/** Fails fast without exposing key material; useful for readiness/configuration checks. */
export function validateAiCredentialEncryptionKey(
  encryptionKey = process.env.AI_CREDENTIAL_ENCRYPTION_KEY,
): void {
  void parseEncryptionKey(encryptionKey);
}
