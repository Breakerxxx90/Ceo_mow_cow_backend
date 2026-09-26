const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const dbPath = path.join(__dirname, 'data', 'shop.db');

if (!fs.existsSync(dbPath)) require('./migrate');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

const sessions = new Map();
const tokenFor = user => crypto.createHash('sha256').update(`${user.id}:${user.username}:${Date.now()}:${Math.random()}`).digest('hex');

const userByToken = req => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return sessions.get(token) || null;
};

const requireUser = (req, res, next) => {
  const user = userByToken(req);
  if (!user) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อน' });
  req.user = user; 
  next();
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้' });
  next();
};

const STAFF = ['cashier', 'manager', 'owner', 'admin'];   // คิดเงิน / ใบเสร็จ
const MANAGE = ['manager', 'owner', 'admin'];             // โปรโมชั่น / สินค้า / สต็อก / หมดอายุ / ขายดี / แบรนด์ / ออเดอร์
const OWNER_ONLY = ['owner', 'admin'];                    // รายรับ-รายจ่าย / ผู้ใช้ในระบบ

const cleanUser = u => ({ id: u.id, username: u.username, role: u.role });
const product = row => row && ({ ...row, featured: Boolean(row.featured) });
const sendError = (res, err) => res.status(err.status || 400).json({ error: err.message || 'เกิดข้อผิดพลาด' });

// สร้างเลขอ้างอิงคำสั่งซื้อแบบสุ่ม เช่น CEO-241002-A1B2C3 แล้วเช็คว่ายังไม่ซ้ำในฐานข้อมูล
function generateOrderRefCode() {
  const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, ''); // YYMMDD
  for (let attempt = 0; attempt < 8; attempt++) {
    const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
    const candidate = `CEO-${datePart}-${randomPart}`;
    const exists = db.prepare('SELECT 1 FROM orders WHERE ref_code=?').get(candidate);
    if (!exists) return candidate;
  }
  return `CEO-${datePart}-${Date.now().toString(36).toUpperCase()}`;
}

// ---------- Authentication System ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/signup', (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (username.length < 3) throw Object.assign(new Error('ชื่อผู้ใช้ต้องมีอย่างน้อย 3 ตัวอักษร'), { status: 400 });
    if (password.length < 6) throw Object.assign(new Error('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร'), { status: 400 });
    if (req.body.confirm !== password) throw Object.assign(new Error('ยืนยันรหัสผ่านไม่ตรงกัน'), { status: 400 });
    const info = db.prepare('INSERT INTO users (username,password) VALUES (?,?)').run(username, password);
    const user = db.prepare('SELECT id,username,role FROM users WHERE id=?').get(info.lastInsertRowid);
    const token = tokenFor(user); 
    sessions.set(token, user);
    res.status(201).json({ token, user: cleanUser(user) });
  } catch (e) { 
    sendError(res, e.code === 'SQLITE_CONSTRAINT_UNIQUE' ? Object.assign(new Error('ชื่อผู้ใช้นี้ถูกใช้แล้ว'), { status: 409 }) : e); 
  }
});

app.post('/api/login', (req, res) => {
  const user = db.prepare('SELECT id,username,password,role FROM users WHERE username=?').get(String(req.body.username || '').trim());
  if (!user || user.password !== String(req.body.password || '')) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  const token = tokenFor(user); 
  const safe = cleanUser(user); 
  sessions.set(token, safe);
  res.json({ token, user: safe });
});

app.post('/api/logout', requireUser, (req, res) => { 
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); 
  sessions.delete(token); 
  res.json({ ok: true }); 
});

// ---------- Products / Recommendations / Saved ----------
app.get('/api/products', (req, res) => {
  let sql = 'SELECT * FROM products WHERE 1=1'; 
  const args = [];
  if (req.query.q) { 
    sql += ' AND (name LIKE ? COLLATE NOCASE OR brand LIKE ? COLLATE NOCASE OR category LIKE ? COLLATE NOCASE OR description LIKE ? COLLATE NOCASE)'; 
    const q = `%${String(req.query.q).trim()}%`; 
    args.push(q, q, q, q); 
  }
  if (req.query.category) { sql += ' AND (category = ? OR brand = ?)'; args.push(req.query.category, req.query.category); }
  if (req.query.brand) { sql += ' AND (brand = ? OR category = ?)'; args.push(req.query.brand, req.query.brand); }
  sql += ' ORDER BY featured DESC, id DESC';
  res.json(db.prepare(sql).all(...args).map(product));
});

