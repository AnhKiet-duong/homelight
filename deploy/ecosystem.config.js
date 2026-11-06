// Cấu hình pm2 cho gallery trên VPS. Chạy từ thư mục dự án:
//   pm2 start deploy/ecosystem.config.js
// Hướng dẫn đầy đủ: docs/trien-khai-vps.md
const path = require('path');

module.exports = {
  apps: [{
    name: 'homelight',
    script: path.join(__dirname, '..', 'server.js'),
    cwd: path.join(__dirname, '..'),
    // Bắt buộc 1 bản: ảnh, tài khoản, phiên đăng nhập được giữ trong RAM,
    // chạy nhiều bản (cluster) thì các bản ghi đè dữ liệu của nhau
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      // Đặt cổng ở đây thì trang Tài khoản không đổi được cổng (nginx luôn trỏ đúng).
      // Đổi số này thì đổi cả proxy_pass trong deploy/nginx-homelight.conf
      PORT: 3000,
      // Dung lượng tối đa mỗi video tải lên (MB). Tăng thì tăng client_max_body_size trong nginx
      // VIDEO_MAX_MB: 4096,
    },
    autorestart: true,
    max_restarts: 20,
    restart_delay: 3000,
    max_memory_restart: '1500M',
    time: true, // thêm giờ vào mỗi dòng log
  }],
};
