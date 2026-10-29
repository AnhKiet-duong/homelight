# My Gallery

Gallery ảnh tự host với giao diện điện ảnh: tải ảnh lên, xem theo dòng thời gian và trình chiếu kỷ niệm dạng băng chuyền 3D. Có tài khoản đăng nhập, mỗi người một thư mục ảnh riêng. Chỉ cần Node.js, cài thêm `sharp` để ảnh tải nhanh khi mạng chậm.

## Chạy

```bash
npm install      # một lần: cài sharp để tạo ảnh nhỏ (cần Node.js 20.9+; không cài thì web vẫn chạy, chỉ là luôn gửi ảnh gốc)
node server.js
```

Mở `http://localhost:3000` **ngay trên máy chạy server** để tạo tài khoản quản trị đầu tiên (vì lý do an toàn, bước này không làm được từ máy khác). Sau đó vào trang **Tài khoản** để thêm người dùng khác.

Thiết bị khác cùng mạng Wi‑Fi mở bằng địa chỉ IP mà server in ra. Muốn truy cập từ bất cứ đâu mà ảnh vẫn nằm trên máy mình, xem [docs/truy-cap-tu-xa.md](docs/truy-cap-tu-xa.md).

> Không chạy được trên Vercel/Netlify: các nền tảng đó không giữ file sau mỗi lần chạy nên ảnh tải lên sẽ mất.

## Chép ảnh thẳng từ ổ đĩa

Không cần tải lên qua trình duyệt: chép ảnh (hoặc cả thư mục) vào

```
storage/import/<tên đăng nhập>/
```

Server quét thư mục này mỗi 10 giây (và ngay khi bạn mở trang), chuyển ảnh vào gallery của tài khoản đó, đọc ngày chụp từ EXIF, rồi làm trống thư mục. Thư mục con trở thành album cùng tên (`Đà Lạt 2024/` → album "Đà Lạt 2024"). Ảnh đã có sẵn được để vào `_anh-trung/`, file không phải ảnh vào `_khong-phai-anh/` để bạn xem lại. Server in đường dẫn của từng tài khoản khi khởi động. Muốn đặt thư mục nhập ở chỗ khác (cùng ổ đĩa thì chuyển ảnh tức thì): `IMPORT_DIR=D:\GalleryImport`.

## Tối ưu cho máy chủ là PC cá nhân

Gallery được thiết kế để chạy trên máy tính ở nhà với mạng gia đình. Điểm nghẽn là **tốc độ upload** của mạng nhà (thường chỉ vài chục Mbps, thấp hơn nhiều so với download), nên mọi tối ưu đều nhằm gửi ít dữ liệu nhất có thể cho người xem.

**Ảnh nhỏ thay cho ảnh gốc** (cần `sharp`, cài bằng `npm install`)

- Mỗi ảnh có thêm 3 bản WebP: **nhỏ** (rộng 600px, khoảng 30 KB) cho lưới ảnh, **điện thoại** (rộng 1080px, khoảng 100 KB) và **vừa màn hình** (1920px, khoảng 200 KB) để xem phóng to và trình chiếu. Ảnh gốc 4 MB chỉ tải khi bấm nút **GỐC** trong lúc xem ảnh, hoặc khi tải xuống
- Điện thoại tự dùng bản 1080px, nhẹ bằng khoảng 1/3 (ảnh ngang) đến 1/2 (ảnh dọc) so với bản 1920px. Máy tính và máy tính bảng dùng bản 1920px
- Xem ảnh: hiện ngay ảnh nhỏ đã có, rồi thay bằng ảnh nét khi tải xong
- Lúc ảnh đang tải, ô ảnh hiện màu chủ đạo của ảnh thay vì ô trống; ảnh ngoài màn hình chưa tải (lazy load)
- Ảnh cũ được tạo dần các bản còn thiếu sau khi khởi động server, hoặc ngay khi có người xem. Server chỉ tạo bản còn thiếu, không làm lại bản đã có
- Tạo ảnh nhỏ chạy tối đa 2 ảnh cùng lúc, mỗi ảnh 1 luồng, để máy vẫn mượt khi đang xử lý cả thư viện

**Không gửi lại thứ trình duyệt đã có**

