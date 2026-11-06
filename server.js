// Gallery server — không cần cài thư viện, chỉ cần Node.js 18+.
// Chạy: node server.js   (đổi cổng: trang Tài khoản của quản trị viên, hoặc PORT=8080 node server.js)
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const { pipeline, Transform } = require('stream');
const media = require('./media');
const video = require('./video');
const backup = require('./backup');
const exif = require('./exif');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const STORAGE_DIR = path.join(ROOT, 'storage');      // toàn bộ dữ liệu, không đưa lên git
const USERS_DIR = path.join(STORAGE_DIR, 'users');   // mỗi người dùng một thư mục: users/<id>/
const USERS_FILE = path.join(STORAGE_DIR, 'users.json');
const SESSIONS_FILE = path.join(STORAGE_DIR, 'sessions.json');
const LEGACY_UPLOAD_DIR = path.join(ROOT, 'uploads'); // bản cũ (chưa có tài khoản)
const LEGACY_DATA_FILE = path.join(ROOT, 'data.json');
// Chép ảnh vào import/<tên đăng nhập>/ là ảnh tự vào gallery của người đó (thư mục con thành album)
const IMPORT_DIR = path.resolve(process.env.IMPORT_DIR || path.join(STORAGE_DIR, 'import'));
const IMPORT_SCAN_MS = 10 * 1000;
const IMPORT_MAX_SIZE = 200 * 1024 * 1024; // chép trên máy nên cho phép ảnh lớn hơn khi tải lên
const MAX_SIZE = 50 * 1024 * 1024; // 50 MB / ảnh
const VIDEO_MAX_SIZE = (Number(process.env.VIDEO_MAX_MB) || 4096) * 1024 * 1024; // 4 GB / video (đổi: VIDEO_MAX_MB=8192)
const SESSION_MS = 30 * 24 * 3600 * 1000; // đăng nhập giữ 30 ngày
const LOGIN_MAX_FAILS = 10, LOGIN_LOCK_MS = 15 * 60 * 1000;
const TRASH_DAYS = 30; // ảnh xoá nằm trong thùng rác bao lâu rồi mới xoá hẳn

// Chỉ nhận các định dạng ảnh an toàn để hiển thị (không nhận SVG vì có thể chứa script)
const IMAGE_TYPES = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/avif': '.avif', 'image/bmp': '.bmp',
  'image/heic': '.heic', // ảnh iPhone: xem qua ảnh nhỏ WebP (xem media.js), file gốc chỉ để tải xuống
};
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  ...Object.fromEntries(Object.entries(IMAGE_TYPES).map(([t, e]) => [e, t])),
  ...Object.fromEntries(Object.entries(video.VIDEO_TYPES).map(([t, e]) => [e, t])),
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.jpg': 'image/jpeg',
};
// Trang xem được khi chưa đăng nhập
const OPEN_PAGES = new Set([
  '/login.html', '/favicon.ico', '/vendor/hls.light.min.js', // hls.js: trang link chia sẻ cần (khách không đăng nhập)
  '/manifest.webmanifest', '/sw.js', // ứng dụng cài được: trình duyệt tải manifest không kèm cookie
  '/icons/icon.svg', '/icons/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
]);
// i18n.js và từ điển public/i18n/*.js: trang đăng nhập cần. So khớp chặt để "/i18n/..%2f" không lọt qua
const OPEN_I18N = /^\/i18n(\/[a-z]+)?\.js$/;
const LANGS = ['en', 'vi'];

// ---------- Lưu file JSON ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Ghi tuần tự theo từng file để các request đồng thời không ghi đè lên nhau
const writeQueues = new Map();
function writeJson(file, data) {
  const json = JSON.stringify(data, null, 2);
  const next = (writeQueues.get(file) || Promise.resolve()).then(async () => {
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, json);
    await fsp.rename(tmp, file);
  }).catch(err => console.error(`Lỗi ghi ${path.basename(file)}:`, err));
  writeQueues.set(file, next);
  return next;
}

fs.mkdirSync(USERS_DIR, { recursive: true });

// ---------- Cài đặt máy chủ (storage/settings.json) ----------
// Cổng: biến môi trường PORT (nếu có) > cổng quản trị viên đã lưu > 3000
const SETTINGS_FILE = path.join(STORAGE_DIR, 'settings.json');
const DEFAULT_PORT = 3000;
const ENV_PORT = Number(process.env.PORT) || null;
const portOk = n => Number.isInteger(n) && n >= 1024 && n <= 65535;
let settings = readJson(SETTINGS_FILE, {});
const saveSettings = () => writeJson(SETTINGS_FILE, settings);
let PORT = ENV_PORT || (portOk(settings.port) ? settings.port : DEFAULT_PORT);
// Mức chất lượng video: 'lite' (mặc định: 720p + file gốc) | 'full' (360p – 4K, tốn ổ hơn nhiều)
const VIDEO_MODES = ['lite', 'full'];
let videoMode = VIDEO_MODES.includes(settings.videoMode) ? settings.videoMode : 'lite';

// ---------- Người dùng ----------
// users.json: [{ id, username, role: 'admin' | 'user', salt, hash, created }]
let users = readJson(USERS_FILE, []);
const saveUsers = () => writeJson(USERS_FILE, users);
const publicUser = u => ({ id: u.id, username: u.username, role: u.role, created: u.created });
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

// ---------- Link chia sẻ album (xem không cần tài khoản, xem mục "Link chia sẻ" bên dưới) ----------
// shares.json: [{ token, uid, albumId, created, expires (ms | null), pass: { salt, hash } | null, download, theme, views, last }]
const SHARES_FILE = path.join(STORAGE_DIR, 'shares.json');
let shares = readJson(SHARES_FILE, []);
const saveShares = () => writeJson(SHARES_FILE, shares);
// Khoá ký cookie mở khoá link có mật khẩu (tạo một lần, lưu trong settings.json)
function ensureSecret() {
  if (typeof settings.secret === 'string' && settings.secret.length >= 32) return;
  settings.secret = crypto.randomBytes(32).toString('hex');
  saveSettings();
}
ensureSecret();

const scrypt = promisify(crypto.scrypt);
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: (await scrypt(password, salt, 64)).toString('hex') };
}
async function checkPassword(user, password) {
  // Vẫn tính hash khi không có tài khoản để thời gian phản hồi như nhau
  const salt = user ? user.salt : '00000000000000000000000000000000';
  const hash = await scrypt(password, salt, 64);
  return !!user && crypto.timingSafeEqual(hash, Buffer.from(user.hash, 'hex'));
}

function validUsername(v) {
  const name = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!USERNAME_RE.test(name)) throw httpError(400, 'Tên đăng nhập 3–32 ký tự, chỉ gồm chữ thường không dấu, số và . _ -');
  return name;
}
function validPassword(v) {
  if (typeof v !== 'string' || v.length < 8 || v.length > 200) throw httpError(400, 'Mật khẩu cần ít nhất 8 ký tự');
  return v;
}

async function createUser(username, password, role) {
  if (users.some(u => u.username === username)) throw httpError(409, 'Tên đăng nhập đã có người dùng');
  const user = { id: crypto.randomBytes(6).toString('hex'), username, role, ...await hashPassword(password), created: Date.now() };
  await fsp.mkdir(imagesDir(user.id), { recursive: true });
  await fsp.mkdir(importDir(user), { recursive: true }).catch(() => {});
  users.push(user);
  await saveUsers();
  return user;
}

// ---------- Ảnh của từng người: users/<id>/photos.json + users/<id>/images/ ----------
const userDir = id => path.join(USERS_DIR, id);
const imagesDir = id => path.join(userDir(id), 'images');
const photosFile = id => path.join(userDir(id), 'photos.json');
const thumbsDir = id => path.join(userDir(id), 'thumbs'); // ảnh nhỏ <id ảnh>-sm.webp / -md.webp
const photoCache = new Map();
function getPhotos(uid) {
  if (!photoCache.has(uid)) photoCache.set(uid, readJson(photosFile(uid), []));
  return photoCache.get(uid);
}
function savePhotos(uid, list) {
  photoCache.set(uid, list);
  return writeJson(photosFile(uid), list);
}
// Gộp nhiều lần ghi (vd. khi đang tạo ảnh nhỏ hàng loạt) thành một
const saveTimers = new Map();
function savePhotosSoon(uid) {
  clearTimeout(saveTimers.get(uid));
  saveTimers.set(uid, setTimeout(() => { saveTimers.delete(uid); savePhotos(uid, getPhotos(uid)); }, 2000));
}

// Tra ảnh theo id / tên file nhanh (thư mục trên ổ ngoài có thể có hàng chục nghìn ảnh).
// Danh sách chỉ bị push thêm hoặc thay bằng mảng mới -> đổi độ dài là dựng lại
const indexes = new WeakMap();
function photoIndex(list, key) {
  let ix = indexes.get(list);
  if (!ix || ix.len !== list.length) indexes.set(list, ix = { len: list.length });
  return ix[key] || (ix[key] = new Map(list.map(p => [p[key], p])));
}

// ---------- Ảnh nhỏ cho mạng chậm (xem media.js) ----------
// Gửi cho trình duyệt: thumb (lưới ảnh), preview (xem phóng to), url (ảnh gốc), color (màu nền lúc đang tải)
// Bỏ toạ độ GPS và nơi chụp (ảnh gửi cho người không phải chủ ảnh)
function noLocation(v) {
  if (v.exif && 'lat' in v.exif) { const { lat, lon, ...rest } = v.exif; v.exif = rest; }
  delete v.place;
  return v;
}
function photoView(p, url = p.url) {
  const { hash, hls, vfail, rel, mtime, trashAlbums, trashCovers, dhash, ...rest } = p;
  if (p.kind === 'video') {
    // hls: danh sách phát nhiều mức chất lượng (null khi chưa tạo xong mức nào -> phát file gốc)
    // processing: server còn đang tạo thêm mức chất lượng
    const ready = Object.keys(readyHls(p));
    return {
      ...rest, url, thumb: url + '?s=sm', preview: url + '?s=md',
      hls: ready.length ? url + '/hls/master.m3u8' : null, qualities: ready.map(Number),
      processing: video.hasFfmpeg && !vfail && videoPlan(p).some(q => !ready.includes(String(q))),
    };
  }
  return { ...rest, url, thumb: url + '?s=sm', preview: p.type === 'image/gif' ? url : url + '?s=md' }; // GIF giữ ảnh động
}
const thumbFailed = new Set();
function makeThumbs(uid, photo, urgent) {
  const key = uid + '/' + photo.id, isVideo = photo.kind === 'video';
  if (!(isVideo ? video.hasFfmpeg : media.hasSharp) || thumbFailed.has(key) || isOffline(photo)) return Promise.resolve(false);
  // Video: tạo ảnh bìa bằng ffmpeg trước, rồi làm ảnh nhỏ từ ảnh bìa như ảnh thường
  const l = photo.link && linkById(photo.link), slot = l ? driveSlot(l) : null; // ảnh trên ổ ngoài: chờ tới lượt dùng ổ
  const from = originalPath(uid, photo);
  const src = isVideo ? ensurePoster(uid, photo, urgent, slot) : Promise.resolve(from);
  return src.then(file => media.hasSharp ? media.queueVariants(file, cacheDir(uid, photo), photo.id, urgent, slot) : null).then(info => {
    const p = getPhotos(uid).find(x => x.id === photo.id);
    if (p && info && (p.color !== info.color || p.dhash !== info.dhash || (!p.w && info.w && !isVideo))) {
      p.color = info.color;
      if (info.dhash) p.dhash = info.dhash; // để tìm ảnh trùng (xem duplicateGroups)
      if (!p.w && info.w && !isVideo) Object.assign(p, { w: info.w, h: info.h }); // ảnh nhập khi chưa có sharp
      savePhotosSoon(uid);
    }
    return true;
  }, async err => {
    // Ổ vừa bị rút, hoặc cắm lại với ký tự khác trong lúc chờ: không phải lỗi, quét lại ổ thì làm tiếp
    if (err.cancelled || isOffline(photo) || originalPath(uid, photo) !== from || (photo.link && !await linkReachable(photo.link))) return false;
    thumbFailed.add(key);
    console.error(`Không tạo được ảnh nhỏ cho ${photo.name}:`, err.message);
    return false;
  });
}
async function dropThumbs(uid, photo) {
  if (photo.kind === 'video') {
    await video.cancel(uid + '/' + photo.id);
    await fsp.unlink(posterPath(uid, photo)).catch(() => {});
    await fsp.rm(hlsDir(uid, photo), { recursive: true, force: true }).catch(() => {});
  }
  await Promise.all(Object.keys(media.SIZES).map(s => fsp.unlink(media.variantPath(cacheDir(uid, photo), photo.id, s)).catch(() => {})));
}
// ?s=sm|ph|md: gửi ảnh nhỏ, chưa có thì tạo ngay; không tạo được thì gửi ảnh gốc
async function serveVariant(res, uid, photo, size, cache) {
  const file = media.variantPath(cacheDir(uid, photo), photo.id, size);
  const exists = () => fsp.access(file).then(() => true, () => false);
  if (await exists() || (await makeThumbs(uid, photo, true) && await exists())) return serveFile(res, file, cache);
  if (photo.kind === 'video') {
    // Chưa cài sharp: gửi ảnh bìa JPEG. Chưa có ffmpeg: ô màu tối có nút play (không cache, để lần sau hiện ảnh bìa thật)
    const poster = posterPath(uid, photo);
    if (await fsp.access(poster).then(() => true, () => false)) return serveFile(res, poster, cache);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(VIDEO_PLACEHOLDER);
  }
  return serveFile(res, originalPath(uid, photo), 'private, max-age=600');
}
const VIDEO_PLACEHOLDER = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#22232a"/>' +
  '<circle cx="80" cy="45" r="17" fill="#fff" fill-opacity=".14"/><path d="M74 36v18l15-9z" fill="#fff" fill-opacity=".7"/></svg>';

// ---------- Video (xem video.js) ----------
// users/<id>/thumbs/<id video>-poster.jpg: ảnh bìa; users/<id>/thumbs/<id video>-hls/<360|720|1080>/: các mức HLS
// Ảnh/video trong thư mục liên kết (ổ cứng ngoài): bản cache nằm trên chính ổ đó hoặc trên máy, xem phần "Thư mục liên kết"
const posterPath = (uid, p) => path.join(cacheDir(uid, p), `${p.id}-poster.jpg`);
const hlsDir = (uid, p) => path.join(cacheDir(uid, p), `${p.id}-hls`);
const fileExists = f => fsp.access(f).then(() => true, () => false);

async function ensurePoster(uid, photo, urgent, slot) {
  const out = posterPath(uid, photo);
  if (!await fileExists(out)) {
    await fsp.mkdir(cacheDir(uid, photo), { recursive: true });
    await video.makePoster(originalPath(uid, photo), out, photo, urgent, slot);
  }
  return out;
}

// Mức HLS theo chế độ đang chọn; mức đã tạo nhưng không thuộc chế độ (vd. 1080p khi gọn nhẹ) thì không gửi cho trình xem
const videoPlan = p => video.plan(p.w, p.h, videoMode);
const levelAllowed = (p, q) => videoMode === 'full' || videoPlan(p).includes(Number(q));
const readyHls = p => Object.fromEntries(Object.entries(p.hls || {}).filter(([q]) => levelAllowed(p, q)));

async function dirSize(dir) {
  let n = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const f = path.join(dir, e.name);
    n += e.isDirectory() ? await dirSize(f) : (await fsp.stat(f).catch(() => ({ size: 0 }))).size;
  }
  return n;
}
// Xoá các mức HLS không thuộc chế độ đang chọn. Trả về số byte đã xoá
async function pruneHls(uid, photo) {
  if (photo.kind !== 'video' || videoMode === 'full' || isOffline(photo)) return 0; // ổ đang rút: dọn khi cắm lại
  const dir = hlsDir(uid, photo), running = videoLevel.get(uid + '/' + photo.id);
  const removed = new Set();
  let freed = 0;
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    const q = name.replace(/\.tmp$/, '');
    if (levelAllowed(photo, q) || (running && name === running.q + '.tmp')) continue; // .tmp của mức đang tạo: ffmpeg tự dọn khi bị huỷ
    const size = await dirSize(path.join(dir, name));
    if (levelAllowed(photo, q)) continue; // vừa đổi lại sang đầy đủ trong lúc đếm dung lượng
    await fsp.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
    freed += size;
    if (name === q) removed.add(q);
  }
  const drop = Object.keys(photo.hls || {}).filter(q => removed.has(q) || !levelAllowed(photo, q));
  if (drop.length) {
    for (const q of drop) delete photo.hls[q];
    savePhotosSoon(uid);
  }
  return freed;
}
// Quản trị viên đổi chế độ: huỷ ffmpeg đang tạo mức không còn cần, xoá các mức thừa, rồi tạo các mức còn thiếu
async function setVideoMode(mode) {
  videoMode = settings.videoMode = mode;
  await saveSettings();
  await Promise.all([...videoLevel].filter(([, j]) => !levelAllowed(j.photo, j.q)).map(([key]) => video.cancel(key)));
  let freed = 0;
  for (const u of users) for (const p of getPhotos(u.id)) {
    if (p.kind !== 'video') continue;
    freed += await pruneHls(u.id, p);
    processVideo(u.id, p);
  }
  return freed;
}

