# 声场 Docker 镜像：Node 22 + FFmpeg，单端口运行（服务端直接托管构建产物）。
# 构建：docker build -t shengchang .
# 运行：docker run -p 4174:4174 \
#         -v shengchang-runtime:/app/.runtime \
#         -v shengchang-config:/root/.shengchang \
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
RUN npm run build

ENV SHENGCHANG_API_PORT=4174
ENV NODE_ENV=production
EXPOSE 4174
CMD ["node", "server/index.js"]
