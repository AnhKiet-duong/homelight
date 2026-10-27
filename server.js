// Gallery server — không cần cài thư viện, chỉ cần Node.js 18+.
// Chạy: node server.js   (đổi cổng: PORT=8080 node server.js)
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { promisify } = require('util');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const STORAGE_DIR = path.join(ROOT, 'storage');      // toàn bộ dữ liệu, không đưa lên git
const USERS_DIR = path.join(STORAGE_DIR, 'users');   // mỗi người dùng một thư mục: users/<id>/
const USERS_FILE = path.join(STORAGE_DIR, 'users.json');
const SESSIONS_FILE = path.join(STORAGE_DIR, 'sessions.json');
const LEGACY_UPLOAD_DIR = path.join(ROOT, 'uploads'); // bản cũ (chưa có tài khoản)
const LEGACY_DATA_FILE = path.join(ROOT, 'data.json');
const MAX_SIZE = 50 * 1024 * 1024; // 50 MB / ảnh
const SESSION_MS = 30 * 24 * 3600 * 1000; // đăng nhập giữ 30 ngày
const LOGIN_MAX_FAILS = 10, LOGIN_LOCK_MS = 15 * 60 * 1000;

// Chỉ nhận các định dạng ảnh an toàn để hiển thị (không nhận SVG vì có thể chứa script)
const IMAGE_TYPES = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/avif': '.avif', 'image/bmp': '.bmp',
};
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  ...Object.fromEntries(Object.entries(IMAGE_TYPES).map(([t, e]) => [e, t])),
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
  users.push(user);
  await saveUsers();
  return user;
}

// ---------- Ảnh của từng người: users/<id>/photos.json + users/<id>/images/ ----------
const userDir = id => path.join(USERS_DIR, id);
const imagesDir = id => path.join(userDir(id), 'images');
const photosFile = id => path.join(userDir(id), 'photos.json');
const photoCache = new Map();
function getPhotos(uid) {
  if (!photoCache.has(uid)) photoCache.set(uid, readJson(photosFile(uid), []));
  return photoCache.get(uid);
}
function savePhotos(uid, list) {
  photoCache.set(uid, list);
  return writeJson(photosFile(uid), list);
}

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

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
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

