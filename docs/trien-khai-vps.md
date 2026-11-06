# Chạy gallery trên VPS (pm2 + nginx + HTTPS)

Hướng dẫn này đưa gallery lên một máy chủ thuê (VPS) chạy Ubuntu, có tên miền riêng và HTTPS miễn phí:

- **pm2** giữ `node server.js` luôn chạy, tự bật lại khi lỗi hoặc khi VPS khởi động lại.
- **nginx** đứng trước Node: nhận kết nối từ internet ở cổng 80/443, chuyển vào gallery ở cổng 3000.
- **Let's Encrypt** (certbot) cấp chứng chỉ HTTPS miễn phí và tự gia hạn.

```
Trình duyệt ──HTTPS 443──▶ nginx ──http 127.0.0.1:3000──▶ node server.js (pm2)
```

File mẫu đi kèm trong thư mục `deploy/`:

| File | Dùng để |
|---|---|
| `deploy/ecosystem.config.js` | cấu hình pm2 (tên app, cổng, tự khởi động lại) |
| `deploy/nginx-homelight.conf` | cấu hình nginx (upload lớn, video HLS, tua video) |

Các lệnh bên dưới chạy trên VPS qua SSH. Thay `anh.example.com` bằng tên miền của bạn, `kiet` bằng tên người dùng trên VPS.

## 0. Chọn VPS

| | Tối thiểu | Nên có |
|---|---|---|
| CPU | 1 vCPU | 2 vCPU trở lên nếu xem nhiều video (ffmpeg tạo bản HLS rất tốn CPU) |
| RAM | 1 GB | 2 GB |
| Ổ đĩa | đủ chứa ảnh + khoảng 30% cho ảnh nhỏ và bản HLS của video | gắn thêm ổ (block storage) nếu thư viện lớn |
| Hệ điều hành | Ubuntu 22.04 hoặc 24.04 | |

So với chạy trên laptop ở nhà, VPS có băng thông upload lớn hơn nhiều nên xem ảnh gốc và video 1080p/4K từ xa mượt hơn. Đổi lại phải trả tiền ổ đĩa theo dung lượng ảnh.

## 1. Trỏ tên miền về VPS

Ở trang quản lý tên miền, tạo bản ghi **A**: `anh.example.com` → địa chỉ IP của VPS. Đợi vài phút rồi kiểm tra từ máy bạn:

```bash
ping anh.example.com
```

> **Nếu dùng Cloudflare:** để bản ghi ở chế độ **DNS only** (đám mây xám). Chế độ proxy (đám mây cam) của gói miễn phí chặn mọi request lớn hơn 100 MB, nên tải video lên sẽ lỗi.

## 2. Chuẩn bị VPS

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git nginx

# Node.js 22 LTS (sharp cần Node 20.9+)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v

