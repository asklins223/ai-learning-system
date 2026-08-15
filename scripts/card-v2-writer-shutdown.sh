#!/usr/bin/env bash
# 方案 20 C8 — V1 旧 writer 停写就绪检查与执行脚本（R35）。
#
# 用法：
#   scripts/card-v2-writer-shutdown.sh check            # 就绪检查（只读）
#   scripts/card-v2-writer-shutdown.sh status           # cutover 事件状态
#   scripts/card-v2-writer-shutdown.sh execute [--force] # 停写 drill（workspace 级）
#
# 前置：dev postgres（localhost:5432）。生产翻转 = 部署层设置
# CARD_GENERATION_V2_ENABLED=true 且不设 CARD_GENERATION_V1_WRITER_ENABLED，
# 需 owner 批准（docs/ops/learning-companion-v2-runbook.md §7）。

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_URL="${DATABASE_URL_MIGRATOR:-postgres://ailearn:ailearn_dev@localhost:5432/ailearn}"
ACTION="${1:-check}"
TSX="$ROOT/workers/ai-worker/node_modules/tsx/dist/loader.mjs"

run_eval() {
  # 在 apps/api 下执行（node_modules 可解析 postgres/drizzle）
  (cd "$ROOT/apps/api" && DATABASE_URL_API="$DB_URL" node --import "$TSX" -e "$1")
}

case "$ACTION" in
  check)
    echo "== C8 就绪检查（只读） =="
    run_eval '
      import postgres from "postgres";
      const sql = postgres(process.env.DATABASE_URL_API, { max: 1 });
      const hits = await sql`SELECT writer_kind, count(*)::int AS n, max(hit_at) AS latest FROM card_generation_legacy_writer_hits GROUP BY writer_kind`;
      console.log("legacy writer hits:", JSON.stringify(hits));
      const v1 = await sql`SELECT count(*)::int AS n FROM card_generation_runs WHERE created_at >= now() - interval \x2724 hours\x27`;
      const v2 = await sql`SELECT count(*)::int AS n FROM card_generation_runs_v2 WHERE created_at >= now() - interval \x2724 hours\x27`;
      console.log("V1 runs 24h:", v1[0].n, "| V2 runs 24h:", v2[0].n);
      await sql.end();
    '
    echo "== readiness（服务级，全 workspace 口径） =="
    run_eval '
      import postgres from "postgres";
      import { drizzle } from "drizzle-orm/postgres-js";
      const q = postgres(process.env.DATABASE_URL_API, { max: 1 });
      const db = drizzle(q, { schema: {} });
      const { checkLegacyWriterShutdownReadiness } = await import("./src/modules/card-generation-v2/shutdown-rc-service.ts");
      const report = await checkLegacyWriterShutdownReadiness(db as never, null);
      console.log(JSON.stringify(report, null, 1));
      await q.end();
    '
    ;;
  execute)
    echo "== C8 停写 drill 执行 =="
    if [ "$FORCE" != "--force" ]; then
      echo "（未加 --force：readiness blocked 则不执行）"
    fi
    C8_WORKSPACE_ID="${C8_WORKSPACE_ID:?C8_WORKSPACE_ID env required（workspace 级 drill）}" \
    run_eval '
      import postgres from "postgres";
      import { drizzle } from "drizzle-orm/postgres-js";
      const q = postgres(process.env.DATABASE_URL_API, { max: 1 });
      const db = drizzle(q, { schema: {} });
      const { executeV1WriterShutdown } = await import("./src/modules/card-generation-v2/shutdown-rc-service.ts");
      const result = await executeV1WriterShutdown(db as never, process.env.C8_WORKSPACE_ID, { force: process.argv.includes("--force") });
      console.log(JSON.stringify(result, null, 1));
      await q.end();
    '
    echo "== 停写开关（部署层） =="
    echo "生产翻转：CARD_GENERATION_V2_ENABLED=true 且 CARD_GENERATION_V1_WRITER_ENABLED 不设置"
    echo "（需 owner 批准，见 runbook §7）"
    ;;
  status)
    echo "== cutover 事件状态 =="
    run_eval '
      import postgres from "postgres";
      const sql = postgres(process.env.DATABASE_URL_API, { max: 1 });
      const events = await sql`SELECT event_type, count(*)::int AS n, max(created_at) AS latest FROM card_generation_cutover_events GROUP BY event_type ORDER BY event_type`;
      console.log(JSON.stringify(events));
      await sql.end();
    '
    ;;
  *)
    echo "usage: $0 {check|execute [--force]|status}" >&2
    exit 1
    ;;
esac
