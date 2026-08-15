import postgres from "postgres";
const admin = postgres("postgres://ailearn:ailearn_dev@localhost:5432/ailearn", { max: 2 });
const api = postgres("postgres://ailearn_api:ailearn_dev@localhost:5432/ailearn", { max: 1 });

const ws = crypto.randomUUID();
const uid = crypto.randomUUID();
const noteId = crypto.randomUUID();
const noteVersionId = crypto.randomUUID();
const cardId = crypto.randomUUID();
const keyPointId = crypto.randomUUID();
const runId = crypto.randomUUID();
const taskId = crypto.randomUUID();

await admin.begin(async (tx) => {
  await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${uid}, ${"r2-" + uid.slice(0, 8) + "@x.test"}, 'h', 'owner')`;
  await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${ws}, 'rw2', ${uid})`;
  await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws}, ${uid}, 'owner')`;
  await tx`INSERT INTO notes (id, workspace_id, title, title_source, current_version_id, created_by) VALUES (${noteId}, ${ws}, 'n', 'manual', NULL, ${uid})`;
  await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by) VALUES (${noteVersionId}, ${noteId}, ${ws}, 1, '{"blocks":[]}', 'h', ${uid})`;
  await tx`UPDATE notes SET current_version_id = ${noteVersionId} WHERE id = ${noteId}`;
  await tx`INSERT INTO learning_cards (id, note_version_id, workspace_id, status, schema_json) VALUES (${cardId}, ${noteVersionId}, ${ws}, 'active', '{"title":"c","summary":"s"}')`;
  await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text) VALUES (${keyPointId}, ${cardId}, ${ws}, 1, 'claim', 'q')`;
});

try {
  await api.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO learning_runs (id, workspace_id, user_id, origin, return_target, key_point_id, target_fingerprint, goal, phase) VALUES (${runId}, ${ws}, ${uid}, '{"kind":"card"}', '{"kind":"card"}', ${keyPointId}, 'fp', 'stabilize', 'active')`;
    await tx`INSERT INTO learning_tasks (id, run_id, workspace_id, user_id, sequence, intent, prompt, target_summary) VALUES (${taskId}, ${runId}, ${ws}, ${uid}, 1, 'explain', 'p', 's')`;
    await tx`INSERT INTO learning_task_variants (id, task_id, workspace_id, user_id, purpose, template_trust_ceiling, estimated_active_seconds, interaction, public_payload_hash, input_schema_hash, disclosure_profile_hash, alternatives, revision, status) VALUES (${crypto.randomUUID()}, ${taskId}, ${ws}, ${uid}, 'formal', 'mastery_eligible', 60, '{"kind":"text_response","maxChars":2000}', 'ph', 'ih', 'dh', '[]', 1, 'active')`;
    console.log("variant insert ok");
  });
} catch (err) {
  console.log("DETAIL:", (err as { detail?: string }).detail);
  console.log("MESSAGE:", (err as Error).message);
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
await api.end({ timeout: 2 });
