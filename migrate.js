const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'shop.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS brands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    brand TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Woman',
    stock INTEGER NOT NULL DEFAULT 0,
    rating REAL NOT NULL DEFAULT 4.5,
    description TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT '',
    featured INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS saved (
    user_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, product_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS cart_items (
    user_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, product_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    total REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ชำระเงินแล้ว',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    price REAL NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id)
  );
`);

const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (!userCount) {
  const addUser = db.prepare('INSERT INTO users (username,password,role) VALUES (?,?,?)');
  addUser.run('demo', 'demo123', 'user');
  addUser.run('admin', 'admin1234', 'admin');
}
const brandNames = [...new Set(db.prepare('SELECT brand FROM products WHERE brand <> \'\'').all().map(x => x.brand))];
const addBrand = db.prepare('INSERT OR IGNORE INTO brands (name) VALUES (?)');
brandNames.forEach(name => addBrand.run(name));
['Woman', 'Men', 'Home', 'Food and Drink', 'Pet'].forEach(name => addBrand.run(name));

const productCount = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
if (!productCount) {
  const add = db.prepare(`INSERT INTO products
    (name,price,brand,category,stock,rating,description,image,featured)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const products = [
    ['Classic Blue Dress', 1290, 'Mellow', 'Woman', 18, 4.8, 'เดรสทรงคลาสสิก ใส่ได้ทั้งวันทำงานและวันหยุด', 'g-dress', 1],
    ['Everyday Cotton Shirt', 690, 'Northline', 'Men', 25, 4.6, 'เสื้อเชิ้ตผ้าคอตตอนเนื้อนุ่ม ระบายอากาศดี', 'g-shirt', 1],
    ['Street Runner Sneakers', 1890, 'Runway', 'Men', 12, 4.7, 'รองเท้าผ้าใบสำหรับวันสบาย ๆ น้ำหนักเบา', 'g-sneaker', 1],
    ['Soft Home Blanket', 990, 'Cozy Lab', 'Home', 20, 4.9, 'ผ้าห่มเนื้อนุ่มสำหรับมุมพักผ่อนในบ้าน', 'g-blanket', 1],
    ['Morning Coffee Set', 790, 'Daily Brew', 'Food and Drink', 30, 4.5, 'เซ็ตกาแฟสำหรับเริ่มต้นวันใหม่', 'g-coffee', 1],
    ['Pet Comfort Bed', 1150, 'Paw House', 'Pet', 10, 4.8, 'เบาะนอนนุ่มสำหรับเพื่อนตัวโปรด', 'g-snack', 1]
  ];
  const tx = db.transaction(rows => rows.forEach(row => add.run(...row)));
  tx(products);
  products.forEach(row => addBrand.run(row[2]));
}
// ---- เพิ่มคอลัมน์/ตารางใหม่สำหรับระบบแอดมิน (รันซ้ำได้ ไม่ลบข้อมูลเดิม) ----
const productCols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
if (!productCols.includes('expiry_date')) {
  db.exec('ALTER TABLE products ADD COLUMN expiry_date TEXT');
}

// ---- เพิ่มคอลัมน์ rating (ดาว) ให้ตาราง brands (รันซ้ำได้ ไม่ลบข้อมูลเดิม) ----
const brandCols = db.prepare('PRAGMA table_info(brands)').all().map(c => c.name);
if (!brandCols.includes('rating')) {
  db.exec("ALTER TABLE brands ADD COLUMN rating REAL NOT NULL DEFAULT 4.5");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    discount_percent REAL NOT NULL DEFAULT 0,
    product_id INTEGER,
    starts_at TEXT,
    ends_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('income','expense')),
    amount REAL NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// ---- ย้าย role เก่า 'admin' (สิทธิ์เดียวเห็นหมด) ให้กลายเป็น 'owner' ----
db.prepare("UPDATE users SET role='owner' WHERE role='admin'").run();

//  สร้างบัญชีพนักงานแยกสิทธิ์ ถ้ายังไม่มี 
const addUserIfMissing = (username, password, role) => {
  const exists = db.prepare('SELECT 1 FROM users WHERE username=?').get(username);
  if (!exists) db.prepare('INSERT INTO users (username,password,role) VALUES (?,?,?)').run(username, password, role);
};
addUserIfMissing('cashier', 'cashier123', 'cashier');
addUserIfMissing('manager', 'manager123', 'manager');
addUserIfMissing('owner', 'owner123', 'owner');

// ---- เพิ่มคอลัมน์เลขอ้างอิงใบเสร็จให้ตาราง orders (รันซ้ำได้ ไม่ลบข้อมูลเดิม) ----
const orderCols = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
if (!orderCols.includes('ref_code')) {
  db.exec('ALTER TABLE orders ADD COLUMN ref_code TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_ref_code ON orders(ref_code)');
}

console.log('Database ready:', path.join(dataDir, 'shop.db'));
db.close();