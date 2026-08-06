import { zodToJsonSchema } from "../agent/tools/zod-to-json-schema.ts";
import { TOOL_ZOD_SCHEMAS } from "../agent/tools/schemas.ts";

// Verify JSON Schema generation for key tools
const tools = [
  "submit_deck_draft",
  "submit_quality_report",
  "record_extraction_decisions",
  "submit_deck_proposal",
  "apply_candidate_operations",
  "apply_draft_patch",
];

for (const toolName of tools) {
  const schema = TOOL_ZOD_SCHEMAS[toolName];
  if (!schema) {
    console.log(`${toolName}: NO SCHEMA`);
    continue;
  }
  const jsonSchema = zodToJsonSchema(schema);
  const hasAdditionalPropertiesFalse = JSON.stringify(jsonSchema).includes('"additionalProperties":false');
  const hasType = jsonSchema.type === "object";
  const hasProperties = jsonSchema.properties !== undefined;
  console.log(`${toolName}: type=${hasType}, props=${hasProperties}, strict=${hasAdditionalPropertiesFalse}`);
}

// Verify submit_deck_draft has density in required
const draftSchema = zodToJsonSchema(TOOL_ZOD_SCHEMAS["submit_deck_draft"]!);
const draftProps = (draftSchema.properties as Record<string, unknown>)?.draft as Record<string, unknown>;
const draftRequired = draftProps?.required as string[];
console.log("submit_deck_draft.draft.required:", draftRequired);
console.log("density in required:", draftRequired?.includes("density"));
console.log("cardBudget in required:", draftRequired?.includes("cardBudget"));

// Verify submit_quality_report has perClaimVerdicts with minItems
const reportSchema = zodToJsonSchema(TOOL_ZOD_SCHEMAS["submit_quality_report"]!);
const reportProps = (reportSchema.properties as Record<string, unknown>)?.report as Record<string, unknown>;
const reportRequired = reportProps?.required as string[];
console.log("submit_quality_report.report.required:", reportRequired);
console.log("perClaimVerdicts in required:", reportRequired?.includes("perClaimVerdicts"));
