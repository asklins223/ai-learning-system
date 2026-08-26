import type { GatewayErrorCode } from "@ailearn/shared/desktop-ipc-contracts";

const GATE_INVALIDATION_CODES = [
  "auth_required",
  "reauth_required",
  "stale_workspace",
  "api_unavailable",
  "api_untrusted",
  "configuration_error",
  "unsupported_contract",
] as const satisfies readonly GatewayErrorCode[];

export type GateInvalidationCode = (typeof GATE_INVALIDATION_CODES)[number];
export type GateInvalidationListener = (code: GateInvalidationCode) => void;

const listeners = new Set<GateInvalidationListener>();

export function asGateInvalidationCode(code: GatewayErrorCode): GateInvalidationCode | null {
  return (GATE_INVALIDATION_CODES as readonly GatewayErrorCode[]).includes(code)
    ? code as GateInvalidationCode
    : null;
}

export function publishGateInvalidation(code: GatewayErrorCode): void {
  const invalidation = asGateInvalidationCode(code);
  if (!invalidation) return;

  for (const listener of [...listeners]) {
    try {
      listener(invalidation);
    } catch {
      // A stale consumer must never replace the authoritative gateway error.
    }
  }
}

export function subscribeGateInvalidation(listener: GateInvalidationListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
