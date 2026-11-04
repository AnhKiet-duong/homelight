// Xử lý video: nhận dạng định dạng, đọc thông tin (ffprobe), tạo ảnh bìa và bản HLS nhiều mức chất lượng (ffmpeg).
// HLS: video được cắt thành đoạn 4 giây ở 360p / 720p / 1080p / 1440p (2K) / 2160p (4K), trình xem tự đổi mức theo tốc độ mạng (như YouTube).
// Chế độ gọn nhẹ (mặc định, quản trị viên đổi trong trang Tài khoản): chỉ tạo 720p để đỡ tốn ổ đĩa.
// Cần ffmpeg + ffprobe: dùng bản cài trên máy nếu có, không thì dùng bản đóng gói sẵn do npm install tải về
// (@ffmpeg-installer/ffmpeg, @ffprobe-installer/ffprobe). Không có cả hai thì video vẫn xem được bằng file gốc.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const works = cmd => {
  try { return !!cmd && spawnSync(cmd, ['-version'], { windowsHide: true, timeout: 15000 }).status === 0; } catch { return false; }
};
const bundled = pkg => { try { return require(pkg).path; } catch { return null; } }; // gói npm chưa cài -> null

// Chọn ffmpeg theo thứ tự: FFMPEG_PATH -> ffmpeg cài trên máy (PATH) -> bản đóng gói qua npm
function pickTools() {
  const envFf = process.env.FFMPEG_PATH;
  if (envFf) {
    const fp = process.env.FFPROBE_PATH ||
      path.join(path.dirname(envFf), path.basename(envFf).replace(/ffmpeg/i, 'ffprobe'));
    return { ffmpeg: envFf, ffprobe: fp, source: 'FFMPEG_PATH' };
  }
  if (works('ffmpeg') && works('ffprobe')) return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', source: 'system' };
  const ff = bundled('@ffmpeg-installer/ffmpeg'), fp = bundled('@ffprobe-installer/ffprobe');
  if (ff && fp) return { ffmpeg: ff, ffprobe: fp, source: 'npm' };
  return { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', source: null };
}
const tools = pickTools();
const FFMPEG = tools.ffmpeg, FFPROBE = tools.ffprobe;
const hasFfmpeg = !!tools.source && works(FFMPEG) && works(FFPROBE);
// Nơi lấy ffmpeg (in ra khi khởi động): 'system' | 'npm' | 'FFMPEG_PATH' | null
const ffmpegSource = hasFfmpeg ? tools.source : null;

// Định dạng video nhận vào -> đuôi file lưu trên ổ đĩa
const VIDEO_TYPES = {
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi', 'video/3gpp': '.3gp', 'video/mp2t': '.mts',
};

// Các mức HLS, đặt theo cạnh ngắn của video (video dọc 720p là 720×1280).
// crf giữ chất lượng đều, maxrate là trần bitrate để mạng chậm vẫn xem mượt (kbps)
const QUALITIES = {
  360: { crf: 27, maxrate: 800, audio: 64, fps: 30 },
  720: { crf: 24, maxrate: 2500, audio: 96, fps: 30 },
  1080: { crf: 23, maxrate: 5000, audio: 128, fps: 60 },
  1440: { crf: 22, maxrate: 9000, audio: 128, fps: 60 },   // 2K: xem trong mạng nhà / mạng nhanh
  2160: { crf: 22, maxrate: 16000, audio: 160, fps: 60 },  // 4K
};
const SEGMENT_SECONDS = 4;

// Nhận dạng video bằng vài trăm byte đầu file (không tin vào đuôi file)
function sniffVideo(buf) {
  if (buf.length < 16) return null;
  const at = (o, n) => buf.toString('latin1', o, o + n);
  if (at(4, 4) === 'ftyp') {
    const brand = at(8, 4);
    if (/^(avi[fs]|hei[cxms]|hev[cx]|mif1|msf1|M4A |M4B |M4P |crx )$/.test(brand)) return null; // ảnh HEIC/AVIF, nhạc
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand.startsWith('3g')) return 'video/3gpp';
    return 'video/mp4';
  }
  if (/^(moov|mdat|wide|free|skip)$/.test(at(4, 4))) return 'video/quicktime'; // .mov đời cũ không có ftyp
  if (buf.readUInt32BE(0) === 0x1A45DFA3) return buf.includes('webm') ? 'video/webm' : 'video/x-matroska';
  if (at(0, 4) === 'RIFF' && at(8, 4) === 'AVI ') return 'video/x-msvideo';
  if (buf[0] === 0x47 && buf.length > 188 && buf[188] === 0x47) return 'video/mp2t';     // .ts
  if (buf[4] === 0x47 && buf.length > 196 && buf[196] === 0x47) return 'video/mp2t';     // .mts/.m2ts của máy quay
  return null;
}

