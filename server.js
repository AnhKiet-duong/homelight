// Gallery server — không cần cài thư viện, chỉ cần Node.js 18+.
// Chạy: node server.js   (đổi cổng: PORT=8080 node server.js)
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DATA_FILE = path.join(ROOT, 'data.json');
const MAX_SIZE = 50 * 1024 * 1024; // 50 MB / ảnh

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

// ---------- Metadata (data.json) ----------
let photos = [];
try { photos = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { photos = []; }
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Ghi file tuần tự để các request đồng thời không ghi đè lên nhau
let saving = Promise.resolve();
function save() {
  saving = saving.then(async () => {
    const tmp = DATA_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(photos, null, 2));
    await fsp.rename(tmp, DATA_FILE);
  }).catch(err => console.error('Lỗi ghi data.json:', err));
  return saving;
}

// ---------- Helpers ----------
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
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
      if (size > limit) { reject(Object.assign(new Error('File quá lớn'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
  const p = path.normalize(path.join(base, decodeURIComponent(urlPath)));
  return p.startsWith(base + path.sep) || p === base ? p : null;
}

// ---------- API ----------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','photos',id?]
  if (parts[1] !== 'photos' || parts.length > 3) return send(res, 404, { error: 'Not found' });
  const id = parts[2];

  // GET /api/photos — danh sách ảnh
  if (req.method === 'GET' && !id) return send(res, 200, photos);

  // POST /api/photos — body là nội dung file ảnh, tên file ở header X-Filename
  if (req.method === 'POST' && !id) {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = IMAGE_TYPES[type];
    if (!ext) return send(res, 415, { error: 'Định dạng không được hỗ trợ: ' + (type || 'không rõ') });
    const buf = await readBody(req, MAX_SIZE);
    if (!buf.length) return send(res, 400, { error: 'File rỗng' });

    const newId = crypto.randomUUID();
    const file = newId + ext;
    await fsp.writeFile(path.join(UPLOAD_DIR, file), buf);
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
    };
    photos.push(photo);
    await save();
    return send(res, 201, photo);
  }

  const photo = photos.find(p => p.id === id);
  if (!photo) return send(res, 404, { error: 'Không tìm thấy ảnh' });

  // PATCH /api/photos/:id — sửa tên / yêu thích
  if (req.method === 'PATCH') {
    let body;
    try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); }
    catch { return send(res, 400, { error: 'JSON không hợp lệ' }); }
    if (typeof body.fav === 'boolean') photo.fav = body.fav;
    if (typeof body.name === 'string' && body.name.trim()) photo.name = body.name.trim().slice(0, 200);
    await save();
    return send(res, 200, photo);
  }

  // DELETE /api/photos/:id
  if (req.method === 'DELETE') {
    photos = photos.filter(p => p.id !== id);
    await save();
    await fsp.unlink(path.join(UPLOAD_DIR, photo.file)).catch(() => {});
    return send(res, 200, { ok: true });
  }

  send(res, 405, { error: 'Method not allowed' });
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

    if (url.pathname.startsWith('/uploads/')) {
      const file = safeJoin(UPLOAD_DIR, url.pathname.slice('/uploads/'.length));
      // Tên file là UUID nên nội dung không bao giờ đổi -> cache lâu
      return file ? serveFile(res, file, 'public, max-age=31536000, immutable') : send(res, 400, 'Bad path');
    }

    const file = safeJoin(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    return file ? serveFile(res, file, 'no-cache') : send(res, 400, 'Bad path');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.message || 'Lỗi server' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nGallery đang chạy:`);
  console.log(`  Máy này:        http://localhost:${PORT}`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  Thiết bị khác:  http://${n.address}:${PORT}`);
    }
  }
  console.log(`\nẢnh lưu tại: ${UPLOAD_DIR}\n`);
});
