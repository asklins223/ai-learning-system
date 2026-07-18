import { and, eq } from "drizzle-orm";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import { logger } from "./logger.ts";

/**
 * Worker-side search projection adapter.
 *
 * Keep this adapter in the worker instead of importing API application source.
 * Cross-application source imports caused TypeScript and the runtime bundler to
 * resolve a second drizzle-orm installation from apps/api/node_modules.
 */
export async function upsertSearchDocument(params: {
  workspaceId: string;
  objectType: "note" | "card" | "source" | "evidence";
  objectId: string;
  title: string | null;
  body: string | null;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  const { workspaceId, objectType, objectId, title, body, metadata } = params;

  try {
    await db
      .insert(schema.searchDocuments)
      .values({
        workspaceId,
        objectType,
        objectId,
        title: title ?? null,
        body: body ?? null,
        metadata: metadata ?? {},
        indexedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          schema.searchDocuments.workspaceId,
          schema.searchDocuments.objectType,
          schema.searchDocuments.objectId,
        ],
        set: {
          title: title ?? null,
          body: body ?? null,
          metadata: metadata ?? {},
          indexedAt: new Date(),
        },
      });
    return true;
  } catch (err) {
    logger.error(
      { err, workspaceId, objectType, objectId },
      "search index upsert failed — index may be stale, run reindex to compensate",
    );
    return false;
  }
}

export async function deleteSearchDocument(
  workspaceId: string,
  objectType: string,
  objectId: string,
): Promise<void> {
  try {
    await db
      .delete(schema.searchDocuments)
      .where(
        and(
          eq(schema.searchDocuments.workspaceId, workspaceId),
          eq(schema.searchDocuments.objectType, objectType),
          eq(schema.searchDocuments.objectId, objectId),
        ),
      );
  } catch (err) {
    logger.error(
      { err, workspaceId, objectType, objectId },
      "search index delete failed — index may have ghost document, run reindex to compensate",
    );
  }
}
