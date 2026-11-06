// Tạo lại data/cities.txt.gz (dùng để đoán nơi chụp từ toạ độ GPS, xem exif.js). Không chạy khi server chạy.
// Nguồn: cities.pbf trong gói npm all-the-cities (dữ liệu GeoNames, CC BY 4.0). Cách dùng:
//   npm pack all-the-cities && tar xzf all-the-cities-*.tgz
//   node data/make-cities.js package/cities.pbf 15000 data/cities.txt.gz
// Chỉ đọc file như dữ liệu (tự giải mã protobuf), không chạy code của gói.
const fs = require('fs');
const buf = fs.readFileSync(process.argv[2]);
let pos = 0;
function varint() { let r = 0, s = 0, b; do { b = buf[pos++]; r += (b & 0x7f) * Math.pow(2, s); s += 7; } while (b & 0x80); return r; }
const svarint = () => { const n = varint(); return n % 2 ? -(n + 1) / 2 : n / 2; };
const cities = []; let lastLat = 0, lastLon = 0;
while (pos < buf.length) {
  const len = varint(), end = pos + len, c = { name: '', country: '', pop: 0, lat: 0, lon: 0, alt: '' };
  while (pos < end) {
    const key = varint(), tag = key >> 3, wt = key & 7;
    if (wt === 2) { const l = varint(); const s = buf.toString('utf8', pos, pos + l); pos += l; if (tag === 2) c.name = s; else if (tag === 3) c.country = s; else if (tag === 4) c.alt = s; else if (tag === 7) c.fc = s; }
    else if (wt === 0) { if (tag === 1) svarint(); else if (tag === 9) c.pop = varint(); else if (tag === 10) { lastLon += svarint(); c.lon = lastLon / 1e5; } else if (tag === 11) { lastLat += svarint(); c.lat = lastLat / 1e5; } else varint(); }
    else throw new Error('wt ' + wt);
  }
  cities.push(c);
}
console.error(cities.length);
const min = Number(process.argv[3] || 15000);
// Việt Nam: lấy mọi thị trấn (nhiều nơi không có số dân), sửa chữ Ð (eth) thành Đ, bỏ tiền tố "Thị Trấn" / "Thành Phố"
const VN_NAMES = { 'Ho Chi Minh City': 'Hồ Chí Minh', Hanoi: 'Hà Nội', Haiphong: 'Hải Phòng', 'Da Nang': 'Đà Nẵng', 'Qui Nhon': 'Quy Nhơn', 'Dien Bien Phu': 'Điện Biên Phủ', 'Cam Ranh': 'Cam Ranh' };
for (const x of cities) if (x.country === 'VN') x.name = VN_NAMES[x.name] || x.name.replace(/\u00d0/g, '\u0110').replace(/^(Thị Trấn|Thành Phố|Thị Xã)\s+/i, '');
// Quận nội thành (vd. "Quận Bốn", "Hoàn Kiếm") không có số dân: bỏ những nơi không có số dân cách thành phố lớn dưới 15 km,
// để ảnh chụp trong phố hiện "Hồ Chí Minh" / "Hà Nội". Bỏ cả khu vực con của thành phố (PPLX) ở mọi nước
const big = cities.filter(x => x.pop >= 500000);
const near = (a, b) => Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos(a.lat * Math.PI / 180)) * 111 < 15;
const list = cities.filter(x => x.fc !== 'PPLX' && !(x.country === 'VN' && /^(Quận|Phường) /.test(x.name)) && (x.pop >= min || (x.country === 'VN' && (x.pop > 0 || !big.some(b => b !== x && near(x, b))))));
const out = '# GeoNames (geonames.org), CC BY 4.0, qua gói all-the-cities. Mỗi dòng: tên|mã nước|vĩ độ|kinh độ|số dân (nghìn)\n' + list.map(x => [x.name, x.country, x.lat.toFixed(3), x.lon.toFixed(3), Math.round(x.pop / 1000)].join('|')).join('\n');
console.error(list.length, out.length, require('zlib').gzipSync(out, { level: 9 }).length);
if (process.argv[4]) fs.writeFileSync(process.argv[4], require('zlib').gzipSync(out, { level: 9 }));
