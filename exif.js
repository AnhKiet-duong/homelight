// Thông tin chụp của ảnh / video: máy ảnh, ống kính, thông số, toạ độ GPS, và đoán nơi chụp (thành phố gần nhất).
// Kết quả lưu ở p.exif = { cam, lens, iso, f, exp, fl, lat, lon } (chỉ có trường đọc được; {} là đã đọc mà không có gì)
// và p.place = { n: tên thành phố, cc: mã nước }. Tên nước do trình duyệt tự dịch từ mã (Intl.DisplayNames).
// Danh sách thành phố: data/cities.txt.gz (GeoNames, CC BY 4.0), ~25 nghìn nơi, chỉ nạp khi cần.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');

let sharp = null;
try { sharp = require('sharp'); } catch { /* chưa cài sharp: chỉ đọc được JPEG */ }

// ---------- Đọc khối EXIF (TIFF) ----------
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function parseTiff(buf, tiff) {
  const le = buf.readUInt16BE(tiff) === 0x4949;
  const u16 = o => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
  const u32 = o => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
  const s32 = o => le ? buf.readInt32LE(o) : buf.readInt32BE(o);
  const readIfd = ifd => {
    const tags = new Map();
    if (ifd < tiff || ifd + 2 > buf.length) return tags;
    const n = u16(ifd);
    for (let i = 0; i < n && i < 500; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > buf.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4), size = (TYPE_SIZE[type] || 0) * count;
      if (!size || count > 1e5) continue;
      const at = size <= 4 ? e + 8 : tiff + u32(e + 8);
      if (at + size > buf.length) continue;
      const vals = [];
      if (type !== 2) for (let k = 0; k < Math.min(count, 8); k++) {
        const o = at + k * TYPE_SIZE[type];
        vals.push(type === 3 ? u16(o) : type === 4 ? u32(o) : type === 9 ? s32(o)
          : type === 5 ? (u32(o + 4) ? u32(o) / u32(o + 4) : NaN)
          : type === 10 ? (s32(o + 4) ? s32(o) / s32(o + 4) : NaN) : buf[o]);
      }
      tags.set(tag, type === 2 ? buf.toString('utf8', at, at + count).replace(/\0[\s\S]*$/, '').trim() : vals);
    }
    return tags;
  };
  const ifd0 = readIfd(tiff + u32(tiff + 4));
  const ptr = t => ifd0.has(t) ? readIfd(tiff + ifd0.get(t)[0]) : new Map();
  return { ifd0, exif: ptr(0x8769), gps: ptr(0x8825) };
}

// Tên hãng gọn: "NIKON CORPORATION" -> "Nikon", "OLYMPUS IMAGING CORP." -> "Olympus"
function cleanMake(s) {
  s = s.replace(/\s+(corporation|corp\.?|co\.?,?\s*ltd\.?|imaging( corp\.?)?|optical( co.*)?|company|electronics|camera)\s*$/ig, '').trim();
  return /^[A-Z]{4,}$/.test(s) ? s[0] + s.slice(1).toLowerCase() : s;
}
function camName(make, model) {
  make = cleanMake(make || ''); model = (model || '').trim();
  if (!model) return make;
  if (make && model.toLowerCase().startsWith(make.toLowerCase())) return make + model.slice(make.length); // "NIKON D750" -> "Nikon D750"
  if (make && model.toLowerCase().startsWith(make.split(' ')[0].toLowerCase())) return model;
  return make ? make + ' ' + model : model;
}
const num = (v, d = 1) => Number.isFinite(v) && v > 0 ? Math.round(v * d) / d : undefined;

