# Kiến trúc và logic của homelight (My Gallery)

Tài liệu này mô tả cách homelight hoạt động bên trong: dữ liệu nằm đâu, luồng xử lý chính, các quy tắc
không được phá vỡ, và chỗ các phần dính vào nhau. Dùng nó để trả lời câu hỏi về tính năng và để kiểm tra
một tính năng mới có xung đột với logic cũ không (xem mục 12, "Kiểm tra xung đột").

Tham chiếu dùng **tên hàm** thay vì số dòng (số dòng đổi liên tục). Tìm bằng `grep -n "function tênHàm" server.js`.
Khi sửa code làm thay đổi điều gì ở đây, sửa tài liệu này trong cùng commit.

---

## 1. Tổng quan

- Node.js ≥ 18, **không framework, không build**. Một file server (`server.js`) dùng `http.createServer(handle)`.
- Hai module phụ: `media.js` (ảnh: nhận dạng, EXIF, ảnh nhỏ WebP bằng sharp) và `video.js` (ffmpeg/ffprobe, HLS).
- Giao diện: 4 trang HTML độc lập trong `public/` (`index.html`, `account.html`, `login.html`, `slideshow.html`),
  mỗi trang tự có `<style>` và `<script>`. Script dùng chung duy nhất là `public/i18n.js`; các hàm như `api()`, `toast()`
  bị chép lặp giữa các trang: sửa một chỗ phải sửa các bản chép.
- Thư viện tuỳ chọn (optionalDependencies): `sharp` (ảnh nhỏ), `heic-decode` (ảnh HEIC iPhone),
  `@ffmpeg-installer/ffmpeg` + `@ffprobe-installer/ffprobe` (ffmpeg đóng gói; ffmpeg cài trên máy được ưu tiên hơn, mục 5.1).
  Thiếu thư viện nào thì tính năng đó tự tắt, phần còn lại vẫn chạy
  (code không được giả định ảnh nhỏ / HLS / `color` luôn có).
- Toàn bộ dữ liệu trong `storage/` (không đưa lên git). Comment và thông báo trong code bằng tiếng Việt.
- README.md (tiếng Anh) là tài liệu cho người dùng; `docs/truy-cap-tu-xa.md` hướng dẫn truy cập từ xa.

### Sơ đồ file

| File | Vai trò |
| --- | --- |
| `server.js` | Mọi thứ phía server: cấu hình, tài khoản, phiên, API, phục vụ file, thư viện ảnh, nhập ảnh, video pipeline, thư mục liên kết (ổ ngoài) |
| `media.js` | `SIZES`, `sniffType`, `exifDate`, `heicDate`, `imageSize`, `variantPath`, hàng đợi `queueVariants`/`pump` |
| `video.js` | Chọn ffmpeg, `sniffVideo`, `probe`, `plan`/`QUALITIES`, hàng đợi `posterLane`/`hlsLane`, `makePoster`, `makeRendition`, `cancel`, `masterPlaylist`, `pump` |
| `public/index.html` | Gallery: lưới ảnh, album, chia sẻ, tải lên, lightbox (zoom), trình phát video, chủ đề, tiết kiệm dữ liệu |
| `public/account.html` | Tài khoản, ngôn ngữ, mật khẩu; admin: người dùng, cổng, chất lượng video, ổ cứng ngoài |
| `public/login.html` | Đăng nhập, tạo admin đầu tiên, chọn ngôn ngữ trước khi đăng nhập |
| `public/slideshow.html` | Trình chiếu 3D, tự đọc `/api/photos` |
| `public/i18n.js` + `public/i18n/*.js` | Hệ thống đa ngôn ngữ (mục 10) |
| `public/vendor/hls.light.min.js` | hls.js 1.7.3 dự phòng khi CDN lỗi (đổi phiên bản thì đổi cả URL CDN trong index.html) |

---

## 2. Lưu trữ và trạng thái

### 2.1 Thư mục `storage/`

```
storage/
  settings.json            { port?, videoMode?: 'lite'|'full' }
  users.json               [{ id, username, role: 'admin'|'user', salt, hash, created, prefs?: { dataSaver?, lang? } }]
  sessions.json            { sha256(token): { uid, exp } }
  links.json               [{ id, uid, name, path, cache: 'drive'|'local', hidden: [rel], created }]
  import/<username>/       thư mục nhập ảnh (+ _anh-trung/, _khong-phai-anh/)
  users/<uid>/
    photos.json            danh sách ảnh + video (mục 4.1)
    albums.json            [{ id, name, photoIds, cover, created, link? }]
    images/                file gốc <uuid><ext> (đang tải video: <uuid>.part)
    thumbs/                <photoId>-sm|ph|md.webp, <photoId>-poster.jpg, <photoId>-hls/<q>/
```

Ổ ngoài dùng cache trên ổ: `<thư mục liên kết>/.homelight/` gồm `link.json` (dấu nhận ổ), `README.txt`,
`cache/` (cùng kiểu tên như `thumbs/`). Đường dẫn cache của một ảnh luôn lấy qua `cacheDir(uid, p)`,
file gốc qua `originalPath(uid, p)`.

Bản cũ (trước khi có tài khoản): `data.json` + `uploads/` ở gốc; `migrateLegacy` chuyển sang admin đầu tiên
lúc `/api/setup` rồi đổi tên thành `data.json.migrated`.

### 2.2 Quy tắc trạng thái (rất quan trọng)

- **Bộ nhớ là nguồn sự thật.** `settings`, `users`, `sessions`, `links` đọc một lần lúc khởi động;
  `photos.json`/`albums.json` của từng người đọc lần đầu cần rồi giữ trong `photoCache`/`albumCache`.
  Server không bao giờ đọc lại file JSON khi đang chạy: sửa tay file trong `storage/` lúc server chạy sẽ bị ghi đè.
- Mọi thay đổi: **sửa object trong bộ nhớ trước, rồi gọi hàm lưu** tương ứng
  (`saveUsers`, `saveSessions`, `saveSettings`, `saveLinks`, `savePhotos`, `savePhotosSoon` (gộp ghi sau 2 giây), `saveAlbums`).
  Không ghi các file này bằng `fs` trực tiếp.
- `writeJson` chụp dữ liệu ngay lúc gọi, xếp hàng ghi theo từng file, ghi `.tmp` rồi đổi tên (không bao giờ có file ghi dở).
  Lỗi ghi chỉ được log; promise vẫn resolve.
- `readJson` trả về giá trị mặc định khi file hỏng: `users.json` hỏng sẽ thành `[]` (mở lại màn hình tạo admin).
- `photoIndex(list, key)` cache tra cứu theo `file`/`id` trong một WeakMap theo mảng, chỉ dựng lại khi **độ dài** mảng đổi.
  Sửa `p.file`/`p.id` tại chỗ mà không đổi độ dài thì phải gọi `indexes.delete(list)` (như `scanLink` làm).
