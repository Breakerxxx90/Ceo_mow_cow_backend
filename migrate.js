// ย้ายข้อมูลจริงจาก data/shop.db (SQLite เดิม) เข้า Postgres (Neon) ผ่าน DATABASE_URL
// รันครั้งเดียวตอนเปลี่ยนระบบ ไม่ต้องรันทุกครั้งที่ deploy
//
// วิธีใช้:
//   1) รัน schema.sql ใน Neon SQL Editor ก่อน (สร้างตารางเปล่า)
//   2) เอาไฟล์ data/shop.db เดิมไปวางไว้ที่ path เดียวกันในเครื่องที่จะรันสคริปต์นี้
//   3) ตั้งค่า DATABASE_URL แล้วรัน: node migrate.js
//      Windows (PowerShell): $env:DATABASE_URL="postgres://..."; node migrate.js
//      Mac/Linux:             DATABASE_URL="postgres://..." node migrate.js
//   4) สคริปต์ใช้ ON CONFLICT DO NOTHING จึงรันซ้ำได้โดยไม่ทำข้อมูลซ้ำ

const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('ไม่พบ DATABASE_URL กรุณาตั้งค่า environment variable ก่อนรันสคริปต์นี้');
  process.exit(1);
}

const sqlitePath = path.join(__dirname, 'data', 'shop.db');
const sqlite = new Database(sqlitePath, { readonly: true });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// รีเซ็ตลำดับ id ของตาราง (identity column) ให้ต่อจากค่าสูงสุดที่ย้ายเข้าไป
async function resetSeq(client, table, idCol = 'id') {
  await client.query(
    `SELECT setval(pg_get_serial_sequence('${table}', '${idCol}'), COALESCE((SELECT MAX(${idCol}) FROM ${table}), 1))`
  );
}

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('เริ่มย้ายข้อมูลจาก shop.db เข้า Postgres...\n');

    const users = sqlite.prepare('SELECT * FROM users').all();
    for (const u of users) {
      await client.query(
        `INSERT INTO users (id,username,password,role,created_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO NOTHING`,
        [u.id, u.username, u.password, u.role, u.created_at]
      );
    }
    await resetSeq(client, 'users');
    console.log(`✔ users: ${users.length} แถว`);

    const brands = sqlite.prepare('SELECT * FROM brands').all();
    for (const b of brands) {
      await client.query(
        `INSERT INTO brands (id,name,description,image,rating,created_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO NOTHING`,
        [b.id, b.name, b.description, b.image, b.rating, b.created_at]
      );
    }
    await resetSeq(client, 'brands');
    console.log(`✔ brands: ${brands.length} แถว`);

    const products = sqlite.prepare('SELECT * FROM products').all();
    for (const p of products) {
      await client.query(
        `INSERT INTO products (id,name,price,brand,category,stock,rating,description,image,featured,expiry_date,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [p.id, p.name, p.price, p.brand, p.category, p.stock, p.rating, p.description, p.image, p.featured, p.expiry_date, p.created_at]
      );
    }
    await resetSeq(client, 'products');
    console.log(`✔ products: ${products.length} แถว`);

    const saved = sqlite.prepare('SELECT * FROM saved').all();
    for (const s of saved) {
      await client.query(
        `INSERT INTO saved (user_id,product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [s.user_id, s.product_id]
      );
    }
    console.log(`✔ saved: ${saved.length} แถว`);

    const cartItems = sqlite.prepare('SELECT * FROM cart_items').all();
    for (const c of cartItems) {
      await client.query(
        `INSERT INTO cart_items (user_id,product_id,quantity) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [c.user_id, c.product_id, c.quantity]
      );
    }
    console.log(`✔ cart_items: ${cartItems.length} แถว`);

    const orders = sqlite.prepare('SELECT * FROM orders').all();
    for (const o of orders) {
      await client.query(
        `INSERT INTO orders (id,user_id,total,status,ref_code,created_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO NOTHING`,
        [o.id, o.user_id, o.total, o.status, o.ref_code, o.created_at]
      );
    }
    await resetSeq(client, 'orders');
    console.log(`✔ orders: ${orders.length} แถว`);

    const orderItems = sqlite.prepare('SELECT * FROM order_items').all();
    for (const oi of orderItems) {
      await client.query(
        `INSERT INTO order_items (id,order_id,product_id,quantity,price) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO NOTHING`,
        [oi.id, oi.order_id, oi.product_id, oi.quantity, oi.price]
      );
    }
    await resetSeq(client, 'order_items');
    console.log(`✔ order_items: ${orderItems.length} แถว`);

    const promotions = sqlite.prepare('SELECT * FROM promotions').all();
    for (const p of promotions) {
      await client.query(
        `INSERT INTO promotions (id,title,description,discount_percent,product_id,starts_at,ends_at,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [p.id, p.title, p.description, p.discount_percent, p.product_id, p.starts_at, p.ends_at, p.created_at]
      );
    }
    await resetSeq(client, 'promotions');
    console.log(`✔ promotions: ${promotions.length} แถว`);

    const transactions = sqlite.prepare('SELECT * FROM transactions').all();
    for (const t of transactions) {
      await client.query(
        `INSERT INTO transactions (id,type,amount,description,created_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO NOTHING`,
        [t.id, t.type, t.amount, t.description, t.created_at]
      );
    }
    await resetSeq(client, 'transactions');
    console.log(`✔ transactions: ${transactions.length} แถว`);

    console.log('\nเสร็จสิ้น! ข้อมูลทั้งหมดอยู่ใน Postgres แล้ว');
  } catch (err) {
    console.error('\nเกิดข้อผิดพลาดระหว่าง migrate:', err);
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

migrate();