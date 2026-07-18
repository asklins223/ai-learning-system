import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const apiSchemaDirectory = "apps/api/src/db/schema";
const sharedSchemaDirectory = "packages/db/src/schema";

async function schemaFiles(directory) {
  return (await readdir(directory))
    .filter((entry) => entry.endsWith(".ts"))
    .sort();
}

const [apiFiles, sharedFiles] = await Promise.all([
  schemaFiles(apiSchemaDirectory),
  schemaFiles(sharedSchemaDirectory),
]);

if (apiFiles.join("\n") !== sharedFiles.join("\n")) {
  throw new Error(
    `database schema file sets differ:\nAPI=${apiFiles.join(", ")}\nDB=${sharedFiles.join(", ")}`,
  );
}

const mismatches = [];
for (const file of apiFiles) {
  const [apiSource, sharedSource] = await Promise.all([
    readFile(join(apiSchemaDirectory, file), "utf8"),
    readFile(join(sharedSchemaDirectory, file), "utf8"),
  ]);
  if (apiSource !== sharedSource) mismatches.push(file);
}

if (mismatches.length > 0) {
  throw new Error(`database schema mirrors drifted: ${mismatches.join(", ")}`);
}

console.log(`database schema mirror OK (${apiFiles.length} files)`);
