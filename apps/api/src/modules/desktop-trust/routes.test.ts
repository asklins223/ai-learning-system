import assert from "node:assert/strict";
import test from "node:test";
import {
  createDesktopTrustChallengeResponse,
  readDesktopTrustConfig,
  resolveApiBindHost,
  trustSignatureMessage,
} from "./routes.ts";

const encodedSecret = Buffer.alloc(32, 7).toString("base64url");
const env = {
  AILEARN_DESKTOP_PAIRING_KEY_ID: "dev-key-1",
  AILEARN_DESKTOP_PAIRING_SECRET: encodedSecret,
  AILEARN_DOMAIN_SCHEMA_REVISION: "domain-v2-test",
} satisfies NodeJS.ProcessEnv;

const request = {
  version: 1 as const,
  nonce: Buffer.alloc(32, 3).toString("base64url"),
  ipcContractVersion: "desktop-ipc-v1" as const,
  pairingKeyId: "dev-key-1",
};

test("desktop trust config requires a base64url secret with at least 32 bytes", () => {
  assert.deepEqual(readDesktopTrustConfig({}), { ok: false, reason: "missing" });
  assert.deepEqual(
    readDesktopTrustConfig({ ...env, AILEARN_DESKTOP_PAIRING_SECRET: "not base64!" }),
    { ok: false, reason: "invalid" },
  );
  const parsed = readDesktopTrustConfig(env);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.config.pairingSecret.length, 32);
});

test("bind host is loopback unless container wildcard is explicit", () => {
  assert.equal(resolveApiBindHost({}), "127.0.0.1");
  assert.throws(() => resolveApiBindHost({ API_BIND_ADDRESS: "0.0.0.0" }));
  assert.equal(
    resolveApiBindHost({
      API_BIND_ADDRESS: "0.0.0.0",
      AILEARN_CONTAINER_MODE: "true",
      AILEARN_ALLOW_CONTAINER_WILDCARD: "true",
    }),
    "0.0.0.0",
  );
});

test("trust response signs the exact nonce text and carries no credential", () => {
  const parsed = readDesktopTrustConfig(env);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const response = createDesktopTrustChallengeResponse(request, parsed.config, "instance-1");
  assert.equal(response.nonce, request.nonce);
  assert.equal(response.serviceId, "ailearn-api");
  assert.equal(response.signature.length, 64);
  assert.equal(
    trustSignatureMessage(response),
    [
      "ailearn-local-api-trust-v1",
      request.nonce,
      "ailearn-api",
      "desktop-ipc-v1",
      "domain-v2-test",
      "dev-key-1",
      "instance-1",
    ].join("\n"),
  );
  assert.equal("token" in response, false);
  assert.throws(() => createDesktopTrustChallengeResponse({ ...request, pairingKeyId: "other" }, parsed.config, "instance-1"));
});
