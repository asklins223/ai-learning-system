import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  pendingReturnMarkerV2Schema,
  type PendingReturnMarkerV2,
} from "@ailearn/shared/learning-run-v2-contracts";
import { z } from "zod";

const subjectWorkspaceKeySchema = z.string().uuid();
const storageEntrySchema = z.strictObject({
  subjectId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  marker: pendingReturnMarkerV2Schema,
});
const storageSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(storageEntrySchema).max(64),
}).superRefine((value, context) => {
  const keys = value.entries.map((entry) => `${entry.subjectId}:${entry.workspaceId}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "duplicate subject/workspace marker" });
  }
});
type Storage = z.infer<typeof storageSchema>;

export interface PendingReturnMarkerStore {
  get(subjectId: string, workspaceId: string): Promise<PendingReturnMarkerV2 | null>;
  set(subjectId: string, workspaceId: string, marker: PendingReturnMarkerV2): Promise<void>;
  clear(subjectId: string, workspaceId: string): Promise<void>;
  clearSubject(subjectId: string): Promise<void>;
}

function key(subjectId: string, workspaceId: string): string {
  return `${subjectWorkspaceKeySchema.parse(subjectId)}:${subjectWorkspaceKeySchema.parse(workspaceId)}`;
}

export class MemoryPendingReturnMarkerStore implements PendingReturnMarkerStore {
  private readonly entries = new Map<string, PendingReturnMarkerV2>();

  snapshot(): Array<{ subjectId: string; workspaceId: string; marker: PendingReturnMarkerV2 }> {
    return [...this.entries.entries()].map(([entryKey, marker]) => {
      const [subjectId, workspaceId] = entryKey.split(":");
      return { subjectId, workspaceId, marker };
    });
  }

  async get(subjectId: string, workspaceId: string): Promise<PendingReturnMarkerV2 | null> {
    return this.entries.get(key(subjectId, workspaceId)) ?? null;
  }

  async set(subjectId: string, workspaceId: string, marker: PendingReturnMarkerV2): Promise<void> {
    this.entries.set(key(subjectId, workspaceId), pendingReturnMarkerV2Schema.parse(marker));
  }

  async clear(subjectId: string, workspaceId: string): Promise<void> {
    this.entries.delete(key(subjectId, workspaceId));
  }

  async clearSubject(subjectId: string): Promise<void> {
    const parsedSubjectId = subjectWorkspaceKeySchema.parse(subjectId);
    for (const entryKey of this.entries.keys()) {
      if (entryKey.startsWith(`${parsedSubjectId}:`)) this.entries.delete(entryKey);
    }
  }
}

/** Small, non-sensitive JSON store for restart recovery. It never stores run content. */
export class FilePendingReturnMarkerStore implements PendingReturnMarkerStore {
  private readonly memory = new MemoryPendingReturnMarkerStore();
  private loaded: Promise<void> | null = null;
  private flushQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          const raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
          const parsed = storageSchema.safeParse(raw);
          if (!parsed.success) return;
          for (const entry of parsed.data.entries) {
            await this.memory.set(entry.subjectId, entry.workspaceId, entry.marker);
          }
        } catch {
          // Missing/corrupt marker storage is equivalent to no marker: fail closed
          // at the return resolver and never resurrect unvalidated content.
        }
      })();
    }
    await this.loaded;
  }

  private flush(): Promise<void> {
    // Return-contract resolution, workspace switching and logout can mutate
    // the marker store concurrently. Queue the complete snapshot+rename so an
    // older temporary file can never win the final rename race.
    const write = this.flushQueue.then(async () => {
      const entries: Storage["entries"] = [];
      // Memory store is intentionally opaque; use an indexed read list for the
      // bounded persisted representation through its own snapshot helper.
      for (const entry of this.memory.snapshot()) entries.push(entry);
      const payload = storageSchema.parse({ version: 1, entries });
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(payload), { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    this.flushQueue = write.then(() => undefined, () => undefined);
    return write;
  }

  async get(subjectId: string, workspaceId: string): Promise<PendingReturnMarkerV2 | null> {
    await this.ensureLoaded();
    return this.memory.get(subjectId, workspaceId);
  }

  async set(subjectId: string, workspaceId: string, marker: PendingReturnMarkerV2): Promise<void> {
    await this.ensureLoaded();
    await this.memory.set(subjectId, workspaceId, marker);
    await this.flush();
  }

  async clear(subjectId: string, workspaceId: string): Promise<void> {
    await this.ensureLoaded();
    await this.memory.clear(subjectId, workspaceId);
    await this.flush();
  }

  async clearSubject(subjectId: string): Promise<void> {
    await this.ensureLoaded();
    await this.memory.clearSubject(subjectId);
    await this.flush();
  }
}
