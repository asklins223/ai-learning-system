import { readdir } from "node:fs/promises";

// Database schema has one source of truth. API and worker import this directory
// directly; there is no application-side mirror or compatibility shim.
const canonicalSchemaDirectory = "packages/shared/src/db-schema";

const schemaFiles = (await readdir(canonicalSchemaDirectory))
  .filter((entry) => entry.endsWith(".ts"))
  .sort();

if (schemaFiles.length === 0) {
  throw new Error(`canonical database schema directory is empty: ${canonicalSchemaDirectory}`);
}

console.log(`canonical database schema OK (${schemaFiles.length} files; ${canonicalSchemaDirectory})`);
