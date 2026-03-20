#!/bin/bash
set -e

# Load KEY=value from .env (same directory as this script). Values may contain '='.
# Strips one pair of surrounding " or ' if present. Does not expand $ inside values.
load_env_var() {
  local key="$1"
  local file="$2"
  local line val
  line=$(grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null | tail -n 1 | tr -d '\r' || true)
  [[ -z "$line" ]] && return 0
  val="${line#*=}"
  val="${val#\"}"
  val="${val%\"}"
  val="${val#\'}"
  val="${val%\'}"
  printf '%s' "$val"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: missing $ENV_FILE — copy .env.example and set DEPLOY_PASSWORD." >&2
  exit 1
fi

DEPLOY_PASSWORD="$(load_env_var DEPLOY_PASSWORD "$ENV_FILE")"
if [[ -z "$DEPLOY_PASSWORD" ]]; then
  echo "Error: DEPLOY_PASSWORD is empty or missing in $ENV_FILE" >&2
  exit 1
fi

RESTART_TOKEN="$(load_env_var RESTART_TOKEN "$ENV_FILE")"
[[ -z "$RESTART_TOKEN" ]] && RESTART_TOKEN="$DEPLOY_PASSWORD"

SERVER="andrew@107.161.89.172"
IMAGE="simple-node-server"

echo "==> Building image for linux/amd64..."
docker build --platform linux/amd64 -t "$IMAGE" .

echo "==> Saving image..."
docker save "$IMAGE" | gzip > /tmp/server-image.tar.gz

echo "==> Uploading to VPS..."
sshpass -p "$DEPLOY_PASSWORD" scp /tmp/server-image.tar.gz "$SERVER":~/server-image.tar.gz

echo "==> Loading image and starting container on VPS..."
# Unquoted heredoc delimiter so RESTART_TOKEN is expanded locally before SSH (remote has no env).
sshpass -p "$DEPLOY_PASSWORD" ssh "$SERVER" bash -s <<REMOTE_EOF
sudo docker rm -f node-server 2>/dev/null || true
sudo docker load < ~/server-image.tar.gz
sudo docker run -d --name node-server --restart unless-stopped --network host \\
  -e RESTART_TOKEN='${RESTART_TOKEN}' \\
  -e IDLE_RESTART_MS=900000 \\
  simple-node-server
echo "==> Container status:"
sudo docker ps --filter "name=node-server"
echo "==> Logs:"
sudo docker logs node-server
REMOTE_EOF

echo "==> Done! Cleaning up..."
rm /tmp/server-image.tar.gz
