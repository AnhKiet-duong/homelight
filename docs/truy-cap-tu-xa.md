# Truy cập gallery từ bất cứ đâu (ảnh vẫn nằm trên laptop)

Gallery chạy trên laptop của bạn. **Tailscale Funnel** tạo một địa chỉ HTTPS công khai (dạng `https://ten-may.ten-mang.ts.net`) trỏ về laptop, không cần mở port modem, không cần IP tĩnh, miễn phí.

## Cần biết trước

- Laptop phải **bật, không ngủ và có mạng** thì web mới vào được.
- Tốc độ xem ảnh phụ thuộc tốc độ **upload** của mạng nhà bạn.
- Tạo tài khoản quản trị **trước** khi bật Funnel (bước 1).

## 1. Chạy gallery và tạo tài khoản

Mở PowerShell trong thư mục dự án (ví dụ `G:\Web UI`):

```powershell
node server.js
```

Mở `http://localhost:3000` trên chính laptop, tạo tài khoản quản trị. Để cửa sổ này chạy.

## 2. Cài Tailscale

1. Tải và cài từ https://tailscale.com/download/windows
2. Đăng nhập (Google, Microsoft hoặc GitHub đều được).

## 3. Bật Funnel

Mở **một cửa sổ PowerShell khác** và chạy:

```powershell
tailscale funnel --bg 3000
```

Lần đầu, lệnh sẽ in ra một đường link để bật HTTPS và Funnel cho mạng của bạn. Mở link, bấm đồng ý, rồi chạy lại lệnh trên. Lệnh in ra địa chỉ công khai, ví dụ:

```
Available on the internet:
https://laptop-kiet.tail1234.ts.net/
|-- proxy http://127.0.0.1:3000
```

Mở địa chỉ đó trên điện thoại (tắt Wi‑Fi, dùng 4G để thử) và đăng nhập.

`--bg` giúp Funnel tự chạy lại sau khi khởi động máy. Các lệnh hữu ích:

```powershell
tailscale funnel status     # xem địa chỉ đang công khai
tailscale funnel reset      # tắt công khai
```

## 4. Giữ laptop luôn sẵn sàng (tuỳ chọn)

- **Không cho máy ngủ:** Settings → System → Power → Screen and sleep → "When plugged in, put my device to sleep after" → **Never**.
- **Tự chạy gallery khi đăng nhập Windows:** tạo file `start-gallery.bat` có nội dung

  ```bat
  cd /d "G:\Web UI"
  node server.js
  ```

  rồi nhấn `Win + R`, gõ `shell:startup`, Enter, và đặt một shortcut tới file `.bat` đó vào thư mục vừa mở.

## Phương án khác

- **Cloudflare Tunnel** (`cloudflared`): miễn phí, nhanh. Muốn địa chỉ cố định thì cần tên miền riêng; không có thì mỗi lần chạy `cloudflared tunnel --url http://localhost:3000` sẽ ra một link `trycloudflare.com` ngẫu nhiên.
- **ngrok**: dễ thử nhất (`ngrok http 3000`), gói miễn phí có 1 tên miền cố định nhưng giới hạn băng thông.

## An toàn

- Dùng mật khẩu dài, mỗi người một tài khoản riêng.
- Nhập sai mật khẩu 10 lần thì tài khoản bị khoá 15 phút.
- Sao lưu thư mục `storage/` định kỳ (ổ ngoài, Google Drive…).