// Đọc thông tin, tạo ảnh bìa rồi lần lượt các mức HLS (360p trước để mạng chậm có cái xem sớm nhất).
// Nhiều video cùng lúc: mọi video có 360p xong rồi mới tới 720p
const videoJobs = new Set();
const videoLevel = new Map(); // key -> { photo, q }: mức đang tạo, để huỷ khi đổi chế độ
async function processVideo(uid, photo) {
  const key = uid + '/' + photo.id;
  if (!video.hasFfmpeg || videoJobs.has(key) || photo.vfail || photo.trashed || isOffline(photo)) return;
  videoJobs.add(key);
  const alive = () => getPhotos(uid).includes(photo);
  try {
    if (!photo.w || !photo.duration) {
      const l = photo.link && linkById(photo.link), probe = () => video.probe(originalPath(uid, photo));
      const info = await (l ? onDrive(l, probe) : probe());
      Object.assign(photo, { w: info.w, h: info.h, duration: info.duration, fps: info.fps });
      if (!photo.taken && info.taken) photo.taken = info.taken;
      savePhotosSoon(uid);
    }
    if (!photo.color || !await fileExists(media.hasSharp ? media.variantPath(cacheDir(uid, photo), photo.id, 'sm') : posterPath(uid, photo))) {
      await makeThumbs(uid, photo);
    }
    // Tính lại mức còn thiếu sau mỗi mức: quản trị viên có thể đổi chế độ giữa chừng
    for (const done = new Set(); ;) {
      if (!alive() || isOffline(photo) || photo.trashed) return; // vào thùng rác: khôi phục thì làm tiếp
      let q = null;
      for (const c of videoPlan(photo)) {
        if (done.has(c)) continue;
        if (photo.hls && photo.hls[c] && await fileExists(path.join(hlsDir(uid, photo), String(c), 'index.m3u8'))) { done.add(c); continue; }
        q = c; break;
      }
      if (q === null) break;
      const t0 = Date.now(), wanted = () => alive() && !isOffline(photo) && levelAllowed(photo, q);
      const l = photo.link && linkById(photo.link);
      let r;
      videoLevel.set(key, { photo, q });
      try {
        // Đường dẫn tính lúc bắt đầu chạy: ổ có thể được cắm lại với ký tự khác trong lúc chờ
        r = await video.makeRendition(() => originalPath(uid, photo), () => hlsDir(uid, photo), q, photo, key, wanted, l ? driveSlot(l) : null);
      } catch (err) {
        if (err.cancelled && alive() && !levelAllowed(photo, q)) continue; // huỷ vì đổi chế độ: làm mức tiếp theo của chế độ mới
        throw err;
      } finally {
        videoLevel.delete(key);
      }
      if (!alive()) { // bị xoá trong lúc chạy (không xoá HLS nếu ảnh vẫn còn dưới object khác, vd. vừa khôi phục bản sao lưu)
        if (!getPhotos(uid).some(x => x.id === photo.id)) await fsp.rm(hlsDir(uid, photo), { recursive: true, force: true });
        return;
      }
      if (isOffline(photo)) return; // ổ vừa được ngắt: không ghi thêm gì lên ổ, cắm lại thì làm lại mức này
      if (!wanted()) { await fsp.rm(path.join(hlsDir(uid, photo), String(q)), { recursive: true, force: true }); continue; }
      done.add(q);
      photo.hls = { ...photo.hls, [q]: r };
      await savePhotos(uid, getPhotos(uid));
      console.log(`Video ${photo.name}: xong ${q}p (${r.kbps} kbps, ${Math.round((Date.now() - t0) / 1000)} giây)`);
    }
  } catch (err) {
    if (err.cancelled || isOffline(photo) || (photo.link && !await linkReachable(photo.link))) return; // ổ vừa bị rút: cắm lại thì làm tiếp
    photo.vfail = true; // không thử lại mỗi lần khởi động; xoá dòng vfail trong photos.json để thử lại
    savePhotosSoon(uid);
    console.error(`Không xử lý được video ${photo.name}:`, err.message);
  } finally {
    videoJobs.delete(key);
  }
}

// /uploads/<file>/hls/master.m3u8 và /uploads/<file>/hls/<mức>/(index.m3u8|segNNNN.ts)
async function serveHls(res, uid, photo, rest, cache) {
  const ready = readyHls(photo);
  if (rest.length === 1 && rest[0] === 'master.m3u8') {
    if (!Object.keys(ready).length) return send(res, 404, 'Video chưa có bản HLS');
    // Danh sách mức thay đổi khi server tạo thêm mức -> không cache lâu
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' });
    return res.end(video.masterPlaylist(ready));
  }
  if (rest.length === 2 && ready[rest[0]] && /^(index\.m3u8|seg\d{4,6}\.ts)$/.test(rest[1])) {
    return serveFile(res, path.join(hlsDir(uid, photo), rest[0], rest[1]), cache);
  }
  send(res, 404, 'Không tìm thấy');
}
const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');

// ---------- Album của từng người: users/<id>/albums.json ----------
// [{ id, name, photoIds: [...], cover: photoId | null, created }] — album chỉ giữ id ảnh, không sao chép file
const albumsFile = id => path.join(userDir(id), 'albums.json');
const albumCache = new Map();
function getAlbums(uid) {
  if (!albumCache.has(uid)) albumCache.set(uid, readJson(albumsFile(uid), []));
  return albumCache.get(uid);
}
function saveAlbums(uid, list) {
  albumCache.set(uid, list);
  return writeJson(albumsFile(uid), list);
}

// Ảnh từ bản cũ (uploads/ + data.json) được chuyển cho tài khoản quản trị đầu tiên
async function migrateLegacy(uid) {
  const legacy = readJson(LEGACY_DATA_FILE, null);
  if (!Array.isArray(legacy) || !legacy.length) return 0;
  const moved = [];
  for (const p of legacy) {
    const file = path.basename(String(p.file || ''));
    try {
      await fsp.rename(path.join(LEGACY_UPLOAD_DIR, file), path.join(imagesDir(uid), file));
      moved.push({ ...p, file, url: '/uploads/' + file });
    } catch { /* file không còn, bỏ qua */ }
  }
  await savePhotos(uid, moved);
  await fsp.rename(LEGACY_DATA_FILE, LEGACY_DATA_FILE + '.migrated').catch(() => {});
  return moved.length;
}

// ---------- Phiên đăng nhập ----------
// sessions.json chỉ lưu hash của token, lộ file cũng không đăng nhập được
let sessions = readJson(SESSIONS_FILE, {});
for (const [k, s] of Object.entries(sessions)) if (s.exp < Date.now()) delete sessions[k];
const saveSessions = () => writeJson(SESSIONS_FILE, sessions);
const tokenKey = t => crypto.createHash('sha256').update(t).digest('hex');

function createSession(uid) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions[tokenKey(token)] = { uid, exp: Date.now() + SESSION_MS };
  saveSessions();
  return token;
}
function dropSessions(uid, keepKey) {
  for (const [k, s] of Object.entries(sessions)) if (s.uid === uid && k !== keepKey) delete sessions[k];
  return saveSessions();
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function sessionOf(req) {
  const token = cookies(req).sid;
  if (!token) return null;
  const key = tokenKey(token);
  const s = sessions[key];
  if (!s || s.exp < Date.now()) return null;
  const user = users.find(u => u.id === s.uid);
  return user ? { key, user } : null;
}
function sessionCookie(req, token, maxAge) {
  // Qua Tailscale Funnel / Cloudflare Tunnel là HTTPS -> thêm Secure
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// Chặn đoán mật khẩu: sai quá nhiều lần thì khoá tên đăng nhập đó một lúc
const loginFails = new Map(); // username -> { n, until }
function loginLocked(name) {
  const f = loginFails.get(name);
  return f && f.until > Date.now();
}
function noteLoginFail(name) {
  const f = loginFails.get(name) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= LOGIN_MAX_FAILS) { f.n = 0; f.until = Date.now() + LOGIN_LOCK_MS; }
  loginFails.set(name, f);
}

// Tạo tài khoản đầu tiên chỉ được làm ngay trên máy chạy server (không qua tunnel)
function isLocalRequest(req) {
  const ip = req.socket.remoteAddress || '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  return loopback && !req.headers['x-forwarded-for'];
}

// Đặt lại mật khẩu khi quên: chỉ trên máy chạy server, mở bằng localhost / 127.0.0.1.
// Kiểm tra thêm Host và Origin để trang web lạ (DNS rebinding) không lợi dụng được trình duyệt trên máy này.
function isLocalBrowser(req) {
  if (!isLocalRequest(req)) return false;
  const host = (req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return false;
  const origin = req.headers.origin;
  return !origin || origin.toLowerCase() === `http://${(req.headers.host || '').toLowerCase()}`;
}

// ---------- Helpers ----------
const httpError = (status, message) => Object.assign(new Error(message), { status });

// Nén chữ/JSON (nhỏ đi 4–8 lần, rất có ích khi mạng chậm): ưu tiên brotli (nhỏ hơn gzip ~15%), không có thì gzip
function pickEncoding(req) {
  const ae = req.headers['accept-encoding'] || '';
  return /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null;
}
// max: nén kỹ nhất, dùng cho trang web (chỉ nén một lần rồi giữ lại); còn lại nén nhanh cho dữ liệu đổi liên tục
function compress(data, enc, max = false) {
  if (enc === 'gzip') return zlib.gzipSync(data, { level: max ? 9 : 6 });
  const { BROTLI_PARAM_QUALITY, BROTLI_PARAM_SIZE_HINT } = zlib.constants;
  return zlib.brotliCompressSync(data, { params: { [BROTLI_PARAM_QUALITY]: max ? 11 : 5, [BROTLI_PARAM_SIZE_HINT]: data.length } });
}
const notModified = (req, etag) => req.headers['if-none-match'] === etag;

function send(res, status, body, headers = {}) {
  const req = res.req;
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  let data = isJson ? JSON.stringify(body) : body;
  // Dữ liệu GET (danh sách ảnh, album…): trình duyệt giữ lại và hỏi lại kèm ETag,
  // chưa đổi thì chỉ trả 304 thay vì gửi lại cả danh sách (vd. mỗi lần quay lại tab)
  const revalidate = status === 200 && isJson && req.method === 'GET' && !headers['Set-Cookie'];
  const etag = revalidate ? `W/"${crypto.createHash('sha1').update(data).digest('base64url')}"` : null;
  const cache = revalidate ? 'private, no-cache' : 'no-store';
  if (etag && notModified(req, etag)) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cache, Vary: 'Accept-Encoding' });
    return res.end();
  }
  const enc = data.length > 1024 ? pickEncoding(req) : null;
  if (enc) data = compress(Buffer.from(data), enc);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': cache,
    ...(etag ? { ETag: etag } : {}),
    ...(enc ? { 'Content-Encoding': enc, Vary: 'Accept-Encoding' } : {}),
    ...headers,
  });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'File quá lớn')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Chỉ nhận Content-Type: application/json -> form của trang web khác không gửi giả được (chống CSRF)
async function readJsonBody(req) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw httpError(415, 'Cần gửi dữ liệu dạng JSON');
  try { return JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); }
  catch (err) { throw err.status ? err : httpError(400, 'JSON không hợp lệ'); }
}

function decodeHeader(v, fallback = '') {
  try { return v ? decodeURIComponent(v) : fallback; } catch { return fallback; }
}

// Trang web đã nén, giữ trong RAM theo ETag -> mỗi phiên bản chỉ nén một lần (nén kỹ nhất), không nén lại mỗi lượt tải
const packed = new Map();
async function packText(file, etag, enc) {
  const key = enc + ':' + file, hit = packed.get(key);
  if (hit && hit.etag === etag) return hit.data;
  const data = compress(await fsp.readFile(file), enc, true);
  packed.set(key, { etag, data });
  return data;
}

// File đang gửi cho người xem; ngắt ổ thì đóng các file nằm trên ổ đó (xem stopDrive)
const openReads = new Set();
function readStream(file, opts) {
  const s = fs.createReadStream(file, opts);
  openReads.add(s);
  s.on('close', () => openReads.delete(s));
  return s;
}

async function serveFile(res, file, cache) {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error();
    const type = STATIC_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const isText = /^text\/|json|svg/.test(type);
    // Mọi file đều có ETag: hết hạn cache thì trình duyệt hỏi lại, file chưa đổi thì chỉ nhận 304 (không tải lại)
    const etag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;
    const common = { ETag: etag, 'Cache-Control': cache, ...(isText ? { Vary: 'Accept-Encoding' } : { 'Accept-Ranges': 'bytes' }) };
    if (notModified(res.req, etag)) { res.writeHead(304, common); return res.end(); }
    // Range: trình duyệt chỉ tải đoạn video cần xem (tua tới đâu tải tới đó), không phải cả file
    const range = !isText && /^bytes=(\d*)-(\d*)$/.exec(res.req.headers.range || '');
    const ifRange = res.req.headers['if-range'];
    if (range && (range[1] || range[2]) && (!ifRange || ifRange === etag)) {
      const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, ...common });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        ...common, 'X-Content-Type-Options': 'nosniff',
      });
      if (res.req.method === 'HEAD') return res.end();
      return pipeline(readStream(file, { start, end }), res, () => {});
    }
    const enc = isText ? pickEncoding(res.req) : null;
    const body = enc ? await packText(file, etag, enc) : null;
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body ? body.length : stat.size,
      ...(enc ? { 'Content-Encoding': enc } : {}),
      ...common,
      'X-Content-Type-Options': 'nosniff',
    });
    if (res.req.method === 'HEAD') return res.end();
    // pipeline: người xem tua/đóng video giữa chừng thì đóng file ngay (Windows không khoá file)
    body ? res.end(body) : pipeline(readStream(file), res, () => {});
  } catch {
    if (!res.headersSent) send(res, 404, 'Không tìm thấy');
  }
}

// Chặn đường dẫn kiểu ../ ra ngoài thư mục cho phép
function safeJoin(base, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  const p = path.normalize(path.join(base, decoded));
  return p.startsWith(base + path.sep) || p === base ? p : null;
}

