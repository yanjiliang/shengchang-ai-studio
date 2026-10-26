#!/bin/sh
# Start the local Breeze-TTS-2 (MLX) service on 127.0.0.1:${BREEZE_PORT:-4180}
cd "$(dirname "$0")"
mkdir -p logs
if [ ! -x .venv/bin/python ]; then echo "missing .venv: see README 「安装 Breeze」"; exit 1; fi
if lsof -nP -iTCP:${BREEZE_PORT:-4180} -sTCP:LISTEN >/dev/null 2>&1; then echo "port ${BREEZE_PORT:-4180} already in use"; exit 1; fi
BREEZE_RAW_DIR="${BREEZE_RAW_DIR:-}" nohup .venv/bin/python server.py >> logs/server.log 2>&1 &
echo $! > logs/server.pid; echo "started pid $(cat logs/server.pid); log: logs/server.log"
