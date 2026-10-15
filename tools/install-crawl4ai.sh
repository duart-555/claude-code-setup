#!/usr/bin/env bash
# Run Crawl4AI in Docker so the `c4ai-sse` MCP server has something to talk to.
# The container restarts on its own (--restart unless-stopped), and comes back after a reboot as
# soon as Docker itself is running. Idempotent: re-running reuses the existing container.
#
#   ./tools/install-crawl4ai.sh                          # generates a token
#   CRAWL4AI_API_TOKEN=... ./tools/install-crawl4ai.sh   # use your own
set -euo pipefail

NAME="${CRAWL4AI_NAME:-crawl4ai}"
PORT="${CRAWL4AI_PORT:-11235}"
IMAGE="${CRAWL4AI_IMAGE:-unclecode/crawl4ai:latest}"

command -v docker >/dev/null || { echo "docker not found. Install Docker Desktop (macOS/Windows) or docker engine (Linux)." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is installed but not running. Start Docker Desktop and re-run." >&2; exit 1; }

TOKEN="${CRAWL4AI_API_TOKEN:-$(openssl rand -hex 24)}"

if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "container '$NAME' exists; making sure it is running and set to restart"
  docker update --restart unless-stopped "$NAME" >/dev/null
  docker start "$NAME" >/dev/null 2>&1 || true
  echo "token is whatever the container was created with:"
  echo "  docker inspect $NAME --format '{{range .Config.Env}}{{println .}}{{end}}' | grep CRAWL4AI_API_TOKEN"
else
  docker run -d --name "$NAME" \
    --restart unless-stopped \
    -p "127.0.0.1:${PORT}:11235" \
    --shm-size=1g \
    -e "CRAWL4AI_API_TOKEN=${TOKEN}" \
    "$IMAGE" >/dev/null
  echo "started '$NAME' on 127.0.0.1:${PORT}"
  echo "token: ${TOKEN}"
fi

cat <<EOF

Register the MCP server (replace <TOKEN>):
  claude mcp add-json c4ai-sse '{"type":"sse","url":"http://localhost:${PORT}/mcp/sse","headers":{"Authorization":"Bearer <TOKEN>"}}' -s user

Auto-start after a reboot:
  macOS/Windows: Docker Desktop > Settings > General > "Start Docker Desktop when you sign in"
  Linux:         sudo systemctl enable --now docker
Check health:    curl -s http://localhost:${PORT}/health
EOF
