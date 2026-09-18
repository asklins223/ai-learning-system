#!/bin/bash
#
# 一次性（可丢弃）开发数据库：为那些**断言依赖"库里只有自己的夹具"**的集成测试
# 重建一个隔离库——全部迁移 + 角色授权都落到一个全新库上，用完即弃。
#
# 为什么需要它：RLS 策略目录（rls-policies-postgres）、worker 队列
# （queue-postgres）、投影分页（projection-pagination）等用例，断言里含
# "claim 到的恰好是这两条 job""库里没有别的 active queue"这类前提。在共享的
# 开发库（ailearn）上跑会因为历史残留行而**假失败**；反过来它们又会写入和删除
# 数据，本来也不该在开发库上跑。CI 是每次起一个空的 postgres 服务来解决这个
# 问题的，本地没有等价物——这个脚本就是那个等价物。
#
# 用法：
#   bash scripts/dev-disposable-db.sh                    # 默认 ailearn_rls_test
#   bash scripts/dev-disposable-db.sh ailearn_scratch
#   make disposable-db DISPOSABLE_DB=ailearn_scratch
#
# 前置：开发 compose 的 postgres 容器在跑（`make up` 或 `make storage` 之后）。
# 连接串默认打 127.0.0.1:${DISPOSABLE_DB_PORT:-5432}（compose 的宿主端口映射），
# 可用 DISPOSABLE_DB_HOST / DISPOSABLE_DB_PORT 覆盖。
#
# 安全性（这是把删除操作放进仓库的前提）：目标库名必须匹配 ailearn_* 且
# **不等于** ailearn / postgres，否则直接拒绝执行——开发库不会被误删。
#
# 跑完会打印可直接复制的集成测试环境变量。示例（apps/api 下）：
#   RLS_TEST_MIGRATOR_DATABASE_URL=... \
#   RLS_TEST_API_DATABASE_URL=... \
#   RLS_TEST_WORKER_DATABASE_URL=... \
#   node --import tsx --test src/integration-tests/rls-policies-postgres.integration.ts

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 先把「调用方显式给的值」固定进私有变量，**再** source .env。
# .env 里有 PORT=4000（API 端口）这类通用名：此前用短别名 PORT 承接数据库端口，
# source 之后被 .env 覆盖成 4000，迁移于是去连 127.0.0.1:4000——API 恰好监听在那里，
# TCP 连得上但 Postgres 握手永远不来，脚本无声挂死。位置参数 $1 不受 source 影响。
ARG_DB_NAME="${1:-}"
REQUESTED_HOST="${DISPOSABLE_DB_HOST:-}"
REQUESTED_PORT="${DISPOSABLE_DB_PORT:-}"

DB_NAME="${ARG_DB_NAME:-ailearn_rls_test}"
COMPOSE=(docker compose -p ailearn-dev -f docker-compose.dev.yml)

# ── 安全护栏：只允许删/建一次性库 ────────────────────────────────────────
case "$DB_NAME" in
  ailearn|postgres|template0|template1|"")
    echo "refusing to use protected database '$DB_NAME' as a disposable database" >&2
    exit 2
    ;;
esac
if ! printf '%s' "$DB_NAME" | grep -Eq '^ailearn_[A-Za-z0-9_]+$'; then
  echo "disposable database name must match ^ailearn_[A-Za-z0-9_]+\$ (got '$DB_NAME')" >&2
  exit 2
fi

# ── 凭据：与 dev compose 同一份 .env（apply-roles.sh 也是从这里拿密码）────
if [ ! -f "$REPO_ROOT/.env" ]; then
  echo "missing $REPO_ROOT/.env (needed for POSTGRES_USER/POSTGRES_PASSWORD and the role passwords)" >&2
  exit 2
fi
set -a
# shellcheck disable=SC1091
. "$REPO_ROOT/.env"
set +a
: "${POSTGRES_USER:?POSTGRES_USER is required in .env}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required in .env}"
: "${MIGRATOR_PASSWORD:?MIGRATOR_PASSWORD is required in .env}"
: "${API_PASSWORD:?API_PASSWORD is required in .env}"
: "${WORKER_PASSWORD:?WORKER_PASSWORD is required in .env}"

