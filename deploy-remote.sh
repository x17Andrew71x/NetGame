#!/bin/bash
set -e

SERVER="andrew@107.161.89.172"
PASS='x58G1@$$@$$1n!'
IMAGE="simple-node-server"

echo "==> Building image for linux/amd64..."
docker build --platform linux/amd64 -t "$IMAGE" .

echo "==> Saving image..."
docker save "$IMAGE" | gzip > /tmp/server-image.tar.gz

echo "==> Uploading to VPS..."
sshpass -p "$PASS" scp /tmp/server-image.tar.gz "$SERVER":~/server-image.tar.gz

echo "==> Loading image and starting container on VPS..."
sshpass -p "$PASS" ssh "$SERVER" bash -s <<'EOF'
sudo docker rm -f node-server 2>/dev/null || true
sudo docker load < ~/server-image.tar.gz
sudo docker run -d --name node-server --restart unless-stopped --network host simple-node-server
echo "==> Container status:"
sudo docker ps --filter "name=node-server"
echo "==> Logs:"
sudo docker logs node-server
EOF

echo "==> Done! Cleaning up..."
rm /tmp/server-image.tar.gz
