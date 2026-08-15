# Build context must be the repo root (set by docker-compose).
# F-027: 锁定 node patch 版本，避免 latest 标签漂移
FROM node:22.11.0-alpine3.20 AS base
WORKDIR /app

# 国内 apk 镜像（清华 USTC）
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.ustc.edu.cn|g' /etc/apk/repositories

# F-027: 使用 npm ci + lockfile 确保可复现构建。
# install-links 将本地 file: 包打包进 worker 的 node_modules，而不是创建指向
# 仓库外目录的符号链接。这样 @ailearn/db 与 worker 会解析到同一份 drizzle-orm。
FROM base AS deps
COPY packages/shared /packages/shared
COPY packages/db /packages/db
COPY workers/ai-worker/package.json workers/ai-worker/package-lock.json workers/ai-worker/.npmrc ./
RUN npm config set registry https://registry.npmmirror.com \
 && npm ci --install-links --no-audit --no-fund

# 第五轮审计 W#1：自包含 drizzle-orm 提供者。
# 根 .dockerignore 排除 **/node_modules，无法从构建上下文 COPY apps/api 的
# node_modules；而 worker tsconfig paths 把 drizzle-orm 强制映射到
# apps/api/node_modules/drizzle-orm（保证与 apps/api schema 单一 drizzle 类型
# 身份）。此阶段独立安装与 apps/api 锁定的同版本 drizzle-orm，供 prod 阶段
# typecheck + esbuild 解析，使 prod 镜像无需 dev 的 apps/api bind-mount 即可
# 自包含构建。
#
# round-7 🟡4 修复：不再硬编码精确版本（原 0.45.2，caret 升版后与 apps/api 实际
# 解析版本脱钩 → 双 drizzle 身份 TS2769 仅在镜像构建静默回归）。改为从 deps 阶段
# `npm ci` 已装出的 **实际解析版本**（读 node_modules/drizzle-orm/package.json）
# 动态安装，版本始终与 worker/apps/api 的 lockfile 分辨率保持一致，升版自动跟随。
#
# round-8 🟡6 说明（保持现状）：此动态版本只保证「v2_drizzle == worker lockfile 的
# drizzle-orm 解析版本」，并未显式校验与 **apps/api lockfile**（apps/api/package-lock.json）
# 的解析版本一致。镜像内 apps/api/src 原样 COPY，其 drizzle 由本 v2_drizzle 提供并由
# L88-89 的 symlink 强配——若未来 worker 与 apps/api 两个 lockfile 各自 caret 升到不同
# patch，symlink 仍强制配对，但类型身份可能漂移（本地 tsc 因 apps/api node_modules
# 未 install 而不暴露，仅镜像 build 内显现 TS2769）。当前两处均解析 0.45.2，非实际 bug。
# 维护纪律：升级 apps/api 或 worker 任一 lockfile 的 drizzle-orm 版本时，须保证另一处
# 同步（或从单一 root lockfile 提供），并在 CI 加
#   node -p "require('drizzle-orm/package.json').version"
# 对两 lockfile 命中版本的一致性断言。
FROM base AS v2_drizzle
WORKDIR /drizzle
RUN npm config set registry https://registry.npmmirror.com
COPY --from=deps /app/node_modules/drizzle-orm/package.json /tmp/drizzle-version/package.json
RUN npm install --no-audit --no-fund --prefix /drizzle \
      "drizzle-orm@$(node -p 'require("/tmp/drizzle-version/package.json").version')"

FROM base AS dev
ENV NODE_ENV=development \
    NODE_OPTIONS=--preserve-symlinks \
    PATH=/app/node_modules/.bin:$PATH
COPY --from=deps /app/node_modules /app/node_modules
COPY packages/shared /tmp/shared
COPY packages/db /tmp/db
COPY workers/ai-worker/package.json ./package.json
COPY workers/ai-worker/tsconfig.json ./tsconfig.json
COPY workers/ai-worker/src ./src
# dev 保留源码热挂载路径；包本身不携带 node_modules，并通过 preserve-symlinks
# 从 /app/node_modules 解析唯一的 drizzle-orm/zod 实例。
RUN rm -rf node_modules/@ailearn/db node_modules/@ailearn/shared \
 && mkdir -p node_modules/@ailearn \
 && ln -sf /tmp/shared node_modules/@ailearn/shared \
 && ln -sf /tmp/db node_modules/@ailearn/db
CMD ["npm", "run", "dev"]


FROM base AS prod
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules /app/node_modules
COPY workers/ai-worker/package.json /app/workers/ai-worker/package.json
COPY workers/ai-worker/tsconfig.json /app/workers/ai-worker/tsconfig.json
COPY workers/ai-worker/src /app/workers/ai-worker/src
# 第五轮审计 W#1：worker 的 src/schema 与 src/db 及 card-generation-v2 服务函数
# import ../../../../apps/api/...（tsconfig rootDir=../..，include=src）。prod
# 阶段必须自包含——依赖唯一的 apps/api bind-mount 在镜像构建时不可用。完整 COPY
# apps/api/src（覆盖 schema re-export + 服务模块的类型/运行时依赖），并把独立安装
# 的 drizzle-orm 放到 tsconfig paths 映射目标 apps/api/node_modules/drizzle-orm，
# 使 `tsc --noEmit` 与 esbuild 都能解析（apps/api 其余 node_modules 依赖
# pino/postgres/zod/prom-client/@ailearn/shared 均来自 worker 自己的 /app/node_modules）。
COPY apps/api/src /app/apps/api/src
# apps/api/package.json：NodeNext 用就近 package.json 的 "type" 判断 .ts 模块格式。
# 缺失时 TS 回退把 apps/api/src 的 schema 视为 CommonJS，为其合成 .default 导出，
# 与 worker 的 schema re-export（ESM，无 default）类型不匹配（实测 queue-postgres
# integration TS2345）。复制后模块格式与宿主持平。
COPY apps/api/package.json /app/apps/api/package.json
COPY --from=v2_drizzle /drizzle/node_modules/drizzle-orm /app/apps/api/node_modules/drizzle-orm
# worker/src 的集成测试经相对路径直接引用 packages/shared/src（含 .ts 源），tsconfig
# include=src/** 会 type-check 它们；镜像内须存在对应源，使 `../../../../packages/shared`
# 从 /app/workers/ai-worker/... 正常解析到 /app/packages/shared（与仓库根布局一致）。
COPY packages/shared /app/packages/shared
# 镜像内 drizzle-orm 单一身份：把 worker 自己 npm ci 装出的 /app/node_modules/
# drizzle-orm（真实目录副本）替换为指向 apps/api 实例的符号链接——与宿主仓库 round-4
# 修复一致（workers/ai-worker/node_modules/drizzle-orm -> ../../../apps/api/...）。
# 否则 tsc 在 NodeNext 下会混合解析（worker 节点解析命中自身副本、schema 经 paths
# 命中 apps/api 副本），两个 drizzle 包身份导致 PgTable/PgColumn/SQL 类型不兼容
#（实测 prod 构建 TS2769）。符号链接保证 node 解析与 tsconfig paths 收敛到同一物理包。
RUN rm -rf /app/node_modules/drizzle-orm \
 && ln -s /app/apps/api/node_modules/drizzle-orm /app/node_modules/drizzle-orm
RUN cd /app/workers/ai-worker && npm run build
WORKDIR /app/workers/ai-worker
# F-027: 以非 root 用户运行
RUN chown -R node:node /app
USER node
CMD ["node", "dist/index.cjs"]