// ---------- API: tài khoản ----------
async function authApi(req, res, parts, session) {
  const action = parts[1];

  // GET /api/status — đã đăng nhập chưa, đã có tài khoản nào chưa
  if (action === 'status' && req.method === 'GET') {
    return send(res, 200, {
      user: session ? publicUser(session.user) : null,
      prefs: session ? { dataSaver: false, ...session.user.prefs } : null, // tuỳ chọn riêng của tài khoản; chỉ có lang khi đã lưu
      needsSetup: users.length === 0,
      canSetup: users.length === 0 && isLocalRequest(req),
      canReset: users.length > 0 && isLocalBrowser(req), // hiện nút "Quên mật khẩu?"
    });
  }

  // POST /api/setup — tạo tài khoản quản trị đầu tiên
  if (action === 'setup' && req.method === 'POST') {
    if (users.length) throw httpError(409, 'Đã có tài khoản quản trị');
    if (!isLocalRequest(req)) throw httpError(403, 'Hãy mở trang này ngay trên máy chạy server để tạo tài khoản đầu tiên');
    const body = await readJsonBody(req);
    const user = await createUser(validUsername(body.username), validPassword(body.password), 'admin');
    const migrated = await migrateLegacy(user.id);
    const token = createSession(user.id);
    return send(res, 201, { user: publicUser(user), migrated }, { 'Set-Cookie': sessionCookie(req, token, SESSION_MS / 1000) });
  }

  // POST /api/login
  if (action === 'login' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const name = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (loginLocked(name)) throw httpError(429, 'Sai mật khẩu quá nhiều lần, hãy thử lại sau 15 phút');
    const user = users.find(u => u.username === name);
    if (!await checkPassword(user, password)) {
      noteLoginFail(name);
      throw httpError(401, 'Sai tên đăng nhập hoặc mật khẩu');
    }
    loginFails.delete(name);
    const token = createSession(user.id);
    return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, token, SESSION_MS / 1000) });
  }

  // POST /api/reset-password — quên mật khẩu: đặt mật khẩu mới, chỉ làm được ngay trên máy chạy server
  if (action === 'reset-password' && req.method === 'POST') {
    if (!isLocalBrowser(req)) throw httpError(403, 'Chỉ đặt lại được mật khẩu khi mở trang ngay trên máy chạy server (http://localhost)');
    const body = await readJsonBody(req);
    const name = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const user = users.find(u => u.username === name);
    if (!user) throw httpError(404, 'Không có tài khoản với tên đăng nhập này');
    Object.assign(user, await hashPassword(validPassword(body.password)));
    await saveUsers();
    await dropSessions(user.id); // đăng xuất mọi thiết bị đang dùng mật khẩu cũ
    loginFails.delete(name);
    console.log(`Đã đặt lại mật khẩu cho "${user.username}" từ máy chủ.`);
    const token = createSession(user.id);
    return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, token, SESSION_MS / 1000) });
  }

  // GET /api/reset-users — tên các tài khoản để chọn khi đặt lại (chỉ trên máy chủ)
  if (action === 'reset-users' && req.method === 'GET') {
    if (!isLocalBrowser(req)) throw httpError(403, 'Chỉ đặt lại được mật khẩu khi mở trang ngay trên máy chạy server (http://localhost)');
    return send(res, 200, users.map(u => ({ username: u.username, role: u.role })));
  }

  // POST /api/logout
  if (action === 'logout' && req.method === 'POST') {
    if (session) { delete sessions[session.key]; await saveSessions(); }
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  if (!session) throw httpError(401, 'Cần đăng nhập');
  const me = session.user;

  // POST /api/prefs — lưu tuỳ chọn của tài khoản, gửi một hoặc cả hai:
  // { dataSaver: true|false } (tiết kiệm dữ liệu khi xem bằng 4G/5G), { lang: 'en'|'vi' }
  if (action === 'prefs' && req.method === 'POST') {
    const body = await readJsonBody(req) || {};
    const patch = {};
    if (body.dataSaver !== undefined) {
      if (typeof body.dataSaver !== 'boolean') throw httpError(400, 'Tuỳ chọn không hợp lệ');
      patch.dataSaver = body.dataSaver;
    }
    if (body.lang !== undefined) {
      if (!LANGS.includes(body.lang)) throw httpError(400, 'Tuỳ chọn không hợp lệ');
      patch.lang = body.lang;
    }
    if (!Object.keys(patch).length) throw httpError(400, 'Tuỳ chọn không hợp lệ');
    me.prefs = { ...me.prefs, ...patch };
    await saveUsers();
    return send(res, 200, { prefs: me.prefs });
  }

  // POST /api/password — tự đổi mật khẩu, đăng xuất các thiết bị khác
  if (action === 'password' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!await checkPassword(me, typeof body.current === 'string' ? body.current : '')) throw httpError(400, 'Mật khẩu hiện tại không đúng');
    Object.assign(me, await hashPassword(validPassword(body.next)));
    await saveUsers();
    await dropSessions(me.id, session.key);
    return send(res, 200, { ok: true });
  }

  // /api/settings — cài đặt máy chủ, chỉ quản trị viên
  if (action === 'settings') {
    if (me.role !== 'admin') throw httpError(403, 'Chỉ quản trị viên mới làm được');
    const view = () => ({ port: PORT, envPort: ENV_PORT, defaultPort: DEFAULT_PORT, videoMode });
    if (req.method === 'GET') return send(res, 200, view());

    // PUT /api/settings { videoMode: 'lite' | 'full' } — gọn nhẹ thì xoá ngay các mức video khác 720p, trả về số byte đã xoá
    // PUT /api/settings { port } — mở cổng mới ngay, cổng cũ đóng sau vài giây
    if (req.method === 'PUT') {
      const body = await readJsonBody(req) || {};
      if (body.videoMode !== undefined) {
        if (!VIDEO_MODES.includes(body.videoMode)) throw httpError(400, 'Tuỳ chọn không hợp lệ');
        const freed = body.videoMode === videoMode ? 0 : await setVideoMode(body.videoMode);
        return send(res, 200, { ...view(), freed });
      }
      const port = Number(body.port);
      if (!portOk(port)) throw httpError(400, 'Cổng phải là số từ 1024 đến 65535');
      if (ENV_PORT) throw httpError(409, `Cổng đang được đặt bằng biến môi trường PORT=${ENV_PORT} khi chạy server. Bỏ biến đó rồi chạy lại server để đổi cổng ở đây.`);
      if (port === PORT) return send(res, 200, { ...view(), old: PORT });
      const old = PORT;
      await switchPort(port);
      settings.port = port;
      await saveSettings();
      return send(res, 200, { ...view(), old });
    }
    throw httpError(405, 'Method not allowed');
  }

  // /api/users — chỉ quản trị viên
  if (action === 'users') {
    if (me.role !== 'admin') throw httpError(403, 'Chỉ quản trị viên mới làm được');
    const id = parts[2];

    if (!id && req.method === 'GET') {
      return send(res, 200, users.map(u => {
        const list = getPhotos(u.id);
        // bytes: dung lượng trên máy chủ (không tính ảnh xem từ ổ ngoài)
        return { ...publicUser(u), photos: list.length, linked: list.filter(p => p.link).length, bytes: list.reduce((a, p) => a + (p.link ? 0 : p.size || 0), 0) };
      }));
    }
    if (!id && req.method === 'POST') {
      const body = await readJsonBody(req);
      const role = body.role === 'admin' ? 'admin' : 'user';
      const user = await createUser(validUsername(body.username), validPassword(body.password), role);
      return send(res, 201, { ...publicUser(user), photos: 0, bytes: 0 });
    }

    const user = users.find(u => u.id === id);
    if (!user) throw httpError(404, 'Không tìm thấy tài khoản');

    // PATCH /api/users/:id — đặt lại mật khẩu / đổi quyền
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      if (body.role !== undefined) {
        if (user.id === me.id) throw httpError(400, 'Không thể tự đổi quyền của chính mình');
        user.role = body.role === 'admin' ? 'admin' : 'user';
      }
      if (body.password !== undefined) {
        Object.assign(user, await hashPassword(validPassword(body.password)));
        await dropSessions(user.id, user.id === me.id ? session.key : null);
      }
      await saveUsers();
      return send(res, 200, publicUser(user));
    }

    // DELETE /api/users/:id — xoá tài khoản và toàn bộ ảnh của người đó
    if (req.method === 'DELETE') {
      if (user.id === me.id) throw httpError(400, 'Không thể tự xoá tài khoản của chính mình');
      users = users.filter(u => u.id !== user.id);
      await saveUsers();
      if (shares.some(x => x.uid === user.id)) { shares = shares.filter(x => x.uid !== user.id); await saveShares(); }
      for (const l of links.filter(x => x.uid === user.id)) await removeLink(l);
      await dropSessions(user.id);
      photoCache.delete(user.id);
      albumCache.delete(user.id);
      await fsp.rm(userDir(user.id), { recursive: true, force: true });
      return send(res, 200, { ok: true });
    }
  }

  throw httpError(404, 'Not found');
}

// ---------- API: ảnh chung (ảnh mọi người đã chọn công khai) ----------
// Ảnh công khai vẫn nằm trong thư mục của chủ ảnh, chỉ được xem qua /shared/<id chủ ảnh>/<file>
function publicPhotos(viewerId) {
  const list = [];
  for (const u of users) {
    for (const p of getPhotos(u.id)) {
      if (!p.public || p.trashed || isOffline(p)) continue;
      const v = { ...photoView(p, `/shared/${u.id}/${p.file}`), fav: false, owner: u.username, mine: u.id === viewerId };
      if (!v.mine) noLocation(v); // không lộ nơi chụp ảnh của người khác
      list.push(v);
    }
  }
  return list;
}
function findPublicPhoto(ownerId, file) {
  if (!users.some(u => u.id === ownerId)) return null;
  const p = photoIndex(getPhotos(ownerId), 'file').get(file);
  return p && p.public && !p.trashed ? p : null;
}

// ---------- API: ảnh (của người đang đăng nhập) ----------
async function photosApi(req, res, parts, uid) {
  if (parts.length > 3) throw httpError(404, 'Not found');
  const id = parts[2];
  // Không giữ danh sách ảnh qua một await: xoá ảnh / quét ổ ngoài thay mảng bằng mảng mới trong lúc chờ,
  // lưu mảng cũ sẽ làm ảnh đã xoá hiện lại và mất ảnh vừa thêm -> luôn lấy lại getPhotos(uid) ngay trước khi sửa / lưu

  // GET /api/photos — danh sách ảnh
  if (req.method === 'GET' && !id) return send(res, 200, visiblePhotos(uid).map(p => photoView(p)));

  // POST /api/photos/bulk — công khai / riêng tư nhiều ảnh cùng lúc: { ids: [...], public: true|false }
  if (req.method === 'POST' && id === 'bulk') {
    const body = await readJsonBody(req);
    if (!Array.isArray(body.ids) || typeof body.public !== 'boolean') throw httpError(400, 'Cần danh sách ảnh và trạng thái công khai');
    const ids = new Set(body.ids), photos = getPhotos(uid);
    let updated = 0;
    for (const p of photos) if (ids.has(p.id) && !!p.public !== body.public) { p.public = body.public; updated++; }
    if (updated) await savePhotos(uid, photos);
    return send(res, 200, { updated });
  }

  // POST /api/photos — body là nội dung file ảnh/video, tên file ở header X-Filename
  if (req.method === 'POST' && !id) {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type.startsWith('video/')) return uploadVideo(req, res, uid);
    // HEIC: trình duyệt hay gửi image/heif hoặc không rõ định dạng -> server tự nhận dạng
    const ext = IMAGE_TYPES[type === 'image/heif' ? 'image/heic' : type];
    if (!ext) return send(res, 415, { error: 'Định dạng không được hỗ trợ: ' + (type || 'không rõ') });
    const buf = await readBody(req, MAX_SIZE);
    if (!buf.length) return send(res, 400, { error: 'File rỗng' });
    const heic = ext === '.heic';
    if (heic && media.sniffType(buf) !== 'image/heic') return send(res, 415, { error: 'Không nhận ra ảnh HEIC' });

    const newId = crypto.randomUUID();
    const file = newId + ext;
    await fsp.mkdir(imagesDir(uid), { recursive: true });
    await fsp.writeFile(path.join(imagesDir(uid), file), buf);
    const photo = {
      hash: sha1(buf), // để nhận ra ảnh trùng khi chép vào thư mục nhập
      id: newId,
      name: decodeHeader(req.headers['x-filename'], 'image' + ext).slice(0, 200),
      file,
      url: '/uploads/' + file,
      type: heic ? 'image/heic' : type,
      size: buf.length,
      w: Number(req.headers['x-width']) || 0,
      h: Number(req.headers['x-height']) || 0,
      taken: Number(req.headers['x-taken']) || (heic ? await media.heicDate(path.join(imagesDir(uid), file)) : media.exifDate(buf)), // ngày chụp đọc từ EXIF (nếu có)
      added: Date.now(),
      fav: false,
      public: false, // true: mọi tài khoản đều xem và tải được
    };
    if (type === 'image/jpeg') setMeta(photo, exif.parseExif(buf)); // định dạng khác: đọc ở nền (scheduleMeta)
    const photos = getPhotos(uid); // lấy lại sau các await ở trên (nhận file có thể mất cả phút khi mạng chậm)
    photos.push(photo);
    await savePhotos(uid, photos);
    makeThumbs(uid, photo);
    scheduleMeta();
    return send(res, 201, photoView(photo));
  }

  const findPhoto = () => getPhotos(uid).find(p => p.id === id);
  let photo = findPhoto();
  if (!photo) return send(res, 404, { error: 'Không tìm thấy ảnh' });

  // PATCH /api/photos/:id — sửa tên / yêu thích
  if (req.method === 'PATCH') {
    const body = await readJsonBody(req);
    photo = findPhoto(); // có thể vừa bị xoá trong lúc đọc body
    if (!photo) return send(res, 404, { error: 'Không tìm thấy ảnh' });
    if (typeof body.fav === 'boolean') photo.fav = body.fav;
    if (typeof body.public === 'boolean') photo.public = body.public;
    if (typeof body.name === 'string' && body.name.trim()) photo.name = body.name.trim().slice(0, 200);
    await savePhotos(uid, getPhotos(uid));
    return send(res, 200, photoView(photo));
  }

  // DELETE /api/photos/:id — chuyển vào thùng rác (xoá hẳn sau TRASH_DAYS ngày, xem /api/trash)
  if (req.method === 'DELETE') {
    const n = await trashPhotos(uid, [id]);
    return send(res, 200, { ok: true, trashed: n });
  }

  send(res, 405, { error: 'Method not allowed' });
}

// ---------- Thông tin chụp: máy ảnh, thông số, GPS, nơi chụp (exif.js) ----------
// p.exif chưa có = chưa đọc; {} = đã đọc mà không có gì. Đọc dần ở nền, mỗi lúc một file (chỉ đọc phần đầu file, nhanh)
function setMeta(p, info) {
  p.exif = info;
  const pl = exif.place(info.lat, info.lon);
  if (pl) p.place = pl; else delete p.place;
}
let metaRunning = false, metaAgain = false;
function scheduleMeta() {
  if (metaRunning) { metaAgain = true; return; }
  metaRunning = true;
  readMeta().catch(err => console.error('Lỗi khi đọc thông tin chụp:', err.message)).finally(() => {
    metaRunning = false;
    if (metaAgain) { metaAgain = false; scheduleMeta(); }
  });
}
async function readMeta() {
  for (const u of [...users]) {
    let n = 0;
    const changed = async () => { if (++n % 50 === 0) await savePhotos(u.id, getPhotos(u.id)); }; // ảnh hiện dần khi đọc nhiều
    for (const p of getPhotos(u.id).filter(p => p.exif === undefined || (media.hasSharp && !p.dhash))) {
      if (restoring) return;
      if (isOffline(p) || !getPhotos(u.id).includes(p)) continue; // ảnh trên ổ đang rút: đọc khi cắm lại
      const l = p.link && linkById(p.link), file = () => originalPath(u.id, p);
      if (media.hasSharp && !p.dhash) { // vân tay ảnh (tìm ảnh trùng) từ ảnh nhỏ đã có; chưa có ảnh nhỏ thì để lần sau
        const sm = () => media.variantPath(cacheDir(u.id, p), p.id, 'sm');
        const h = await (l ? onDrive(l, () => media.dhash(sm())) : media.dhash(sm())).catch(() => null);
        if (h && getPhotos(u.id).includes(p)) { p.dhash = h; await changed(); }
      }
      if (p.exif !== undefined) continue;
      const read = async () => p.kind === 'video'
        ? (video.hasFfmpeg ? exif.fromVideoTags((await video.probe(file())).tags) : {})
        : exif.readImage(file());
      let info;
      try { info = await (l ? onDrive(l, read) : read()); }
      catch (err) {
        if (err.cancelled || isOffline(p)) continue;
        info = {}; // file hỏng / không đọc được: không thử lại mãi
      }
      if (!getPhotos(u.id).includes(p) || p.exif !== undefined) continue; // bị xoá / thay trong lúc đọc
      setMeta(p, info);
      await changed();
    }
    if (n % 50) await savePhotos(u.id, getPhotos(u.id));
  }
}

