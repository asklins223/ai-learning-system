# Build context must be the repo root (set by docker-compose).
# Real paths are prefixed with `apps/api/` and `packages/shared/`.
# F-027: 锁定 node patch 版本，避免 latest 标签漂移
FROM node:22.11.0-alpine3.20 AS base
WORKDIR /app

# 国内 apk 镜像（清华 USTC），加速 alpine 包安装
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.ustc.edu.cn|g' /etc/apk/repositories

# P3 前置（Owner 2026-08-11 批准）：Alpine ffmpeg/ffprobe 用于音频时长探测/转码。
# 供应链影响：apk 包来自 Alpine 官方仓库（经 USTC 镜像），ffmpeg 为 LGPL/GPL 组合许可；
# 体积影响见 phase-report（记录于 P2 收尾）。
RUN apk add --no-cache ffmpeg

# F-027: 使用 npm ci + lockfile 确保可复现构建
FROM base AS deps
COPY apps/api/package.json apps/api/package-lock.json ./
COPY packages/shared /packages/shared
COPY packages/shared/package.json packages/shared/package-lock.json /tmp/shared/
RUN npm config set registry https://registry.npmmirror.com \
 && npm ci --install-links --no-audit --no-fund \
 && npm ci --no-audit --no-fund --prefix /tmp/shared --registry=https://registry.npmmirror.com

FROM base AS dev
ENV NODE_ENV=development PATH=/app/node_modules/.bin:$PATH
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /tmp/shared /tmp/shared
COPY packages/shared /tmp/shared
COPY apps/api/package.json ./package.json
COPY apps/api/tsconfig.json ./tsconfig.json
COPY apps/api/drizzle.config.ts ./drizzle.config.ts
COPY apps/api/src ./src
RUN mkdir -p node_modules/@ailearn \
 && rm -rf node_modules/@ailearn/shared \
 && ln -s /tmp/shared node_modules/@ailearn/shared
EXPOSE 4000
CMD ["npm", "run", "dev"]

# F-027: 生产镜像 — 非 root 用户运行
FROM base AS prod
ENV NODE_ENV=production
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /tmp/shared /tmp/shared
COPY packages/shared /tmp/shared
COPY apps/api/package.json ./package.json
COPY apps/api/tsconfig.json ./tsconfig.json
COPY apps/api/drizzle.config.ts ./drizzle.config.ts
COPY apps/api/src ./src
RUN mkdir -p node_modules/@ailearn \
 && rm -rf node_modules/@ailearn/shared \
 && ln -s /tmp/shared node_modules/@ailearn/shared \
 && npm run typecheck \
 && npm run build
# F-027: 以非 root 用户运行
RUN chown -R node:node /app
USER node
EXPOSE 4000
CMD ["node", "dist/server.cjs"]
