# 声场 Docker 镜像：Node 22 + FFmpeg，单端口运行（服务端直接托管构建产物）。
# 以非 root 的 node 用户运行：凭证在 /home/node/.shengchang，数据在 /app/.runtime。
# 构建：docker build -t shengchang .
# 运行：docker run -p 4174:4174 \
#         -v shengchang-runtime:/app/.runtime \
#         -v shengchang-config:/home/node/.shengchang \
#         shengchang
# 数据卷说明见 README「Docker 运行」一节。
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Pre-create both volume mountpoints with node ownership: Docker creates
# missing mountpoints as root, which would block the non-root runtime user
# from writing its config; pre-existing dirs are copied into fresh named
# volumes together with their ownership.
RUN npm run build \
  && mkdir -p /app/.runtime /home/node/.shengchang \
  && chown -R node:node /app/.runtime /home/node/.shengchang

USER node
ENV SHENGCHANG_API_PORT=4174
ENV NODE_ENV=production
EXPOSE 4174
CMD ["node", "server/index.js"]