// ---------- Thùng rác: ảnh xoá được giữ TRASH_DAYS ngày rồi mới xoá hẳn ----------
// Ảnh trong thùng rác vẫn nằm trong photos.json (thêm trashed: thời điểm xoá, trashAlbums: các album đã chứa nó),
// bị ẩn khỏi mọi danh sách (visiblePhotos, ảnh công khai, link chia sẻ) nhưng chủ ảnh vẫn xem được ảnh nhỏ.
async function trashPhotos(uid, ids) {
  const want = new Set(ids), now = Date.now(), albums = getAlbums(uid);
  let n = 0, albumsChanged = false;
  for (const p of getPhotos(uid)) {
    if (!want.has(p.id) || p.trashed) continue;
    p.trashed = now;
    p.trashAlbums = albums.filter(a => a.photoIds.includes(p.id)).map(a => a.id);
    for (const a of albums) {
      if (!a.photoIds.includes(p.id)) continue;
      a.photoIds = a.photoIds.filter(x => x !== p.id);
      if (a.cover === p.id) { a.cover = null; (p.trashCovers ||= []).push(a.id); }
      albumsChanged = true;
    }
    if (p.kind === 'video') video.cancel(uid + '/' + p.id); // dừng chuyển đổi, khôi phục thì làm tiếp
    n++;
  }
  if (n) await savePhotos(uid, getPhotos(uid));
  if (albumsChanged) await saveAlbums(uid, getAlbums(uid));
  return n;
}
async function restoreTrashed(uid, ids) {
  const want = new Set(ids), albums = getAlbums(uid), back = [];
  let albumsChanged = false;
  for (const p of getPhotos(uid)) {
    if (!want.has(p.id) || !p.trashed) continue;
    for (const a of albums) {
      if (!(p.trashAlbums || []).includes(a.id) || a.photoIds.includes(p.id)) continue;
      a.photoIds.push(p.id);
      if (!a.cover && (p.trashCovers || []).includes(a.id)) a.cover = p.id;
      albumsChanged = true;
    }
    delete p.trashed;
    delete p.trashAlbums;
    delete p.trashCovers;
    back.push(p);
  }
  if (back.length) await savePhotos(uid, getPhotos(uid));
  if (albumsChanged) await saveAlbums(uid, getAlbums(uid));
  for (const p of back) if (p.kind === 'video') processVideo(uid, p);
  return back.length;
}
// Xoá hẳn: bỏ khỏi danh sách và album, xoá ảnh nhỏ / HLS, rồi xoá file gốc.
// Ảnh trong thư mục liên kết: chỉ ẩn khỏi gallery, không bao giờ xoá file gốc trên ổ ngoài
async function destroyPhotos(uid, list) {
  if (!list.length) return 0;
  const ids = new Set(list.map(p => p.id));
  await savePhotos(uid, getPhotos(uid).filter(p => !ids.has(p.id)));
  const albums = getAlbums(uid);
  if (albums.some(a => a.photoIds.some(x => ids.has(x)) || ids.has(a.cover))) {
    for (const a of albums) {
      a.photoIds = a.photoIds.filter(x => !ids.has(x));
      if (ids.has(a.cover)) a.cover = null;
    }
    await saveAlbums(uid, albums);
  }
  for (const photo of list) {
    await dropThumbs(uid, photo); // trước khi xoá file gốc: dừng ffmpeg đang đọc nó
    if (photo.link) await hideLinked(photo);
    else await fsp.unlink(path.join(imagesDir(uid), photo.file)).catch(() => {});
  }
  return list.length;
}
// Xoá hẳn ảnh đã nằm trong thùng rác quá TRASH_DAYS ngày (mỗi 6 giờ, và lúc khởi động)
async function purgeTrash() {
  if (restoring) return;
  const limit = Date.now() - TRASH_DAYS * 864e5;
  for (const u of [...users]) {
    const old = getPhotos(u.id).filter(p => p.trashed && p.trashed < limit);
    if (old.length) { await destroyPhotos(u.id, old); console.log(`Thùng rác của ${u.username}: đã xoá hẳn ${old.length} ảnh/video quá ${TRASH_DAYS} ngày`); }
  }
}

// /api/trash — GET: danh sách; POST { ids }: chuyển vào thùng rác; POST /restore { ids }; POST /purge { ids } hoặc { all: true }
async function trashApi(req, res, parts, uid) {
  const action = parts[2];
  if (!action && req.method === 'GET') {
    const items = getPhotos(uid).filter(p => p.trashed && !isOffline(p)).sort((a, b) => b.trashed - a.trashed)
      .map(p => ({ ...photoView(p), purgeAt: p.trashed + TRASH_DAYS * 864e5 }));
    return send(res, 200, { days: TRASH_DAYS, items });
  }
  if (req.method !== 'POST' || parts.length > 3) throw httpError(404, 'Not found');
  const body = await readJsonBody(req) || {};
  const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string') : [];
  if (!action) {
    if (!ids.length) throw httpError(400, 'Chưa chọn ảnh nào');
    return send(res, 200, { trashed: await trashPhotos(uid, ids) });
  }
  if (action === 'restore') {
    if (!ids.length) throw httpError(400, 'Chưa chọn ảnh nào');
    return send(res, 200, { restored: await restoreTrashed(uid, ids) });
  }
  if (action === 'purge') {
    const want = new Set(ids);
    const list = getPhotos(uid).filter(p => p.trashed && (body.all === true || want.has(p.id)));
    if (!list.length && body.all !== true) throw httpError(400, 'Chưa chọn ảnh nào');
    return send(res, 200, { purged: await destroyPhotos(uid, list) });
  }
  throw httpError(404, 'Not found');
}

// ---------- Ảnh trùng: giống hệt (cùng SHA-1) hoặc rất giống (vân tay dHash khác nhau tối đa SIMILAR_BITS bit) ----------
const SIMILAR_BITS = 5;
function popcount32(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24;
}
const fpOf = h => [parseInt(h.slice(0, 8), 16), parseInt(h.slice(8, 16), 16)];
function duplicateGroups(uid) {
  const list = visiblePhotos(uid);
  const parent = new Map(list.map(p => [p.id, p.id]));
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent.set(a, b); };
  const byHash = new Map();
  for (const p of list) {
    if (!p.hash) continue; // ảnh trên ổ ngoài không có SHA-1: chỉ so bằng vân tay
    if (byHash.has(p.hash)) union(p.id, byHash.get(p.hash).id); else byHash.set(p.hash, p);
  }
  // Rất giống: chia 64 bit thành 8 dải 8 bit. Khác nhau <= 5 bit thì ít nhất 3 dải trùng hẳn, nên chỉ cần so
  // các ảnh có chung một dải (khỏi so từng cặp trong cả thư viện)
  const fps = [];
  for (const p of list) {
    if (!p.dhash) continue;
    const [a, b] = fpOf(p.dhash), bits = popcount32(a) + popcount32(b);
    if (bits < 4 || bits > 60) continue; // ảnh gần như một màu: vân tay không nói lên gì
    fps.push({ p, a, b });
  }
  const bands = new Map();
  for (const f of fps) for (let k = 0; k < 8; k++) {
    const key = k + f.p.dhash.slice(k * 2, k * 2 + 2);
    if (!bands.has(key)) bands.set(key, []);
    bands.get(key).push(f);
  }
  const shape = p => p.w && p.h ? p.w / p.h : 0;
  for (const bucket of bands.values()) {
    if (bucket.length < 2 || bucket.length > 1500) continue;
    for (let i = 0; i < bucket.length; i++) for (let j = i + 1; j < bucket.length; j++) {
      const x = bucket[i], y = bucket[j];
      if (popcount32(x.a ^ y.a) + popcount32(x.b ^ y.b) > SIMILAR_BITS) continue;
      const r1 = shape(x.p), r2 = shape(y.p);
      if (r1 && r2 && Math.abs(Math.log(r1 / r2)) > .15) continue; // khác hẳn tỉ lệ khung (ảnh dọc / ảnh ngang)
      union(x.p.id, y.p.id);
    }
  }
  const groups = new Map();
  for (const p of list) {
    const r = find(p.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  }
  // Ảnh nên giữ: nhiều điểm ảnh nhất, rồi file lớn nhất, rồi ảnh có trước
  const better = (a, b) => ((b.w || 0) * (b.h || 0) - (a.w || 0) * (a.h || 0)) || ((b.size || 0) - (a.size || 0)) || (a.added - b.added);
  return [...groups.values()].filter(g => g.length > 1).map(g => {
    g.sort(better);
    return { kind: g.every(p => p.hash && p.hash === g[0].hash) ? 'exact' : 'similar', items: g };
  }).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'exact' ? -1 : 1) || b.items.length - a.items.length);
}
// Bỏ ảnh trùng: ảnh giữ lại nhận album, ảnh bìa và yêu thích của các bản bị bỏ; các bản đó vào thùng rác (khôi phục được)
async function resolveDuplicates(uid, list) {
  const byId = new Map(visiblePhotos(uid).map(p => [p.id, p])), albums = getAlbums(uid), remove = [];
  let albumsChanged = false, photosChanged = false;
  for (const g of list) {
    const keep = byId.get(g && g.keep);
    const drop = (Array.isArray(g && g.remove) ? g.remove : []).map(id => byId.get(id)).filter(p => p && p !== keep);
    if (!keep || !drop.length) continue;
    for (const p of drop) {
      if (p.fav && !keep.fav) { keep.fav = true; photosChanged = true; }
      for (const a of albums) {
        if (!a.photoIds.includes(p.id)) continue;
        if (!a.photoIds.includes(keep.id)) a.photoIds.push(keep.id);
        if (a.cover === p.id) a.cover = keep.id;
        albumsChanged = true;
      }
      remove.push(p.id);
    }
  }
  if (albumsChanged) await saveAlbums(uid, getAlbums(uid));
  if (photosChanged) await savePhotos(uid, getPhotos(uid));
  return trashPhotos(uid, remove);
}
// /api/duplicates — GET: các nhóm ảnh trùng; POST /resolve { groups: [{ keep, remove: [...] }] }
async function duplicatesApi(req, res, parts, uid) {
  if (!parts[2] && req.method === 'GET') {
    const pending = media.hasSharp ? visiblePhotos(uid).filter(p => !p.dhash).length : 0;
    const groups = duplicateGroups(uid).map(g => ({ kind: g.kind, items: g.items.map(p => ({ ...photoView(p), same: !!p.hash && p.hash === g.items[0].hash })) }));
    return send(res, 200, { groups, pending });
  }
  if (parts[2] === 'resolve' && parts.length === 3 && req.method === 'POST') {
    const body = await readJsonBody(req) || {};
    if (!Array.isArray(body.groups) || !body.groups.length) throw httpError(400, 'Chưa chọn ảnh nào');
    return send(res, 200, { trashed: await resolveDuplicates(uid, body.groups.slice(0, 5000)) });
  }
  throw httpError(404, 'Not found');
}

// ---------- Link chia sẻ album ----------
// /s/<token>: trang share.html (ai có link cũng mở được, không cần tài khoản). Album luôn là bản hiện tại
// (thêm / bớt ảnh trong album là link đổi theo). Không lộ vị trí chụp, tên tài khoản chỉ hiện tên đăng nhập.
// Link có mật khẩu: /s/<token>/unlock đặt cookie (chỉ cho đường dẫn /s/<token>) = HMAC(secret, token + salt mật khẩu),
// nên đổi / bỏ mật khẩu là mọi người phải nhập lại. Thu hồi = xoá khỏi shares.json.
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{20,40}$/;
const SHARE_THEMES = ['cinema', 'paper', 'bento'];
const SHARE_MAX = 200; // mỗi tài khoản
const shareByToken = token => SHARE_TOKEN_RE.test(token || '') ? shares.find(x => x.token === token) || null : null;
const shareAlbum = sh => users.some(u => u.id === sh.uid) ? getAlbums(sh.uid).find(a => a.id === sh.albumId) || null : null;
const shareExpired = sh => !!sh.expires && sh.expires <= Date.now();
const shareCookie = sh => 'sh_' + sh.token.slice(0, 12);
const shareKey = sh => crypto.createHmac('sha256', settings.secret).update(sh.token + ':' + (sh.pass ? sh.pass.salt : '')).digest('base64url');
function shareUnlocked(req, sh) {
  if (!sh.pass) return true;
  const v = cookies(req)[shareCookie(sh)] || '', k = shareKey(sh);
  return v.length === k.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(k));
}
function sharePhotos(sh, album) {
  const ids = new Set(album.photoIds);
  return visiblePhotos(sh.uid).filter(p => ids.has(p.id));
}
// Chỉ gửi những trường người xem cần (không có yêu thích, công khai, thông tin máy ảnh / vị trí, id ổ ngoài...)
function shareView(sh, p) {
  const v = photoView(p, `/s/${sh.token}/f/${encodeURIComponent(p.file)}`);
  const out = { id: v.id, name: v.name, kind: v.kind, type: v.type, w: v.w, h: v.h, taken: v.taken, added: v.added, color: v.color, thumb: v.thumb, preview: v.preview };
  if (p.kind === 'video') Object.assign(out, { duration: v.duration, hls: v.hls, qualities: v.qualities, url: v.url });
  if (sh.download) Object.assign(out, { url: v.url, size: v.size });
  return out;
}
const shareFails = new Map(); // ip|token -> { n, until }
let shareSaveTimer = null;
const saveSharesSoon = () => { if (!shareSaveTimer) shareSaveTimer = setTimeout(() => { shareSaveTimer = null; saveShares(); }, 5000); };

async function shareRoute(req, res, url) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const [token, action, name, ...rest] = url.pathname.slice(3).split('/');
  const sh = shareByToken(token);
  if (!action) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveFile(res, path.join(PUBLIC_DIR, 'share.html'), 'no-cache'); // link sai / hết hạn: trang tự báo
  }
  const album = sh && shareAlbum(sh);
  if (!sh || !album) throw httpError(404, 'Link không tồn tại hoặc đã bị thu hồi');
  if (shareExpired(sh)) throw httpError(410, 'Link này đã hết hạn');

  if (action === 'info' && !name && req.method === 'GET') {
    const owner = users.find(u => u.id === sh.uid);
    const open = shareUnlocked(req, sh), list = open ? sharePhotos(sh, album) : [];
    if (open) { sh.views = (sh.views || 0) + 1; sh.last = Date.now(); saveSharesSoon(); }
    return send(res, 200, {
      name: album.name, owner: owner.username, expires: sh.expires || null, theme: sh.theme, download: !!sh.download,
      locked: !open, count: open ? list.length : null, photos: list.map(p => shareView(sh, p)),
    });
  }
  if (action === 'unlock' && !name && req.method === 'POST') {
    if (!sh.pass) return send(res, 200, { ok: true });
    const key = (req.socket.remoteAddress || '') + '|' + sh.token, f = shareFails.get(key) || { n: 0, until: 0 };
    if (f.until > Date.now()) throw httpError(429, 'Nhập sai quá nhiều lần, thử lại sau ít phút');
    const body = await readJsonBody(req) || {};
    const pass = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    const ok = crypto.timingSafeEqual(await scrypt(pass, sh.pass.salt, 64), Buffer.from(sh.pass.hash, 'hex'));
    if (!ok) {
      f.n++; if (f.n >= LOGIN_MAX_FAILS) { f.n = 0; f.until = Date.now() + LOGIN_LOCK_MS; }
      shareFails.set(key, f);
      throw httpError(403, 'Sai mật khẩu');
    }
    shareFails.delete(key);
    const maxAge = Math.max(60, Math.min(30 * 86400, sh.expires ? Math.floor((sh.expires - Date.now()) / 1000) : 30 * 86400));
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, { ok: true }, { 'Set-Cookie': `${shareCookie(sh)}=${shareKey(sh)}; Path=/s/${sh.token}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}` });
  }
  if (action === 'f' && name && (req.method === 'GET' || req.method === 'HEAD')) {
    if (!shareUnlocked(req, sh)) return send(res, 401, 'Cần mật khẩu');
    let photo = null;
    try { const file = decodeURIComponent(name); photo = sharePhotos(sh, album).find(p => p.file === file) || null; } catch { /* đường dẫn lỗi */ }
    const isHls = rest[0] === 'hls';
    if (!photo || (rest.length && !isHls)) return send(res, 404, 'Không tìm thấy');
    if (isOffline(photo)) return send(res, 503, OFFLINE_MSG);
    const cache = 'private, max-age=300'; // ngắn: chủ album có thể thu hồi link
    if (isHls) return photo.kind === 'video' ? serveHls(res, sh.uid, photo, rest.slice(1), cache) : send(res, 404, 'Không tìm thấy');
    const size = Object.hasOwn(media.SIZES, url.searchParams.get('s')) ? url.searchParams.get('s') : null;
    // Không cho tải ảnh gốc: chỉ gửi ảnh cỡ vừa màn hình (video vẫn cần file gốc khi chưa có bản HLS)
    if (!size && !sh.download && photo.kind !== 'video') return serveVariant(res, sh.uid, photo, 'md', cache);
    return size ? serveVariant(res, sh.uid, photo, size, cache) : serveOriginal(res, sh.uid, photo, cache);
  }
  throw httpError(404, 'Not found');
}

// /api/shares — link chia sẻ của mình. GET: danh sách; POST { albumId, days, password?, download, theme };
// PATCH /:token { days?, password? ('' = bỏ mật khẩu), download?, theme? }; DELETE /:token: thu hồi
async function sharesApi(req, res, parts, uid) {
  const view = sh => {
    const a = shareAlbum(sh);
    return { token: sh.token, url: '/s/' + sh.token, albumId: sh.albumId, albumName: a ? a.name : null, created: sh.created,
      expires: sh.expires || null, expired: shareExpired(sh), hasPass: !!sh.pass, download: !!sh.download, theme: sh.theme, views: sh.views || 0, last: sh.last || null };
  };
  const expiresOf = days => {
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw httpError(400, 'Thời hạn không hợp lệ');
    return days ? Date.now() + days * 864e5 : null;
  };
  const passOf = async v => {
    if (v === '' || v == null) return null;
    if (typeof v !== 'string' || v.length < 4 || v.length > 200) throw httpError(400, 'Mật khẩu link cần ít nhất 4 ký tự');
    return hashPassword(v);
  };
  if (parts.length === 2 && req.method === 'GET') return send(res, 200, shares.filter(x => x.uid === uid).sort((a, b) => b.created - a.created).map(view));
  if (parts.length === 2 && req.method === 'POST') {
    const body = await readJsonBody(req) || {};
    if (!getAlbums(uid).some(a => a.id === body.albumId)) throw httpError(404, 'Không tìm thấy album');
    if (shares.filter(x => x.uid === uid).length >= SHARE_MAX) throw httpError(400, `Tối đa ${SHARE_MAX} link chia sẻ`);
    const sh = {
      token: crypto.randomBytes(18).toString('base64url'), uid, albumId: body.albumId, created: Date.now(),
      expires: expiresOf(body.days ?? 0), pass: await passOf(body.password), download: body.download === true,
      theme: SHARE_THEMES.includes(body.theme) ? body.theme : 'cinema', views: 0, last: null,
    };
    shares.push(sh);
    await saveShares();
    return send(res, 201, view(sh));
  }
  const sh = parts.length === 3 ? shares.find(x => x.uid === uid && x.token === parts[2]) : null;
  if (!sh) throw httpError(404, 'Không tìm thấy link');
  if (req.method === 'PATCH') {
    const body = await readJsonBody(req) || {};
    if (body.days !== undefined) sh.expires = expiresOf(body.days);
    if (body.password !== undefined) sh.pass = await passOf(body.password);
    if (typeof body.download === 'boolean') sh.download = body.download;
    if (SHARE_THEMES.includes(body.theme)) sh.theme = body.theme;
    await saveShares();
    return send(res, 200, view(sh));
  }
  if (req.method === 'DELETE') {
    shares = shares.filter(x => x !== sh);
    await saveShares();
    return send(res, 200, { ok: true });
  }
  throw httpError(405, 'Method not allowed');
}

