# Handoff: kremote — Home screen, full-screen terminal, QR login

**Generated**: 2026-09-10
**Branch**: `feat/terminal-mvp`
**Status**: Code complete, verified E2E in a real browser. NOT pushed, NOT deployed.

## Goal

Drop the session tab strip. Navigation is now two levels:

- **Home / Files / Git / Logs** — the browsing screens, sharing one top bar.
  Home lists the live sessions on the host and has a `＋ New session` button.
- **Terminal** — tapping a session row opens a screen with *no* view switcher and
  *no* tab strip: just a slim bar (‹ back · title · badge · ✕ kill) and the pty
  filling the rest of the viewport.

Plus: the installed PWA can **scan the QR** the agent prints, instead of needing
an address bar to paste `?key=` into.

## Completed

- [x] **Home view** (`#home`): live pty list from `term.list` — program label,
      cwd, idle, "open here" flag; per-row ✕ kills the pty (even one this browser
      never opened); `＋ New session`; re-polls every 10s while Home is visible
      and the page is not hidden.
- [x] **Terminal screen** (`#terminals` + `#term-bar` + `#term-stack`): full-bleed
      xterm, macOS window chrome removed. `#app[data-view="term"]` is the CSS
      switch that hides the top bar and shows `#mobile-keys` / `#composer`.
- [x] **`Tab` → `Pane`**: no per-session tab button. Panes live in `#term-stack`,
      keep their scrollback in the background; Home is the only session switcher.
      Badge/title paint into the one shared bar.
- [x] **Failed attach no longer leaves a husk**: `attachToTerm()` returns
      `boolean`; a stale row discards the just-built pane (`discardPane()`), stays
      on Home and repaints the list.
- [x] **`syncTerms()`**: a reconnect no longer yanks the user off Files/Git/Logs.
      Home is forced only from a terminal screen whose pane is dead.
- [x] **QR login** (`src/qrscan.ts` + "Scan QR code" on the login screen):
      `BarcodeDetector` first, lazy `import('jsqr')` fallback (separate ~47KB gz
      chunk), frames downscaled to ≤640px, 6 scans/s. `parseQrPayload()` accepts
      only a `?key=` URL or a bare key.
- [x] **Tests** `packages/relay/web/test/qrscan.test.ts` (new; root `npm test`
      glob extended to `packages/relay/web/test/*.test.ts`). Suite **97/97**,
      `npm run typecheck` + `npm run web:build` clean.
- [x] `docs/progress.md` updated.

## Not Yet Done

- [ ] **Commit + push** `feat/terminal-mvp`.
- [ ] **Deploy to VPS** — `bash deploy/deploy.sh` in an *interactive* terminal
      (SSH password prompt). **One new dep this time** (`jsqr` in
      `packages/relay/web`); `deploy/update.sh:28-29` already runs `npm install`
      then `npm run web:build`, so the deploy scripts need no change.
- [ ] **Real-device checks** that a desktop browser cannot cover: the QR scanner
      against a real phone camera (Chromium here has no `BarcodeDetector`, so only
      the jsQR path was exercised), and the mobile keys / composer row on a coarse
      pointer (they are `display:none` under `pointer: fine`).

## Failed Approaches (Don't Repeat These)

- **Two agents against one relay**: `pkill -f packages/agent/src/index.ts` does
  NOT kill the node child on Windows/Git Bash. Two agents sharing a deviceId
  kick each other off in a ~500ms reconnect loop, and `term.attach` then fails
  with "no such terminal" for sessions the *other* agent owns. Find and stop them
  with PowerShell `Get-CimInstance Win32_Process` + `Get-NetTCPConnection`.
- **`heredoc` through the Bash tool** for large HTML: apostrophes in the content
  break the outer quoting. Use the Write tool for whole files, `node -e` with a
  script for surgical replacements.
- **Phase 2 — attaching native terminals started outside kremote (tmux/WSL)**:
  dropped by the user earlier; node-pty cannot adopt a foreign console's pty.
- **Auto-attaching every live session on connect**: replaced long ago by the
  picker, now by Home. Do not bring it back.

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Home is the 4th nav item, not a drawer | User's pick. The session list is a destination, not a transient overlay — and it needs room for per-row actions. |
| Terminal is a screen, not a view | "terminal giờ sẽ full màn hình luôn cho gọn gàng". Hiding the switcher is the point; a tab strip on a phone was noise. |
| Panes stay alive when you leave the terminal | Scrollback and the pty attachment survive a trip to Home/Files, so going back is instant and lossless. |
| Per-row ✕ kills the pty; ‹ back just leaves | Two different intents. Closing the last session must not silently spawn another (the old `closeTab` did). |
| `BarcodeDetector` first, jsQR lazily | Native is free where it exists; iOS Safari/Firefox users get a working scanner without everyone paying 130KB. |
| `parseQrPayload` rejects URLs with no key | It can navigate the browser to another origin. Only a well-formed kremote login URL earns that. |

