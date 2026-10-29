# My Gallery

Gallery ảnh và video tự host với giao diện điện ảnh: tải ảnh/video lên, xem theo dòng thời gian và trình chiếu kỷ niệm dạng băng chuyền 3D. Có tài khoản đăng nhập, mỗi người một thư mục ảnh riêng. Chỉ cần Node.js, cài thêm `sharp` để ảnh tải nhanh khi mạng chậm và `ffmpeg` để video xem mượt ở mọi tốc độ mạng.

## Chạy

```bash
npm install      # một lần: cài sharp để tạo ảnh nhỏ (cần Node.js 20.9+; không cài thì web vẫn chạy, chỉ là luôn gửi ảnh gốc)
node server.js
```

Mở `http://localhost:3000` **ngay trên máy chạy server** để tạo tài khoản quản trị đầu tiên (vì lý do an toàn, bước này không làm được từ máy khác). Sau đó vào trang **Tài khoản** để thêm người dùng khác.

**Đổi cổng:** quản trị viên vào **Tài khoản → Cổng máy chủ**, nhập cổng mới (1024–65535). Server mở cổng mới ngay không cần chạy lại, trang tự chuyển sang địa chỉ mới, và cổng được lưu trong `storage/settings.json` cho những lần sau. Chạy bằng `PORT=8080 node server.js` thì biến `PORT` được ưu tiên và không đổi được trong trang. Xoá `storage/settings.json` để quay về cổng 3000.

Thiết bị khác cùng mạng Wi‑Fi mở bằng địa chỉ IP mà server in ra. Muốn truy cập từ bất cứ đâu mà ảnh vẫn nằm trên máy mình, xem [docs/truy-cap-tu-xa.md](docs/truy-cap-tu-xa.md).

> Không chạy được trên Vercel/Netlify: các nền tảng đó không giữ file sau mỗi lần chạy nên ảnh tải lên sẽ mất.

## Video

Tải video lên như ảnh (nút **Tải ảnh lên**, kéo thả), hoặc chép vào thư mục nhập bên dưới. Nhận MP4, MOV (iPhone), MKV, WebM, AVI, 3GP, MTS; tối đa 4 GB mỗi video (đổi bằng `VIDEO_MAX_MB=8192`). Ngày quay đọc từ thông tin trong file.

Để video xem mượt khi mạng chậm, cài **ffmpeg** trên máy chạy server (một lần), rồi mở lại cửa sổ chạy server:

```bash
winget install Gyan.FFmpeg      # Windows
# macOS: brew install ffmpeg    Linux: sudo apt install ffmpeg
```

Có ffmpeg, mỗi video được chuyển sang **HLS** (cách YouTube phát video): cắt thành đoạn 4 giây ở nhiều mức chất lượng, tính theo cạnh ngắn của video:

| Mức | Bitrate tối đa | Dùng khi |
| --- | --- | --- |
| 360p | 0,8 Mbps | mạng 3G, Wi‑Fi yếu |
| 720p | 2,5 Mbps | 4G, mạng nhà bình thường |
| 1080p | 5 Mbps | mạng tốt |
| 1440p (2K) | 9 Mbps | mạng nhanh, xem trong mạng nhà |
| 2160p (4K) | 16 Mbps | xem trong mạng nhà, màn hình 4K |

