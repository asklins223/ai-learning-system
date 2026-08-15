import postgres from "postgres";
const admin = postgres("postgres://ailearn:ailearn_dev@localhost:5432/ailearn", { max: 2 });
process.env.DATABASE_URL_API = "postgres://ailearn_api:ailearn_dev@localhost:5432/ailearn";
process.env.LEARNING_DRAFT_ENC_KEY = "f".repeat(64);

const ws = crypto.randomUUID();
const uid = crypto.randomUUID();
const noteId = crypto.randomUUID();
const noteVersionId = crypto.randomUUID();
const cardId = crypto.randomUUID();
const keyPointId = crypto.randomUUID();
const claim = "repro 观点";

await admin.begin(async (tx) => {
  await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${uid}, ${"r-" + uid.slice(0, 8) + "@x.test"}, 'h', 'owner')`;
  await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${ws}, 'rw', ${uid})`;
  await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws}, ${uid}, 'owner')`;
  await tx`INSERT INTO notes (id, workspace_id, title, title_source, current_version_id, created_by) VALUES (${noteId}, ${ws}, 'n', 'manual', NULL, ${uid})`;
  await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by) VALUES (${noteVersionId}, ${noteId}, ${ws}, 1, '{"blocks":[]}', 'h', ${uid})`;
  await tx`UPDATE notes SET current_version_id = ${noteVersionId} WHERE id = ${noteId}`;
  await tx`INSERT INTO learning_cards (id, note_version_id, workspace_id, status, schema_json) VALUES (${cardId}, ${noteVersionId}, ${ws}, 'active', '{"title":"c","summary":"s"}')`;
  await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text) VALUES (${keyPointId}, ${cardId}, ${ws}, 1, ${claim}, 'q')`;
});

const { withWorkspaceTransaction } = await import("./src/db/client.ts");
const { createRun } = await import("./src/modules/learning-runs/run-service.ts");

try {
  const run = await withWorkspaceTransaction({ workspaceId: ws, userId: uid }, async (tx) =>
    createRun(tx, {
      workspaceId: ws,
      userId: uid,
      request: {
        version: 1,
        origin: { kind: "card", cardId, keyPointId },
        goal: "stabilize",
        clientRequestId: "c",
        idempotencyKey: "k",
      },
    }),
  );
  console.log("OK run:", run.runId, run.phase);
} catch (err) {
  console.log("MSG:", (err as Error).message?.slice(0, 600));
  console.log("CAUSE:", JSON.stringify((err as { cause?: unknown }).cause, null, 2)?.slice(0, 1200));
}
await admin.begin(async (tx) => {
  await tx`DELETE FROM learning_runs WHERE workspace_id = ${ws}`;
  await tx`DELETE FROM card_key_points WHERE workspace_id = ${ws}`;
  await tx`DELETE FROM learning_cards WHERE workspace_id = ${ws}`;
  await tx`DELETE FROM note_versions WHERE workspace_id = ${ws}`;
  await tx`DELETE FROM notes WHERE workspace_id = ${ws}`;
  await tx`DELETE FROM workspace_members WHERE workspace_id = ${ws}`;
  await tx`DELETE FROM workspaces WHERE id = ${ws}`;
  await tx`DELETE FROM users WHERE id = ${uid}`;
});
await admin.end({ timeout: 2 });
const { closeDatabase } = await import("./src/db/client.ts");
await closeDatabase();
