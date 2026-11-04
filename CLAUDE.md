# homelight (My Gallery)

Gallery ảnh/video tự host: Node.js thuần, không framework, không build. `server.js` + `media.js` + `video.js`,
giao diện là các trang HTML độc lập trong `public/`, dữ liệu trong `storage/` (không đưa lên git).
Người dùng nói tiếng Việt; comment và thông báo trong code bằng tiếng Việt; README bằng tiếng Anh.

**Trước khi trả lời câu hỏi về tính năng hoặc thêm / sửa logic, đọc `docs/kien-truc.md`** (kiến trúc, luồng xử lý,
quy tắc, mô hình đồng thời, danh sách kiểm tra xung đột ở mục 12). Khi thay đổi làm tài liệu đó sai, sửa nó trong cùng commit.

Các quy tắc hay bị phá nhất:
- Dữ liệu trong bộ nhớ là nguồn sự thật: sửa object tại chỗ rồi gọi `save*`; không ghi / đọc lại file JSON trong `storage/`
  trực tiếp; gọi lại `getPhotos(uid)` sau mỗi `await` trước khi sửa / lưu.
- File gốc trên ổ ngoài (thư mục liên kết) không bao giờ bị ghi / xoá. Code mới đọc / ghi ổ ngoài đi qua
  `onDrive` / `driveSlot` / `readStream` và kiểm tra `isOffline` (code cũ còn vài ngoại lệ nhỏ trên cache, xem mục 7.2).
- Lỗi có `cancelled: true` (hoặc ổ rút) là "làm tiếp sau", không bao giờ đặt `vfail` / `thumbFailed`.
- Người xem chỉ thấy mức HLS qua `readyHls`; dữ liệu ảnh gửi cho trình duyệt đi qua `photoView` (và `albumView`, `publicPhotos`).
- Chuỗi tiếng Việt là khoá dịch: chuỗi mới cần bản tiếng Anh (`public/i18n/<trang>.js`, lỗi server trong `public/i18n.js`).
- Kiểm tra quyền ở server; API mới có body dùng `readJsonBody` (bắt `Content-Type: application/json`, chống CSRF).

Chạy: `node server.js` (mặc định cổng 3000, hoặc cổng đã lưu / biến `PORT`). Trên Windows PowerShell dùng `npm.cmd` thay cho `npm`.
Thử nghiệm trên bản sao trong thư mục tạm, không dùng `storage/` thật của người dùng.