// Mức HLS cần tạo cho video kích thước w×h.
// 'lite' (gọn nhẹ): chỉ một mức 720p (video gốc nhỏ hơn thì giữ cỡ gốc), cần nét hơn thì xem file gốc.
// 'full' (đầy đủ): luôn có 360p, mức cao hơn chỉ khi video gốc đủ nét
const LITE_LEVEL = 720;
function plan(w, h, mode = 'full') {
  if (mode === 'lite') return [LITE_LEVEL];
  const short = Math.min(w, h) || 0;
  return Object.keys(QUALITIES).map(Number).filter((q, i) => i === 0 || short >= q * 0.9);
}
// Kích thước khung hình của một mức (chẵn, không phóng to quá video gốc)
function frameSize(w, h, q) {
  if (!w || !h) return null;
  const k = Math.min(1, q / Math.min(w, h));
  const even = v => Math.max(2, Math.round(v * k / 2) * 2);
  return { w: even(w), h: even(h) };
}

function run(cmd, args, { key } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    try { os.setPriority(child.pid, 10); } catch { /* không đổi được độ ưu tiên thì thôi */ } // nhường CPU cho việc khác trên máy
    if (key) children.set(key, child);
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err = (err + d).slice(-4000); });
    child.on('error', reject);
    child.on('close', code => {
      if (key && children.get(key) === child) children.delete(key);
      if (child.killedByUs) reject(Object.assign(new Error('Đã huỷ'), { cancelled: true }));
      else if (code === 0) resolve(out);
      else reject(new Error(err.trim().split('\n').slice(-2).join(' ') || `${path.basename(cmd)} lỗi ${code}`));
    });
  });
}

// Thông tin video: kích thước hiển thị (đã xoay), thời lượng, fps, ngày quay
async function probe(file) {
  const j = JSON.parse(await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
  const v = (j.streams || []).find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!v) throw new Error('Không có hình trong file');
  const rot = Number((v.tags && v.tags.rotate) || ((v.side_data_list || []).find(d => d.rotation != null) || {}).rotation || 0);
  const swap = Math.abs(rot) % 180 === 90;
  const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || '0/1').split('/').map(Number);
  const created = Date.parse((j.format.tags && j.format.tags.creation_time) || (v.tags && v.tags.creation_time) || '');
  return {
    w: (swap ? v.height : v.width) || 0,
    h: (swap ? v.width : v.height) || 0,
    duration: Math.round((Number(j.format.duration) || Number(v.duration) || 0) * 10) / 10,
    fps: d ? n / d : 0,
    taken: created > Date.UTC(1971, 0, 1) ? created : null, // máy quay chưa đặt giờ hay ghi năm 1904/1970
  };
}

// Hàng đợi: tối đa một ffmpeg mỗi loại cùng lúc (ảnh bìa nhanh nên đi riêng, không phải chờ video dài đang chuyển đổi).
// slot (video trên ổ ngoài, do server cấp): chỉ lấy việc khi ổ đó rảnh, giữ ổ trong lúc làm; ổ bị rút / ngắt thì huỷ.
// urgent (có người đang chờ xem) thì không chờ ổ rảnh
const cancelledErr = () => Object.assign(new Error('Đã huỷ'), { cancelled: true });
function lane() {
  const waiting = [];
  let busy = false;
  const pump = () => {
    if (busy) return;
    const i = waiting.findIndex(j => !j.slot || j.urgent || j.slot.free());
    if (i < 0) return;
    busy = true;
    const { fn, resolve, reject, slot } = waiting.splice(i, 1)[0];
    const release = slot ? slot.take() : () => {};
    Promise.resolve().then(() => { if (slot && !slot.ok()) throw cancelledErr(); return fn(); })
      .then(resolve, reject).finally(() => { busy = false; release(); pump(); });
  };
  const add = (fn, urgent, slot) => new Promise((resolve, reject) => {
    const job = { fn, resolve, reject, urgent, slot };
    urgent ? waiting.unshift(job) : waiting.push(job);
    pump();
  });
  add.pump = pump;
  return add;
}
const posterLane = lane(), hlsLane = lane();
// Server gọi khi một ổ vừa rảnh: lấy tiếp việc đang chờ ổ đó
const pump = () => { posterLane.pump(); hlsLane.pump(); };
const children = new Map(); // key -> tiến trình ffmpeg đang chạy (để huỷ khi xoá video)

