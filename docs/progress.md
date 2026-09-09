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

## 🤝 Zero-touch enrollment (agent tự đăng ký, kiểu 9Remote) — mới

Mục tiêu: bỏ bước copy DEVICE_KEY tay. Agent trỏ relayUrl vào relay là tự chạy.

- **Protocol**: `hello.agent` thêm `register?: boolean` + `label?`, `deviceKey` thành optional.
  `hello.res` thêm `deviceKey?`/`deviceId?` (chỉ trả về đúng socket đăng ký, đúng 1 lần).
- **Relay** (`relay.ts`): hello.agent không có deviceKey + `register:true` → mint DEVICE_KEY
  (`Store.addDeviceNow` — sync mutation, flush nền) rồi **chỉ trả key sau khi store ghi bền**
  (`await flush()` — relay crash ngay sau enrollment thì key vẫn còn, cửa không mở lại).
  Cửa đăng ký chốt bởi `maxDevices` (mặc định **1**, env `KREMOTE_MAX_DEVICES`): agent đầu tiên
  chiếm slot, sau đó `device registration closed`. Restart relay → store nạp lại → cửa vẫn đóng.
  Refuse reason này chỉ log, không tính vào brute-force block.
- **Agent** (`client.ts`): không có deviceKey → gửi `register:true`; nhận `hello.res{deviceKey}`
  → lưu vào config (`saveConfig`), reconnect như thiết bị thường → tự xin ACCESS_KEY như cũ.
  `config.ts`: `deviceKey` thành optional (config mới chỉ cần `relayUrl` + `root`).
- **Kiểm thử**: `npm test` **63/63** (+3: enroll+pair, cửa đóng khi đủ cap, restart vẫn đóng cửa).
  End-to-end thật: config không key → tự enroll ~1s, config có key; agent thứ 2 bị chặn đúng
  `device registration closed`.

---

## 📌 Việc tiếp theo (theo spec)

1. ~~Nút file ops trong web (mkdir/rename/delete) — handler agent đã sẵn, chưa có UI.~~ ✅ XONG (mục 🖱 ở trên).
2. ~~Xử lý push cần credential (SSH/PAT) — hiện chỉ chạy `git push` thô.~~ ✅ XONG (mục 🔑 ở dưới).
3. ~~Cân nhắc auth mạnh hơn cho relay khi deploy VPS (rate‑limit, TLS).~~ ✅ XONG (mục 🔒 ở trên).
4. ~~Deploy thử lên VPS + test từ điện thoại thật.~~ ⏳ Bộ script deploy đã xong (mục 🚀 ở dưới); **còn lại: chạy thật trên VPS + test điện thoại thật**.

---

## 🔑 Git push credential (SSH/PAT) — mới

Mục tiêu: `git push` chạy được khi cần xác thực, không treo máy (unattended daemon).

- **`git.ts`** — `GitRunner` nhận `creds?: GitCredentials` (`{username?, token}`):
  - `runGit(..., {auth:true})` tiêm credential qua **in-process credential helper**
    (`credential.helper=!f(){ echo username=$KREMOTE_GIT_USER; echo password=$KREMOTE_GIT_TOKEN; }; f`):
    token đi qua **env của child**, không nằm trong argv (ẩn với `ps`), không ghi ra đĩa.
    Xoá helper kế thừa (`credential.helper=` rỗng) trước để chỉ helper của ta được gọi.
  - **Chống treo**: mọi lệnh git đặt `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`,
    `GIT_SSH_COMMAND='ssh -o BatchMode=yes'` → thiếu credential thì lỗi ngay, không chờ prompt.
  - **Phân loại lỗi auth**: khớp stderr với `AUTH_FAIL_PATTERNS` → `GitError` code `EAUTH`
    kèm hint rõ ràng (có/không có creds cấu hình). UI git panel đã hiện `res.error` nên
    thông báo tới người dùng tự động.
  - Chỉ `push` dùng `auth:true` (status/diff/commit/log là local).
- **Config** (`config.ts`): thêm `gitCredentials?: {username?, token}`. Env override
  `KREMOTE_GIT_TOKEN` / `KREMOTE_GIT_USER` (giữ token ngoài file config khi chạy service).
  Default username `x-access-token` (hợp GitHub PAT). Wiring vào `AgentClient`.
- **SSH remote**: không cần cấu hình gì — dùng OS ssh key qua `BatchMode=yes`.
- **Kiểm thử**: `npm test` **60/60** (+2: push bad token → `EAUTH`; push không creds → fail fast,
  không treo). typecheck sạch.

---

## 🚀 Deploy kit cho VPS (TLS nhúng Node) — mới

Mục tiêu: script hoá việc dựng relay trên VPS công khai, TLS terminate trong Node (không reverse proxy).

