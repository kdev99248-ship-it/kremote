# Deploying the kremote relay to a VPS

The **relay** runs on a cheap public VPS (Ubuntu/Debian). It's pure JS — only
the `ws` dependency — so no native build tools are needed. TLS terminates in
Node itself on `:443` (no reverse proxy); Let's Encrypt renewals hot-reload the
cert with no restart. The **agent** stays on your Windows machine and dials out.

```
[Windows agent]  ──wss dial-out──▶  [VPS relay :443]  ◀──wss──  [Phone/browser]
 node-pty, fs, git                   pairing + web UI            xterm + CodeMirror
```

## Prerequisites

- A VPS with a public IP, ports **80** (ACME challenge) and **443** open.
- A DNS **A record** pointing your domain (e.g. `remote.example.com`) at the VPS.
- SSH access as root (or a sudo user).
- On your dev machine: `rsync`, `ssh`, and the repo's web toolchain (`npm`).

## 1. Provision the VPS (once)

Copy the repo (or at least `deploy/`, `packages/relay`, `packages/shared`) to the
VPS, then:

```bash
sudo DOMAIN=remote.example.com EMAIL=you@example.com bash deploy/setup-vps.sh
```

This installs Node 24 + certbot, creates the `kremote` service user, issues the
TLS cert, installs a renewal hook that copies certs into `/etc/kremote/tls/`
(which the relay watches), and installs the `kremote-relay` systemd unit +
`/etc/kremote/relay.env`.

## 2. Push code from your dev machine

```bash
VPS=root@remote.example.com bash deploy/deploy.sh
```

Builds the web UI locally, rsyncs `relay` + `shared` + `public` to the VPS,
installs `ws`, and restarts the service. Re-run this on every code change.

## 3. Register your Windows device (once)

On the VPS:

```bash
sudo -u kremote KREMOTE_RELAY_HOME=/home/kremote/.kremote-relay \
  node /opt/kremote/packages/relay/src/keygen.ts my-windows
```

Copy the printed **DEVICE_KEY** into the Windows agent config
(`~/.kremote/config.json`):

```json
{
  "relayUrl": "wss://remote.example.com/ws",
  "deviceKey": "<DEVICE_KEY>",
  "root": "C:/works",
  "label": "my-windows"
}
```

> `relayUrl` must include the **`/ws`** path. `root` uses **forward slashes** on
> Windows.

## 4. Start everything

```bash
# VPS
sudo systemctl start kremote-relay
journalctl -u kremote-relay -f          # watch the audit log

# Windows (agent)
npm run agent                           # prints an ACCESS_KEY + ?key= URL
```

Open `https://remote.example.com/?key=<ACCESS_KEY>` on your phone. The browser
stores a durable session token, so later visits skip the login and reattach the
live terminal.

## Git push credentials (optional)

`git push` runs unattended, so it never prompts. Two ways to authenticate:

1. **SSH remote** — install an SSH key for the `agent`'s OS user; nothing else
   needed (the agent uses `ssh -o BatchMode=yes`).
2. **HTTPS PAT** — add to the agent config, or set env vars for the agent:

   ```json
   { "gitCredentials": { "username": "x-access-token", "token": "ghp_…" } }
   ```

   or `KREMOTE_GIT_TOKEN=ghp_…` (and optional `KREMOTE_GIT_USER=…`). The token
   is fed to git via an in-process credential helper — never written to disk or
   passed on the command line. A bad/missing token surfaces as a clear
   "authentication failed" error in the git panel (no hang).

## Verify / troubleshoot

```bash
curl -sk https://remote.example.com/healthz | jq .   # {ok, ...relay.stats, guard.stats}
systemctl status kremote-relay
journalctl -u kremote-relay -n 100 --no-pager
```

- **Port 443 bind fails**: the unit grants `CAP_NET_BIND_SERVICE`; if it still
  fails, `setcap cap_net_bind_service=+ep $(command -v node)`.
- **Cert renewal**: `certbot renew --dry-run`; the deploy hook lives at
  `/etc/letsencrypt/renewal-hooks/deploy/kremote-copy-certs.sh`. After a real
  renewal the relay logs `tls-reload`.
- **Locked out by the brute-force guard**: wait `KREMOTE_BLOCK_MS` (default 5m)
  or restart the service.
