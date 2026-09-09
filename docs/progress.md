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

## 🔁 Session sống sót + auto‑reconnect + đăng nhập bền (mới)

Mục tiêu: rớt mạng / ngủ laptop / mở lại tab → tự kết nối lại **không cần ACCESS_KEY mới**, và terminal đang chạy (Claude Code, harness…) được gắn lại kèm lịch sử.

- **Protocol** (`shared`): `hello.client` nhận `accessKey?` **hoặc** `session?`; `hello.res` trả `session` (token bền 12h). Thêm `term.attach`/`term.attach.res` (replay scrollback) và `peer.back` (relay báo client khi agent quay lại).
- **Relay**: cấp token bền cho browser khi đăng nhập; xác thực lại bằng token đã lưu (trượt hạn 12h); **không xóa session khi rớt** (chỉ prune khi hết hạn). Agent reconnect → re‑pair + gửi `peer.back`.
- **Store**: thêm `touchSession` (gia hạn khi reconnect).
- **Agent**: `TermManager` giữ **scrollback ring buffer** 256KB mỗi pty; xử lý `term.attach` (resize theo viewport mới + replay buffer). Terminal vẫn sống qua `peer.gone` (đã có từ trước).
- **Web**: lưu token vào `localStorage`; khi load có token → kết nối im lặng bỏ qua màn login; `onClosed` → auto‑reconnect backoff (0.5s→15s); reattach terminal qua `term.list` + `term.attach` (reset + ghi lại scrollback) thay vì mở tab mới; badge trạng thái `live` / `reconnecting` (vàng, nhấp nháy) / `exited`.
- **Kiểm thử**: typecheck sạch; `npm test` **49/49** (thêm 3 test: session sống sót, token lạ bị từ chối, reconnect chờ agent rồi pair); web build sạch (không chunk >500kB).
- **Smoke test end‑to‑end** (Playwright, relay 8795 ↔ agent thật):
  - Đăng nhập `?key=` → app, terminal live; token bền lưu vào `localStorage`.
  - **Reload URL trần (không `?key=`) → vào thẳng, bỏ qua login** (đăng nhập bền); terminal cũ gắn lại kèm **replay scrollback** (marker sống sót); gõ lệnh sau reattach OK.
  - Kill agent → `peer.gone` → badge **reconnecting** (vàng), conn `off`.
  - Restart agent → `peer.back` → resync: terminal cũ đánh dấu **exited** (pty chết theo tiến trình agent, giữ lại scrollback) + **tự mở terminal mới live** (fix: mở terminal mới khi không còn tab sống, không chỉ khi 0 tab).

---

## 🔒 Siết bảo mật relay (chuẩn bị lên VPS) — mới

Mục tiêu: relay đủ an toàn để mở ra internet công khai.

- **`guard.ts` (mới)** — `ConnectionGuard` thuần, transport‑agnostic, đồng hồ tiêm được (như `relay.tick(now)`):
  - Giới hạn kết nối đồng thời **theo IP** (mặc định 20) và **tổng** (200).
  - **Chống brute‑force ACCESS_KEY**: cửa sổ trượt đếm auth‑fail theo IP → vượt ngưỡng (mặc định 10/60s) thì **chặn tạm IP** (mặc định 5 phút).
  - Chuẩn hoá IP: bóc IPv4‑mapped (`::ffff:1.2.3.4`→`1.2.3.4`), gộp IPv6 theo **/64** (chặn /128 vô dụng), bỏ zone id.
  - `sweep(now)` dọn cửa sổ hết hạn + gỡ block hết hạn (gọi trong `tick`).
- **`relay.ts`** — `reject()` phát event `'rejected'(peerId, reason)` (giữ Relay không biết IP); lớp transport phân loại.
- **`index.ts`** — wiring toàn bộ ở lớp socket:
  - **TLS nhúng trong Node**: có `KREMOTE_TLS_CERT`+`KREMOTE_TLS_KEY` → `https.createServer` (`wss://`); **hot‑reload** cert qua `setSecureContext` khi Let's Encrypt gia hạn (fs.watch + debounce, không cần restart). Không cert → `http` (dev local). **IP lấy trực tiếp từ socket** (không reverse‑proxy).
  - **`maxPayload`** cho WS (mặc định 8 MB, > `MAX_GIT_DIFF_BYTES` 2 MB) thay cho mặc định 100 MiB của `ws`.
  - **Hello deadline**: socket không gửi hello hợp lệ trong 10s bị đóng (4008) — bịt lỗ un‑authed socket không bao giờ bị sweep.
  - **Phân loại auth‑fail**: chỉ lý do đoán‑credential (`invalid or expired access key`, `session expired`) tính vào brute‑force; `agent offline`/`protocol mismatch`/… chỉ log (tránh khoá nhầm người thật).
  - **Audit log có cấu trúc** 1 dòng/sự kiện: `refuse`, `auth-fail` (kèm `blocked`), `block`, `hello-timeout`, `tls-reload`, `agent-online/offline`, `paired`. `/healthz` trả thêm `guard.stats`.
- **Kiểm thử**: `npm test` **58/58** (thêm 9: 8 test guard đồng hồ giả + 1 test event `rejected`); typecheck sạch.
- **Smoke runtime** (relay 8795, limit nhỏ qua env):
  - Brute‑force: 3 key sai → `4003`, lần 4+ IP bị chặn → `1013` (log `block`).
  - Per‑IP cap: giữ 3 socket, socket 4 bị đóng `1013` (`refuse reason=per-ip`).
  - Hello‑timeout: socket im lặng bị đóng `4008` (`hello-timeout`).
  - TLS: self‑signed cert → `wss://` bắt tay + duplex frame OK; ghi đè cert → log `tls-reload`, `wss` vẫn chạy với cert mới không restart.

