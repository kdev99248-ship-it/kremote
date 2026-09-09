# HANDOFF — kremote: 4 tính năng (2 settings, 3 bio-lock, 4 log tail, 6 history)

Cập nhật: phiên `20260909_124717_400ec0`, branch `feat/terminal-mvp` @ `C:\works\kremote`

## Mục tiêu (user: "lam 2,3,4,6")
- **#2 Settings terminal** — font size + theme sáng/tối, persist localStorage. Web-only.
- **#3 Bio-lock** — WebAuthn platform authenticator (Face ID/vân tay/Windows Hello) gate session token. Web-only.
- **#4 Log tail** — `tail -f` live qua protocol `tail.*`, kèm pattern-match notification. Cần protocol + agent + web.
- **#6 Command history** — ghi dòng lệnh đã submit, panel search + tap-to-send. Web-only.

## TRẠNG THÁI: code xong, đang verify E2E. CHƯA commit/push/deploy.

### Đã verify PASS (browser thật, relay :8799, agent zero-touch)
- #2 settings: popover mở, font 14→15 persist, theme persist (`localStorage['kremote.term.settings']` = `{"fontSize":15,"theme":"dark"}`). ✅
- #6 history: sau khi FIX bug buffer (xem dưới), ghi `echo hist-fix-check` vào `localStorage['kremote.history']`; drawer render item, tap → gõ lại lệnh + chạy được. ✅
- #4 tail: theo `demo.log`, append từ ngoài → stream live WARN/ERROR/INFO đúng. Sau FIX replay (xem dưới) đang test lại.

### Đang dở
- Vừa restart agent+relay fresh (KEY: `4W89ZSCY`, port 8799) với `demo.log` có sẵn 2 dòng để test:
  1. **replay** (mở tail → 2 dòng cũ phải hiện ngay) — kiểm tra fix `initialReplay`
  2. **pattern notify** (#4): set pattern `ERROR`, append dòng ERROR → phải bắn notification
- #3 bio-lock: **CHƯA verify E2E** (WebAuthn khó test headless — cần virtual authenticator qua CDP `WebAuthn.enable` + `addVirtualAuthenticator`, hoặc verify logic/persist thôi).

## Tests: 76/76 pass, typecheck sạch, web:build sạch.

## 2 BUG đã phát hiện & FIX trong lúc verify (quan trọng — đừng lặp lại)
1. **History bỏ sót dòng lệnh**: thiết kế đầu parse từng chunk `data.includes('\r')` — SAI vì input đến theo chunk rời (desktop: mỗi phím 1 chunk; Enter là chunk `\r` riêng). Fix: `sendInput()` accumulate `pendingLine` per-tab (Map), record khi gặp `\r`, cap 4096 bytes. File `main.ts`.
2. **Tail replay bị drop**: agent gửi `tail.data` replay TRƯỚC `tail.watch.res` → client chưa biết watchId → bỏ chunk. Fix: tách `initialReplay(watchId)` khỏi `watch()`; `client.ts` gọi replay SAU khi gửi ack. File `tail.ts` + `client.ts` + `tail.test.ts`.

## Files đã tạo/sửa (chưa commit)
MỚI:
- `packages/agent/src/tail.ts` (120 dòng) — `TailManager`: fs.watch + đọc offset mới, phát hiện rotation (shrink→từ 0), cap 8 watch, pathguard trong root
- `packages/agent/test/tail.test.ts` (4 test: replay, fromEnd, rotation, pathguard+cap)
- `packages/relay/web/src/settings.ts` (68) — `readSettings/saveSettings`, font+theme
- `packages/relay/web/src/history.ts` (37) — `addHistory/searchHistory`, dedupe, cap, localStorage `kremote.history`
- `packages/relay/web/src/biolock.ts` (93) — WebAuthn: `register/verify`, gate token, persist credId
- `packages/relay/web/src/tailview.ts` (167) — panel Logs: start/stop follow, render dòng, pattern notify

SỬA:
- `packages/shared/src/protocol.ts` — thêm `tail.watch`/`tail.watch.res`/`tail.data`/`tail.dead`/`tail.unwatch` + union `ClientToAgent`/`AgentToClient`
- `packages/agent/src/client.ts` — import TailManager, field `tails`, case `tail.watch`/`tail.unwatch`, replay-after-ack, `closeAll` trong stop()
- `packages/relay/web/src/conn.ts` — `onFrame()` giờ trả unsubscribe
- `packages/relay/web/src/main.ts` — import 4 module; VIEWS thêm `'tail'`; createTab dùng termSettings; `sendInput` buffer history; settings popover; history drawer; biolock startup gate; applySettingsToTabs
- `packages/relay/web/index.html` — nút `#settings-btn`/`#history-btn`, view-btn `Logs`, `#settings-pop`/`#history-drawer`/`#tail` markup
- `packages/relay/web/src/style.css` — style settings/history/tail

## Verify E2E setup (tái lập)
- tmp: `%LOCALAPPDATA%\Temp\kremote-feat-test` (relay-home, agent/config.json, root/demo.log)
- agent config: `{relayUrl:"ws://127.0.0.1:8799/ws", root:<tmp>/root, label:"feat-test"}`
- relay: `KREMOTE_RELAY_PORT=8799 KREMOTE_RELAY_HOME=<tmp>/relay-home node packages/relay/src/index.ts`
- agent: `KREMOTE_AGENT_CONFIG=<tmp>/agent/config.json node packages/agent/src/index.ts`
- URL: `http://127.0.0.1:8799/?key=<KEY từ agent.log>`
- Browser test: dùng CDP `Input.insertText` + `Input.dispatchKeyEvent` (synthetic KeyboardEvent bị xterm bỏ); chỉ ASCII trong comment Python (em-dash làm hỏng stdin)

## CÒN LẠI
1. Verify replay + pattern-notify (#4) trên KEY `4W89ZSCY`
2. Verify hoặc chấp nhận #3 bio-lock (cân nhắc CDP virtual authenticator)
3. Kill node processes dọn dẹp (`taskkill /F /IM node.exe`)
4. `npm run typecheck && npm test && npm run web:build` lần cuối
5. COMMIT + push + `bash deploy/deploy.sh` (VPS root@163.61.73.198 / kremote.cc) + docs `docs/progress.md`

## Bối cảnh dự án (không đổi)
- TLS nhúng Node :443, build-on-VPS git-based, zero-touch cap 1 device, PWA viết tay
- Deploy: `bash deploy/deploy.sh` (đọc `deploy/deploy.env`) hoặc `VPS=root@163.61.73.198 bash deploy/deploy.sh`
- Commit gần nhất trước phiên này: `7d4988d` (notification)
