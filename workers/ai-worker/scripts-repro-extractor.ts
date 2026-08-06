import { toolRegistry } from "./src/agent/tool-registry.ts";
import { buildExtractorSystemPrompt } from "./src/agent/roles/supervisor-policy.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function getKey() {
  const envPath = resolve(process.cwd(), "../../.env");
  const text = readFileSync(envPath, "utf8");
  const m = text.match(/^OPENAI_COMPAT_API_KEY=(.+)$/m);
  return m?.[1]?.trim() ?? "";
}

async function main() {
  const tools = toolRegistry.getToolSchemasForRole("text_extractor");
  const system = buildExtractorSystemPrompt("text_extractor");

  const bundle = [{
    bundleId: "bundle:852680cd82416e4b0447fad10db8b6f4",
    sectionPath: ["1.1", "细胞是生物体结构和功能的基本单位"],
    evidenceUnits: [
      { refId: "ev_001", kind: "paragraph", text: "细胞是生物体结构和功能的基本单位。除病毒外，所有生物体都是由细胞构成的。细胞的多样性反映了生物界的多样性。", contextOnly: false },
      { refId: "ev_002", kind: "paragraph", text: "原核细胞没有以核膜为界限的细胞核，没有染色体，但有拟核，拟核中有环状DNA分子。原核细胞中只有核糖体一种细胞器。", contextOnly: false },
      { refId: "ev_003", kind: "paragraph", text: "真核细胞有以核膜为界限的细胞核，有染色体，有多种细胞器。", contextOnly: false },
      { refId: "ev_004", kind: "paragraph", text: "原核细胞和真核细胞的统一性体现在：都有细胞膜、细胞质、核糖体和遗传物质DNA。", contextOnly: false },
    ],
  }];

  const instructions = [
    "你收到了以下分配给你的 bundles。请仔细阅读数据，提取候选知识点，",
    "然后调用 record_extraction_decisions 记录决策，最后调用 complete_agent_task 完成任务。",
    "",
    `分配的 bundle IDs: ${JSON.stringify(bundle.map(b => b.bundleId))}`,
    `bundle 数量: ${bundle.length}`,
  ].join("\n");

  const bundleJsonStr = JSON.stringify(bundle, null, 2);
  const content = instructions + "\n\n[bundle_data]\n" + bundleJsonStr + "\n[/bundle_data]\n\n" +
    "现在请执行以下操作：\n1. 分析每个 bundle 的 evidenceUnits，识别可学习的知识点。\n" +
    "2. 调用 record_extraction_decisions，提交所有候选和/或 no-candidate 决策。\n" +
    "3. 调用 complete_agent_task 完成任务。";

  const requestBody: Record<string, unknown> = {
    model: "glm-5.2",
    messages: [
      { role: "system", content: system },
      { role: "user", content },
    ],
    tools: tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    tool_choice: "auto",
    temperature: 0.2,
    stream: false,
    enable_thinking: false,
  };

  const apiKey = getKey();
  const resp = await fetch("https://cn.morbuke.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(requestBody),
  });
  const body = await resp.json() as Record<string, unknown>;
  console.log("STATUS", resp.status);
  console.log(JSON.stringify(body, null, 2).slice(0, 5000));
}

main().catch(e => { console.error(e); process.exit(1); });