# pm2
sudo npm install -g pm2
```

Tường lửa: chỉ mở SSH, 80 và 443. **Không mở cổng 3000**, gallery chỉ được vào qua nginx.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

## 3. Tải code và cài thư viện

```bash
cd ~
git clone https://github.com/AnhKiet-duong/homelight.git
cd homelight
npm install
```

`npm install` cài `sharp` (ảnh nhỏ) và `ffmpeg` đóng gói sẵn (video HLS), không cần cài ffmpeg hệ thống.

**Chuyển ảnh có sẵn từ laptop lên** (bỏ qua nếu bắt đầu mới): toàn bộ dữ liệu nằm trong thư mục `storage/`. Dừng gallery trên laptop rồi chép cả thư mục này lên VPS, ví dụ bằng WinSCP, hoặc trong PowerShell:

```powershell
scp -r "G:\Web UI\storage" kiet@IP_VPS:~/homelight/
```

Thư mục liên kết (ổ cứng ngoài) trỏ tới ổ trên laptop nên sẽ báo "ngoại tuyến" trên VPS. Gỡ liên kết đó trong gallery, hoặc chép ảnh vào thư mục nhập ảnh (mục 8).

## 4. Chạy bằng pm2

```bash
cd ~/homelight
pm2 start deploy/ecosystem.config.js
pm2 status
pm2 logs homelight --lines 30
```

Cho pm2 tự chạy khi VPS khởi động lại:

```bash
pm2 startup        # lệnh này in ra một dòng "sudo env PATH=... pm2 startup systemd ...": chép và chạy dòng đó
pm2 save
```

Giữ log gọn (không đầy ổ):

```bash
pm2 install pm2-logrotate
```

Vài điều trong `deploy/ecosystem.config.js` cần giữ nguyên:

- **`instances: 1`**: gallery giữ danh sách ảnh, tài khoản, phiên đăng nhập trong RAM. Chạy 2 bản cùng lúc (cluster) thì hai bản ghi đè dữ liệu của nhau.
- **`PORT: 3000`**: cổng đặt bằng biến môi trường thì trang **Tài khoản → Cổng máy chủ** bị khoá, tránh lỡ tay đổi cổng làm nginx mất kết nối. Muốn đổi cổng, sửa ở đây và ở `proxy_pass` trong file nginx.

## 5. Cấu hình nginx

```bash
sudo cp ~/homelight/deploy/nginx-homelight.conf /etc/nginx/sites-available/homelight
sudo nano /etc/nginx/sites-available/homelight     # đổi anh.example.com thành tên miền của bạn
sudo ln -s /etc/nginx/sites-available/homelight /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Mở `http://anh.example.com`: phải thấy trang đăng nhập (chưa có HTTPS).

Những dòng quan trọng trong file mẫu:

| Dòng | Tại sao |
|---|---|
| `client_max_body_size 4200m` | nginx mặc định chỉ nhận 1 MB mỗi request. Gallery nhận ảnh tới 50 MB và video tới 4096 MB (`VIDEO_MAX_MB`). Tăng `VIDEO_MAX_MB` thì tăng số này theo |
| `proxy_request_buffering off` | video tải lên được chuyển thẳng vào gallery, không bị nginx chép tạm ra ổ trước (đỡ tốn gấp đôi dung lượng và thời gian) |
| `proxy_max_temp_file_size 0` | khi xem hoặc tải video gốc nhiều GB, nginx chuyển dần dữ liệu thay vì chép cả file ra ổ tạm |
| `proxy_read_timeout 300s` | sau khi tải xong video lớn, gallery cần vài giây đọc thông tin video trước khi trả lời |
| `X-Forwarded-For` | **bắt buộc, không được xoá** (xem mục 7) |
| `X-Forwarded-Proto` | gallery thấy `https` thì đặt cookie đăng nhập kèm `Secure` |
| `Host` | giữ nguyên tên miền gốc cho gallery |

Không cần bật `gzip` trong nginx: gallery đã tự nén trang và dữ liệu bằng brotli/gzip, nginx chuyển nguyên. Tua video (Range) và các đoạn HLS `.m3u8`/`.ts` đi qua nginx bình thường, không cần cấu hình thêm.

## 6. Bật HTTPS (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d anh.example.com
```

Nhập email, đồng ý điều khoản, chọn chuyển hướng HTTP sang HTTPS nếu được hỏi. Certbot tự thêm phần `listen 443 ssl` và đường dẫn chứng chỉ vào file nginx ở mục 5.

Chứng chỉ có hạn 90 ngày và được gia hạn tự động. Kiểm tra việc gia hạn chạy được:

```bash
sudo certbot renew --dry-run
```

Mở `https://anh.example.com`: có ổ khoá trên thanh địa chỉ là xong.

## 7. Tạo tài khoản quản trị và đặt lại mật khẩu (qua SSH tunnel)

Vì an toàn, gallery chỉ cho **tạo tài khoản đầu tiên** và **Quên mật khẩu?** khi trang được mở bằng `localhost` ngay trên máy chạy server. Trên VPS không có trình duyệt, nên dùng SSH tunnel để mượn cổng 3000 của VPS về máy bạn.

