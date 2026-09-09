#!/usr/bin/env bash
# kremote — one-time VPS provisioning (run ON the VPS as root or with sudo).
#
#   Installs Node 24, certbot; creates the `kremote` service user, the store
#   dir, and the TLS drop dir; issues a Let's Encrypt cert; installs the
#   systemd unit + a renewal deploy-hook that hot-swaps the cert.
#
# Usage (on the VPS):
#   sudo DOMAIN=remote.example.com EMAIL=you@example.com bash setup-vps.sh
#
# After this runs once, use deploy/deploy.sh from your dev machine to push code.
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN=your.host}"
EMAIL="${EMAIL:?set EMAIL=you@example.com for the ACME account}"
APP_DIR="${APP_DIR:-/opt/kremote}"
TLS_DIR="${TLS_DIR:-/etc/kremote/tls}"
SVC_USER="${SVC_USER:-kremote}"

log() { echo -e "\n\033[1;36m[setup]\033[0m $*"; }

# ── 1. Node 24 (NodeSource) + certbot ──────────────────────────────────────
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  log "Installing Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
log "node $(node --version), npm $(npm --version)"

if ! command -v certbot >/dev/null; then
  log "Installing certbot"
  apt-get update && apt-get install -y certbot
fi

# ── 2. Service user + directories ──────────────────────────────────────────
if ! id "$SVC_USER" >/dev/null 2>&1; then
  log "Creating service user '$SVC_USER'"
  useradd --system --create-home --shell /usr/sbin/nologin "$SVC_USER"
fi
mkdir -p "$APP_DIR" "$TLS_DIR" "/home/$SVC_USER/.kremote-relay"
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR" "/home/$SVC_USER/.kremote-relay"
chown -R "$SVC_USER:$SVC_USER" "$TLS_DIR"
chmod 750 "$TLS_DIR"

# ── 3. Firewall (best-effort) ──────────────────────────────────────────────
if command -v ufw >/dev/null; then
  log "Opening ports 80 (ACME) + 443 (relay) in ufw"
  ufw allow 80/tcp  || true
  ufw allow 443/tcp || true
fi

# ── 4. Issue the TLS cert (standalone; needs port 80 free momentarily) ─────
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  log "Issuing Let's Encrypt cert for $DOMAIN"
  certbot certonly --standalone --non-interactive --agree-tos \
    -m "$EMAIL" -d "$DOMAIN"
fi

# ── 5. Renewal deploy-hook: copy certs where the relay user can read them ──
# The relay watches $TLS_DIR/{fullchain.pem,privkey.pem} and hot-reloads via
# setSecureContext, so a renewal needs no restart — the copy alone triggers it.
HOOK="/etc/letsencrypt/renewal-hooks/deploy/kremote-copy-certs.sh"
mkdir -p "$(dirname "$HOOK")"
cat > "$HOOK" <<HOOK_EOF
#!/usr/bin/env bash
set -euo pipefail
install -o "$SVC_USER" -g "$SVC_USER" -m 644 \
  "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$TLS_DIR/fullchain.pem"
install -o "$SVC_USER" -g "$SVC_USER" -m 640 \
  "/etc/letsencrypt/live/$DOMAIN/privkey.pem"   "$TLS_DIR/privkey.pem"
HOOK_EOF
chmod +x "$HOOK"
log "Installed renewal hook: $HOOK"
# Run it once now to seed $TLS_DIR.
bash "$HOOK"

# ── 6. systemd unit + env file ─────────────────────────────────────────────
log "Installing systemd unit"
sed -e "s#@APP_DIR@#$APP_DIR#g" -e "s#@SVC_USER@#$SVC_USER#g" \
  "$(dirname "$0")/kremote-relay.service" > /etc/systemd/system/kremote-relay.service

ENV_FILE="/etc/kremote/relay.env"
if [ ! -f "$ENV_FILE" ]; then
  log "Writing $ENV_FILE (edit it, then: systemctl restart kremote-relay)"
  cat > "$ENV_FILE" <<ENV_EOF
# kremote relay environment — see deploy/relay.env.example for all knobs.
KREMOTE_RELAY_HOST=0.0.0.0
KREMOTE_RELAY_PORT=443
KREMOTE_TLS_CERT=$TLS_DIR/fullchain.pem
KREMOTE_TLS_KEY=$TLS_DIR/privkey.pem
KREMOTE_RELAY_HOME=/home/$SVC_USER/.kremote-relay
ENV_EOF
  chmod 640 "$ENV_FILE"
  chown root:"$SVC_USER" "$ENV_FILE"
fi

# Let the service bind :443 as a non-root user.
setcap 'cap_net_bind_service=+ep' "$(command -v node)" || \
  log "WARN: setcap failed; :443 bind may need AmbientCapabilities (already in unit)"

systemctl daemon-reload
systemctl enable kremote-relay >/dev/null 2>&1 || true

log "Provisioning done."
echo "  Next:"
echo "   1) Push code:   deploy/deploy.sh  (from your dev machine)"
echo "   2) Register a device on the VPS:"
echo "        sudo -u $SVC_USER KREMOTE_RELAY_HOME=/home/$SVC_USER/.kremote-relay \\"
echo "          node $APP_DIR/packages/relay/src/keygen.ts my-windows"
echo "   3) Put the printed DEVICE_KEY in the Windows agent config."
echo "   4) systemctl start kremote-relay && journalctl -u kremote-relay -f"