app.get('/api/products/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'ไม่พบสินค้า' });
  res.json(product(p));
});

app.get('/api/recommend', (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 8));
  const rows = db.prepare('SELECT * FROM products ORDER BY featured DESC, rating DESC, id DESC LIMIT ?').all(limit);
  res.json(rows.map(product));
});

app.get('/api/saved', requireUser, (req, res) => {
  const ids = db.prepare('SELECT product_id FROM saved WHERE user_id=?').all(req.user.id).map(x => x.product_id);
  const items = ids.length ? db.prepare(`SELECT * FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(product) : [];
  res.json({ ids, items });
});

app.post('/api/saved/:id', requireUser, (req, res) => {
  const id = Number(req.params.id); 
  const exists = db.prepare('SELECT 1 FROM saved WHERE user_id=? AND product_id=?').get(req.user.id, id);
  if (exists) db.prepare('DELETE FROM saved WHERE user_id=? AND product_id=?').run(req.user.id, id);
  else db.prepare('INSERT OR IGNORE INTO saved (user_id,product_id) VALUES (?,?)').run(req.user.id, id);
  res.json({ saved: !exists });
});

// ---------- Cart & Checkout (ปรับปรุงแก้ไขการทำงานสมบูรณ์) ----------
app.get('/api/cart', requireUser, (req, res) => {
  const items = db.prepare(`SELECT p.id,p.name,p.price,p.image,p.stock,ci.quantity
    FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.user_id=? ORDER BY ci.rowid`).all(req.user.id);
  res.json({ items, total: items.reduce((sum, i) => sum + i.price * i.quantity, 0) });
});

app.post('/api/cart', requireUser, (req, res) => {
  const id = Number(req.body.product_id || req.body.id); 
  const quantity = Math.max(1, Number(req.body.quantity || 1));
  const p = db.prepare('SELECT id,stock FROM products WHERE id=?').get(id);
  if (!p) return res.status(404).json({ error: 'ไม่พบสินค้า' });
  if (p.stock < 1) return res.status(400).json({ error: 'สินค้าหมดสต็อก' });
  
  const current = db.prepare('SELECT quantity FROM cart_items WHERE user_id=? AND product_id=?').get(req.user.id, id);
  const next = Math.min(p.stock, (current ? current.quantity : 0) + quantity);
  db.prepare(`INSERT INTO cart_items (user_id,product_id,quantity) VALUES (?,?,?)
    ON CONFLICT(user_id,product_id) DO UPDATE SET quantity=excluded.quantity`).run(req.user.id, id, next);
  res.json({ ok: true });
});

app.put('/api/cart/:id', requireUser, (req, res) => {
  const id = Number(req.params.id); 
  const quantity = Number(req.body.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    db.prepare('DELETE FROM cart_items WHERE user_id=? AND product_id=?').run(req.user.id, id);
  } else {
    const p = db.prepare('SELECT stock FROM products WHERE id=?').get(id);
    if (!p) return res.status(404).json({ error: 'ไม่พบสินค้า' });
    db.prepare('UPDATE cart_items SET quantity=? WHERE user_id=? AND product_id=?').run(Math.min(quantity, p.stock), req.user.id, id);
  }
  res.json({ ok: true });
});

app.delete('/api/cart/:id', requireUser, (req, res) => { 
  db.prepare('DELETE FROM cart_items WHERE user_id=? AND product_id=?').run(req.user.id, Number(req.params.id)); 
  res.json({ ok: true }); 
});

app.post('/api/checkout', requireUser, (req, res) => {
  const items = db.prepare(`SELECT p.id,p.name,p.image,p.price,p.stock,ci.quantity FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.user_id=?`).all(req.user.id);
  if (!items.length) return res.status(400).json({ error: 'ตะกร้าว่างอยู่' });
  if (items.some(i => i.quantity > i.stock)) return res.status(400).json({ error: 'สินค้าบางรายการมีไม่พอในสต็อก' });
  
  const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const refCode = generateOrderRefCode();
  
  // เรียกใช้งาน Transaction ตัดสต็อก บันทึกคำสั่งซื้อ (พร้อมเลขอ้างอิงใบเสร็จ) และลบตะกร้าสินค้า
  const orderId = db.transaction(() => {
    const order = db.prepare('INSERT INTO orders (user_id,total,ref_code) VALUES (?,?,?)').run(req.user.id, total, refCode);
    const add = db.prepare('INSERT INTO order_items (order_id,product_id,quantity,price) VALUES (?,?,?,?)');
    const stock = db.prepare('UPDATE products SET stock=stock-? WHERE id=?');
    items.forEach(i => { add.run(order.lastInsertRowid, i.id, i.quantity, i.price); stock.run(i.quantity, i.id); });
    db.prepare('DELETE FROM cart_items WHERE user_id=?').run(req.user.id);
    return order.lastInsertRowid;
  })();

  const createdAt = db.prepare('SELECT created_at FROM orders WHERE id=?').get(orderId).created_at;

  res.json({
    order_id: orderId,
    ref_code: refCode,
    total,
    created_at: createdAt,
    items: items.map(i => ({ id: i.id, name: i.name, image: i.image, price: i.price, quantity: i.quantity }))
  });
});

// ---------- Admin Management APIs ----------
const LOW_STOCK_THRESHOLD = 5;

app.get('/api/admin/stats', requireUser, requireRole(...MANAGE), (req, res) => res.json({
  products: db.prepare('SELECT COUNT(*) n FROM products').get().n,
  users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
  orders: db.prepare('SELECT COUNT(*) n FROM orders').get().n,
  revenue: db.prepare('SELECT COALESCE(SUM(total),0) n FROM orders').get().n,
  lowStock: db.prepare('SELECT COUNT(*) n FROM products WHERE stock <= ?').get(LOW_STOCK_THRESHOLD).n
}));

app.get('/api/admin/low-stock', requireUser, requireRole(...MANAGE), (req, res) => {
  const threshold = Number(req.query.threshold || LOW_STOCK_THRESHOLD);
  const rows = db.prepare('SELECT * FROM products WHERE stock <= ? ORDER BY stock ASC').all(threshold);
  res.json(rows.map(product));
});

app.get('/api/admin/orders', requireUser, requireRole(...MANAGE), (req, res) => 
  res.json(db.prepare(`SELECT o.*,u.username FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.id DESC`).all())
);

app.get('/api/admin/users', requireUser, requireRole(...OWNER_ONLY), (req, res) => 
  res.json(db.prepare('SELECT id,username,role,created_at FROM users ORDER BY id').all())
);

app.get('/api/admin/brands', requireUser, requireRole(...MANAGE), (req, res) => 
  res.json(db.prepare(`SELECT b.*, COUNT(p.id) AS product_count FROM brands b LEFT JOIN products p ON p.brand=b.name GROUP BY b.id ORDER BY b.name`).all())
);

app.post('/api/admin/brands', requireUser, requireRole(...MANAGE), (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'กรุณาใส่ชื่อแบรนด์' });
  try {
    const rating = req.body.rating === undefined || req.body.rating === '' ? 4.5 : Number(req.body.rating);
    const r = db.prepare('INSERT INTO brands (name,description,image,rating) VALUES (?,?,?,?)').run(name, req.body.description || '', req.body.image || '', rating);
    res.status(201).json(db.prepare('SELECT * FROM brands WHERE id=?').get(r.lastInsertRowid));
  } catch (e) { 
    sendError(res, e.code === 'SQLITE_CONSTRAINT_UNIQUE' ? Object.assign(new Error('มีแบรนด์นี้แล้ว'), { status: 409 }) : e); 
  }
});

app.put('/api/admin/brands/:id', requireUser, requireRole(...MANAGE), (req, res) => {
  const id = Number(req.params.id); 
  const old = db.prepare('SELECT * FROM brands WHERE id=?').get(id);
  if (!old) return res.status(404).json({ error: 'ไม่พบแบรนด์' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'กรุณาใส่ชื่อแบรนด์' });
  const rating = req.body.rating === undefined || req.body.rating === '' ? old.rating : Number(req.body.rating);
  const tx = db.transaction(() => {
    db.prepare('UPDATE brands SET name=?,description=?,image=?,rating=? WHERE id=?').run(name, req.body.description || '', req.body.image || '', rating, id);
    db.prepare('UPDATE products SET brand=? WHERE brand=?').run(name, old.name);
  });
  try { tx(); res.json(db.prepare('SELECT * FROM brands WHERE id=?').get(id)); } catch (e) { sendError(res, e); }
});

app.delete('/api/admin/brands/:id', requireUser, requireRole(...MANAGE), (req, res) => {
  const id = Number(req.params.id); 
  const brand = db.prepare('SELECT name FROM brands WHERE id=?').get(id);
  if (!brand) return res.status(404).json({ error: 'ไม่พบแบรนด์' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM products WHERE brand=?').get(brand.name).n;
  if (count) return res.status(400).json({ error: 'ลบไม่ได้ เพราะแบรนด์นี้มีสินค้าอยู่ ' + count + ' รายการ' });
  db.prepare('DELETE FROM brands WHERE id=?').run(id); 
  res.json({ ok: true });
});

app.get('/api/brands', (req, res) => res.json(
  db.prepare(`SELECT b.*, COUNT(p.id) AS product_count FROM brands b
    LEFT JOIN products p ON (p.brand = b.name OR p.category = b.name)
    GROUP BY b.id ORDER BY b.name`).all()
));

app.post('/api/products', requireUser, requireRole(...MANAGE), (req, res) => {
  const b = req.body; 
  if (!b.name || !Number.isFinite(Number(b.price))) return res.status(400).json({ error: 'กรอกชื่อและราคาสินค้า' });
  const r = db.prepare(`INSERT INTO products (name,price,brand,category,stock,rating,description,image,featured,expiry_date) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(b.name, Number(b.price), b.brand || '', b.category || 'Woman', Number(b.stock || 0), Number(b.rating || 4.5), b.description || '', b.image || 'g-snack', Number(b.featured || 0), b.expiry_date || null);
  res.status(201).json(product(db.prepare('SELECT * FROM products WHERE id=?').get(r.lastInsertRowid)));
});

app.put('/api/products/:id', requireUser, requireRole(...MANAGE), (req, res) => {
  const b = req.body; 
  const id = Number(req.params.id);
  const r = db.prepare(`UPDATE products SET name=?,price=?,brand=?,category=?,stock=?,rating=?,description=?,image=?,featured=?,expiry_date=? WHERE id=?`)
    .run(b.name, Number(b.price), b.brand || '', b.category || 'Woman', Number(b.stock || 0), Number(b.rating || 4.5), b.description || '', b.image || 'g-snack', Number(b.featured || 0), b.expiry_date || null, id);
  if (!r.changes) return res.status(404).json({ error: 'ไม่พบสินค้า' }); 
  res.json(product(db.prepare('SELECT * FROM products WHERE id=?').get(id)));
});

app.delete('/api/products/:id', requireUser, requireRole(...MANAGE), (req, res) => { 
  const r = db.prepare('DELETE FROM products WHERE id=?').run(Number(req.params.id)); 
  if (!r.changes) return res.status(404).json({ error: 'ไม่พบสินค้า' }); 
  res.json({ ok: true }); 
});

// ---------- Promotions ----------
app.get('/api/admin/promotions', requireUser, requireRole(...MANAGE), (req, res) => 
  res.json(db.prepare('SELECT * FROM promotions ORDER BY id DESC').all())
);

app.post('/api/admin/promotions', requireUser, requireRole(...MANAGE), (req, res) => {
  const b = req.body; 
  if (!b.title) return res.status(400).json({ error: 'กรุณาใส่ชื่อโปรโมชั่น' });
  const r = db.prepare('INSERT INTO promotions (title,description,discount_percent,product_id,starts_at,ends_at) VALUES (?,?,?,?,?,?)')
    .run(b.title, b.description || '', Number(b.discount_percent || 0), b.product_id ? Number(b.product_id) : null, b.starts_at || null, b.ends_at || null);
  res.status(201).json(db.prepare('SELECT * FROM promotions WHERE id=?').get(r.lastInsertRowid));
});

app.delete('/api/admin/promotions/:id', requireUser, requireRole(...MANAGE), (req, res) => { 
  db.prepare('DELETE FROM promotions WHERE id=?').run(Number(req.params.id)); 
  res.json({ ok: true }); 
});

// ---------- Expiring Products ----------
app.get('/api/admin/expiring', requireUser, requireRole(...MANAGE), (req, res) => {
  const days = Number(req.query.days || 30);
  const rows = db.prepare(`SELECT * FROM products WHERE expiry_date IS NOT NULL AND expiry_date <> ''
    AND date(expiry_date) <= date('now', '+' || ? || ' days') ORDER BY expiry_date ASC`).all(days);
  res.json(rows.map(product));
});

// ---------- Bestsellers ----------
app.get('/api/admin/bestsellers', requireUser, requireRole(...MANAGE), (req, res) => {
  const limit = Number(req.query.limit || 8);
  const rows = db.prepare(`SELECT p.*, COALESCE(SUM(oi.quantity),0) AS sold FROM products p
    LEFT JOIN order_items oi ON oi.product_id = p.id GROUP BY p.id ORDER BY sold DESC, p.rating DESC LIMIT ?`).all(limit);
  res.json(rows.map(r => Object.assign(product(r), { sold: r.sold })));
});

// ---------- POS Checkout ----------
app.post('/api/admin/pos-checkout', requireUser, requireRole(...STAFF), (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) throw Object.assign(new Error('กรุณาเลือกสินค้าอย่างน้อย 1 รายการ'), { status: 400 });
    const rows = items.map(i => {
      const p = db.prepare('SELECT id,price,stock FROM products WHERE id=?').get(Number(i.product_id));
      if (!p) throw Object.assign(new Error('ไม่พบสินค้า'), { status: 404 });
      const quantity = Math.max(1, Number(i.quantity || 1));
      if (quantity > p.stock) throw Object.assign(new Error('สินค้าในสต็อกไม่พอ'), { status: 400 });
      return { id: p.id, price: p.price, quantity };
    });
    const total = rows.reduce((s, r) => s + r.price * r.quantity, 0);
    const refCode = generateOrderRefCode();
    const orderId = db.transaction(() => {
      const order = db.prepare("INSERT INTO orders (user_id,total,status,ref_code) VALUES (?,?,?,?)").run(req.user.id, total, 'ชำระเงินแล้ว (หน้าร้าน)', refCode);
      const add = db.prepare('INSERT INTO order_items (order_id,product_id,quantity,price) VALUES (?,?,?,?)');
      const stock = db.prepare('UPDATE products SET stock=stock-? WHERE id=?');
      rows.forEach(r => { add.run(order.lastInsertRowid, r.id, r.quantity, r.price); stock.run(r.quantity, r.id); });
      return order.lastInsertRowid;
    })();
    res.status(201).json({ order_id: orderId, ref_code: refCode, total });
  } catch (e) { sendError(res, e); }
});

