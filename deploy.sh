#!/bin/bash
set -e

APP_NAME="node-server"
IMAGE_NAME="simple-node-server"

sudo docker build -t "$IMAGE_NAME" .

sudo docker rm -f "$APP_NAME" 2>/dev/null || true

sudo docker run -d \
  --name "$APP_NAME" \
  --restart unless-stopped \
  -p 3000:3000 \
  "$IMAGE_NAME"

sudo docker ps --filter "name=$APP_NAME"