- `processVideo` giữ tham chiếu tới object ảnh và kiểm tra `getPhotos(uid).includes(photo)` (`alive()`) để biết ảnh
  đã bị xoá; ảnh không còn thì nó **xoá cả thư mục HLS**. (`makeThumbs` thì tìm lại ảnh theo `id` rồi ghi `color`/`w`/`h`.)
  Xoá ảnh = thay mảng bằng mảng đã lọc. **Đừng dựng lại object ảnh mới thay cho object cũ**; hãy sửa tại chỗ.
- **Mảng cũ sau `await`:** `photosApi`/`albumsApi` lấy `getPhotos(uid)`/`getAlbums(uid)` *trước* khi chờ đọc body rồi lưu
  chính mảng đó. Nếu giữa chừng có xoá ảnh / `forgetPhotos` (quét ổ mỗi 5 phút) thay mảng, lần lưu sẽ hồi sinh bản ghi
  đã xoá và làm mất bản ghi mới (tải lên ảnh 50 MB là dễ dính nhất). Code mới: gọi lại `getPhotos(uid)` **sau** mọi `await`
  rồi mới sửa / lưu.
- Ngoại lệ của "không đọc lại": sau khi xoá một người dùng, job còn chạy gọi `getPhotos(uid)` sẽ đọc lại file không còn
  (được `[]`) và có thể ghi `photos.json` vào thư mục đã xoá.
- Trạng thái chỉ nằm trong bộ nhớ (mất khi khởi động lại): `loginFails`, `thumbFailed`, `notMedia`, `linkStates`,
  `importStates`, `videoJobs`, `videoLevel`, `driveLanes`, `openReads`.

### 2.3 Cấu hình

- Cổng: biến môi trường `PORT` > `settings.port` > 3000. Có `PORT` thì giao diện không được đổi cổng (409).
  `switchPort` mở cổng mới trước, đóng cổng cũ sau 3 giây (kết nối đang tải được 10 phút), chỉ lưu `settings.port` khi thành công.
- Biến môi trường khác: `IMPORT_DIR`, `VIDEO_MAX_MB` (mặc định 4096), `FFMPEG_PATH`, `FFPROBE_PATH`.
- Giới hạn: ảnh tải lên 50 MB (đọc cả vào RAM), ảnh nhập 200 MB, video `VIDEO_MAX_MB` (ghi thẳng ra đĩa), JSON body 64 KB.
- Cài đặt chung của máy chủ (chỉ admin): thêm vào `settings` + `saveSettings`, trả ra trong `view()` của `/api/settings`.
- Tuỳ chọn riêng từng tài khoản: `user.prefs`. `POST /api/prefs` chỉ nhận các khoá đã kiểm tra
  (`dataSaver` boolean, `lang` trong `LANGS`); thêm tuỳ chọn mới phải thêm kiểm tra ở đó và giá trị mặc định
  trong `GET /api/status` (`prefs: { dataSaver: false, ...user.prefs }`).

---

## 3. Server: tài khoản, phiên, định tuyến, phục vụ file

### 3.1 Tài khoản và phiên

- Mật khẩu: `scrypt(password, salt 16 byte, 64)`; `checkPassword` luôn chạy scrypt (kể cả tên không tồn tại) và so sánh `timingSafeEqual`.
- Tên đăng nhập: chữ thường `^[a-z0-9._-]{3,32}$`, **không đổi được** (thư mục nhập `import/<username>` gắn theo tên).
- Phiên: token 32 byte ngẫu nhiên trong cookie `sid` (`HttpOnly; SameSite=Lax`, thêm `Secure` khi `X-Forwarded-Proto: https`);
  `sessions.json` chỉ lưu **sha256 của token**. Hạn cố định 30 ngày, không gia hạn; phiên hết hạn chỉ bị dọn lúc khởi động.
- `sessionOf` tra người dùng trực tiếp trong `users`, nên đổi quyền / tuỳ chọn có hiệu lực ngay.
- Khoá đăng nhập: sai 10 lần theo **tên đăng nhập** (không theo IP) thì khoá 15 phút, chỉ trong bộ nhớ.
- Admin đầu tiên: `POST /api/setup` chỉ khi chưa có tài khoản **và** yêu cầu từ máy chủ (`isLocalRequest`: loopback
  và không có `X-Forwarded-For`, nên không tạo được qua tunnel). Không được thêm đường nào khác tạo admin đầu tiên.
- Luôn trả người dùng qua `publicUser` (không bao giờ lộ `salt`/`hash`/`prefs`).
- Admin không tự bỏ quyền hay tự xoá mình, nên luôn còn ít nhất một admin. Đổi mật khẩu đăng xuất các phiên khác (`dropSessions`).

### 3.2 Định tuyến (`handle`)

1. `/api/*`: chia theo `parts[1]` cho `public`, `photos`, `albums`, `import`, `links`; còn lại vào `authApi`
   (status/setup/login/logout không cần phiên; prefs/password/settings/users cần phiên).
2. Ngoài API chỉ nhận GET/HEAD (khác: 405). Chưa đăng nhập: trang `.html` chuyển sang `/login.html?next=...`, file khác 401.
   Mở không cần đăng nhập: `/login.html`, `/favicon.ico`, `/i18n.js`, `/i18n/<chữ thường>.js` (regex `OPEN_I18N` cố tình chặt).
3. `/uploads/<file>[?s=sm|ph|md]` và `/uploads/<file>/hls/...`: chỉ tìm trong ảnh **của chính người đang đăng nhập**
   (theo `p.file`), cache 1 năm `immutable`; ảnh trên ổ đang rút trả 503. Ngoại lệ: `master.m3u8` là `no-cache`;
   khi chưa làm được ảnh nhỏ, ảnh gửi file gốc với `max-age=600`, video gửi SVG giữ chỗ `no-store`, nhưng ảnh bìa
   (khi thiếu sharp) lại được cache `immutable` dưới URL `?s=`.
4. `/shared/<ownerId>/<file>[...]`: ảnh của người khác, chỉ khi `p.public`, cache 5 phút.
5. Còn lại: file tĩnh trong `public/` qua `safeJoin` + `serveFile` (`no-cache` + ETag).

Lỗi: ném `httpError(status, 'thông báo tiếng Việt')`; `handle` trả `{ error }`. Lỗi không có status thành 500 "Lỗi server".
Nhiều chỗ khác trả thẳng chữ thường (vd. `send(res, 404, 'Không tìm thấy')`, 503 ổ rút, 405), không phải `{ error }`.
Các route media trong `handle` viết `return serveVariant(...)` **không có `await`**, nên lỗi của chúng thoát khỏi `try/catch`
(thành unhandled rejection). Route mới nên viết `return await ...`.

### 3.3 Trả dữ liệu và file

- `send()`: object thành JSON; GET 200 **trả JSON** và không đặt cookie thì có ETag (`private, no-cache`, trả 304 khi khớp),
  còn lại `no-store`; nén br/gzip khi > 1 KB.
