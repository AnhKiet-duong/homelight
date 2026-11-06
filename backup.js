// Sao lưu tự động: chép dữ liệu gallery sang một thư mục khác (ổ cứng ngoài, hoặc thư mục được OneDrive /
// Google Drive / Dropbox đồng bộ lên mạng). Cấu trúc trong <thư mục đã chọn>/homelight-backup/:
//   files/<id người dùng>/<file>   ảnh/video gốc: chỉ chép file mới (file gốc không bao giờ đổi nội dung, xem server.js)
//   snapshots/<thời điểm>/         mỗi lần sao lưu một bản: users.json, links.json, shares.json, settings.json,
//                                  users/<id>/photos.json + albums.json, manifest.json (thông tin để hiện danh sách)
// Ảnh nhỏ / video HLS không sao lưu (server tự tạo lại), ảnh trên ổ cứng ngoài (thư mục liên kết) cũng không
// (file gốc vẫn nằm trên ổ đó). Phiên đăng nhập không sao lưu.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const BACKUP_DIR = 'homelight-backup';
const STAMP_RE = /^\d{8}-\d{6}(-[a-z-]+)?$/;

const pad = n => String(n).padStart(2, '0');
function stampOf(d, reason) {
  const s = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return reason === 'before-restore' ? s + '-before-restore' : s;
}
const rootOf = dir => path.join(dir, BACKUP_DIR);
const exists = f => fsp.access(f).then(() => true, () => false);

async function writeFileAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file + '.tmp', data);
  await fsp.rename(file + '.tmp', file);
}

// Chép một file gốc; đã có bản cùng dung lượng thì bỏ qua (tên file là UUID nên nội dung không đổi)
async function copyOnce(src, dest) {
  const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(dest).catch(() => null)]);
  if (b && b.size === a.size) return 0;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest + '.tmp');
  await fsp.rename(dest + '.tmp', dest);
  return a.size;
}