# source 之后再定连接地址（见文件上方关于 PORT 被 .env 覆盖的说明）。
DB_HOST="${REQUESTED_HOST:-127.0.0.1}"
DB_PORT="${REQUESTED_PORT:-5432}"

PG_CONTAINER="$("${COMPOSE[@]}" ps -q postgres 2>/dev/null || true)"
if [ -z "$PG_CONTAINER" ]; then
  echo "dev postgres container is not running; start the stack first (make up)" >&2
  exit 2
fi

psql_admin() { # psql_admin <dbname> [extra psql args...]
  local db="$1"; shift
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$PG_CONTAINER" \
    psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$db" "$@"
}

apply_roles() { # apply_roles <dbname> <true|false>
  psql_admin "$1" \
    -v migrator_password="$MIGRATOR_PASSWORD" \
    -v api_password="$API_PASSWORD" \
    -v worker_password="$WORKER_PASSWORD" \
    -v require_rls_disabled="$2" \
    -f - < "$REPO_ROOT/infra/postgres/roles.sql" >/dev/null
}

echo "==> recreating disposable database $DB_NAME"
psql_admin postgres \
  -c "DROP DATABASE IF EXISTS $DB_NAME" \
  -c "CREATE DATABASE $DB_NAME OWNER $POSTGRES_USER"

# 角色是集群级的（已存在则跳过创建、按 .env 轮换密码）；这里只负责把
# 库级授权与 DEFAULT PRIVILEGES 落到新库上——迁移前先来一遍，迁移后再来一遍
# 兜住迁移新建的表（与 CI 的 fresh-migrations job 同序）。
echo "==> applying role grants (pre-migration)"
apply_roles "$DB_NAME" false

DATABASE_URL_DISPOSABLE="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
echo "==> running migrations"
# 迁移会把 223 条迁移名逐条打出来；成功时只留最后一行，失败时原样全量输出
# （诊断信息不能省，但成功路径不该刷屏）。
if ! migrate_output="$(
  cd "$REPO_ROOT/apps/api"
  DATABASE_URL_MIGRATOR="$DATABASE_URL_DISPOSABLE" \
  DATABASE_URL="$DATABASE_URL_DISPOSABLE" \
    npm run --silent db:migrate 2>&1
)"; then
  printf '%s\n' "$migrate_output" >&2
  echo "migrations failed against $DB_NAME (database left in place for inspection)" >&2
  exit 1
fi
printf '    %s\n' "$(printf '%s\n' "$migrate_output" | tail -n 1)"

echo "==> applying role grants (post-migration) + RLS completeness check"
apply_roles "$DB_NAME" true

MIGRATOR_URL="postgres://ailearn_migrator:$MIGRATOR_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
API_URL="postgres://ailearn_api:$API_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
WORKER_URL="postgres://ailearn_worker:$WORKER_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"

cat <<EOF

$DB_NAME is ready (all migrations applied, role grants applied, RLS catalog complete).

  RLS/SEC-01 + 受限角色用例（apps/api）:
    RLS_TEST_MIGRATOR_DATABASE_URL='$MIGRATOR_URL' \\
    RLS_TEST_API_DATABASE_URL='$API_URL' \\
    RLS_TEST_WORKER_DATABASE_URL='$WORKER_URL' \\
    node --import tsx --test src/integration-tests/rls-policies-postgres.integration.ts

  worker 队列用例（workers/ai-worker）:
    QUEUE_TEST_MIGRATOR_DATABASE_URL='$MIGRATOR_URL' \\
    QUEUE_TEST_WORKER_A_DATABASE_URL='$WORKER_URL' \\
    QUEUE_TEST_WORKER_B_DATABASE_URL='$WORKER_URL' \\
    node --import tsx --test src/integration-tests/queue-postgres.integration.ts

  需要超级用户连接的用例（投影分页、拓扑等，夹具自己写数据）:
    DATABASE_URL_API='$DATABASE_URL_DISPOSABLE' \\
    DATABASE_URL_MIGRATOR='$DATABASE_URL_DISPOSABLE' \\
    DATABASE_URL_WORKER='$DATABASE_URL_DISPOSABLE'

注意：这些用例会往库里写夹具并做清理，但**不要**把这个库当成长期状态；
任何一次运行后都可直接重跑本脚本回到干净状态。
EOF
