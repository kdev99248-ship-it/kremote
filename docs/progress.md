# kremote — Tiến độ (2026-09-08)

## ✅ Đã hoàn thành

### Build order bước 1–2: Terminal end‑to‑end

- **Spike node-pty**: chạy trên Node v24.20.0 qua prebuilds (ConPTY).  
  - `spawn` + `resize` OK.  
  - Không cần VS Build Tools, không cần fallback Node 22.  
  - **Quirk**: npm chặn install scripts – cần `npm install-scripts approve node-pty`; postinstall thiếu `pty.node`, phải copy thủ công từ `prebuilds/win32-x64/` sang `build/Release/`.

- **Monorepo** (`packages/`):
  - `shared`: giao thức JSON (`term.*`, `hello.*`, `accesskey.*`, `peer.gone`), encode/decode.
  - `relay`: WS server (port 8787), lưu DEVICE_KEY hash, mint ACCESS_KEY một lần, ghép nối browser↔agent, pump frame opaque, giới hạn 4 session/device, sweep idle, serve static kèm traversal guard. CLI `keygen` đăng ký thiết bị.
  - `agent`: client WSS dial‑out + reconnect backoff, quản lý terminal bằng node-pty (mở/đóng/list/input/resize/exit), in ACCESS_KEY, pathguard cho fs.*.
  - `relay/web`: UI Vite vanilla TS – login ACCESS_KEY (prefill ?key=), xterm.js + fit + web‑links, đa tab, hàng phím mobile (Ctrl/Alt/Shift/Esc/Tab/arrows). Build vào `relay/public`.

- **Kiểm thử**: 24/24 pass (`npm test`):
  - protocol round‑trip
  - relay pairing lifecycle (kết nối, ghép, key một lần, agent‑offline → `peer.gone`, reconnect re‑pair, giới hạn session)
  - pathguard (`../`, symlink escape, absolute‑outside‑root, null byte)

- **Smoke test end‑to‑end** thật:
  - Browser → relay → agent → PowerShell thật (`echo WEB_UI_OK; hostname` → DESKTOP‑C9BJLFQ)
  - Multi‑tab độc lập, `peer.gone` khi agent ngắt, dot trạng thái chuyển sang `off`
  - Mobile keys render đúng ở 390px, không overflow

- **Git**:
  - Branch: `feat/terminal-mvp`
  - Commit: `83b5ce0 feat: terminal MVP — relay pairing, agent pty, web terminal`
  - Đã commit tất cả code terminal MVP.

---

## 🔄 Đang làm (bước 3–4)

### Filesystem protocol + agent handlers (task #5)
- Đã mở rộng `packages/shared/src/protocol.ts` với `fs.*` và `git.*` frames, kèm các hằng số giới hạn.
- Đã viết `packages/agent/src/fs.ts`: `FsHandlers` với `list`, `read`, `write` (mtime‑conflict check), `mkdir`, `rename`, `delete`. Tất cả path đều qua `resolveInRootSafe` (lexical + realpath guard). `read` từ chối binary và file > 10 MB; `write` từ chối > 100 KB.
- Đã viết `packages/agent/src/git.ts`: `GitRunner` chạy `git status`, `diff`, `commit`, `push`, `log` với cwd bên trong repo đã resolve qua `FsHandlers`.
- Đã tích hợp vào `AgentClient` (`client.ts`) – xử lý các frame `fs.*` và `git.*` trong `handle()`.
- Test cho `fs.ts` đang được viết (`packages/agent/test/fs.test.ts`).

### Web UI file explorer + CodeMirror (task #6)
- Chưa bắt đầu.

### Git panel (task #7)
- Chưa bắt đầu.

---

## 🧩 Ghi chú cho chạy local

- Port 8787 bị chiếm bởi một process Python (uv) – dùng `KREMOTE_RELAY_PORT=8788`.
- Cần approve esbuild và node-pty trong package.json (`allowScripts`).
- Để chạy:
  ```bash
  KREMOTE_RELAY_HOME=<dir> node packages/relay/src/keygen.ts my-win
  KREMOTE_RELAY_PORT=8788 KREMOTE_RELAY_HOME=<dir> node packages/relay/src/index.ts
  # ghi DEVICE_KEY vào ~/.kremote/config.json
  KREMOTE_AGENT_CONFIG=<cfg.json> node packages/agent/src/index.ts
  ```

---

## 📌 Việc tiếp theo (theo spec)

1. Hoàn thiện test `fs.test.ts`.
2. Xây dựng file tree lazy + CodeMirror editor trong web UI.
3. Tích hợp Git panel (status, diff, commit, push).
4. Thêm test cho git handlers.

---

*Cập nhật lúc 2026-09-08 sau khi commit terminal MVP.*