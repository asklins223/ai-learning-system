import { listReviews } from "../modules/review/service.ts";

const WORKSPACE_ID = "7b3880e9-d381-49cc-9ab2-09fd3536df7c";
const USER_ID = "8e57882a-3512-447b-b1fa-6c74664fb241";

try {
  console.log("Calling listReviews...");
  const result = await listReviews(WORKSPACE_ID, { status: "pending" }, USER_ID);
  console.log("Success! total:", result.total, "items:", result.items.length);
} catch (error: any) {
  console.error("ERROR CAUGHT!");
  console.error("name:", error?.name);
  console.error("message:", error?.message?.slice(0, 500));
  console.error("code:", error?.code);
  console.error("cause:", error?.cause?.message?.slice(0, 500) ?? error?.cause);
  console.error("full error:", JSON.stringify({
    name: error?.name,
    message: error?.message?.slice(0, 500),
    code: error?.code,
    causeMessage: error?.cause?.message?.slice(0, 500),
    stack: error?.stack?.slice(0, 1000),
  }, null, 2));
}

process.exit(0);
