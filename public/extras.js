// Các bảng công cụ của trang chính: thùng rác (và sau này dòng thời gian, bản đồ, ảnh trùng).
// Tải khi mở lần đầu từ menu "Thêm" (xem openTool trong index.html). Dùng chung biến và hàm của index.html:
// $, t, tn, esc, toast, photos, load, jsonHeaders, isVideo, fmtSize, i18n
const extras = (() => {
  const css = `
  .xp { position: fixed; inset: 0; z-index: 150; display: grid; place-items: center; padding: 24px; background: rgba(0,0,0,.55);
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); opacity: 0; transition: opacity .25s; }
  .xp.show { opacity: 1; }
  .xp-box { display: flex; flex-direction: column; width: min(1100px, 100%); height: min(860px, calc(100dvh - 48px)); overflow: hidden;
    border-radius: 24px; background: #111115; border: 1px solid var(--line); box-shadow: 0 40px 100px -30px rgba(0,0,0,.8);
    transform: translateY(14px); transition: transform .3s var(--ease); }
  .xp.show .xp-box { transform: none; }
  .xp-head { display: flex; align-items: flex-start; gap: 16px; padding: 22px 24px 16px; border-bottom: 1px solid var(--line); }
  .xp-head h2 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -.01em; }
  .xp-head p { margin: 4px 0 0; font-size: 13px; color: var(--muted); }
  .xp-x { margin-left: auto; flex: none; width: 40px; height: 40px; display: grid; place-items: center; border: 0; border-radius: 999px; background: var(--surface-2); color: var(--text); }
  .xp-x svg { width: 18px; height: 18px; }
  .xp-body { flex: 1; overflow-y: auto; padding: 18px 24px 24px; overscroll-behavior: contain; }
  .xp-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 24px; border-top: 1px solid var(--line); }
  .xp-foot:empty { display: none; }
  .xp-foot .grow { flex: 1; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .xp-foot .btn { height: 38px; padding: 0 16px; font-size: 13px; }
  .xp-foot .btn:disabled { opacity: .4; pointer-events: none; }
  .xp-foot .danger { color: #ff8a80; }
  .xp-empty { display: grid; place-items: center; text-align: center; min-height: 260px; color: var(--muted); font-size: 14px; }
  .xp-empty b { display: block; margin-bottom: 6px; font-size: 17px; color: var(--text); font-weight: 600; }
  body:has(.xp.show) .toast { bottom: calc(88px + env(safe-area-inset-bottom)); } /* không che hàng nút */
  .xp-note { margin: 0 0 14px; font-size: 13px; color: var(--faint); }

  .tr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 10px; }
  .tr-it { position: relative; aspect-ratio: 1; padding: 0; border: 0; border-radius: 14px; overflow: hidden; background: var(--surface-2); cursor: pointer; }
  .tr-it img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .25s var(--ease), opacity .25s; }
  .tr-it .d { position: absolute; left: 6px; bottom: 6px; padding: 3px 8px; border-radius: 999px; background: rgba(0,0,0,.6); color: #fff; font-size: 11px; font-weight: 500; }
  .tr-it .v { position: absolute; right: 6px; bottom: 6px; padding: 3px 7px; border-radius: 999px; background: rgba(0,0,0,.6); color: #fff; font-size: 11px; }
  .tr-it .ck { position: absolute; top: 8px; left: 8px; width: 24px; height: 24px; border-radius: 999px; border: 2px solid rgba(255,255,255,.9);
    background: rgba(0,0,0,.25); display: grid; place-items: center; color: #0b0b0d; }
  .tr-it .ck svg { width: 14px; height: 14px; opacity: 0; }
  .tr-it.on { box-shadow: 0 0 0 3px var(--gold); }
  .tr-it.on img { transform: scale(.94); opacity: .85; }
  .tr-it.on .ck { background: var(--gold); border-color: var(--gold); }
  .tr-it.on .ck svg { opacity: 1; }
  .tr-it:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; }

  .xp-body.flush { padding: 0; position: relative; overflow: hidden; }
  .map { position: absolute; inset: 0; background: #1a1b20; font: inherit; }
  html[data-theme="paper"] .map { background: #eae3d6; } html[data-theme="bento"] .map { background: #e6eaf2; }
  .pm { position: relative; width: 52px; height: 52px; }
  .pm i { position: absolute; inset: 0; background: #ccc center / cover no-repeat; border-radius: 12px; border: 3px solid #fff; box-shadow: 0 6px 16px rgba(0,0,0,.35); }
  .pm b { position: absolute; top: -8px; right: -10px; min-width: 24px; height: 24px; padding: 0 7px; border-radius: 999px; background: var(--gold); color: #0b0b0d;
    font: 600 12px/24px var(--sans, system-ui); text-align: center; box-shadow: 0 2px 6px rgba(0,0,0,.3); }
  html[data-theme="paper"] .pm i { border-radius: 2px; } html[data-theme="paper"] .pm b, html[data-theme="bento"] .pm b { color: #fff; }
  .pm.big { width: 64px; height: 64px; }
  .map .leaflet-control-attribution { font-size: 10px; }
  .map-msg { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; padding: 24px; color: var(--muted); font-size: 14px; }
  .dup-g { margin-bottom: 22px; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
  .dup-g:last-child { border-bottom: 0; }
  .dup-h { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-size: 13px; color: var(--muted); }
  .dup-h b { color: var(--text); font-weight: 600; }
  .dup-h label { margin-left: auto; display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .dup-h input { accent-color: var(--gold); }
  .dup-g.skip .dup-row { opacity: .4; }
  .dup-row { display: flex; align-items: flex-start; gap: 10px; overflow-x: auto; padding: 3px 3px 6px; scrollbar-width: thin; }
  .dup-it { flex: none; width: 168px; padding: 0; border: 0; background: none; color: inherit; text-align: left; cursor: pointer; font: inherit; }
  .dup-it .ph { position: relative; height: 128px; border-radius: 12px; overflow: hidden; background: var(--surface-2); }
  .dup-it img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .dup-it .tag { position: absolute; top: 6px; left: 6px; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: rgba(0,0,0,.65); color: #fff; }
  .dup-it.keep .ph { box-shadow: 0 0 0 3px var(--gold); }
  .dup-it.keep .tag { background: var(--gold); color: #0b0b0d; }
  .dup-it:not(.keep) img { opacity: .55; }
  .dup-it .cap { margin-top: 6px; font-size: 12px; line-height: 1.4; color: var(--muted); }
  .dup-it .cap b { display: block; color: var(--text); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dup-it:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; border-radius: 12px; }
  html[data-theme="paper"] .dup-it .ph { border-radius: 2px; } html[data-theme="paper"] .dup-it.keep .tag, html[data-theme="bento"] .dup-it.keep .tag { color: #fff; }
  html[data-theme="bento"] .dup-it .ph { border-radius: 16px; background: var(--tile); }
  .sh-new { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; align-items: end; margin-bottom: 8px; }
  .sh-f { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--muted); }
  .sh-f :is(input, select) { height: 40px; padding: 0 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface-2); color: var(--text); font: inherit; font-size: 14px; min-width: 0; color-scheme: dark; }
  html[data-theme="paper"] .sh-f :is(input, select), html[data-theme="bento"] .sh-f :is(input, select) { color-scheme: light; background: var(--bg); }
  .sh-chk { flex-direction: row; align-items: center; gap: 8px; height: 40px; font-size: 13px; color: var(--text); cursor: pointer; }
  .sh-chk input { width: 16px; height: 16px; accent-color: var(--gold); }
  .sh-new .btn { height: 40px; }
  .sh-warn { margin: 6px 0 16px; padding: 10px 14px; border-radius: 12px; background: color-mix(in srgb, var(--gold) 14%, transparent); font-size: 13px; line-height: 1.5; }
  .sh-h { margin: 22px 0 10px; font-size: 12px; letter-spacing: .16em; text-transform: uppercase; color: var(--faint); }
  .sh-it { padding: 14px 0; border-top: 1px solid var(--line); }
  .sh-it.off { opacity: .55; }
  .sh-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .sh-row input { flex: 1 1 260px; min-width: 0; height: 38px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface-2); color: var(--text); font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
  html[data-theme="paper"] .sh-row input, html[data-theme="bento"] .sh-row input { background: var(--bg); }
  .sh-row .btn { height: 38px; padding: 0 14px; font-size: 13px; }
  .sh-meta { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--muted); }
  .sh-meta b { color: var(--text); font-weight: 600; }
  .sh-it .danger { color: #ff8a80; }
  html[data-theme="paper"] .sh-it .danger, html[data-theme="bento"] .sh-it .danger { color: #c62828; }
  html[data-theme="paper"] .xp { background: rgba(60,40,20,.35); }
  html[data-theme="paper"] .xp-box { background: var(--card); border-radius: 4px; border: 0; box-shadow: 0 40px 90px -30px rgba(60,40,20,.55); }
  html[data-theme="paper"] .xp-head { border-bottom: 2px solid var(--text); margin: 0 24px; padding: 24px 0 14px; }
  html[data-theme="paper"] .xp-head h2 { font-family: var(--serif); font-weight: 400; font-size: 30px; }
  html[data-theme="paper"] .xp-x { background: var(--bg); }
  html[data-theme="paper"] .tr-it { border-radius: 2px; background: var(--paper-2); }
  html[data-theme="paper"] .xp-foot .danger { color: #b3261e; }
  html[data-theme="bento"] .xp { background: rgba(17,19,26,.35); }
  html[data-theme="bento"] .xp-box { background: var(--bg); border: 0; border-radius: 28px; box-shadow: 0 40px 90px -30px rgba(17,19,26,.5); }
  html[data-theme="bento"] .xp-head { border: 0; }
  html[data-theme="bento"] .xp-x { background: var(--tile); }
  html[data-theme="bento"] .xp-foot { border: 0; background: var(--tile); }
  html[data-theme="bento"] .tr-it { border-radius: 18px; background: var(--tile); }
  html[data-theme="bento"] .xp-foot .danger { color: #d93025; }
  .xp-box.xp-sm { width: min(600px, 100%); height: auto; max-height: calc(100dvh - 48px); }
  .in-top { display: flex; gap: 16px; align-items: center; margin-bottom: 18px; }
  .in-top img { width: 64px; height: 64px; border-radius: 16px; flex: none; }
  .in-top p { margin: 0; font-size: 14px; line-height: 1.55; }
  .in-box { padding: 14px 16px; border-radius: 14px; background: var(--surface-2); font-size: 14px; line-height: 1.6; }
  html[data-theme="paper"] .in-box { background: var(--bg); border-radius: 4px; }
  html[data-theme="bento"] .in-box { background: var(--tile); border-radius: 18px; }
  .in-box ol { margin: 6px 0 0; padding-left: 22px; }
  .in-box .k { display: inline-flex; vertical-align: -4px; width: 20px; height: 20px; }
  .in-box .k svg { width: 20px; height: 20px; }
  .in-go { margin-top: 14px; height: 42px; padding: 0 22px; }
  .in-h { margin: 22px 0 8px; font-size: 12px; letter-spacing: .16em; text-transform: uppercase; color: var(--faint); }
  .in-l { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.6; color: var(--muted); }
  .in-l li + li { margin-top: 4px; }
  @media (max-width: 760px) {
    .xp { padding: 0; }
    .xp-box, .xp-box.xp-sm { height: 100dvh; max-height: none; border-radius: 0 !important; }
    .xp-head { padding: calc(16px + env(safe-area-inset-top)) 16px 12px; }
    html[data-theme="paper"] .xp-head { margin: 0 16px; padding: calc(16px + env(safe-area-inset-top)) 0 12px; }
    .xp-body { padding: 14px 16px 20px; }
    .xp-foot { padding: 10px 16px calc(10px + env(safe-area-inset-bottom)); }
    .tr-grid { grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .xp-foot .grow { flex: 1 1 100%; }
    .xp-foot .btn { flex: 1; }
    body:has(.xp.show) .toast { bottom: calc(124px + env(safe-area-inset-bottom)); }
  }`;
  document.head.append(Object.assign(document.createElement('style'), { textContent: css }));

  const closeSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  const checkSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>';
  let cur = null; // bảng đang mở: { el, body, foot, onClose }

  // Khung bảng dùng chung: tiêu đề, nội dung cuộn được, hàng nút ở dưới
  function panel(title, sub) {
    close();
    const el = document.createElement('div');
    el.className = 'xp';
    el.innerHTML = `<div class="xp-box" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="xp-head"><div><h2>${esc(title)}</h2><p>${esc(sub || '')}</p></div><button class="xp-x" aria-label="${esc(t('Đóng'))}">${closeSvg}</button></div>
      <div class="xp-body"></div><div class="xp-foot"></div></div>`;
    document.body.append(el);
    document.body.classList.add('lb-open'); // khoá cuộn trang phía sau
    requestAnimationFrame(() => el.classList.add('show'));
    el.addEventListener('click', e => { if (e.target === el) close(); });
    el.querySelector('.xp-x').onclick = close;
    el.querySelector('.xp-x').focus();
    cur = { el, body: el.querySelector('.xp-body'), foot: el.querySelector('.xp-foot'), sub: el.querySelector('.xp-head p') };
    return cur;
  }
  function close() {
    if (!cur) return;
    const { el, onClose } = cur;
    cur = null;
    if (!document.getElementById('lb').classList.contains('open')) document.body.classList.remove('lb-open');
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
    if (onClose) onClose();
  }
  addEventListener('keydown', e => { if (e.key === 'Escape' && cur) { e.stopPropagation(); close(); } }, true);

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
    if (res.status === 401) { location.href = '/login.html?next=/'; throw new Error(t('Cần đăng nhập')); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(t(data.error) || t('Lỗi {0}', res.status));
    return data;
  }
  async function get(url) {
    const res = await fetch(url);
    if (res.status === 401) { location.href = '/login.html?next=/'; throw new Error(t('Cần đăng nhập')); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(t(data.error) || t('Lỗi {0}', res.status));
    return data;
  }

  // ---------- Thùng rác ----------
  async function trash() {
    const p = panel(t('Thùng rác'), '');
    const sel = new Set();
    let items = [], changed = false;
    p.onClose = () => { if (changed) load(); };
    p.body.innerHTML = `<div class="xp-empty">${esc(t('Đang tải…'))}</div>`;

    const render = () => {
      if (!items.length) {
        p.body.innerHTML = `<div class="xp-empty"><div><b>${esc(t('Thùng rác trống'))}</b>${esc(t('Ảnh và video bạn xoá sẽ nằm ở đây 30 ngày trước khi bị xoá hẳn.'))}</div></div>`;
        p.foot.innerHTML = '';
        return;
      }
      p.body.innerHTML = `<div class="tr-grid">${items.map(it => {
        const days = Math.max(0, Math.ceil((it.purgeAt - Date.now()) / 864e5));
        return `<button class="tr-it${sel.has(it.id) ? ' on' : ''}" data-id="${esc(it.id)}" aria-pressed="${sel.has(it.id)}" title="${esc(it.name)}">
          <img src="${esc(it.thumb)}" alt="" loading="lazy"><span class="ck">${checkSvg}</span>
          <span class="d">${esc(days ? tn('còn {0} ngày', days) : t('xoá hôm nay'))}</span>${isVideo(it) ? '<span class="v">▶</span>' : ''}</button>`;
      }).join('')}</div>`;
      foot();
    };
    const foot = () => {
      const n = sel.size, all = n === items.length;
      p.foot.innerHTML = `<span class="grow">${esc(n ? t('Đã chọn {0} ảnh', n) : t('Bấm vào ảnh để chọn'))}</span>
        <button class="btn" data-a="all">${esc(t(all ? 'Bỏ chọn hết' : 'Chọn tất cả'))}</button>
        ${n ? `<button class="btn light" data-a="restore">${esc(t('Khôi phục'))}</button><button class="btn danger" data-a="purge">${esc(t('Xoá vĩnh viễn'))}</button>`
          : `<button class="btn danger" data-a="empty">${esc(t('Dọn sạch thùng rác'))}</button>`}`;
    };
    p.body.addEventListener('click', e => {
      const b = e.target.closest('.tr-it'); if (!b) return;
      const id = b.dataset.id;
      if (sel.has(id)) sel.delete(id); else sel.add(id);
      b.classList.toggle('on', sel.has(id)); b.setAttribute('aria-pressed', sel.has(id));
      foot();
    });
    p.foot.addEventListener('click', async e => {
      const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
      if (a === 'all') {
        const all = sel.size === items.length;
        sel.clear(); if (!all) items.forEach(it => sel.add(it.id));
        return render();
      }
      const ids = [...sel];
      const linked = items.some(it => it.link && (a === 'empty' || sel.has(it.id)));
      const note = linked ? '\n' + t('Ảnh trên ổ cứng ngoài chỉ bị ẩn khỏi gallery, file trên ổ vẫn giữ nguyên.') : '';
      if (a === 'purge' && !confirm(tn('Xoá vĩnh viễn {0} ảnh? Không lấy lại được nữa.', ids.length) + note)) return;
      if (a === 'empty' && !confirm(tn('Xoá vĩnh viễn toàn bộ {0} ảnh trong thùng rác? Không lấy lại được nữa.', items.length) + note)) return;
      e.target.disabled = true;
      try {
        if (a === 'restore') { const r = await post('/api/trash/restore', { ids }); toast(tn('Đã khôi phục {0} ảnh', r.restored)); changed = true; }
        else { const r = await post('/api/trash/purge', a === 'empty' ? { all: true } : { ids }); toast(tn('Đã xoá vĩnh viễn {0} ảnh', r.purged)); }
      } catch (err) { toast(err.message); }
      sel.clear();
      await refresh();
    });
    const refresh = async () => {
      try { const d = await get('/api/trash'); items = d.items; p.sub.textContent = items.length ? tn('{0} ảnh · tự xoá hẳn sau {1} ngày', items.length, d.days) : ''; }
      catch (err) { toast(err.message); }
      for (const id of [...sel]) if (!items.some(it => it.id === id)) sel.delete(id);
      if (cur === p) render();
    };
    await refresh();
  }

  // ---------- Bản đồ ảnh (Leaflet trong /vendor/leaflet, nền bản đồ của CARTO / OpenStreetMap) ----------
  let leaflet = null;
  const mapState = { center: null, zoom: null }; // mở lại thì về đúng chỗ đang xem
  function loadLeaflet() {
    const css = href => new Promise(ok => { const l = Object.assign(document.createElement('link'), { rel: 'stylesheet', href }); l.onload = l.onerror = ok; document.head.append(l); });
    const js = src => new Promise((ok, fail) => { const s = Object.assign(document.createElement('script'), { src }); s.onload = ok; s.onerror = () => fail(new Error(t('Không tải được bản đồ'))); document.head.append(s); });
    return leaflet ||= Promise.all([css('/vendor/leaflet/leaflet.css'), css('/vendor/leaflet/MarkerCluster.css'), js('/vendor/leaflet/leaflet.js')])
      .then(() => js('/vendor/leaflet/leaflet.markercluster.js'))
      .catch(err => { leaflet = null; throw err; });
  }
  const TILES = {
    cinema: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    paper: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    bento: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  };
  async function map() {
    const album = curAlbum(), inAlbum = album && new Set(album.photoIds);
    const list = (isShared() ? shared : photos).filter(p => hasGps(p) && (!inAlbum || inAlbum.has(p.id)));
    const places = new Set(list.map(p => p.place ? p.place.cc + p.place.n : '').filter(Boolean)).size;
    const p = panel(album ? t('Bản đồ: {0}', album.name) : t('Bản đồ ảnh'), list.length ? tn('{0} ảnh có vị trí · {1} nơi', list.length, places) : '');
    p.body.classList.add('flush');
    if (!list.length) {
      p.body.innerHTML = `<div class="map-msg"><div><b style="display:block;color:var(--text);font-size:17px;margin-bottom:6px">${esc(t('Chưa có ảnh nào có vị trí'))}</b>${esc(t('Ảnh chụp bằng điện thoại khi bật định vị sẽ hiện trên bản đồ. Ảnh cũ được đọc dần, quay lại sau ít phút nhé.'))}</div></div>`;
      return;
    }
    p.body.innerHTML = `<div class="map-msg">${esc(t('Đang tải…'))}</div>`;
    try { await loadLeaflet(); } catch (err) { p.body.innerHTML = `<div class="map-msg">${esc(err.message)}</div>`; return; }
    if (cur !== p) return; // đã đóng trong lúc tải
    const el = document.createElement('div'); el.className = 'map';
    p.body.replaceChildren(el);
    const theme = document.documentElement.dataset.theme;
    const m = L.map(el, { zoomControl: true, worldCopyJump: true, attributionControl: true });
    L.tileLayer(TILES[theme] || TILES.cinema, {
      subdomains: 'abcd', maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
    }).addTo(m);
    const icon = (ph, n) => L.divIcon({ className: '', iconSize: n > 1 ? [64, 64] : [52, 52], html: `<div class="pm${n > 1 ? ' big' : ''}"><i style="background-image:url('${esc(ph.thumb)}')${ph.color ? `;background-color:rgb(${esc(ph.color)})` : ''}"></i>${n > 1 ? `<b>${n > 999 ? Math.round(n / 100) / 10 + 'k' : n}</b>` : ''}</div>` });
    const group = L.markerClusterGroup({
      showCoverageOnHover: false, maxClusterRadius: 60, spiderfyOnMaxZoom: true,
      iconCreateFunction: c => { const ms = c.getAllChildMarkers(); return icon(ms[0].options.photo, ms.length); },
    });
    const sorted = [...list].sort((a, b) => when(b) - when(a)); // ảnh mới nhất làm "bìa" của cụm
    for (const ph of sorted) {
      const mk = L.marker([ph.exif.lat, ph.exif.lon], { icon: icon(ph, 1), photo: ph, title: ph.name });
      mk.on('click', () => { close(); openPhoto(ph); });
      group.addLayer(mk);
    }
    m.addLayer(group);
    if (mapState.center) m.setView(mapState.center, mapState.zoom);
    else m.fitBounds(group.getBounds(), { padding: [40, 40], maxZoom: 13 });
    const count = () => {
      const b = m.getBounds(), n = sorted.filter(ph => b.contains([ph.exif.lat, ph.exif.lon])).length;
      p.foot.innerHTML = `<span class="grow">${esc(tn('{0} ảnh trong vùng đang xem', n))}</span>
        <button class="btn" data-a="all">${esc(t('Xem tất cả'))}</button><button class="btn light" data-a="area"${n ? '' : ' disabled'}>${esc(t('Xem ảnh trong vùng này'))}</button>`;
    };
    m.on('moveend', () => { mapState.center = m.getCenter(); mapState.zoom = m.getZoom(); count(); });
    count();
    p.foot.onclick = e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'all') { m.fitBounds(group.getBounds(), { padding: [40, 40], maxZoom: 13 }); return; }
      if (a !== 'area') return;
      const b = m.getBounds(), w = ((b.getWest() + 180) % 360 + 360) % 360 - 180, e2 = ((b.getEast() + 180) % 360 + 360) % 360 - 180;
      const wide = b.getEast() - b.getWest() >= 360;
      close();
      setBounds({ s: b.getSouth(), n: b.getNorth(), w: wide ? -180 : w, e: wide ? 180 : e2 });
    };
    p.onClose = () => m.remove();
  }

  // ---------- Ảnh trùng ----------
  async function dupes() {
    const p = panel(t('Ảnh trùng'), '');
    let groups = [], changed = false;
    p.onClose = () => { if (changed) load(); };
    p.body.innerHTML = `<div class="xp-empty">${esc(t('Đang tìm…'))}</div>`;
    const fmtDate = new Intl.DateTimeFormat(i18n.locale, { day: 'numeric', month: 'short', year: 'numeric' });
    const refresh = async () => {
      let d;
      try { d = await get('/api/duplicates'); } catch (err) { p.body.innerHTML = `<div class="xp-empty">${esc(err.message)}</div>`; return; }
      // Mặc định: giữ ảnh server gợi ý (nhiều điểm ảnh nhất), bỏ các bản còn lại
      groups = d.groups.map(g => ({ ...g, keep: g.items[0].id, skip: false }));
      const extra = groups.reduce((a, g) => a + g.items.length - 1, 0);
      p.sub.textContent = groups.length ? tn('{0} nhóm · bỏ được {1} ảnh', groups.length, extra) : '';
      const note = d.pending ? `<p class="xp-note">${esc(tn('Còn {0} ảnh đang được phân tích, mở lại sau ít phút để thấy đủ.', d.pending))}</p>` : '';
      if (!groups.length) {
        p.body.innerHTML = note + `<div class="xp-empty"><div><b>${esc(t('Không có ảnh trùng'))}</b>${esc(t('Ảnh giống hệt, hoặc cùng một ảnh ở cỡ khác / đã nén lại, sẽ hiện ở đây.'))}</div></div>`;
        p.foot.innerHTML = '';
        return;
      }
      p.body.innerHTML = note + `<p class="xp-note">${esc(t('Bấm vào ảnh muốn giữ lại. Các ảnh còn lại vào thùng rác; album và yêu thích của chúng được chuyển sang ảnh giữ lại.'))}</p>`
        + groups.map((g, gi) => `<section class="dup-g" data-g="${gi}"><div class="dup-h"><b>${esc(t(g.kind === 'exact' ? 'Giống hệt' : 'Rất giống'))}</b>${esc(tn('{0} ảnh', g.items.length))}
          <label><input type="checkbox" data-skip="${gi}"> ${esc(t('Giữ cả nhóm'))}</label></div><div class="dup-row">${g.items.map(it => `
          <button class="dup-it" data-id="${esc(it.id)}"><div class="ph"><img src="${esc(it.thumb)}" alt="" loading="lazy"><span class="tag"></span></div>
          <div class="cap"><b title="${esc(it.name)}">${esc(it.name)}</b>${esc([it.w ? `${it.w}×${it.h}` : '', fmtSize(it.size || 0)].filter(Boolean).join(' · '))}<br>${esc(fmtDate.format(new Date(it.taken || it.added)))}${it.same && it.id !== g.items[0].id ? ' · ' + esc(t('giống hệt từng byte')) : ''}</div></button>`).join('')}</div></section>`).join('');
      paint();
    };
    const paint = () => {
      let n = 0;
      groups.forEach((g, gi) => {
        const sec = p.body.querySelector(`[data-g="${gi}"]`);
        sec.classList.toggle('skip', g.skip);
        sec.querySelectorAll('.dup-it').forEach(b => {
          const keep = b.dataset.id === g.keep;
          b.classList.toggle('keep', keep);
          b.querySelector('.tag').textContent = t(keep ? 'Giữ lại' : g.skip ? 'Giữ' : 'Bỏ');
          if (!keep && !g.skip) n++;
        });
      });
      p.foot.innerHTML = `<span class="grow">${esc(n ? tn('Sẽ chuyển {0} ảnh vào thùng rác', n) : t('Không bỏ ảnh nào'))}</span>
        <button class="btn light" data-a="go"${n ? '' : ' disabled'}>${esc(t('Bỏ ảnh trùng'))}</button>`;
    };
    p.body.addEventListener('click', e => {
      const b = e.target.closest('.dup-it'); if (!b) return;
      const g = groups[b.closest('[data-g]').dataset.g];
      g.keep = b.dataset.id; g.skip = false;
      b.closest('.dup-g').querySelector('[data-skip]').checked = false;
      paint();
    });
    p.body.addEventListener('change', e => {
      const i = e.target.dataset.skip; if (i === undefined) return;
      groups[i].skip = e.target.checked; paint();
    });
    p.foot.addEventListener('click', async e => {
      if (!e.target.closest('[data-a="go"]')) return;
      const list = groups.filter(g => !g.skip).map(g => ({ keep: g.keep, remove: g.items.map(it => it.id).filter(id => id !== g.keep) }));
      e.target.disabled = true;
      try {
        const r = await post('/api/duplicates/resolve', { groups: list });
        changed = true;
        toast(tn('Đã chuyển {0} ảnh vào thùng rác', r.trashed), { label: t('Mở thùng rác'), run: () => extras.open('trash') });
      } catch (err) { toast(err.message); }
      await refresh();
    });
    await refresh();
  }

  // ---------- Link chia sẻ album (xem không cần tài khoản) ----------
  async function copyText(text, input) {
    try { await navigator.clipboard.writeText(text); return true; } // chỉ có trên HTTPS / localhost
    catch {
      if (!input) return false;
      input.focus(); input.select();
      try { return document.execCommand('copy'); } catch { return false; }
    }
  }
  async function share(album) {
    const p = panel(album ? t('Chia sẻ "{0}"', album.name) : t('Link chia sẻ'), album ? t('Người có link xem được album mà không cần tài khoản') : t('Mọi link chia sẻ album của bạn'));
    const fmtDate = new Intl.DateTimeFormat(i18n.locale, { day: 'numeric', month: 'long', year: 'numeric' });
    const local = /^(localhost|127\.|\[?::1\]?$)/.test(location.hostname);
    const lan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
    const theme = document.documentElement.dataset.theme;
    const form = album ? `<div class="sh-new">
        <label class="sh-f"><span>${esc(t('Thời hạn'))}</span><select id="shDays">
          <option value="1">${esc(t('1 ngày'))}</option><option value="7" selected>${esc(t('7 ngày'))}</option><option value="30">${esc(t('30 ngày'))}</option><option value="365">${esc(t('1 năm'))}</option><option value="0">${esc(t('Không hết hạn'))}</option></select></label>
        <label class="sh-f"><span>${esc(t('Mật khẩu (không bắt buộc)'))}</span><input id="shPass" type="text" autocomplete="off" maxlength="200" placeholder="${esc(t('Để trống: không cần mật khẩu'))}"></label>
        <label class="sh-f"><span>${esc(t('Giao diện trang'))}</span><select id="shTheme">${[['cinema', 'Điện ảnh'], ['paper', 'Album giấy'], ['bento', 'Ô màu']].map(([v, n]) => `<option value="${v}"${v === theme ? ' selected' : ''}>${esc(t(n))}</option>`).join('')}</select></label>
        <label class="sh-f sh-chk"><input id="shDown" type="checkbox"><span>${esc(t('Cho tải ảnh gốc'))}</span></label>
        <button class="btn light" id="shCreate">${esc(t('Tạo link'))}</button>
      </div>` : '';
    const warn = local ? t('Bạn đang mở gallery bằng địa chỉ của chính máy chủ (localhost), nên link sẽ không mở được trên máy khác. Hãy mở gallery bằng địa chỉ mạng hoặc tên miền rồi copy link.')
      : lan ? t('Địa chỉ này chỉ mở được trong cùng mạng Wi-Fi. Muốn gửi cho người ở xa, hãy mở gallery qua tên miền / đường hầm (xem README) rồi copy link.') : '';
    p.body.innerHTML = form + (warn ? `<div class="sh-warn">${esc(warn)}</div>` : '') + `<div id="shList"></div>`;
    const list = p.body.querySelector('#shList');
    const render = items => {
      if (album) items = items.filter(x => x.albumId === album.id);
      if (!items.length) { list.innerHTML = album ? '' : `<div class="xp-empty"><div><b>${esc(t('Chưa có link chia sẻ nào'))}</b>${esc(t('Mở một album rồi bấm "Chia sẻ" để tạo link.'))}</div></div>`; return; }
      list.innerHTML = `<div class="sh-h">${esc(album ? t('Link của album này') : t('{0} link', items.length))}</div>` + items.map(x => {
        const url = location.origin + x.url;
        const exp = x.expired ? `<b>${esc(t('Đã hết hạn'))}</b>` : x.expires ? esc(t('Hết hạn {0}', fmtDate.format(new Date(x.expires)))) : esc(t('Không hết hạn'));
        return `<div class="sh-it${x.expired ? ' off' : ''}" data-token="${esc(x.token)}">
          ${album ? '' : `<div class="sh-meta" style="margin:0 0 8px"><b>${esc(x.albumName || '—')}</b></div>`}
          <div class="sh-row"><input readonly value="${esc(url)}" aria-label="Link"><button class="btn light" data-a="copy">${esc(t('Copy'))}</button>
            <a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${esc(t('Mở'))}</a><button class="btn danger" data-a="revoke">${esc(t('Thu hồi'))}</button></div>
          <div class="sh-meta"><span>${exp}</span><span>${esc(t(x.hasPass ? 'Có mật khẩu' : 'Không mật khẩu'))}</span><span>${esc(t(x.download ? 'Cho tải ảnh gốc' : 'Không cho tải ảnh gốc'))}</span><span>${esc(tn('{0} lượt xem', x.views))}</span></div>
        </div>`;
      }).join('');
    };
    const refresh = async () => { try { render(await get('/api/shares')); } catch (err) { toast(err.message); } };
    p.body.addEventListener('click', async e => {
      if (e.target.closest('#shCreate')) {
        const b = e.target.closest('#shCreate'); b.disabled = true;
        try {
          const x = await post('/api/shares', { albumId: album.id, days: Number(p.body.querySelector('#shDays').value), password: p.body.querySelector('#shPass').value, download: p.body.querySelector('#shDown').checked, theme: p.body.querySelector('#shTheme').value });
          p.body.querySelector('#shPass').value = '';
          await refresh();
          const input = list.querySelector(`[data-token="${x.token}"] input`);
          toast(t(await copyText(location.origin + x.url, input) ? 'Đã tạo link và copy vào bộ nhớ tạm' : 'Đã tạo link'));
        } catch (err) { toast(err.message); }
        b.disabled = false;
        return;
      }
      const a = e.target.closest('[data-a]'); if (!a) return;
      const it = a.closest('[data-token]'), token = it.dataset.token, input = it.querySelector('input');
      if (a.dataset.a === 'copy') toast(t(await copyText(input.value, input) ? 'Đã copy link' : 'Không copy được, hãy chọn link rồi copy bằng tay'));
      if (a.dataset.a === 'revoke') {
        if (!confirm(t('Thu hồi link này? Ai đang giữ link sẽ không xem được nữa.'))) return;
        try {
          const res = await fetch('/api/shares/' + encodeURIComponent(token), { method: 'DELETE' });
          if (!res.ok) throw new Error(t((await res.json().catch(() => ({}))).error) || t('Lỗi {0}', res.status));
          toast(t('Đã thu hồi link'));
        } catch (err) { toast(err.message); }
        refresh();
      }
    });
    await refresh();
  }

  // Cài như ứng dụng (PWA): Chrome / Edge / Android có hộp cài của trình duyệt (installPrompt trong index.html), cần HTTPS.
  // iPhone / iPad: chỉ có Safari → Chia sẻ → Thêm vào MH chính, và nói rõ giới hạn của Apple.
  function install() {
    const p = panel(t('Cài như ứng dụng'), t('Mở gallery từ màn hình chính, toàn màn hình, không có thanh địa chỉ'));
    p.el.querySelector('.xp-box').classList.add('xp-sm');
    const ua = navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const android = /Android/i.test(ua);
    const shareIc = '<span class="k"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg></span>';
    let how;
    if (ios) {
      how = `<b>${esc(t('Trên iPhone / iPad'))}</b><ol>
        <li>${esc(t('Mở trang này bằng Safari'))}</li>
        <li>${t('Bấm nút Chia sẻ {0} ở thanh dưới (iPad: góc trên)', shareIc)}</li>
        <li>${esc(t('Chọn "Thêm vào MH chính", rồi bấm "Thêm"'))}</li></ol>`;
    } else if (installPrompt) {
      how = `${esc(t('Trình duyệt của bạn cài được ngay.'))}<br><button class="btn light in-go" id="inGo">${esc(t('Cài đặt'))}</button>`;
    } else if (!isSecureContext) {
      how = `<b>${esc(t('Cần HTTPS'))}</b><br>${esc(t('Chrome và Edge chỉ cho cài khi gallery mở bằng https:// (hoặc mở ngay trên máy chủ bằng localhost). Bạn đang mở bằng {0}. Khi đã có tên miền và HTTPS (xem hướng dẫn VPS trong README), mở lại menu này.', location.origin))}`;
    } else {
      how = android
        ? `${esc(t('Mở menu ⋮ của Chrome, chọn "Thêm vào màn hình chính" hoặc "Cài đặt ứng dụng".'))}`
        : `${esc(t('Bấm biểu tượng cài đặt ở cuối thanh địa chỉ, hoặc menu ⋮ → "Cài đặt trang này làm ứng dụng" (Chrome, Edge). Firefox và Safari trên máy tính chưa hỗ trợ cài ứng dụng web đầy đủ.'))}`;
    }
    const good = [t('Mở từ màn hình chính như một ứng dụng, toàn màn hình'), t('Màn hình giữ sáng trong lúc tải ảnh lên')];
    if (!ios) good.push(t('Android: chọn ảnh / video trong ứng dụng Thư viện → Chia sẻ → My Gallery để tải lên thẳng'));
    const limits = ios ? [
      t('iPhone / iPad không cho ứng dụng web nhận ảnh từ nút Chia sẻ của ứng dụng Ảnh: hãy mở gallery rồi bấm Tải lên'),
      t('Đang tải lên mà chuyển sang ứng dụng khác hoặc khoá màn hình thì việc tải dừng lại: giữ gallery mở tới khi xong'),
      t('Ứng dụng trên màn hình chính đăng nhập riêng với Safari: đăng nhập một lần trong ứng dụng'),
    ] : [
      t('Không tải lên ngầm: đóng ứng dụng hoặc tắt màn hình là việc tải dừng lại'),
      t('Vẫn cần kết nối tới máy chủ: mất mạng thì ứng dụng chỉ hiện trang báo không kết nối được'),
    ];
    p.body.innerHTML = `<div class="in-top"><img src="/icons/icon-192.png" alt=""><p>${esc(t('Gallery chạy trên máy chủ của bạn như một trang web. Cài lên điện thoại hoặc máy tính để mở nhanh như ứng dụng; ảnh vẫn nằm trên máy chủ, không chiếm bộ nhớ máy.'))}</p></div>
      <div class="in-box">${how}</div>
      <div class="in-h">${esc(t('Được gì'))}</div><ul class="in-l">${good.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      <div class="in-h">${esc(t('Giới hạn'))}</div><ul class="in-l">${limits.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
    const go = p.body.querySelector('#inGo');
    if (go) go.onclick = async () => {
      const ev = installPrompt; if (!ev) return;
      installPrompt = null;
      ev.prompt();
      const { outcome } = await ev.userChoice.catch(() => ({}));
      if (outcome === 'accepted') close();
      else go.disabled = true;
    };
  }

  const tools = { trash, map, dupes, share, install };
  return {
    open(name, arg) { return tools[name] && tools[name](arg); },
    close,
  };
})();