- **`deploy/setup-vps.sh`** (chạy 1 lần trên VPS): cài Node 24 + certbot, tạo user hệ thống
  `kremote`, cấp cert Let's Encrypt (`certbot --standalone`), cài **renewal deploy-hook**
  copy cert vào `/etc/kremote/tls/` (relay watch dir này → hot‑reload, gia hạn không cần restart),
  cài systemd unit + `/etc/kremote/relay.env`, `setcap`/`AmbientCapabilities` để bind :443 không cần root.
- **`deploy/kremote-relay.service`**: systemd unit đã hardening (`ProtectSystem=strict`,
  `NoNewPrivileges`, `ReadWritePaths` chỉ store dir, `CAP_NET_BIND_SERVICE`). Node chạy thẳng `.ts`.
- **`deploy/deploy.sh`** (chạy từ máy dev): build web local → rsync `relay`+`shared`+`public`
  lên VPS (KHÔNG gửi node-pty; relay thuần JS chỉ cần `ws`), cài `ws` + symlink `@kremote/shared`,
  restart service. Chạy lại mỗi lần đổi code.
- **`deploy/relay.env.example`** + **`deploy/README.md`** (hướng dẫn đầy đủ: DNS, cấp key, cấu hình agent,
  git push creds, troubleshoot).
- **Kiểm thử runtime local** (giả lập VPS, self‑signed cert, env y hệt deploy):
  - Relay boot `https://…:8443 [TLS]`, `/healthz` OK, serve web UI.
  - WSS handshake OK; hello sai key → `hello.res{ok:false}` + close `4003` + audit `auth-fail`.
  - Ghi đè cert → log `tls-reload`, vẫn serve với cert mới không restart (đúng đường certbot renewal).
  - `bash -n` sạch cả 2 script.
- **Còn lại**: chạy thật trên một VPS + test từ điện thoại thật (4G latency, mobile keys, scrollback).

---

## 📱 Mobile terminal: composer tiếng Việt + pwsh UTF‑8 + clear thật — mới

Ba vấn đề mobile: (1) xterm textarea phá IME gõ tiếng Việt, (2) PowerShell 5.1
codepage legacy làm hỏng UTF‑8, (3) `cls`/`clear` không xoá scrollback.

- **Composer IME‑safe** (`web/index.html`, `main.ts`, `style.css`): ô input DOM chuẩn
  trong footer mobile, chặn gửi khi đang compose (`compositionstart/end` + `keydown`),
  Enter gửi cả dòng — Telex/VNI hoạt động vì không đi qua xterm textarea.
- **Agent shell** (`agent/src/term.ts`): ưu tiên `pwsh.exe` (PowerShell 7, UTF‑8 mặc định),
  fallback `powershell.exe` bọc `chcp 65001`. Giữ contract `data`/`exit` của TermManager.
- **Clear thật** (`web/src/clear.ts` + hook trong `main.ts`): ConPTY không bao giờ gửi
  `ESC[3J` — probe thật trên Win10 PS 5.1 cho thấy `cls` chỉ emit `ESC[H` + burst `ESC[K`
  (30 dòng), `2J` thường không xuất hiện. Detector `looksLikeClear` nhận cả 2 shape
  (`2J`, hoặc `H` + ≥3 `K` — full burst luôn nằm trong 1 chunk, dưới giới hạn ~4 KB),
  web tự append `ESC[3J` → scrollback xoá thật.
- **Kiểm thử**: `npm test` **67/67** (+4 unit cho detector, dùng chunk ConPTY thật).
  Browser E2E (CDP input thật): flood 60 dòng → scrollArea 1054px, sau `cls` còn 493px
  = đúng viewport, màn hình trống chỉ còn prompt.

---

*Cập nhật lúc 2026-09-09 sau khi hoàn thiện file explorer + editor (code‑split) + git panel và smoke test 13/13.*

*Cập nhật lúc 2026-09-09 (chiều): redesign terminal (window chrome kiểu macOS) + session sống sót/auto‑reconnect/đăng nhập bền — test 49/49, build sạch. Đã commit 9a3f756.*

*Cập nhật lúc 2026-09-09 (tối): smoke test end‑to‑end thật (Playwright, relay+agent) — xác nhận đăng nhập bền + reattach + replay scrollback + peer.gone/peer.back. Vá khoảng trống: tự mở terminal mới khi mọi tab đã chết sau khi agent restart.*

*Cập nhật lúc 2026-09-09 (khuya): siết bảo mật relay — `ConnectionGuard` (cap kết nối/IP + tổng, chống brute‑force ACCESS_KEY, chuẩn hoá IPv6 /64), TLS nhúng trong Node + hot‑reload cert, hello‑deadline, maxPayload, audit log có cấu trúc. Test 58/58, smoke rate‑limit + TLS đạt.*