- `readJsonBody` bắt buộc `Content-Type: application/json`, chống CSRF cùng với `SameSite=Lax`. Endpoint mới có body nên dùng nó.
  Hiện vẫn có các POST không body chỉ dựa vào `SameSite=Lax`: logout, `POST /api/import`, `links/:id/scan`, `links/:id/eject`
  (các route DELETE được trình duyệt chặn bằng preflight CORS).
- `serveFile`: ETag yếu `size-mtime`, hỗ trợ một khoảng Range (video tua được), file chữ được nén tối đa một lần rồi giữ trong RAM.
  Mọi file gửi cho người xem mở bằng **`readStream()`** (ghi vào `openReads`) để ngắt ổ đóng được file; code mới stream file gốc
  phải dùng `readStream`, không dùng `fs.createReadStream`.
- Chỉ có header bảo mật `X-Content-Type-Options: nosniff` (không CSP). Không nhận ảnh SVG (có thể chứa script).

### 3.4 Bảng API

| Route | Quyền | Ghi chú |
| --- | --- | --- |
| `GET /api/status` | mở | `{ user, prefs, needsSetup, canSetup }`; mọi trang dùng để khởi động |
| `POST /api/setup` | mở, chỉ máy chủ, chưa có tài khoản | tạo admin đầu tiên + chuyển dữ liệu cũ |
| `POST /api/login`, `POST /api/logout` | mở | |
| `POST /api/prefs` | phiên | `{ dataSaver?, lang? }` |
| `POST /api/password` | phiên | `{ current, next }` |
| `GET/PUT /api/settings` | admin | `{ port }` hoặc `{ videoMode }` (có `videoMode` thì bỏ qua `port`) |
| `GET/POST /api/users`, `PATCH/DELETE /api/users/:id` | admin | xoá người dùng: gỡ link, xoá phiên, `rm -rf users/<id>` (không xoá `import/<username>`) |
| `GET/POST /api/photos` | phiên | POST: body là file thô (mục 4.2) |
| `POST /api/photos/bulk` | phiên | `{ ids, public }`, chỉ đổi được `public` |
| `PATCH/DELETE /api/photos/:id` | phiên, ảnh của mình | PATCH `{ fav?, public?, name? }` |
| `GET /api/public` | phiên | ảnh công khai của mọi người (có `owner`, `mine`) |
| `GET/POST /api/albums`, `PATCH/DELETE /api/albums/:id` | phiên, album của mình | PATCH `{ name?, add?, remove?, cover? }` |
| `GET/POST /api/import` | phiên | trạng thái / quét ngay (chờ tối đa 1,5 giây) |
| `GET /api/links` | phiên | admin thấy hết, người dùng thấy link của mình |
| `GET /api/links/browse?path=` | admin | duyệt thư mục máy chủ |
| `POST /api/links`, `PATCH/DELETE /api/links/:id` | admin | |
| `POST /api/links/:id/scan`, `POST /api/links/:id/eject` | chủ link hoặc admin | quét lại / kết nối lại; ngắt ổ an toàn |

Người không có quyền với một link nhận 404 (không phải 403). Kiểm tra quyền admin **luôn ở server**;
việc ẩn panel trong `account.html` chỉ là giao diện.

---

## 4. Thư viện ảnh

### 4.1 Bản ghi trong `photos.json`

Chung: `id` (UUID, khoá chính, dùng trong album và tên ảnh nhỏ), `name` (≤ 200), `file` (tên trong URL, duy nhất trong
danh sách của một người), `url`, `type` (MIME), `size`, `w`/`h` (kích thước hiển thị sau khi xoay), `taken`, `added`,
`fav`, `public`, `color` ("r g b", màu nền khi đang tải; có thể chưa có), `hash` (SHA-1 cả file; chỉ ảnh trong máy).
`kind: 'video'` **chỉ có ở video**: luôn kiểm tra `p.kind === 'video'`, không bao giờ `kind === 'image'`.

Video thêm: `duration`, `fps`, `hls: { '<q>': { kbps, w, h } }` (các mức đã xong), `vfail: true`
(lỗi vĩnh viễn; tự xoá khi file trên ổ ngoài bị thay. Muốn thử lại bằng tay: **tắt server**, xoá dòng `vfail` trong
`photos.json`, chạy lại; sửa lúc server chạy thì bị ghi đè).
Ảnh trên ổ ngoài thêm: `link` (id link), `rel` (đường dẫn trong thư mục), `mtime`.

`photoView` là **nơi duy nhất** quyết định dữ liệu gửi cho trình duyệt: bỏ `hash`, `hls`, `vfail`, `rel`, `mtime`;
thêm `thumb` (`?s=sm`), `preview` (`?s=md`, GIF thì là file gốc để giữ ảnh động); video thêm `hls` (URL master hoặc null),
`qualities`, `processing`. Trường nội bộ mới không được lộ ra thì thêm vào danh sách bỏ của `photoView`.
`publicPhotos` dựa trên `photoView` (thêm `owner`, `mine`, ép `fav: false`), nên mọi thứ `photoView` lộ ra cũng lộ cho
người khác với ảnh công khai. `albumView` tự dựng `coverUrl`/`coverThumb` từ `p.url`, không qua `photoView`.

### 4.2 Ba đường ảnh vào thư viện

1. **Tải lên** (`POST /api/photos`, `photosApi`): body là file thô, header `X-Filename` (encodeURIComponent),
   `X-Width`, `X-Height`, `X-Taken`, `X-Duration`. Ảnh: tin `Content-Type` khai báo (chỉ HEIC được dò lại), đọc vào RAM,
   lưu `images/<uuid><ext>`, **không** kiểm tra trùng. Video (`uploadVideo`): stream ra `.part`, dò định dạng bằng
   `sniffVideo`, đổi tên, `videoInfo` (ffprobe, không có thì dùng header), rồi `processVideo`.
   Đang mở một album thì trình duyệt tự thêm ảnh vừa tải vào album đó.
2. **Thư mục nhập** `storage/import/<username>/` (`scanImports` mỗi 10 giây, `importUser`): bỏ file mới sửa < 3 giây
   (đang chép), dò định dạng bằng nội dung, chuyển vào `images/`, băm SHA-1; trùng thì chuyển sang `_anh-trung/`,
   không phải ảnh/video hoặc quá lớn thì sang `_khong-phai-anh/`. Thư mục con thành album (tên `a / b`, ghép vào album
   **trùng tên** có sẵn, kể cả album người dùng tự tạo). Windows: file đang chép báo EBUSY/EPERM thì thử lại lần quét sau.
3. **Thư mục liên kết trên ổ ngoài** (mục 6): đọc tại chỗ, không chép.

Chống trùng chỉ dùng khi nhập: tập hash gồm mọi ảnh không thuộc link (kể cả ảnh tải lên). Ảnh trên ổ ngoài không có hash.
`POST /api/import` quét thư mục nhập của **mọi** người dùng, không chỉ người gọi. File 0 byte nằm lại thư mục nhập mãi.