// Video có thể nặng vài GB: ghi thẳng xuống ổ đĩa trong lúc nhận (không giữ trong RAM), tính hash luôn khi ghi
function saveStream(req, dest, limit) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    let size = 0;
    const meter = new Transform({
      transform(chunk, _, cb) {
        size += chunk.length;
        if (size > limit) return cb(httpError(413, `Video quá lớn (tối đa ${Math.round(limit / 1048576)} MB)`));
        hash.update(chunk); cb(null, chunk);
      },
    });
    pipeline(req, meter, fs.createWriteStream(dest), err => {
      if (!err) return resolve({ size, hash: hash.digest('hex') });
      fsp.unlink(dest).catch(() => {});
      reject(err.status ? err : httpError(400, 'Tải lên bị gián đoạn'));
    });
  });
}
async function readHead(file, n = 256) {
  const buf = Buffer.alloc(n), fh = await fsp.open(file, 'r');
  try { const { bytesRead } = await fh.read(buf, 0, n, 0); return buf.subarray(0, bytesRead); } finally { await fh.close(); }
}
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', c => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}
// Thông tin video: ffprobe nếu có, không thì dùng số liệu trình duyệt gửi kèm
async function videoInfo(file, fallback = {}) {
  const info = video.hasFfmpeg ? await video.probe(file).catch(() => null) : null;
  return {
    w: info?.w || fallback.w || 0, h: info?.h || fallback.h || 0,
    duration: info?.duration || fallback.duration || 0, fps: info?.fps || 0,
    taken: info?.taken || fallback.taken || null,
  };
}

async function uploadVideo(req, res, uid) {
  if (Number(req.headers['content-length']) > VIDEO_MAX_SIZE) {
    return send(res, 413, { error: `Video quá lớn (tối đa ${Math.round(VIDEO_MAX_SIZE / 1048576)} MB)` }, { Connection: 'close' });
  }
  await fsp.mkdir(imagesDir(uid), { recursive: true });
  const newId = crypto.randomUUID(), part = path.join(imagesDir(uid), newId + '.part');
  const { size, hash } = await saveStream(req, part, VIDEO_MAX_SIZE);
  const type = size ? video.sniffVideo(await readHead(part)) : null;
  if (!type) {
    await fsp.unlink(part).catch(() => {});
    return send(res, 415, { error: size ? 'Không nhận ra định dạng video' : 'File rỗng' });
  }
  const file = newId + video.VIDEO_TYPES[type];
  await fsp.rename(part, path.join(imagesDir(uid), file));
  const name = decodeHeader(req.headers['x-filename'], 'video' + video.VIDEO_TYPES[type]).slice(0, 200);
  const info = await videoInfo(path.join(imagesDir(uid), file), {
    w: Number(req.headers['x-width']) || 0, h: Number(req.headers['x-height']) || 0,
    duration: Number(req.headers['x-duration']) || 0, taken: Number(req.headers['x-taken']) || null,
  });
  const photo = {
    hash, id: newId, kind: 'video', name, file, url: '/uploads/' + file, type, size,
    w: info.w, h: info.h, duration: info.duration, fps: info.fps, taken: info.taken,
    added: Date.now(), fav: false, public: false,
  };
  const photos = getPhotos(uid);
  photos.push(photo);
  await savePhotos(uid, photos);
  processVideo(uid, photo);
  scheduleMeta();
  return send(res, 201, photoView(photo));
}

// ---------- API: album (của người đang đăng nhập) ----------
function albumView(a, photos) {
  const byId = photoIndex(photos, 'id');
  const ids = a.photoIds.filter(id => byId.has(id));
  const cover = byId.get(ids.includes(a.cover) ? a.cover : ids[0]);
  return { id: a.id, name: a.name, photoIds: ids, cover: cover ? cover.id : null, coverUrl: cover ? cover.url : null, coverThumb: cover ? cover.url + '?s=sm' : null, created: a.created };
}
function albumName(v) {
  const name = typeof v === 'string' ? v.trim().slice(0, 80) : '';
  if (!name) throw httpError(400, 'Hãy đặt tên cho album');
  return name;
}
function ownPhotoIds(v, photos) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw httpError(400, 'Danh sách ảnh không hợp lệ');
  const byId = photoIndex(photos, 'id');
  return v.filter(id => { const p = byId.get(id); return p && !p.trashed; });
}

async function albumsApi(req, res, parts, uid) {
  if (parts.length > 3) throw httpError(404, 'Not found');
  const id = parts[2];
  // Như photosApi: lấy lại getPhotos / getAlbums sau mỗi await (xoá album / ảnh thay mảng bằng mảng mới)

  // GET /api/albums
  if (req.method === 'GET' && !id) {
    // Album tạo từ thư mục trên ổ ngoài: ẩn khi rút ổ (trống)
    const shown = visiblePhotos(uid);
    const albums = getAlbums(uid);
    return send(res, 200, albums.map(a => albumView(a, shown)).filter((v, i) => !(albums[i].link && !v.photoIds.length)));
  }

  // POST /api/albums — { name, photoIds? }
  if (req.method === 'POST' && !id) {
    const body = await readJsonBody(req);
    const photos = getPhotos(uid), albums = getAlbums(uid);
    if (albums.length >= 500) throw httpError(400, 'Đã có quá nhiều album');
    const album = { id: crypto.randomBytes(6).toString('hex'), name: albumName(body.name), photoIds: [...new Set(ownPhotoIds(body.photoIds, photos))], cover: null, created: Date.now() };
    albums.push(album);
    await saveAlbums(uid, albums);
    return send(res, 201, albumView(album, photos));
  }

  const findAlbum = () => getAlbums(uid).find(a => a.id === id);
  let album = findAlbum();
  if (!album) throw httpError(404, 'Không tìm thấy album');

  // PATCH /api/albums/:id — { name?, add?: [...], remove?: [...], cover? }
  if (req.method === 'PATCH') {
    const body = await readJsonBody(req);
    album = findAlbum(); // có thể vừa bị xoá trong lúc đọc body
    if (!album) throw httpError(404, 'Không tìm thấy album');
    const photos = getPhotos(uid);
    if (body.name !== undefined) album.name = albumName(body.name);
    const add = ownPhotoIds(body.add, photos);
    const remove = new Set(ownPhotoIds(body.remove, photos));
    album.photoIds = [...new Set([...album.photoIds, ...add])].filter(x => !remove.has(x));
    if (body.cover !== undefined) album.cover = album.photoIds.includes(body.cover) ? body.cover : null;
    if (remove.has(album.cover)) album.cover = null;
    await saveAlbums(uid, getAlbums(uid));
    return send(res, 200, albumView(album, getPhotos(uid)));
  }

  // DELETE /api/albums/:id — chỉ xoá album, ảnh vẫn còn
  if (req.method === 'DELETE') {
    await saveAlbums(uid, getAlbums(uid).filter(a => a.id !== id));
    if (shares.some(x => x.uid === uid && x.albumId === id)) { shares = shares.filter(x => !(x.uid === uid && x.albumId === id)); await saveShares(); } // link của album cũng mất
    return send(res, 200, { ok: true });
  }

  send(res, 405, { error: 'Method not allowed' });
}

// ---------- Nhập ảnh từ ổ đĩa: chép file vào import/<tên đăng nhập>/ ----------
// Server quét thư mục này mỗi 10 giây, chuyển ảnh vào gallery (thư mục gốc trống lại).
// Thư mục con thành album cùng tên. Ảnh trùng và file không phải ảnh được để riêng cho bạn xem lại.
const DUP_DIR = '_anh-trung', BAD_DIR = '_khong-phai-anh';
const importDir = u => path.join(IMPORT_DIR, u.username);
const importStates = new Map(); // uid -> { busy, pending, imported, duplicates, skipped, last }
const importState = uid => importStates.get(uid) || importStates.set(uid, { busy: false, pending: 0, imported: 0, duplicates: 0, skipped: 0, last: null }).get(uid);
const importStatus = u => ({ folder: importDir(u), ...importState(u.id) });

// Liệt kê file ảnh trong thư mục nhập (kể cả thư mục con), bỏ qua file ẩn và các thư mục _anh-trung, _khong-phai-anh
async function listImportFiles(root, rel = '') {
  const out = [];
  let entries;
  try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || /^(thumbs\.db|desktop\.ini)$/i.test(e.name)) continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) { if (rel || (e.name !== DUP_DIR && e.name !== BAD_DIR)) out.push(...await listImportFiles(root, r)); }
    else if (e.isFile()) out.push(r);
  }
  return out;
}