- Chỉ tạo mức không vượt quá video gốc (video 1080p có 360p, 720p, 1080p; video 4K có đủ 5 mức). 360p luôn được tạo trước, nên video xem được ở mạng chậm chỉ sau vài giây; các mức cao hơn làm dần sau. Nhiều video cùng lúc thì video nào cũng có 360p trước rồi mới tới 720p
- Trình xem tự chọn mức theo tốc độ mạng đo được và **đổi mức ngay giữa chừng** khi mạng nhanh lên hay chậm đi, không phải tải lại từ đầu. Màn hình nhỏ không tải bản 2K/4K. Nút chất lượng trong lúc xem cho chọn tay: Tự động, từng mức, hoặc Bản gốc (lựa chọn được nhớ)
- Ảnh bìa lấy từ một khung hình đầu video, rồi làm ảnh nhỏ như ảnh thường cho lưới ảnh
- Chạy ffmpeg ở mức ưu tiên thấp, mỗi lúc một video, để máy vẫn dùng được trong lúc chuyển đổi. Video 4K dài có thể mất vài phút; server in ra mỗi khi xong một mức
- Trình phát hls.js tải từ CDN (không tốn đường truyền nhà bạn), CDN không vào được thì dùng bản có sẵn trong `public/vendor/`. Safari và iPhone phát HLS sẵn
- Chưa có ffmpeg (hoặc mức đầu tiên chưa xong) thì phát file gốc, vẫn tua được tới đâu tải tới đó. Video iPhone (HEVC) có thể không phát được trên Chrome cho tới khi ffmpeg chuyển đổi xong
- **Tiết kiệm dữ liệu** (menu **Giao diện**, hoặc nút chất lượng lúc xem video): bật khi xem bằng 4G/5G. Video "Tự động" không lên quá 360p (khoảng 350 MB/giờ, so với khoảng 2 GB/giờ ở 1080p), mở video không tự phát, chỉ tải trước 12 giây; ảnh xem phóng to và trình chiếu dùng cỡ 1080px. Tuỳ chọn lưu theo **từng tài khoản** trên server, nên bật trên điện thoại thì máy khác đăng nhập cùng tài khoản cũng được áp dụng
- Bản HLS nằm trong `storage/users/<id>/thumbs/<id video>-hls/`, chiếm thêm khoảng 30–60% dung lượng video gốc (video 4K nhiều hơn). Xoá đi được, server sẽ tạo lại khi khởi động. ffmpeg cài ở chỗ khác thì đặt `FFMPEG_PATH`

## Chép ảnh thẳng từ ổ đĩa

Không cần tải lên qua trình duyệt: chép ảnh, video (hoặc cả thư mục) vào

```
storage/import/<tên đăng nhập>/
```

Server quét thư mục này mỗi 10 giây (và ngay khi bạn mở trang), chuyển ảnh vào gallery của tài khoản đó, đọc ngày chụp từ EXIF, rồi làm trống thư mục. Thư mục con trở thành album cùng tên (`Đà Lạt 2024/` → album "Đà Lạt 2024"). Ảnh đã có sẵn được để vào `_anh-trung/`, file không phải ảnh vào `_khong-phai-anh/` để bạn xem lại. Server in đường dẫn của từng tài khoản khi khởi động. Muốn đặt thư mục nhập ở chỗ khác (cùng ổ đĩa thì chuyển ảnh tức thì): `IMPORT_DIR=D:\GalleryImport`.

## Xem ảnh trên ổ cứng ngoài (không chép vào máy)

Muốn xem ảnh/video đang nằm trên ổ cứng ngoài mà không tốn dung lượng máy: cắm ổ vào, đăng nhập bằng tài khoản quản trị, vào **Tài khoản → Ổ cứng ngoài**, bấm **Chọn thư mục…** (hoặc gõ đường dẫn, vd. `E:\Anh gia dinh`), chọn gallery của ai sẽ hiện các ảnh này rồi bấm **Liên kết thư mục**.

- Ảnh và video được **đọc tại chỗ**, không chép vào máy. File gốc không bao giờ bị sửa, đổi tên hay xoá; nút xoá trong gallery chỉ **ẩn** ảnh đó
- Thư mục con thành album cùng tên. Thêm hay xoá ảnh trên ổ thì gallery tự cập nhật (quét lại mỗi 5 phút, hoặc bấm **Quét lại**)
- Ảnh nhỏ và bản HLS của video mặc định lưu ngay trên ổ đó, trong thư mục ẩn `.homelight` (xoá đi được, gallery tạo lại khi cần). Ổ chỉ đọc, hoặc bỏ chọn ô này, thì lưu trên máy: khoảng 0,4 MB mỗi ảnh, video thì cỡ 30–60% video gốc
- **Rút ổ ra**: ảnh trong đó tạm ẩn khỏi gallery (album, yêu thích, công khai vẫn được giữ). Cắm lại là hiện lại sau vài giây. Windows đổi ký tự ổ (E: thành F:) thì server tự tìm ra; nếu không, bấm **Đổi đường dẫn**
- Lần đầu liên kết một ổ nhiều ảnh, server cần một lúc để đọc và tạo ảnh nhỏ; ảnh hiện dần trong gallery. Ổ USB 2.0 hoặc ổ HDD sẽ chậm hơn SSD
- Chỉ quản trị viên được liên kết thư mục (vì nó cho đọc ổ đĩa của máy chủ). Danh sách lưu trong `storage/links.json`
- Định dạng: JPEG, PNG, GIF, WebP, AVIF, BMP, HEIC (iPhone) và các video như phần trên