Thêm một định dạng mới phải sửa cùng lúc: `IMAGE_TYPES` / `video.VIDEO_TYPES`, `media.sniffType` / `video.sniffVideo`,
`MEDIA_EXT` (thư mục liên kết lọc theo **đuôi file trước** rồi mới dò nội dung), `STATIC_TYPES`, và regex
`isVideoFile` / `isHeicFile` cùng `accept` của ô chọn file trong `index.html`.

### 4.3 Ảnh nhỏ (`media.js`)

- `SIZES`: `sm` 600×1500 (lưới), `ph` 1080×1920 (lightbox trên điện thoại / tiết kiệm dữ liệu), `md` 1920×1920 (lightbox máy tính).
  Đây là các giá trị `?s=` hợp lệ duy nhất. Thêm khoá mới: ảnh trong máy được bổ sung lúc khởi động, ảnh trên ổ ngoài ở
  lần quét đầu sau khi cắm / khởi động, còn video chỉ khi cỡ đó được yêu cầu lần đầu. Sửa thông số khoá cũ thì ảnh nhỏ cũ
  **không** tự làm lại. Đổi tên `ph`/`md` sẽ làm hỏng regex của `forScreen()` (index.html) và của slideshow.
- `makeVariants`: HEIC giải mã bằng heic-decode (đã xoay đúng), ảnh khác `sharp(...).rotate()` theo EXIF; ghi `.tmp` rồi đổi tên;
  bỏ qua cỡ đã có; trả về `color` lấy từ ảnh `sm`.
- `queueVariants`: tối đa **2 job cùng lúc** cho toàn server, gộp job trùng, `urgent` (có người đang chờ xem) chen lên đầu.
  Job của ảnh trên ổ ngoài mang `slot` (mục 7).
- `makeThumbs` (server): video thì tạo ảnh bìa bằng ffmpeg trước rồi làm ảnh nhỏ từ ảnh bìa. Lỗi thật thì ghi vào
  `thumbFailed`, không thử lại cho tới khi khởi động lại hoặc file trên ổ ngoài bị thay. Bị huỷ / ổ rút / đường dẫn đổi thì
  **không** tính là lỗi.
- `serveVariant`: chưa có ảnh nhỏ thì tạo ngay (urgent); không tạo được: ảnh gửi file gốc, video gửi ảnh bìa hoặc SVG giữ chỗ.
- Nút "Ảnh gốc" bị ẩn với `image/heic`, nhưng nếu thiếu sharp / heic-decode thì `serveVariant` vẫn gửi file HEIC gốc
  cho `?s=` và trình duyệt hiện ảnh hỏng.
- `w`/`h` trình duyệt gửi khác 0 thì không bao giờ được sửa; gửi 0 (HEIC, định dạng Chrome không đọc được) thì `makeThumbs`
  điền lại. Video lấy kích thước / thời lượng từ ffprobe trước, header sau.

### 4.4 Album, yêu thích, chia sẻ, xoá

- Album chỉ chứa `photoIds`; `GET /api/albums` lọc bỏ id không còn / đang ẩn (nhưng phản hồi của `POST`/`PATCH` album dùng
  cả danh sách, nên có thể trả id / bìa của ảnh trên ổ đang rút). Tối đa 500 album khi tạo bằng tay.
- Thư mục con (nhập hoặc ổ ngoài) thành album, **ghép theo tên** vào album bất kỳ đã có cùng tên. Album mới tạo từ ổ ngoài
  có `link`: bị ẩn khi ổ rút, và chỉ bị xoá trong `forgetPhotos` (file biến mất / gỡ link) khi rỗng. Album ghép vào album
  có sẵn thì không có `link`, nên ảnh nhập và ảnh ổ ngoài có thể nằm chung một album.
- "Công khai" **không phải** ẩn danh: chỉ tài khoản khác trong gallery xem được (`/shared/...`), vẫn cần đăng nhập.
- Xoá ảnh: bỏ khỏi mọi album (và `cover`), `dropThumbs`, rồi: ảnh trong máy thì xoá file gốc;
  **ảnh trên ổ ngoài chỉ bị ẩn** (thêm `rel` vào `links.json` `hidden`), file trên ổ không bao giờ bị đụng tới.
  Chưa có API bỏ ẩn. `dropThumbs` chỉ dừng được ffmpeg HLS; ảnh bìa và sharp đang đọc file vẫn chạy, nên trên Windows
  xoá file gốc có thể lỗi EBUSY (bị nuốt) và để lại file mồ côi trong `images/`. Xoá được cả ảnh của ổ đang rút.

### 4.5 Quy tắc về URL và cache

- `p.file` là khoá URL và được cache 1 năm `immutable`. Ảnh trong máy tên `<uuid><ext>` nên nội dung không bao giờ đổi.
  Ảnh trên ổ ngoài tên `<id>.<mtime base36><ext>`: file trên ổ bị thay thì URL đổi.
  **Tính năng nào sửa nội dung file tại chỗ phải đổi tên file/URL**, nếu không trình duyệt hiện bản cũ.
  Ảnh nhỏ đặt theo `p.id`, nên đổi nội dung phải `dropThumbs`.
- Tra file luôn qua bản ghi (`photoIndex(getPhotos(uid), 'file')` + `originalPath`), không bao giờ ghép đường dẫn từ URL.
  Route media mới phải giữ nguyên quy tắc này (cách ly người dùng, chống `../`).

---

## 5. Video

### 5.1 Công cụ và thông tin

- `pickTools` lúc tải module: `FFMPEG_PATH` > ffmpeg trong PATH > gói npm > không có. Cần cả ffmpeg lẫn ffprobe.
  Có `FFMPEG_PATH` mà hỏng thì **không** thử tiếp các nguồn khác (video tắt); `FFPROBE_PATH` chỉ được đọc khi có `FFMPEG_PATH`.
  Kiểm tra bằng `spawnSync -version` (có thể làm chậm lúc khởi động).
- `sniffVideo` nhận dạng bằng byte đầu file (loại HEIC/AVIF/nhạc M4A khỏi MP4). `probe` đọc kích thước đã xoay,
  thời lượng, fps, ngày quay (trước năm 1971 coi như không có).
- Không có ffmpeg: video phát file gốc; HEVC/MKV có thể không phát được trên Chrome.

### 5.2 Mức chất lượng và chế độ

- `QUALITIES`: 360 / 720 / 1080 / 1440 (2K) / 2160 (4K), mỗi mức có crf, maxrate, âm thanh, fps tối đa. Mức đặt theo **cạnh ngắn**.
- `settings.videoMode` (admin đổi ở trang Tài khoản):
  - `'lite'` (**mặc định**): chỉ một mức 720p (video nhỏ hơn giữ nguyên cỡ, không phóng to), cộng file gốc.
  - `'full'`: luôn có 360p, thêm các mức mà video gốc đủ nét (cạnh ngắn ≥ 90% mức đó).