// ---------- Receipts / Admin Orders ----------
app.get('/api/admin/orders/:id', requireUser, requireRole(...STAFF), (req, res) => {
  const order = db.prepare('SELECT o.*,u.username FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=?').get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'ไม่พบออเดอร์' });
  const items = db.prepare('SELECT oi.*, p.name FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?').all(order.id);
  res.json({ order, items });
});

app.get('/api/admin/receipts', requireUser, requireRole(...STAFF), (req, res) => {
  res.json(db.prepare(`SELECT o.*,u.username FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 50`).all());
});

// ---------- Finance / Profit & Loss ----------
app.get('/api/admin/transactions', requireUser, requireRole(...OWNER_ONLY), (req, res) => 
  res.json(db.prepare('SELECT * FROM transactions ORDER BY id DESC').all())
);

app.post('/api/admin/transactions', requireUser, requireRole(...OWNER_ONLY), (req, res) => {
  const b = req.body;
  if (!['income', 'expense'].includes(b.type)) return res.status(400).json({ error: "ประเภทต้องเป็น income หรือ expense" });
  if (!Number.isFinite(Number(b.amount)) || Number(b.amount) <= 0) return res.status(400).json({ error: 'กรุณาใส่จำนวนเงินให้ถูกต้อง' });
  const r = db.prepare('INSERT INTO transactions (type,amount,description) VALUES (?,?,?)').run(b.type, Number(b.amount), b.description || '');
  res.status(201).json(db.prepare('SELECT * FROM transactions WHERE id=?').get(r.lastInsertRowid));
});

app.delete('/api/admin/transactions/:id', requireUser, requireRole(...OWNER_ONLY), (req, res) => { 
  db.prepare('DELETE FROM transactions WHERE id=?').run(Number(req.params.id)); 
  res.json({ ok: true }); 
});

app.get('/api/admin/profit-loss', requireUser, requireRole(...OWNER_ONLY), (req, res) => {
  const salesRevenue = db.prepare('SELECT COALESCE(SUM(total),0) n FROM orders').get().n;
  const otherIncome = db.prepare("SELECT COALESCE(SUM(amount),0) n FROM transactions WHERE type='income'").get().n;
  const expense = db.prepare("SELECT COALESCE(SUM(amount),0) n FROM transactions WHERE type='expense'").get().n;
  const totalIncome = salesRevenue + otherIncome;
  res.json({ salesRevenue, otherIncome, expense, totalIncome, profit: totalIncome - expense });
});

// ---------- Static Files & Error Handling ----------
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'home.html')));

app.use((err, req, res, next) => { 
  console.error(err); 
  res.status(500).json({ error: 'เซิร์ฟเวอร์ขัดข้อง' }); 
});

app.listen(PORT, () => console.log(`CEO เมากาว running at http://localhost:${PORT}`));