Trên laptop (PowerShell hoặc Terminal):

```bash
ssh -L 3000:127.0.0.1:3000 kiet@IP_VPS
```

Giữ cửa sổ đó mở, rồi trên laptop mở `http://localhost:3000`. Bạn đang nói chuyện trực tiếp với gallery trên VPS như thể ngồi trước máy đó: tạo tài khoản quản trị, hoặc bấm **Quên mật khẩu?** khi cần. Xong thì đóng cửa sổ SSH. (Nếu gallery trên laptop cũng đang chạy ở cổng 3000, đổi thành `-L 3001:127.0.0.1:3000` và mở `http://localhost:3001`.)

> **Vì sao nginx phải gửi `X-Forwarded-For`:** mọi request từ internet đi qua nginx đều tới gallery từ địa chỉ `127.0.0.1`. Gallery dựa vào header `X-Forwarded-For` để biết request đó thật ra đến từ ngoài. Nếu xoá dòng này, **ai trên internet cũng được coi là "ngồi trên máy chủ"** và có thể đặt lại mật khẩu quản trị. Sau khi cấu hình, mở `https://anh.example.com/login.html` từ điện thoại: **không** được thấy nút **Quên mật khẩu?**.

## 8. Đưa nhiều ảnh lên một lần

Ngoài nút tải lên trên web, có thể chép thẳng ảnh/video vào `~/homelight/storage/import/<tên đăng nhập>/` trên VPS (bằng WinSCP, FileZilla hoặc `scp -r`). Gallery quét thư mục này mỗi 10 giây, thư mục con trở thành album. Cách này nhanh hơn tải qua trình duyệt khi có hàng nghìn ảnh.

## 9. Cập nhật phiên bản mới

```bash
cd ~/homelight
git pull
npm install
pm2 restart homelight
```

Dữ liệu trong `storage/` không nằm trong git nên không bị ảnh hưởng.

## 10. Sao lưu

Mọi thứ cần sao lưu nằm trong `~/homelight/storage/` (ảnh gốc, tài khoản, album, cài đặt). Ảnh nhỏ và bản HLS tạo lại được nếu mất. Ví dụ tạo bản nén mỗi đêm lúc 3 giờ (chạy `crontab -e` rồi thêm dòng):

```
0 3 * * * tar -czf /home/kiet/backup-homelight-$(date +\%F).tar.gz -C /home/kiet/homelight storage
```

Nên chép bản sao lưu ra chỗ khác (laptop, Google Drive, ổ ngoài), vì VPS hỏng thì bản sao lưu nằm trên đó cũng mất. Để chép từ VPS về laptop:

```powershell
scp -r kiet@IP_VPS:~/homelight/storage "D:\backup-homelight"
```

## Khi gặp lỗi

| Hiện tượng | Kiểm tra |
|---|---|
| `502 Bad Gateway` | gallery không chạy: `pm2 status`, `pm2 logs homelight` |
| Tải video lên báo `413 Request Entity Too Large` | `client_max_body_size` trong nginx nhỏ hơn video; hoặc đang bật proxy Cloudflare (mục 1) |
| Tải lên dừng giữa chừng với video lớn | `proxy_request_buffering off` và các timeout trong file nginx; ổ VPS còn trống không: `df -h` |
| Video chỉ phát bản gốc, không có mức 360p/720p | `pm2 logs homelight` xem ffmpeg có lỗi không; VPS 1 vCPU tạo bản HLS chậm, đợi thêm |
| Không vào được sau khi đổi cổng | cổng trong `deploy/ecosystem.config.js` và `proxy_pass` trong nginx phải giống nhau, rồi `pm2 restart homelight` |
| `certbot` báo lỗi xác minh | tên miền chưa trỏ đúng IP, hoặc tường lửa chưa mở cổng 80 |

Muốn để ảnh ở laptop nhà mà vẫn xem được từ xa (không thuê VPS), xem [truy-cap-tu-xa.md](truy-cap-tu-xa.md).
