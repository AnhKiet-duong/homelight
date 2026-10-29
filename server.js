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

// Chỉ nhận các định dạng ảnh an toàn để hiển thị (không nhận SVG vì có thể chứa script)
const IMAGE_TYPES = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/avif': '.avif', 'image/bmp': '.bmp',
  'image/heic': '.heic', // ảnh iPhone: xem qua ảnh nhỏ WebP (xem media.js), file gốc chỉ để tải xuống
};
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  ...Object.fromEntries(Object.entries(IMAGE_TYPES).map(([t, e]) => [e, t])),
  ...Object.fromEntries(Object.entries(video.VIDEO_TYPES).map(([t, e]) => [e, t])),
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.jpg': 'image/jpeg',
};
// Trang xem được khi chưa đăng nhập
const OPEN_PAGES = new Set(['/login.html', '/favicon.ico']);

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

// ---------- Người dùng ----------
// users.json: [{ id, username, role: 'admin' | 'user', salt, hash, created }]
let users = readJson(USERS_FILE, []);
const saveUsers = () => writeJson(USERS_FILE, users);
const publicUser = u => ({ id: u.id, username: u.username, role: u.role, created: u.created });
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

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
function photoView(p, url = p.url) {
  const { hash, hls, vfail, rel, mtime, ...rest } = p;
  if (p.kind === 'video') {
    // hls: danh sách phát nhiều mức chất lượng (null khi chưa tạo xong mức nào -> phát file gốc)
    // processing: server còn đang tạo thêm mức chất lượng
    const ready = Object.keys(hls || {});
    return {
      ...rest, url, thumb: url + '?s=sm', preview: url + '?s=md',
      hls: ready.length ? url + '/hls/master.m3u8' : null, qualities: ready.map(Number),
      processing: video.hasFfmpeg && !vfail && video.plan(p.w, p.h).some(q => !ready.includes(String(q))),
    };
  }
  return { ...rest, url, thumb: url + '?s=sm', preview: p.type === 'image/gif' ? url : url + '?s=md' }; // GIF giữ ảnh động
}
const thumbFailed = new Set();
function makeThumbs(uid, photo, urgent) {
  const key = uid + '/' + photo.id, isVideo = photo.kind === 'video';
  if (!(isVideo ? video.hasFfmpeg : media.hasSharp) || thumbFailed.has(key) || isOffline(photo)) return Promise.resolve(false);
  // Video: tạo ảnh bìa bằng ffmpeg trước, rồi làm ảnh nhỏ từ ảnh bìa như ảnh thường
  const src = isVideo ? ensurePoster(uid, photo, urgent) : Promise.resolve(originalPath(uid, photo));
  return src.then(file => media.hasSharp ? media.queueVariants(file, cacheDir(uid, photo), photo.id, urgent) : null).then(info => {
    const p = getPhotos(uid).find(x => x.id === photo.id);
    if (p && info && (p.color !== info.color || (!p.w && info.w && !isVideo))) {
      p.color = info.color;
      if (!p.w && info.w && !isVideo) Object.assign(p, { w: info.w, h: info.h }); // ảnh nhập khi chưa có sharp
      savePhotosSoon(uid);
    }
    return true;
  }, err => {
    if (photo.link && !fs.existsSync(originalPath(uid, photo))) return false; // ổ vừa bị rút: cắm lại thì làm tiếp
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

async function ensurePoster(uid, photo, urgent) {
  const out = posterPath(uid, photo);
  if (!await fileExists(out)) {
    await fsp.mkdir(cacheDir(uid, photo), { recursive: true });
    await video.makePoster(originalPath(uid, photo), out, photo, urgent);
  }
  return out;
}

// Đọc thông tin, tạo ảnh bìa rồi lần lượt các mức HLS (360p trước để mạng chậm có cái xem sớm nhất).
// Nhiều video cùng lúc: mọi video có 360p xong rồi mới tới 720p
const videoJobs = new Set();
async function processVideo(uid, photo) {
  const key = uid + '/' + photo.id;
  if (!video.hasFfmpeg || videoJobs.has(key) || photo.vfail || isOffline(photo)) return;
  videoJobs.add(key);
  const src = originalPath(uid, photo);
  const alive = () => getPhotos(uid).includes(photo);
  try {
    if (!photo.w || !photo.duration) {
      const info = await video.probe(src);
      Object.assign(photo, { w: info.w, h: info.h, duration: info.duration, fps: info.fps });
      if (!photo.taken && info.taken) photo.taken = info.taken;
      savePhotosSoon(uid);
    }
    if (!photo.color || !await fileExists(media.hasSharp ? media.variantPath(cacheDir(uid, photo), photo.id, 'sm') : posterPath(uid, photo))) {
      await makeThumbs(uid, photo);
    }
    for (const q of video.plan(photo.w, photo.h)) {
      if (!alive()) return;
      if (photo.hls && photo.hls[q] && await fileExists(path.join(hlsDir(uid, photo), String(q), 'index.m3u8'))) continue;
      const t0 = Date.now();
      const r = await video.makeRendition(src, hlsDir(uid, photo), q, photo, key, alive);
      if (!alive()) { await fsp.rm(hlsDir(uid, photo), { recursive: true, force: true }); return; }
      photo.hls = { ...photo.hls, [q]: r };
      await savePhotos(uid, getPhotos(uid));
      console.log(`Video ${photo.name}: xong ${q}p (${r.kbps} kbps, ${Math.round((Date.now() - t0) / 1000)} giây)`);
    }
  } catch (err) {
    if (err.cancelled || (photo.link && !fs.existsSync(src))) return; // ổ vừa bị rút: cắm lại thì làm tiếp
    photo.vfail = true; // không thử lại mỗi lần khởi động; xoá dòng vfail trong photos.json để thử lại
    savePhotosSoon(uid);
    console.error(`Không xử lý được video ${photo.name}:`, err.message);
  } finally {
    videoJobs.delete(key);
  }
}

// /uploads/<file>/hls/master.m3u8 và /uploads/<file>/hls/<mức>/(index.m3u8|segNNNN.ts)
async function serveHls(res, uid, photo, rest, cache) {
  const ready = photo.hls || {};
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
      return pipeline(fs.createReadStream(file, { start, end }), res, () => {});
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
    body ? res.end(body) : pipeline(fs.createReadStream(file), res, () => {});
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
      prefs: session ? { dataSaver: false, ...session.user.prefs } : null, // tuỳ chọn riêng của tài khoản
      needsSetup: users.length === 0,
      canSetup: users.length === 0 && isLocalRequest(req),
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

  // POST /api/logout
  if (action === 'logout' && req.method === 'POST') {
    if (session) { delete sessions[session.key]; await saveSessions(); }
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  if (!session) throw httpError(401, 'Cần đăng nhập');
  const me = session.user;

  // POST /api/prefs — lưu tuỳ chọn của tài khoản: { dataSaver: true|false } (tiết kiệm dữ liệu khi xem bằng 4G/5G)
  if (action === 'prefs' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (typeof body.dataSaver !== 'boolean') throw httpError(400, 'Tuỳ chọn không hợp lệ');
    me.prefs = { ...me.prefs, dataSaver: body.dataSaver };
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
    const view = () => ({ port: PORT, envPort: ENV_PORT, defaultPort: DEFAULT_PORT });
    if (req.method === 'GET') return send(res, 200, view());

    // PUT /api/settings { port } — mở cổng mới ngay, cổng cũ đóng sau vài giây
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
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
      if (p.public && !isOffline(p)) list.push({ ...photoView(p, `/shared/${u.id}/${p.file}`), fav: false, owner: u.username, mine: u.id === viewerId });
    }
  }
  return list;
}
function findPublicPhoto(ownerId, file) {
  if (!users.some(u => u.id === ownerId)) return null;
  const p = photoIndex(getPhotos(ownerId), 'file').get(file);
  return p && p.public ? p : null;
}

// ---------- API: ảnh (của người đang đăng nhập) ----------
async function photosApi(req, res, parts, uid) {
  if (parts.length > 3) throw httpError(404, 'Not found');
  const id = parts[2];
  const photos = getPhotos(uid);

  // GET /api/photos — danh sách ảnh
  if (req.method === 'GET' && !id) return send(res, 200, visiblePhotos(uid).map(p => photoView(p)));

  // POST /api/photos/bulk — công khai / riêng tư nhiều ảnh cùng lúc: { ids: [...], public: true|false }
  if (req.method === 'POST' && id === 'bulk') {
    const body = await readJsonBody(req);
    if (!Array.isArray(body.ids) || typeof body.public !== 'boolean') throw httpError(400, 'Cần danh sách ảnh và trạng thái công khai');
    const ids = new Set(body.ids);
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
      taken: Number(req.headers['x-taken']) || (heic ? await media.heicDate(path.join(imagesDir(uid), file)) : null), // ngày chụp đọc từ EXIF (nếu có)
      added: Date.now(),
      fav: false,
      public: false, // true: mọi tài khoản đều xem và tải được
    };
    photos.push(photo);
    await savePhotos(uid, photos);
    makeThumbs(uid, photo);
    return send(res, 201, photoView(photo));
  }

  const photo = photos.find(p => p.id === id);
  if (!photo) return send(res, 404, { error: 'Không tìm thấy ảnh' });

  // PATCH /api/photos/:id — sửa tên / yêu thích
  if (req.method === 'PATCH') {
    const body = await readJsonBody(req);
    if (typeof body.fav === 'boolean') photo.fav = body.fav;
    if (typeof body.public === 'boolean') photo.public = body.public;
    if (typeof body.name === 'string' && body.name.trim()) photo.name = body.name.trim().slice(0, 200);
    await savePhotos(uid, photos);
    return send(res, 200, photoView(photo));
  }

  // DELETE /api/photos/:id — xoá luôn khỏi các album
  if (req.method === 'DELETE') {
    await savePhotos(uid, photos.filter(p => p.id !== id));
    const albums = getAlbums(uid);
    if (albums.some(a => a.photoIds.includes(id))) {
      for (const a of albums) {
        a.photoIds = a.photoIds.filter(x => x !== id);
        if (a.cover === id) a.cover = null;
      }
      await saveAlbums(uid, albums);
    }
    await dropThumbs(uid, photo); // trước khi xoá file gốc: dừng ffmpeg đang đọc nó
    // Ảnh trong thư mục liên kết: chỉ ẩn khỏi gallery, không bao giờ xoá file gốc trên ổ ngoài
    if (photo.link) await hideLinked(photo);
    else await fsp.unlink(path.join(imagesDir(uid), photo.file)).catch(() => {});
    return send(res, 200, { ok: true });
  }

  send(res, 405, { error: 'Method not allowed' });
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
  return v.filter(id => photos.some(p => p.id === id));
}

async function albumsApi(req, res, parts, uid) {
  if (parts.length > 3) throw httpError(404, 'Not found');
  const id = parts[2];
  const photos = getPhotos(uid);
  const albums = getAlbums(uid);

  // GET /api/albums
  if (req.method === 'GET' && !id) {
    // Album tạo từ thư mục trên ổ ngoài: ẩn khi rút ổ (trống)
    const shown = visiblePhotos(uid);
    return send(res, 200, albums.map(a => albumView(a, shown)).filter((v, i) => !(albums[i].link && !v.photoIds.length)));
  }

  // POST /api/albums — { name, photoIds? }
  if (req.method === 'POST' && !id) {
    const body = await readJsonBody(req);
    if (albums.length >= 500) throw httpError(400, 'Đã có quá nhiều album');
    const album = { id: crypto.randomBytes(6).toString('hex'), name: albumName(body.name), photoIds: [...new Set(ownPhotoIds(body.photoIds, photos))], cover: null, created: Date.now() };
    albums.push(album);
    await saveAlbums(uid, albums);
    return send(res, 201, albumView(album, photos));
  }

  const album = albums.find(a => a.id === id);
  if (!album) throw httpError(404, 'Không tìm thấy album');

  // PATCH /api/albums/:id — { name?, add?: [...], remove?: [...], cover? }
  if (req.method === 'PATCH') {
    const body = await readJsonBody(req);
    if (body.name !== undefined) album.name = albumName(body.name);
    const add = ownPhotoIds(body.add, photos);
    const remove = new Set(ownPhotoIds(body.remove, photos));
    album.photoIds = [...new Set([...album.photoIds, ...add])].filter(x => !remove.has(x));
    if (body.cover !== undefined) album.cover = album.photoIds.includes(body.cover) ? body.cover : null;
    if (remove.has(album.cover)) album.cover = null;
    await saveAlbums(uid, albums);
    return send(res, 200, albumView(album, photos));
  }

  // DELETE /api/albums/:id — chỉ xoá album, ảnh vẫn còn
  if (req.method === 'DELETE') {
    await saveAlbums(uid, albums.filter(a => a.id !== id));
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
    if (p.link) continue; // ảnh trên ổ ngoài: không so trùng
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
    if (changed) await savePhotos(uid, getPhotos(uid));
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
for (const l of links) { try { linkState(l).online = fs.statSync(l.path).isDirectory(); } catch {} }

function originalPath(uid, p) {
  const l = p.link && linkById(p.link);
  return l ? path.join(l.path, p.rel) : path.join(imagesDir(uid), p.file);
}
function cacheDir(uid, p) {
  const l = p.link && linkById(p.link);
  return l && l.cache === 'drive' ? path.join(l.path, LINK_DIR, 'cache') : thumbsDir(uid);
}
// Ảnh để hiện: bỏ ảnh của ổ đang rút ra
const visiblePhotos = uid => getPhotos(uid).filter(p => !isOffline(p));
const OFFLINE_MSG = 'Ổ đĩa chứa ảnh này đang không cắm vào máy chủ';
function serveOriginal(res, uid, photo, cache) {
  if (isOffline(photo)) return send(res, 503, OFFLINE_MSG);
  return serveFile(res, originalPath(uid, photo), cache);
}

// Liệt kê ảnh/video (kể cả thư mục con). Ổ bị rút giữa chừng -> ném lỗi, để không tưởng nhầm là ảnh đã bị xoá
async function walkLink(root, rel = '', out = new Map()) {
  let entries;
  try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); }
  catch (err) {
    if (rel && (err.code === 'EPERM' || err.code === 'EACCES')) return out; // thư mục hệ thống không cho đọc
    throw err;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.test(e.name)) continue;
    const r = rel ? path.join(rel, e.name) : e.name, full = path.join(root, r);
    if (e.isDirectory()) { if (!within(full, ROOT) && !within(full, IMPORT_DIR)) await walkLink(root, r, out); }
    else if (e.isFile() && MEDIA_EXT.test(e.name)) {
      try { out.set(r, await fsp.stat(full)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
  }
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
  if (st.scanning || !u) return;
  st.scanning = true;
  const uid = u.id, toAlbums = new Map();
  let changed = 0;
  try {
    let found;
    try { found = await walkLink(l.path); }
    catch (err) {
      st.error = err.code === 'ENOENT' ? null : err.message;
      if (st.online) console.log(`Không đọc được "${l.name}" (${l.path}): ${err.message}`);
      st.online = st.resumed = false;
      return;
    }
    st.online = true; st.error = null;
    const mine = new Map(getPhotos(uid).filter(p => p.link === l.id).map(p => [p.rel, p]));
    // Ổ bỗng trống trơn (vd. cắm ổ khác vào cùng ký tự E:) -> không xoá gì, chờ lần sau
    if (found.size || !mine.size) {
      await forgetPhotos(uid, [...mine.values()].filter(p => !found.has(p.rel)));
      const hidden = (l.hidden || []).filter(r => found.has(r));
      if (hidden.length !== (l.hidden || []).length) { l.hidden = hidden; await saveLinks(); }
    }
    const hidden = new Set(l.hidden || []);
    for (const [rel, stat] of found) {
      if (!linkById(l.id) || !users.includes(u)) return; // vừa gỡ liên kết / xoá tài khoản
      const old = mine.get(rel);
      if (hidden.has(rel) || (old && old.size === stat.size && old.mtime === Math.round(stat.mtimeMs))) continue;
      const skipKey = `${l.id}|${rel}|${stat.size}|${Math.round(stat.mtimeMs)}`;
      if (notMedia.has(skipKey)) continue;
      let p;
      try { p = await linkedPhoto(l, rel, stat); }
      catch (err) { console.error(`Không đọc được ${rel}:`, err.message); continue; }
      if (!p) { notMedia.add(skipKey); continue; }
      if (old) {
        // File bị thay bằng bản khác: giữ id, yêu thích, công khai, album; làm lại ảnh nhỏ / HLS
        await dropThumbs(uid, old);
        thumbFailed.delete(uid + '/' + old.id);
        for (const k of ['hls', 'vfail', 'color']) delete old[k];
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
        if (p.link !== l.id) continue;
        if (p.kind === 'video') processVideo(uid, p);
        else if (media.hasSharp && (!p.color || Object.keys(media.SIZES).some(s => !fs.existsSync(media.variantPath(cacheDir(uid, p), p.id, s))))) makeThumbs(uid, p);
      }
    }
  } finally {
    if (changed) await savePhotos(uid, getPhotos(uid));
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
    st.lastScan = Date.now();
  }
}
const notMedia = new Set(); // file có đuôi ảnh nhưng không phải ảnh: không đọc lại mỗi lần quét

let linkScanning = null;
function scanLinks() {
  if (!linkScanning) {
    linkScanning = (async () => { for (const l of [...links]) if (linkState(l).online) await scanLink(l).catch(err => console.error('Lỗi quét thư mục liên kết:', err.message)); })()
      .finally(() => { linkScanning = null; });
  }
  return linkScanning;
}

// Windows có thể gán ký tự khác khi cắm lại ổ (E: -> F:): tìm dấu .homelight/link.json trên các ổ khác
async function relocate(l) {
  if (process.platform !== 'win32' || l.cache !== 'drive' || !/^[a-z]:\\/i.test(l.path)) return false;
  for (const d of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const cand = d + l.path.slice(1);
    if (normPath(cand) === normPath(l.path)) continue;
    const mark = readJson(path.join(cand, LINK_DIR, 'link.json'), null);
    if (mark && mark.id === l.id) {
      console.log(`"${l.name}" đã chuyển từ ${l.path} sang ${cand}`);
      l.path = cand;
      await saveLinks();
      return true;
    }
  }
  return false;
}

async function checkLinks() {
  for (const l of [...links]) {
    const st = linkState(l), was = st.online;
    const on = await isDir(l.path) || await relocate(l);
    if (on && !was) { console.log(`Đã cắm ổ chứa "${l.name}" (${l.path})`); st.online = true; scanLink(l); }
    else if (!on && was) { console.log(`Ổ chứa "${l.name}" (${l.path}) đã rút ra: tạm ẩn ảnh trong đó`); st.online = st.resumed = false; }
  }
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
  return p;
}

function linkView(l) {
  const st = linkState(l), owner = users.find(u => u.id === l.uid);
  let photos = 0, videos = 0;
  for (const p of owner ? getPhotos(owner.id) : []) if (p.link === l.id) p.kind === 'video' ? videos++ : photos++;
  return {
    id: l.id, name: l.name, path: l.path, cache: l.cache, uid: l.uid, owner: owner ? owner.username : null,
    online: st.online, scanning: st.scanning, lastScan: st.lastScan, error: st.error,
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

  // POST /api/links/:id/scan — quét lại ngay
  if (parts[3] === 'scan' && parts.length === 4 && req.method === 'POST') {
    if (await isDir(l.path) || await relocate(l)) { linkState(l).online = true; scanLink(l); }
    else linkState(l).online = false;
    return send(res, 200, linkView(l));
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
      linkState(l).online = true; linkState(l).resumed = false;
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

// ---------- Server ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    const session = sessionOf(req);

    if (url.pathname.startsWith('/api/')) {
      const parts = url.pathname.split('/').filter(Boolean); // ['api', 'photos', id?]
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

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

    const page = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!session && !OPEN_PAGES.has(page)) {
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
  if (!video.hasFfmpeg) console.log('\nChưa có ffmpeg nên video chỉ phát bản gốc (nặng khi mạng yếu). Cài: winget install Gyan.FFmpeg rồi mở lại cửa sổ này');
  console.log('');

  setTimeout(scanImports, 1000);
  setInterval(scanImports, IMPORT_SCAN_MS).unref();
  // Tạo dần ảnh nhỏ cho các ảnh cũ chưa có (kể cả ảnh chỉ thiếu một cỡ mới thêm)
  const missing = (uid, p) => Object.keys(media.SIZES).some(s => !fs.existsSync(media.variantPath(cacheDir(uid, p), p.id, s)));
  // (ảnh trên ổ ngoài: làm khi quét thư mục liên kết, vì ổ có thể đang rút)
  if (media.hasSharp) for (const u of users) for (const p of getPhotos(u.id)) if (p.kind !== 'video' && !p.link && (!p.color || missing(u.id, p))) makeThumbs(u.id, p);
  // Video chưa đủ ảnh bìa / mức HLS (vd. tải lên khi chưa cài ffmpeg, hoặc server tắt giữa chừng): làm tiếp
  if (video.hasFfmpeg) for (const u of users) for (const p of getPhotos(u.id)) if (p.kind === 'video' && !p.link) processVideo(u.id, p);
  // Thư mục liên kết (ổ cứng ngoài): quét lúc khởi động, định kỳ, và ngay khi cắm ổ vào
  setTimeout(scanLinks, 2000);
  setInterval(scanLinks, LINK_SCAN_MS).unref();
  setInterval(checkLinks, LINK_CHECK_MS).unref();
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
