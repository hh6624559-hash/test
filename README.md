# Web bán hàng online (Node.js + Express + SQLite)

Cửa hàng có giỏ hàng, đặt hàng COD hoặc chuyển khoản (mã QR VietQR), và trang quản trị đơn hàng, sản phẩm, tồn kho.

## Chạy thử trên máy
```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
# mở .env, đổi ADMIN_PASSWORD, JWT_SECRET (>= 32 ký tự), tên shop, thông tin ngân hàng
npm start
```
- Cửa hàng: http://localhost:3000
- Quản trị: http://localhost:3000/admin (đăng nhập bằng `ADMIN_PASSWORD`, sau đó thêm sản phẩm đầu tiên)

Tạo `JWT_SECRET` ngẫu nhiên: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## Đưa lên GitHub
```bash
git init
git add .
git commit -m "Web bán hàng đầu tiên"
git branch -M main
git remote add origin https://github.com/TEN_BAN/TEN_REPO.git
git push -u origin main
```
`.gitignore` đã loại `.env`, `node_modules` và file database. Không bao giờ commit `.env`.

## Đưa lên mạng để bán thật
Dữ liệu nằm trong file SQLite (`DB_PATH`), nên nơi chạy phải có **ổ đĩa lưu trữ bền vững**, nếu không mỗi lần deploy là mất đơn hàng.
- **VPS** (Vietnix, Vultr, DigitalOcean...): cài Node 18+, clone repo, tạo `.env`, chạy bằng `pm2 start server.js`, đặt Nginx phía trước và cài SSL bằng Let's Encrypt (certbot).
- **Render / Railway / Fly.io**: tạo Web Service từ repo GitHub, lệnh chạy `npm start`, khai báo biến môi trường như `.env.example`, gắn Persistent Disk/Volume và đặt `DB_PATH` trỏ vào ổ đó.
- Sao lưu định kỳ file `.db` (copy về máy hoặc lên Google Drive).

## Tính năng
- Khách: tăng giảm số lượng từng món, kiểm tra số điện thoại Việt Nam, chọn giao tận nơi hoặc nhận tại cửa hàng, gửi vị trí GPS hoặc link Google Maps, 3 cách thanh toán (tiền mặt, chuyển khoản khi nhận, thanh toán luôn kèm ảnh chụp màn hình và mã QR), lịch sử đơn, mua lại, trạng thái đơn tự cập nhật.
- Người bán (`/admin`): thống kê, hàng cần chuẩn bị, thêm sửa sản phẩm (biểu tượng, đơn vị, tồn kho), lọc đơn, đổi trạng thái (Mới, Nhận đơn, Chuẩn bị, Đã giao, Đã hủy), xem ảnh thanh toán, xóa đơn, xuất CSV.
- Bảo mật: giá tính ở máy chủ, mật khẩu admin kiểm tra ở máy chủ (JWT 8 giờ), giới hạn số lần đăng nhập và đặt hàng, ô ẩn chống bot, mã đơn ngẫu nhiên, khách chỉ xem được trạng thái đơn của mình.

## Giới hạn hiện tại
- Chuyển khoản do bạn tự đối chiếu tiền (nội dung chuyển khoản là `DH` + số điện thoại khách), chưa có cổng thanh toán tự xác nhận.
- Chưa có tài khoản khách, mã giảm giá, email hoặc SMS thông báo, tích hợp GHN/GHTK.
- Xóa đơn không hoàn tác được (có hộp xác nhận trước khi xóa).