async function serveFile(res, file, cache) {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error();
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  } catch {
    send(res, 404, 'Không tìm thấy');
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

  // POST /api/password — tự đổi mật khẩu, đăng xuất các thiết bị khác
  if (action === 'password' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!await checkPassword(me, typeof body.current === 'string' ? body.current : '')) throw httpError(400, 'Mật khẩu hiện tại không đúng');
    Object.assign(me, await hashPassword(validPassword(body.next)));
    await saveUsers();
    await dropSessions(me.id, session.key);
    return send(res, 200, { ok: true });
  }

  // /api/users — chỉ quản trị viên
  if (action === 'users') {
    if (me.role !== 'admin') throw httpError(403, 'Chỉ quản trị viên mới làm được');
    const id = parts[2];

    if (!id && req.method === 'GET') {
      return send(res, 200, users.map(u => {
        const list = getPhotos(u.id);
        return { ...publicUser(u), photos: list.length, bytes: list.reduce((a, p) => a + (p.size || 0), 0) };
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
      if (p.public) list.push({ ...p, fav: false, url: `/shared/${u.id}/${p.file}`, owner: u.username, mine: u.id === viewerId });
    }
  }
  return list;
}
function findPublicFile(ownerId, file) {
  if (!users.some(u => u.id === ownerId)) return null;
  const photo = getPhotos(ownerId).find(p => p.public && p.file === file);
  return photo ? path.join(imagesDir(ownerId), photo.file) : null;
}

// ---------- API: ảnh (của người đang đăng nhập) ----------
async function photosApi(req, res, parts, uid) {
  if (parts.length > 3) throw httpError(404, 'Not found');
  const id = parts[2];
  const photos = getPhotos(uid);

  // GET /api/photos — danh sách ảnh
  if (req.method === 'GET' && !id) return send(res, 200, photos);

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

  // POST /api/photos — body là nội dung file ảnh, tên file ở header X-Filename
  if (req.method === 'POST' && !id) {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = IMAGE_TYPES[type];
    if (!ext) return send(res, 415, { error: 'Định dạng không được hỗ trợ: ' + (type || 'không rõ') });
    const buf = await readBody(req, MAX_SIZE);
    if (!buf.length) return send(res, 400, { error: 'File rỗng' });

    const newId = crypto.randomUUID();
    const file = newId + ext;
    await fsp.mkdir(imagesDir(uid), { recursive: true });
    await fsp.writeFile(path.join(imagesDir(uid), file), buf);
    const photo = {
      id: newId,
      name: decodeHeader(req.headers['x-filename'], 'image' + ext).slice(0, 200),
      file,
      url: '/uploads/' + file,
      type,
      size: buf.length,
      w: Number(req.headers['x-width']) || 0,
      h: Number(req.headers['x-height']) || 0,
      taken: Number(req.headers['x-taken']) || null, // ngày chụp đọc từ EXIF (nếu có)
      added: Date.now(),
      fav: false,
      public: false, // true: mọi tài khoản đều xem và tải được
    };
    photos.push(photo);
    await savePhotos(uid, photos);
    return send(res, 201, photo);
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
    return send(res, 200, photo);
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
    await fsp.unlink(path.join(imagesDir(uid), photo.file)).catch(() => {});
    return send(res, 200, { ok: true });
  }

  send(res, 405, { error: 'Method not allowed' });
}

// ---------- API: album (của người đang đăng nhập) ----------
function albumView(a, photos) {
  const ids = a.photoIds.filter(id => photos.some(p => p.id === id));
  const cover = photos.find(p => p.id === (ids.includes(a.cover) ? a.cover : ids[0]));
  return { id: a.id, name: a.name, photoIds: ids, cover: cover ? cover.id : null, coverUrl: cover ? cover.url : null, created: a.created };
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
  if (req.method === 'GET' && !id) return send(res, 200, albums.map(a => albumView(a, photos)));

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

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
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
      return await authApi(req, res, parts, session);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

    const page = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!session && !OPEN_PAGES.has(page)) {
      // Chưa đăng nhập: trang thì chuyển sang đăng nhập, còn ảnh/file thì từ chối
      if (page.endsWith('.html')) return send(res, 302, '', { Location: '/login.html?next=' + encodeURIComponent(url.pathname + url.search) });
      return send(res, 401, 'Cần đăng nhập');
    }

    if (url.pathname.startsWith('/uploads/')) {
      // Chỉ tìm trong thư mục của người đang đăng nhập -> không xem được ảnh của người khác
      const file = safeJoin(imagesDir(session.user.id), url.pathname.slice('/uploads/'.length));
      // Tên file là UUID nên nội dung không bao giờ đổi -> cache lâu (private: không cho proxy lưu)
      return file ? serveFile(res, file, 'private, max-age=31536000, immutable') : send(res, 400, 'Bad path');
    }

    if (url.pathname.startsWith('/shared/')) {
      // /shared/<id chủ ảnh>/<file>: chỉ trả về khi ảnh đang được công khai
      const [ownerId, name, ...rest] = url.pathname.slice('/shared/'.length).split('/');
      let file = null;
      try { if (!rest.length && name) file = findPublicFile(ownerId, decodeURIComponent(name)); } catch { /* đường dẫn lỗi */ }
      // Cache ngắn vì chủ ảnh có thể chuyển lại thành riêng tư
      return file ? serveFile(res, file, 'private, max-age=300') : send(res, 404, 'Không tìm thấy');
    }

    const file = safeJoin(PUBLIC_DIR, page);
    return file ? serveFile(res, file, 'no-cache') : send(res, 400, 'Bad path');
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Lỗi server' });
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nCổng ${PORT} đang được dùng, có thể gallery đã chạy ở một cửa sổ khác.`);
    console.error('Hãy tắt cửa sổ đó, hoặc chạy ở cổng khác:');
    console.error('  PowerShell:  $env:PORT=8080; node server.js');
    console.error('  CMD:         set PORT=8080 && node server.js\n');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nGallery đang chạy:`);
  console.log(`  Máy này:        http://localhost:${PORT}`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  Thiết bị khác:  http://${n.address}:${PORT}`);
    }
  }
  console.log(`\nDữ liệu lưu tại: ${STORAGE_DIR}`);
  if (!users.length) console.log(`Chưa có tài khoản: mở http://localhost:${PORT} trên máy này để tạo tài khoản quản trị.`);
  console.log('');
});