// Chuyển file sang thư mục khác (khác ổ đĩa thì copy rồi xoá); trùng tên thì thêm số
async function moveFile(src, dest) {
  try { await fsp.rename(src, dest); }
  catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
    await fsp.unlink(src);
  }
}
async function setAside(src, root, dirName, fileName) {
  const dir = path.join(root, dirName);
  await fsp.mkdir(dir, { recursive: true });
  const { name, ext } = path.parse(fileName);
  let dest = path.join(dir, fileName);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${name} (${i})${ext}`);
  await moveFile(src, dest);
}

async function removeEmptyDirs(dir, isRoot = true) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) if (e.isDirectory() && !(isRoot && (e.name === DUP_DIR || e.name === BAD_DIR))) await removeEmptyDirs(path.join(dir, e.name), false);
  if (!isRoot) await fsp.rmdir(dir).catch(() => {}); // chỉ xoá được khi đã trống
}

async function importUser(u) {
  const root = importDir(u), uid = u.id, st = importState(uid);
  await fsp.mkdir(root, { recursive: true });
  const files = await listImportFiles(root);
  st.pending = files.length;
  if (!files.length) return;

  // Ảnh tải lên từ bản cũ chưa có mã hash -> tính một lần để nhận ra ảnh trùng
  const hashes = new Set();
  let changed = 0;
  for (const p of getPhotos(uid)) {
    if (p.link || p.trashed) continue; // ảnh trên ổ ngoài / trong thùng rác: không so trùng
    if (!p.hash && ++changed) p.hash = sha1(await fsp.readFile(path.join(imagesDir(uid), p.file)).catch(() => Buffer.alloc(0)));
    hashes.add(p.hash);
  }

  st.busy = true;
  const before = st.imported;
  const toAlbums = new Map(); // tên album -> [id ảnh]
  try {
    for (const rel of files) {
      if (!users.includes(u)) return; // tài khoản vừa bị xoá
      const src = path.join(root, rel);
      try {
        const stat = await fsp.stat(src);
        // File vừa được ghi trong 3 giây gần đây -> có thể đang chép dở, để lần quét sau
        if (Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs) < 3000 || !stat.size) continue;

        const head = await readHead(src);
        const type = media.sniffType(head) || video.sniffVideo(head);
        const isVideo = !!type && type.startsWith('video/');
        if (!type || stat.size > (isVideo ? VIDEO_MAX_SIZE : IMPORT_MAX_SIZE)) { await setAside(src, root, BAD_DIR, path.basename(rel)); st.skipped++; continue; }

        // Chuyển vào thư mục ảnh. Windows không cho chuyển file đang chép dở -> lỗi thì thử lại lần sau
        const id = crypto.randomUUID(), file = id + (isVideo ? video.VIDEO_TYPES[type] : IMAGE_TYPES[type]), dest = path.join(imagesDir(uid), file);
        await fsp.mkdir(imagesDir(uid), { recursive: true });
        try { await moveFile(src, dest); }
        catch (err) { if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) continue; throw err; }

        const buf = isVideo ? null : await fsp.readFile(dest); // video có thể rất nặng: không đọc cả file vào RAM
        const hash = isVideo ? await hashFile(dest) : sha1(buf);
        if (hashes.has(hash)) {
          await setAside(dest, root, DUP_DIR, path.basename(rel));
          st.duplicates++;
          continue;
        }
        hashes.add(hash);

        let photo;
        if (isVideo) {
          const info = await videoInfo(dest);
          photo = {
            hash, id, kind: 'video', name: path.basename(rel).slice(0, 200), file, url: '/uploads/' + file, type, size: stat.size,
            w: info.w, h: info.h, duration: info.duration, fps: info.fps,
            taken: info.taken || Math.round(stat.mtimeMs), added: Date.now(), fav: false, public: false,
          };
        } else {
          const { w, h } = await media.imageSize(dest);
          photo = {
            hash, id, name: path.basename(rel).slice(0, 200), file, url: '/uploads/' + file, type, size: buf.length, w, h,
            taken: (type === 'image/heic' ? await media.heicDate(dest) : media.exifDate(buf)) || Math.round(stat.mtimeMs), // không có EXIF thì lấy ngày sửa file
            added: Date.now(), fav: false, public: false,
          };
        }
        const list = getPhotos(uid);
        list.push(photo);
        if (++changed % 20 === 0) await savePhotos(uid, list);
        isVideo ? processVideo(uid, photo) : makeThumbs(uid, photo);

        const folder = path.dirname(rel);
        if (folder !== '.') {
          const name = folder.split(path.sep).join(' / ').slice(0, 80);
          if (!toAlbums.has(name)) toAlbums.set(name, []);
          toAlbums.get(name).push(id);
        }
        st.imported++;
      } catch (err) {
        console.error(`Không nhập được ${rel}:`, err.message);
      } finally {
        st.pending = Math.max(0, st.pending - 1);
      }
    }
  } finally {
    if (changed) { await savePhotos(uid, getPhotos(uid)); scheduleMeta(); }
    if (toAlbums.size) {
      const albums = getAlbums(uid);
      for (const [name, ids] of toAlbums) {
        let album = albums.find(a => a.name === name);
        if (!album) albums.push(album = { id: crypto.randomBytes(6).toString('hex'), name, photoIds: [], cover: null, created: Date.now() });
        album.photoIds = [...new Set([...album.photoIds, ...ids])];
      }
      await saveAlbums(uid, albums);
    }
    if (st.imported > before) { st.last = Date.now(); console.log(`Đã nhập ${st.imported - before} ảnh cho ${u.username}`); }
    await removeEmptyDirs(root);
    st.busy = false;
  }
}

let scanning = null;
function scanImports() {
  if (restoring) return Promise.resolve();
  if (!scanning) {
    scanning = (async () => {
      for (const u of [...users]) await importUser(u).catch(err => console.error('Lỗi nhập ảnh:', err.message));
    })().finally(() => { scanning = null; });
  }
  return scanning;
}

// ---------- Thư mục liên kết: xem ảnh/video ngay trên ổ cứng ngoài, không chép vào máy ----------
// storage/links.json: [{ id, uid, name, path, cache: 'drive' | 'local', hidden: [rel...], created }]
// Ảnh trong thư mục liên kết nằm trong photos.json của chủ như ảnh thường, thêm link (id thư mục) và rel (đường dẫn bên trong).
// File gốc không bao giờ bị chép, sửa hay xoá. Ảnh nhỏ và video HLS (bản cache) lưu ở:
//   cache 'drive': <thư mục>/.homelight/cache trên chính ổ đó -> không tốn dung lượng máy
//   cache 'local': storage/users/<id>/thumbs như ảnh thường (~0,4 MB mỗi ảnh; video HLS cỡ bằng video gốc)
// Rút ổ ra: ảnh trong đó tạm ẩn, cắm lại là hiện lại (Windows đổi ký tự ổ, vd. E: thành F:, server tự tìm ra).
const LINKS_FILE = path.join(STORAGE_DIR, 'links.json');
const LINK_DIR = '.homelight';
const LINK_SCAN_MS = 5 * 60 * 1000; // quét lại để thấy ảnh mới thêm / đã xoá trên ổ
const LINK_CHECK_MS = 10 * 1000;    // ổ còn cắm không
const MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|hei[cf]|mp4|m4v|mov|webm|mkv|avi|3gp|mts|m2ts)$/i;
const SKIP_DIRS = /^(\$recycle\.bin|system volume information|recycler|found\.\d+)$/i;

let links = readJson(LINKS_FILE, []);
const saveLinks = () => writeJson(LINKS_FILE, links);
const linkStates = new Map(); // id -> { online, scanning, lastScan, error, resumed }
const linkState = l => linkStates.get(l.id) || linkStates.set(l.id, { online: false, scanning: false, lastScan: null, error: null, resumed: false }).get(l.id);
const linkById = id => links.find(l => l.id === id);
const linkOnline = id => { const l = linkById(id); return !!l && linkState(l).online; };
const isOffline = p => !!p.link && !linkOnline(p.link);
const isDir = p => fsp.stat(p).then(s => s.isDirectory(), () => false);
// Windows không phân biệt hoa thường trong đường dẫn
const normPath = p => process.platform === 'win32' ? p.toLowerCase() : p;
const within = (p, dir) => { const a = normPath(p), b = normPath(dir); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); };
// Thư mục có đọc được không; máy không phải Windows thì ghi nhớ luôn mã thiết bị (để biết thư mục nào cùng ổ)
async function linkThere(l) {
  const st = await fsp.stat(l.path).catch(() => null);
  if (st && process.platform !== 'win32') linkState(l).dev = st.dev;
  return !!st && st.isDirectory();
}
for (const l of links) {
  try {
    const st = fs.statSync(l.path);
    linkState(l).online = st.isDirectory();
    if (process.platform !== 'win32') linkState(l).dev = st.dev;
  } catch {}
}

// Mỗi ổ chỉ làm một việc nặng (ảnh nhỏ, ảnh bìa, chuyển đổi video) một lúc: ổ cứng gắn ngoài bị đọc/ghi
// nhiều luồng cùng lúc thì chậm hẳn đi và rất nóng. Việc nào đọc/ghi ổ cũng giữ "chỗ" của ổ đó trong lúc làm.
// Các thư mục trên cùng ổ dùng chung một chỗ: Windows theo ký tự ổ ("d:\"), máy khác theo mã thiết bị
const driveOf = l => process.platform === 'win32' ? normPath(path.parse(l.path).root)
  : linkState(l).dev != null ? 'dev:' + linkState(l).dev : l.path;
const driveLanes = new Map(); // ổ -> { active, idle: [resolve] }
const cancelled = () => Object.assign(new Error('Đã huỷ'), { cancelled: true });
function driveLane(l) {
  const key = driveOf(l);
  return driveLanes.get(key) || driveLanes.set(key, { active: 0, idle: [] }).get(key);
}
// Giữ chỗ của ổ; trả về hàm nhả chỗ. Ổ rảnh lại: báo các hàng đợi lấy việc tiếp
function takeDrive(lane) {
  lane.active++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--lane.active) return;
    lane.idle.splice(0).forEach(f => f());
    media.pump(); video.pump();
  };
}
// Việc nhẹ của server (đọc danh sách thư mục, đầu file, ffprobe, dọn HLS thừa): làm ngay, không chờ việc nặng,
// để ảnh hiện dần trong gallery cả khi ổ đang chuyển đổi một video dài; vẫn giữ chỗ để việc nặng mới không chen vào
function onDrive(l, fn) {
  const release = takeDrive(driveLane(l));
  return Promise.resolve().then(() => { if (!linkState(l).online) throw cancelled(); return fn(); }).finally(release);
}
// Cho hàng đợi chung (ảnh nhỏ, ảnh bìa, HLS): chỉ lấy việc khi ổ của việc đó đang rảnh, nên một ổ đang bận
// không làm tắc việc của ổ khác. ok() sai (ổ bị rút / ngắt, hoặc cắm lại với ký tự khác) thì việc bị huỷ
function driveSlot(l) {
  const key = driveOf(l), lane = driveLane(l);
  return { free: () => !lane.active, take: () => takeDrive(lane), ok: () => linkState(l).online && driveOf(l) === key };
}
// Dừng mọi việc của thư mục liên kết (whole: của mọi thư mục trên cùng ổ): ngoại tuyến, huỷ ffmpeg đang chạy,
// đóng các file đang gửi cho người xem. whole thì chờ việc đang dở (vd. một ảnh nhỏ) xong, để ổ không còn file nào mở
async function stopDrive(l, whole = true) {
  const same = whole ? links.filter(x => driveOf(x) === driveOf(l)) : [l];
  const ids = new Set(same.map(x => x.id)), dirs = same.map(x => x.path);
  for (const x of same) Object.assign(linkState(x), { online: false, resumed: false });
  const closing = [...openReads].filter(s => dirs.some(d => within(String(s.path), d)))
    .map(s => new Promise(resolve => { s.once('close', resolve); s.destroy(); }));
  await Promise.all([...videoLevel].filter(([, j]) => ids.has(j.photo.link)).map(([key]) => video.cancel(key)));
  await Promise.all(closing);
  const lane = driveLane(l);
  if (whole && lane.active) await new Promise(resolve => lane.idle.push(resolve));
  return [...ids];
}
// Không đọc được thư mục liên kết: rút cả ổ thì dừng mọi việc trên ổ; ổ vẫn còn (thư mục bị đổi tên / xoá)
// thì chỉ dừng thư mục đó, các thư mục khác trên ổ vẫn chạy
async function linkGone(l) {
  const others = links.filter(x => x !== l && driveOf(x) === driveOf(l));
  const driveThere = process.platform === 'win32' ? await isDir(path.parse(l.path).root)
    : (await Promise.all(others.map(x => isDir(x.path)))).some(Boolean);
  return stopDrive(l, !driveThere);
}

function originalPath(uid, p) {
  const l = p.link && linkById(p.link);
  return l ? path.join(l.path, p.rel) : path.join(imagesDir(uid), p.file);
}
function cacheDir(uid, p) {
  const l = p.link && linkById(p.link);
  return l && l.cache === 'drive' ? path.join(l.path, LINK_DIR, 'cache') : thumbsDir(uid);
}
// Ảnh để hiện: bỏ ảnh của ổ đang rút ra
const visiblePhotos = uid => getPhotos(uid).filter(p => !p.trashed && !isOffline(p)); // (bỏ cả ảnh trong thùng rác)
const OFFLINE_MSG = 'Ổ đĩa chứa ảnh này đang không cắm vào máy chủ';
function serveOriginal(res, uid, photo, cache) {
  if (isOffline(photo)) return send(res, 503, OFFLINE_MSG);
  return serveFile(res, originalPath(uid, photo), cache);
}

// Liệt kê ảnh/video (kể cả thư mục con). Ổ bị rút giữa chừng -> ném lỗi, để không tưởng nhầm là ảnh đã bị xoá.
// gate: đọc từng thư mục khi tới lượt dùng ổ (không giữ ổ suốt lần quét), ổ bị ngắt thì dừng ở thư mục kế tiếp
async function walkLink(root, gate = fn => fn(), rel = '', out = new Map()) {
  const dirs = [];
  await gate(async () => {
    let entries;
    try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); }
    catch (err) {
      if (rel && (err.code === 'EPERM' || err.code === 'EACCES')) return; // thư mục hệ thống không cho đọc
      throw err;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.test(e.name) || e.name === backup.BACKUP_DIR) continue; // thư mục sao lưu của gallery
      const r = rel ? path.join(rel, e.name) : e.name, full = path.join(root, r);
      if (e.isDirectory()) { if (!within(full, ROOT) && !within(full, IMPORT_DIR)) dirs.push(r); }
      else if (e.isFile() && MEDIA_EXT.test(e.name)) {
        try { out.set(r, await fsp.stat(full)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      }
    }
  });
  for (const r of dirs) await walkLink(root, gate, r, out);
  return out;
}

// Đọc thông tin một file trên ổ ngoài; không phải ảnh/video thì trả về null
async function linkedPhoto(l, rel, stat) {
  const src = path.join(l.path, rel);
  const head = await readHead(src, 256 * 1024); // đủ để đọc EXIF, không đọc cả file
  const type = media.sniffType(head) || video.sniffVideo(head);
  if (!type) return null;
  const isVideo = type.startsWith('video/'), id = crypto.randomUUID(), mtime = Math.round(stat.mtimeMs);
  // Tên file trong URL có thêm thời điểm sửa: file trên ổ bị thay thì URL đổi, trình duyệt không dùng bản cache cũ
  const file = `${id}.${mtime.toString(36)}${isVideo ? video.VIDEO_TYPES[type] : IMAGE_TYPES[type]}`;
  const base = {
    id, link: l.id, rel, name: path.basename(rel).slice(0, 200), file, url: '/uploads/' + file, type, size: stat.size, mtime,
    added: Date.now(), fav: false, public: false,
  };
  if (isVideo) {
    const info = await videoInfo(src);
    return { ...base, kind: 'video', w: info.w, h: info.h, duration: info.duration, fps: info.fps, taken: info.taken || mtime };
  }
  const { w, h } = await media.imageSize(src);
  return { ...base, w, h, taken: (type === 'image/heic' ? await media.heicDate(src) : media.exifDate(head)) || mtime };
}

// Bỏ ảnh khỏi gallery (file trên ổ đã bị xoá, hoặc gỡ liên kết); file gốc không bị đụng tới
async function forgetPhotos(uid, gone, keepCache = false) {
  if (!gone.length) return;
  const ids = new Set(gone.map(p => p.id));
  await savePhotos(uid, getPhotos(uid).filter(p => !ids.has(p.id)));
  const albums = getAlbums(uid);
  let changed = false;
  for (const a of albums) {
    const n = a.photoIds.length;
    a.photoIds = a.photoIds.filter(x => !ids.has(x));
    if (a.photoIds.length !== n || ids.has(a.cover)) { changed = true; if (ids.has(a.cover)) a.cover = null; }
  }
  if (changed) await saveAlbums(uid, albums.filter(a => !(a.link && !a.photoIds.length))); // album tự tạo từ thư mục mà trống thì bỏ
  for (const p of gone) keepCache ? await video.cancel(uid + '/' + p.id) : await dropThumbs(uid, p);
}

async function hideLinked(photo) {
  const l = linkById(photo.link);
  if (!l) return;
  l.hidden = [...new Set([...(l.hidden || []), photo.rel])];
  await saveLinks();
}

async function scanLink(l) {
  const st = linkState(l), u = users.find(x => x.id === l.uid);
  if (!u) return;
  if (st.scanning) { st.again = true; return; } // quét xong lần đang chạy thì quét lại (vd. vừa cắm lại ổ)
  st.scanning = true;
  st.again = false;
  const uid = u.id, toAlbums = new Map();
  let changed = 0;
  try {
    let found;
    try { found = await walkLink(l.path, fn => onDrive(l, fn)); }
    catch (err) {
      if (err.cancelled) return; // ổ bị rút / được ngắt giữa lúc quét
      st.error = err.code === 'ENOENT' ? null : err.message;
      if (st.online) console.log(`Không đọc được "${l.name}" (${l.path}): ${err.message}`);
      await linkGone(l);
      return;
    }
    if (!st.online) return; // vừa bị ngắt / rút ra ngay khi quét xong
    st.error = null;
    const mine = new Map(getPhotos(uid).filter(p => p.link === l.id).map(p => [p.rel, p]));
    // Ổ bỗng trống trơn (vd. cắm ổ khác vào cùng ký tự E:) -> không xoá gì, chờ lần sau
    if (found.size || !mine.size) {
      await forgetPhotos(uid, [...mine.values()].filter(p => !found.has(p.rel)));
      const hidden = (l.hidden || []).filter(r => found.has(r));
      if (hidden.length !== (l.hidden || []).length) { l.hidden = hidden; await saveLinks(); }
    }
    const hidden = new Set(l.hidden || []);
    for (const [rel, stat] of found) {
      if (!linkById(l.id) || !users.includes(u) || !st.online) return; // vừa gỡ liên kết / xoá tài khoản / rút ổ
      const old = mine.get(rel);
      if (hidden.has(rel) || (old && old.size === stat.size && old.mtime === Math.round(stat.mtimeMs))) continue;
      const skipKey = `${l.id}|${rel}|${stat.size}|${Math.round(stat.mtimeMs)}`;
      if (notMedia.has(skipKey)) continue;
      let p;
      try { p = await onDrive(l, () => linkedPhoto(l, rel, stat)); }
      catch (err) {
        if (err.cancelled || !await linkReachable(l.id)) return; // ổ bị rút: không thử từng file còn lại
        console.error(`Không đọc được ${rel}:`, err.message);
        continue;
      }
      if (!p) { notMedia.add(skipKey); continue; }
      if (old) {
        // File bị thay bằng bản khác: giữ id, yêu thích, công khai, album; làm lại ảnh nhỏ / HLS
        await dropThumbs(uid, old);
        thumbFailed.delete(uid + '/' + old.id);
        for (const k of ['hls', 'vfail', 'color', 'exif', 'place', 'dhash']) delete old[k];
        const { id, added, fav, public: pub, name, ...fresh } = p;
        Object.assign(old, fresh, { file: old.id + fresh.file.slice(id.length), url: '/uploads/' + old.id + fresh.file.slice(id.length) });
        indexes.delete(getPhotos(uid)); // tên file đổi
        p = old;
      } else {
        getPhotos(uid).push(p);
        const folder = path.dirname(rel);
        if (folder !== '.') {
          const name = folder.split(path.sep).join(' / ').slice(0, 80);
          if (!toAlbums.has(name)) toAlbums.set(name, []);
          toAlbums.get(name).push(p.id);
        }
      }
      if (++changed % 50 === 0) await savePhotos(uid, getPhotos(uid)); // ảnh hiện dần trong lúc quét ổ lớn
      p.kind === 'video' ? processVideo(uid, p) : makeThumbs(uid, p);
    }
    // Vừa cắm lại / vừa khởi động: làm tiếp ảnh nhỏ và video còn dở
    if (!st.resumed) {
      st.resumed = true;
      for (const p of getPhotos(uid)) {
        if (!st.online) break;
        if (p.link !== l.id) continue;
        if (p.kind === 'video') {
          try { await onDrive(l, () => pruneHls(uid, p)); } catch { break; } // ổ bị rút / ngắt giữa chừng
          processVideo(uid, p);
        }
        else if (media.hasSharp && (!p.color || await missingThumbs(uid, p))) makeThumbs(uid, p);
      }
      scheduleMeta(); // thông tin chụp của ảnh trên ổ (đọc khi ổ đang cắm)
    }
  } finally {
    if (changed) { await savePhotos(uid, getPhotos(uid)); scheduleMeta(); }
    if (toAlbums.size) {
      const albums = getAlbums(uid);
      for (const [name, ids] of toAlbums) {
        let album = albums.find(a => a.name === name);
        if (!album) albums.push(album = { id: crypto.randomBytes(6).toString('hex'), name, photoIds: [], cover: null, created: Date.now(), link: l.id });
        album.photoIds = [...new Set([...album.photoIds, ...ids])];
      }
      await saveAlbums(uid, albums);
    }
    if (changed) console.log(`"${l.name}": cập nhật ${changed} ảnh/video từ ${l.path}`);
    st.scanning = false;
    if (st.again && st.online) setImmediate(() => scanLink(l));
    st.lastScan = Date.now();
  }
}
// Thiếu cỡ ảnh nhỏ nào không (kiểm tra không chặn server, ổ ngoài có thể có hàng chục nghìn ảnh)
async function missingThumbs(uid, p) {
  for (const s of Object.keys(media.SIZES)) if (!await fileExists(media.variantPath(cacheDir(uid, p), p.id, s))) return true;
  return false;
}
const notMedia = new Set(); // file có đuôi ảnh nhưng không phải ảnh: không đọc lại mỗi lần quét

let linkScanning = null;
function scanLinks() {
  if (restoring) return Promise.resolve();
  if (!linkScanning) {
    linkScanning = (async () => { for (const l of [...links]) if (linkState(l).online) await scanLink(l).catch(err => console.error('Lỗi quét thư mục liên kết:', err.message)); })()
      .finally(() => { linkScanning = null; });
  }
  return linkScanning;
}

// Ký tự các ổ đang cắm (dò một lần mỗi lượt kiểm tra, không dò lại cho từng thư mục)
async function driveLetters() {
  const out = [];
  for (const d of 'DEFGHIJKLMNOPQRSTUVWXYZ') if (await isDir(d + ':\\')) out.push(d);
  return out;
}
// Windows có thể gán ký tự khác khi cắm lại ổ (E: -> F:): tìm dấu .homelight/link.json trên các ổ khác
async function relocate(l, letters = driveLetters) {
  if (process.platform !== 'win32' || l.cache !== 'drive' || !/^[a-z]:\\/i.test(l.path)) return false;
  for (const d of await letters()) {
    const cand = d + l.path.slice(1);
    if (normPath(cand) === normPath(l.path)) continue;
    const mark = await fsp.readFile(path.join(cand, LINK_DIR, 'link.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (mark && mark.id === l.id) {
      console.log(`"${l.name}" đã chuyển từ ${l.path} sang ${cand}`);
      l.path = cand;
      await saveLinks();
      return true;
    }
  }
  return false;
}

// Ổ còn cắm không: mỗi 10 giây, và ngay khi đọc/ghi trên ổ bị lỗi. Rút ra thì dừng mọi việc trên ổ đó
let checking = null;
function checkLinks() {
  if (restoring) return Promise.resolve();
  return checking ||= (async () => {
    let letters = null;
    const getLetters = () => (letters ||= driveLetters());
    for (const l of [...links]) {
      const st = linkState(l), was = st.online;
      if (st.ejected) { if (!await isDir(l.path)) st.ejected = false; continue; } // đã ngắt: chờ rút ổ, hoặc bấm "Kết nối lại"
      const on = await linkThere(l) || await relocate(l, getLetters);
      if (on && !was) { console.log(`Đã cắm ổ chứa "${l.name}" (${l.path})`); st.online = true; scanLink(l); }
      else if (!on && was) { console.log(`Không thấy "${l.name}" (${l.path}), ổ đã rút ra?: tạm ẩn ảnh, dừng mọi việc trên đó`); await linkGone(l); }
    }
  })().finally(() => { checking = null; });
}
// Đã ngắt ổ: mỗi giây xem ổ đã rút ra chưa, để rút rồi cắm lại ngay (trong 10 giây) vẫn được nhận lại
let ejectTimer = null;
function watchEjected() {
  if (ejectTimer) return;
  ejectTimer = setInterval(async () => {
    const ejected = links.filter(l => linkState(l).ejected);
    if (!ejected.length) { clearInterval(ejectTimer); ejectTimer = null; return; }
    for (const l of ejected) if (!await isDir(l.path)) linkState(l).ejected = false;
  }, 1000);
  ejectTimer.unref();
}
// Đọc/ghi trên ổ ngoài bị lỗi: ổ còn không? Không còn thì dừng ngay, không chờ lần kiểm tra 10 giây
async function linkReachable(id) {
  const l = linkById(id);
  if (!l) return false;
  if (await isDir(l.path)) return true;
  await checkLinks();
  return false;
}

// Ghi dấu và thư mục cache lên ổ ngoài; ổ chỉ đọc được -> trả về false (dùng cache trên máy)
async function prepareDriveCache(l) {
  const dir = path.join(l.path, LINK_DIR);
  try {
    await fsp.mkdir(path.join(dir, 'cache'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'link.json'), JSON.stringify({ id: l.id, name: l.name, created: l.created }));
    await fsp.writeFile(path.join(dir, 'README.txt'),
      'Thư mục này do gallery tạo: ảnh nhỏ và video đã chuyển đổi của các ảnh trong ổ này,\r\n' +
      'để xem nhanh qua mạng mà không tốn dung lượng máy tính. Ảnh gốc của bạn không bị thay đổi.\r\n' +
      'Xoá thư mục này cũng không sao: gallery sẽ tạo lại khi cần.\r\n');
    if (process.platform === 'win32') require('child_process').execFile('attrib', ['+h', dir], () => {}); // ẩn trong Explorer
    return true;
  } catch { return false; }
}

async function validLinkPath(v) {
  let p = typeof v === 'string' ? v.trim().replace(/^"(.*)"$/, '$1') : ''; // "Copy as path" của Windows có dấu ngoặc kép
  if (!p) throw httpError(400, 'Hãy chọn thư mục');
  if (/^[a-z]:$/i.test(p)) p += '\\';
  if (!path.isAbsolute(p)) throw httpError(400, 'Cần đường dẫn đầy đủ, vd. E:\\Anh');
  p = path.resolve(p);
  if (!await isDir(p)) throw httpError(400, 'Không tìm thấy thư mục này (ổ đã cắm chưa?)');
  if (within(p, ROOT) || within(p, IMPORT_DIR)) throw httpError(400, 'Đây là thư mục của chính gallery');
  const bdir = backupConf().dir;
  if (bdir && within(p, backup.rootOf(bdir))) throw httpError(400, 'Đây là thư mục sao lưu của gallery');
  return p;
}

function linkView(l) {
  const st = linkState(l), owner = users.find(u => u.id === l.uid);
  let photos = 0, videos = 0;
  for (const p of owner ? getPhotos(owner.id) : []) if (p.link === l.id) p.kind === 'video' ? videos++ : photos++;
  return {
    id: l.id, name: l.name, path: l.path, cache: l.cache, uid: l.uid, owner: owner ? owner.username : null,
    online: st.online, ejected: !!st.ejected, scanning: st.scanning, lastScan: st.lastScan, error: st.error,
    photos, videos, hidden: (l.hidden || []).length, created: l.created,
  };
}

async function removeLink(l) {
  links = links.filter(x => x !== l); // trước tiên: lần quét đang chạy (nếu có) tự dừng
  linkStates.delete(l.id);
  await saveLinks();
  const u = users.find(x => x.id === l.uid);
  // Cache trên máy: xoá từng ảnh nhỏ; cache trên ổ: xoá cả thư mục .homelight (nếu ổ đang cắm)
  if (u) await forgetPhotos(u.id, getPhotos(u.id).filter(p => p.link === l.id), l.cache === 'drive');
  if (l.cache === 'drive') await fsp.rm(path.join(l.path, LINK_DIR), { recursive: true, force: true }).catch(() => {});
}

// Duyệt thư mục trên máy chủ để chọn (chỉ quản trị viên): không có path -> danh sách ổ đĩa
async function browseDirs(p) {
  if (!p) {
    const roots = process.platform === 'win32'
      ? [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(d => d + ':\\')
      : ['/', '/media', '/mnt', '/Volumes', os.homedir()];
    const dirs = [];
    for (const r of roots) if (await isDir(r)) dirs.push({ name: r, path: r });
    return { path: '', parent: null, dirs, media: 0 };
  }
  const dir = path.resolve(String(p));
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { throw httpError(400, 'Không mở được thư mục này'); }
  const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$') && !SKIP_DIRS.test(e.name))
    .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }));
  const parent = path.dirname(dir) === dir ? '' : path.dirname(dir);
  return { path: dir, parent, dirs, media: entries.filter(e => e.isFile() && MEDIA_EXT.test(e.name)).length };
}

// /api/links — xem: chủ thư mục và quản trị viên; thêm / sửa / gỡ: chỉ quản trị viên (vì đọc được ổ đĩa của máy chủ)
async function linksApi(req, res, parts, url, me) {
  const isAdmin = me.role === 'admin', id = parts[2];
  const needAdmin = () => { if (!isAdmin) throw httpError(403, 'Chỉ quản trị viên mới làm được'); };
  if (!id && req.method === 'GET') return send(res, 200, links.filter(l => isAdmin || l.uid === me.id).map(linkView));

  // GET /api/links/browse?path=E:\ — các thư mục con để chọn
  if (id === 'browse' && parts.length === 3 && req.method === 'GET') { needAdmin(); return send(res, 200, await browseDirs(url.searchParams.get('path'))); }

  // POST /api/links — { path, name?, uid?, cache?: 'drive' | 'local' }
  if (!id && req.method === 'POST') {
    needAdmin();
    const body = await readJsonBody(req);
    const p = await validLinkPath(body.path);
    const owner = users.find(u => u.id === (body.uid || me.id));
    if (!owner) throw httpError(400, 'Không tìm thấy tài khoản');
    const clash = links.find(l => l.uid === owner.id && (within(p, l.path) || within(l.path, p)));
    if (clash) throw httpError(409, `Trùng với thư mục đã liên kết "${clash.name}" (${clash.path})`);
    const name = (typeof body.name === 'string' && body.name.trim() ? body.name.trim() : path.basename(p) || p).slice(0, 80);
    const l = { id: crypto.randomBytes(6).toString('hex'), uid: owner.id, name, path: p, cache: 'local', hidden: [], created: Date.now() };
    let note = null;
    if (body.cache !== 'local') {
      if (await prepareDriveCache(l)) l.cache = 'drive';
      else note = 'Không ghi được lên ổ này (ổ chỉ đọc?), ảnh nhỏ sẽ lưu trên máy chủ';
    }
    links.push(l);
    await saveLinks();
    linkState(l).online = true;
    scanLink(l);
    return send(res, 201, { ...linkView(l), scanning: true, note });
  }

  const l = linkById(id);
  if (!l || (!isAdmin && l.uid !== me.id)) throw httpError(404, 'Không tìm thấy thư mục liên kết');

  // POST /api/links/:id/scan — quét lại ngay (sau khi ngắt ổ: kết nối lại mọi thư mục trên ổ đó)
  if (parts[3] === 'scan' && parts.length === 4 && req.method === 'POST') {
    const same = linkState(l).ejected ? links.filter(x => driveOf(x) === driveOf(l)) : [l];
    for (const x of same) {
      linkState(x).ejected = false;
      if (await linkThere(x) || await relocate(x)) { linkState(x).online = true; scanLink(x); }
      else await linkGone(x); // dừng việc còn dở; cắm lại thì làm tiếp
    }
    return send(res, 200, linkView(l));
  }

  // POST /api/links/:id/eject — ngắt ổ an toàn: dừng mọi việc và đóng mọi file trên ổ chứa thư mục này,
  // để "Safely Remove" của Windows làm được. Rút ổ ra rồi cắm lại, hoặc bấm "Kết nối lại" là dùng tiếp
  if (parts[3] === 'eject' && parts.length === 4 && req.method === 'POST') {
    for (const x of links) if (driveOf(x) === driveOf(l)) linkState(x).ejected = true;
    watchEjected();
    const ids = await stopDrive(l);
    console.log(`Đã ngắt ổ ${path.parse(l.path).root} (${ids.length} thư mục liên kết), có thể rút ổ ra`);
    return send(res, 200, { ...linkView(l), drive: path.parse(l.path).root, links: ids.length });
  }
  if (parts.length > 3) throw httpError(404, 'Not found');

  // PATCH /api/links/:id — { name?, path? } (đổi path khi ổ có ký tự khác, ảnh vẫn giữ nguyên)
  if (req.method === 'PATCH') {
    needAdmin();
    const body = await readJsonBody(req);
    if (typeof body.name === 'string' && body.name.trim()) l.name = body.name.trim().slice(0, 80);
    if (body.path !== undefined) {
      const p = await validLinkPath(body.path);
      const clash = links.find(x => x !== l && x.uid === l.uid && (within(p, x.path) || within(x.path, p)));
      if (clash) throw httpError(409, `Trùng với thư mục đã liên kết "${clash.name}"`);
      l.path = p;
      Object.assign(linkState(l), { online: true, resumed: false, ejected: false });
      if (l.cache === 'drive') await prepareDriveCache(l);
    }
    await saveLinks();
    if (body.path !== undefined) scanLink(l);
    return send(res, 200, linkView(l));
  }

  // DELETE /api/links/:id — gỡ liên kết: ảnh biến khỏi gallery, file trên ổ vẫn nguyên
  if (req.method === 'DELETE') {
    needAdmin();
    await removeLink(l);
    return send(res, 200, { ok: true });
  }
  throw httpError(405, 'Method not allowed');
}

// ---------- Sao lưu tự động + khôi phục (xem backup.js), chỉ quản trị viên ----------
// settings.backup: { dir, freq: 'off' | 'daily' | 'weekly', hour: 0–23, keep: số bản giữ lại, last: { at, ok, error?, ... } }
const BACKUP_FREQS = ['off', 'daily', 'weekly'];
const backupConf = () => ({ dir: '', freq: 'off', hour: 3, keep: 10, last: null, ...settings.backup });
const backupJob = { promise: null, progress: {}, reason: null };
let restoring = false; // đang khôi phục: chặn mọi thay đổi khác

// Chụp toàn bộ dữ liệu ngay lúc gọi (đồng bộ): các file trong một bản sao lưu luôn khớp nhau
function stateNow() {
  const clone = v => JSON.parse(JSON.stringify(v));
  const photos = {}, albums = {};
  for (const u of users) { photos[u.id] = clone(getPhotos(u.id)); albums[u.id] = clone(getAlbums(u.id)); }
  const { backup: _b, ...rest } = settings;
  return { users: clone(users), links: clone(links), shares: clone(shares), settings: clone(rest), photos, albums };
}

function startBackup(reason = 'manual') {
  if (backupJob.promise) return backupJob.promise;
  const conf = backupConf();
  if (!conf.dir) return Promise.reject(httpError(400, 'Hãy chọn thư mục sao lưu'));
  const state = stateNow(), t0 = Date.now();
  backupJob.progress = { phase: 'start' };
  backupJob.reason = reason;
  backupJob.promise = (async () => {
    try {
      if (!await isDir(conf.dir)) throw new Error('Không thấy thư mục sao lưu (ổ đã cắm chưa?)');
      const r = await backup.run(conf.dir, state, { originalOf: (uid, p) => path.join(imagesDir(uid), p.file), keep: conf.keep, reason, progress: backupJob.progress });
      settings.backup = { ...backupConf(), last: { at: t0, ok: true, id: r.id, photos: r.photos, copied: r.copied, copiedBytes: r.copiedBytes, missing: r.missing, ms: Date.now() - t0 } };
      console.log(`Sao lưu xong (${r.id}): ${r.photos} ảnh/video, chép thêm ${r.copied} file (${(r.copiedBytes / 1048576).toFixed(1)} MB) vào ${backup.rootOf(conf.dir)}`);
      return r;
    } catch (err) {
      settings.backup = { ...backupConf(), last: { at: t0, ok: false, error: err.message } };
      console.error('Sao lưu lỗi:', err.message);
      throw err;
    } finally {
      await saveSettings();
      backupJob.promise = null;
    }
  })();
  backupJob.promise.catch(() => {});
  return backupJob.promise;
}

// Lịch: kiểm tra mỗi 5 phút; máy tắt đúng giờ hẹn thì sao lưu ngay khi bật lại. Lỗi (vd. chưa cắm ổ) thì 1 giờ sau thử lại
function backupDue() {
  const c = backupConf();
  if (c.freq === 'off' || !c.dir || backupJob.promise || restoring) return false;
  const last = c.last ? c.last.at : 0;
  if (last >= backup.lastSlot(c.freq, c.hour)) return false;
  return !(c.last && !c.last.ok && Date.now() - last < 3600 * 1000);
}

async function validBackupDir(v) {
  let p = typeof v === 'string' ? v.trim().replace(/^"(.*)"$/, '$1') : '';
  if (!p) return '';
  if (/^[a-z]:$/i.test(p)) p += '\\';
  if (!path.isAbsolute(p)) throw httpError(400, 'Cần đường dẫn đầy đủ, vd. E:\\Anh');
  p = path.resolve(p);
  if (!await isDir(p)) throw httpError(400, 'Không tìm thấy thư mục này (ổ đã cắm chưa?)');
  if (within(p, ROOT) || within(p, IMPORT_DIR)) throw httpError(400, 'Đây là thư mục của chính gallery');
  const l = links.find(x => within(p, x.path));
  if (l) throw httpError(400, `Thư mục này nằm trong thư mục liên kết "${l.name}", hãy chọn chỗ khác`);
  return p;
}

// Khôi phục: sao lưu dữ liệu hiện tại trước (để còn quay lại được), chép lại file gốc còn thiếu,
// rồi thay toàn bộ danh sách ảnh, album, tài khoản, thư mục liên kết, link chia sẻ bằng bản đã chọn.
// Giữ nguyên: cổng, cài đặt sao lưu, phiên đăng nhập (phiên của tài khoản không còn tự hết hiệu lực)
async function restoreBackup(id) {
  const conf = backupConf();
  if (!conf.dir) throw httpError(400, 'Hãy chọn thư mục sao lưu');
  let snap;
  try { snap = await backup.readSnapshot(conf.dir, id); } catch (err) { throw httpError(400, err.message); }
  if (!snap.users.some(u => u.role === 'admin')) throw httpError(400, 'Bản sao lưu không có tài khoản quản trị');
  if (restoring) throw httpError(409, 'Đang khôi phục, đợi chút nhé');
  restoring = true;
  try {
    await Promise.all([scanning, linkScanning, checking].filter(Boolean).map(p => p.catch(() => {})));
    if (backupJob.promise) await backupJob.promise.catch(() => {});
    try { await startBackup('before-restore'); }
    catch (err) { throw httpError(500, 'Không sao lưu được dữ liệu hiện tại trước khi khôi phục: ' + err.message); }
    // Dừng video đang chuyển đổi (object ảnh cũ sắp bị thay)
    await Promise.all([...videoLevel.keys()].map(k => video.cancel(k)));
    for (let i = 0; i < 100 && videoJobs.size; i++) await new Promise(r => setTimeout(r, 200));
    backupJob.progress = {};
    const files = await backup.restoreFiles(conf.dir, snap, (uid, p) => path.join(imagesDir(uid), p.file), backupJob.progress);

    const keep = { port: settings.port, backup: settings.backup };
    settings = { ...snap.settings, ...keep };
    if (keep.port === undefined) delete settings.port;
    videoMode = VIDEO_MODES.includes(settings.videoMode) ? settings.videoMode : 'lite';
    users = snap.users;
    links = snap.links;
    shares = Array.isArray(snap.shares) ? snap.shares : [];
    ensureSecret();
    photoCache.clear(); albumCache.clear(); linkStates.clear(); thumbFailed.clear(); notMedia.clear(); importStates.clear();
    for (const u of users) {
      await fsp.mkdir(imagesDir(u.id), { recursive: true });
      await savePhotos(u.id, snap.photos[u.id] || []);
      await saveAlbums(u.id, snap.albums[u.id] || []);
    }
    await Promise.all([saveUsers(), saveLinks(), saveSettings(), saveShares()]);
    for (const l of links) await linkThere(l).then(on => { linkState(l).online = on; });
    console.log(`Đã khôi phục bản sao lưu ${id}: ${users.length} tài khoản, chép lại ${files.copied} file gốc` + (files.missing ? `, thiếu ${files.missing} file` : ''));
    return { id, users: users.length, copied: files.copied, missing: files.missing };
  } finally {
    restoring = false;
    resumeWork();
  }
}

async function backupApi(req, res, parts, me) {
  if (me.role !== 'admin') throw httpError(403, 'Chỉ quản trị viên mới làm được');
  const view = async () => {
    const c = backupConf(), reachable = !!c.dir && await isDir(c.dir);
    let linked = 0;
    for (const u of users) for (const p of getPhotos(u.id)) if (p.link) linked++;
    return {
      dir: c.dir, root: c.dir ? backup.rootOf(c.dir) : null, freq: c.freq, hour: c.hour, keep: c.keep, last: c.last,
      reachable, running: !!backupJob.promise, reason: backupJob.reason, restoring, progress: backupJob.progress,
      next: c.freq !== 'off' && c.dir ? nextBackupAt(c) : null, linked,
      snapshots: reachable ? await backup.listSnapshots(c.dir) : [],
    };
  };
  if (parts.length === 2 && req.method === 'GET') return send(res, 200, await view());

  // PUT /api/backup { dir?, freq?, hour?, keep? }
  if (parts.length === 2 && req.method === 'PUT') {
    const body = await readJsonBody(req) || {};
    const c = backupConf(), next = { ...c };
    if (body.dir !== undefined) next.dir = await validBackupDir(body.dir);
    if (body.freq !== undefined) { if (!BACKUP_FREQS.includes(body.freq)) throw httpError(400, 'Tuỳ chọn không hợp lệ'); next.freq = body.freq; }
    if (body.hour !== undefined) { if (!Number.isInteger(body.hour) || body.hour < 0 || body.hour > 23) throw httpError(400, 'Tuỳ chọn không hợp lệ'); next.hour = body.hour; }
    if (body.keep !== undefined) { if (!Number.isInteger(body.keep) || body.keep < 1 || body.keep > 100) throw httpError(400, 'Số bản giữ lại từ 1 đến 100'); next.keep = body.keep; }
    if (next.dir !== c.dir) next.last = null; // thư mục mới: sao lưu lần đầu theo lịch
    settings.backup = { ...backupConf(), ...next };
    await saveSettings();
    return send(res, 200, await view());
  }
  // POST /api/backup/run — sao lưu ngay (chạy nền, trang hỏi lại tiến độ)
  if (parts[2] === 'run' && parts.length === 3 && req.method === 'POST') {
    if (restoring) throw httpError(409, 'Đang khôi phục, đợi chút nhé');
    startBackup('manual').catch(() => {});
    return send(res, 200, await view());
  }
  // POST /api/backup/restore { id }
  if (parts[2] === 'restore' && parts.length === 3 && req.method === 'POST') {
    const body = await readJsonBody(req) || {};
    if (typeof body.id !== 'string') throw httpError(400, 'Không tìm thấy bản sao lưu này');
    const r = await restoreBackup(body.id);
    return send(res, 200, { ...r, ...await view() });
  }
  throw httpError(404, 'Not found');
}
// Lần tự sao lưu kế tiếp (để hiện trên trang Tài khoản)
function nextBackupAt(c) {
  const slot = backup.lastSlot(c.freq, c.hour);
  if (!c.last || c.last.at < slot) return Date.now();
  return slot + (c.freq === 'weekly' ? 7 : 1) * 864e5;
}

// ---------- Server ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    const session = sessionOf(req);

    if (url.pathname.startsWith('/s/')) return await shareRoute(req, res, url);

    if (url.pathname.startsWith('/api/')) {
      const parts = url.pathname.split('/').filter(Boolean); // ['api', 'photos', id?]
      if (restoring && req.method !== 'GET') throw httpError(503, 'Đang khôi phục dữ liệu từ bản sao lưu, thử lại sau ít phút');
      // /api/backup — sao lưu tự động, khôi phục (chỉ quản trị viên)
      if (parts[1] === 'backup') {
        if (!session) throw httpError(401, 'Cần đăng nhập');
        return await backupApi(req, res, parts, session.user);
      }
      // GET /api/public — ảnh công khai của mọi người
      if (parts[1] === 'public' && parts.length === 2 && req.method === 'GET') {
        if (!session) throw httpError(401, 'Cần đăng nhập');
        return send(res, 200, publicPhotos(session.user.id));
      }
      if (parts[1] === 'photos') {
        if (!session) throw httpError(401, 'Cần đăng nhập');
        return await photosApi(req, res, parts, session.user.id);
      }
      if (parts[1] === 'albums') {
        if (!session) throw httpError(401, 'Cần đăng nhập');
        return await albumsApi(req, res, parts, session.user.id);
      }
      if (parts[1] === 'trash') {
        if (!session) throw httpError(401, 'Cần đăng nhập');
        return await trashApi(req, res, parts, session.user.id);
      }
      if (parts[1] === 'shares') {
        if (!session) throw httpError(401, 'Cần đăng nhập');
        return await sharesApi(req, res, parts, session.user.id);
      }
      if (parts[1] === 'duplicates') {
        if (!session) throw httpError(401, 'Cần đăng nhập');
        return await duplicatesApi(req, res, parts, session.user.id);
      }
      // GET /api/import — thư mục nhập ảnh và tiến độ; POST /api/import — quét ngay
      if (parts[1] === 'import' && parts.length === 2) {
        if (!session) throw httpError(401, 'Cần đăng nhập');
        const st = importState(session.user.id), before = st.imported;
        if (req.method === 'POST') await Promise.race([scanImports(), new Promise(r => setTimeout(r, 1500))]);
        else if (req.method !== 'GET') throw httpError(405, 'Method not allowed');
        return send(res, 200, { ...importStatus(session.user), added: st.imported - before });
      }
      // /api/links — thư mục liên kết (ổ cứng ngoài)
      if (parts[1] === 'links') {
        if (!session) throw httpError(401, 'Cần đăng nhập');
        return await linksApi(req, res, parts, url, session.user);
      }
      return await authApi(req, res, parts, session);
    }

    // Android "Chia sẻ" vào ứng dụng đã cài: service worker (public/sw.js) nhận trước. Tới được server là chưa có service worker
    // (lần đầu mở sau khi cài, trình duyệt xoá dữ liệu...): bỏ file, mở gallery
    if (url.pathname === '/share-target' && req.method === 'POST') { req.resume(); return send(res, 303, '', { Location: '/' }); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

    const page = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!session && !OPEN_PAGES.has(page) && !OPEN_I18N.test(page)) {
      // Chưa đăng nhập: trang thì chuyển sang đăng nhập, còn ảnh/file thì từ chối
      if (page.endsWith('.html')) return send(res, 302, '', { Location: '/login.html?next=' + encodeURIComponent(url.pathname + url.search) });
      return send(res, 401, 'Cần đăng nhập');
    }

    // ?s=sm (ảnh trong lưới) / ?s=ph, ?s=md (xem phóng to trên điện thoại / máy tính) -> ảnh nhỏ WebP, không có ?s là ảnh gốc
    const size = Object.hasOwn(media.SIZES, url.searchParams.get('s')) ? url.searchParams.get('s') : null;

    if (url.pathname.startsWith('/uploads/')) {
      // Chỉ tìm trong thư mục của người đang đăng nhập -> không xem được ảnh của người khác
      const uid = session.user.id;
      // Tên file là UUID nên nội dung không bao giờ đổi -> cache lâu (private: không cho proxy lưu)
      const cache = 'private, max-age=31536000, immutable';
      const [name, hls, ...rest] = url.pathname.slice('/uploads/'.length).split('/');
      let photo = null;
      try { photo = photoIndex(getPhotos(uid), 'file').get(decodeURIComponent(name)) || null; } catch { /* đường dẫn lỗi */ }
      if (!photo || (hls !== undefined && hls !== 'hls')) return send(res, 404, 'Không tìm thấy');
      if (isOffline(photo)) return send(res, 503, OFFLINE_MSG);
      if (hls === 'hls') return photo.kind === 'video' ? serveHls(res, uid, photo, rest, cache) : send(res, 404, 'Không tìm thấy');
      return size ? serveVariant(res, uid, photo, size, cache) : serveOriginal(res, uid, photo, cache);
    }

    if (url.pathname.startsWith('/shared/')) {
      // /shared/<id chủ ảnh>/<file>: chỉ trả về khi ảnh đang được công khai
      const [ownerId, name, ...rest] = url.pathname.slice('/shared/'.length).split('/');
      const isHls = rest[0] === 'hls';
      let photo = null;
      try { if ((!rest.length || isHls) && name) photo = findPublicPhoto(ownerId, decodeURIComponent(name)); } catch { /* đường dẫn lỗi */ }
      if (!photo) return send(res, 404, 'Không tìm thấy');
      if (isOffline(photo)) return send(res, 503, OFFLINE_MSG);
      // Cache ngắn vì chủ ảnh có thể chuyển lại thành riêng tư
      const cache = 'private, max-age=300';
      if (isHls) return photo.kind === 'video' ? serveHls(res, ownerId, photo, rest.slice(1), cache) : send(res, 404, 'Không tìm thấy');
      return size ? serveVariant(res, ownerId, photo, size, cache) : serveOriginal(res, ownerId, photo, cache);
    }

    const file = safeJoin(PUBLIC_DIR, page);
    return file ? serveFile(res, file, 'no-cache') : send(res, 400, 'Bad path');
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Lỗi server' });
  }
}

// Mở server ở một cổng; lỗi (cổng bận, không có quyền) trả về qua Promise
function listenOn(port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(handle);
    s.once('error', reject);
    s.listen(port, '0.0.0.0', () => { s.off('error', reject); resolve(s); });
  });
}

function printAddresses() {
  console.log(`  Máy này:        http://localhost:${PORT}`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  Thiết bị khác:  http://${n.address}:${PORT}`);
    }
  }
}

