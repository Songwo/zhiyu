# 知屿网页版（自托管）
#   docker compose up -d --build
# 资料保存在挂载的 /data 卷里；首次启动看日志里的「设置口令」创建账号。

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run web:build && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    ZHIYU_DATA=/data \
    ZHIYU_PORT=8848 \
    ZHIYU_HOST=0.0.0.0
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist-web ./dist-web
COPY --from=build /app/selfhost ./selfhost
COPY --from=build /app/electron/services ./electron/services
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8848
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8848/api/web/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "selfhost/server.mjs"]
