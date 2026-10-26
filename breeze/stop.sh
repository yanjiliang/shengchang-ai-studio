#!/bin/sh
cd "$(dirname "$0")"
[ -f logs/server.pid ] && kill "$(cat logs/server.pid)" 2>/dev/null && echo "stopped $(cat logs/server.pid)"; rm -f logs/server.pid