- `videoPlan(p)`, `levelAllowed(p, q)`, `readyHls(p)`: **mọi chỗ cho người xem thấy mức HLS phải đi qua `readyHls`**
  (`photoView.qualities`, master playlist, truy cập segment). Ở `full` mọi mức đã có đều hợp lệ.
- `setVideoMode`: lưu cài đặt, huỷ ffmpeg đang làm mức không còn hợp lệ, `pruneHls` từng video (xoá thư mục mức thừa,
  trả về số byte đã xoá), rồi gọi lại `processVideo`. Lúc khởi động ở `lite` cũng tự dọn các mức thừa của video trong máy;
  video trên ổ ngoài được dọn khi ổ được quét lại sau khi cắm.

### 5.3 `processVideo` (vòng lặp mỗi video)

1. Bỏ qua nếu không có ffmpeg, đang chạy (`videoJobs`), `vfail`, hoặc ổ đang rút.
2. Thiếu kích thước / thời lượng thì `probe` (ảnh trên ổ ngoài: trong `onDrive`).
3. Thiếu ảnh nhỏ thì `makeThumbs` (ảnh bìa trước).
4. Lặp: **tính lại `videoPlan` sau mỗi mức** (đổi chế độ giữa chừng vẫn đúng), lấy mức đầu tiên chưa xong
   (xong = có `photo.hls[q]` **và** có `<q>/index.m3u8`), gọi `video.makeRendition`, ghi `photo.hls[q]`, `savePhotos`.
   Mỗi video chỉ xếp một mức mỗi lần và quay lại cuối hàng, nên các video **đang cùng chờ** đều có mức đầu tiên trước khi
   video nào có mức thứ hai (video tới sau, hoặc ổ đang bận làm hàng đợi chọn job khác, thì không đảm bảo thứ tự này).
5. Lỗi: bị huỷ, ổ rút, hoặc ổ không tới được thì im lặng (làm tiếp sau); lỗi khác đặt `vfail = true` (được lưu lại).

`processVideo` gọi lại khi đang chạy là **không làm gì**. Muốn làm lại một video đang chạy (vd. file nguồn đổi)
phải huỷ job rồi gọi lại sau khi job thoát.

### 5.4 `makeRendition` và ảnh bìa

- Chạy trong `hlsLane` (1 ffmpeg HLS toàn server). `src`/`dir` có thể là hàm, được tính lúc bắt đầu chạy
  (ổ có thể đổi ký tự khi đang chờ). Kiểm tra `stillWanted()` trước và ngay trước khi chạy ffmpeg.
- Mã hoá vào `<q>.tmp/` rồi đổi tên thành `<q>/` khi xong: **thư mục `<q>` tồn tại nghĩa là đã hoàn chỉnh**.
  Không bao giờ ghi `photo.hls[q]` khi chưa có thư mục hoàn chỉnh, không tạo `<q>` trực tiếp.
- Khung khoá mỗi 4 giây ở mọi mức (`-force_key_frames`, `-sc_threshold 0`) để đổi mức giữa chừng không giật.
  Đoạn 4 giây, libx264 veryfast, AAC stereo, âm thanh tuỳ chọn. ffmpeg chạy độ ưu tiên thấp.
- Ảnh bìa (`makePoster`, `posterLane` riêng, 1 ffmpeg): khung hình ở 10% thời lượng (tối đa giây thứ 3), cạnh ngắn ≤ 1080.
- Chỉ ffmpeg HLS là huỷ được (`video.cancel(key)`); ảnh bìa, ffprobe, sharp chạy tới hết.

### 5.5 Phục vụ HLS

`serveHls`: `master.m3u8` dựng tại chỗ từ `readyHls` (`no-cache`); `<q>/index.m3u8` và `segNNNN.ts` chỉ phục vụ
khi `q` có trong `readyHls`. Lưu ý: URL segment cố định và cache `immutable`, nên một mức bị xoá rồi tạo lại dùng lại URL cũ.

---

## 6. Thư mục liên kết (ổ cứng ngoài)

- `links.json`: `{ id, uid (chủ), name, path, cache: 'drive'|'local', hidden: [rel], created }`.
  Ảnh trong đó là bản ghi bình thường trong `photos.json` của chủ, thêm `link`, `rel`, `mtime`.
  **File gốc không bao giờ bị ghi, chuyển hay xoá.**
- Cache: `drive` (mặc định): `<path>/.homelight/cache`; ổ chỉ đọc thì tự chuyển `local` (`storage/users/<uid>/thumbs`).
  `.homelight` được ẩn bằng `attrib +h` trên Windows và không bao giờ bị quét.
- Trạng thái trong bộ nhớ `linkStates`: `online`, `scanning`, `lastScan`, `error`, `resumed`, `again`, `ejected`, `dev`.
  `isOffline(p)`: link không còn hoặc không online. Ảnh ngoại tuyến bị ẩn khỏi mọi danh sách và mọi URL trả 503.
- `scanLink`:
  1. Nếu đang quét thì đặt `again`, quét lại ngay khi xong.
  2. `walkLink` đọc từng thư mục, mỗi thư mục một lượt `onDrive`. Bỏ file / thư mục bắt đầu bằng dấu chấm, thư mục hệ thống, thư mục nằm trong app / `IMPORT_DIR`, và mọi file có đuôi không thuộc `MEDIA_EXT`. Lỗi đọc thì ném lỗi chứ không trả danh sách thiếu, nên không hiểu nhầm là ảnh đã bị xoá. **Ngoại lệ:** thư mục con báo EPERM/EACCES bị bỏ qua lặng lẽ, nên ảnh trong đó bị `forgetPhotos` quên (mất yêu thích, album, công khai).
  3. Quên các file đã biến mất (`forgetPhotos`), nhưng **chỉ khi quét thấy ít nhất một file** hoặc trước đó chưa có ảnh nào. Như vậy cắm nhầm ổ khác cùng ký tự thì không xoá gì.
  4. Đọc file mới hoặc đã đổi (theo `size` + `mtime`) bằng `linkedPhoto` trong `onDrive`. File bị thay thì sửa object cũ tại chỗ: giữ `id`, `name`, `added`, yêu thích, công khai, album; xoá `hls`, `vfail`, `color` và làm lại ảnh nhỏ / HLS. **Trường cache mới theo từng ảnh phải thêm vào danh sách xoá này.** Thư mục con thành album.
  5. Lần quét đầu sau khi online (`resumed` false): làm tiếp ảnh nhỏ / video còn dở và dọn HLS thừa. Đây là **nơi duy nhất** việc dở của ổ ngoài được tiếp tục; lúc khởi động chỉ tiếp tục ảnh trong máy.
- `checkLinks` (10 giây một lần, gộp các lời gọi trùng):
  - Đang `ejected` thì bỏ qua, và chỉ xoá cờ khi đường dẫn biến mất.
  - Đọc được thư mục, hoặc `relocate` tìm được ổ (chỉ Windows và cache `drive`: dò ký tự D..Z, so `link.json`):
    - vừa online → `scanLink`;
    - vừa mất → `linkGone`.
