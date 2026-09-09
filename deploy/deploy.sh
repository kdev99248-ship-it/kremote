#!/usr/bin/env bash
# kremote — one-command update from your DEV machine (optional convenience).
#
#   Pushes your current branch to GitHub, then SSHes into the VPS and runs
#   update.sh there (git pull + rebuild + restart). Nothing is built or copied
#   locally — the VPS builds from git.
#
# Usage (from your dev machine, in the repo):
#   VPS=root@1.2.3.4 bash deploy/deploy.sh
#   VPS=root@1.2.3.4 APP_DIR=/opt/kremote BRANCH=feat/terminal-mvp bash deploy/deploy.sh
set -euo pipefail

VPS="${VPS:?set VPS=user@host}"
APP_DIR="${APP_DIR:-/opt/kremote}"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

log() { echo -e "\n\033[1;36m[deploy]\033[0m $*"; }

log "Pushing $BRANCH to origin"
git push origin "$BRANCH"

log "Updating VPS ($VPS) from git"
ssh "$VPS" "APP_DIR=$APP_DIR BRANCH=$BRANCH bash $APP_DIR/deploy/update.sh"

log "Done."