// Đổi cổng khi đang chạy: mở cổng mới trước (lỗi thì giữ nguyên cổng cũ), rồi mới đóng cổng cũ
let server = null;
async function switchPort(port) {
  let next;
  try { next = await listenOn(port); }
  catch (err) {
    if (err.code === 'EADDRINUSE') throw httpError(409, `Cổng ${port} đang được chương trình khác dùng, hãy chọn cổng khác`);
    if (err.code === 'EACCES') throw httpError(409, `Máy chủ không cho mở cổng ${port}, hãy chọn cổng khác`);
    throw err;
  }
  const old = server;
  server = next;
  PORT = port;
  // Chờ một chút để trang kịp nhận trả lời; tải lên đang dở ở cổng cũ vẫn chạy tiếp cho xong
  setTimeout(() => {
    old.close();
    old.closeIdleConnections();
    setTimeout(() => old.closeAllConnections(), 10 * 60 * 1000).unref();
  }, 3000).unref();
  console.log(`\nĐã chuyển sang cổng ${port}:`);
  printAddresses();
  console.log(`Nếu dùng Tailscale Funnel, chạy lại:  tailscale funnel --bg ${port}\n`);
}

// Làm tiếp việc còn dở của ảnh trong máy: lúc khởi động, và sau khi khôi phục bản sao lưu
function resumeWork(links = true) {
  // Tạo dần ảnh nhỏ cho các ảnh cũ chưa có (kể cả ảnh chỉ thiếu một cỡ mới thêm)
  const missing = (uid, p) => Object.keys(media.SIZES).some(s => !fs.existsSync(media.variantPath(cacheDir(uid, p), p.id, s)));
  // (ảnh trên ổ ngoài: làm khi quét thư mục liên kết, vì ổ có thể đang rút)
  if (media.hasSharp) for (const u of users) for (const p of getPhotos(u.id)) if (p.kind !== 'video' && !p.link && (!p.color || missing(u.id, p))) makeThumbs(u.id, p);
  // Video chưa đủ ảnh bìa / mức HLS (vd. tải lên khi chưa cài ffmpeg, hoặc server tắt giữa chừng): làm tiếp
  if (video.hasFfmpeg) for (const u of users) for (const p of getPhotos(u.id)) if (p.kind === 'video' && !p.link) processVideo(u.id, p);
  // Chế độ gọn nhẹ: xoá các mức video khác 720p còn sót (vd. tạo từ trước khi có tuỳ chọn này)
  (async () => {
    let freed = 0;
    for (const u of users) for (const p of getPhotos(u.id)) if (p.kind === 'video' && !p.link) freed += await pruneHls(u.id, p);
    if (freed) console.log(`Video gọn nhẹ (720p + bản gốc): đã xoá ${(freed / 1048576).toFixed(1)} MB các mức chất lượng khác`);
  })();
  scheduleMeta();
  if (links) scanLinks();
}

