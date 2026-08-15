import { sql } from "drizzle-orm";
import { db } from "./src/db/client.ts";
async function main() {
  const ids = ["381ddd7b-2bd9-4e0b-98aa-5f4a8fe9d2d5"];
  try {
    const r1 = await db.execute(sql`SELECT ${ids}::uuid[] AS out`);
    console.log("cast direct:", JSON.stringify(r1));
  } catch (e) { console.log("cast direct ERR", (e as any)?.message); }
  try {
    const r2 = await db.execute(sql`SELECT ${{...{v:[ids]}}} `);
  } catch {}
  try {
    const r3 = await db.execute(sql`SELECT ${sql.raw(Array.isArray(ids) ? "'{" + ids.join(",") + "}'::uuid[]" : "NULL")} AS out`);
    console.log("raw literal:", JSON.stringify(r3));
  } catch (e) { console.log("raw literal ERR", (e as any)?.message); }
  await process.exit(0);
}
main();
