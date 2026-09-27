const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);

if (!process.env.DATABASE_URL) {
  console.error('ไม่พบ DATABASE_URL กรุณาตั้งค่า environment variable ก่อนรันเซิร์ฟเวอร์');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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
// queryable รับได้ทั้ง pool (นอก transaction) หรือ client (ใน transaction)
async function generateOrderRefCode(queryable = pool) {
  const datePart = new Date().toISOString().slice(2, 10).replace(/-/g, ''); // YYMMDD
  for (let attempt = 0; attempt < 8; attempt++) {
    const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
    const candidate = `CEO-${datePart}-${randomPart}`;
    const { rows } = await queryable.query('SELECT 1 FROM orders WHERE ref_code=$1', [candidate]);
    if (!rows.length) return candidate;
  }
  return `CEO-${datePart}-${Date.now().toString(36).toUpperCase()}`;
}

// ---------- Authentication System ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/signup', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (username.length < 3) throw Object.assign(new Error('ชื่อผู้ใช้ต้องมีอย่างน้อย 3 ตัวอักษร'), { status: 400 });
    if (password.length < 6) throw Object.assign(new Error('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร'), { status: 400 });
    if (req.body.confirm !== password) throw Object.assign(new Error('ยืนยันรหัสผ่านไม่ตรงกัน'), { status: 400 });
    const { rows } = await pool.query('INSERT INTO users (username,password) VALUES ($1,$2) RETURNING id,username,role', [username, password]);
    const user = rows[0];
    const token = tokenFor(user);
    sessions.set(token, user);
    res.status(201).json({ token, user: cleanUser(user) });
  } catch (e) {
    if (e.code === '23505') return sendError(res, Object.assign(new Error('ชื่อผู้ใช้นี้ถูกใช้แล้ว'), { status: 409 }));
    sendError(res, e);
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id,username,password,role FROM users WHERE username=$1', [String(req.body.username || '').trim()]);
    const user = rows[0];
    if (!user || user.password !== String(req.body.password || '')) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    const token = tokenFor(user);
    const safe = cleanUser(user);
    sessions.set(token, safe);
    res.json({ token, user: safe });
  } catch (e) { sendError(res, e); }
});

app.post('/api/logout', requireUser, (req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  sessions.delete(token);
  res.json({ ok: true });
});

// ---------- Products / Recommendations / Saved ----------
app.get('/api/products', async (req, res) => {
  try {
    let sql = 'SELECT * FROM products WHERE 1=1';
    const args = [];
    if (req.query.q) {
      const q = `%${String(req.query.q).trim()}%`;
      args.push(q, q, q, q);
      sql += ` AND (name ILIKE $${args.length - 3} OR brand ILIKE $${args.length - 2} OR category ILIKE $${args.length - 1} OR description ILIKE $${args.length})`;
    }
    if (req.query.category) {
      args.push(req.query.category, req.query.category);
      sql += ` AND (category = $${args.length - 1} OR brand = $${args.length})`;
    }
    if (req.query.brand) {
      args.push(req.query.brand, req.query.brand);
      sql += ` AND (brand = $${args.length - 1} OR category = $${args.length})`;
    }
    sql += ' ORDER BY featured DESC, id DESC';
    const { rows } = await pool.query(sql, args);
    res.json(rows.map(product));
  } catch (e) { sendError(res, e); }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products WHERE id=$1', [Number(req.params.id)]);
    if (!rows[0]) return res.status(404).json({ error: 'ไม่พบสินค้า' });
    res.json(product(rows[0]));
  } catch (e) { sendError(res, e); }
});

app.get('/api/recommend', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 8));
    const { rows } = await pool.query('SELECT * FROM products ORDER BY featured DESC, rating DESC, id DESC LIMIT $1', [limit]);
    res.json(rows.map(product));
  } catch (e) { sendError(res, e); }
});

app.get('/api/saved', requireUser, async (req, res) => {
  try {
    const { rows: savedRows } = await pool.query('SELECT product_id FROM saved WHERE user_id=$1', [req.user.id]);
    const ids = savedRows.map(x => x.product_id);
    let items = [];
    if (ids.length) {
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await pool.query(`SELECT * FROM products WHERE id IN (${placeholders})`, ids);
      items = rows.map(product);
    }
    res.json({ ids, items });
  } catch (e) { sendError(res, e); }
});

