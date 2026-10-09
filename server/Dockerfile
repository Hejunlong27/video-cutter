# ---------- 构建阶段 ----------
FROM node:20-bookworm-slim AS build

WORKDIR /app

# 先装依赖，利用 Docker 层缓存
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm install

# 编译 TS
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:20-bookworm-slim AS runtime

# 镜像内安装 ffmpeg / ffprobe
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    STORAGE_ROOT=/data \
    DATABASE_URL="file:/data/app.db" \
    FFMPEG_PATH=ffmpeg \
    FFPROBE_PATH=ffprobe \
    PORT=4000

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./

# 数据目录（挂载 volume 时会被覆盖）
RUN mkdir -p /data/uploads /data/tasks /data/tmp

EXPOSE 4000

# db push 幂等：确保 SQLite 表结构存在后再启动服务
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node dist/index.js"]
