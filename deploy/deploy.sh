#!/usr/bin/env bash
# kremote — push code to the VPS and restart the relay (run from your DEV machine).
#
# Builds the web UI locally (needs the toolchain you already have), then rsyncs
# the relay + shared + built public dir to the VPS. node-pty (agent-only) is
# never sent — the relay is pure JS.
#
# Usage:
#   VPS=root@remote.example.com bash deploy/deploy.sh
#   VPS=root@1.2.3.4 APP_DIR=/opt/kremote bash deploy/deploy.sh
set -euo pipefail

VPS="${VPS:?set VPS=user@host}"
APP_DIR="${APP_DIR:-/opt/kremote}"
SVC_USER="${SVC_USER:-kremote}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

log() { echo -e "\n\033[1;36m[deploy]\033[0m $*"; }

# ── 1. Build the web UI (outputs to packages/relay/public) ─────────────────
log "Building web UI"
( cd "$HERE" && npm run web:build )

# ── 2. rsync only what the relay needs ─────────────────────────────────────
# Trailing slashes matter. --delete keeps the remote tree clean.
log "Syncing to $VPS:$APP_DIR"
ssh "$VPS" "mkdir -p $APP_DIR/packages/relay $APP_DIR/packages/shared $APP_DIR/deploy"

rsync -az --delete \
  --exclude 'node_modules' --exclude 'web' --exclude 'public/*.map' \
  "$HERE/packages/relay/" "$VPS:$APP_DIR/packages/relay/"
rsync -az --delete \
  --exclude 'node_modules' \
  "$HERE/packages/shared/" "$VPS:$APP_DIR/packages/shared/"
rsync -az \
  "$HERE/package.json" "$VPS:$APP_DIR/package.json"
rsync -az --delete \
  "$HERE/deploy/" "$VPS:$APP_DIR/deploy/"

# ── 3. Install relay's runtime deps on the VPS (just `ws`) ──────────────────
# The relay is not installed as an npm workspace on the VPS (agent/web dirs
# aren't shipped), so resolve deps by hand: `ws` in the app-root node_modules
# (Node resolves upward from packages/relay/src), and a symlink for the
# @kremote/shared package import.
log "Installing relay deps on VPS"
WS_VER="$(node -p "require('$HERE/packages/relay/package.json').dependencies.ws")"
ssh "$VPS" bash -s -- "$APP_DIR" "$WS_VER" <<'REMOTE'
set -euo pipefail
APP_DIR="$1"; WS_VER="$2"
cd "$APP_DIR"
npm install --no-save --no-package-lock "ws@$WS_VER"
mkdir -p node_modules/@kremote
ln -sfn ../../packages/shared node_modules/@kremote/shared
REMOTE

# ── 4. Fix ownership + restart ─────────────────────────────────────────────
log "Restarting relay"
ssh "$VPS" "chown -R $SVC_USER:$SVC_USER $APP_DIR && systemctl restart kremote-relay && sleep 1 && systemctl --no-pager --lines=5 status kremote-relay"

log "Done. Health check:"
echo "  curl -sk https://\$DOMAIN/healthz | jq ."