app.post('/api/saved/:id', requireUser, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query('SELECT 1 FROM saved WHERE user_id=$1 AND product_id=$2', [req.user.id, id]);
    const exists = rows.length > 0;
    if (exists) {
      await pool.query('DELETE FROM saved WHERE user_id=$1 AND product_id=$2', [req.user.id, id]);
    } else {
      await pool.query('INSERT INTO saved (user_id,product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, id]);
    }
    res.json({ saved: !exists });
  } catch (e) { sendError(res, e); }
});

// ---------- Cart & Checkout (ปรับปรุงแก้ไขการทำงานสมบูรณ์) ----------
app.get('/api/cart', requireUser, async (req, res) => {
  try {
    const { rows: items } = await pool.query(
      `SELECT p.id,p.name,p.price,p.image,p.stock,ci.quantity
       FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.user_id=$1 ORDER BY ci.product_id`,
      [req.user.id]
    );
    res.json({ items, total: items.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0) });
  } catch (e) { sendError(res, e); }
});

app.post('/api/cart', requireUser, async (req, res) => {
  try {
    const id = Number(req.body.product_id || req.body.id);
    const quantity = Math.max(1, Number(req.body.quantity || 1));
    const { rows: prows } = await pool.query('SELECT id,stock FROM products WHERE id=$1', [id]);
    const p = prows[0];
    if (!p) return res.status(404).json({ error: 'ไม่พบสินค้า' });
    if (p.stock < 1) return res.status(400).json({ error: 'สินค้าหมดสต็อก' });

    const { rows: crows } = await pool.query('SELECT quantity FROM cart_items WHERE user_id=$1 AND product_id=$2', [req.user.id, id]);
    const current = crows[0];
    const next = Math.min(p.stock, (current ? current.quantity : 0) + quantity);
    await pool.query(
      `INSERT INTO cart_items (user_id,product_id,quantity) VALUES ($1,$2,$3)
       ON CONFLICT (user_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity`,
      [req.user.id, id, next]
    );
    res.json({ ok: true });
  } catch (e) { sendError(res, e); }
});

app.put('/api/cart/:id', requireUser, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const quantity = Number(req.body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      await pool.query('DELETE FROM cart_items WHERE user_id=$1 AND product_id=$2', [req.user.id, id]);
    } else {
      const { rows } = await pool.query('SELECT stock FROM products WHERE id=$1', [id]);
      const p = rows[0];
      if (!p) return res.status(404).json({ error: 'ไม่พบสินค้า' });
      await pool.query('UPDATE cart_items SET quantity=$1 WHERE user_id=$2 AND product_id=$3', [Math.min(quantity, p.stock), req.user.id, id]);
    }
    res.json({ ok: true });
  } catch (e) { sendError(res, e); }
});

