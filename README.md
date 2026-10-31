# My Gallery

A self-hosted photo and video gallery with a cinematic interface: upload photos and videos, browse them on a timeline, and replay memories in a 3D carousel slideshow. It has login accounts, and each person gets their own photo folder. All you need is Node.js; add `sharp` so photos load quickly on slow connections and `ffmpeg` so videos play smoothly at any network speed.

The app's interface is in Vietnamese, so this README quotes button and menu names as they appear on screen, with an English gloss on first mention.

## Running

```bash
npm install      # once: installs sharp for thumbnails (needs Node.js 20.9+; without it the site still runs but always sends original photos)
node server.js
```

Open `http://localhost:3000` **on the machine running the server** to create the first admin account (for safety, this step can't be done from another device). Then go to **Tài khoản** (Account) to add other users.

**Changing the port:** as an admin, go to **Tài khoản → Cổng máy chủ** (Account → Server port) and enter a new port (1024–65535). The server opens the new port immediately without a restart, the page redirects to the new address, and the port is saved in `storage/settings.json` for future runs. If you start with `PORT=8080 node server.js`, the `PORT` variable takes priority and can't be changed from the page. Delete `storage/settings.json` to go back to port 3000.

Other devices on the same Wi‑Fi network can open the IP address the server prints. To reach the gallery from anywhere while keeping your photos on your own machine, see [docs/truy-cap-tu-xa.md](docs/truy-cap-tu-xa.md) (in Vietnamese).

> It does not work on Vercel/Netlify: those platforms don't keep files between runs, so uploaded photos would be lost.

## Video

Upload videos the same way as photos (the **Tải ảnh lên** (Upload photos) button, or drag and drop), or copy them into the import folder described below. MP4, MOV (iPhone), MKV, WebM, AVI, 3GP and MTS are accepted, up to 4 GB per video (change this with `VIDEO_MAX_MB=8192`). The recording date is read from the file's metadata.

For smooth playback on slow connections, install **ffmpeg** on the server machine (once), then reopen the window running the server:

```bash
winget install Gyan.FFmpeg      # Windows
# macOS: brew install ffmpeg    Linux: sudo apt install ffmpeg
```

With ffmpeg, each video is converted to **HLS** (the way YouTube streams video): cut into 4-second segments at several quality levels, based on the video's short edge:

| Level | Max bitrate | Use for |
| --- | --- | --- |
| 360p | 0.8 Mbps | 3G, weak Wi‑Fi |
| 720p | 2.5 Mbps | 4G, typical home internet |
| 1080p | 5 Mbps | good connections |
| 1440p (2K) | 9 Mbps | fast connections, viewing on the home network |
| 2160p (4K) | 16 Mbps | viewing on the home network, 4K screens |

- Only levels that don't exceed the source are created (a 1080p video gets 360p, 720p and 1080p; a 4K video gets all 5). 360p is always created first, so a video is watchable on a slow connection within seconds; higher levels follow gradually. With several videos at once, every video gets 360p before any moves on to 720p
- The player picks a level from the measured network speed and **switches mid-playback** as the connection speeds up or slows down, without restarting. Small screens don't load 2K/4K. The quality button during playback lets you choose manually: Auto, a specific level, or Original (your choice is remembered)
- The cover image is taken from an early frame, then turned into thumbnails like any photo for the grid
- ffmpeg runs at low priority, one video at a time, so the machine stays usable during conversion. A long 4K video can take several minutes; the server prints a line each time a level finishes
- The hls.js player loads from a CDN (so it doesn't use your home bandwidth); if the CDN is unreachable, the copy in `public/vendor/` is used. Safari and iPhone play HLS natively
- Without ffmpeg (or until the first level is done), the original file is played, and you can still seek as far as it has downloaded. iPhone videos (HEVC) may not play in Chrome until ffmpeg finishes converting them
- **Tiết kiệm dữ liệu** (Data saver; in the **Giao diện** (Appearance) menu, or the quality button during playback): turn it on when watching over 4G/5G. "Auto" video stays at 360p or below (about 350 MB/hour, compared with about 2 GB/hour at 1080p), videos don't autoplay when opened, only 12 seconds are buffered ahead, and enlarged photos and slideshows use the 1080px size. The setting is stored **per account** on the server, so turning it on from your phone also applies on other devices logged in to the same account
- HLS copies live in `storage/users/<id>/thumbs/<video id>-hls/` and take about 30–60% of the original video's size (more for 4K). They can be deleted; the server recreates them on startup. If ffmpeg is installed elsewhere, set `FFMPEG_PATH`

## Copying photos straight from disk

You don't have to upload through the browser: copy photos and videos (or whole folders) into

```
storage/import/<username>/
```

The server scans this folder every 10 seconds (and as soon as you open the page), moves the photos into that account's gallery, reads the capture date from EXIF, then empties the folder. Subfolders become albums with the same name (`Da Lat 2024/` → album "Da Lat 2024"). Photos you already have go into `_anh-trung/`, and non-image files go into `_khong-phai-anh/` for you to review. The server prints each account's path on startup. To put the import folder somewhere else (on the same drive, photos move instantly): `IMPORT_DIR=D:\GalleryImport`.

## Viewing photos on an external drive (without copying)

To view photos and videos on an external drive without using space on your machine: plug in the drive, log in as an admin, go to **Tài khoản → Ổ cứng ngoài** (Account → External drive), click **Chọn thư mục…** (Choose folder; or type a path, e.g. `E:\Family photos`), choose whose gallery should show these photos, then click **Liên kết thư mục** (Link folder).

- Photos and videos are **read in place**, not copied. The original files are never modified, renamed or deleted; the delete button in the gallery only **hides** a photo
- Subfolders become albums with the same name. Adding or removing photos on the drive updates the gallery automatically (rescanned every 5 minutes, or click **Quét lại** (Rescan))
- Thumbnails and video HLS copies are stored on the drive itself by default, in a hidden `.homelight` folder (safe to delete; the gallery recreates it when needed). If the drive is read-only, or you untick this option, they're stored on the machine: about 0.4 MB per photo, and roughly 30–60% of the original size for video
- **Unplugging the drive**: its photos are temporarily hidden from the gallery (albums, favorites and public status are kept). Plug it back in and they return within seconds. If Windows changes the drive letter (E: to F:), the server finds it on its own; if not, click **Đổi đường dẫn** (Change path)
- The first time you link a drive with many photos, the server needs a while to read them and create thumbnails; photos appear in the gallery gradually. USB 2.0 and HDD drives are slower than SSDs
- Only admins can link folders (because it allows reading the server's drives). The list is stored in `storage/links.json`
- Formats: JPEG, PNG, GIF, WebP, AVIF, BMP, HEIC (iPhone), and the video formats listed above

## iPhone HEIC photos

Chrome, Edge and Firefox can't open HEIC photos, and sharp as installed from npm has no HEVC decoder (for licensing reasons). So the server also uses `heic-decode` (installed by `npm install`) to decode a HEIC once, then creates WebP thumbnails like any other photo. The gallery shows the WebP; the download button still returns the original HEIC file. The capture date is read from EXIF in the HEIC file. A 12 MP photo takes about 1–2 seconds to decode the first time; later views are as fast as any other photo.

## Optimized for a personal PC as the server

The gallery is designed to run on a home computer on a home connection. The bottleneck is your connection's **upload speed** (usually only a few dozen Mbps, far below download), so every optimization aims to send viewers as little data as possible.

**Thumbnails instead of originals** (requires `sharp`, installed by `npm install`)

- Each photo gets 3 extra WebP versions: **small** (600px wide, about 30 KB) for the grid, **phone** (1080px wide, about 100 KB) and **screen** (1920px, about 200 KB) for enlarged view and slideshows. A 4 MB original only loads when you click **GỐC** (Original) while viewing a photo, or when downloading
- Phones automatically use the 1080px version, about 1/3 (landscape) to 1/2 (portrait) the weight of the 1920px one. Computers and tablets use the 1920px version
- Viewing a photo: the small version already loaded is shown right away, then replaced by the sharp one once it finishes loading
- While a photo loads, its grid cell shows the photo's dominant color instead of an empty box; off-screen photos aren't loaded yet (lazy loading)
- Older photos get their missing versions gradually after the server starts, or as soon as someone views them. The server only creates what's missing and never redoes existing versions
- Thumbnail generation handles at most 2 photos at a time, one thread each, so the machine stays responsive while processing a whole library

**Not resending what the browser already has**

- Photos have random-ID filenames, so their content never changes: browsers cache them for 1 year, and later views use no bandwidth
- All files (pages, photos) and the photo/album lists have an **ETag**: the browser asks "anything new?", and if nothing changed, the server replies with just a `304` (a few hundred bytes) instead of the whole file. For example, returning to the gallery tab no longer reloads the whole photo list
- Shared photos are cached for only 5 minutes (since the owner may set them back to private), after which the browser just revalidates with the ETag rather than reloading the photo

**Text compression**

- Pages and JSON data are compressed with **brotli** (gzip for older browsers). The 150 KB main page is only about 30 KB when sent
- Pages are compressed once at the highest level and kept in RAM, not recompressed per request, so this costs no CPU

**Light on the server**

- No database or heavy libraries: just Node.js, with data stored as JSON files in `storage/`
- The photo list is kept in RAM, and during bulk thumbnail generation multiple disk writes are batched into one
- Fonts load from Google Fonts, so they don't use your home bandwidth

## Features

- Password login (hashed with scrypt), stays logged in for 30 days, temporary lockout after repeated wrong passwords
- Each user has an ID and their own photo folder, and sees only their own photos
- Admins can add and remove users, reset passwords and grant permissions
- Shared photos: select photos and click **Công khai** (Public) so every account can view and download them (the **Ảnh chung** (Shared photos) tab); everything else stays private. Public photos remain in the owner's folder, and can be set back to **Riêng tư** (Private) at any time
- Albums: create an album, select photos and click **Thêm vào album** (Add to album), choose a cover, rename, and run a slideshow per album. Albums only store a list of photos, so a photo can be in several albums, and deleting an album doesn't delete its photos
- Upload with a button, drag and drop, or paste (Ctrl+V); the capture date is read automatically from EXIF
- Video viewing in all three themes, with quality that adapts to the network (see **Video**)
- Photo grid grouped by year, 3D tilt on hover, ambient light color taken from the photo
- Three themes, switched with the **Giao diện** (Appearance) button in the top bar: **Điện ảnh** (Cinema: dark background, 3D tilt), **Album giấy** (Paper album: light paper background, white photo frames, magazine-style type) and **Ô màu** (Color tiles: rounded tile grid, album sidebar, an "On this day" tile; a bottom navigation bar on phones). Your choice is remembered in the browser
- Favorites, search, sorting, enlarged view, download, delete
- Photo zoom while viewing (up to 5x): mouse wheel, double-click, `+` `-` `0` keys, or pinch and double-tap on phones; drag to pan
- Slideshow (`/slideshow.html`): 3D carousel, Ken Burns effect, background music, fullscreen, keyboard shortcuts

## Structure

- `server.js` — server and API (`/api/photos`, `/api/albums`, `/api/public`, `/api/import`, `/api/links`, `/api/login`, `/api/users`, …)
- `media.js` — reads EXIF, identifies images, creates thumbnails with sharp
- `video.js` — identifies videos, reads metadata, creates covers and HLS copies with ffmpeg
- `public/vendor/hls.light.min.js` — HLS player (hls.js 1.7.3, Apache 2.0 license), the fallback when the CDN is unreachable
- `public/index.html` — gallery page
- `public/slideshow.html` — slideshow page
- `public/login.html`, `public/account.html` — login, account and user management
- `storage/` — all data (not committed to git):
  - `users.json` — account list (passwords hashed)
  - `sessions.json` — login sessions
  - `users/<id>/images/` — each person's original photos
  - `users/<id>/thumbs/` — thumbnails, covers and video HLS copies (safe to delete; the server recreates them)
  - `import/<username>/` — folder for copying photos in
  - `links.json` — folders linked on external drives
  - `users/<id>/photos.json` — each person's photo info
  - `users/<id>/albums.json` — each person's albums

Backup: just copy the whole `storage/` folder.

Upgrading from an old version: photos in `uploads/` and `data.json` are moved into the admin account automatically when you create it.
