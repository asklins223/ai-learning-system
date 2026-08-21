import { readdir } from "node:fs/promises";

const apiSchemaDirectory = "apps/api/src/db/schema";

async function schemaFiles(directory) {
  return (await readdir(directory))
    .filter((entry) => entry.endsWith(".ts"))
    .sort();
}

const apiFiles = await schemaFiles(apiSchemaDirectory);
if (apiFiles.length === 0) {
  throw new Error(`canonical database schema directory is empty: ${apiSchemaDirectory}`);
}

console.log(`canonical database schema OK (${apiFiles.length} files; ${apiSchemaDirectory})`);
