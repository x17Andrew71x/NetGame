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
WIN_SSH="/c/Windows/System32/OpenSSH/ssh.exe"
WIN_SCP="/c/Windows/System32/OpenSSH/scp.exe"

PASS_FILE=$(mktemp)
printf '%s' "$DEPLOY_PASSWORD" > "$PASS_FILE"
trap 'rm -f "$PASS_FILE"' EXIT

echo "==> npm run build (updates dist/ for static FTP + Docker build context)..."
(cd "$SCRIPT_DIR" && npm run build)

echo "==> Building image for linux/amd64..."
docker build --platform linux/amd64 -t "$IMAGE" .

echo "==> Saving image..."
docker save "$IMAGE" | gzip > /tmp/server-image.tar.gz

echo "==> Uploading to VPS..."
sshpass -f "$PASS_FILE" -k "$WIN_SCP" /tmp/server-image.tar.gz "$SERVER":~/server-image.tar.gz

echo "==> Loading image and starting container on VPS..."
sshpass -f "$PASS_FILE" -k "$WIN_SSH" "$SERVER" bash -s <<REMOTE_EOF
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

echo "==> Done! Cleaning up Docker artifact..."
rm /tmp/server-image.tar.gz

# ---- Optional: static frontend over FTP (different host than game API server) ----
FTP_HOST="$(load_env_var FTP_HOST "$ENV_FILE")"
FTP_USER="$(load_env_var FTP_USER "$ENV_FILE")"
FTP_PASS="$(load_env_var FTP_PASS "$ENV_FILE")"
FTP_FOLDER="$(load_env_var FTP_FOLDER "$ENV_FILE")"

ftp_any_set=""
[[ -n "$FTP_HOST" || -n "$FTP_USER" || -n "$FTP_PASS" || -n "$FTP_FOLDER" ]] && ftp_any_set=1

if [[ -n "$ftp_any_set" ]]; then
  if [[ -z "$FTP_HOST" || -z "$FTP_USER" || -z "$FTP_PASS" || -z "$FTP_FOLDER" ]]; then
    echo "Error: set all four FTP_HOST, FTP_USER, FTP_PASS, and FTP_FOLDER, or leave all empty to skip FTP." >&2
    exit 1
  fi
  if [[ ! -d "$SCRIPT_DIR/dist" ]]; then
    echo "Error: dist/ missing after build." >&2
    exit 1
  fi

  echo "==> Deploying dist/ to static host via FTP ($FTP_HOST) → $FTP_FOLDER ..."

  PYTHON=""
  if command -v python >/dev/null 2>&1 && python --version >/dev/null 2>&1; then PYTHON=python;
  elif command -v python3 >/dev/null 2>&1 && python3 --version >/dev/null 2>&1; then PYTHON=python3;
  else echo "Error: python is required for FTP deploy." >&2; exit 1; fi

  export _DEPLOY_FTP_HOST="$FTP_HOST"
  export _DEPLOY_FTP_USER="$FTP_USER"
  export _DEPLOY_FTP_PASS="$FTP_PASS"
  export _DEPLOY_FTP_FOLDER="$FTP_FOLDER"
  export _DEPLOY_DIST="$SCRIPT_DIR/dist"
  "$PYTHON" - <<'PY'
import ftplib
import os
import shlex
import shutil
import subprocess
from pathlib import Path
from urllib.parse import quote

host = os.environ["_DEPLOY_FTP_HOST"]
user = os.environ["_DEPLOY_FTP_USER"]
password = os.environ["_DEPLOY_FTP_PASS"]
remote_base = os.environ["_DEPLOY_FTP_FOLDER"].replace("\\", "/").strip()
local_root = Path(os.environ["_DEPLOY_DIST"]).resolve()

def cwd_remote_path(ftp: ftplib.FTP, path: str) -> None:
    ftp.cwd("/")
    if not path or path == "/":
        return
    for seg in [p for p in path.split("/") if p]:
        try:
            ftp.mkd(seg)
        except ftplib.error_perm as e:
            if "550" not in str(e) and "521" not in str(e):
                raise
        ftp.cwd(seg)

def upload_tree(ftp: ftplib.FTP, local: Path) -> None:
    for child in sorted(local.iterdir()):
        if child.is_file():
            with open(child, "rb") as f:
                ftp.storbinary(f"STOR {child.name}", f)
        elif child.is_dir():
            try:
                ftp.mkd(child.name)
            except ftplib.error_perm as e:
                if "550" not in str(e) and "521" not in str(e):
                    raise
            ftp.cwd(child.name)
            upload_tree(ftp, child)
            ftp.cwd("..")

lftp_bin = shutil.which("lftp")
lftp_ok = False
if lftp_bin:
    uq = quote(user, safe="")
    pq = quote(password, safe="")
    url = f"ftp://{uq}:{pq}@{host}/"
    lines = [
        "set cmd:fail-exit yes",
        "set net:max-retries 3",
        "set ftp:ssl-allow no",
        "set ftp:passive-mode true",
        f"open {url}",
        f"cd {shlex.quote(remote_base)}",
        f"lcd {shlex.quote(str(local_root))}",
        "mirror -R --delete --parallel=4 --verbose .",
        "quit",
        "",
    ]
    script = "\n".join(lines)
    r = subprocess.run([lftp_bin, "-f", "/dev/stdin"], input=script.encode(), check=False)
    lftp_ok = r.returncode == 0
    if lftp_ok:
        print("FTP deploy finished (lftp mirror --delete).")
    else:
        print("lftp failed (exit %s); falling back to ftplib (no remote file delete)." % r.returncode)

if not lftp_ok:
    ftp = ftplib.FTP(host, timeout=180)
    ftp.login(user, password)
    ftp.set_pasv(True)
    cwd_remote_path(ftp, remote_base)
    upload_tree(ftp, local_root)
    ftp.quit()
    print("FTP deploy finished (ftplib). Old files not in dist/ were not removed.")
PY
  unset _DEPLOY_FTP_HOST _DEPLOY_FTP_USER _DEPLOY_FTP_PASS _DEPLOY_FTP_FOLDER _DEPLOY_DIST
else
  echo "==> Skipping FTP static deploy (set FTP_HOST, FTP_USER, FTP_PASS, FTP_FOLDER in .env to enable)."
fi

echo "==> All deploy steps complete."