listenOn(PORT).then(s => {
  server = s;
  console.log(`\nGallery đang chạy:`);
  printAddresses();
  console.log(`\nDữ liệu lưu tại: ${STORAGE_DIR}`);
  if (!users.length) console.log(`Chưa có tài khoản: mở http://localhost:${PORT} trên máy này để tạo tài khoản quản trị.`);
  else {
    console.log('Chép ảnh vào các thư mục sau là ảnh tự hiện trong gallery:');
    for (const u of users) console.log(`  ${u.username}:  ${importDir(u)}`);
  }
  if (links.length) {
    console.log('\nThư mục liên kết (xem tại chỗ, không chép vào máy):');
    for (const l of links) console.log(`  ${l.name}:  ${l.path}${linkState(l).online ? '' : '  (chưa cắm ổ)'}`);
  }
  if (!media.hasSharp) console.log('\nChưa cài "sharp" nên chưa có ảnh nhỏ (web sẽ chậm khi mạng yếu). Chạy: npm install');
  else if (!media.hasHeic) console.log('\nChưa cài "heic-decode" nên chưa xem được ảnh HEIC của iPhone. Chạy: npm install');
  if (!video.hasFfmpeg) console.log('\nChưa có ffmpeg nên video chỉ phát bản gốc (nặng khi mạng yếu). Chạy: npm install (tự tải ffmpeg, không cần cài vào máy)');
  else if (video.ffmpegSource === 'npm') console.log('\nVideo: dùng ffmpeg đóng gói sẵn (node_modules), không cần cài ffmpeg vào máy');
  console.log('');

  setTimeout(scanImports, 1000);
  setInterval(scanImports, IMPORT_SCAN_MS).unref();
  resumeWork(false);
  // Thư mục liên kết (ổ cứng ngoài): quét lúc khởi động, định kỳ, và ngay khi cắm ổ vào
  setTimeout(scanLinks, 2000);
  setInterval(scanLinks, LINK_SCAN_MS).unref();
  setInterval(checkLinks, LINK_CHECK_MS).unref();
  // Thùng rác: xoá hẳn ảnh quá hạn
  setTimeout(purgeTrash, 2 * 60 * 1000).unref();
  setInterval(purgeTrash, 6 * 3600 * 1000).unref();
  // Sao lưu tự động theo lịch
  setInterval(() => { if (backupDue()) startBackup('auto').catch(() => {}); }, 5 * 60 * 1000).unref();
  setTimeout(() => { if (backupDue()) startBackup('auto').catch(() => {}); }, 60 * 1000).unref();
}, err => {
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
    console.error(err.code === 'EADDRINUSE'
      ? `\nCổng ${PORT} đang được dùng, có thể gallery đã chạy ở một cửa sổ khác.`
      : `\nKhông có quyền mở cổng ${PORT}.`);
    console.error('Hãy tắt cửa sổ đó, hoặc chạy ở cổng khác:');
    console.error('  PowerShell:  $env:PORT=8080; node server.js');
    console.error('  CMD:         set PORT=8080 && node server.js');
    if (!ENV_PORT && settings.port) console.error(`Cổng ${PORT} được lưu trong ${SETTINGS_FILE}, xoá file đó để quay về cổng ${DEFAULT_PORT}.`);
    console.error('');
    process.exit(1);
  }
  throw err;
});
