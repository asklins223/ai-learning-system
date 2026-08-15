// 调试：真实调用 generateMemoryCandidates + upsertMemory（用后即删）。
import postgres from "postgres";

const CONN = "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
const sql = postgres(CONN, { max: 2 });
const { withWorkspaceTransaction } = await import("../db/client.ts");
const { generateMemoryCandidates } = await import("../modules/companion-conversation/proactive-generator.ts");
const { upsertMemory } = await import("../modules/companion-conversation/memory-service.ts");

const workspaceId = "8e5f7dab-79ae-4708-8bf1-f8765603dd92";
const userId = "9c58b119-785b-4f08-acea-8c812f73b891";

const generated = await generateMemoryCandidates({
  outcome: "demonstrated",
  trustOutcome: "demonstrated",
  keyPointClaim: "Earth's orbital period is 365 days",
  scheduleImpact: "none",
});
console.log("GENERATED:", JSON.stringify(generated));

if (generated) {
  try {
    await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
      upsertMemory(tx, { workspaceId, userId }, {
        kind: "learning_context",
        content: generated.learningContext,
        sourceEventId: "run.completed:debug-probe",
        candidate: true,
      }),
    );
    console.log("UPSERT OK");
  } catch (err) {
    console.log("UPSERT FAILED:", err instanceof Error ? err.message.slice(0, 300) : err);
  }
}
await sql.end({ timeout: 2 });
