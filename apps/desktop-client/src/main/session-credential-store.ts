import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { app, safeStorage } from "electron";
import type { SessionCredentialStore } from "./desktop-gateway";

/**
 * Persists the bearer token between launches, encrypted with Electron's
 * `safeStorage` (Keychain on macOS, DPAPI on Windows, libsecret on Linux).
 *
 * Fail-closed: when the platform cannot encrypt — Linux without a keyring is the
 * real case — `available` is false and nothing is ever written, so the session
 * stays memory-only rather than landing on disk in the clear.
 */
export function createSessionCredentialStore(): SessionCredentialStore {
  const filePath = resolve(app.getPath("userData"), "session-credential-v1.bin");
  const temporaryPath = `${filePath}.tmp`;

  let encryptionAvailable = false;
  try {
    encryptionAvailable = safeStorage.isEncryptionAvailable();
  } catch {
    encryptionAvailable = false;
  }

  return {
    available: encryptionAvailable,

    hasStored(): boolean {
      return encryptionAvailable && existsSync(filePath);
    },

    async load(): Promise<string | null> {
      if (!encryptionAvailable) return null;
      let encrypted: Buffer;
      try {
        encrypted = await readFile(filePath);
      } catch {
        return null;
      }
      try {
        const token = safeStorage.decryptString(encrypted);
        return token.trim() ? token : null;
      } catch {
        // A credential we cannot decrypt is useless and must not be retried on
        // every launch; drop it so the user simply signs in again.
        await rm(filePath, { force: true }).catch(() => undefined);
        return null;
      }
    },

    async save(token: string): Promise<void> {
      if (!encryptionAvailable) return;
      const encrypted = safeStorage.encryptString(token);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(temporaryPath, encrypted, { mode: 0o600 });
      await rename(temporaryPath, filePath);
    },

    async clear(): Promise<void> {
      await Promise.all([
        rm(filePath, { force: true }),
        rm(temporaryPath, { force: true }),
      ]).catch(() => undefined);
    },
  };
}
