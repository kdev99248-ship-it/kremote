# kremote — Tiến độ (2026-09-09)

## ✅ Đã hoàn thành

### Build order bước 1–2: Terminal end‑to‑end

- **Spike node-pty**: chạy trên Node v24.20.0 qua prebuilds (ConPTY).
  - `spawn` + `resize` OK.
  - Không cần VS Build Tools, không cần fallback Node 22.
  - **Quirk**: npm chặn install scripts – cần `npm install-scripts approve node-pty`; postinstall thiếu `pty.node`, phải copy thủ công từ `prebuilds/win32-x64/` sang `build/Release/`.

- **Monorepo** (`packages/`):
  - `shared`: giao thức JSON (`term.*`, `hello.*`, `accesskey.*`, `peer.gone`, `fs.*`, `git.*`), encode/decode.
  - `relay`: WS server (port 8787), lưu DEVICE_KEY hash, mint ACCESS_KEY một lần, ghép nối browser↔agent, pump frame opaque, giới hạn 4 session/device, sweep idle, serve static kèm traversal guard. CLI `keygen` đăng ký thiết bị.
  - `agent`: client WSS dial‑out + reconnect backoff, quản lý terminal bằng node-pty (mở/đóng/list/input/resize/exit), in ACCESS_KEY, pathguard cho fs.*.
  - `relay/web`: UI Vite vanilla TS – login ACCESS_KEY (prefill ?key=), xterm.js + fit + web‑links, đa tab, hàng phím mobile (Ctrl/Alt/Shift/Esc/Tab/arrows). Build vào `relay/public`.

### Build order bước 3–4: Filesystem + Git (task #5–7) — XONG

- **Protocol** (`packages/shared/src/protocol.ts`): thêm `fs.*` + `git.*` frames, kèm hằng số giới hạn.
- **Agent fs** (`packages/agent/src/fs.ts`): `FsHandlers` với `list`, `read`, `write` (mtime‑conflict check), `mkdir`, `rename`, `delete`. Mọi path qua `resolveInRootSafe` (lexical + realpath guard). `read` từ chối binary và file > 10 MB; `write` từ chối > 100 KB.
- **Agent git** (`packages/agent/src/git.ts`): `GitRunner` chạy `git status`, `diff`, `commit`, `push`, `log` với cwd bên trong repo đã resolve qua `FsHandlers`.
- **Tích hợp** `AgentClient` (`client.ts`) xử lý các frame `fs.*` và `git.*`.
- **Web file explorer** (`packages/relay/web/src/files.ts`): `FileTree` lazy load thư mục qua `fs.list`, sort dir‑first, breadcrumb, size format.
- **Web editor** (`packages/relay/web/src/editor.ts`): `Editor` dùng CodeMirror 6 — mở/sửa/lưu (Ctrl+S), mtime‑conflict UI (reload from disk), highlight theo đuôi file (js/ts/json/html/css/md/py/shell).
  - **Code‑split**: `editor.ts` là chunk lazy riêng, fetch khi click file đầu tiên; mỗi language pack là chunk riêng. Bundle chính 315 kB (chỉ xterm), editor 411 kB tải theo yêu cầu — không còn cảnh báo 500 kB.
- **Web git panel** (`packages/relay/web/src/git.ts`): `GitPanel` — repo path input, branch + ahead/behind, danh sách file thay đổi với mã trạng thái màu, chọn file → diff (colorized), commit (message + `--all`), push.

- **Kiểm thử**: 46/46 pass (`npm test`), tăng từ 24:
  - protocol round‑trip
  - relay pairing lifecycle (kết nối, ghép, key một lần, agent‑offline → `peer.gone`, reconnect re‑pair, giới hạn session)
  - pathguard (`../`, symlink escape, absolute‑outside‑root, null byte)
  - fs handlers (`fs.test.ts`), git handlers (`git.test.ts` — status/diff/commit/log, reject non‑repo/empty‑message/outside‑root), config (`config.test.ts`)

- **Smoke test end‑to‑end** (Playwright, relay 8789 ↔ agent thật, root = repo):
  - Terminal MVP: Browser → relay → agent → PowerShell thật, multi‑tab, `peer.gone`.
  - **Files view**: tree list root (15 entries), mở `package.json` → CodeMirror hiện nội dung, save bar đúng path; xác nhận chunk `editor-*.js` chỉ fetch khi click file đầu tiên.
  - **Git view**: branch `feat/terminal-mvp`, sync state, 17 file thay đổi, chọn file → diff render.
  - Chuyển view qua lại OK. 13/13 check pass.
  - Mobile keys render đúng ở 390px, không overflow.

- **Git**:
  - Branch: `feat/terminal-mvp`

---

## 🧩 Ghi chú cho chạy local

- Port 8787/8788 hay bị chiếm (Python uv, relay cũ) – dùng `KREMOTE_RELAY_PORT=8789`.
- Cần approve esbuild và node-pty trong package.json (`allowScripts`).
- Agent config JSON: dùng forward slash cho `root` (ví dụ `C:/works/kremote`) để tránh lỗi escape.
- Để chạy:
  ```bash
  KREMOTE_RELAY_HOME=<dir> node packages/relay/src/keygen.ts my-win
  KREMOTE_RELAY_PORT=8789 KREMOTE_RELAY_HOME=<dir> node packages/relay/src/index.ts
  # ghi DEVICE_KEY vào ~/.kremote/config.json
  KREMOTE_AGENT_CONFIG=<cfg.json> node packages/agent/src/index.ts
  ```

---

## 📌 Việc tiếp theo (theo spec)

1. Nút file ops trong web (mkdir/rename/delete) — handler agent đã sẵn, chưa có UI.
2. Xử lý push cần credential (SSH/PAT) — hiện chỉ chạy `git push` thô.
3. Cân nhắc auth mạnh hơn cho relay khi deploy VPS (rate‑limit, TLS).
4. Deploy thử lên VPS + test từ điện thoại thật.

---

*Cập nhật lúc 2026-09-09 sau khi hoàn thiện file explorer + editor (code‑split) + git panel và smoke test 13/13.*
