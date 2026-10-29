// Xử lý ảnh: nhận dạng định dạng, đọc ngày chụp EXIF, tạo ảnh nhỏ (thumbnail) cho mạng chậm.
// Ảnh nhỏ cần thư viện "sharp" (npm install). Không có sharp thì mọi thứ vẫn chạy, chỉ là luôn gửi ảnh gốc.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

let sharp = null;
try {
  sharp = require('sharp');
  sharp.cache(false);      // không giữ file ảnh trong RAM giữa các lần xử lý
  sharp.concurrency(1);    // mỗi ảnh 1 luồng, để server vẫn nhanh khi đang tạo ảnh nhỏ
} catch { /* chưa cài sharp */ }

// sm: ảnh trong lưới (~40 KB), ph: xem phóng to trên điện thoại (~100 KB), md: xem phóng to trên máy tính (~250 KB).
// Ảnh gốc chỉ tải khi bấm "Ảnh gốc" hoặc tải xuống.
const SIZES = {
  sm: { w: 600, h: 1500, q: 70 },
  ph: { w: 1080, h: 1920, q: 76 },
  md: { w: 1920, h: 1920, q: 78 },
};

// Nhận dạng ảnh bằng vài byte đầu file (không tin vào đuôi file)
function sniffType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.readUInt32BE(0) === 0x89504E47) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && /^avi[fs]$/.test(buf.toString('latin1', 8, 12))) return 'image/avif';
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'image/bmp';
  return null;
}

// Đọc ngày chụp (EXIF DateTimeOriginal) từ ảnh JPEG — giống exifDate() trong index.html
function exifDate(buf) {
  try {
    if (buf.readUInt16BE(0) !== 0xFFD8) return null;
    let off = 2;
    while (off + 4 < buf.length) {
      const marker = buf.readUInt16BE(off), len = buf.readUInt16BE(off + 2);
      if (marker === 0xFFE1 && buf.readUInt32BE(off + 4) === 0x45786966) { // "Exif"
        const tiff = off + 10, le = buf.readUInt16BE(tiff) === 0x4949;
        const u16 = o => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
        const u32 = o => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
        const findTag = (ifd, tag) => {
          const n = u16(ifd);
          for (let i = 0; i < n; i++) if (u16(ifd + 2 + i * 12) === tag) return ifd + 2 + i * 12;
          return -1;
        };
        const exifPtr = findTag(tiff + u32(tiff + 4), 0x8769);
        if (exifPtr < 0) return null;
        const dt = findTag(tiff + u32(exifPtr + 8), 0x9003);
        if (dt < 0) return null;
        const start = tiff + u32(dt + 8);
        const m = buf.toString('latin1', start, start + 19).match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
        if (!m || m[1] === '0000') return null;
        return new Date(m[1], m[2] - 1, m[3], m[4], m[5], m[6]).getTime() || null;
      }
      if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break;
      off += 2 + len;
    }
  } catch { /* EXIF hỏng */ }
  return null;
}

// Kích thước hiển thị (đã xoay theo EXIF) — cần sharp
async function imageSize(file) {
  if (!sharp) return { w: 0, h: 0 };
  try {
    const m = await sharp(file).metadata();
    const swap = (m.orientation || 1) >= 5;
    return { w: (swap ? m.height : m.width) || 0, h: (swap ? m.width : m.height) || 0 };
  } catch { return { w: 0, h: 0 }; }
}

const variantPath = (dir, id, size) => path.join(dir, `${id}-${size}.webp`);

// Tạo các cỡ ảnh còn thiếu (WebP); trả về màu trung bình "r g b" (làm nền lúc ảnh đang tải) và kích thước ảnh gốc
async function makeVariants(src, dir, id) {
  await fsp.mkdir(dir, { recursive: true });
  const base = sharp(src, { animated: false, limitInputPixels: 300e6 }).rotate(); // xoay theo EXIF
  for (const [size, s] of Object.entries(SIZES)) {
    const out = variantPath(dir, id, size);
    if (await fsp.access(out).then(() => true, () => false)) continue; // đã có (vd. ảnh cũ chỉ thiếu cỡ mới thêm)
    await base.clone().resize(s.w, s.h, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: s.q, effort: 4 }).toFile(out + '.tmp');
    await fsp.rename(out + '.tmp', out);
  }
  const { channels } = await sharp(variantPath(dir, id, 'sm')).stats();
  return { color: channels.slice(0, 3).map(c => Math.round(c.mean)).join(' '), ...await imageSize(src) };
}

// Hàng đợi: tạo tối đa 2 ảnh cùng lúc, cùng một ảnh thì chỉ tạo một lần.
// urgent: có người đang chờ xem ảnh này -> chen lên đầu hàng (trước các ảnh cũ đang tạo dần)
const jobs = new Map();   // key -> { promise, entry }
const waiting = [];
let running = 0;
function queueVariants(src, dir, id, urgent = false) {
  if (!sharp) return Promise.resolve(null);
  const key = path.join(dir, id);
  let job = jobs.get(key);
  if (!job) {
    const entry = { run: () => makeVariants(src, dir, id) };
    job = { entry, promise: new Promise((resolve, reject) => Object.assign(entry, { resolve, reject })) };
    jobs.set(key, job);
    job.promise.catch(() => {}).finally(() => jobs.delete(key));
    urgent ? waiting.unshift(entry) : waiting.push(entry);
  } else if (urgent) {
    const i = waiting.indexOf(job.entry);
    if (i > 0) waiting.unshift(...waiting.splice(i, 1));
  }
  pump();
  return job.promise;
}
function pump() {
  while (running < 2 && waiting.length) {
    const { run, resolve, reject } = waiting.shift();
    running++;
    run().then(resolve, reject).finally(() => { running--; pump(); });
  }
}

module.exports = { hasSharp: !!sharp, SIZES, sniffType, exifDate, imageSize, variantPath, queueVariants };
