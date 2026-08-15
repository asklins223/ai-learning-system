import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL ?? "postgres://ailearn_api:ailearn_dev@localhost:5432/ailearn", { max: 1 });
const ws = "11111111-1111-4111-8111-111111111111";
const uid = "22222222-2222-4222-8222-222222222222";
try {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    const taskId = crypto.randomUUID();
    // 先建 run + task 供 FK
    await tx`INSERT INTO learning_runs (id, workspace_id, user_id, origin, return_target, key_point_id, target_fingerprint, goal, phase) VALUES (${crypto.randomUUID()}, ${ws}, ${uid}, '{}', '{}', '33333333-3333-4333-8333-333333333333', 'fp', 'stabilize', 'active')`;
    await tx`INSERT INTO learning_tasks (id, run_id, workspace_id, user_id, sequence, intent, prompt, target_summary) SELECT ${taskId}, id, workspace_id, user_id, 1, 'explain', 'p', 's' FROM learning_runs WHERE workspace_id = ${ws} LIMIT 1`;
    await tx`INSERT INTO learning_task_variants (id, task_id, workspace_id, user_id, purpose, template_trust_ceiling, estimated_active_seconds, interaction, public_payload_hash, input_schema_hash, disclosure_profile_hash, alternatives, revision, status) VALUES (${crypto.randomUUID()}, ${taskId}, ${ws}, ${uid}, 'formal', 'mastery_eligible', 60, '{"kind":"text_response","maxChars":2000}', 'ph', 'ih', 'dh', '[]', 1, 'active')`;
    console.log("variant insert ok");
  });
} catch (err) {
  console.log("DETAIL:", (err as { detail?: string }).detail);
  console.log("MESSAGE:", (err as Error).message);
}
await sql.end({ timeout: 2 });
