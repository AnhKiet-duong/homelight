// Đa ngôn ngữ (en/vi). Chữ tiếng Việt trong code chính là khoá; tiếng Anh tra trong từ điển, không có thì giữ nguyên.
// Chạy đồng bộ trong <head> để trang hiện đúng ngôn ngữ ngay từ đầu, không nháy.
(() => {
  const LANGS = ['en', 'vi'];
  // 'lang' là ngôn ngữ đang dùng; 'langAcct' đánh dấu giá trị đó chép từ tài khoản (không phải chọn ở trang đăng nhập)
  const ACCT = 'langAcct';
  const read = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const write = (k, v) => {
    try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* trình duyệt chặn lưu */ }
  };
  const stored = () => { const v = read('lang'); return LANGS.includes(v) ? v : null; };

  const lang = stored() || 'en';
  const dict = Object.create(null); // không có prototype: t('constructor') không dính thuộc tính có sẵn
  document.documentElement.lang = lang;

  // Lỗi server có giá trị thay đổi: khi không có tham số thì so khớp cả câu rồi lấy lại giá trị
  const SERVER_PATTERNS = {
    'Cổng đang được đặt bằng biến môi trường PORT={0} khi chạy server. Bỏ biến đó rồi chạy lại server để đổi cổng ở đây.':
      'The port is set by the PORT={0} environment variable. Remove it and restart the server to change the port here.',
    'Cổng {0} đang được chương trình khác dùng, hãy chọn cổng khác': 'Port {0} is in use by another program. Choose a different port.',
    'Máy chủ không cho mở cổng {0}, hãy chọn cổng khác': 'The server cannot open port {0}. Choose a different port.',
    'Định dạng không được hỗ trợ: {0}': 'Unsupported format: {0}',
    'Video quá lớn (tối đa {0} MB)': 'Video is too large (max {0} MB)',
    'Trùng với thư mục đã liên kết "{0}" ({1})': 'Overlaps the linked folder "{0}" ({1})',
    'Trùng với thư mục đã liên kết "{0}"': 'Overlaps the linked folder "{0}"',
    'Thư mục này nằm trong thư mục liên kết "{0}", hãy chọn chỗ khác': 'This folder is inside the linked folder "{0}". Choose another place.',
    'Không sao lưu được dữ liệu hiện tại trước khi khôi phục: {0}': 'Could not back up the current data before restoring: {0}',
    'Bản sao lưu bị hỏng hoặc thiếu file: {0}': 'The backup is damaged or missing a file: {0}',
    'Tối đa {0} link chia sẻ': 'At most {0} share links',
  };
  const patterns = Object.entries(SERVER_PATTERNS).map(([vi, en]) => ({
    re: new RegExp('^' + vi.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\d+\\\}/g, '(.*)') + '$', 's'),
    en,
  }));

  Object.assign(dict, SERVER_PATTERNS, {
    'Tên đăng nhập 3–32 ký tự, chỉ gồm chữ thường không dấu, số và . _ -': 'Username must be 3–32 characters: lowercase letters, numbers and . _ -',
    'Mật khẩu cần ít nhất 8 ký tự': 'Password must be at least 8 characters',
    'Tên đăng nhập đã có người dùng': 'That username is already taken',
    'File quá lớn': 'File is too large',
    'Cần gửi dữ liệu dạng JSON': 'Request must be JSON',
    'JSON không hợp lệ': 'Invalid JSON',
    'Đã có tài khoản quản trị': 'An admin account already exists',
    'Hãy mở trang này ngay trên máy chạy server để tạo tài khoản đầu tiên': 'Open this page on the server machine to create the first account',
    'Sai mật khẩu quá nhiều lần, hãy thử lại sau 15 phút': 'Too many failed attempts. Try again in 15 minutes.',
    'Sai tên đăng nhập hoặc mật khẩu': 'Incorrect username or password',
    'Cần đăng nhập': 'Please sign in',
    'Tuỳ chọn không hợp lệ': 'Invalid setting',
    'Hãy chọn thư mục sao lưu': 'Choose a backup folder',
    'Không thấy thư mục sao lưu (ổ đã cắm chưa?)': 'Backup folder not found (is the drive plugged in?)',
    'Số bản giữ lại từ 1 đến 100': 'Keep between 1 and 100 copies',
    'Đang khôi phục, đợi chút nhé': 'A restore is running, please wait',
    'Đang khôi phục dữ liệu từ bản sao lưu, thử lại sau ít phút': 'Restoring data from a backup, try again in a few minutes',
    'Không tìm thấy bản sao lưu này': 'Backup not found',
    'Bản sao lưu không có tài khoản quản trị': 'This backup has no admin account',
    'Đây là thư mục sao lưu của gallery': 'This is the gallery backup folder',
    'Mật khẩu hiện tại không đúng': 'Current password is incorrect',
    'Chỉ quản trị viên mới làm được': 'Admins only',
    'Cổng phải là số từ 1024 đến 65535': 'Port must be a number from 1024 to 65535',
    'Không tìm thấy tài khoản': 'Account not found',
    'Không thể tự đổi quyền của chính mình': 'You cannot change your own role',
    'Không thể tự xoá tài khoản của chính mình': 'You cannot delete your own account',
    'Cần danh sách ảnh và trạng thái công khai': 'A photo list and public status are required',
    'Định dạng không được hỗ trợ: không rõ': 'Unsupported format: unknown',
    'File rỗng': 'File is empty',
    'Không nhận ra ảnh HEIC': 'Not a valid HEIC image',
    'Không nhận ra định dạng video': 'Unrecognized video format',
    'Không tìm thấy ảnh': 'Photo not found',
    'Không tìm thấy': 'Not found',
    'Tải lên bị gián đoạn': 'Upload was interrupted',
    'Hãy đặt tên cho album': 'Enter an album name',
    'Danh sách ảnh không hợp lệ': 'Invalid photo list',
    'Đã có quá nhiều album': 'Too many albums',
    'Không tìm thấy album': 'Album not found',
    'Hãy chọn thư mục': 'Choose a folder',
    'Cần đường dẫn đầy đủ, vd. E:\\Anh': 'Enter a full path, e.g. E:\\Photos',
    'Không tìm thấy thư mục này (ổ đã cắm chưa?)': 'Folder not found (is the drive connected?)',
    'Đây là thư mục của chính gallery': "This is the gallery's own folder",
    'Không mở được thư mục này': 'Cannot open this folder',
    'Không tìm thấy thư mục liên kết': 'Linked folder not found',
    'Ổ đĩa chứa ảnh này đang không cắm vào máy chủ': "The drive with this photo isn't connected to the server",
    'Video chưa có bản HLS': 'Video is not ready for streaming yet',
    'Lỗi server': 'Server error',
    'Chưa chọn ảnh nào': 'No photos selected',
    'Link không tồn tại hoặc đã bị thu hồi': "This link doesn't exist or has been revoked",
    'Link này đã hết hạn': 'This link has expired',
    'Sai mật khẩu': 'Wrong password',
    'Nhập sai quá nhiều lần, thử lại sau ít phút': 'Too many wrong attempts. Try again in a few minutes.',
    'Mật khẩu link cần ít nhất 4 ký tự': 'The link password needs at least 4 characters',
    'Thời hạn không hợp lệ': 'Invalid expiry',
    'Không tìm thấy link': 'Link not found',
  });

  // Thay {0} {1} một lượt: giá trị có sẵn "{1}" hay "$&" (tên file) vẫn giữ nguyên
  const fill = (s, args) => args.length ? s.replace(/\{(\d+)\}/g, (m, i) => i < args.length ? args[i] : m) : s;

  function t(key, ...args) {
    if (typeof key !== 'string') return key; // vd. data.error không có
    if (lang === 'vi') return fill(key, args);
    if (dict[key] !== undefined) return fill(dict[key], args);
    if (!args.length) {
      for (const { re, en } of patterns) {
        const m = key.match(re);
        if (m) return fill(en, m.slice(1));
      }
    }
    return fill(key, args);
  }

  // Dịch một chuỗi tĩnh: bỏ khoảng trắng hai đầu khi so khớp rồi trả lại; xuống dòng giữa câu trong HTML coi như một dấu cách
  function translated(s) {
    const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const hit = m[2] && dict[m[2].replace(/\s+/g, ' ')];
    return hit === undefined || !m[2] ? null : m[1] + hit + m[3];
  }

  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  const SKIP = new Set(['SCRIPT', 'STYLE']);

  // Chỉ gọi cho phần HTML tĩnh. Tên ảnh, tên album là dữ liệu người dùng, không bao giờ đi qua đây
  function apply(root = document) {
    document.documentElement.lang = lang;
    if (lang === 'vi') return;
    const title = translated(document.title);
    if (title !== null) document.title = title;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      if (SKIP.has(n.parentNode.nodeName)) continue;
      const v = translated(n.nodeValue);
      if (v !== null) n.nodeValue = v;
    }
    const els = [...root.querySelectorAll(ATTRS.map(a => `[${a}]`).join())];
    if (root.getAttribute) els.push(root);
    for (const el of els) {
      for (const a of ATTRS) {
        if (!el.hasAttribute(a)) continue;
        const v = translated(el.getAttribute(a));
        if (v !== null) el.setAttribute(a, v);
      }
    }
  }

  const postLang = l => fetch('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: l }) });

  let switching = false;
  // Đổi ngôn ngữ: lưu vào máy, lưu vào tài khoản nếu đã đăng nhập (chưa đăng nhập server trả 401), xong mới tải lại
  async function set(next) {
    if (!LANGS.includes(next)) return;
    switching = true;
    write('lang', next);
    let saved = false;
    try { saved = (await postLang(next)).ok; } catch { /* lần tải sau sẽ đồng bộ lại */ }
    write(ACCT, saved ? '1' : null);
    location.reload();
  }

  // Đồng bộ với tài khoản: ngôn ngữ đã lưu luôn thắng; tải lại chỉ khi đã ghi được vào máy, tránh tải lại mãi
  function sync(prefs) {
    if (!prefs || switching) return;
    if (LANGS.includes(prefs.lang)) {
      write('lang', prefs.lang);
      write(ACCT, '1');
      if (prefs.lang !== lang && stored() === prefs.lang) location.reload();
      return;
    }
    const local = stored();
    if (!local) return;
    if (read(ACCT)) {
      // Giá trị của tài khoản trước trên trình duyệt này: tài khoản mới vẫn mặc định tiếng Anh
      write('lang', null);
      write(ACCT, null);
      if (lang !== 'en') location.reload();
      return;
    }
    // Vừa chọn ở trang đăng nhập: lưu vào tài khoản
    postLang(local).then(r => { if (r.ok) write(ACCT, '1'); }).catch(() => {});
  }

  fetch('/api/status').then(r => r.ok ? r.json() : null).then(s => sync(s && s.prefs)).catch(() => {});

  window.t = t; // gán vào window: script của trang vẫn được khai báo biến t riêng
  window.i18n = {
    lang,
    locale: lang === 'vi' ? 'vi-VN' : 'en-US',
    t,
    add(d) { Object.assign(dict, d); },
    apply,
    set,
  };
})();
