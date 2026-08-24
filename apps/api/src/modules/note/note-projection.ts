import { noteDetailV1Schema, type NoteDetailV1 } from "@ailearn/shared/note-projection-contracts";
import { noteSaveReceiptV1Schema, type NoteSaveReceiptV1 } from "@ailearn/shared/note-save-contracts";

export type NoteReadProjectionSource = {
  note: {
    id: string;
    workspaceId: string;
    title: string;
    titleSource: string;
    sourceId: string | null;
    currentVersionId: string | null;
  };
  version: {
    id: string;
    noteId: string;
    versionNo: number;
    contentHash: string;
    createdAt: Date;
    updatedAt: Date;
  };
  blocks: ReadonlyArray<{
    ordinal: number;
    type: string;
    content: string;
  }>;
};

/**
 * Convert the persistence result into the shared public Note read DTO.
 * Explicit field selection is intentional: adding a private DB column must
 * not silently expand the desktop payload.
 */
export function projectNoteDetailV1(
  source: NoteReadProjectionSource,
  role: "owner" | "member",
  snapshotAt = new Date(),
): NoteDetailV1 {
  const currentVersionId = source.note.currentVersionId;
  if (!currentVersionId) throw new Error("note_current_version_missing");

  return noteDetailV1Schema.parse({
    version: 1,
    noteId: source.note.id,
    workspaceId: source.note.workspaceId,
    title: source.note.title,
    titleSource: source.note.titleSource,
    sourceId: source.note.sourceId,
    currentVersionId,
    currentVersion: {
      versionId: source.version.id,
      noteId: source.version.noteId,
      versionNo: source.version.versionNo,
      contentHash: source.version.contentHash,
      createdAt: source.version.createdAt.toISOString(),
      updatedAt: source.version.updatedAt.toISOString(),
      blocks: source.blocks.map((block) => ({
        ordinal: block.ordinal,
        type: block.type,
        content: block.content,
      })),
    },
    permissions: {
      canRead: true,
      canEdit: role === "owner",
      canSave: role === "owner",
    },
    revision: currentVersionId,
    snapshotAt: snapshotAt.toISOString(),
  });
}

export type NoteSaveReceiptSource = {
  note: {
    id: string;
    workspaceId: string;
    currentVersionId: string | null;
  };
  version: {
    id: string;
    versionNo: number;
    updatedAt: Date;
  };
};

export function projectNoteSaveReceiptV1(
  source: NoteSaveReceiptSource,
  baseVersionId: string,
  isAutosave: boolean,
): NoteSaveReceiptV1 {
  const currentVersionId = source.note.currentVersionId;
  if (!currentVersionId) throw new Error("note_current_version_missing");

  return noteSaveReceiptV1Schema.parse({
    version: 1,
    status: "committed",
    noteId: source.note.id,
    workspaceId: source.note.workspaceId,
    baseVersionId,
    versionId: source.version.id,
    currentVersionId,
    versionNo: source.version.versionNo,
    isAutosave,
    revision: currentVersionId,
    savedAt: source.version.updatedAt.toISOString(),
  });
}