### Env vars deploy (mới)

| Env | Mặc định | Ý nghĩa |
|-----|----------|---------|
| `KREMOTE_TLS_CERT` / `KREMOTE_TLS_KEY` | — | Đường dẫn cert/key PEM; có cả hai → bật `wss://` + hot‑reload |
| `KREMOTE_MAX_CONNS_PER_IP` | 20 | Kết nối đồng thời tối đa/IP |
| `KREMOTE_MAX_CONNS` | 200 | Kết nối đồng thời tối đa toàn relay |
| `KREMOTE_AUTH_FAIL_MAX` | 10 | Số auth‑fail/cửa sổ trước khi chặn IP |
| `KREMOTE_AUTH_FAIL_WINDOW_MS` | 60000 | Độ dài cửa sổ trượt auth‑fail |
| `KREMOTE_BLOCK_MS` | 300000 | Thời gian chặn tạm IP |
| `KREMOTE_HELLO_TIMEOUT_MS` | 10000 | Hạn gửi hello cho socket chưa auth |
| `KREMOTE_MAX_PAYLOAD` | 8388608 | Giới hạn kích thước 1 frame WS (byte) |

---

## 🖱 File ops UI (mkdir / rename / delete) — mới

Mục tiêu: đưa các handler `fs.*` đã có lên web UI trong Files view.

- **FileTree** (`packages/relay/web/src/files.ts`):
  - Head mới: breadcrumb + nút **"+ Folder"** → form inline (Enter xác nhận, Esc huỷ).
  - Mỗi row có nút **✎ rename** (inline input) + **🗑 delete** — hiện khi hover desktop,
    luôn hiện trên touch với tap size 32px (mobile CSS).
  - Delete dùng **two-tap confirm** tại chỗ ("Delete? ✓ ✕"), xoá dir đệ quy.
  - `runOp()` — một op mỗi lúc (`busy` guard), reload tree sau khi xong, banner thông báo
    thành công/lỗi tự huỷ sau 4s. Validate tên client-side: cấm `/`, `\`, `.`, `..`.
- **Fix #1 — banner bị xoá ngay**: `runOp` gọi `notice()` trước `loadDirectory()`/`render()`
  mà cả hai wipe `container.innerHTML` → banner chớp mắt là mất. Đảo thứ tự: render trước,
  notice sau.
- **Fix #2 — overflow ngang 28px trên mobile**: `#editor` (slide-over ẩn) dùng
  `transform: translateX(28px)` → ló ra ngoài viewport, body scrollWidth 418 > 390.
  Handoff cũ báo "no overflow" là đo ở Term view. Fix gốc: `#files { overflow: hidden }`
  trong breakpoint mobile (clip trong context của slide-over, đúng ý đồ thiết kế).
- **Kiểm thử smoke (browser thật, relay 8789 ↔ agent thật, root = sandbox)**:
  - mkdir `test-dir` → có trên disk; mkdir tên `"bad/name"` → banner "Invalid folder name".
  - rename `old-name.js` → `renamed.js` → OK trên disk; rename `a.json` → `docs` (đụng tên
    dir có sẵn) → banner đỏ EPERM từ server, file nguyên vẹn.
  - delete file (two-tap) → mất trên disk; delete dir đệ quy → mất cả thư mục.
  - Banner success hiện đúng sau fix #1.
  - Mobile 390px (emulation): scrollW == clientW == 390 ở cả Term/Files/editor mở; nút row
    32x32 luôn hiện; back chevron đóng editor về tree OK.
  - Desktop: nút hành động reveal khi hover; editor + tree bình thường.
  - `npm test` 58/58, typecheck sạch, web build sạch.

---

## 📌 Việc tiếp theo (theo spec)

1. ~~Nút file ops trong web (mkdir/rename/delete) — handler agent đã sẵn, chưa có UI.~~ ✅ XONG (mục 🖱 ở trên).
2. Xử lý push cần credential (SSH/PAT) — hiện chỉ chạy `git push` thô.
3. ~~Cân nhắc auth mạnh hơn cho relay khi deploy VPS (rate‑limit, TLS).~~ ✅ XONG (mục 🔒 ở trên).
4. Deploy thử lên VPS + test từ điện thoại thật.

---

*Cập nhật lúc 2026-09-09 sau khi hoàn thiện file explorer + editor (code‑split) + git panel và smoke test 13/13.*

*Cập nhật lúc 2026-09-09 (chiều): redesign terminal (window chrome kiểu macOS) + session sống sót/auto‑reconnect/đăng nhập bền — test 49/49, build sạch. Đã commit 9a3f756.*

*Cập nhật lúc 2026-09-09 (tối): smoke test end‑to‑end thật (Playwright, relay+agent) — xác nhận đăng nhập bền + reattach + replay scrollback + peer.gone/peer.back. Vá khoảng trống: tự mở terminal mới khi mọi tab đã chết sau khi agent restart.*

*Cập nhật lúc 2026-09-09 (khuya): siết bảo mật relay — `ConnectionGuard` (cap kết nối/IP + tổng, chống brute‑force ACCESS_KEY, chuẩn hoá IPv6 /64), TLS nhúng trong Node + hot‑reload cert, hello‑deadline, maxPayload, audit log có cấu trúc. Test 58/58, smoke rate‑limit + TLS đạt.*

*Cập nhật lúc 2026-09-09: file ops UI (mkdir/rename/delete + two‑tap confirm + banner) — smoke test browser thật hết các op, phát hiện & vá 2 bug: banner bị wipe bởi render(), overflow ngang 28px trên mobile do `#editor` translateX khi ẩn (`#files { overflow: hidden }`). Test 58/58.*