function fromTiff(buf, tiff) {
  const { ifd0, exif, gps } = parseTiff(buf, tiff);
  const str = (m, t) => typeof m.get(t) === 'string' && m.get(t) ? m.get(t).slice(0, 80) : undefined;
  const one = (m, t) => Array.isArray(m.get(t)) ? m.get(t)[0] : undefined;
  const out = {
    cam: camName(str(ifd0, 0x010F), str(ifd0, 0x0110)) || undefined,
    lens: str(exif, 0xA434),
    iso: num(one(exif, 0x8827)),
    f: num(one(exif, 0x829D), 10),
    exp: num(one(exif, 0x829A), 1e6),
    fl: num(one(exif, 0x920A), 10),
  };
  const lat = gps.get(2), lon = gps.get(4);
  if (Array.isArray(lat) && Array.isArray(lon) && lat.length >= 3 && lon.length >= 3) {
    const deg = a => a[0] + a[1] / 60 + a[2] / 3600;
    let la = deg(lat), lo = deg(lon);
    if (/^S/i.test(gps.get(1) || '')) la = -la;
    if (/^W/i.test(gps.get(3) || '')) lo = -lo;
    if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && (la || lo)) {
      out.lat = Math.round(la * 1e5) / 1e5; out.lon = Math.round(lo * 1e5) / 1e5;
    }
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// Khối EXIF: từ sharp ("Exif\0\0" + TIFF), hoặc tìm APP1 trong phần đầu file JPEG
function parseExif(buf) {
  try {
    if (buf.toString('latin1', 0, 4) === 'Exif') return fromTiff(buf, 6);
    if (buf.readUInt16BE(0) !== 0xFFD8) return {};
    let off = 2;
    while (off + 4 < buf.length) {
      const marker = buf.readUInt16BE(off), len = buf.readUInt16BE(off + 2);
      if (marker === 0xFFE1 && buf.readUInt32BE(off + 4) === 0x45786966) return fromTiff(buf, off + 10);
      if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break;
      off += 2 + len;
    }
  } catch { /* EXIF hỏng */ }
  return {};
}

// Ảnh (mọi định dạng sharp đọc được, kể cả HEIC): chỉ đọc phần đầu file, không giải mã ảnh
async function readImage(file) {
  if (sharp) {
    try { const { exif } = await sharp(file).metadata(); return exif ? parseExif(exif) : {}; }
    catch { /* sharp không đọc được: thử đọc tay phần đầu JPEG */ }
  }
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return parseExif(buf.subarray(0, bytesRead));
  } finally { await fh.close(); }
}

// Video: thẻ của ffprobe (xem video.probe). iPhone/Android ghi toạ độ dạng ISO 6709: "+10.7626+106.6601+012.000/"
function fromVideoTags(tags = {}) {
  const get = (...keys) => { for (const k of keys) for (const [n, v] of Object.entries(tags)) if (n.toLowerCase() === k && v) return String(v); return ''; };
  const out = {};
  const cam = camName(get('com.apple.quicktime.make', 'make'), get('com.apple.quicktime.model', 'model'));
  if (cam) out.cam = cam.slice(0, 80);
  const m = get('com.apple.quicktime.location.iso6709', 'location', 'location-eng').match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  if (m) {
    const la = Number(m[1]), lo = Number(m[2]);
    if (Math.abs(la) <= 90 && Math.abs(lo) <= 180 && (la || lo)) { out.lat = Math.round(la * 1e5) / 1e5; out.lon = Math.round(lo * 1e5) / 1e5; }
  }
  return out;
}

// ---------- Đoán nơi chụp: thành phố gần nhất ----------
const CELL = 1; // ô lưới 1 độ
let grid = null;
function loadCities() {
  grid = new Map();
  let text = '';
  try { text = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'data', 'cities.txt.gz'))).toString('utf8'); }
  catch (err) { console.error('Không đọc được data/cities.txt.gz, sẽ không đoán được nơi chụp:', err.message); }
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const [n, cc, la, lo, k] = line.split('|'), lat = Number(la), lon = Number(lo);
    const key = Math.floor(lat / CELL) + ':' + Math.floor(lon / CELL);
    if (!grid.has(key)) grid.set(key, []);
    // Thành phố lớn được "kéo" gần hơn tới 15 km: chụp ở trung tâm Sài Gòn thì ra "Hồ Chí Minh" chứ không phải huyện bên cạnh
    grid.get(key).push({ n, cc, lat, lon, bonus: Math.min(15, Math.max(0, 5 * Math.log10((Number(k) || 0) / 50))) });
  }
}
function km(a, b, c, d) {
  const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}
const MAX_KM = 100; // xa hơn thì không đoán (giữa biển, vùng hoang)
function place(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!grid) loadCities();
  const cy = Math.floor(lat / CELL), cx = Math.floor(lon / CELL);
  let best = null, bestKm = Infinity, bestScore = Infinity;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { // 5x5 ô quanh điểm: đủ xa hơn MAX_KM
      let x = cx + dx;
      if (x < -180) x += 360; else if (x >= 180) x -= 360;
      for (const c of grid.get((cy + dy) + ':' + x) || []) {
        const d = km(lat, lon, c.lat, c.lon), score = d - c.bonus;
        if (score < bestScore) { bestScore = score; bestKm = d; best = c; }
      }
  }
  return best && bestKm <= MAX_KM ? { n: best.n, cc: best.cc } : null;
}

module.exports = { parseExif, readImage, fromVideoTags, place };