*Cập nhật lúc 2026-09-09: file ops UI (mkdir/rename/delete + two‑tap confirm + banner) — smoke test browser thật hết các op, phát hiện & vá 2 bug: banner bị wipe bởi render(), overflow ngang 28px trên mobile do `#editor` translateX khi ẩn (`#files { overflow: hidden }`). Test 58/58.*

---

## 📲 PWA — cài lên màn hình chính như app — mới

Mục tiêu: trên mobile, mở kremote như app riêng (icon, fullscreen, không thanh trình duyệt).

- **Manifest** (`web/public/manifest.webmanifest`): standalone, brand colors
  (`#0c0c0c`/`#040404`), icon 192/512 + maskable.
- **Icons** vẽ bằng Pillow khớp brand: chevron `>` + block caret màu coral trên nền
  near-black (maskable có safe-zone 80%).
- **Service worker** (`web/public/sw.js`, viết tay không workbox):
  shell (`index.html`) network-first + fallback cache khi offline (mở login không cần mạng);
  `/assets/*` + icons cache-first (tên file có hash, stale an toàn);
  `/ws`, `/healthz` không bao giờ bị chặn; version bump xoá cache cũ.
  Đăng ký chỉ ở build production (`import.meta.env.PROD`) — không dính HMR của Vite.
- **Relay**: thêm MIME `.webmanifest` (application/manifest+json) và `.png`.
- **Kiểm thử**: local browser thật — SW `activated`, scope `/`, manifest parse OK,
  cache chứa shell; CDP offline mode → fetch `/` vẫn 200 từ cache (fallback hoạt động).
  Trên VPS: manifest/sw/icons trả 200 + MIME đúng qua HTTPS.

---

## ⚙️ 4 tính năng terminal — Settings · Bio-lock · Log tail · History — mới

Bốn tính năng bổ trợ cho terminal (2 web-only, 1 full-stack, 1 web-only):

- **#2 Settings terminal** (`web/src/settings.ts`): font size (10–24, clamp) + theme
  sáng/tối cho xterm, persist `localStorage['kremote.term.settings']`. Popover ⚙ trên
  header; áp dụng live cho mọi tab đang mở.
- **#3 Bio-lock** (`web/src/biolock.ts`): WebAuthn platform authenticator (Windows
  Hello / Face ID / vân tay) làm cổng mở lại session. Bật trong Settings → tạo credential
  gắn với origin, lưu credId cạnh session token. Khi khởi động, nếu có token + credId thì
  giữ token lại tới khi `navigator.credentials.get()` xác minh; huỷ/lỗi → xoá token, về
  màn login. Đây là lớp tiện lợi chống nhìn trộm, không phải biên bảo mật cứng (token vẫn
  là thứ auth với relay).
- **#4 Log tail** (`agent/src/tail.ts` + `tailview.ts` + protocol `tail.*`): `tail -f`
  live qua `TailManager` (fs.watch + đọc offset mới, phát hiện rotation khi size co lại →
  đọc từ 0, cap 8 watch, pathguard trong root). Panel Logs: nhập path → Follow (replay
  phần cuối file rồi stream tiếp), ô pattern + chuông 🔔 để notify khi dòng mới khớp regex.
- **#6 Command history** (`web/src/history.ts`): mỗi dòng lệnh submit được ghi lại (dedupe,
  mới nhất trước, cap 500) vào `localStorage['kremote.history']`. Drawer ⌘: search + tap để
  gửi lại lệnh vào terminal đang active.

**2 bug phát hiện & vá khi verify:**
- History bỏ sót lệnh: input tới theo chunk rời (mỗi phím 1 chunk, Enter là chunk `\r`
  riêng) nên parse từng chunk là sai. Vá: `sendInput()` gom `pendingLine` per-tab (Map),
  ghi khi gặp `\r`, cap 4096 bytes.
- Tail replay bị drop: agent gửi `tail.data` replay TRƯỚC `tail.watch.res` → client chưa
  biết watchId → bỏ chunk. Vá: tách `initialReplay(watchId)` khỏi `watch()`; agent gọi
  replay SAU khi gửi ack.

- **Kiểm thử**: 76/76 test, typecheck + web:build sạch. E2E browser thật (Playwright,
  relay+agent zero-touch): #2 font/theme persist; #6 ghi + tap-to-send chạy lại lệnh; #4
  replay 2 dòng seed ngay khi Follow, stream ERROR live, notify đúng khi khớp `ERROR` và
  KHÔNG notify với dòng INFO; #3 bio-lock qua CDP virtual authenticator (origin `localhost`
  vì `127.0.0.1` không phải RP ID hợp lệ) — verified thật → mở khoá + reconnect; unverified
  → chặn, xoá token, về login.