- `linkReachable(id)`: khi đọc/ghi trên ổ bị lỗi thì kiểm tra ngay, không chờ 10 giây.
- `relocate` dò ký tự ổ một lần mỗi lượt kiểm tra (`driveLetters`), đọc `link.json` bất đồng bộ.
- `removeLink`:
  1. Bỏ khỏi `links` **trước tiên**, để lần quét đang chạy tự dừng.
  2. Quên các ảnh.
  3. Xoá `.homelight` (cache trên ổ) hoặc các ảnh nhỏ (cache local).

  Hàm này không gọi `stopDrive`: stream đang gửi cho người xem và job nặng đang chạy (sharp, ảnh bìa) vẫn tiếp tục, có thể
  tạo lại file trong `.homelight/cache` sau khi đã xoá. Job còn chờ thì tự huỷ (`slot.ok()` sai).
- Thêm link: `validLinkPath` (đường dẫn tuyệt đối, có thật, không nằm trong app hay `IMPORT_DIR`), kiểm tra trùng / lồng nhau theo cùng chủ, rồi `prepareDriveCache`. Ổ chỉ đọc thì chuyển sang cache `local`, nhưng **chỉ khi tạo link**:
  `PATCH` đổi đường dẫn sang ổ chỉ đọc vẫn giữ `drive` (mọi lần ghi cache sau đó lỗi), và cũng không dừng job hay đóng stream trên đường dẫn cũ.

---

## 7. Mô hình đồng thời và ổ đĩa (đọc kỹ trước khi thêm việc nặng)

### 7.1 Hàng đợi toàn server

| Hàng đợi | Số việc cùng lúc | Việc |
| --- | --- | --- |
| `media.js` queue | 2 | ảnh nhỏ sharp |
| `video.js posterLane` | 1 | ảnh bìa ffmpeg (urgent chen đầu) |
| `video.js hlsLane` | 1 | HLS ffmpeg (không bao giờ urgent) |
| `scanImports` | 1 lượt quét toàn cục | nhập ảnh |

### 7.2 "Chỗ" của mỗi ổ

Mục tiêu: **mỗi ổ ngoài chỉ một việc nặng một lúc** (ổ cứng gắn ngoài bị đọc/ghi nhiều luồng thì chậm hẳn và nóng).

- `driveOf(l)`: Windows là ký tự ổ viết thường (`"d:\"`), máy khác là `dev:<mã thiết bị>`, nếu chưa biết mã thì dùng đường dẫn.
  Các link trên cùng ổ dùng chung một `driveLane`: `{ active, idle }`.
- `takeDrive(lane)`: giữ chỗ (`active++`), trả về hàm nhả. Khi `active` về 0: báo những ai đang chờ ổ rảnh
  (`stopDrive`) và gọi `media.pump()` + `video.pump()`.
- **Việc nặng** (sharp, ảnh bìa, HLS) nhận `driveSlot(l)` = `{ free, take, ok }`. Hàng đợi chỉ lấy job có `slot.free()`
  (hoặc không có slot, hoặc urgent), giữ chỗ trong lúc chạy, và huỷ job nếu lúc bắt đầu `slot.ok()` sai
  (ổ rút / ngắt / đổi ký tự). Hàng đợi tìm job phù hợp đầu tiên (không phải chỉ job đầu hàng), nên ổ bận
  **không chặn** việc của ổ khác hay ảnh trong máy.
- **Việc nhẹ** (`onDrive`: đọc thư mục, đọc đầu file, ffprobe, dọn HLS): chạy ngay không chờ, nhưng vẫn giữ chỗ trong lúc chạy,
  nên không có việc nặng **mới** nào chen vào. Đừng bọc thao tác dài trong `onDrive` (việc nặng sẽ bị bỏ đói).
- Urgent (người xem đang chờ một ảnh) bỏ qua `free()` nên có thể chạy song song với việc khác trên cùng ổ.
  Code mới truyền `urgent = true` cho ảnh trên ổ ngoài là bỏ qua luật một việc nặng mỗi ổ.
- Tối đa cùng lúc toàn server cho việc **tạo** ảnh nhỏ / ảnh bìa / HLS: 1 HLS + 1 ảnh bìa + 2 sharp + các việc nhẹ.
  Các lệnh đọc thông tin chạy ngoài mọi hàng đợi: sharp metadata (`imageSize`, `heicDate`), ffprobe (`videoInfo`),
  và băm cả file khi nhập.

**Quy tắc cho code mới:** mọi đọc/ghi trên ổ ngoài phải hoặc giữ chỗ (`onDrive` cho việc nhẹ, `driveSlot` cho việc nặng đưa vào
hàng đợi) và kiểm tra `online`, hoặc (với phản hồi HTTP) đi qua `readStream`. Bỏ qua quy tắc này thì ngắt ổ không đóng được file
và rút ổ không dừng được việc. **Code hiện tại còn ngoại lệ** (chỉ là thao tác nhỏ trên cache `.homelight`, không bao giờ
trên file gốc): `dropThumbs`, `removeLink`, việc xoá thư mục HLS trong `processVideo`, `pruneHls` khi gọi từ `setVideoMode`,
`fileExists` / `missingThumbs`, `mkdir` trong `ensurePoster`.
Đổi giao diện slot (`free/take/ok`) phải sửa cùng lúc `server.js driveSlot`, `media.js pump` và `video.js lane`.

### 7.3 Huỷ và dừng

- Huỷ được báo bằng lỗi có `cancelled: true` (`cancelled()`, `cancelledErr()`, `run` khi bị kill).
  **Mọi `catch` trên các đường này phải coi `cancelled` / ngoại tuyến / ổ không tới được là "làm tiếp sau"**,
  không phải lỗi vĩnh viễn (nếu không sẽ đặt nhầm `vfail` (được lưu!) hay `thumbFailed`).
- `stopDrive(l, whole)`:
  1. Chọn các link cần dừng: mọi link trên cùng ổ, hoặc chỉ link đó.
  2. Đặt `online = false`, `resumed = false`.
  3. Đóng các `readStream` nằm trong các thư mục đó.
  4. Huỷ ffmpeg HLS của các ảnh đó (theo `videoLevel`).
  5. Nếu `whole`: chờ ổ rảnh (`active` về 0), vì ảnh bìa và sharp không huỷ được.
- `linkGone(l)`: cả ổ biến mất (Windows: không thấy thư mục gốc; máy khác: không link nào cùng ổ còn đọc được) thì dừng cả ổ;
  chỉ thư mục bị đổi tên / xoá thì chỉ dừng thư mục đó.
- **Ngắt ổ an toàn** (`POST /api/links/:id/eject`):
  1. Đặt `ejected` cho mọi link trên ổ.
  2. `watchEjected` kiểm tra mỗi giây; rút ổ là xoá cờ, nên rút rồi cắm lại ngay vẫn được nhận.
  3. `stopDrive`, rồi trả lời. Lúc này Windows "Safely Remove" làm được.

  Khi `ejected`, `checkLinks` bỏ qua link kể cả khi ổ vẫn cắm. Muốn dùng lại thì rút ổ ra rồi cắm vào, hoặc bấm "Kết nối lại" (`/scan`).
