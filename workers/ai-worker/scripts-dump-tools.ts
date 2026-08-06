import { toolRegistry } from "./src/agent/tool-registry.ts";
const tools = toolRegistry.getToolSchemasForRole("text_extractor");
console.log(JSON.stringify(tools, null, 2));
