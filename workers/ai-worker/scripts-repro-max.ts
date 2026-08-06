import { toolRegistry } from "./src/agent/tool-registry.ts";
import { buildExtractorSystemPrompt } from "./src/agent/roles/supervisor-policy.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function getKey() {
  const text = readFileSync(resolve(process.cwd(), "../../.env"), "utf8");
  return text.match(/^OPENAI_COMPAT_API_KEY=(.+)$/m)?.[1]?.trim() ?? "";
}

const realEvidence = [
  "细胞是生命的基本结构和功能单位。原核细胞没有成形的细胞核，真核细胞有成形的细胞核。",
  "细胞膜由磷脂双分子层和蛋白质组成，具有选择透过性。膜上的载体蛋白和通道蛋白协助物质运输。",
  "主动运输是逆浓度梯度运输，需要消耗 ATP。被动运输包括自由扩散和协助扩散，不消耗能量。",
  "线粒体是细胞的能量工厂，通过有氧呼吸产生 ATP。无氧呼吸在细胞质基质中进行，产生乳酸或酒精。",
  "核糖体是蛋白质合成的场所。粗面内质网上的核糖体合成膜蛋白和分泌蛋白，游离核糖体合成胞内蛋白。",
  "高尔基体对蛋白质进行加工、分类和包装。溶酶体含有水解酶，负责细胞内消化。",
  "细胞周期分为分裂间期和分裂期。间期包括 G1 期、S 期和 G2 期。S 期进行 DNA 复制。",
  "有丝分裂分为前期、中期、后期和末期。中期染色体排列在赤道板上，后期姐妹染色单体分离。",
  "减数分裂是有性生殖生物特有的细胞分裂方式，DNA 复制一次，细胞连续分裂两次。",
  "减数第一次分裂同源染色体分离，减数第二次分裂姐妹染色单体分离。",
  "同源染色体是形态大小相同、一条来自父方一条来自母方的染色体。联会发生在减数第一次分裂前期。",
  "交叉互换发生在联会的同源染色体之间，增加遗传多样性。",
];

const bundle = [{
  bundleId: "bundle:852680cd82416e4b0447fad10db8b6f4",
  sectionPath: [],
  evidenceUnits: realEvidence.map((t, i) => ({ refId: `ev_${String(i+1).padStart(3,"0")}`, kind: "text_span", text: t, contextOnly: false })),
}];

async function call(maxTokens: number | undefined) {
  const tools = toolRegistry.getToolSchemasForRole("text_extractor");
  const system = buildExtractorSystemPrompt("text_extractor");
  const bundleJsonStr = JSON.stringify(bundle, null, 2);
  const instructions = [
    "你收到了以下分配给你的 bundles。请仔细阅读数据，提取候选知识点，",
    "然后调用 record_extraction_decisions 记录决策，最后调用 complete_agent_task 完成任务。",
    "", `分配的 bundle IDs: ${JSON.stringify(bundle.map(b => b.bundleId))}`, `bundle 数量: ${bundle.length}`,
  ].join("\n");
  const content = instructions + "\n\n[bundle_data]\n" + bundleJsonStr + "\n[/bundle_data]\n\n" +
    "现在请执行以下操作：\n1. 分析每个 bundle 的 evidenceUnits，识别可学习的知识点。\n" +
    "2. 调用 record_extraction_decisions，提交所有候选和/或 no-candidate 决策。\n" +
    "3. 调用 complete_agent_task 完成任务。";

  const requestBody: Record<string, unknown> = {
    model: "glm-5.2",
    messages: [{ role: "system", content: system }, { role: "user", content }],
    tools: tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    tool_choice: "auto", temperature: 0.3, stream: false, enable_thinking: false,
  };
  if (maxTokens !== undefined) requestBody.max_tokens = maxTokens;

  const resp = await fetch("https://cn.morbuke.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getKey()}` },
    body: JSON.stringify(requestBody),
  });
  const body = await resp.json() as any;
  const choice = body.choices?.[0];
  const tc = choice?.message?.tool_calls?.[0];
  return {
    maxTokens: maxTokens ?? "none",
    status: resp.status,
    finish: choice?.finish_reason,
    toolName: tc?.function?.name,
    argsLen: typeof tc?.function?.arguments === "string" ? tc.function.arguments.length : "n/a",
    argsPrefix: typeof tc?.function?.arguments === "string" ? tc.function.arguments.slice(0, 120) : "",
    usage: body.usage,
  };
}

for (const mt of [undefined, 4096, 8192, 16384]) {
  const r = await call(mt as number | undefined);
  console.log("max_tokens=" + r.maxTokens, "finish=" + r.finish, "tool=" + r.toolName, "argsLen=" + r.argsLen, "usage=" + JSON.stringify(r.usage));
}
