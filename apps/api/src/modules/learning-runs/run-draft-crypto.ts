/**
 * LearningTask draft 静态加密（文档 16 §12.7）。
 *
 * draft 是 user-private/workspace-scoped 的跨设备恢复数据。落库前用
 * AES-256-GCM 应用层加密（密钥 env LEARNING_DRAFT_ENC_KEY，64 位 hex）。
 * 未配置密钥时 fail closed：draft 读写不可用（409），绝不落明文。
 *
 * 存储形状：{ "enc": "<base64(iv|authTag|ciphertext)>" } 写入 payload 列。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

// 懒缓存解码后的密钥，按 env 原始值失效：env 不变时（生产热路径）避免重复
// 读 env + 正则 + Buffer.from；env 变化时（测试场景）重新解码。
let cachedRawKey: string | undefined;
let cachedKey: Buffer | null | undefined;

function loadKey(): Buffer | null {
  const raw = process.env.LEARNING_DRAFT_ENC_KEY?.trim();
  if (raw === cachedRawKey) return cachedKey ?? null;
  cachedRawKey = raw;
  if (!raw) {
    cachedKey = null;
    return null;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    // 密钥格式错误按未配置处理（fail closed），启动日志由调用方决定。
    cachedKey = null;
    return null;
  }
  cachedKey = Buffer.from(raw, "hex");
  return cachedKey;
}

export interface EncryptedDraftShape {
  enc: string;
}

export function isDraftEncryptionAvailable(): boolean {
  return loadKey() !== null;
}

/** 加密 draft payload → { enc }。密钥缺失返回 null（调用方必须 fail closed）。 */
export function encryptDraftPayload(payload: unknown): EncryptedDraftShape | null {
  const key = loadKey();
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload ?? null), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc: Buffer.concat([iv, tag, ciphertext]).toString("base64") };
}

/** 解密 draft payload。密钥缺失或密文损坏返回 null（fail closed，不抛明文）。 */
export function decryptDraftPayload(stored: unknown): unknown {
  const key = loadKey();
  if (!key) return null;
  const shape = stored as EncryptedDraftShape | null;
  if (!shape || typeof shape.enc !== "string" || shape.enc.length === 0) return null;
  try {
    const raw = Buffer.from(shape.enc, "base64");
    if (raw.length < 12 + 16 + 1) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    return null;
  }
}
