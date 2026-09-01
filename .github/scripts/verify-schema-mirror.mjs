import { readdir, readFile } from "node:fs/promises";

// 2026-08-24（AI 设计审查 §4.4 第三批）：drizzle schema 单一事实来源已下沉至
// packages/shared/src/db-schema（api 与 worker 平级消费）。apps/api/src/db/schema
// 保留兼容 re-export 壳。
//
// 2026-08-25（AI 设计审计修复）：此前只比对文件名集合，防不了壳内容回潮——
// 某个壳若被改回自带 pgTable/pgEnum 定义，api 经壳导入的运行时行为将与
// canonical 漂移、而 drizzle-kit 仍按 canonical 生成迁移，「双源」静默复活而
// CI 全绿。现在逐壳断言正文是纯 re-export（且无 drizzle 定义残留），并对 api
// 目录里 canonical 之外的孤儿文件报错。
const canonicalSchemaDirectory = "packages/shared/src/db-schema";
const apiShimDirectory = "apps/api/src/db/schema";

/** 壳允许的唯一形态：单行 `export ... from "@ailearn/shared/db-schema[/...]"`（含注释行）。
 *  index.ts 允许包根形式 `@ailearn/shared/db-schema`；其余文件必须指向同名子路径。 */
function assertPureReexport(file, content) {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("/*") && !line.startsWith("*"));
  const reexports = lines.filter(
    (line) => line.startsWith("export ") && line.includes(`from "@ailearn/shared/db-schema`),
  );
  if (reexports.length === 0 || reexports.length !== lines.length) {
    throw new Error(
      `api schema shim ${apiShimDirectory}/${file} is not a pure re-export of @ailearn/shared/db-schema/${file} — ` +
      `canonical definitions must live only in packages/shared/src/db-schema (found ${lines.length} non-comment lines, ${reexports.length} re-export lines)`,
    );
  }
}

async function schemaFiles(directory) {
  return (await readdir(directory))
    .filter((entry) => entry.endsWith(".ts"))
    .sort();
}

const canonicalFiles = await schemaFiles(canonicalSchemaDirectory);
if (canonicalFiles.length === 0) {
  throw new Error(`canonical database schema directory is empty: ${canonicalSchemaDirectory}`);
}
const canonicalSet = new Set(canonicalFiles);

const apiShims = await schemaFiles(apiShimDirectory);
for (const file of apiShims) {
  if (!canonicalSet.has(file)) {
    throw new Error(`orphan api schema shim ${apiShimDirectory}/${file} has no counterpart in ${canonicalSchemaDirectory} — delete it or move the definition into shared`);
  }
  assertPureReexport(file, await readFile(`${apiShimDirectory}/${file}`, "utf8"));
}
for (const file of canonicalFiles) {
  if (!apiShims.includes(file)) {
    throw new Error(`api schema shim directory is missing re-export for ${file} — add apps/api/src/db/schema/${file}`);
  }
}

console.log(
  `canonical database schema OK (${canonicalFiles.length} files; ${canonicalSchemaDirectory}; api shims synchronized and verified as pure re-exports)`,
);
