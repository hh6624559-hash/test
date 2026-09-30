require('dotenv').config();
const express = require('express'), path = require('path'), crypto = require('crypto');
const Database = require('better-sqlite3'), jwt = require('jsonwebtoken'), rateLimit = require('express-rate-limit');

const { ADMIN_PASSWORD, JWT_SECRET } = process.env;
if (!ADMIN_PASSWORD || !JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('Thiếu ADMIN_PASSWORD hoặc JWT_SECRET (>= 32 ký tự) trong .env');
  process.exit(1);
}
const FREE = +process.env.FREE_SHIP_FROM || 300000, FEE = +process.env.SHIP_FEE || 30000;
const STATUS = ['Mới', 'Nhận đơn', 'Chuẩn bị', 'Đã giao', 'Đã hủy'], CANCEL = 'Đã hủy';
const SHIPS = ['Giao tận nơi', 'Nhận tại cửa hàng'], PMS = ['COD', 'CK_NHAN', 'CK_TRUOC'];
const BANK = !!(process.env.BANK_BIN && process.env.BANK_ACCOUNT);
const MAPRE = /^https:\/\/(?:www\.google\.com\/maps|maps\.google\.com|maps\.app\.goo\.gl|goo\.gl\/maps)(?:[\/?#][\w\-.~:\/?#@!$()*+,;=%&]*)?$/;

const db = new Database(process.env.DB_PATH || 'data.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, name TEXT NOT NULL, cat TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0, descr TEXT DEFAULT '', image TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1, emoji TEXT DEFAULT '', unit TEXT DEFAULT 'cái');
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, code TEXT, created TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL,
  address TEXT NOT NULL, note TEXT DEFAULT '', method TEXT NOT NULL, ship INTEGER NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'Mới',
  ship_method TEXT DEFAULT 'Giao tận nơi', map_url TEXT DEFAULT '', proof TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, product_id INTEGER, name TEXT NOT NULL, qty INTEGER NOT NULL, price INTEGER NOT NULL, unit TEXT DEFAULT '');
`);
// Nâng cấp database cũ (nếu cột đã có thì bỏ qua lỗi)
for (const s of [
  "ALTER TABLE products ADD COLUMN emoji TEXT DEFAULT ''", "ALTER TABLE products ADD COLUMN unit TEXT DEFAULT 'cái'",
  "ALTER TABLE orders ADD COLUMN ship_method TEXT DEFAULT 'Giao tận nơi'", "ALTER TABLE orders ADD COLUMN map_url TEXT DEFAULT ''",
  "ALTER TABLE orders ADD COLUMN proof TEXT DEFAULT ''", "ALTER TABLE order_items ADD COLUMN unit TEXT DEFAULT ''"
]) { try { db.exec(s); } catch (e) {} }
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ix_orders_code ON orders(code)');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (q, r) => r.sendFile(path.join(__dirname, 'public', 'admin.html')));

const bad = m => Object.assign(new Error(m), { user: true });
const wrap = fn => (req, res) => {
  try { res.json(fn(req)); }
  catch (e) {
    if (e.user) return res.status(400).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'Lỗi máy chủ' });
  }
};
const str = (v, n) => String(v ?? '').trim().slice(0, n);
function vnPhone(v) {
  const s = String(v).replace(/[\s.\-()]/g, '');
  if (!/^(\+?84|0)\d{9,10}$/.test(s)) return '';
  const n = '0' + s.replace(/^(\+?84|0)/, '');
  return /^0(3[2-9]|5[25689]|7[06-9]|8[1-9]|9\d)\d{7}$/.test(n) || /^02\d{9}$/.test(n) ? n : '';
}
const newCode = () => { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; return 'DH' + [...crypto.randomBytes(6)].map(x => A[x % A.length]).join(''); };

// ---------- Công khai ----------
app.get('/api/config', (q, res) => res.json({
  shopName: process.env.SHOP_NAME || 'Cửa hàng', tagline: process.env.TAGLINE || '', footer: process.env.FOOTER || '', freeShip: FREE, shipFee: FEE,
  bank: { bin: process.env.BANK_BIN || '', acc: process.env.BANK_ACCOUNT || '', holder: process.env.BANK_HOLDER || '' }
}));
app.get('/api/products', wrap(() => db.prepare('SELECT id,name,price,stock,descr,emoji,unit FROM products WHERE active=1 ORDER BY id').all()));

const orderLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, message: { error: 'Bạn vừa đặt hàng nhiều lần, vui lòng thử lại sau ít phút.' } });
app.post('/api/orders', orderLimit, wrap(req => {
  const b = req.body || {};
  if (b.hp) throw bad('Yêu cầu không hợp lệ.');
  if (!(+b.t >= 4000)) throw bad('Bạn thao tác quá nhanh, vui lòng thử lại.');
  const name = str(b.name, 60), phone = vnPhone(b.phone), method = b.method, sm = b.shipMethod;
  let address = str(b.address, 300);
  if (name.length < 2) throw bad('Nhập họ tên người nhận.');
  if (!phone) throw bad('Số điện thoại không hợp lệ ở Việt Nam. Ví dụ: 0912345678.');
  if (!SHIPS.includes(sm)) throw bad('Chọn hình thức nhận hàng.');
  if (!PMS.includes(method) || (method !== 'COD' && !BANK)) throw bad('Chọn hình thức thanh toán.');
  if (sm === SHIPS[0] && address.length < 8) throw bad('Nhập địa chỉ đầy đủ: số nhà, đường, phường/xã, tỉnh/thành.');
  if (!address) address = '(Khách nhận tại cửa hàng)';
  const mapUrl = str(b.mapUrl, 300);
  if (mapUrl && !MAPRE.test(mapUrl)) throw bad('Link vị trí phải là link Google Maps.');
  let proof = '';
  if (method === 'CK_TRUOC') {
    proof = String(b.proof || '');
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(proof) || proof.length > 700000) throw bad('Cần đính kèm ảnh chụp màn hình đã thanh toán (ảnh quá lớn hoặc không hợp lệ).');
  }
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 30) throw bad('Giỏ hàng trống.');

  return db.transaction(() => {
    let sub = 0; const lines = [];
    for (const it of b.items) {
      const qty = Math.floor(+it.qty);
      const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(+it.id);
      if (!p || !(qty > 0) || qty > 99) throw bad('Có sản phẩm không hợp lệ hoặc đã ngừng bán. Hãy tải lại trang.');
      if (p.stock < qty) throw bad(`"${p.name}" chỉ còn ${p.stock} ${p.unit || 'sản phẩm'}.`);
      db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(qty, p.id);
      sub += p.price * qty; lines.push([p.id, p.name, qty, p.price, p.unit || '']);   // giá luôn lấy từ database
    }
    const ship = sm === SHIPS[1] || sub >= FREE ? 0 : FEE, total = sub + ship, code = newCode();
    const r = db.prepare('INSERT INTO orders(code,created,name,phone,address,method,ship,total,ship_method,map_url,proof) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(code, new Date().toISOString(), name, phone, address, method, ship, total, sm, mapUrl, proof);
    const ins = db.prepare('INSERT INTO order_items(order_id,product_id,name,qty,price,unit) VALUES(?,?,?,?,?,?)');
    lines.forEach(l => ins.run(r.lastInsertRowid, ...l));
    return { code, total, ship };
  })();
}));

// Khách theo dõi trạng thái: chỉ trả về trạng thái, không trả thông tin cá nhân
const trackLimit = rateLimit({ windowMs: 60 * 1000, max: 30 });
app.get('/api/track', trackLimit, wrap(req => {
  const codes = str(req.query.codes, 400).split(',').filter(c => /^DH[A-Z0-9]{6}$/.test(c)).slice(0, 20), out = {};
  codes.forEach(c => { const o = db.prepare('SELECT status FROM orders WHERE code=?').get(c); if (o) out[c] = o.status; });
  return out;
}));

// ---------- Quản trị ----------
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Thử sai quá nhiều lần, đợi 15 phút.' } });
app.post('/api/admin/login', loginLimit, (req, res) => {
  const a = Buffer.from(String(req.body?.password || '')), b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Sai mật khẩu' });
  res.json({ token: jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '8h' }) });
});
function auth(req, res, next) {
  try { jwt.verify((req.headers.authorization || '').slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Chưa đăng nhập' }); }
}
function prod(b) {
  const name = str(b.name, 120), price = Math.round(+b.price), stock = Math.floor(+b.stock);
  if (!name || !(price > 0) || !(stock >= 0)) throw bad('Nhập đủ tên, giá lớn hơn 0 và tồn kho từ 0.');
  return [name, str(b.cat, 40), price, stock, str(b.descr, 2000), '', b.active === false || b.active === 0 ? 0 : 1, str(b.emoji, 8), str(b.unit, 20) || 'cái'];
}
app.get('/api/admin/products', auth, wrap(() => db.prepare('SELECT * FROM products ORDER BY id DESC').all()));
app.post('/api/admin/products', auth, wrap(req => ({
  id: db.prepare('INSERT INTO products(name,cat,price,stock,descr,image,active,emoji,unit) VALUES(?,?,?,?,?,?,?,?,?)').run(...prod(req.body || {})).lastInsertRowid
})));
app.put('/api/admin/products/:id', auth, wrap(req => {
  db.prepare('UPDATE products SET name=?,cat=?,price=?,stock=?,descr=?,image=?,active=?,emoji=?,unit=? WHERE id=?').run(...prod(req.body || {}), +req.params.id);
  return { ok: true };
}));
app.delete('/api/admin/products/:id', auth, wrap(req => { db.prepare('DELETE FROM products WHERE id=?').run(+req.params.id); return { ok: true }; }));

app.get('/api/admin/orders', auth, wrap(() => {
  const os = db.prepare(`SELECT id,code,created,name,phone,address,method,ship,total,status,ship_method,map_url,(proof<>'') AS has_proof FROM orders ORDER BY id DESC LIMIT 500`).all();
  const its = db.prepare('SELECT name,qty,price,unit FROM order_items WHERE order_id=?');
  return os.map(o => ({ ...o, items: its.all(o.id) }));
}));
app.get('/api/admin/orders/:id/proof', auth, wrap(req => ({ proof: db.prepare('SELECT proof FROM orders WHERE id=?').get(+req.params.id)?.proof || '' })));
const restock = id => db.prepare('SELECT product_id,qty FROM order_items WHERE order_id=?').all(id)
  .forEach(i => db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(i.qty, i.product_id));
app.patch('/api/admin/orders/:id', auth, wrap(req => {
  const st = req.body?.status, id = +req.params.id;
  if (!STATUS.includes(st)) throw bad('Trạng thái không hợp lệ.');
  db.transaction(() => {
    const o = db.prepare('SELECT status FROM orders WHERE id=?').get(id);
    if (!o) throw bad('Không tìm thấy đơn.');
    if (o.status === CANCEL && st !== CANCEL) throw bad('Đơn đã hủy không mở lại được.');
    if (o.status !== CANCEL && st === CANCEL) restock(id);   // hủy đơn thì trả hàng về kho
    db.prepare('UPDATE orders SET status=? WHERE id=?').run(st, id);
  })();
  return { ok: true };
}));
app.delete('/api/admin/orders/:id', auth, wrap(req => {
  const id = +req.params.id;
  db.transaction(() => {
    const o = db.prepare('SELECT status FROM orders WHERE id=?').get(id);
    if (!o) return;
    if (o.status !== CANCEL) restock(id);
    db.prepare('DELETE FROM order_items WHERE order_id=?').run(id);
    db.prepare('DELETE FROM orders WHERE id=?').run(id);
  })();
  return { ok: true };
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Chạy tại http://localhost:${PORT}  (quản trị: /admin)`));