app.delete('/api/cart/:id', requireUser, async (req, res) => {
  try {
    await pool.query('DELETE FROM cart_items WHERE user_id=$1 AND product_id=$2', [req.user.id, Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { sendError(res, e); }
});

app.post('/api/checkout', requireUser, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rows: items } = await client.query(
      `SELECT p.id,p.name,p.image,p.price,p.stock,ci.quantity FROM cart_items ci JOIN products p ON p.id=ci.product_id WHERE ci.user_id=$1`,
      [req.user.id]
    );
    if (!items.length) return res.status(400).json({ error: 'ตะกร้าว่างอยู่' });
    if (items.some(i => i.quantity > i.stock)) return res.status(400).json({ error: 'สินค้าบางรายการมีไม่พอในสต็อก' });

    const total = items.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
    const refCode = await generateOrderRefCode(client);

    // เรียกใช้งาน Transaction ตัดสต็อก บันทึกคำสั่งซื้อ (พร้อมเลขอ้างอิงใบเสร็จ) และลบตะกร้าสินค้า
    await client.query('BEGIN');
    const { rows: orderRows } = await client.query(
      'INSERT INTO orders (user_id,total,ref_code) VALUES ($1,$2,$3) RETURNING id,created_at',
      [req.user.id, total, refCode]
    );
    const orderId = orderRows[0].id;
    const createdAt = orderRows[0].created_at;
    for (const i of items) {
      await client.query('INSERT INTO order_items (order_id,product_id,quantity,price) VALUES ($1,$2,$3,$4)', [orderId, i.id, i.quantity, i.price]);
      await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2', [i.quantity, i.id]);
    }
    await client.query('DELETE FROM cart_items WHERE user_id=$1', [req.user.id]);
    await client.query('COMMIT');

    res.json({
      order_id: orderId,
      ref_code: refCode,
      total,
      created_at: createdAt,
      items: items.map(i => ({ id: i.id, name: i.name, image: i.image, price: i.price, quantity: i.quantity }))
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    sendError(res, e);
  } finally {
    client.release();
  }
});

// ---------- Admin Management APIs ----------
const LOW_STOCK_THRESHOLD = 5;

app.get('/api/admin/stats', requireUser, requireRole(...MANAGE), async (req, res) => {
  try {
    const [{ rows: p }, { rows: u }, { rows: o }, { rows: rev }, { rows: low }] = await Promise.all([
      pool.query('SELECT COUNT(*)::int n FROM products'),
      pool.query('SELECT COUNT(*)::int n FROM users'),
      pool.query('SELECT COUNT(*)::int n FROM orders'),
      pool.query('SELECT COALESCE(SUM(total),0)::float n FROM orders'),
      pool.query('SELECT COUNT(*)::int n FROM products WHERE stock <= $1', [LOW_STOCK_THRESHOLD])
    ]);
    res.json({ products: p[0].n, users: u[0].n, orders: o[0].n, revenue: rev[0].n, lowStock: low[0].n });
  } catch (e) { sendError(res, e); }
});

app.get('/api/admin/low-stock', requireUser, requireRole(...MANAGE), async (req, res) => {
  try {
    const threshold = Number(req.query.threshold || LOW_STOCK_THRESHOLD);
    const { rows } = await pool.query('SELECT * FROM products WHERE stock <= $1 ORDER BY stock ASC', [threshold]);
    res.json(rows.map(product));
  } catch (e) { sendError(res, e); }
});

app.get('/api/admin/orders', requireUser, requireRole(...MANAGE), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT o.*,u.username FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.id DESC`);
    res.json(rows);
  } catch (e) { sendError(res, e); }
});

app.get('/api/admin/users', requireUser, requireRole(...OWNER_ONLY), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id,username,role,created_at FROM users ORDER BY id');
    res.json(rows);
  } catch (e) { sendError(res, e); }
});

app.get('/api/admin/brands', requireUser, requireRole(...MANAGE), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.*, COUNT(p.id)::int AS product_count FROM brands b LEFT JOIN products p ON p.brand=b.name GROUP BY b.id ORDER BY b.name`
    );
    res.json(rows);
  } catch (e) { sendError(res, e); }
});

app.post('/api/admin/brands', requireUser, requireRole(...MANAGE), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'กรุณาใส่ชื่อแบรนด์' });
    const rating = req.body.rating === undefined || req.body.rating === '' ? 4.5 : Number(req.body.rating);
    const { rows } = await pool.query(
      'INSERT INTO brands (name,description,image,rating) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, req.body.description || '', req.body.image || '', rating]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return sendError(res, Object.assign(new Error('มีแบรนด์นี้แล้ว'), { status: 409 }));
    sendError(res, e);
  }
});

app.put('/api/admin/brands/:id', requireUser, requireRole(...MANAGE), async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const { rows: oldRows } = await client.query('SELECT * FROM brands WHERE id=$1', [id]);
    const old = oldRows[0];
    if (!old) return res.status(404).json({ error: 'ไม่พบแบรนด์' });
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'กรุณาใส่ชื่อแบรนด์' });
    const rating = req.body.rating === undefined || req.body.rating === '' ? old.rating : Number(req.body.rating);

    await client.query('BEGIN');
    await client.query('UPDATE brands SET name=$1,description=$2,image=$3,rating=$4 WHERE id=$5', [name, req.body.description || '', req.body.image || '', rating, id]);
    await client.query('UPDATE products SET brand=$1 WHERE brand=$2', [name, old.name]);
    await client.query('COMMIT');

    const { rows } = await pool.query('SELECT * FROM brands WHERE id=$1', [id]);
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    sendError(res, e);
  } finally {
    client.release();
  }
});

app.delete('/api/admin/brands/:id', requireUser, requireRole(...MANAGE), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows: brandRows } = await pool.query('SELECT name FROM brands WHERE id=$1', [id]);
    const brand = brandRows[0];
    if (!brand) return res.status(404).json({ error: 'ไม่พบแบรนด์' });
    const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS n FROM products WHERE brand=$1', [brand.name]);
    const count = countRows[0].n;
    if (count) return res.status(400).json({ error: 'ลบไม่ได้ เพราะแบรนด์นี้มีสินค้าอยู่ ' + count + ' รายการ' });
    await pool.query('DELETE FROM brands WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (e) { sendError(res, e); }
});

