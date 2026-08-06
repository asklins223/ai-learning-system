/** 诊断:worker provider 链最小真实调用(定位 P1 真实 E2E 失败根因) */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "./src/lib/ai-provider.ts"; // 副作用:注册全部 provider 工厂
import { buildCapabilityBundle } from "./src/lib/capability-bundle.ts";
import { resolveAIGovernanceContext } from "./src/lib/governance.ts";
import { AgentRuntime } from "./src/agent/runtime.ts";

const envText = readFileSync(resolve(process.cwd(), ".env"), "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const WORKSPACE_ID = "20000000-0000-4000-8000-000000000031";
const USER_ID = "10000000-0000-4000-8000-000000000031";

async function main() {
  const govCtx = await resolveAIGovernanceContext(WORKSPACE_ID, USER_ID);
  console.log("govCtx providerName:", govCtx.providerName, "model:", govCtx.providerModel);
  const bundle = await buildCapabilityBundle(govCtx);
  if (!bundle) throw new Error("buildCapabilityBundle returned null");
  console.log("bundle.capability:", bundle.capability.providerId, bundle.capability.modelId);

  const runtime = new AgentRuntime({
    bundle,
    toolMode: bundle.capability.toolMode,
    contextWindowTokens: bundle.capability.contextWindowTokens,
    maxInputTokens: bundle.capability.maxInputTokens,
    maxOutputTokens: bundle.capability.maxOutputTokens,
    reservedOutputTokens: bundle.capability.reservedOutputTokens,
  });

  const result = await runtime.executeTurn(
    {
      role: "generation_supervisor",
      systemPrompt: "你是一个学习卡生成助手。",
      messages: [{ role: "user", content: "请回复:ok" }],
      tools: [],
      maxTokens: 50,
      temperature: 0.3,
    },
    { runId: "diag-run", agentUnitId: "diag-unit", turnNo: 1, attemptNo: 1, role: "generation_supervisor" },
  );
  console.log("executeTurn result:", JSON.stringify({
    finishReason: result.finishReason,
    content: result.content?.slice(0, 80),
    toolCalls: result.toolCalls,
    usage: result.usage,
  }));
}

main().catch((err) => {
  console.error("DIAG FAILED:", err);
  process.exit(1);
});
