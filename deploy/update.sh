#!/usr/bin/env bash
# kremote — update the relay to the latest code (run ON the VPS).
#
#   git pull → npm install → rebuild web → restart service. That's it.
#
# Usage (on the VPS):
#   bash /opt/kremote/deploy/update.sh
#   sudo bash /opt/kremote/deploy/update.sh   (needs root to restart the service)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/kremote}"
BRANCH="${BRANCH:-feat/terminal-mvp}"
SVC_USER="${SVC_USER:-kremote}"

log() { echo -e "\n\033[1;36m[update]\033[0m $*"; }

cd "$APP_DIR"
log "Pulling latest $BRANCH"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

log "Installing deps + rebuilding web UI"
npm install
npm run web:build

chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"

log "Restarting relay"
systemctl restart kremote-relay
sleep 1
systemctl --no-pager --lines=6 status kremote-relay || true

log "Done."