## Ảnh HEIC của iPhone

Chrome, Edge và Firefox không mở được ảnh HEIC, còn sharp cài từ npm không có bộ giải mã HEVC (vướng bản quyền). Vì vậy server dùng thêm `heic-decode` (cài cùng `npm install`) để giải mã HEIC một lần, rồi tạo ảnh nhỏ WebP như mọi ảnh khác. Gallery hiện ảnh WebP; nút tải xuống vẫn trả về file HEIC gốc. Ngày chụp được đọc từ EXIF trong file HEIC. Mỗi ảnh 12 MP mất khoảng 1–2 giây để giải mã lần đầu, các lần xem sau thì nhanh như ảnh thường.

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
- Xem video ở cả ba giao diện, tự đổi chất lượng theo mạng (xem phần **Video**)
- Lưới ảnh chia theo năm, nghiêng 3D khi rê chuột, màu ánh sáng lấy từ ảnh
- Ba giao diện, đổi bằng nút **Giao diện** trên thanh trên cùng: **Điện ảnh** (nền tối, nghiêng 3D), **Album giấy** (nền giấy sáng, khung ảnh trắng, chữ kiểu tạp chí) và **Ô màu** (lưới ô bo tròn, thanh bên album, ô "Ngày này năm trước"; trên điện thoại có thanh điều hướng dưới đáy). Lựa chọn được nhớ trong trình duyệt
- Yêu thích, tìm kiếm, sắp xếp, xem phóng to, tải xuống, xoá
- Trình chiếu (`/slideshow.html`): băng chuyền 3D, Ken Burns, nhạc nền, toàn màn hình, phím tắt

## Cấu trúc

- `server.js` — server và API (`/api/photos`, `/api/albums`, `/api/public`, `/api/import`, `/api/links`, `/api/login`, `/api/users`, …)
- `media.js` — đọc EXIF, nhận dạng ảnh, tạo ảnh nhỏ bằng sharp
- `video.js` — nhận dạng video, đọc thông tin, tạo ảnh bìa và bản HLS bằng ffmpeg
- `public/vendor/hls.light.min.js` — trình phát HLS (hls.js 1.7.3, giấy phép Apache 2.0), dự phòng khi không tải được từ CDN
- `public/index.html` — trang gallery
- `public/slideshow.html` — trang trình chiếu
- `public/login.html`, `public/account.html` — đăng nhập, tài khoản và quản lý người dùng
- `storage/` — toàn bộ dữ liệu (không đưa lên git):
  - `users.json` — danh sách tài khoản (mật khẩu đã mã hoá)
  - `sessions.json` — phiên đăng nhập
  - `users/<id>/images/` — ảnh gốc của từng người
  - `users/<id>/thumbs/` — ảnh nhỏ, ảnh bìa và bản HLS của video (xoá đi được, server sẽ tạo lại)
  - `import/<tên đăng nhập>/` — thư mục chép ảnh vào
  - `links.json` — các thư mục liên kết trên ổ cứng ngoài
  - `users/<id>/photos.json` — thông tin ảnh của từng người
  - `users/<id>/albums.json` — album của từng người

Sao lưu: chỉ cần copy cả thư mục `storage/`.

Nâng cấp từ bản cũ: ảnh trong `uploads/` và `data.json` sẽ tự chuyển vào tài khoản quản trị khi bạn tạo nó.
