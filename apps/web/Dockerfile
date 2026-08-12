# Build context must be the repo root (set by docker-compose).
# F-027: 锁定 node patch 版本，避免 latest 标签漂移
FROM node:22.11.0-alpine3.20 AS base
WORKDIR /app

# 国内 apk 镜像（清华 USTC）
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.ustc.edu.cn|g' /etc/apk/repositories

# F-027: 使用 npm ci + lockfile 确保可复现构建
FROM base AS deps
COPY apps/web/package.json apps/web/package-lock.json ./
COPY packages/shared/package.json packages/shared/package-lock.json /tmp/shared/
RUN npm config set registry https://registry.npmmirror.com \
 && npm ci --no-audit --no-fund \
 && npm ci --no-audit --no-fund --prefix /tmp/shared --registry=https://registry.npmmirror.com

FROM base AS dev
ENV NODE_ENV=development PATH=/app/node_modules/.bin:$PATH NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /tmp/shared /tmp/shared
COPY packages/shared /tmp/shared
COPY apps/web/package.json ./package.json
COPY apps/web/tsconfig.json ./tsconfig.json
COPY apps/web/next.config.mjs ./next.config.mjs
COPY apps/web/next-env.d.ts ./next-env.d.ts
COPY apps/web/tailwind.config.ts ./tailwind.config.ts
COPY apps/web/postcss.config.js ./postcss.config.js
COPY apps/web/public ./public
COPY apps/web/app ./app
COPY apps/web/components ./components
COPY apps/web/features ./features
COPY apps/web/lib ./lib
# 2026-08-11：middleware.ts 根级鉴权文件（base 与 prod 段都需包含）
COPY apps/web/middleware.ts ./middleware.ts
RUN mkdir -p node_modules/@ailearn \
 && ln -sf /tmp/shared node_modules/@ailearn/shared
EXPOSE 3000
CMD ["npm", "run", "dev"]

FROM base AS prod
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# G-004: 构建时注入 INTERNAL_API_URL，避免 rewrite 固化 localhost
# docker-compose 中 API 服务名为 api，容器间通信用 http://api:4000
ARG INTERNAL_API_URL=http://api:4000
# NEXT_PUBLIC_* 值会在 `next build` 时固化进浏览器 bundle。生产构建未显式
# 传入时保持关闭，避免缺失配置意外启用 v0.6 写路径。
ARG NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED=false
ARG NEXT_PUBLIC_AI_QUESTION_V1_ENABLED=false
ARG NEXT_PUBLIC_RUBRIC_EVALUATION_V1_ENABLED=false
ARG NEXT_PUBLIC_COMPANION_V2_INTERNAL=false
# 2026-08-11 修复：compose 传入 7 个 NEXT_PUBLIC_*，此前只声明 4 个 ARG，
# 缺失 3 个在构建时静默失效（恒 false），导致生产 flag 无法开启。
ARG NEXT_PUBLIC_COMPANION_PET_ENABLED=false
ARG NEXT_PUBLIC_CARD_SET_DECK_UI_ENABLED=false
ARG NEXT_PUBLIC_AGENT_ACTIVITY_STREAM_ENABLED=false
ENV INTERNAL_API_URL=$INTERNAL_API_URL \
    NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED=$NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED \
    NEXT_PUBLIC_AI_QUESTION_V1_ENABLED=$NEXT_PUBLIC_AI_QUESTION_V1_ENABLED \
    NEXT_PUBLIC_RUBRIC_EVALUATION_V1_ENABLED=$NEXT_PUBLIC_RUBRIC_EVALUATION_V1_ENABLED \
    NEXT_PUBLIC_COMPANION_V2_INTERNAL=$NEXT_PUBLIC_COMPANION_V2_INTERNAL \
    NEXT_PUBLIC_COMPANION_PET_ENABLED=$NEXT_PUBLIC_COMPANION_PET_ENABLED \
    NEXT_PUBLIC_CARD_SET_DECK_UI_ENABLED=$NEXT_PUBLIC_CARD_SET_DECK_UI_ENABLED \
    NEXT_PUBLIC_AGENT_ACTIVITY_STREAM_ENABLED=$NEXT_PUBLIC_AGENT_ACTIVITY_STREAM_ENABLED
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /tmp/shared /tmp/shared
COPY packages/shared /tmp/shared
COPY apps/web/package.json ./package.json
COPY apps/web/tsconfig.json ./tsconfig.json
COPY apps/web/next.config.mjs ./next.config.mjs
COPY apps/web/next-env.d.ts ./next-env.d.ts
COPY apps/web/tailwind.config.ts ./tailwind.config.ts
COPY apps/web/postcss.config.js ./postcss.config.js
COPY apps/web/public ./public
COPY apps/web/app ./app
COPY apps/web/components ./components
COPY apps/web/features ./features
COPY apps/web/lib ./lib
# 2026-08-11：middleware.ts 根级鉴权文件（base 与 prod 段都需包含）
COPY apps/web/middleware.ts ./middleware.ts
RUN mkdir -p node_modules/@ailearn \
 && ln -sf /tmp/shared node_modules/@ailearn/shared \
 && npm run build \
 # 2026-08-12（构建面审计 P2-1）：镜像瘦身——next build 后裁剪 devDeps
 # （typescript/eslint/tailwind/@playwright/test 等运行时不需要的包），
 # next start 不再携带全量 node_modules。
 && npm prune --omit=dev --no-audit --no-fund
# F-027: 以非 root 用户运行
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "start"]
