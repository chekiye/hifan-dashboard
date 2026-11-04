# 里番缺口看板 —— 生产镜像
#
# ⚠️ 构建链说明（2026-10-13 实测修正）：
#   初版用 pnpm workspace 构建，但 pnpm 12 在 Windows 上软链接反复失效，
#   项目已改用 **npm workspaces**。本 Dockerfile 与之一致。
#
# 关键设计：数据库用 Node 内置 node:sqlite，**无需任何原生模块编译**。
# 因此镜像不含 build-essential / python3 / node-gyp，
# 构建链零原生依赖，镜像小、构建快。
#
# 需要 Node >= 22.5（node:sqlite 引入版本）

# ── 构建阶段 ────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# 先拷贝 manifest，利用 Docker 层缓存：依赖未变时不重新安装
COPY package.json package-lock.json ./
COPY packages/core/package.json      packages/core/
COPY packages/collector/package.json packages/collector/
COPY packages/matcher/package.json   packages/matcher/
COPY packages/scanner/package.json  packages/scanner/
COPY packages/server/package.json    packages/server/

RUN npm ci --no-audit --no-fund

# 再拷贝源码
COPY packages/ packages/

# 按依赖顺序构建：core → collector → server
RUN npm run build -w @hifan/core \
 && npm run build -w @hifan/collector \
 && npm run build -w @hifan/matcher \
 && npm run build -w @hifan/scanner \
 && npm run build -w @hifan/server

# ── 运行阶段 ────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# 时区（cron 任务依赖本地时区）
ENV TZ=Asia/Shanghai
# tini 作为 init 进程，正确转发信号给 Node（保证 DB 优雅关闭）
RUN apk add --no-cache tzdata tini

WORKDIR /app

# 只拷构建产物 + 生产依赖，不带源码与构建工具
COPY --from=builder /app/node_modules            ./node_modules
COPY --from=builder /app/package.json            ./package.json
COPY --from=builder /app/packages/core/package.json     ./packages/core/package.json
COPY --from=builder /app/packages/core/dist             ./packages/core/dist
COPY --from=builder /app/packages/collector/package.json ./packages/collector/package.json
COPY --from=builder /app/packages/collector/dist         ./packages/collector/dist
COPY --from=builder /app/packages/matcher/package.json   ./packages/matcher/package.json
COPY --from=builder /app/packages/matcher/dist           ./packages/matcher/dist
COPY --from=builder /app/packages/scanner/package.json  ./packages/scanner/package.json
COPY --from=builder /app/packages/scanner/dist          ./packages/scanner/dist
COPY --from=builder /app/packages/server/package.json    ./packages/server/package.json
COPY --from=builder /app/packages/server/dist            ./packages/server/dist

# 前端看板（单文件）
COPY web/ ./web/

# node:sqlite 在 Node 22 标记为 experimental，屏蔽警告噪声
ENV NODE_NO_WARNINGS=1 \
    NODE_ENV=production \
    PORT=8848 \
    HOST=0.0.0.0 \
    WEB_DIST=/app/web

# 数据目录（挂载到宿主机本地卷（⚠️ 网络盘/cifs 会损坏 SQLite））
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8848

ENTRYPOINT ["/sbin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8848/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]