app.get('/api/brands', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.*, COUNT(p.id)::int AS product_count FROM brands b
       LEFT JOIN products p ON (p.brand = b.name OR p.category = b.name)
       GROUP BY b.id ORDER BY b.name`
    );
    res.json(rows);
  } catch (e) { sendError(res, e); }
});

app.post('/api/products', requireUser, requireRole(...MANAGE), async (req, res) => {
  try {
    const b = req.body;
    if (!b.name || !Number.isFinite(Number(b.price))) return res.status(400).json({ error: 'กรอกชื่อและราคาสินค้า' });
    const { rows } = await pool.query(
      `INSERT INTO products (name,price,brand,category,stock,rating,description,image,featured,expiry_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [b.name, Number(b.price), b.brand || '', b.category || 'Woman', Number(b.stock || 0), Number(b.rating || 4.5), b.description || '', b.image || 'g-snack', Number(b.featured || 0), b.expiry_date || null]
    );
    res.status(201).json(product(rows[0]));
  } catch (e) { sendError(res, e); }
});

app.put('/api/products/:id', requireUser, requireRole(...MANAGE), async (req, res) => {
  try {
    const b = req.body;
    const id = Number(req.params.id);
    const { rowCount, rows } = await pool.query(
      `UPDATE products SET name=$1,price=$2,brand=$3,category=$4,stock=$5,rating=$6,description=$7,image=$8,featured=$9,expiry_date=$10 WHERE id=$11 RETURNING *`,
      [b.name, Number(b.price), b.brand || '', b.category || 'Woman', Number(b.stock || 0), Number(b.rating || 4.5), b.description || '', b.image || 'g-snack', Number(b.featured || 0), b.expiry_date || null, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'ไม่พบสินค้า' });
    res.json(product(rows[0]));
  } catch (e) { sendError(res, e); }
});

app.delete('/api/products/:id', requireUser, requireRole(...MANAGE), async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM products WHERE id=$1', [Number(req.params.id)]);
    if (!rowCount) return res.status(404).json({ error: 'ไม่พบสินค้า' });
    res.json({ ok: true });
  } catch (e) { sendError(res, e); }
});

// ---------- Promotions ----------
app.get('/api/admin/promotions', requireUser, requireRole(...MANAGE), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM promotions ORDER BY id DESC');
    res.json(rows);
  } catch (e) { sendError(res, e); }
});

