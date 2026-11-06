// Service worker của ứng dụng cài được (PWA). Cố ý làm rất ít:
//  - Trang (điều hướng): luôn lấy từ server; mất kết nối thì hiện trang báo "không kết nối được" thay cho trang lỗi của trình duyệt.
//  - POST /share-target: Android "Chia sẻ" ảnh / video vào ứng dụng -> cất file vào Cache "share-inbox" rồi mở /?shared=1,
//    index.html lấy file ra và tải lên như bình thường (kể cả khi phải đăng nhập trước).
// Không cache /api, ảnh, video hay file giao diện: ảnh đã có cache HTTP dài hạn, còn giao diện luôn là bản mới nhất của server.
const INBOX = 'share-inbox';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.method === 'POST' && url.pathname === '/share-target') return e.respondWith(receiveShare(req));
  if (req.mode === 'navigate' && req.method === 'GET') e.respondWith(fetch(req).catch(() => offlinePage()));
});

async function receiveShare(req) {
  try {
    const form = await req.formData(), cache = await caches.open(INBOX);
    let i = 0;
    for (const f of form.getAll('media')) {
      if (!(f instanceof File) || !f.size) continue;
      await cache.put(`/share-inbox/${Date.now()}-${i++}`, new Response(f, {
        headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Name': encodeURIComponent(f.name || 'shared'), 'X-Modified': String(f.lastModified || '') },
      }));
    }
  } catch { /* form lỗi: vẫn mở ứng dụng */ }
  return Response.redirect('/?shared=1', 303);
}

function offlinePage() {
  const vi = /^vi\b/i.test(navigator.language || '');
  const [title, text, btn] = vi
    ? ['Không kết nối được', 'Không kết nối được máy chủ gallery. Kiểm tra mạng, hoặc máy chủ có đang bật không, rồi thử lại.', 'Thử lại']
    : ['Can’t connect', 'Can’t reach the gallery server. Check your connection, or whether the server is running, then try again.', 'Try again'];
  return new Response(`<!doctype html><html lang="${vi ? 'vi' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#07070a"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07070a;color:#eae6df;font:16px/1.5 system-ui,sans-serif;text-align:center}
main{padding:24px;max-width:340px}img{width:72px;height:72px;border-radius:18px}h1{font-size:20px;margin:18px 0 6px}p{color:#a39d93;margin:0 0 22px}
button{font:inherit;font-weight:600;padding:10px 22px;border-radius:99px;border:0;background:#f4efe6;color:#07070a;cursor:pointer}</style>
<main><img src="data:image/svg+xml,${encodeURIComponent(ICON)}" alt=""><h1>${title}</h1><p>${text}</p><button onclick="location.reload()">${btn}</button></main></html>`,
  { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
// Biểu tượng nhúng sẵn (không tải được gì khi mất mạng)
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#1d1a15"/><path d="M256 128 380 222V372a12 12 0 0 1-12 12H144a12 12 0 0 1-12-12V222Z" fill="#f4efe6"/><path d="M160 238h192v118H160Z" fill="#1d1a15"/><circle cx="306" cy="272" r="18" fill="#ffcf73"/><path d="M160 356 214 296l36 38 28-24 74 46Z" fill="#e8a84a"/></svg>';