// Ảnh bìa: một khung hình gần đầu video (bỏ qua giây đầu thường tối đen)
function makePoster(src, out, info, urgent, slot) {
  return posterLane(async () => {
    const size = info.w && info.h ? frameSize(info.w, info.h, Math.min(1080, Math.min(info.w, info.h))) : null;
    const grab = at => run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-ss', String(at), '-i', src, '-frames:v', '1',
      ...(size ? ['-vf', `scale=${size.w}:${size.h}`] : []), '-q:v', '3', out + '.tmp.jpg']);
    const at = info.duration > 2 ? Math.min(info.duration * 0.1, 3) : 0;
    await grab(at);
    if (!(await fsp.stat(out + '.tmp.jpg').catch(() => null))?.size) await grab(0); // tua quá cuối file -> lấy khung đầu
    await fsp.rename(out + '.tmp.jpg', out);
  }, urgent, slot);
}

// Một mức HLS: <dir>/<q>/index.m3u8 + seg0000.ts … Tạo trong thư mục tạm rồi đổi tên khi xong,
// nên mức nào có thư mục là đã hoàn chỉnh.
// src, dir: đường dẫn hoặc hàm trả về đường dẫn (tính lúc bắt đầu chạy). slot: xem lane()
function makeRendition(src, dir, q, info, key, stillWanted = () => true, slot = null) {
  return hlsLane(async () => {
    if (!stillWanted()) throw cancelledErr(); // video bị xoá / ổ bị rút khi đang chờ
    if (typeof src === 'function') src = src();
    if (typeof dir === 'function') dir = dir();
    const s = QUALITIES[q], size = frameSize(info.w, info.h, q);
    const out = path.join(dir, String(q)), tmp = out + '.tmp';
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.mkdir(tmp, { recursive: true });
    const filters = [size ? `scale=${size.w}:${size.h}` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2'];
    if (info.fps > s.fps + 1) filters.push(`fps=${s.fps}`);
    try {
      if (!stillWanted()) throw cancelledErr(); // bị huỷ trong lúc chuẩn bị thư mục: không chạy ffmpeg nữa
      await run(FFMPEG, [
        '-hide_banner', '-nostdin', '-y', '-i', src,
        '-map', '0:v:0', '-map', '0:a:0?', '-vf', filters.join(','),
        '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
        '-crf', String(s.crf), '-maxrate', s.maxrate + 'k', '-bufsize', s.maxrate * 2 + 'k',
        // khung hình khoá đúng mỗi 4 giây ở mọi mức -> các đoạn khớp nhau, đổi mức giữa chừng không bị giật
        '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`, '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', s.audio + 'k', '-ac', '2',
        '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'vod',
        '-hls_segment_filename', path.join(tmp, 'seg%04d.ts'),
        '-nostats', path.join(tmp, 'index.m3u8'),
      ], { key });
      await fsp.rm(out, { recursive: true, force: true });
      await fsp.rename(tmp, out);
    } catch (err) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    // Bitrate thật của mức này (để ghi vào danh sách phát chính)
    let bytes = 0;
    for (const f of await fsp.readdir(out)) bytes += (await fsp.stat(path.join(out, f))).size;
    return { kbps: info.duration ? Math.round(bytes * 8 / info.duration / 1000) : s.maxrate, ...(size || {}) };
  }, false, slot);
}

// Huỷ ffmpeg đang chạy cho video này (khi xoá video). Chờ tiến trình thoát để Windows nhả file
function cancel(key) {
  const child = children.get(key);
  if (!child) return Promise.resolve();
  child.killedByUs = true;
  return new Promise(resolve => { child.once('close', resolve); child.kill(); });
}

// Danh sách phát chính: liệt kê các mức đã xong, trình phát tự chọn theo tốc độ mạng
function masterPlaylist(renditions) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const [q, r] of Object.entries(renditions).sort((a, b) => a[0] - b[0])) {
    const bw = Math.round(r.kbps * 1000 * 1.15); // cộng thêm phần dao động bitrate
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw},AVERAGE-BANDWIDTH=${r.kbps * 1000}` +
      (r.w ? `,RESOLUTION=${r.w}x${r.h}` : ''), `${q}/index.m3u8`);
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  hasFfmpeg, ffmpegSource, VIDEO_TYPES, QUALITIES, LITE_LEVEL, sniffVideo, plan, probe, makePoster, makeRendition, cancel, masterPlaylist, pump,
};
