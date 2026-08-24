import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  DESKTOP_API_SERVICE_ID,
  DESKTOP_IPC_CONTRACT_VERSION,
  desktopTrustChallengeRequestSchema,
  desktopTrustChallengeResponseSchema,
  desktopTrustSignatureMessage,
  nonEmptyStringSchema,
  type DesktopTrustChallengeRequestV1,
  type DesktopTrustChallengeResponseV1,
} from "@ailearn/shared/desktop-ipc-contracts";

const TRUST_SECRET_ENV = "AILEARN_DESKTOP_PAIRING_SECRET";
const TRUST_KEY_ID_ENV = "AILEARN_DESKTOP_PAIRING_KEY_ID";
const DOMAIN_REVISION_ENV = "AILEARN_DOMAIN_SCHEMA_REVISION";

export type DesktopTrustConfig = {
  pairingKeyId: string;
  pairingSecret: Buffer;
  domainSchemaRevision: string;
};

export type DesktopTrustConfigResult =
  | { ok: true; config: DesktopTrustConfig }
  | { ok: false; reason: "missing" | "invalid" };

export function readDesktopTrustConfig(
  env: NodeJS.ProcessEnv = process.env,
): DesktopTrustConfigResult {
  const pairingKeyId = env[TRUST_KEY_ID_ENV]?.trim();
  const encodedSecret = env[TRUST_SECRET_ENV]?.trim();
  const domainSchemaRevision = env[DOMAIN_REVISION_ENV]?.trim();

  if (!pairingKeyId || !encodedSecret || !domainSchemaRevision) {
    return { ok: false, reason: "missing" };
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(pairingKeyId)) {
    return { ok: false, reason: "invalid" };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(encodedSecret)) {
    return { ok: false, reason: "invalid" };
  }

  const pairingSecret = Buffer.from(encodedSecret, "base64url");
  if (
    pairingSecret.length < 32 ||
    pairingSecret.toString("base64url") !== encodedSecret ||
    !nonEmptyStringSchema.safeParse(domainSchemaRevision).success
  ) {
    return { ok: false, reason: "invalid" };
  }

  return {
    ok: true,
    config: { pairingKeyId, pairingSecret, domainSchemaRevision },
  };
}

export function resolveApiBindHost(env: NodeJS.ProcessEnv = process.env): "127.0.0.1" | "0.0.0.0" {
  const configured = env.API_BIND_ADDRESS?.trim() || "127.0.0.1";
  if (configured === "127.0.0.1") return configured;
  if (
    configured === "0.0.0.0" &&
    env.AILEARN_CONTAINER_MODE?.trim().toLowerCase() === "true" &&
    env.AILEARN_ALLOW_CONTAINER_WILDCARD?.trim().toLowerCase() === "true"
  ) {
    return configured;
  }
  throw new Error(
    "API_BIND_ADDRESS must be literal 127.0.0.1 outside an explicitly opted-in container listener",
  );
}

export const trustSignatureMessage = desktopTrustSignatureMessage;

export function createDesktopTrustChallengeResponse(
  request: DesktopTrustChallengeRequestV1,
  config: DesktopTrustConfig,
  instanceId: string,
): DesktopTrustChallengeResponseV1 {
  desktopTrustChallengeRequestSchema.parse(request);
  if (request.pairingKeyId !== config.pairingKeyId) {
    throw new Error("pairing key id mismatch");
  }

  const unsigned = {
    version: 1 as const,
    nonce: request.nonce,
    serviceId: DESKTOP_API_SERVICE_ID,
    ipcContractVersion: DESKTOP_IPC_CONTRACT_VERSION,
    domainSchemaRevision: config.domainSchemaRevision,
    pairingKeyId: config.pairingKeyId,
    instanceId,
    algorithm: "HMAC-SHA256" as const,
  };
  const signature = createHmac("sha256", config.pairingSecret)
    .update(trustSignatureMessage(unsigned), "ascii")
    .digest("hex");
  return desktopTrustChallengeResponseSchema.parse({ ...unsigned, signature });
}

const processInstanceId = randomUUID();

export async function desktopTrustRoutes(app: FastifyInstance): Promise<void> {
  app.post("/_ailearn/desktop/trust/v1/challenge", async (request, reply) => {
    const parsed = desktopTrustChallengeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    const configResult = readDesktopTrustConfig();
    if (!configResult.ok) {
      return reply.code(503).send({ error: "desktop_trust_unavailable" });
    }

    if (parsed.data.pairingKeyId !== configResult.config.pairingKeyId) {
      return reply.code(401).send({ error: "untrusted_service" });
    }

    return reply
      .header("Cache-Control", "no-store")
      .send(createDesktopTrustChallengeResponse(parsed.data, configResult.config, processInstanceId));
  });
}