// Danh sách bản sao lưu, mới nhất trước
async function listSnapshots(dir) {
  const snapDir = path.join(rootOf(dir), 'snapshots');
  const names = (await fsp.readdir(snapDir).catch(() => [])).filter(n => STAMP_RE.test(n)).sort().reverse();
  const out = [];
  for (const id of names) {
    const m = await fsp.readFile(path.join(snapDir, id, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (m) out.push({ id, ...m });
  }
  return out;
}

async function readSnapshot(dir, id) {
  if (!STAMP_RE.test(id)) throw new Error('Không tìm thấy bản sao lưu này');
  const base = path.join(rootOf(dir), 'snapshots', id);
  const read = (f, fallback) => fsp.readFile(path.join(base, f), 'utf8').then(JSON.parse, err => {
    if (fallback !== undefined && err.code === 'ENOENT') return fallback;
    throw new Error('Bản sao lưu bị hỏng hoặc thiếu file: ' + f);
  });
  const manifest = await read('manifest.json');
  const users = await read('users.json');
  if (!Array.isArray(users)) throw new Error('Bản sao lưu bị hỏng hoặc thiếu file: users.json');
  const data = { manifest, users, links: await read('links.json', []), shares: await read('shares.json', []), settings: await read('settings.json', {}), photos: {}, albums: {} };
  for (const u of users) {
    data.photos[u.id] = await read(`users/${u.id}/photos.json`, []);
    data.albums[u.id] = await read(`users/${u.id}/albums.json`, []);
  }
  return data;
}

// Xoá bản cũ quá số lượng giữ lại, rồi xoá file gốc không còn bản nào cần tới
async function prune(dir, keep) {
  const root = rootOf(dir), snapDir = path.join(root, 'snapshots');
  const all = (await fsp.readdir(snapDir).catch(() => [])).filter(n => STAMP_RE.test(n)).sort().reverse();
  for (const id of all.slice(keep)) await fsp.rm(path.join(snapDir, id), { recursive: true, force: true });
  // Bản dở (sao lưu bị ngắt giữa chừng)
  for (const n of await fsp.readdir(snapDir).catch(() => [])) if (n.endsWith('.tmp')) await fsp.rm(path.join(snapDir, n), { recursive: true, force: true });
  const needed = new Set();
  for (const id of all.slice(0, keep)) {
    let snap;
    try { snap = await readSnapshot(dir, id); } catch { return 0; } // đọc không được một bản: không xoá file nào cho chắc
    for (const [uid, list] of Object.entries(snap.photos)) for (const p of list) if (!p.link && p.file) needed.add(uid + '/' + p.file);
  }
  let removed = 0;
  const filesDir = path.join(root, 'files');
  for (const uid of await fsp.readdir(filesDir).catch(() => [])) {
    for (const f of await fsp.readdir(path.join(filesDir, uid)).catch(() => [])) {
      if (needed.has(uid + '/' + f)) continue;
      await fsp.unlink(path.join(filesDir, uid, f)).catch(() => {});
      removed++;
    }
  }
  return removed;
}

// Lần sao lưu gần nhất theo lịch: hằng ngày lúc <hour> giờ, hằng tuần lúc <hour> giờ Chủ nhật
function lastSlot(freq, hour, now = new Date()) {
  const s = new Date(now);
  s.setHours(hour, 0, 0, 0);
  if (s > now) s.setDate(s.getDate() - 1);
  if (freq === 'weekly') while (s.getDay() !== 0) s.setDate(s.getDate() - 1);
  return s.getTime();
}

/**
 * Chạy một lần sao lưu.
 * state: chụp ngay khi gọi (đồng bộ) nên dữ liệu khớp nhau: { users, links, shares, settings, photos: {uid: [...]}, albums: {uid: [...]} }
 * originalOf(uid, p): đường dẫn file gốc trên máy chủ
 * progress: object được cập nhật trong lúc chạy (để trang Tài khoản hiện tiến độ)
 */
async function run(dir, state, { originalOf, keep, reason = 'auto', progress = {} }) {
  const root = rootOf(dir), now = new Date();
  await fsp.mkdir(path.join(root, 'snapshots'), { recursive: true });
  await writeFileAtomic(path.join(root, 'README.txt'),
    'Thư mục này do homelight (gallery ảnh) tạo: các bản sao lưu tự động.\r\n' +
    'files/: ảnh và video gốc. snapshots/: danh sách ảnh, album, tài khoản ở từng thời điểm.\r\n' +
    'Khôi phục: trang Tài khoản > Sao lưu tự động > Khôi phục. Đừng sửa hay xoá file trong này bằng tay.\r\n');

  const jobs = [];
  for (const u of state.users) for (const p of state.photos[u.id] || []) if (!p.link && p.file) jobs.push([u.id, p]);
  Object.assign(progress, { phase: 'files', done: 0, total: jobs.length, copied: 0, bytes: 0, missing: 0 });
  for (const [uid, p] of jobs) {
    try {
      const n = await copyOnce(originalOf(uid, p), path.join(root, 'files', uid, p.file));
      if (n) { progress.copied++; progress.bytes += n; }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      progress.missing++; // file gốc đã mất trên máy chủ: bỏ qua
    }
    progress.done++;
  }

  progress.phase = 'snapshot';
  let id = stampOf(now, reason);
  while (await exists(path.join(root, 'snapshots', id))) { now.setSeconds(now.getSeconds() + 1); id = stampOf(now, reason); }
  const tmp = path.join(root, 'snapshots', id + '.tmp');
  const json = v => JSON.stringify(v, null, 2);
  const manifest = {
    created: now.getTime(), reason, users: state.users.length,
    photos: jobs.length + state.users.reduce((a, u) => a + (state.photos[u.id] || []).filter(p => p.link).length, 0),
    bytes: jobs.reduce((a, [, p]) => a + (p.size || 0), 0),
  };
  await writeFileAtomic(path.join(tmp, 'users.json'), json(state.users));
  await writeFileAtomic(path.join(tmp, 'links.json'), json(state.links));
  await writeFileAtomic(path.join(tmp, 'shares.json'), json(state.shares));
  await writeFileAtomic(path.join(tmp, 'settings.json'), json(state.settings));
  for (const u of state.users) {
    await writeFileAtomic(path.join(tmp, 'users', u.id, 'photos.json'), json(state.photos[u.id] || []));
    await writeFileAtomic(path.join(tmp, 'users', u.id, 'albums.json'), json(state.albums[u.id] || []));
  }
  await writeFileAtomic(path.join(tmp, 'manifest.json'), json(manifest)); // ghi cuối cùng: có manifest là bản đầy đủ
  await fsp.rename(tmp, path.join(root, 'snapshots', id));

  progress.phase = 'prune';
  const removed = await prune(dir, keep);
  return { id, ...manifest, copied: progress.copied, copiedBytes: progress.bytes, missing: progress.missing, removed };
}

// Chép lại file gốc còn thiếu trên máy chủ từ bản sao lưu (khi khôi phục)
async function restoreFiles(dir, snap, destOf, progress = {}) {
  const jobs = [];
  for (const u of snap.users) for (const p of snap.photos[u.id] || []) if (!p.link && p.file) jobs.push([u.id, p]);
  Object.assign(progress, { phase: 'restore', done: 0, total: jobs.length, copied: 0, missing: 0 });
  for (const [uid, p] of jobs) {
    const dest = destOf(uid, p);
    if (!await exists(dest)) {
      try { await copyOnce(path.join(rootOf(dir), 'files', uid, p.file), dest); progress.copied++; }
      catch (err) { if (err.code !== 'ENOENT') throw err; progress.missing++; }
    }
    progress.done++;
  }
  return progress;
}

module.exports = { BACKUP_DIR, rootOf, run, listSnapshots, readSnapshot, restoreFiles, lastSlot };
