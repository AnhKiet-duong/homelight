# My Gallery

Gallery ảnh tự host với giao diện điện ảnh: tải ảnh lên, xem theo dòng thời gian và trình chiếu kỷ niệm dạng băng chuyền 3D. Không cần cài thư viện, chỉ cần Node.js 18+.

## Chạy

```bash
node server.js
```

Mở `http://localhost:3000`. Thiết bị khác cùng mạng Wi‑Fi mở bằng địa chỉ IP mà server in ra.

## Tính năng

- Tải ảnh bằng nút bấm, kéo thả hoặc dán (Ctrl+V); tự đọc ngày chụp từ EXIF
- Lưới ảnh chia theo năm, nghiêng 3D khi rê chuột, màu ánh sáng lấy từ ảnh
- Yêu thích, tìm kiếm, sắp xếp, xem phóng to, tải xuống, xoá
- Trình chiếu (`/slideshow.html`): băng chuyền 3D, Ken Burns, nhạc nền, toàn màn hình, phím tắt

## Cấu trúc

- `server.js` — server và API (`/api/photos`)
- `public/index.html` — trang gallery
- `public/slideshow.html` — trang trình chiếu
- `uploads/`, `data.json` — ảnh và thông tin ảnh (không đưa lên git)
