export type CompanionCelebrationPolicyInput = Readonly<{
  masterMuted: boolean;
  temporarilyHidden: boolean;
  activeness: "quiet" | "moderate" | "active" | null;
  proactiveMuted: boolean;
  allowPlayful: boolean;
}>;

/**
 * Celebration is deliberately fail-closed. Until the server-owned companion
 * profile is known, the app must not guess that an unsolicited action or
 * voice line is welcome.
 */
export function companionCelebrationAllowed(input: CompanionCelebrationPolicyInput): boolean {
  return !input.masterMuted
    && !input.temporarilyHidden
    && input.activeness !== null
    && input.activeness !== "quiet"
    && !input.proactiveMuted
    && input.allowPlayful;
}
