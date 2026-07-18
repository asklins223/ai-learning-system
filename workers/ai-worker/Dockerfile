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
RUN cd /app/workers/ai-worker && npm run build
WORKDIR /app/workers/ai-worker
# F-027: 以非 root 用户运行
RUN chown -R node:node /app
USER node
CMD ["node", "dist/index.cjs"]
