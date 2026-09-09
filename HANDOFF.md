# Handoff: kremote — 9Remote-style web UI clone + mobile responsive

**Generated**: 2026-09-09
**Branch**: `feat/terminal-mvp`
**Status**: Ready for Review (MVP verified on emulator; not yet tested on a real phone / real VPS)

## Goal

kremote = personal remote-access tool (terminal + file explorer + git, driven from a browser),
modeled on **9Remote** (docs.9remote.cc). Single-owner, no SaaS relay. This session's active
question: is the web UI a faithful clone of 9Remote's look **and** excellently mobile-responsive?
Verdict reached: **yes at MVP level** — verified via Playwright at 390px, no real-device test yet.

## Completed

- [x] Terminal end-to-end (relay pairing → agent node-pty → xterm.js), multi-tab, mobile key row.
- [x] Filesystem: agent `fs.*` handlers (list/read/write/mkdir/rename/delete) behind path guard.
- [x] Git: agent `git.*` handlers (status/diff/commit/push/log) with cwd inside resolved repo.
- [x] Web file explorer (`FileTree`) + CodeMirror editor (`Editor`) + git panel (`GitPanel`).
- [x] **Code-split**: `editor.ts` is a lazy chunk; per-language packs lazy too. Main bundle 315 kB
      (xterm only), editor 411 kB on demand — no chunk >500 kB, 984 kB single-chunk warning gone.
- [x] Tests 46/46 (`npm test`): protocol, relay pairing lifecycle, pathguard, fs/git/config handlers.
- [x] Playwright smoke 13/13 (real relay 8789 ↔ agent ↔ repo): login, terminal, tree, lazy editor
      chunk, save bar, json language chunk, git branch/sync/changed-files/diff, view switching.
- [x] Mobile assessment at 390px (iPhone 12): 5 screenshots (login/terminal/files-tree/editor/git),
      **no horizontal overflow** (scrollW == clientW == 390), 9Remote dark theme + coral accent,
      editor slides over tree with back chevron, mobile key row on terminal view only.
- [x] Committed as `c678d4a`; `docs/progress.md` updated.

## Not Yet Done

- [ ] `git push` credential handling (SSH/PAT) — currently runs raw `git push`.
- [ ] Deploy to VPS + test from a **real phone** (only emulator-verified so far).

> File ops UI (mkdir/rename/delete) — **DONE** since this handoff was written (see
> `docs/progress.md` mục 🖱). Smoke-tested in a real browser; also fixed two bugs found
> during that smoke: (1) notice banner was wiped instantly by the re-render, (2) 28px
> horizontal overflow on mobile caused by the hidden `#editor` slide-over's
> `translateX(28px)` — fixed with `#files { overflow: hidden }` in the mobile breakpoint.
> Note: the earlier "no horizontal overflow at 390px" claim was measured on the Term view
> only; re-measure per view after UI changes.

## Failed Approaches (Don't Repeat These)

- **Port 8788 / 8787**: frequently occupied (old relay pid 13348 from this repo — deliberately NOT
  killed since not started by us; also Python uv). → Use `KREMOTE_RELAY_PORT=8789`.
- **Agent config JSON with backslash root** (`"C:\works\kremote"`) → `Bad escaped character in JSON
  at position 107`. → Use forward slashes: `"root": "C:/works/kremote"`.
- **Node resolving `/tmp`** on Windows → `C:\tmp` ENOENT. → Use full Windows temp path
  `C:/Users/kdev9/AppData/Local/Temp/...`.
- **Playwright `getByRole('button', {name:'Term'})`** matched both view-btn "Term" and the new-tab
  button (aria-label "New terminal") → strict-mode violation. → `{ name: 'Term', exact: true }`.
- **ACCESS_KEY reuse**: one-time, 5-min expiry. → Restart agent to mint a fresh key before each
  Playwright run.

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| `editor.ts` split from `files.ts` as lazy chunk | CodeMirror ~800 kB dominated bundle; only load on first file click |
| `guessLanguage` async w/ dynamic import per lang | Each language pack becomes its own chunk (26–85 kB) |
| Do not kill pre-existing relay (pid 13348) | Not started by us; only clean up our own smoke processes |
| Verdict "MVP done" not "fully done" | Only emulator-verified; real-phone/VPS test outstanding |

## Current State

**Working**: terminal, files (tree + lazy CodeMirror), git panel — all end-to-end over real
relay↔agent↔repo. UI matches 9Remote (dark `#040404`, coral `#e46c4c`, green live dot, rounded
segmented tabs). Mobile clean at 390px.

**Broken**: nothing known.

**Uncommitted Changes**: `files.ts` + `style.css` (file ops UI + 2 fixes) ready to commit;
untracked `.claude/`, `.tmp-relay-home/` (DEVICE_KEY store — never commit), `.tmp-sandbox/`,
`HANDOFF.md`.

## Files to Know

