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
COPY apps/web/lib ./lib
RUN mkdir -p node_modules/@ailearn \
 && ln -sf /tmp/shared node_modules/@ailearn/shared
EXPOSE 3000
CMD ["npm", "run", "dev"]

FROM base AS prod
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# G-004: 构建时注入 INTERNAL_API_URL，避免 rewrite 固化 localhost
# docker-compose 中 API 服务名为 api，容器间通信用 http://api:4000
ARG INTERNAL_API_URL=http://api:4000
ENV INTERNAL_API_URL=$INTERNAL_API_URL
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
COPY apps/web/lib ./lib
RUN mkdir -p node_modules/@ailearn \
 && ln -sf /tmp/shared node_modules/@ailearn/shared \
 && npm run build
# F-027: 以非 root 用户运行
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "start"]
