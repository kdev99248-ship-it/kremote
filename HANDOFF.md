# Handoff: kremote — Session picker (attach live terminals from any device)

**Generated**: 2026-09-10
**Branch**: `feat/terminal-mvp`
**Status**: Ready for Review — code complete, committed (`1e2d4c4`), NOT pushed, NOT deployed.

## Goal

Open kremote on a phone and see/attach the terminal sessions left running on the
PC (e.g. `claude` started earlier). Phase 1: a **Sessions picker** listing every
live pty with its running program, cwd and idle time; tap to attach.

## Completed

- [x] **Agent tracks program + activity per pty** (`packages/agent/src/term.ts`):
      `lastActivity` (epoch ms of last output) and `title` (last OSC window title)
      per terminal; `parseOscTitle()` helper.
- [x] **Protocol** (`packages/shared/src/protocol.ts`): `term.list.res.terms[]`
      gains `title?` + `lastActivity?` (optional → backward compatible).
- [x] **Web Sessions picker** (`index.html`, `src/main.ts`, `src/style.css`):
      `#sessions-drawer` opened from ••• → 🖥 Sessions; row = program label + cwd +
      idle + "open" marker; tap → focus or attach.
- [x] **`syncTerms()` behavior change**: fresh device no longer auto-spawns a tab
      per live session — own tabs still revive silently; others go to the picker.
- [x] **Tests** `packages/agent/test/term.test.ts` (new). Suite **90/90**,
      `npm run typecheck` + `npm run web:build` clean.
- [x] `docs/progress.md` updated; committed `1e2d4c4` with Co-Authored-By line.

## Not Yet Done

- [ ] **Push** `feat/terminal-mvp` to origin (`git push`).
- [ ] **Deploy to VPS** — `bash deploy/deploy.sh` in an *interactive* terminal
      (SSH password prompt; see the deploy blocker note below, carried from the
      previous batch). Agent + web rebuild from git; no new deps, no relay change.
- [ ] **Real-device E2E** (not yet run — see Resume Instructions §3–6): verify the
      picker shows the right program/idle, fresh device opens the drawer (not
      auto-tabs), reconnect stays silent, empty host opens one tab.

## Failed Approaches (Don't Repeat These)

- **Phase 2 — attaching native terminals started outside kremote (tmux/WSL)**:
  **dropped by the user.** node-pty can only control processes *it* spawned; it
  cannot adopt a foreign console's pty on native Windows, and there's no native
  tmux to reattach to. Phase 1 only covers kremote-spawned ptys (which already
  survive in agent RAM).
- **Auto-attaching every live session as a tab on connect** (the old
  `syncTerms()` behavior): noisy on a phone. Replaced with: revive *this
  browser's own* tabs silently, offer everything else in the picker.
- **Explore subagents** (`Explore`/`general-purpose`) fail here with
  `model_not_found` (HTTP 404, `claude-opus-5`). Explore with Read/Grep/Glob
  directly.

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Agent tracks the OSC window title per pty | The web only derives the program name from xterm's `onTitleChange` for tabs *it* opened. A fresh phone would show "pwsh" for everything, so the source of truth must be the agent. |
| Best-effort title parse (residual tail, no state machine) | A title split across two pty chunks just updates on the next emission — never fatal. Cheap. |
| Fresh device → show picker, not auto-tabs | User explicitly chose "Hiện danh sách để tự chọn" (show a list to pick). |
| Reconnect path left identical | Existing-tab revival (`attachToTerm(info, existing)`) is untouched to avoid regressions; behavior change is scoped to *un-tabbed* live sessions only. |
| Only protocol edit is the two optional fields | `term.attach`/`term.data` etc. unchanged; old clients/agents interop fine. |

## Current State

**Working**: All Phase-1 code compiles and is committed. 90/90 tests pass
(includes a real-pty test that spawns `node -e` and asserts `list()` reports
`title:'claude'`). typecheck + web:build clean.

**Broken**: Nothing known. Not yet exercised in a real browser/phone.

**Uncommitted Changes**: `HANDOFF.md` only (this file). The feature is committed.

## Files to Know

| File | Why It Matters |
|------|----------------|
| `packages/agent/src/term.ts` | `TermManager`; `parseOscTitle()`; `proc.onData` updates `title`/`lastActivity`; `TermInfo`/`TermEntry`. |
| `packages/shared/src/protocol.ts` | `TermListRes.terms[]` now `{termId, shell, cwd, title?, lastActivity?}`. |
| `packages/agent/src/client.ts` | term.list handler (`:173`, `this.terms.list()`) — **unchanged**, new fields flow through automatically. |
| `packages/relay/web/src/main.ts` | `openSessions`/`renderSessions`/`makeSessionRow`/`idleLabel` (~`:1000`); rewritten `syncTerms()` (`:502`); `programFromTitle(raw, shellName)` (`:305`); menu `case 'sessions'` (`:599`). |
| `packages/relay/web/index.html` | `#sessions-drawer` (after `#history-drawer`) + `data-act="sessions"` menu item. |
| `packages/relay/web/src/style.css` | `#sessions-drawer` / `.session-row` / `.session-name` / `.session-meta` (after `.history-empty`). |
| `packages/agent/test/term.test.ts` | New tests (`node --test`). |

## Code Context