| File | Why It Matters |
|------|----------------|
| `packages/shared/src/protocol.ts` | JSON frame protocol (`term.*`, `fs.*`, `git.*`, `hello.*`, `accesskey.*`, `peer.gone`) + limits |
| `packages/agent/src/fs.ts` | `FsHandlers` — all paths via `resolveInRootSafe` (lexical + realpath guard) |
| `packages/agent/src/git.ts` | `GitRunner` — status/diff/commit/push/log inside resolved repo |
| `packages/agent/src/client.ts` | `AgentClient` dispatches `fs.*` / `git.*` / `term.*` frames |
| `packages/relay/web/src/files.ts` | `FileTree` + `loadEditor()` lazy loader |
| `packages/relay/web/src/editor.ts` | `Editor` (CodeMirror, lazy chunk) — async `guessLanguage` |
| `packages/relay/web/src/git.ts` | `GitPanel` — branch/status/diff/commit/push UI |
| `packages/relay/web/src/main.ts` | View switching, tabs, lazy `openFile`, mobile keys |
| `packages/relay/web/src/style.css` | Breakpoints: max-width 700/400px, pointer:coarse, hover:none |
| `docs/progress.md` | Current progress log (Vietnamese) |
| `docs/superpowers/specs/2026-09-08-kremote-design.md` | Design spec ("Modeled on 9Remote") |

## Code Context

**Lazy editor loader** (`files.ts`):
```typescript
export async function loadEditor(container: HTMLElement, opts?: EditorOpts): Promise<Editor> {
  editorModule ??= import('./editor');       // CodeMirror chunk fetched once
  const { Editor } = await editorModule;
  return new Editor(container, opts);
}
```

**Lazy openFile** (`main.ts`): first click fetches the editor chunk, later clicks reuse it:
```typescript
let editorReady: Promise<Editor> | null = null;
async function openFile(path: string): Promise<void> {
  editorReady ??= loadEditor($('editor'), { onSave: () => fileTree?.refresh() });
  const ed = await editorReady;
  await ed.openFile(path);
}
```

**Per-language dynamic import** (`editor.ts`):
```typescript
private async guessLanguage(path: string): Promise<LanguageSupport[]> {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'js': case 'ts': case 'jsx': case 'tsx': {
      const { javascript } = await import('@codemirror/lang-javascript');
      return [javascript()];
    }
    // json, html, css, md, py, sh/bash (shell via StreamLanguage) …
  }
}
```

## Resume Instructions

Run relay + agent locally (Windows, PowerShell or bash):

1. Mint device key: `KREMOTE_RELAY_HOME=<dir> node packages/relay/src/keygen.ts my-win`
2. Start relay: `KREMOTE_RELAY_PORT=8789 KREMOTE_RELAY_HOME=<dir> node packages/relay/src/index.ts`
3. Put printed DEVICE_KEY into agent config JSON (`root` must use **forward slashes**):
   `{ "relayUrl": "ws://127.0.0.1:8789", "deviceKey": "…", "root": "C:/works/kremote" }`
4. Start agent: `KREMOTE_AGENT_CONFIG=<cfg.json> node packages/agent/src/index.ts`
   - Agent prints an ACCESS_KEY (one-time, 5-min expiry) and a `?key=…` URL.
5. Open the URL in a browser (or `http://127.0.0.1:8789/?key=<KEY>`).
   - Expected: login auto-submits, green conn dot, a terminal tab boots into PowerShell.
   - If login fails: the key likely expired — restart the agent for a fresh key.
6. Build web after edits: `npm run -w packages/relay/web build` (outputs to `packages/relay/public`).
7. Tests: `npm test` — expect **46/46**.

To re-run the mobile check: mint fresh key, then
`KREMOTE_KEY=<KEY> PW_ARTIFACT_DIR=<dir> node <skill>/run.js <mobile.js>` (390px, isMobile/hasTouch).
Expect `body overflow-x: {"overflowX": false}`.

## Warnings

- **ACCESS_KEY is one-time + 5-min** — always restart the agent before a fresh browser/Playwright run.
- **Agent config `relayUrl` needs the `/ws` path** (`ws://127.0.0.1:8789/ws`) — bare origin gives
  `Unexpected server response: 400` with a 30s reconnect loop.
- **`deviceKey` printed by keygen is one-time readable** — if lost, re-run keygen (old key's hash stays but is useless).
- **Config `root` needs forward slashes** on Windows, else JSON escape error.
- **Don't kill relay pid 13348** (or any relay not started this session) — only clean up your own
  smoke processes (this session used relay pid on port 8789 + its agent).
- `.playwright-mcp`, `.tmp-agent-root`, `.tmp-tscheck`, `.serena`, `packages/relay/public` are
  gitignored — verify before committing. Also never commit `.tmp-relay-home/` (holds DEVICE_KEY).
- User communicates in **Vietnamese**; `docs/progress.md` is in Vietnamese.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
