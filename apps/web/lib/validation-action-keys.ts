export type ActionKeyStore = Map<string, string>;

/**
 * Keep one idempotency key for an action until a response is known to have
 * succeeded (or failed definitively). This lets a UI retry replay an action
 * whose successful response was lost in transit.
 */
export function getOrCreateActionKey(
  store: ActionKeyStore,
  slot: string,
  prefix: string,
  createId: () => string = () => crypto.randomUUID(),
): string {
  const existing = store.get(slot);
  if (existing) return existing;

  const key = `${prefix}-${createId()}`;
  store.set(slot, key);
  return key;
}

export function clearActionKey(store: ActionKeyStore, slot: string): void {
  store.delete(slot);
}