**Agent — OSC title parser** (`term.ts`):
```typescript
// Matches OSC 0 / OSC 2 title, BEL (\x07) or ST (ESC \) terminated. Returns the
// LAST title in the chunk, or null. Windows ConPTY uses BEL-terminated ]0;.
export function parseOscTitle(buf: string): string | null {
  const re = /\x1b\]([02]);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let last: string | null = null, m: RegExpExecArray | null;
  while ((m = re.exec(buf)) !== null) last = m[2];
  return last;
}
```
```typescript
export interface TermInfo { termId: string; shell: string; cwd: string; title?: string; lastActivity: number }
interface TermEntry { proc: pty.IPty; info: TermInfo; buffer: string; titleScan: string }
// proc.onData: append+cap buffer; info.lastActivity = Date.now();
//   scan = titleScan + data; if parseOscTitle(scan) !== null → info.title;
//   titleScan = scan.slice(-256)   // residual tail catches split titles
```

**Protocol** (`protocol.ts`):
```typescript
export interface TermListRes {
  type: 'term.list.res'; id: string;
  terms: { termId: string; shell: string; cwd: string; title?: string; lastActivity?: number }[];
}
```

**Web — picker** (`main.ts`). Program label for a row that has no Tab yet:
```typescript
const prog = (info.title && programFromTitle(info.title, shellBaseName(info.shell)))
           || shellBaseName(info.shell);
const openHere = byTermId(info.termId) !== undefined;
// tap → existing ? activate(existing) : attachToTerm(info); then switchView('terminals')
```
`idleLabel(lastActivity?)` → `''` (no data) / `active` (<60s) / `idle Nm` / `idle Nh` / `idle Nd`.

`syncTerms()` (the behavior change):
```typescript
for (const tab of [...tabs]) if (tab.termId && !liveIds.has(tab.termId)) markDead(tab);
for (const info of live) { const ex = byTermId(info.termId); if (ex) await attachToTerm(info, ex); }
if (tabs.some(t => !t.dead)) return;              // already on a live tab
const untabbed = live.filter(i => !byTermId(i.termId));
if (untabbed.length) openSessions(); else void newTab();
```

**Non-obvious**:
- The `••• ` menu handler calls `e.stopPropagation()`, so opening a drawer from a
  menu item doesn't immediately trip that surface's outside-close listener
  (same pattern as history/settings).
- `programFromTitle` returns `''` for path-like titles (pwsh/cmd set cwd as the
  title) and maps "windows powershell"/"cmd" → the shell base name.
- The picker sorts most-recently-active first (`lastActivity` desc).

## Resume Instructions

1. Sanity check (optional): `npm run typecheck && npm test && npm run web:build`
   - Expected: clean, **90/90**. `npm test` runs a real pty (`node -e`); if
     node-pty can't spawn in the env the pty test *skips* (guarded), not fails.
2. Push + deploy: `git push`, then in an **interactive** terminal
   `bash deploy/deploy.sh` (reads `deploy/deploy.env`, or
   `VPS=root@163.61.73.198 bash deploy/deploy.sh`); type the SSH password.
   - If `Permission denied (publickey,password)`: add your pubkey to the VPS
     `~/.ssh/authorized_keys` once, then re-run.
3. **Picker + metadata** (PC browser): open 2 terminals; run `claude` (or any
   program that sets an OSC title) in one. ••• → Sessions.
   - Expected: 2 rows; the claude one shows **claude** (not pwsh) + cwd + idle;
     the just-used one shows **active**.
   - If it shows "pwsh": the agent didn't capture the title — check `entry.title`
     is set in `proc.onData` and that `term.list.res` carries it.
4. **Fresh device pick**: open kremote in a second browser/incognito.
   - Expected: it does **not** auto-open tabs; the **Sessions drawer appears**
     with both live sessions. Tap the claude row → a tab opens with scrollback
     replayed; you can type.
5. **Reconnect unchanged**: on a browser that already has tabs, drop the socket
   (DevTools offline ~2s, back online).
   - Expected: tabs revive silently (`attachToTerm(info, existing)`) — no picker,
     no dupes.
6. **Empty host**: no terminals running, fresh connect.
   - Expected: one new tab opens (unchanged fallback).

## Edge Cases & Error Handling

- **Title split across two pty chunks** → caught on the next chunk via the 256-char
  `titleScan` tail; worst case the label lags one emission. Never fatal.
- **`term.list` rejects mid-reconnect** → `syncTerms()` returns early; `onClosed`
  drives the next reconnect. Picker `openSessions()` shows "Could not load sessions".
- **No live sessions** → picker shows "No live sessions on the host".
- **Session exits while its picker row is on screen** → tapping calls
  `attachToTerm`, which will fail server-side (unknown termId); the row is stale
  until Refresh. (Minor; not specially handled.)
- **Old agent, new web** → `title`/`lastActivity` just `undefined`: label falls
  back to the shell name, idle label is `''`. Fine.

## Warnings

- **Do NOT re-introduce auto-attach** in `syncTerms()` for un-tabbed sessions —
  that regression is the whole point of this change.
- `npm install` (plain) triggers node-pty's blocked native scripts (see memory
  `kremote-node-pty-install`). This feature added **no deps**, so you shouldn't
  need to install anything.
- Windows line endings: `git` warns "LF will be replaced by CRLF" on add — cosmetic.
- Deploy is unchanged from the previous batch: agent + web rebuild from git, relay
  untouched. Port 8787 is taken locally (memory) — use a spare port for local runs.