app.post('/api/admin/promotions', requireUser, requireRole(...MANAGE), async (req, res) => {
  try {
    const b = req.body;
    if (!b.title) return res.status(400).json({ error: 'กรุณาใส่ชื่อโปรโมชั่น' });
    const { rows } = await pool.query(
      'INSERT INTO promotions (title,description,discount_percent,product_id,starts_at,ends_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [b.title, b.description || '', Number(b.discount_percent || 0), b.product_id ? Number(b.product_id) : null, b.starts_at || null, b.ends_at || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { sendError(res, e); }
});

app.delete('/api/admin/promotions/:id', requireUser, requireRole(...MANAGE), async (req, res) => {
  try {
    await pool.query('DELETE FROM promotions WHERE id=$1', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { sendError(res, e); }
});

// ---------- Expiring Products ----------
app.get('/api/admin/expiring', requireUser, requireRole(...MANAGE), async (req, res) => {
  try {
    const days = Number(req.query.days || 30);
    const { rows } = await pool.query(
      `SELECT * FROM products WHERE expiry_date IS NOT NULL AND expiry_date <> ''
       AND expiry_date::date <= (CURRENT_DATE + ($1::int) * INTERVAL '1 day')::date
       ORDER BY expiry_date ASC`,
      [days]
    );
    res.json(rows.map(product));
  } catch (e) { sendError(res, e); }
});

// ---------- Bestsellers ----------
app.get('/api/admin/bestsellers', requireUser, requireRole(...MANAGE), async (req, res) => {
  try {
    const limit = Number(req.query.limit || 8);
    const { rows } = await pool.query(
      `SELECT p.*, COALESCE(SUM(oi.quantity),0)::int AS sold FROM products p
       LEFT JOIN order_items oi ON oi.product_id = p.id GROUP BY p.id ORDER BY sold DESC, p.rating DESC LIMIT $1`,
      [limit]
    );
    res.json(rows.map(r => Object.assign(product(r), { sold: r.sold })));
  } catch (e) { sendError(res, e); }
});

// ---------- POS Checkout ----------
app.post('/api/admin/pos-checkout', requireUser, requireRole(...STAFF), async (req, res) => {
  const client = await pool.connect();
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) throw Object.assign(new Error('กรุณาเลือกสินค้าอย่างน้อย 1 รายการ'), { status: 400 });

    const rows = [];
    for (const i of items) {
      const { rows: prows } = await client.query('SELECT id,price,stock FROM products WHERE id=$1', [Number(i.product_id)]);
      const p = prows[0];
      if (!p) throw Object.assign(new Error('ไม่พบสินค้า'), { status: 404 });
      const quantity = Math.max(1, Number(i.quantity || 1));
      if (quantity > p.stock) throw Object.assign(new Error('สินค้าในสต็อกไม่พอ'), { status: 400 });
      rows.push({ id: p.id, price: p.price, quantity });
    }
    const total = rows.reduce((s, r) => s + Number(r.price) * r.quantity, 0);
    const refCode = await generateOrderRefCode(client);

    await client.query('BEGIN');
    const { rows: orderRows } = await client.query(
      "INSERT INTO orders (user_id,total,status,ref_code) VALUES ($1,$2,$3,$4) RETURNING id",
      [req.user.id, total, 'ชำระเงินแล้ว (หน้าร้าน)', refCode]
    );
    const orderId = orderRows[0].id;
    for (const r of rows) {
      await client.query('INSERT INTO order_items (order_id,product_id,quantity,price) VALUES ($1,$2,$3,$4)', [orderId, r.id, r.quantity, r.price]);
      await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2', [r.quantity, r.id]);
    }
    await client.query('COMMIT');

    res.status(201).json({ order_id: orderId, ref_code: refCode, total });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    sendError(res, e);
  } finally {
    client.release();
  }
});

// ---------- Receipts / Admin Orders ----------
app.get('/api/admin/orders/:id', requireUser, requireRole(...STAFF), async (req, res) => {
  try {
    const { rows: orows } = await pool.query('SELECT o.*,u.username FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=$1', [Number(req.params.id)]);
    const order = orows[0];
    if (!order) return res.status(404).json({ error: 'ไม่พบออเดอร์' });
    const { rows: items } = await pool.query('SELECT oi.*, p.name FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1', [order.id]);
    res.json({ order, items });
  } catch (e) { sendError(res, e); }
});

app.get('/api/admin/receipts', requireUser, requireRole(...STAFF), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT o.*,u.username FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 50`);
    res.json(rows);
  } catch (e) { sendError(res, e); }
});

// ---------- Finance / Profit & Loss ----------
app.get('/api/admin/transactions', requireUser, requireRole(...OWNER_ONLY), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM transactions ORDER BY id DESC');
    res.json(rows);
  } catch (e) { sendError(res, e); }
});

app.post('/api/admin/transactions', requireUser, requireRole(...OWNER_ONLY), async (req, res) => {
  try {
    const b = req.body;
    if (!['income', 'expense'].includes(b.type)) return res.status(400).json({ error: "ประเภทต้องเป็น income หรือ expense" });
    if (!Number.isFinite(Number(b.amount)) || Number(b.amount) <= 0) return res.status(400).json({ error: 'กรุณาใส่จำนวนเงินให้ถูกต้อง' });
    const { rows } = await pool.query(
      'INSERT INTO transactions (type,amount,description) VALUES ($1,$2,$3) RETURNING *',
      [b.type, Number(b.amount), b.description || '']
    );
    res.status(201).json(rows[0]);
  } catch (e) { sendError(res, e); }
});

app.delete('/api/admin/transactions/:id', requireUser, requireRole(...OWNER_ONLY), async (req, res) => {
  try {
    await pool.query('DELETE FROM transactions WHERE id=$1', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { sendError(res, e); }
});

app.get('/api/admin/profit-loss', requireUser, requireRole(...OWNER_ONLY), async (req, res) => {
  try {
    const [{ rows: sr }, { rows: oi }, { rows: ex }] = await Promise.all([
      pool.query('SELECT COALESCE(SUM(total),0)::float n FROM orders'),
      pool.query("SELECT COALESCE(SUM(amount),0)::float n FROM transactions WHERE type='income'"),
      pool.query("SELECT COALESCE(SUM(amount),0)::float n FROM transactions WHERE type='expense'")
    ]);
    const salesRevenue = sr[0].n, otherIncome = oi[0].n, expense = ex[0].n;
    const totalIncome = salesRevenue + otherIncome;
    res.json({ salesRevenue, otherIncome, expense, totalIncome, profit: totalIncome - expense });
  } catch (e) { sendError(res, e); }
});

app.use(express.static(path.join(__dirname, 'frontend')));
// ไม่ต้องมี app.get('/'...) เลย

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'เซิร์ฟเวอร์ขัดข้อง' });
});

app.listen(PORT, () => {
  console.log(`CEO เมากาว running at http://localhost:${PORT}`);
  console.log('ฐานข้อมูล: Postgres (ผ่าน DATABASE_URL)');
});