- `setVideoMode` chạy trong chính request PUT và đi qua mọi video, nên có thể chậm với thư viện lớn.

---

## 8. Giao diện `index.html`

- Trạng thái toàn cục:
  - Danh sách: `photos`, `shared`, `albums`.
  - Đang xem: `albumId`, `mode` (`new|old|name|fav|shared`), `view` (danh sách đang hiện; lightbox dùng chỉ số trong `view`), `current`.
  - Chọn nhiều: `selecting`, `selected`.
  - Hiển thị: `colors`, `seen`.
- `load()` lấy `/api/photos`, `/api/albums` (và `/api/public` khi ở chế độ Chia sẻ). `render()` **dựng lại toàn bộ lưới**
  mỗi lần đổi trạng thái (không ảo hoá); thẻ ảnh giữ chỉ số `i` trong `view`, nên đổi `view` phải render lại.
- Mọi danh sách ảnh từ API đi qua `forScreen()` (trong `api`/`getJson`/`sendFile`), hàm này đổi `preview` giữa `?s=md` và `?s=ph`
  theo `PHONE` (cạnh ngắn màn hình ≤ 600) hoặc tiết kiệm dữ liệu. Code mới lấy ảnh phải đi qua các hàm này.
- Thang ảnh: lưới/dải/bìa album dùng `thumb`; ảnh lớn đầu trang (hero) và lightbox dùng `preview` (lightbox hiện `thumb` mờ
  trước); **file gốc chỉ khi bấm "GỐC"** hoặc tải xuống. Ngoại lệ có sẵn: GIF có `preview` = file gốc (giữ ảnh động).
  Chế độ mới không được tự tải file gốc. Code mới chép object ảnh phải gọi lại `forScreen` (hàm này sửa `preview` tại chỗ
  khi bật / tắt tiết kiệm dữ liệu).
- Lightbox:
  - Zoom bằng pointer events: `translate + scale` trên `#lbImg`, giữ `transform-origin` mặc định vì các animation mở/đóng dựa vào nó.
  - Chỉ bắt pointer sau khi thực sự kéo (> 5px), nếu không click sẽ đóng lightbox.
  - `zEatClick` nuốt click giả sau khi kéo / chụm.
  - Vuốt chuyển ảnh chỉ khi chạm một ngón và chưa zoom. Chỉ ảnh mới zoom được, video thì không.
- Chống chạy đua bất đồng bộ: kiểm tra `view[current] === p`; với video thì `token === vidToken`. `pollVideos` gộp dữ liệu vào object cũ
  bằng `Object.assign`, không thay object.
- Video:
  - Có `MediaSource` thì dùng hls.js (CDN jsDelivr 1.7.3, lỗi thì dùng `/vendor`); không có thì dùng HLS gốc (Safari); không có HLS thì phát file gốc.
  - Menu chất lượng: `auto` / từng mức / `orig`. `vQuality` lưu localStorage và dùng cho mọi video.
  - Chỉ có **một mức** (`p.qualities.length === 1`) thì menu chỉ có mức đó (data-q `auto`) và "Bản gốc". Trường hợp này
    gồm chế độ gọn nhẹ, nhưng cũng gồm video nhỏ (cạnh ngắn < ~648px) ở chế độ đầy đủ và video mới xong mức đầu tiên.
  - Tên mức theo **cạnh ngắn** (`levelQ`), khớp cách server đặt tên.
- **Tiết kiệm dữ liệu** (lưu theo tài khoản, có bản sao trong localStorage). Tính năng media mới phải tôn trọng:
  - không tự phát, không tự tải cho tới khi bấm play;
  - bộ đệm 12 giây, HLS ở mức thấp nhất;
  - ảnh lớn dùng `?s=ph`;
  - phát file gốc thì `preload=metadata`.
- Thăm dò định kỳ:
  - video đang xử lý: 15 giây (chỉ danh sách của mình, không render lại);
  - thư mục nhập khi bận: 3 giây;
  - ổ ngoài đang quét: 5 giây;
  - tải lại khi quay lại tab.
- 3 chủ đề (cinema/paper/bento) dùng chung HTML/JS, chỉ khác CSS `html[data-theme]`. Bento khác JS ở: nhóm theo tháng, không nghiêng 3D,
  kích thước thẻ, thanh bên / thanh dưới. Giao diện mới phải chạy ở cả 3 chủ đề.
- Responsive: mốc 760px, `env(safe-area-inset-*)`, `@media (hover:none)`, `prefers-reduced-motion`.
  Phải dùng được bằng chạm (không có thứ chỉ hiện khi rê chuột) và bàn phím (Esc đóng menu).
- Chế độ Chia sẻ: danh sách `shared` riêng; ẩn yêu thích / xoá / trình chiếu; chỉ đổi công khai được ảnh `mine`; đổi qua lại thì xoá vùng chọn.
- Chữ do người dùng nhập (tên ảnh, album, tài khoản): luôn đặt bằng `textContent` hoặc `esc()`, không bao giờ qua `i18n.apply()`.

Các trang khác:
- `account.html`: panel admin chỉ ẩn/hiện phía trình duyệt. Người dùng thường vẫn quét lại / ngắt được ổ của mình.
- `login.html`: chỉ đi theo `next` bắt đầu bằng `/`, không phải `//`.
- `slideshow.html`: tham số `?album=&fav=1&start=`; tự chọn cỡ ảnh theo màn hình và tiết kiệm dữ liệu trong localStorage
  (không dùng `forScreen`); không lọc video (video hiện như ảnh tĩnh).

---

## 9. Ổ ngoài và giao diện

- `index.html` kiểm tra `/api/links` một lần khoảng 1,5 giây sau khi tải trang: báo các ổ đang rút, và tải lại mỗi 5 giây khi đang quét.
- `account.html`:
  - Thêm link (chọn thư mục, chủ, cache trên ổ hay trên máy).
  - Mỗi link có "Quét lại" / "Kết nối lại"; "Ngắt ổ an toàn" chỉ khi đang online; "Đổi đường dẫn", "Gỡ liên kết" chỉ cho admin.
  - Trạng thái: đã ngắt / đang đọc ổ / đang cắm / chưa cắm. Đang quét thì hỏi lại `/api/links` mỗi 3 giây.
  - Panel "Chất lượng video" chọn gọn nhẹ / đầy đủ; cả hai hướng đều hỏi xác nhận; gọn nhẹ báo dung lượng đã giải phóng.

---

## 10. Đa ngôn ngữ (i18n)

- **Chuỗi tiếng Việt là khoá.** Tiếng Anh tra trong từ điển phẳng. Ngôn ngữ mặc định: tiếng Anh.
- `public/i18n.js` có:
  - API `i18n.t`, `add`, `apply`, `set`, `lang`, `locale`, và `window.t`;
  - **từ điển chung cho mọi thông báo lỗi của server**, cùng `SERVER_PATTERNS` (regex) cho thông báo có giá trị thay đổi.
