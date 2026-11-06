// Tạo lại các icon PNG cho ứng dụng cài được (PWA) từ public/icons/icon.svg. Cách dùng: node data/make-icons.js
// icon.svg vẽ tràn nền, phần hình nằm trong vùng an toàn 80% ở giữa nên dùng được cho cả icon "maskable" (Android tự cắt góc).
const path = require('path');
const sharp = require('sharp');
const dir = path.join(__dirname, '..', 'public', 'icons');
(async () => {
  const svg = path.join(dir, 'icon.svg');
  for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
    await sharp(svg, { density: 72 * size / 512 * 4 }).resize(size, size).png({ compressionLevel: 9 }).toFile(path.join(dir, name));
    console.log(name);
  }
})();
