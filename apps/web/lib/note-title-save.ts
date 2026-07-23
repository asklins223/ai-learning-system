export function normalizeNoteTitle(title: string): string {
  return title.trim() || "无标题笔记";
}

interface ReconcileSavedTitleInput {
  latestTitle: string;
  savedTitle: string;
  requestEditRevision: number;
  currentEditRevision: number;
  preservePendingEdit?: boolean;
}

interface ReconciledSavedTitle {
  nextTitle: string;
  isDirty: boolean;
}

/**
 * Rebase a completed title save onto edits made while its request was in flight.
 *
 * When the user did not touch the title, the server response remains authoritative
 * (including an auto-generated title). Otherwise, keep the latest input until a
 * following save persists it against the new server title.
 */
export function reconcileSavedNoteTitle({
  latestTitle,
  savedTitle,
  requestEditRevision,
  currentEditRevision,
  preservePendingEdit = false,
}: ReconcileSavedTitleInput): ReconciledSavedTitle {
  if (!preservePendingEdit && requestEditRevision === currentEditRevision) {
    return { nextTitle: savedTitle, isDirty: false };
  }

  const isDirty = normalizeNoteTitle(latestTitle) !== savedTitle;
  return {
    nextTitle: isDirty ? latestTitle : savedTitle,
    isDirty,
  };
}