- Từ điển riêng từng trang ở `public/i18n/<trang>.js`. Tên file chỉ gồm chữ thường, vì regex `OPEN_I18N` chỉ cho mở những file như vậy.
- `apply()` chạy **một lần** lúc tải, dịch các nút chữ tĩnh và các thuộc tính `title/placeholder/aria-label/alt`,
  chỉ khớp **nguyên văn**. Chữ tĩnh bị cắt bởi thẻ (`<b>`, `<code>`) cần một khoá cho mỗi đoạn.
- Chữ sinh động phải bọc `t()` ngay chỗ dùng.
- Số nhiều có hai quy ước, dùng đúng quy ước của trang:
  - `index.html`: `tn(key, n)`, cần khoá riêng với `1` thay `{0}`;
  - `account`/`slideshow`: `count(n, key)`, cần khoá `...#1`.
- Thêm từ điển sau thì đè khoá trùng của từ điển trước. Kiểm tra trước khi thêm một khoá trùng chữ nhưng khác nghĩa.
- **Đổi câu tiếng Việt ở code mà không đổi khoá trong từ điển thì bản tiếng Anh âm thầm mất.**
  Thêm `httpError` mới thì phải thêm bản dịch vào `public/i18n.js`, và vào `SERVER_PATTERNS` nếu câu có giá trị chèn vào.
- Lưu ngôn ngữ:
  - localStorage `lang` (+ `langAcct` khi giá trị đến từ tài khoản) và `user.prefs.lang`.
  - `sync()` lúc tải: tài khoản có ngôn ngữ thì luôn thắng.
  - `i18n.set()` lưu vào tài khoản rồi **tải lại trang** (mất trạng thái đang mở).
  - `LANGS` phải giống nhau ở `server.js` và `i18n.js`.
- Trong `index.html` nhiều chỗ khai báo biến cục bộ tên `t` (che hàm dịch). Trong các phạm vi đó dùng `i18n.t()`.

---

## 11. Các điểm dễ vấp đã biết

Các điểm này **không phải lỗi cần sửa ngay**, ghi lại để khỏi bất ngờ:

- `thumbFailed` chỉ mất khi khởi động lại (hoặc file trên ổ bị thay); lỗi sharp tạm thời khiến ảnh hiện bằng file gốc cho tới lúc đó.
- Ảnh tải lên: `taken` chỉ có với JPEG (EXIF phía trình duyệt) hoặc HEIC; video lấy `file.lastModified`.
- `importUser` chuyển file vào `images/` trước rồi mới băm; sập giữa chừng có thể để lại file mồ côi.
- Xoá người dùng: không huỷ job video / ảnh bìa đang chạy (trên Windows `rm` thư mục có thể lỗi → 500 dù tài khoản đã bị xoá),
  không xoá `storage/import/<username>/` (tạo lại cùng tên sẽ nhập lại file còn sót).
- Hai người dùng liên kết cùng một thư mục (cache trên ổ) sẽ dùng chung `.homelight`. Link thứ hai ghi đè `link.json` ngay khi tạo,
  nên link thứ nhất không còn được `relocate` nhận ra khi đổi ký tự ổ; gỡ một link sẽ xoá cache của link kia.
- Thư mục con trên ổ ngoài không có quyền đọc (EPERM/EACCES) bị bỏ qua, ảnh trong đó bị quên (mục 6).
- Cắm lại ổ với ký tự khác trong cùng một chu kỳ 10 giây: việc dở của ổ đó chỉ được tiếp tục sau khi ngắt / kết nối lại / khởi động lại.
- File trên ổ bị thay đúng lúc video của nó đang xử lý: file mới chỉ được xử lý ở lần tiếp tục sau.
- Ảnh bìa không huỷ được: xoá video đúng lúc đang tạo ảnh bìa có thể để lại `-poster.jpg` mồ côi.
- `readJsonBody` trả `null` khi body là chữ `null`; vài route không chặn trường hợp này, nên trả 500.
- Khoá đăng nhập theo tên (kể cả tên không tồn tại), nên ai cũng có thể khoá tạm một tài khoản thật (đánh đổi có chủ đích);
  bộ đếm sai không tự giảm.
- `linkView`, `GET /api/users`, `GET /api/public`, `setVideoMode` duyệt toàn bộ danh sách ảnh mỗi lần gọi.
- `login.html` chặn `//` nhưng không chặn `/\host` trong `next`.
- Chưa thử trên Linux/macOS phần nhóm link theo ổ (`dev`).

---

## 12. Kiểm tra xung đột khi thêm tính năng

Trước khi viết code, đi qua danh sách này:

1. **Dữ liệu:**
   - Trường mới nằm ở đâu (`photos.json`, `users.json` prefs, `settings.json`, `links.json`, chỉ trong bộ nhớ)?
   - Đã sửa trong bộ nhớ rồi gọi hàm `save*` chưa?
   - Có cần ẩn khỏi `photoView` không? Nhớ rằng `photoView` cũng lộ ra cho người khác qua ảnh công khai.
2. **Quyền:** route mới có kiểm tra phiên / admin / chủ sở hữu ở server không? Có dùng `readJsonBody` (chống CSRF) không?
   Có tra ảnh qua bản ghi của đúng người dùng không?
3. **Ảnh trên ổ ngoài:**
   - Có đọc / ghi ổ ngoài không? Nếu có thì phải qua `onDrive` / `driveSlot` / `readStream` và kiểm tra `isOffline`.
   - Có bao giờ sửa / xoá file gốc trên ổ không? Không được.
   - Ảnh ngoại tuyến có bị lộ ra không?
4. **Video:**
   - Có cho người xem thấy mức HLS nào ngoài `readyHls` không?
   - Có đặt `vfail` / `thumbFailed` khi việc chỉ bị huỷ không?
   - Có cần huỷ rồi gọi lại `processVideo` không (gọi lại khi đang chạy thì không có tác dụng)?
5. **Cache trình duyệt:** nội dung file có thể đổi mà URL giữ nguyên không? Nếu có thì đổi tên file, hoặc `dropThumbs`.
6. **Việc nặng:** có chạy sharp / ffmpeg ngoài các hàng đợi sẵn có không? Phải đưa vào hàng đợi, kèm slot nếu là file trên ổ ngoài.
7. **Giao diện:**
   - Mọi chuỗi mới đều có bản dịch chưa (tĩnh: từ điển trang; động: `t()`; lỗi server: `i18n.js`)?
   - Có chạy ở cả 3 chủ đề, trên điện thoại / cảm ứng, với tiết kiệm dữ liệu không?
   - Đã chống chạy đua bằng `view[current] === p` / `vidToken` chưa?
   - Có sửa cả các bản chép `api()` / `toast()` ở trang khác không?
8. **Tài liệu:** cập nhật README (người dùng) và tài liệu này nếu đổi luồng, quy tắc hay dữ liệu.