- Ảnh có tên là mã ngẫu nhiên nên nội dung không bao giờ đổi: trình duyệt lưu lại (cache) 1 năm, xem lần sau không tốn đường truyền
- Mọi file (trang web, ảnh) và danh sách ảnh/album đều có **ETag**: trình duyệt hỏi lại "có gì mới không", chưa đổi thì server chỉ trả `304` (vài trăm byte) thay vì gửi lại cả file. Ví dụ quay lại tab gallery không còn tải lại cả danh sách ảnh
- Ảnh chung chỉ cache 5 phút (vì chủ ảnh có thể đổi lại thành riêng tư), sau đó cũng chỉ hỏi lại bằng ETag chứ không tải lại ảnh

**Nén chữ**

- Trang web và dữ liệu JSON được nén **brotli** (trình duyệt cũ thì gzip). Trang chính 150 KB chỉ còn khoảng 30 KB khi gửi đi
- Trang web chỉ nén một lần ở mức nén cao nhất rồi giữ trong RAM, không nén lại mỗi lượt tải nên không tốn CPU của máy

**Nhẹ cho máy chủ**

- Không cần cơ sở dữ liệu hay thư viện nặng: chỉ cần Node.js, dữ liệu là các file JSON trong `storage/`
- Danh sách ảnh được giữ trong RAM, khi đang tạo ảnh nhỏ hàng loạt thì gộp nhiều lần ghi xuống ổ đĩa thành một
- Font chữ tải từ Google Fonts nên không dùng đường truyền nhà bạn

## Tính năng

- Đăng nhập bằng mật khẩu (mã hoá scrypt), giữ đăng nhập 30 ngày, khoá tạm khi nhập sai nhiều lần
- Mỗi người dùng có mã (id) và thư mục ảnh riêng, chỉ thấy ảnh của mình
- Quản trị viên thêm, xoá, đặt lại mật khẩu, cấp quyền cho người dùng
- Ảnh chung: chọn nhiều ảnh rồi bấm **Công khai** để mọi tài khoản cùng xem và tải về (tab **Ảnh chung**); ảnh còn lại vẫn riêng tư. Ảnh công khai vẫn nằm trong thư mục của chủ ảnh, chuyển lại **Riêng tư** bất cứ lúc nào
- Album: tạo album, chọn nhiều ảnh rồi **Thêm vào album**, chọn ảnh bìa, đổi tên, trình chiếu riêng từng album. Album chỉ lưu danh sách ảnh nên một ảnh có thể nằm trong nhiều album, và xoá album không làm mất ảnh
- Tải ảnh bằng nút bấm, kéo thả hoặc dán (Ctrl+V); tự đọc ngày chụp từ EXIF
- Lưới ảnh chia theo năm, nghiêng 3D khi rê chuột, màu ánh sáng lấy từ ảnh
- Ba giao diện, đổi bằng nút **Giao diện** trên thanh trên cùng: **Điện ảnh** (nền tối, nghiêng 3D), **Album giấy** (nền giấy sáng, khung ảnh trắng, chữ kiểu tạp chí) và **Ô màu** (lưới ô bo tròn, thanh bên album, ô "Ngày này năm trước"; trên điện thoại có thanh điều hướng dưới đáy). Lựa chọn được nhớ trong trình duyệt
- Yêu thích, tìm kiếm, sắp xếp, xem phóng to, tải xuống, xoá
- Trình chiếu (`/slideshow.html`): băng chuyền 3D, Ken Burns, nhạc nền, toàn màn hình, phím tắt

## Cấu trúc

- `server.js` — server và API (`/api/photos`, `/api/albums`, `/api/public`, `/api/import`, `/api/login`, `/api/users`, …)
- `media.js` — đọc EXIF, nhận dạng ảnh, tạo ảnh nhỏ bằng sharp
- `public/index.html` — trang gallery
- `public/slideshow.html` — trang trình chiếu
- `public/login.html`, `public/account.html` — đăng nhập, tài khoản và quản lý người dùng
- `storage/` — toàn bộ dữ liệu (không đưa lên git):
  - `users.json` — danh sách tài khoản (mật khẩu đã mã hoá)
  - `sessions.json` — phiên đăng nhập
  - `users/<id>/images/` — ảnh gốc của từng người
  - `users/<id>/thumbs/` — ảnh nhỏ (xoá đi được, server sẽ tạo lại)
  - `import/<tên đăng nhập>/` — thư mục chép ảnh vào
  - `users/<id>/photos.json` — thông tin ảnh của từng người
  - `users/<id>/albums.json` — album của từng người

Sao lưu: chỉ cần copy cả thư mục `storage/`.

Nâng cấp từ bản cũ: ảnh trong `uploads/` và `data.json` sẽ tự chuyển vào tài khoản quản trị khi bạn tạo nó.