## Current State

**Working**: everything above, exercised against a real relay + agent in
Playwright — fresh connect lands on Home; new session opens the full-screen
terminal (top bar gone, xterm starts at y=46); an OSC title of `claude` shows on
both the terminal bar and the Home row; a reload (a "fresh device" with 0 panes)
still lists every session and re-attaches with scrollback replayed; both ✕ paths
kill correctly and return Home; clicking a dead row logs
`term.attach rejected: no such terminal`, creates no pane and stays on Home; the
QR overlay opens the camera, loads the jsQR chunk and releases the camera on
close (`srcObject === null`).

**Broken**: nothing known.

**Uncommitted Changes**: everything in this batch (see `git status`).

## Files to Know

| File | Why It Matters |
|------|----------------|
| `packages/relay/web/index.html` | `#home`, `#term-bar`/`#term-stack`, `#qr-scan` overlay, `qr-open` button. `#tabs`/`#new-tab`/`#sessions-drawer` are gone. |
| `packages/relay/web/src/main.ts` | `NAV_VIEWS`/`VIEWS`/`VIEW_ELEMENT` + `switchView` (`:96`), `openPane` (`:133`), `renderTermBar` (`:295`), `createPane` (`:342`), `attachToTerm`/`discardPane` (`:459`), `syncTerms` (`:508`), Home list (`:600`), QR login (`:700`). |
| `packages/relay/web/src/qrscan.ts` | New. `cameraSupported`, `startQrScan`, `parseQrPayload`. |
| `packages/relay/web/src/style.css` | Terminal screen block, `#home`/`.session-*`, `#term-search` (previously unstyled), QR block at the end. |
| `packages/relay/web/test/qrscan.test.ts` | New. Payload parsing + a `qrcode`→`jsqr` round-trip. |
| `package.json` | Test glob now includes `packages/relay/web/test/*.test.ts`. |

## Resume Instructions

1. Sanity check: `npm run typecheck && npm test && npm run web:build`
   — expected clean, **97/97**.
2. `git push`, then deploy in an **interactive** terminal: `bash deploy/deploy.sh`
   (it ssh's in and runs `deploy/update.sh`, which installs deps and rebuilds).
3. On a real phone: install/open the PWA, tap **Scan QR code**, point it at the
   QR `kremote` prints. Expected: it logs in without touching the address bar.
   - Android/Chrome takes the `BarcodeDetector` path; iOS Safari lazy-loads jsQR
     (watch for the `jsQR-*.js` chunk in the network panel).
4. On the phone, check the terminal screen: keys row + ABC composer present, top
   bar absent, ‹ returns to Home with the session still listed and still alive.

## Edge Cases & Error Handling

- **Camera denied / absent** → the hint under the reticle turns amber and says so;
  the key field is still there. `qr-open` is hidden entirely when
  `navigator.mediaDevices.getUserMedia` is missing.
- **QR from a different relay** → navigates to that origin with the key, instead
  of failing the key against this host.
- **Non-kremote QR in frame** → hint says "not a kremote key", scanning continues.
- **Session dies while its Home row is on screen** → tapping it fails the attach,
  discards the pane and repaints the list (verified).
- **Every session gone while a terminal is open** → `syncTerms` sends you Home.
- **Old agent, new web** → `title`/`lastActivity` undefined: the row falls back to
  the shell name with no idle label.

## Warnings

- **Do NOT re-introduce auto-attach or auto-spawn.** Closing the last session
  returns to Home; it must not open a replacement pty.
- `closePane` is for killing a pty; `discardPane` is for dropping a local pane
  only. Don't conflate them.
- The web workspace has **no tsconfig** — `npm run typecheck` does not cover it,
  and vite/esbuild strips types without checking. To type-check it, write a
  throwaway `tsconfig` with `lib: ["es2023","dom"]`; expect pre-existing noise
  from missing `vite/client` types (css imports, `import.meta.env`).
- `npm install` (plain) triggers node-pty's blocked native scripts (memory
  `kremote-node-pty-install`). `jsqr` went in with `--ignore-scripts`, which left
  `node_modules/node-pty/build/Release/*.node` intact.
- Port 8787 is the usual local relay. Test stacks in this session used 8899.
