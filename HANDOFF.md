# HANDOFF — kremote: 4 tính năng (2 settings, 3 bio-lock, 4 log tail, 6 history) + Web Push

Cập nhật: phiên `20260909_1920`, branch `feat/terminal-mvp` @ commit `d350823` (đã push origin).

## TRẠNG THÁI: XONG + COMMIT + PUSH. Chỉ còn DEPLOY lên VPS (bị chặn SSH — xem dưới).

### Đã hoàn tất phiên này
- 4 tính năng #2/#3/#4/#6: code + verify E2E (các phiên trước) — 82/82 test, typecheck sạch, web:build sạch.
- **Web Push (lớp mới ngoài plan ban đầu)** — verify E2E thật lần đầu (browser thật, FCM thật):
  - Bật 🔔 trong Logs → permission granted → sub FCM tạo → agent persist `vapid` + sub.
  - Append INFO → không push; append `ERROR …` → notification `tail: demo.log` đúng body/tag `kremote-tail`.
  - Burst 5 dòng ERROR → vẫn 1 notification (1 push/chunk + tag replace). ✔
- Fix: `@xterm/addon-search` thiếu trong node_modules làm `web:build` gãy → `npm install` (đã có trong package.json).
- Docs: `docs/progress.md` có mục 📲 Web Push mới.

## CÒN LẠI (duy nhất)
- **Deploy**: `bash deploy/deploy.sh` fail ở bước SSH — `root@163.61.73.198` trả
  `Permission denied (publickey,password)` với key `~/.ssh/id_ed25519`; chạy non-interactive
  không gõ được mật khẩu. Cần user chạy deploy trong terminal riêng (gõ mật khẩu), hoặc thêm
  key public vào `authorized_keys` trên VPS một lần. Ping tới VPS OK (25ms) — máy sống.
- Sau deploy: test từ điện thoại thật (4G): mở kremote.cc → PWA → Logs → 🔔 → check push khi đóng app.

## Bối cảnh dự án (không đổi)
- TLS nhúng Node :443, build-on-VPS git-based, zero-touch cap 1 device, PWA viết tay.
- Deploy: `bash deploy/deploy.sh` (đọc `deploy/deploy.env`) hoặc `VPS=root@163.61.73.198 bash deploy/deploy.sh`.
- Commit trước phiên này: `4aa7bef`. Commit phiên này: `d350823`.
