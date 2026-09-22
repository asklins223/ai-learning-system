#!/usr/bin/env bash
# A1（逐候选落盘）到底进没进这棵树/这个库？四条独立判据，一条都骗不了人。
# 用法：在任意一个克隆里跑 `bash scripts/check-a1-landed.sh`
#
# ⑥ 那一段是 2026-09-22 加的：这条链后来还交了 B4 的界面、等式断言、种子/清理 SQL 与实机探针，
#    而 HEAD 在同一棵树上被好几个会话往前推——只核 ON CONFLICT 已经不够了。签名一律对 **HEAD** 核，
#    不对工作树核：未提交的改动不算落地（这一树里"我改了"和"它在历史里"是两件事）。
set -u
H=workers/ai-worker/src/handlers/card-generation-v2-handler.ts
echo "① HEAD      : $(git log -1 --format='%h %s' 2>/dev/null)"
echo "② 按目标的冲突目标（≥1 处；逐张写与批量写共用一支 helper 时就是 1 处。0 处=A1 不在这棵树）:"
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

# ⑥ 这条链后来交付的东西，逐个对 **HEAD** 核（不是工作树——未提交的不算落地）。
#    想临时加一条：CHECK_A1_EXTRA="路径::签名" bash scripts/check-a1-landed.sh
echo "⑥ 这条链交付过的签名，逐个对 HEAD 核:"
H_WORKERS="workers/ai-worker/src/handlers"
H_DESK="apps/desktop-client/src/renderer/src/components"
H_TESTS="workers/ai-worker/src/integration-tests"
SIG_LIST="sig|${H_WORKERS}/card-generation-v2-handler.ts|commitAuthoredCandidateV2
sig|${H_WORKERS}/card-generation-v2-handler.ts|runV2PlanPhase
sig|${H_WORKERS}/card-generation-v2-handler.ts|loadCommittedFirstRevisions
sig|${H_WORKERS}/card-generation-v2-handler.ts|pg_advisory_xact_lock
sig|${H_DESK}/CardGenerationSurface.tsx|card-generation-landing
sig|${H_DESK}/surfaces/card-generation-status.ts|isLandedCandidate
sig|${H_DESK}/CardGenerationSurface.live-candidates.test.tsx|已写出
sig|${H_TESTS}/card-generation-v2-pedagogy-stage-postgres.integration.ts|practice_quota_short
sig|${H_TESTS}/card-generation-v2-plan-commit-postgres.integration.ts|xmin
sig|${H_TESTS}/card-generation-v2-per-candidate-commit-postgres.integration.ts|replan
file|apps/api/src/db/migrations/0253_candidate_objective_revision_unique.sql|
sig|apps/api/src/db/migrations/meta/_journal.json|0253_candidate_objective_revision_unique
file|apps/desktop-client/scripts/verify-b4-landing-live.mjs|
file|apps/desktop-client/scripts/seed-b4-inflight.sql|
file|apps/desktop-client/scripts/unseed-b4-inflight.sql|
file|apps/api/src/probes/tmp-b4-http-probe.mts|"
if [ -n "${CHECK_A1_EXTRA:-}" ]; then
  SIG_LIST="${SIG_LIST}
sig|${CHECK_A1_EXTRA%%::*}|${CHECK_A1_EXTRA##*::}"
fi

missing=0
while IFS='|' read -r kind path sig; do
  [ -z "$kind" ] && continue
  if [ "$kind" = "file" ]; then
    if git cat-file -e "HEAD:${path}" 2>/dev/null; then verdict="在"; else verdict="**不在**"; missing=$((missing+1)); fi
    printf '   %-46s %s\n' "${path##*/}" "$verdict"
  else
    n=$(git show "HEAD:${path}" 2>/dev/null | grep -c "$sig")
    if [ "${n:-0}" -ge 1 ]; then verdict="在 (${n})"; else verdict="**不在**"; missing=$((missing+1)); fi
    printf '   %-46s %-34s %s\n' "${path##*/}" "$sig" "$verdict"
  fi
done <<LIST
${SIG_LIST}
LIST

if [ "$missing" -gt 0 ]; then
  echo "→ 有 ${missing} 项不在 HEAD 里（被回退、没提交、或在另一个克隆）"
  exit 1
fi
echo "→ 全部在 HEAD 里"
