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

# ⑤ 自动比对：代码里每个按目标的 ON CONFLICT，库里必须有一条列集合完全一致的
#    唯一索引当 arbiter（ON CONFLICT 不要求索引名前缀，但列集合必须逐个对上）。
#    四列的代码打在只有五列索引的库上 = 每张卡提交一次就 42P10 一次。
python3 - <<'PY'
import re, subprocess
src = open("workers/ai-worker/src/handlers/card-generation-v2-handler.ts").read()
targets = {tuple(re.split(r",\s*", m)) for m in
           re.findall(r"ON CONFLICT \(([^)]*plan_objective_local_id[^)]*)\)", src)}
if not targets:
    print("⑤ 代码里没有按目标的 ON CONFLICT → A1 不在这棵树，⑤ 不适用")
else:
    out = subprocess.run(["docker","exec","ailearn-dev-postgres-1","psql","-U","ailearn","-d","ailearn","-Atc",
      "SELECT replace(replace(indexdef,'ON public.card_generation_candidates_v2 USING btree ',''),'CREATE UNIQUE INDEX ','') FROM pg_indexes WHERE tablename='card_generation_candidates_v2' AND indexdef LIKE '%UNIQUE%'"],
      capture_output=True, text=True).stdout
    live = {tuple(re.sub(r"[()]", "", line.split(" ", 1)[1]).split(", ")) for line in out.strip().splitlines()}
    for t in targets:
        bad = [cols for cols in live if set(cols) == set(t)]
        print(f"⑤ 代码 {t} → 库里有匹配 arbiter 吗：{'有' if bad else '没有（会 42P10）'}")
PY
