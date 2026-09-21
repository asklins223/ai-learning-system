#!/usr/bin/env bash
# A1（逐候选落盘）到底进没进这棵树/这个库？四条独立判据，一条都骗不了人。
# 用法：在任意一个克隆里跑 `bash scripts/check-a1-landed.sh`
set -u
H=workers/ai-worker/src/handlers/card-generation-v2-handler.ts
echo "① HEAD      : $(git log -1 --format='%h %s' 2>/dev/null)"
echo "② 按目标的冲突目标（应为 3 处；0 处=A1 不在这棵树）:"
grep -c "ON CONFLICT (workspace_id, run_id" "$H" 2>/dev/null | sed 's/^/     /'
echo "③ 入口守卫（A1 之后不应再有『非 planning 就 return』）:"
grep -c 'if (run.status !== "planning")' "$H" 2>/dev/null | sed 's/^/     /'
echo "④ 库里真正能给 ON CONFLICT 当 arbiter 的唯一索引:"
docker exec ailearn-dev-postgres-1 psql -U ailearn -d ailearn -Atc \
  "SELECT '   '||indexdef FROM pg_indexes WHERE tablename='card_generation_candidates_v2' AND indexdef LIKE '%UNIQUE%' AND indexname LIKE 'cg_v2%'" 2>/dev/null \
  || echo "     （dev 库不可达）"
