require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const fs = require('fs');
const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

// Multer for XLSX imports (memory)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Multer for return media (disk storage)
const MEDIA_DIR = path.join(__dirname, 'public', 'uploads', 'returns');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

const mediaStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MEDIA_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `ret-${req.params.id}-${Date.now()}-${Math.random().toString(36).slice(2,7)}${ext}`);
  }
});
const mediaUpload = multer({
  storage: mediaStorage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB max per file
  fileFilter: (req, file, cb) => {
    const allowed = /^(image|video)\//;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only images and videos are allowed'));
  }
});

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const morgan = require('morgan');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
if (process.env.NODE_ENV !== 'test') app.use(morgan('combined'));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500, message: { error: 'Too many requests' } }));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── PUBLIC SHOP INVENTORY CORS (NEW) ──────────────────────────────────────
// Only allows your shop domain(s) to call /api/shop/* routes. No auth needed
// for these routes since they're meant to be hit from the public shop site.
const SHOP_ALLOWED_ORIGINS = [
  'https://shop.tekhouz.com',
  'https://tekhouz.com',
  'http://localhost:3000'
];
app.use('/api/shop', (req, res, next) => {
  const origin = req.headers.origin;
  if (SHOP_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── MySQL Connection Pool ────────────────────────────────────────────────────
function buildPoolConfig() {
  const MYSQL_URL = process.env.MYSQL_URL;
  if (MYSQL_URL) {
    const url = new URL(MYSQL_URL);
    return {
      host: url.hostname,
      port: parseInt(url.port) || 3306,
      user: url.username,
      password: url.password,
      database: url.pathname.replace(/^\//, ''),
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    };
  }
  const DATABASE_URL = process.env.DATABASE_URL;
  if (DATABASE_URL) {
    const url = new URL(DATABASE_URL);
    return {
      host: url.hostname,
      port: parseInt(url.port) || 3306,
      user: url.username,
      password: url.password,
      database: url.pathname.replace(/^\//, ''),
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    };
  }
  return {
    host: process.env.MYSQLHOST || process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQLPORT || process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQLUSER || process.env.MYSQL_USER || 'root',
    password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || 'refurb',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  };
}

const pool = mysql.createPool(buildPoolConfig());

// ─── DB Helpers ───────────────────────────────────────────────────────────────
async function dbGet(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows[0] || null;
}

async function dbAll(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function dbRun(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return { insertId: result.insertId, affectedRows: result.affectedRows };
}

async function dbTx(fn) {
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    const result = await fn(conn);
    await conn.commit();
    conn.release();
    return result;
  } catch (err) {
    await conn.rollback();
    conn.release();
    throw err;
  }
}

// ─── Device Type Inference ────────────────────────────────────────────────────
function inferDeviceType(name, sku) {
  const s = ((name||'') + ' ' + (sku||'')).toLowerCase();
  if (/iphone|iphone/.test(s)) return 'iPhone';
  if (/ipad/.test(s)) return 'iPad';
  if (/macbook|mac book/.test(s)) return 'MacBook';
  if (/galaxy|samsung/.test(s)) return 'Samsung';
  if (/laptop/.test(s)) return 'Laptop';
  if (/tablet/.test(s)) return 'Tablet';
  if (/watch/.test(s)) return 'Smartwatch';
  if (/playstation|xbox|nintendo|gaming console/.test(s)) return 'Gaming Console';
  if (/smartphone|android/.test(s)) return 'Smartphone';
  return 'Other';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function g(row, ...keys) {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}
function gNum(row, ...keys) {
  for (const k of keys) {
    const v = parseFloat(row[k]);
    if (!isNaN(v)) return v;
  }
  return 0;
}

// ─── Full Configuration + SKU Generator (NEW — item #3 / #4) ─────────────────
// Builds a human-readable "full configuration" string from a device's fields.
// Works for both `inventory` rows and `po_items` rows since they share field names.
function buildFullConfiguration(row) {
  const parts = [];
  if (row.model) parts.push(row.model);
  if (row.storage) parts.push(row.storage);
  if (row.ram) parts.push(row.ram + ' RAM');
  if (row.color) parts.push(row.color);
  if (row.wifi_cellular) parts.push(row.wifi_cellular);
  if (row.processor) parts.push(row.processor);
  return parts.join(' / ');
}

// Builds a SKU string from full config + grade, e.g.:
//   "MACBOOK-AIR-13-2022-M2-256GB-16GB-STARLIGHT-A"
function buildSkuFromConfig(row, grade) {
  const cfg = buildFullConfiguration(row);
  const slug = (cfg + (grade ? ' ' + grade : ''))
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')   // non-alphanumeric -> dash
    .replace(/^-+|-+$/g, '')      // trim leading/trailing dashes
    .replace(/-{2,}/g, '-');      // collapse multiple dashes
  return slug;
}

// ─── Inventory auto-deduction helper (NEW — fixes orders not deducting stock) ─
// Matches an incoming order's serial/IMEI against `inventory` and marks the
// matching row sold. Used by /api/orders/import, /api/orders/shipstation,
// and the one-time backfill route.
async function tryMarkInventorySold(conn, serial, orderRowId) {
  if (!serial) return { matched: false };

  const [rows] = await conn.query(
    `SELECT id, status, sold_order_id FROM inventory WHERE serial_number = ? OR imei = ? LIMIT 1`,
    [serial, serial]
  );
  const invItem = rows[0];
  if (!invItem) return { matched: false };

  // Already sold to a DIFFERENT order — don't silently overwrite, just flag it.
  if (invItem.status === 'sold' && invItem.sold_order_id && invItem.sold_order_id !== orderRowId) {
    return { matched: true, conflict: true, sold_order_id: invItem.sold_order_id, inventory_id: invItem.id };
  }

  await conn.query(
    `UPDATE inventory SET status = 'sold', sold_order_id = ?, sold_at = NOW() WHERE id = ?`,
    [orderRowId, invItem.id]
  );
  return { matched: true, conflict: false, inventory_id: invItem.id };
}
// ─── Schema ───────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      import_date VARCHAR(20),
      source VARCHAR(255),
      serial_no VARCHAR(255),
      order_id VARCHAR(255),
      order_date VARCHAR(20),
      item_sku VARCHAR(500),
      item_name TEXT,
      recipient VARCHAR(500),
      qty INT DEFAULT 1,
      price DOUBLE DEFAULT 0,
      shipping_paid DOUBLE DEFAULT 0,
      device_type VARCHAR(100) DEFAULT 'Other',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_testing (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_row_id INT,
      device_type VARCHAR(100) DEFAULT 'iPhone',
      lcd_test VARCHAR(50) DEFAULT 'Not Tested',
      touch_test VARCHAR(50) DEFAULT 'Not Tested',
      battery_health INT,
      battery_cycles INT,
      face_id_test VARCHAR(50) DEFAULT 'Not Tested',
      fingerprint_test VARCHAR(50) DEFAULT 'Not Tested',
      front_camera_test VARCHAR(50) DEFAULT 'Not Tested',
      rear_camera_test VARCHAR(50) DEFAULT 'Not Tested',
      speaker_test VARCHAR(50) DEFAULT 'Not Tested',
      mic_test VARCHAR(50) DEFAULT 'Not Tested',
      wifi_test VARCHAR(50) DEFAULT 'Not Tested',
      cellular_test VARCHAR(50) DEFAULT 'Not Tested',
      bluetooth_test VARCHAR(50) DEFAULT 'Not Tested',
      charging_test VARCHAR(50) DEFAULT 'Not Tested',
      vibration_test VARCHAR(50) DEFAULT 'Not Tested',
      keyboard_test VARCHAR(50) DEFAULT 'Not Tested',
      trackpad_test VARCHAR(50) DEFAULT 'Not Tested',
      usb_ports_test VARCHAR(50) DEFAULT 'Not Tested',
      hinge_test VARCHAR(50) DEFAULT 'Not Tested',
      cosmetic_grade VARCHAR(50),
      overall_status VARCHAR(100) DEFAULT 'Not Tested',
      delivery_status VARCHAR(50) DEFAULT 'Pending',
      notes TEXT,
      tested_by VARCHAR(255),
      test_date VARCHAR(20),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_row_id) REFERENCES daily_orders(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      id INT AUTO_INCREMENT PRIMARY KEY,
      month VARCHAR(20) NOT NULL,
      year INT NOT NULL,
      vendor VARCHAR(255) NOT NULL,
      device_type VARCHAR(100) NOT NULL,
      po_number VARCHAR(255),
      vendor_item_id VARCHAR(255),
      manufacturer VARCHAR(255),
      part_number VARCHAR(255),
      description TEXT,
      serial_number VARCHAR(255),
      imei VARCHAR(255),
      condition_grade VARCHAR(100),
      missing_components TEXT,
      damages TEXT,
      color VARCHAR(100),
      storage VARCHAR(100),
      ram VARCHAR(100),
      screen_size VARCHAR(100),
      grade VARCHAR(100),
      sku VARCHAR(500),
      facility VARCHAR(255),
      carrier VARCHAR(255),
      lock_status VARCHAR(100),
      price DOUBLE DEFAULT 0,
      po_price DOUBLE DEFAULT 0,
      remarks TEXT,
      po_id INT,
      lot_id VARCHAR(255),
      invoice_no VARCHAR(255),
      model VARCHAR(255),
      wifi_cellular VARCHAR(100),
      status VARCHAR(50) DEFAULT 'available',
      sold_order_id INT,
      sold_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS \`settings\` (
      \`key\` VARCHAR(255) PRIMARY KEY,
      value TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_testing (
      id INT AUTO_INCREMENT PRIMARY KEY,
      inventory_id INT,
      device_type VARCHAR(100),
      lcd_test VARCHAR(50) DEFAULT 'Not Tested',
      touch_test VARCHAR(50) DEFAULT 'Not Tested',
      battery_health INT,
      battery_cycles INT,
      face_id_test VARCHAR(50) DEFAULT 'Not Tested',
      fingerprint_test VARCHAR(50) DEFAULT 'Not Tested',
      front_camera_test VARCHAR(50) DEFAULT 'Not Tested',
      rear_camera_test VARCHAR(50) DEFAULT 'Not Tested',
      speaker_test VARCHAR(50) DEFAULT 'Not Tested',
      mic_test VARCHAR(50) DEFAULT 'Not Tested',
      wifi_test VARCHAR(50) DEFAULT 'Not Tested',
      cellular_test VARCHAR(50) DEFAULT 'Not Tested',
      bluetooth_test VARCHAR(50) DEFAULT 'Not Tested',
      charging_test VARCHAR(50) DEFAULT 'Not Tested',
      vibration_test VARCHAR(50) DEFAULT 'Not Tested',
      keyboard_test VARCHAR(50) DEFAULT 'Not Tested',
      trackpad_test VARCHAR(50) DEFAULT 'Not Tested',
      usb_ports_test VARCHAR(50) DEFAULT 'Not Tested',
      hinge_test VARCHAR(50) DEFAULT 'Not Tested',
      final_grade VARCHAR(100),
      notes TEXT,
      tested_by VARCHAR(255),
      testing_owner VARCHAR(255),
      test_date VARCHAR(20),
      mdm_lock VARCHAR(50) DEFAULT 'Off',
      d_grade_description TEXT,
      overall_grade VARCHAR(50),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (inventory_id) REFERENCES inventory(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      lot_id VARCHAR(255),
      invoice_no VARCHAR(255),
      vendor_name VARCHAR(255) NOT NULL,
      purchase_month VARCHAR(50),
      purchase_year INT,
      device_types TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      modified_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS po_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      po_id INT,
      device_type VARCHAR(100),
      brand VARCHAR(255),
      model VARCHAR(255),
      sku VARCHAR(500),
      description TEXT,
      serial_number VARCHAR(255),
      imei VARCHAR(255),
      color VARCHAR(100),
      ram VARCHAR(100),
      storage VARCHAR(100),
      processor VARCHAR(255),
      wifi_cellular VARCHAR(100),
      qty INT DEFAULT 1,
      unit_price DOUBLE DEFAULT 0,
      notes TEXT,
      receive_status VARCHAR(50) DEFAULT 'Pending',
      inventory_id INT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS returns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      return_from VARCHAR(100),
      order_id VARCHAR(255),
      sku VARCHAR(500),
      customer_name VARCHAR(255),
      return_date DATE,
      device_config_sent TEXT,
      return_reason VARCHAR(255),
      customer_complaint TEXT,
      tracking_number VARCHAR(255),
      status VARCHAR(50) DEFAULT 'awaiting_shipment',
      received_date DATE,
      device_config_received TEXT,
      condition_received VARCHAR(100),
      charger_included VARCHAR(10),
      lcd_test VARCHAR(50) DEFAULT 'Not Tested',
      touch_test VARCHAR(50) DEFAULT 'Not Tested',
      battery_health INT,
      face_id_test VARCHAR(50) DEFAULT 'Not Tested',
      fingerprint_test VARCHAR(50) DEFAULT 'Not Tested',
      front_camera_test VARCHAR(50) DEFAULT 'Not Tested',
      rear_camera_test VARCHAR(50) DEFAULT 'Not Tested',
      speaker_test VARCHAR(50) DEFAULT 'Not Tested',
      mic_test VARCHAR(50) DEFAULT 'Not Tested',
      wifi_test VARCHAR(50) DEFAULT 'Not Tested',
      cellular_test VARCHAR(50) DEFAULT 'Not Tested',
      charging_test VARCHAR(50) DEFAULT 'Not Tested',
      grade VARCHAR(20),
      tech_notes TEXT,
      tested_by VARCHAR(255),
      test_date DATE,
      next_action VARCHAR(100),
      ops_status VARCHAR(50),
      warehouse_status VARCHAR(50),
      resell_action VARCHAR(100),
      final_action VARCHAR(100),
      ops_notes TEXT,
      ops_reviewed_by VARCHAR(255),
      ops_review_date DATE,
      created_by VARCHAR(255),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS return_media (
      id INT AUTO_INCREMENT PRIMARY KEY,
      return_id INT NOT NULL,
      filename VARCHAR(500) NOT NULL,
      original_name VARCHAR(500),
      mimetype VARCHAR(100),
      size BIGINT DEFAULT 0,
      uploaded_by VARCHAR(255),
      caption TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (return_id) REFERENCES returns(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS part_requisitions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      request_date DATE NOT NULL,
      requested_by VARCHAR(255) NOT NULL,
      part_type VARCHAR(50),
      part_category VARCHAR(100),
      model_compatibility VARCHAR(255),
      part_sku VARCHAR(500),
      color VARCHAR(100) DEFAULT 'NA',
      quality VARCHAR(50) DEFAULT 'OEM',
      quantity_needed INT DEFAULT 1,
      actual_ordered INT,
      priority VARCHAR(50) DEFAULT 'Normal',
      status VARCHAR(50) DEFAULT 'Requested',
      warehouse_location VARCHAR(255),
      notes TEXT,
      po_id INT,
      created_by VARCHAR(255),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS parts_pos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      vendor VARCHAR(255) NOT NULL,
      order_date DATE NOT NULL,
      expected_delivery DATE,
      warehouse_destination VARCHAR(255) DEFAULT 'Milpitas 741',
      status VARCHAR(50) DEFAULT 'Open',
      notes TEXT,
      requisition_id INT,
      created_by VARCHAR(255),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS parts_po_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      po_id INT NOT NULL,
      part_sku VARCHAR(500) NOT NULL,
      part_type VARCHAR(20),
      part_category VARCHAR(100),
      model_compatibility VARCHAR(500),
      quantity_ordered INT DEFAULT 1,
      received_quantity INT DEFAULT 0,
      unit_price DECIMAL(10,2) DEFAULT 0,
      notes TEXT,
      FOREIGN KEY (po_id) REFERENCES parts_pos(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      date_created DATE NOT NULL,
      customer_name VARCHAR(255) DEFAULT 'Tekhouz',
      imei_serial VARCHAR(255),
      issue_description TEXT,
      repair_type VARCHAR(100),
      assigned_technician VARCHAR(255),
      status VARCHAR(50) DEFAULT 'Open',
      warehouse_source VARCHAR(255) DEFAULT 'Milpitas 741',
      notes TEXT,
      created_by VARCHAR(255),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_order_parts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      service_order_id INT NOT NULL,
      part_sku VARCHAR(500) NOT NULL,
      part_type VARCHAR(20),
      model_compatibility VARCHAR(255),
      quantity INT DEFAULT 1,
      notes TEXT,
      FOREIGN KEY (service_order_id) REFERENCES service_orders(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  try {
    await pool.query(`ALTER TABLE returns ADD COLUMN sku VARCHAR(500) AFTER order_id`);
  } catch (e) { /* column already exists */ }

  try {
    await pool.query(`ALTER TABLE inventory ADD COLUMN full_configuration VARCHAR(500) AFTER model`);
  } catch (e) { /* already exists */ }

  try {
    await pool.query(`ALTER TABLE po_items ADD COLUMN full_configuration VARCHAR(500) AFTER model`);
  } catch (e) { /* already exists */ }

  try {
    const untyped = await dbAll("SELECT id, item_name, item_sku FROM daily_orders WHERE device_type IS NULL OR device_type = 'Other'");
    if (untyped.length > 0) {
      await dbTx(async (conn) => {
        for (const r of untyped) {
          await conn.query('UPDATE daily_orders SET device_type = ? WHERE id = ?', [inferDeviceType(r.item_name, r.item_sku), r.id]);
        }
      });
    }
  } catch (err) {
    console.warn('Backfill device_type warning:', err.message);
  }

  try {
    const invRows = await dbAll(
      `SELECT id, model, color, storage, ram FROM inventory WHERE full_configuration IS NULL OR full_configuration = ''`
    );
    if (invRows.length) {
      await dbTx(async (conn) => {
        for (const r of invRows) {
          const cfg = buildFullConfiguration(r);
          await conn.query('UPDATE inventory SET full_configuration = ? WHERE id = ?', [cfg, r.id]);
        }
      });
      console.log(`Backfilled full_configuration for ${invRows.length} inventory rows.`);
    }

    const poRows = await dbAll(
      `SELECT id, model, color, ram, storage FROM po_items WHERE full_configuration IS NULL OR full_configuration = ''`
    );
    if (poRows.length) {
      await dbTx(async (conn) => {
        for (const r of poRows) {
          const cfg = buildFullConfiguration(r);
          await conn.query('UPDATE po_items SET full_configuration = ? WHERE id = ?', [cfg, r.id]);
        }
      });
      console.log(`Backfilled full_configuration for ${poRows.length} po_items rows.`);
    }
  } catch (err) {
    console.warn('full_configuration backfill warning:', err.message);
  }

  const adminExists = await dbGet('SELECT id FROM users WHERE username = ?', ['admin']);
  if (!adminExists) {
    await dbRun('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [
      'admin', bcrypt.hashSync('admin123', 10), 'admin'
    ]);
    console.log('Default admin account created.');
  }

  console.log('Database initialized.');
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ─── DEFAULT_CATALOG ─────────────────────────────────────────────────────────
const DEFAULT_CATALOG = {
  colors: ['Space Gray','Silver','Gold','Rose Gold','Midnight','Starlight','Blue','Green','Purple','Red','Black','White','Yellow','Orange','Coral','Pacific Blue','Alpine Green','Deep Purple','Natural Titanium','Black Titanium','White Titanium'],
  ram: ['2GB','3GB','4GB','6GB','8GB','12GB','16GB','24GB','32GB','64GB','96GB','128GB'],
  storage: ['8GB','16GB','32GB','64GB','128GB','256GB','512GB','1TB','2TB','4TB'],
  models: {}
};
// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid username or password' });
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Dashboard ────────────────────────────────────────────────────────────────
app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { period = 'month', from, to } = req.query;

    let dateFrom, dateTo, resolvedPeriod = period;
    if (from && to) {
      dateFrom = from; dateTo = to; resolvedPeriod = 'custom';
    } else if (period === 'daily') {
      dateFrom = dateTo = today;
    } else if (period === 'week') {
      const wk = new Date(); wk.setDate(wk.getDate() - 6);
      dateFrom = wk.toISOString().split('T')[0]; dateTo = today;
    } else if (period === 'month') {
      dateFrom = today.slice(0,7) + '-01';
      const last = new Date(new Date().getFullYear(), new Date().getMonth()+1, 0);
      dateTo = last.toISOString().split('T')[0];
    } else if (period === 'year') {
      dateFrom = today.slice(0,4) + '-01-01';
      dateTo = today.slice(0,4) + '-12-31';
    }

    const dateFilter = dateFrom ? `AND o.import_date >= '${dateFrom}' AND o.import_date <= '${dateTo}'` : '';
    const orderBase = `FROM daily_orders o LEFT JOIN order_testing t ON o.id = t.order_row_id WHERE 1=1 ${dateFilter}`;

    const [
      invTotalRow,
      invTestedRow,
      workingRow,
      gradesRows,
      overallGradesRows,
      mdmOnRow,
      poTotalRow,
      poUnitsOrderedRow,
      poUnitsReceivedRow,
      poSkusPendingRow,
      byMonthRows,
      notTestedRows,
      ordTotalRow,
      ordPendingRow,
      ordShippedRow,
      ordDeliveredRow,
      ordCancelledRow,
      byTypeRows,
      byVendorRows,
    ] = await Promise.all([
      dbGet('SELECT COUNT(*) c FROM inventory'),
      dbGet('SELECT COUNT(*) c FROM inventory_testing'),
      dbGet("SELECT COUNT(*) c FROM inventory_testing WHERE overall_grade = 'Working'"),
      dbAll(`SELECT COALESCE(overall_grade,'Unknown') grade, COUNT(*) count FROM inventory_testing WHERE overall_grade IS NOT NULL AND overall_grade != '' GROUP BY overall_grade ORDER BY CASE overall_grade WHEN 'A+' THEN 1 WHEN 'A' THEN 2 WHEN 'B+' THEN 3 WHEN 'B' THEN 4 WHEN 'C' THEN 5 WHEN 'D-Fixable' THEN 6 WHEN 'D-Parts' THEN 7 WHEN 'S-Scrap' THEN 8 ELSE 9 END`),
      dbAll(`SELECT COALESCE(overall_grade,'Unknown') grade, COUNT(*) count FROM inventory_testing GROUP BY overall_grade ORDER BY count DESC`),
      dbGet("SELECT COUNT(*) c FROM inventory_testing WHERE mdm_lock = 'On'"),
      dbGet('SELECT COUNT(*) c FROM purchase_orders'),
      dbGet('SELECT COALESCE(SUM(qty),0) c FROM po_items'),
      dbGet("SELECT COALESCE(SUM(qty),0) c FROM po_items WHERE receive_status='Received'"),
      dbGet("SELECT COUNT(*) c FROM po_items WHERE receive_status != 'Received' OR receive_status IS NULL"),
      dbAll(`SELECT year, month, COUNT(*) count FROM inventory WHERE year IS NOT NULL AND month != '' GROUP BY year, month ORDER BY year DESC, CASE month WHEN 'January' THEN 1 WHEN 'February' THEN 2 WHEN 'March' THEN 3 WHEN 'April' THEN 4 WHEN 'May' THEN 5 WHEN 'June' THEN 6 WHEN 'July' THEN 7 WHEN 'August' THEN 8 WHEN 'September' THEN 9 WHEN 'October' THEN 10 WHEN 'November' THEN 11 WHEN 'December' THEN 12 END DESC LIMIT 8`),
      dbAll(`SELECT i.id, i.vendor, i.model, i.device_type, i.serial_number, i.lot_id, i.month, i.year FROM inventory i LEFT JOIN inventory_testing t ON i.id = t.inventory_id WHERE t.id IS NULL ORDER BY i.created_at DESC LIMIT 8`),
      dbGet(`SELECT COUNT(*) c ${orderBase}`),
      dbGet(`SELECT COUNT(*) c ${orderBase} AND COALESCE(t.delivery_status,'Pending') = 'Pending'`),
      dbGet(`SELECT COUNT(*) c ${orderBase} AND t.delivery_status = 'Shipped'`),
      dbGet(`SELECT COUNT(*) c ${orderBase} AND t.delivery_status = 'Delivered'`),
      dbGet(`SELECT COUNT(*) c ${orderBase} AND t.delivery_status = 'Cancelled'`),
      dbAll("SELECT device_type, COUNT(*) count FROM inventory WHERE device_type IS NOT NULL AND device_type != '' GROUP BY device_type ORDER BY count DESC"),
      dbAll("SELECT vendor, COUNT(*) count FROM inventory WHERE vendor IS NOT NULL AND vendor != '' GROUP BY vendor ORDER BY count DESC LIMIT 10"),
    ]);

    const invTotal = invTotalRow.c;
    const invTested = invTestedRow.c;
    const invNotTested = invTotal - invTested;
    const working = workingRow.c;
    const testRate = invTested > 0 ? Math.round(working / invTested * 100) : 0;
    const mdmOn = mdmOnRow.c;
    const mdmRate = invTested > 0 ? Math.round(mdmOn / invTested * 100) : 0;
    const poTotal = poTotalRow.c;
    const poUnitsOrdered = poUnitsOrderedRow.c;
    const poUnitsReceived = poUnitsReceivedRow.c;
    const poSkusPending = poSkusPendingRow.c;

    res.json({
      period: resolvedPeriod, dateFrom, dateTo,
      orders: {
        total:     ordTotalRow.c,
        pending:   ordPendingRow.c,
        shipped:   ordShippedRow.c,
        delivered: ordDeliveredRow.c,
        cancelled: ordCancelledRow.c,
      },
      inventory: {
        total: invTotal, tested: invTested, notTested: invNotTested,
        workingRate: testRate, mdmRate,
        byType:   byTypeRows,
        byVendor: byVendorRows,
        byMonth:  byMonthRows,
        grades: gradesRows,
        overallGrades: overallGradesRows,
      },
      po: {
        total: poTotal, unitsOrdered: poUnitsOrdered, unitsReceived: poUnitsReceived, skusPending: poSkusPending,
        receiveRate: poUnitsOrdered > 0 ? Math.round(poUnitsReceived / poUnitsOrdered * 100) : 0
      },
      notTested: notTestedRows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Daily Orders ─────────────────────────────────────────────────────────────
app.get('/api/orders', auth, async (req, res) => {
  try {
    const { date, source, search, delivery, page = 1, limit = 100 } = req.query;
    let q = `SELECT o.*, COALESCE(t.delivery_status,'Pending') delivery_status,
             t.cosmetic_grade, t.overall_status, t.id test_id, t.tested_by, t.test_date, t.notes,
             t.device_type AS testing_device_type
             FROM daily_orders o LEFT JOIN order_testing t ON o.id = t.order_row_id WHERE 1=1`;
    const p = [];
    if (date) { q += ' AND o.import_date = ?'; p.push(date); }
    if (source) { q += ' AND o.source = ?'; p.push(source); }
    if (delivery) { q += " AND COALESCE(t.delivery_status,'Pending') = ?"; p.push(delivery); }
    if (search) {
      q += ' AND (o.serial_no LIKE ? OR o.order_id LIKE ? OR o.item_name LIKE ? OR o.item_sku LIKE ? OR o.recipient LIKE ?)';
      const s = `%${search}%`; p.push(s,s,s,s,s);
    }
    q += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
    p.push(parseInt(limit), (parseInt(page)-1) * parseInt(limit));

    const [orders, totalRow, sourcesRows, datesRows] = await Promise.all([
      dbAll(q, p),
      dbGet('SELECT COUNT(*) c FROM daily_orders'),
      dbAll('SELECT DISTINCT source FROM daily_orders ORDER BY source'),
      dbAll('SELECT DISTINCT import_date FROM daily_orders ORDER BY import_date DESC LIMIT 30'),
    ]);

    res.json({
      orders,
      total: totalRow.c,
      sources: sourcesRows.map(r => r.source),
      dates: datesRows.map(r => r.import_date),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/orders/:id', auth, async (req, res) => {
  try {
    const allowed = ['serial_no', 'item_name', 'item_sku', 'recipient', 'price', 'import_date'];
    const data = {};
    for (const k of allowed) { if (req.body[k] !== undefined) data[k] = req.body[k]; }
    if (!Object.keys(data).length) return res.status(400).json({ error: 'No valid fields' });
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    await dbRun(`UPDATE daily_orders SET ${sets} WHERE id = ?`, [...Object.values(data), req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCHED: now auto-deducts matching inventory by serial/IMEI on import
app.post('/api/orders/import', auth, upload.single('file'), async (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, {cellDates: true});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, {cellDates: true});
    const importDate = req.body.ship_date || new Date().toISOString().split('T')[0];

    function parseXlDate(raw) {
      if (!raw) return '';
      if (raw instanceof Date) {
        return `${raw.getFullYear()}-${String(raw.getMonth()+1).padStart(2,'0')}-${String(raw.getDate()).padStart(2,'0')}`;
      }
      const s = String(raw);
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      const d = new Date(raw);
      if (!isNaN(d)) return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      return s;
    }

    let count = 0;
    let conflicts = [];
    await dbTx(async (conn) => {
      for (const row of rows) {
        const od = parseXlDate(row['Order Date']);
        const serialNo = g(row,'Serial No.','Serial No','SERIAL_NO','serial_no');

        const [result] = await conn.query(
          `INSERT INTO daily_orders
            (import_date, source, serial_no, order_id, order_date, item_sku, item_name, recipient, qty, price, device_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            importDate,
            g(row,'Source','source'),
            serialNo,
            g(row,'Order ID','order_id','OrderID'),
            od,
            g(row,'Item SKU','item_sku','SKU'),
            g(row,'Item Name','item_name','Description'),
            g(row,'Recipient','recipient'),
            parseInt(row['Qty'] || row['qty'] || 1) || 1,
            gNum(row,'Price','price'),
            inferDeviceType(g(row,'Item Name','item_name','Description'), g(row,'Item SKU','item_sku','SKU'))
          ]
        );

        // NEW: auto-deduct matching inventory item
        const matchResult = await tryMarkInventorySold(conn, serialNo, result.insertId);
        if (matchResult.conflict) conflicts.push({ serial: serialNo, sold_order_id: matchResult.sold_order_id });

        count++;
      }
    });
    res.json({ success: true, imported: count, inventory_conflicts: conflicts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/orders/:id', auth, adminOnly, async (req, res) => {
  try {
    await dbRun('DELETE FROM daily_orders WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders/bulk-delete', auth, adminOnly, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No IDs provided' });
    const placeholders = ids.map(() => '?').join(',');
    const result = await dbRun(`DELETE FROM daily_orders WHERE id IN (${placeholders})`, ids);
    res.json({ deleted: result.affectedRows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ShipStation ──────────────────────────────────────────────────────────────
app.get('/api/settings/shipstation', auth, async (req, res) => {
  try {
    const keyRow = await dbGet("SELECT value FROM `settings` WHERE `key` = 'ss_api_key'");
    const secRow = await dbGet("SELECT value FROM `settings` WHERE `key` = 'ss_api_secret'");
    res.json({ apiKey: keyRow?.value || '', hasSecret: !!secRow?.value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings/shipstation', auth, async (req, res) => {
  try {
    const { apiKey, apiSecret } = req.body;
    if (apiKey !== undefined) {
      await dbRun("INSERT INTO `settings` (`key`, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)", ['ss_api_key', apiKey]);
    }
    if (apiSecret !== undefined) {
      await dbRun("INSERT INTO `settings` (`key`, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)", ['ss_api_secret', apiSecret]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCHED: now tries to extract serial/IMEI from ShipStation item options
// and auto-deducts matching inventory.
app.post('/api/orders/shipstation', auth, async (req, res) => {
  try {
    let { apiKey, apiSecret, ship_date, orderStatus, saveCredentials } = req.body;

    if (!apiKey) {
      const r = await dbGet("SELECT value FROM `settings` WHERE `key`='ss_api_key'");
      apiKey = r?.value;
    }
    if (!apiSecret) {
      const r = await dbGet("SELECT value FROM `settings` WHERE `key`='ss_api_secret'");
      apiSecret = r?.value;
    }
    if (!apiKey || !apiSecret) return res.status(400).json({ error: 'ShipStation API credentials not configured' });

    if (saveCredentials) {
      await dbRun("INSERT INTO `settings` (`key`, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)", ['ss_api_key', apiKey]);
      await dbRun("INSERT INTO `settings` (`key`, value) VALUES (?,?) ON DUPLICATE KEY UPDATE value = VALUES(value)", ['ss_api_secret', apiSecret]);
    }

    const importDate = ship_date || new Date().toISOString().split('T')[0];
    const creds = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
    const qs = new URLSearchParams({ orderStatus: orderStatus || 'awaiting_shipment', pageSize: '500' });
    if (ship_date) { qs.set('createDateStart', ship_date + ' 00:00:00'); qs.set('createDateEnd', ship_date + ' 23:59:59'); }

    const resp = await fetch(`https://ssapi.shipstation.com/orders?${qs}`, {
      headers: { Authorization: `Basic ${creds}` }
    });
    if (!resp.ok) {
      const txt = await resp.text();
      return res.status(resp.status).json({ error: `ShipStation: ${resp.status} — ${txt.slice(0,200)}` });
    }
    const data = await resp.json();
    const orders = data.orders || [];

    let count = 0;
    let conflicts = [];
    await dbTx(async (conn) => {
      for (const o of orders) {
        const oDate = o.orderDate ? o.orderDate.split('T')[0] : importDate;
        const store = o.advancedOptions?.storeName || 'ShipStation';
        const shippingPaid = o.shippingAmount || 0;
        for (const item of o.items || []) {
          // NEW: try to find a serial/IMEI from ShipStation's item options
          let serialFromOptions = '';
          if (Array.isArray(item.options)) {
            const opt = item.options.find(o2 => /serial|imei/i.test(o2.name || ''));
            if (opt) serialFromOptions = (opt.value || '').trim();
          }

          const [result] = await conn.query(
            `INSERT INTO daily_orders
              (import_date, source, serial_no, order_id, order_date, item_sku, item_name, recipient, qty, price, shipping_paid, device_type)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              importDate, store, serialFromOptions, String(o.orderNumber || o.orderId),
              oDate, item.sku || '', item.name || '',
              o.shipTo?.name || '', item.quantity || 1, item.unitPrice || 0, shippingPaid,
              inferDeviceType(item.name, item.sku)
            ]
          );

          // NEW: auto-deduct matching inventory item
          const matchResult = await tryMarkInventorySold(conn, serialFromOptions, result.insertId);
          if (matchResult.conflict) conflicts.push({ serial: serialFromOptions, sold_order_id: matchResult.sold_order_id });

          count++;
        }
      }
    });
    res.json({ success: true, imported: count, ordersFound: orders.length, inventory_conflicts: conflicts });
  } catch (ex) {
    res.status(500).json({ error: ex.message });
  }
});

app.get('/api/orders/:id/testing', auth, async (req, res) => {
  try {
    const row = await dbGet('SELECT * FROM order_testing WHERE order_row_id = ?', [req.params.id]);
    res.json(row || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders/:id/testing', auth, async (req, res) => {
  try {
    const existing = await dbGet('SELECT id FROM order_testing WHERE order_row_id = ?', [req.params.id]);
    const data = { ...req.body };
    delete data.id; delete data.order_row_id; delete data.created_at;

    if (existing) {
      const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
      await dbRun(`UPDATE order_testing SET ${sets} WHERE order_row_id = ?`, [...Object.values(data), req.params.id]);
      res.json({ success: true, action: 'updated' });
    } else {
      const keys = Object.keys(data);
      await dbRun(
        `INSERT INTO order_testing (order_row_id, ${keys.join(', ')}) VALUES (?, ${keys.map(()=>'?').join(', ')})`,
        [req.params.id, ...Object.values(data)]
      );
      res.json({ success: true, action: 'created' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Inventory barcode lookup ──────────────────────────────────────────────────
app.get('/api/inventory/scan', auth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'No scan value' });
    const val = q.trim();
    const scanQ = `SELECT i.*, t.final_grade tested_grade, t.overall_grade, t.mdm_lock, t.battery_health,
      o.order_id sold_to_order_ref, o.import_date sold_date
      FROM inventory i
      LEFT JOIN inventory_testing t ON i.id = t.inventory_id
      LEFT JOIN daily_orders o ON i.sold_order_id = o.id`;
    let item = await dbGet(`${scanQ} WHERE (i.serial_number = ? OR i.imei = ?) LIMIT 1`, [val, val]);
    if (!item && val.toUpperCase().startsWith('INV-')) {
      const id = parseInt(val.split('-')[1]);
      item = await dbGet(`${scanQ} WHERE i.id = ?`, [id]);
    }
    if (!item) {
      item = await dbGet(`${scanQ} WHERE i.sku = ? LIMIT 1`, [val]);
    }
    if (!item) return res.status(404).json({ error: `No inventory item found for: ${val}` });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Assign serial to order (with duplicate + sold checks) ────────────────────
app.post('/api/orders/:id/assign-serial', auth, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { serial } = req.body;
    if (!serial) return res.status(400).json({ error: 'Serial number is required' });

    const duplicate = await dbGet(
      `SELECT id, order_id FROM daily_orders WHERE serial_no = ? AND id != ?`,
      [serial, orderId]
    );
    if (duplicate) {
      return res.status(409).json({
        error: `Serial ${serial} is already assigned to order #${duplicate.order_id}`,
        conflict_order: duplicate.order_id
      });
    }

    let invItem = null;
    try {
      invItem = await dbGet(
        `SELECT id, status, sold_order_id FROM inventory WHERE serial_number = ? OR imei = ? LIMIT 1`,
        [serial, serial]
      );
    } catch { /* skip sold check */ }

    if (invItem && invItem.status === 'sold' && invItem.sold_order_id && invItem.sold_order_id !== orderId) {
      let soldOrderRef = invItem.sold_order_id;
      try {
        const soldTo = await dbGet('SELECT order_id FROM daily_orders WHERE id = ?', [invItem.sold_order_id]);
        if (soldTo) soldOrderRef = soldTo.order_id;
      } catch {}
      return res.status(409).json({
        error: `This device is already sold (Order #${soldOrderRef})`,
        conflict_order: soldOrderRef
      });
    }

    await dbRun('UPDATE daily_orders SET serial_no = ? WHERE id = ?', [serial, orderId]);

    let inventoryUpdated = false;
    if (invItem) {
      try {
        await dbRun(
          `UPDATE inventory SET status = 'sold', sold_order_id = ?, sold_at = NOW() WHERE id = ?`,
          [orderId, invItem.id]
        );
        inventoryUpdated = true;
      } catch {}
    }

    res.json({ success: true, inventory_updated: inventoryUpdated });
  } catch (err) {
    console.error('assign-serial error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to assign serial' });
  }
});

// ─── NEW: One-time backfill for orders that were missed before this patch ────
// Call once via POST /api/admin/backfill-inventory-deduction with an admin
// JWT, then feel free to remove this route.
app.post('/api/admin/backfill-inventory-deduction', auth, adminOnly, async (req, res) => {
  try {
    const orders = await dbAll(
      `SELECT id, serial_no FROM daily_orders WHERE serial_no IS NOT NULL AND serial_no != ''`
    );
    let matched = 0, conflicts = [];

    await dbTx(async (conn) => {
      for (const o of orders) {
        const result = await tryMarkInventorySold(conn, o.serial_no, o.id);
        if (result.matched && !result.conflict) matched++;
        if (result.conflict) conflicts.push({ order_id: o.id, serial: o.serial_no, sold_order_id: result.sold_order_id });
      }
    });

    res.json({ success: true, total_orders_checked: orders.length, newly_matched: matched, conflicts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Inventory ────────────────────────────────────────────────────────────────
app.get('/api/inventory', auth, async (req, res) => {
  try {
    const { month, year, vendor, device_type, lot_id, search, page = 1, limit = 100 } = req.query;
    let q = `SELECT i.*,
             t.id test_id, t.tested_by, t.testing_owner, t.test_date,
             t.final_grade tested_grade, t.overall_grade,
             t.mdm_lock, t.d_grade_description,
             t.lcd_test, t.touch_test, t.battery_health, t.battery_cycles,
             t.face_id_test, t.fingerprint_test, t.front_camera_test, t.rear_camera_test,
             t.speaker_test, t.mic_test, t.wifi_test, t.cellular_test, t.bluetooth_test,
             t.charging_test, t.vibration_test, t.keyboard_test, t.trackpad_test,
             t.usb_ports_test, t.hinge_test, t.notes test_notes
             FROM inventory i LEFT JOIN inventory_testing t ON i.id = t.inventory_id WHERE 1=1`;
    const p = [];
    if (month) { q += ' AND i.month = ?'; p.push(month); }
    if (year) { q += ' AND i.year = ?'; p.push(parseInt(year)); }
    if (vendor) { q += ' AND i.vendor = ?'; p.push(vendor); }
    if (device_type) { q += ' AND i.device_type = ?'; p.push(device_type); }
    if (lot_id) { q += ' AND i.lot_id LIKE ?'; p.push(`%${lot_id}%`); }
    if (search) {
      q += ' AND (i.serial_number LIKE ? OR i.imei LIKE ? OR i.description LIKE ? OR i.sku LIKE ? OR i.model LIKE ?)';
      const s = `%${search}%`; p.push(s,s,s,s,s);
    }
    q += ' ORDER BY i.created_at DESC LIMIT ? OFFSET ?';
    p.push(parseInt(limit), (parseInt(page)-1)*parseInt(limit));

    const [items, totalRow, vendorsRows, monthsRows, typesRows] = await Promise.all([
      dbAll(q, p),
      dbGet('SELECT COUNT(*) c FROM inventory'),
      dbAll('SELECT DISTINCT vendor FROM inventory ORDER BY vendor'),
      dbAll('SELECT DISTINCT month, year FROM inventory ORDER BY year DESC, month DESC'),
      dbAll('SELECT DISTINCT device_type FROM inventory ORDER BY device_type'),
    ]);

    res.json({
      items,
      total: totalRow.c,
      vendors: vendorsRows.map(r => r.vendor),
      months: monthsRows,
      types: typesRows.map(r => r.device_type),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/inventory/export', auth, async (req, res) => {
  try {
    const { month, year, vendor, device_type, lot_id, search } = req.query;
    let q = `SELECT i.*,
             t.tested_by, t.testing_owner, t.test_date,
             t.final_grade tested_grade, t.overall_grade,
             t.mdm_lock, t.d_grade_description,
             t.lcd_test, t.touch_test, t.battery_health, t.battery_cycles,
             t.face_id_test, t.fingerprint_test, t.front_camera_test, t.rear_camera_test,
             t.speaker_test, t.mic_test, t.wifi_test, t.cellular_test, t.bluetooth_test,
             t.charging_test, t.vibration_test, t.keyboard_test, t.trackpad_test,
             t.usb_ports_test, t.hinge_test, t.notes test_notes
             FROM inventory i LEFT JOIN inventory_testing t ON i.id = t.inventory_id WHERE 1=1`;
    const p = [];
    if (month) { q += ' AND i.month = ?'; p.push(month); }
    if (year) { q += ' AND i.year = ?'; p.push(parseInt(year)); }
    if (vendor) { q += ' AND i.vendor = ?'; p.push(vendor); }
    if (device_type) { q += ' AND i.device_type = ?'; p.push(device_type); }
    if (lot_id) { q += ' AND i.lot_id LIKE ?'; p.push(`%${lot_id}%`); }
    if (search) {
      q += ' AND (i.serial_number LIKE ? OR i.imei LIKE ? OR i.description LIKE ? OR i.sku LIKE ? OR i.model LIKE ?)';
      const s = `%${search}%`; p.push(s,s,s,s,s);
    }
    q += ' ORDER BY i.created_at DESC';
    const rows = await dbAll(q, p);

    const hdr = ['Vendor','Month','Year','Lot ID','Invoice No','Device Type','Model','Full Configuration','Description',
      'Serial Number','IMEI','Color','Storage','RAM','WiFi/Cellular','Screen Size',
      'Grade','Condition','Lock Status','Carrier','Missing Components','Damages',
      'SKU','PO Number','Price','PO Price','Facility','Remarks','Status',
      'Overall Grade','Final Grade (Tested)','Test Date','Testing Owner','MDM Lock','D Grade Description',
      'LCD','Touch','Face ID/FP','Fingerprint','Front Camera','Rear Camera',
      'Speaker','Mic','WiFi','Cellular','Bluetooth','Charging','Vibration',
      'Keyboard','Trackpad','USB Ports','Hinge','Battery Health %','Battery Cycles','Test Notes'];

    const data = [hdr, ...rows.map(it => [
      it.vendor, it.month, it.year, it.lot_id||'', it.invoice_no||'', it.device_type, it.model||'', it.full_configuration||'', it.description||'',
      it.serial_number||'', it.imei||'', it.color||'', it.storage||'', it.ram||'', it.wifi_cellular||'', it.screen_size||'',
      it.grade||'', it.condition_grade||'', it.lock_status||'', it.carrier||'', it.missing_components||'', it.damages||'',
      it.sku||'', it.po_number||'', it.price||0, it.po_price||0, it.facility||'', it.remarks||'', it.status||'available',
      it.overall_grade||'', it.tested_grade||'', it.test_date||'', it.testing_owner||it.tested_by||'', it.mdm_lock||'', it.d_grade_description||'',
      it.lcd_test||'', it.touch_test||'', it.face_id_test||'', it.fingerprint_test||'',
      it.front_camera_test||'', it.rear_camera_test||'', it.speaker_test||'', it.mic_test||'',
      it.wifi_test||'', it.cellular_test||'', it.bluetooth_test||'', it.charging_test||'',
      it.vibration_test||'', it.keyboard_test||'', it.trackpad_test||'', it.usb_ports_test||'', it.hinge_test||'',
      it.battery_health||'', it.battery_cycles||'', it.test_notes||''
    ])];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), 'Inventory');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="Inventory_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCHED: this route is ALSO your manual entry endpoint (item #1) — any
// frontend form can POST here with whatever fields it has. Now also
// auto-fills full_configuration + sku when not explicitly provided (item #3/#4).
app.post('/api/inventory', auth, async (req, res) => {
  try {
    const d = { ...req.body };
    if (!d.full_configuration) d.full_configuration = buildFullConfiguration(d);
    if (!d.sku) d.sku = buildSkuFromConfig(d, d.grade || d.condition_grade);

    const keys = Object.keys(d).filter(k => k !== 'id' && k !== 'created_at');
    const result = await dbRun(
      `INSERT INTO inventory (${keys.join(', ')}) VALUES (${keys.map(()=>'?').join(', ')})`,
      keys.map(k => d[k])
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCHED: regenerates full_configuration + sku when specs change
app.put('/api/inventory/:id', auth, async (req, res) => {
  try {
    const d = { ...req.body };
    if (d.model || d.color || d.storage || d.ram) {
      d.full_configuration = buildFullConfiguration(d);
      d.sku = buildSkuFromConfig(d, d.grade || d.condition_grade);
    }
    const keys = Object.keys(d).filter(k => k !== 'id' && k !== 'created_at');
    await dbRun(
      `UPDATE inventory SET ${keys.map(k=>`${k}=?`).join(', ')} WHERE id = ?`,
      [...keys.map(k => d[k]), req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/inventory/:id', auth, adminOnly, async (req, res) => {
  try {
    await dbRun('DELETE FROM inventory WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/inventory/bulk-delete', auth, adminOnly, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No IDs provided' });
    const placeholders = ids.map(() => '?').join(',');
    const result = await dbRun(`DELETE FROM inventory WHERE id IN (${placeholders})`, ids);
    res.json({ deleted: result.affectedRows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/inventory/import', auth, upload.single('file'), async (req, res) => {
  try {
    const { vendor, month, year, device_type } = req.body;
    const wb = XLSX.read(req.file.buffer);
    let totalImported = 0;

    await dbTx(async (conn) => {
      for (const sheetName of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
        for (const row of rows) {
          let sn = g(row,'SERIAL_NUMBER','Serial Number','SERIAL NUMBER','Serial_Number');
          let imei = g(row,'IMEI','IMEI No.','imei','IMEI No');
          if (!sn && !imei) {
            const desc = g(row,'Description','description');
            const match = desc.match(/\[(\d{10,20})\]/);
            if (match) imei = match[1];
          }

          const model = g(row,'Description','DESCRIPTION','description','Item','FullModel','Model');
          const color = g(row,'Color','COLOR','color','Color.1');
          const storage = g(row,'Storage','STORAGE','storage','Hard_Drive_1','Storage_Capacity');
          const ram = g(row,'RAM','Ram','ram');
          const grade = g(row,'Grade','GRADE','grade','Grade.1','Condition');

          const fullConfig = buildFullConfiguration({ model, color, storage, ram });
          const sku = g(row,"Sku's",'SKU','sku','Sku','SKUs') || buildSkuFromConfig({ model, color, storage, ram }, grade);

          await conn.query(
            `INSERT INTO inventory
              (month, year, vendor, device_type, po_number, vendor_item_id, manufacturer, part_number,
               description, model, full_configuration, serial_number, imei, condition_grade, missing_components, damages,
               color, storage, ram, screen_size, grade, sku, facility, carrier, lock_status, price, po_price, remarks)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              month, parseInt(year), vendor, device_type,
              g(row,'PO','po','PO Number','PO#'),
              g(row,'Apto_id','id','S. No.','S.No.','Item_ID'),
              g(row,'MANUFACTURER','Manufacturer','Brand'),
              g(row,'PART_NUMBER','Part Number','PartNumber','Model Number'),
              model, model, fullConfig,
              sn, imei,
              g(row,'CONDITION','Condition','Condition_Grade'),
              g(row,'Missing Components','MISSING COMPONENTS','Missing_Components'),
              g(row,'Damages','DAMAGES','Damage','Defects','Notes'),
              color, storage, ram,
              g(row,'Screen Size','SCREEN SIZE','Screen_Size'),
              grade,
              sku,
              g(row,'Facility','facility','id_PalletDestination','Location'),
              g(row,'Carrier','carrier','Lock/Unlock','Lock/unlock','Lock_Unlock'),
              g(row,'Lock/Unlock','Lock/unlock','lock_status','Lock_Unlock'),
              gNum(row,'Price','price','PRICE'),
              gNum(row,'PO Price','po_price','PO_Price','Cost'),
              g(row,'Remarks','REMARKS','remarks','Notes','Krati-remarks','Battery Count','Battery_Function')
            ]
          );
          totalImported++;
        }
      }
    });
    res.json({ success: true, imported: totalImported });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/inventory/:id/testing', auth, async (req, res) => {
  try {
    const row = await dbGet('SELECT * FROM inventory_testing WHERE inventory_id = ?', [req.params.id]);
    res.json(row || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/inventory/:id/testing', auth, async (req, res) => {
  try {
    const existing = await dbGet('SELECT id FROM inventory_testing WHERE inventory_id = ?', [req.params.id]);
    const data = { ...req.body };
    delete data.id; delete data.inventory_id; delete data.created_at;

    if (existing) {
      const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
      await dbRun(`UPDATE inventory_testing SET ${sets} WHERE inventory_id = ?`, [...Object.values(data), req.params.id]);
      res.json({ success: true, action: 'updated' });
    } else {
      const keys = Object.keys(data);
      await dbRun(
        `INSERT INTO inventory_testing (inventory_id, ${keys.join(', ')}) VALUES (?, ${keys.map(()=>'?').join(', ')})`,
        [req.params.id, ...Object.values(data)]
      );
      res.json({ success: true, action: 'created' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ─── Users ────────────────────────────────────────────────────────────────────
app.get('/api/users', auth, adminOnly, async (req, res) => {
  try {
    const users = await dbAll('SELECT id, username, role, created_at FROM users ORDER BY created_at');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', auth, adminOnly, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    const result = await dbRun(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      [username, bcrypt.hashSync(password, 10), role || 'user']
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(400).json({ error: 'Username already exists' });
  }
});

app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
    await dbRun('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id/password', auth, adminOnly, async (req, res) => {
  try {
    await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(req.body.password, 10), req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Full Database Backup ─────────────────────────────────────────────────────
app.get('/api/backup/download', auth, adminOnly, async (req, res) => {
  try {
    const [orders, testing, inventory, invTesting, purchaseOrders, poItems, users] = await Promise.all([
      dbAll('SELECT * FROM daily_orders ORDER BY id'),
      dbAll('SELECT * FROM order_testing ORDER BY id'),
      dbAll('SELECT * FROM inventory ORDER BY id'),
      dbAll('SELECT * FROM inventory_testing ORDER BY id'),
      dbAll('SELECT * FROM purchase_orders ORDER BY id'),
      dbAll('SELECT * FROM po_items ORDER BY id'),
      dbAll('SELECT id, username, role, created_at FROM users ORDER BY id'),
    ]);

    const wb = XLSX.utils.book_new();
    const addSheet = (name, rows) => {
      if (!rows.length) { XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[`No data in ${name}`]]), name); return; }
      const headers = Object.keys(rows[0]);
      const data = [headers, ...rows.map(r => headers.map(h => r[h] ?? ''))];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), name);
    };

    addSheet('Daily Orders', orders);
    addSheet('Order Testing', testing);
    addSheet('Inventory', inventory);
    addSheet('Inventory Testing', invTesting);
    addSheet('Purchase Orders', purchaseOrders);
    addSheet('PO Items', poItems);
    addSheet('Users', users);

    const date = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="Tekhouz-Backup-${date}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Catalog Settings ─────────────────────────────────────────────────────────
app.get('/api/settings/catalog', auth, async (req, res) => {
  try {
    const row = await dbGet("SELECT value FROM `settings` WHERE `key` = 'device_catalog'");
    if (row) {
      try { return res.json(JSON.parse(row.value)); } catch {}
    }
    res.json(DEFAULT_CATALOG);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings/catalog', auth, adminOnly, async (req, res) => {
  try {
    const catalog = req.body;
    await dbRun(
      "INSERT INTO `settings` (`key`, value) VALUES ('device_catalog', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [JSON.stringify(catalog)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Purchase Orders ──────────────────────────────────────────────────────────
app.get('/api/purchase-orders', auth, async (req, res) => {
  try {
    const { search, vendor, month, year, page = 1, limit = 100 } = req.query;
    let q = `SELECT *,
             (SELECT COUNT(*) FROM po_items WHERE po_id = purchase_orders.id) item_count,
             (SELECT COALESCE(SUM(qty),0) FROM po_items WHERE po_id = purchase_orders.id) total_qty,
             (SELECT COUNT(*) FROM po_items WHERE po_id = purchase_orders.id AND receive_status = 'Received') received_count
             FROM purchase_orders WHERE 1=1`;
    const p = [];
    if (search) { q += ' AND (lot_id LIKE ? OR invoice_no LIKE ? OR vendor_name LIKE ? OR notes LIKE ?)'; const s=`%${search}%`; p.push(s,s,s,s); }
    if (vendor) { q += ' AND vendor_name LIKE ?'; p.push(`%${vendor}%`); }
    if (month) { q += ' AND purchase_month = ?'; p.push(month); }
    if (year) { q += ' AND purchase_year = ?'; p.push(parseInt(year)); }
    q += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    p.push(parseInt(limit), (parseInt(page)-1)*parseInt(limit));

    const [pos, totalRow] = await Promise.all([
      dbAll(q, p),
      dbGet('SELECT COUNT(*) c FROM purchase_orders'),
    ]);
    res.json({ pos, total: totalRow.c });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/purchase-orders', auth, async (req, res) => {
  try {
    const d = req.body;
    const result = await dbRun(
      `INSERT INTO purchase_orders (lot_id, invoice_no, vendor_name, purchase_month, purchase_year, device_types, notes)
        VALUES (?,?,?,?,?,?,?)`,
      [d.lot_id||'', d.invoice_no||'', d.vendor_name, d.purchase_month||'', d.purchase_year||null, d.device_types||'', d.notes||'']
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/purchase-orders/:id', auth, async (req, res) => {
  try {
    const d = req.body;
    await dbRun(
      `UPDATE purchase_orders SET lot_id=?,invoice_no=?,vendor_name=?,purchase_month=?,purchase_year=?,device_types=?,notes=?,modified_at=NOW() WHERE id=?`,
      [d.lot_id||'', d.invoice_no||'', d.vendor_name, d.purchase_month||'', d.purchase_year||null, d.device_types||'', d.notes||'', req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/purchase-orders/:id', auth, adminOnly, async (req, res) => {
  try {
    await dbRun('DELETE FROM purchase_orders WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// IMPORTANT: /next-lot-id MUST be defined before /:id routes
app.get('/api/purchase-orders/next-lot-id', auth, async (req, res) => {
  try {
    const { year, month } = req.query;
    if (!year || !month) return res.status(400).json({ error: 'year and month required' });
    const prefix = `Lot-${year}-${month}-`;
    const existing = await dbAll(`SELECT lot_id FROM purchase_orders WHERE lot_id LIKE ?`, [prefix + '%']);
    let maxNum = 0;
    existing.forEach(po => {
      const num = parseInt((po.lot_id || '').slice(prefix.length));
      if (!isNaN(num) && num > maxNum) maxNum = num;
    });
    const next = String(maxNum + 1).padStart(3, '0');
    res.json({ lot_id: `${prefix}${next}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/purchase-orders/:id/items', auth, async (req, res) => {
  try {
    const { search, brand, device_type } = req.query;
    let q = 'SELECT * FROM po_items WHERE po_id = ?';
    const p = [req.params.id];
    if (search) {
      q += ' AND (serial_number LIKE ? OR imei LIKE ? OR model LIKE ? OR sku LIKE ? OR description LIKE ? OR brand LIKE ?)';
      const s = `%${search}%`; p.push(s,s,s,s,s,s);
    }
    if (brand) { q += ' AND brand = ?'; p.push(brand); }
    if (device_type) { q += ' AND device_type = ?'; p.push(device_type); }
    q += ' ORDER BY id';
    res.json(await dbAll(q, p));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCHED: auto-fills full_configuration + sku (item #3/#4); receive_status
// can now also be set to 'Cancelled' by the frontend (item #2 — no schema
// change needed, it's a free-text VARCHAR column).
app.post('/api/po-items', auth, async (req, res) => {
  try {
    const d = { ...req.body };
    if (!d.full_configuration) d.full_configuration = buildFullConfiguration(d);
    if (!d.sku) d.sku = buildSkuFromConfig(d, null);

    const result = await dbRun(
      `INSERT INTO po_items (po_id,device_type,brand,model,full_configuration,sku,description,serial_number,imei,color,ram,storage,processor,wifi_cellular,qty,unit_price,notes,receive_status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.po_id,d.device_type||'',d.brand||'',d.model||'',d.full_configuration||'',d.sku||'',d.description||'',d.serial_number||'',d.imei||'',d.color||'',d.ram||'',d.storage||'',d.processor||'',d.wifi_cellular||'',d.qty||1,d.unit_price||0,d.notes||'',d.receive_status||'Pending']
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCHED: regenerates full_configuration + sku when specs change
app.put('/api/po-items/:id', auth, async (req, res) => {
  try {
    const d = { ...req.body };
    if (d.model || d.color || d.storage || d.ram) {
      d.full_configuration = buildFullConfiguration(d);
      d.sku = buildSkuFromConfig(d, null);
    }
    await dbRun(
      `UPDATE po_items SET device_type=?,brand=?,model=?,full_configuration=?,sku=?,description=?,serial_number=?,imei=?,color=?,ram=?,storage=?,processor=?,wifi_cellular=?,qty=?,unit_price=?,notes=?,receive_status=? WHERE id=?`,
      [d.device_type||'',d.brand||'',d.model||'',d.full_configuration||'',d.sku||'',d.description||'',d.serial_number||'',d.imei||'',d.color||'',d.ram||'',d.storage||'',d.processor||'',d.wifi_cellular||'',d.qty||1,d.unit_price||0,d.notes||'',d.receive_status||'Pending',req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/po-items/:id', auth, adminOnly, async (req, res) => {
  try {
    await dbRun('DELETE FROM po_items WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/po-items/bulk-delete', auth, adminOnly, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No IDs provided' });
    const placeholders = ids.map(() => '?').join(',');
    const result = await dbRun(`DELETE FROM po_items WHERE id IN (${placeholders})`, ids);
    res.json({ deleted: result.affectedRows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/po-items/:id/receive', auth, async (req, res) => {
  try {
    const item = await dbGet(
      'SELECT pi.*, po.lot_id, po.invoice_no, po.vendor_name, po.purchase_month, po.purchase_year FROM po_items pi JOIN purchase_orders po ON pi.po_id = po.id WHERE pi.id = ?',
      [req.params.id]
    );
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const { receive_status, units } = req.body;

    let inventoryIds = [];
    if (receive_status === 'Received') {
      if (item.inventory_id) {
        await dbRun('DELETE FROM inventory WHERE id = ? AND po_id = ?', [item.inventory_id, item.po_id]);
      }
      const qty = item.qty || 1;
      await dbTx(async (conn) => {
        for (let i = 0; i < qty; i++) {
          const u = units?.[i] || {};
          const sn = u.serial_number !== undefined ? u.serial_number : (qty === 1 ? item.serial_number||'' : '');
          const im = u.imei !== undefined ? u.imei : (qty === 1 ? item.imei||'' : '');
          const fullConfig = item.full_configuration || buildFullConfiguration(item);
          const itemSku = item.sku || buildSkuFromConfig(item, null);
          const [result] = await conn.query(
            `INSERT INTO inventory
              (vendor, month, year, device_type, model, full_configuration, color, ram, storage, wifi_cellular,
               serial_number, imei, sku, description, lot_id, invoice_no, po_id, price, po_price)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              item.vendor_name||'', item.purchase_month||'', item.purchase_year||null,
              item.device_type||'', item.model||'', fullConfig, item.color||'', item.ram||'', item.storage||'',
              item.wifi_cellular||'', sn, im, itemSku, item.description||'',
              item.lot_id||'', item.invoice_no||'', item.po_id,
              item.unit_price||0, item.unit_price||0
            ]
          );
          inventoryIds.push(result.insertId);
        }
      });
    }

    await dbRun('UPDATE po_items SET receive_status=?, inventory_id=? WHERE id=?', [
      receive_status, inventoryIds[0]||item.inventory_id||null, req.params.id
    ]);
    res.json({ success: true, inventory_ids: inventoryIds, count: inventoryIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/purchase-orders/:id/receive-all', auth, async (req, res) => {
  try {
    const po = await dbGet('SELECT * FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    const items = await dbAll(
      "SELECT pi.*, po.lot_id, po.invoice_no, po.vendor_name, po.purchase_month, po.purchase_year FROM po_items pi JOIN purchase_orders po ON pi.po_id = po.id WHERE pi.po_id = ? AND (pi.receive_status IS NULL OR pi.receive_status != 'Received')",
      [req.params.id]
    );

    let totalUnits = 0;
    await dbTx(async (conn) => {
      for (const item of items) {
        const qty = item.qty || 1;
        let firstId = null;
        const fullConfig = item.full_configuration || buildFullConfiguration(item);
        const itemSku = item.sku || buildSkuFromConfig(item, null);
        for (let i = 0; i < qty; i++) {
          const sn = (qty === 1 ? item.serial_number||'' : '');
          const im = (qty === 1 ? item.imei||'' : '');
          const [result] = await conn.query(
            `INSERT INTO inventory
              (vendor, month, year, device_type, model, full_configuration, color, ram, storage, wifi_cellular,
               serial_number, imei, sku, description, lot_id, invoice_no, po_id, price, po_price)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              item.vendor_name||'', item.purchase_month||'', item.purchase_year||null,
              item.device_type||'', item.model||'', fullConfig, item.color||'', item.ram||'', item.storage||'',
              item.wifi_cellular||'', sn, im, itemSku, item.description||'',
              item.lot_id||'', item.invoice_no||'', item.po_id,
              item.unit_price||0, item.unit_price||0
            ]
          );
          if (i === 0) firstId = result.insertId;
          totalUnits++;
        }
        await conn.query("UPDATE po_items SET receive_status='Received', inventory_id=? WHERE id=?", [firstId, item.id]);
      }
    });

    res.json({ success: true, items_received: items.length, units_created: totalUnits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/purchase-orders/:id/export', auth, async (req, res) => {
  try {
    const po = await dbGet('SELECT * FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    const items = await dbAll('SELECT * FROM po_items WHERE po_id = ? ORDER BY id', [req.params.id]);

    const wb = XLSX.utils.book_new();
    const hdr = [
      ['Lot ID','Invoice No','Vendor Name','Month','Year','Device Types','Notes','Created'],
      [po.lot_id,po.invoice_no,po.vendor_name,po.purchase_month,po.purchase_year,po.device_types,po.notes,po.created_at]
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(hdr), 'PO Header');
    const rows = [['Device Type','Brand','Model','Full Configuration','SKU','Description','Serial Number','IMEI','Color','RAM','Storage','Processor','WiFi/Cellular','Qty','Unit Price','Receive Status','Notes']];
    for (const it of items) {
      rows.push([it.device_type,it.brand,it.model,it.full_configuration,it.sku,it.description,it.serial_number,it.imei,it.color,it.ram,it.storage,it.processor,it.wifi_cellular,it.qty,it.unit_price,it.receive_status||'Pending',it.notes]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'PO Items');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fname = `PO_${(po.lot_id||po.id).replace(/[^a-z0-9_-]/gi,'_')}_${po.vendor_name.replace(/\s+/g,'_')}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/purchase-orders/:id/import-items', auth, upload.single('file'), async (req, res) => {
  try {
    const po = await dbGet('SELECT id FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'PO not found' });

    const wb = XLSX.read(req.file.buffer);
    const sn = wb.SheetNames.find(n => n.toLowerCase().includes('item')) || wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn]);

    let count = 0;
    await dbTx(async (conn) => {
      for (const row of rows) {
        const model = g(row,'Model','model');
        const color = g(row,'Color','color');
        const storage = g(row,'Storage','storage','Capacity');
        const ram = g(row,'RAM','ram','Memory');
        const fullConfig = buildFullConfiguration({ model, color, storage, ram });
        const sku = g(row,'SKU','sku') || buildSkuFromConfig({ model, color, storage, ram }, null);

        await conn.query(
          `INSERT INTO po_items (po_id,device_type,brand,model,full_configuration,sku,description,serial_number,imei,color,ram,storage,processor,wifi_cellular,qty,unit_price,notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            req.params.id,
            g(row,'Device Type','device_type','Type'),
            g(row,'Brand','brand','Manufacturer'),
            model, fullConfig, sku,
            g(row,'Description','description','Item Name'),
            g(row,'Serial Number','serial_number','S/N','Serial No','Serial No.','Serial','SERIAL','SN','S.No.','SERIAL_NUMBER','Serial_Number','SerialNumber','serial','Serial #','S/N No'),
            g(row,'IMEI','imei','IMEI No','IMEI No.','IMEI Number','imei_number'),
            color, ram, storage,
            g(row,'Processor','processor','CPU'),
            g(row,'WiFi/Cellular','wifi_cellular','Connectivity'),
            parseInt(g(row,'Qty','qty','Quantity'))||1,
            parseFloat(g(row,'Unit Price','unit_price','Price'))||0,
            g(row,'Notes','notes','Remarks')
          ]
        );
        count++;
      }
    });
    res.json({ success: true, imported: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Parts POs ────────────────────────────────────────────────────────────────

// PATCHED: cancelled items now count as "resolved" so a PO with cancelled
// line items can still close (item #2).
async function recalcPoStatus(poId) {
  const items = await dbAll('SELECT quantity_ordered, received_quantity, receive_status FROM parts_po_items WHERE po_id = ?', [poId]);
  const po = await dbGet('SELECT status FROM parts_pos WHERE id = ?', [poId]);
  if (!po || po.status === 'Cancelled') return;
  let newStatus = 'Open';
  if (items.length > 0) {
    const resolved = items.every(i =>
      i.receive_status === 'Cancelled' || (i.received_quantity || 0) >= (i.quantity_ordered || 1)
    );
    const anyReceived = items.some(i => (i.received_quantity || 0) > 0);
    if (resolved) newStatus = 'Closed';
    else if (anyReceived) newStatus = 'Partial';
    else newStatus = 'Open';
  }
  await dbRun('UPDATE parts_pos SET status = ?, updated_at = NOW() WHERE id = ?', [newStatus, poId]);
  return newStatus;
}

app.get('/api/parts-pos', auth, async (req, res) => {
  try {
    const { status, vendor, search } = req.query;
    let sql = `SELECT pp.*,
                      COUNT(ppi.id)                                              AS item_count,
                      COALESCE(SUM(ppi.quantity_ordered), 0)                     AS total_ordered,
                      COALESCE(SUM(ppi.received_quantity), 0)                    AS total_received,
                      COALESCE(SUM(ppi.quantity_ordered * ppi.unit_price), 0)    AS total_amount
               FROM parts_pos pp
               LEFT JOIN parts_po_items ppi ON ppi.po_id = pp.id
               WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND pp.status = ?'; params.push(status); }
    if (vendor) { sql += ' AND pp.vendor = ?'; params.push(vendor); }
    if (search) {
      sql += ' AND (pp.vendor LIKE ? OR pp.id LIKE ?)';
      const q = '%' + search + '%';
      params.push(q, q);
    }
    sql += ' GROUP BY pp.id ORDER BY pp.created_at DESC';
    const pos = await dbAll(sql, params);
    const stats = await dbAll('SELECT status, COUNT(*) as cnt FROM parts_pos GROUP BY status');
    const statsMap = {};
    stats.forEach(s => { statsMap[s.status] = s.cnt; });
    res.json({ pos, stats: statsMap, total: pos.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/parts-pos', auth, async (req, res) => {
  try {
    const b = req.body;
    const poId = await dbTx(async (conn) => {
      const [r] = await conn.query(
        `INSERT INTO parts_pos (vendor, order_date, expected_delivery, warehouse_destination, notes, requisition_id, created_by)
         VALUES (?,?,?,?,?,?,?)`,
        [b.vendor, b.order_date, b.expected_delivery || null, b.warehouse_destination || 'Milpitas 741', b.notes || null, b.requisition_id || null, req.user.username]
      );
      const newId = r.insertId;
      if (b.items && b.items.length > 0) {
        for (const it of b.items) {
          await conn.query(
            `INSERT INTO parts_po_items (po_id, part_sku, part_type, part_category, model_compatibility, quantity_ordered, received_quantity, unit_price, notes)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [newId, it.part_sku, it.part_type || null, it.part_category || null, it.model_compatibility || null, it.quantity_ordered || 1, it.received_quantity || 0, it.unit_price || 0, it.notes || null]
          );
        }
      }
      return newId;
    });
    await recalcPoStatus(poId);
    res.json({ id: poId, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/parts-pos/:id', auth, async (req, res) => {
  try {
    const po = await dbGet('SELECT * FROM parts_pos WHERE id = ?', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    const items = await dbAll('SELECT * FROM parts_po_items WHERE po_id = ?', [req.params.id]);
    res.json({ ...po, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/parts-pos/:id', auth, async (req, res) => {
  try {
    const b = req.body;
    await dbRun(
      `UPDATE parts_pos SET vendor=?, order_date=?, expected_delivery=?, warehouse_destination=?, notes=?, updated_at=NOW()
       WHERE id=?`,
      [b.vendor, b.order_date, b.expected_delivery || null, b.warehouse_destination || 'Milpitas 741', b.notes || null, req.params.id]
    );
    if (b.status === 'Cancelled') {
      await dbRun('UPDATE parts_pos SET status=? WHERE id=?', ['Cancelled', req.params.id]);
    } else {
      await recalcPoStatus(req.params.id);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/parts-pos/:id/items', auth, async (req, res) => {
  try {
    const b = req.body;
    const r = await dbRun(
      `INSERT INTO parts_po_items (po_id, part_sku, part_type, part_category, model_compatibility, quantity_ordered, received_quantity, unit_price, notes)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [req.params.id, b.part_sku, b.part_type || null, b.part_category || null, b.model_compatibility || null, b.quantity_ordered || 1, b.received_quantity || 0, b.unit_price || 0, b.notes || null]
    );
    await recalcPoStatus(req.params.id);
    res.json({ id: r.insertId, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/parts-pos/:id/items/:itemId', auth, async (req, res) => {
  try {
    const b = req.body;
    await dbRun(
      `UPDATE parts_po_items SET part_sku=?, part_type=?, part_category=?, model_compatibility=?, quantity_ordered=?, received_quantity=?, unit_price=?, notes=?
       WHERE id=? AND po_id=?`,
      [b.part_sku, b.part_type || null, b.part_category || null, b.model_compatibility || null, b.quantity_ordered || 1, b.received_quantity || 0, b.unit_price || 0, b.notes || null, req.params.itemId, req.params.id]
    );
    await recalcPoStatus(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/parts-pos/:id/items/:itemId', auth, async (req, res) => {
  try {
    await dbRun('DELETE FROM parts_po_items WHERE id=? AND po_id=?', [req.params.itemId, req.params.id]);
    await recalcPoStatus(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/parts-pos/:id', auth, adminOnly, async (req, res) => {
  try {
    await dbRun('DELETE FROM parts_pos WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/parts-pos/:id/receive', auth, async (req, res) => {
  try {
    const poId = req.params.id;
    const { items } = req.body; // [{ id, received_quantity }]
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No items provided' });

    await dbTx(async (conn) => {
      for (const it of items) {
        await conn.query(
          `UPDATE parts_po_items SET received_quantity = ? WHERE id = ? AND po_id = ?`,
          [parseInt(it.received_quantity) || 0, it.id, poId]
        );
      }
    });

    const newStatus = await recalcPoStatus(poId);
    res.json({ success: true, status: newStatus });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/parts-pos/from-requisition/:reqId', auth, async (req, res) => {
  try {
    const req2 = await dbGet('SELECT * FROM part_requisitions WHERE id = ?', [req.params.reqId]);
    if (!req2) return res.status(404).json({ error: 'Requisition not found' });
    const vendor = req.body.vendor || 'Unknown';
    const expectedDelivery = req.body.expected_delivery || null;
    const today = new Date().toISOString().slice(0, 10);
    const poId = await dbTx(async (conn) => {
      const [r] = await conn.query(
        `INSERT INTO parts_pos (vendor, order_date, expected_delivery, warehouse_destination, notes, requisition_id, created_by)
         VALUES (?,?,?,?,?,?,?)`,
        [vendor, today, expectedDelivery, req2.warehouse_location || 'Milpitas 741', `From Requisition #${req2.id}`, req2.id, req.user.username]
      );
      const newId = r.insertId;
      await conn.query(
        `INSERT INTO parts_po_items (po_id, part_sku, part_type, part_category, model_compatibility, quantity_ordered, received_quantity, unit_price)
         VALUES (?,?,?,?,?,?,0,0)`,
        [newId, req2.part_sku || 'UNKNOWN', req2.part_type || null, req2.part_category || null, req2.model_compatibility || null, req2.quantity_needed || 1]
      );
      await conn.query(`UPDATE part_requisitions SET status='Converted to PO', po_id=?, updated_at=NOW() WHERE id=?`, [newId, req2.id]);
      return newId;
    });
    res.json({ id: poId, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ─── Service Orders ────────────────────────────────────────────────────────────

app.get('/api/service-orders', auth, async (req, res) => {
  try {
    const { status, technician, repair_type, search } = req.query;
    let sql = `SELECT so.*, COUNT(sop.id) as parts_count
               FROM service_orders so
               LEFT JOIN service_order_parts sop ON sop.service_order_id = so.id
               WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND so.status = ?'; params.push(status); }
    if (technician) { sql += ' AND so.assigned_technician = ?'; params.push(technician); }
    if (repair_type) { sql += ' AND so.repair_type = ?'; params.push(repair_type); }
    if (search) {
      sql += ' AND (so.imei_serial LIKE ? OR so.customer_name LIKE ? OR so.id LIKE ?)';
      const q = '%' + search + '%';
      params.push(q, q, q);
    }
    sql += ' GROUP BY so.id ORDER BY so.created_at DESC';
    const orders = await dbAll(sql, params);
    const stats = await dbAll('SELECT status, COUNT(*) as cnt FROM service_orders GROUP BY status');
    const statsMap = {};
    stats.forEach(s => { statsMap[s.status] = s.cnt; });
    res.json({ orders, stats: statsMap, total: orders.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/service-orders', auth, async (req, res) => {
  try {
    const b = req.body;
    const soId = await dbTx(async (conn) => {
      const [r] = await conn.query(
        `INSERT INTO service_orders (date_created, customer_name, imei_serial, issue_description, repair_type, assigned_technician, status, warehouse_source, notes, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [b.date_created, b.customer_name || 'Tekhouz', b.imei_serial || null, b.issue_description || null, b.repair_type || null, b.assigned_technician || null, b.status || 'Open', b.warehouse_source || 'Milpitas 741', b.notes || null, req.user.username]
      );
      const newId = r.insertId;
      if (b.parts && b.parts.length > 0) {
        for (const p of b.parts) {
          await conn.query(
            `INSERT INTO service_order_parts (service_order_id, part_sku, part_type, model_compatibility, quantity, notes)
             VALUES (?,?,?,?,?,?)`,
            [newId, p.part_sku, p.part_type || null, p.model_compatibility || null, p.quantity || 1, p.notes || null]
          );
        }
      }
      return newId;
    });
    res.json({ id: soId, success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/service-orders/:id', auth, async (req, res) => {
  try {
    const so = await dbGet('SELECT * FROM service_orders WHERE id = ?', [req.params.id]);
    if (!so) return res.status(404).json({ error: 'Not found' });
    const parts = await dbAll('SELECT * FROM service_order_parts WHERE service_order_id = ?', [req.params.id]);
    res.json({ ...so, parts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/service-orders/:id', auth, async (req, res) => {
  try {
    const b = req.body;
    await dbTx(async (conn) => {
      await conn.query(
        `UPDATE service_orders SET date_created=?, customer_name=?, imei_serial=?, issue_description=?, repair_type=?, assigned_technician=?, status=?, warehouse_source=?, notes=?, updated_at=NOW()
         WHERE id=?`,
        [b.date_created, b.customer_name || 'Tekhouz', b.imei_serial || null, b.issue_description || null, b.repair_type || null, b.assigned_technician || null, b.status || 'Open', b.warehouse_source || 'Milpitas 741', b.notes || null, req.params.id]
      );
      await conn.query('DELETE FROM service_order_parts WHERE service_order_id = ?', [req.params.id]);
      if (b.parts && b.parts.length > 0) {
        for (const p of b.parts) {
          await conn.query(
            `INSERT INTO service_order_parts (service_order_id, part_sku, part_type, model_compatibility, quantity, notes)
             VALUES (?,?,?,?,?,?)`,
            [req.params.id, p.part_sku, p.part_type || null, p.model_compatibility || null, p.quantity || 1, p.notes || null]
          );
        }
      }
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/service-orders/:id', auth, adminOnly, async (req, res) => {
  try {
    await dbRun('DELETE FROM service_orders WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Parts Inventory ───────────────────────────────────────────────────────────

app.get('/api/parts-inventory', auth, async (req, res) => {
  try {
    const { category, part_type, model, search } = req.query;
    const skuRows = await dbAll(`
      SELECT part_sku,
             MAX(part_type) as part_type,
             MAX(part_category) as part_category,
             MAX(model_compatibility) as model_compatibility
      FROM parts_po_items GROUP BY part_sku
      UNION
      SELECT part_sku,
             MAX(part_type) as part_type,
             NULL as part_category,
             MAX(model_compatibility) as model_compatibility
      FROM service_order_parts GROUP BY part_sku
    `);
    const skuMap = {};
    for (const r of skuRows) {
      if (!skuMap[r.part_sku]) skuMap[r.part_sku] = r;
      else {
        if (!skuMap[r.part_sku].part_type && r.part_type) skuMap[r.part_sku].part_type = r.part_type;
        if (!skuMap[r.part_sku].part_category && r.part_category) skuMap[r.part_sku].part_category = r.part_category;
        if (!skuMap[r.part_sku].model_compatibility && r.model_compatibility) skuMap[r.part_sku].model_compatibility = r.model_compatibility;
      }
    }
    const stockIn = await dbAll(`
      SELECT ppi.part_sku, SUM(ppi.received_quantity) as received_quantity
      FROM parts_po_items ppi
      JOIN parts_pos pp ON pp.id = ppi.po_id AND pp.status != 'Cancelled'
      GROUP BY ppi.part_sku`);
    const inMap = {};
    stockIn.forEach(r => { inMap[r.part_sku] = r.received_quantity || 0; });
    const stockOut = await dbAll(`SELECT part_sku, SUM(quantity) as qty FROM service_order_parts GROUP BY part_sku`);
    const outMap = {};
    stockOut.forEach(r => { outMap[r.part_sku] = r.qty || 0; });
    const openPO = await dbAll(`
      SELECT i.part_sku, SUM(i.quantity_ordered - i.received_quantity) as qty
      FROM parts_po_items i JOIN parts_pos pos ON pos.id = i.po_id
      WHERE pos.status IN ('Open','Partial') GROUP BY i.part_sku`);
    const openPOMap = {};
    openPO.forEach(r => { openPOMap[r.part_sku] = r.qty || 0; });
    const openReq = await dbAll(`SELECT part_sku, SUM(quantity_needed) as qty FROM part_requisitions WHERE status IN ('Requested','Approved') GROUP BY part_sku`);
    const openReqMap = {};
    openReq.forEach(r => { openReqMap[r.part_sku] = r.qty || 0; });

    let parts = Object.values(skuMap).map(p => ({
      part_sku: p.part_sku,
      part_type: p.part_type,
      part_category: p.part_category,
      model_compatibility: p.model_compatibility,
      total_stock_in: inMap[p.part_sku] || 0,
      total_stock_out: outMap[p.part_sku] || 0,
      current_stock: (inMap[p.part_sku] || 0) - (outMap[p.part_sku] || 0),
      open_po_qty: openPOMap[p.part_sku] || 0,
      open_req_qty: openReqMap[p.part_sku] || 0,
    }));

    if (category)   parts = parts.filter(p => p.part_category === category);
    if (part_type)  parts = parts.filter(p => p.part_type === part_type);
    if (model)      parts = parts.filter(p => (p.model_compatibility || '').toLowerCase().includes(model.toLowerCase()));
    if (search) {
      const q = search.toLowerCase();
      parts = parts.filter(p => (p.part_sku || '').toLowerCase().includes(q) || (p.model_compatibility || '').toLowerCase().includes(q));
    }
    parts.sort((a, b) => a.part_sku.localeCompare(b.part_sku));

    const total = parts.length;
    const total_stock = parts.reduce((s, p) => s + (p.current_stock || 0), 0);
    const low_stock_count = parts.filter(p => p.current_stock > 0 && p.current_stock <= 2).length;
    const out_of_stock_count = parts.filter(p => p.current_stock <= 0).length;
    res.json({ parts, total, stats: { total_stock, low_stock_count, out_of_stock_count } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Returns ──────────────────────────────────────────────────────────────────

app.get('/api/returns', auth, async (req, res) => {
  try {
    const { status, return_from, search, from, to } = req.query;
    let sql = 'SELECT * FROM returns WHERE 1=1';
    const params = [];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (return_from) { sql += ' AND return_from = ?'; params.push(return_from); }
    if (from) { sql += ' AND (return_date >= ? OR created_at >= ?)'; params.push(from, from); }
    if (to) { sql += ' AND (return_date <= ? OR DATE(created_at) <= ?)'; params.push(to, to); }
    if (search) {
      sql += ' AND (order_id LIKE ? OR customer_name LIKE ? OR device_config_sent LIKE ? OR tracking_number LIKE ?)';
      const q = '%' + search + '%';
      params.push(q, q, q, q);
    }
    sql += ' ORDER BY created_at DESC';
    const rows = await dbAll(sql, params);

    const stats = await dbAll(`
      SELECT status, COUNT(*) as cnt FROM returns GROUP BY status
    `);
    const statusMap = {};
    stats.forEach(s => { statusMap[s.status] = s.cnt; });

    res.json({ returns: rows, stats: statusMap, total: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/returns/:id', auth, async (req, res) => {
  try {
    const row = await dbGet('SELECT * FROM returns WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/returns', auth, async (req, res) => {
  try {
    const b = req.body;
    const result = await dbRun(
      `INSERT INTO returns (return_from, order_id, sku, customer_name, return_date, device_config_sent,
        return_reason, customer_complaint, tracking_number, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        b.return_from || null,
        b.order_id || null,
        b.sku || null,
        b.customer_name || null,
        b.return_date || null,
        b.device_config_sent || null,
        b.return_reason || null,
        b.customer_complaint || null,
        b.tracking_number || null,
        b.status || 'awaiting_shipment',
        req.user.username
      ]
    );
    const row = await dbGet('SELECT * FROM returns WHERE id = ?', [result.insertId]);
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/returns/:id', auth, async (req, res) => {
  try {
    const b = req.body;
    const existing = await dbGet('SELECT id FROM returns WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    await dbRun(
      `UPDATE returns SET
        return_from=?, order_id=?, sku=?, customer_name=?, return_date=?, device_config_sent=?,
        return_reason=?, customer_complaint=?, tracking_number=?, status=?,
        received_date=?, device_config_received=?, condition_received=?, charger_included=?,
        lcd_test=?, touch_test=?, battery_health=?, face_id_test=?, fingerprint_test=?,
        front_camera_test=?, rear_camera_test=?, speaker_test=?, mic_test=?,
        wifi_test=?, cellular_test=?, charging_test=?,
        grade=?, tech_notes=?, tested_by=?, test_date=?,
        next_action=?, ops_status=?, warehouse_status=?, resell_action=?,
        final_action=?, ops_notes=?, ops_reviewed_by=?, ops_review_date=?
       WHERE id=?`,
      [
        b.return_from || null, b.order_id || null, b.sku || null, b.customer_name || null,
        b.return_date || null, b.device_config_sent || null,
        b.return_reason || null, b.customer_complaint || null,
        b.tracking_number || null, b.status || null,
        b.received_date || null, b.device_config_received || null,
        b.condition_received || null, b.charger_included || null,
        b.lcd_test || 'Not Tested', b.touch_test || 'Not Tested',
        b.battery_health ? parseInt(b.battery_health) : null,
        b.face_id_test || 'Not Tested', b.fingerprint_test || 'Not Tested',
        b.front_camera_test || 'Not Tested', b.rear_camera_test || 'Not Tested',
        b.speaker_test || 'Not Tested', b.mic_test || 'Not Tested',
        b.wifi_test || 'Not Tested', b.cellular_test || 'Not Tested',
        b.charging_test || 'Not Tested',
        b.grade || null, b.tech_notes || null, b.tested_by || null, b.test_date || null,
        b.next_action || null, b.ops_status || null, b.warehouse_status || null,
        b.resell_action || null, b.final_action || null,
        b.ops_notes || null, b.ops_reviewed_by || null, b.ops_review_date || null,
        req.params.id
      ]
    );
    const row = await dbGet('SELECT * FROM returns WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/returns/:id', auth, adminOnly, async (req, res) => {
  try {
    const result = await dbRun('DELETE FROM returns WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Part Requisitions ────────────────────────────────────────────────────────

app.get('/api/requisitions', auth, async (req, res) => {
  try {
    const { status, priority, part_category, search } = req.query;
    let sql = 'SELECT * FROM part_requisitions WHERE 1=1';
    const params = [];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (priority) { sql += ' AND priority = ?'; params.push(priority); }
    if (part_category) { sql += ' AND part_category = ?'; params.push(part_category); }
    if (search) {
      sql += ' AND (part_sku LIKE ? OR model_compatibility LIKE ? OR requested_by LIKE ? OR part_category LIKE ?)';
      const q = '%' + search + '%';
      params.push(q, q, q, q);
    }
    sql += ' ORDER BY FIELD(priority,"Urgent","Normal","Low"), created_at DESC';
    const rows = await dbAll(sql, params);
    const stats = await dbAll('SELECT status, COUNT(*) as cnt FROM part_requisitions GROUP BY status');
    const statusMap = {};
    stats.forEach(s => { statusMap[s.status] = s.cnt; });
    res.json({ requisitions: rows, stats: statusMap, total: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/requisitions/:id', auth, async (req, res) => {
  try {
    const row = await dbGet('SELECT * FROM part_requisitions WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/requisitions', auth, async (req, res) => {
  try {
    const b = req.body;
    const result = await dbRun(
      `INSERT INTO part_requisitions (request_date, requested_by, part_type, part_category, model_compatibility, part_sku, color, quality, quantity_needed, actual_ordered, priority, status, warehouse_location, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [b.request_date||null, b.requested_by||null, b.part_type||null, b.part_category||null, b.model_compatibility||null, b.part_sku||null, b.color||'NA', b.quality||'OEM', parseInt(b.quantity_needed)||1, b.actual_ordered?parseInt(b.actual_ordered):null, b.priority||'Normal', b.status||'Requested', b.warehouse_location||null, b.notes||null, req.user.username]
    );
    const row = await dbGet('SELECT * FROM part_requisitions WHERE id = ?', [result.insertId]);
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/requisitions/:id', auth, async (req, res) => {
  try {
    const b = req.body;
    const existing = await dbGet('SELECT id FROM part_requisitions WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await dbRun(
      `UPDATE part_requisitions SET request_date=?, requested_by=?, part_type=?, part_category=?, model_compatibility=?, part_sku=?, color=?, quality=?, quantity_needed=?, actual_ordered=?, priority=?, status=?, warehouse_location=?, notes=? WHERE id=?`,
      [b.request_date||null, b.requested_by||null, b.part_type||null, b.part_category||null, b.model_compatibility||null, b.part_sku||null, b.color||'NA', b.quality||'OEM', parseInt(b.quantity_needed)||1, b.actual_ordered?parseInt(b.actual_ordered):null, b.priority||'Normal', b.status||'Requested', b.warehouse_location||null, b.notes||null, req.params.id]
    );
    const row = await dbGet('SELECT * FROM part_requisitions WHERE id = ?', [req.params.id]);
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/requisitions/:id', auth, adminOnly, async (req, res) => {
  try {
    const result = await dbRun('DELETE FROM part_requisitions WHERE id = ?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Return Media ─────────────────────────────────────────────────────────────

app.get('/api/returns/:id/media', auth, async (req, res) => {
  try {
    const rows = await dbAll(
      'SELECT * FROM return_media WHERE return_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/returns/:id/media', auth, (req, res, next) => {
  mediaUpload.array('files', 20)(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    const returnId = parseInt(req.params.id);
    const existing = await dbGet('SELECT id FROM returns WHERE id = ?', [returnId]);
    if (!existing) return res.status(404).json({ error: 'Return not found' });

    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const inserted = [];
    for (const f of req.files) {
      const result = await dbRun(
        `INSERT INTO return_media (return_id, filename, original_name, mimetype, size, uploaded_by, caption)
         VALUES (?,?,?,?,?,?,?)`,
        [returnId, f.filename, f.originalname, f.mimetype, f.size, req.user.username, req.body.caption || null]
      );
      inserted.push({
        id: result.insertId,
        return_id: returnId,
        filename: f.filename,
        original_name: f.originalname,
        mimetype: f.mimetype,
        size: f.size,
        uploaded_by: req.user.username,
        url: `/uploads/returns/${f.filename}`
      });
    }
    res.json({ uploaded: inserted.length, files: inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/returns/media/:mediaId/caption', auth, async (req, res) => {
  try {
    await dbRun('UPDATE return_media SET caption = ? WHERE id = ?', [req.body.caption || null, req.params.mediaId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/returns/media/:mediaId', auth, async (req, res) => {
  try {
    const row = await dbGet('SELECT * FROM return_media WHERE id = ?', [req.params.mediaId]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.uploaded_by !== req.user.username && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const filePath = path.join(MEDIA_DIR, row.filename);
    try { fs.unlinkSync(filePath); } catch {}
    await dbRun('DELETE FROM return_media WHERE id = ?', [req.params.mediaId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── PUBLIC SHOP INVENTORY (NEW — for shop.tekhouz.com) ────────────────────────
// No auth. CORS-restricted (see middleware near top of file). Strips
// vendor/cost/serial/IMEI data — only model/color/storage/RAM/grade/qty/price.
app.get('/api/shop/inventory', async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT
        i.device_type   AS category_raw,
        i.model,
        i.color,
        i.storage,
        i.ram,
        COALESCE(t.overall_grade, i.grade, 'B') AS grade,
        i.price,
        COUNT(*) AS qty
      FROM inventory i
      LEFT JOIN inventory_testing t ON i.id = t.inventory_id
      WHERE i.status = 'available'
        AND i.price > 0
      GROUP BY i.device_type, i.model, i.color, i.storage, i.ram,
               COALESCE(t.overall_grade, i.grade, 'B'), i.price
      ORDER BY i.device_type, i.model, i.price
    `);

    function mapCategory(deviceType) {
      const d = (deviceType || '').toLowerCase();
      if (d.includes('iphone')) return 'iphone';
      if (d.includes('macbook') || d === 'laptop') return 'macbook';
      if (d.includes('samsung') || d.includes('android')) return 'android';
      if (d.includes('surface')) return 'surface';
      if (d.includes('ipad') || d.includes('tablet')) return 'ipad';
      return 'other';
    }

    const products = rows.map(r => ({
      category: mapCategory(r.category_raw),
      model: r.model || '',
      color: r.color || '',
      storage: r.storage || '',
      ram: r.ram || '',
      grade: (r.grade || 'B').toString().charAt(0).toUpperCase(),
      qty: Number(r.qty),
      price: Math.round(Number(r.price))
    }));

    res.setHeader('Cache-Control', 'public, max-age=30');
    res.json({
      updated_at: new Date().toISOString(),
      count: products.length,
      total_units: products.reduce((s, p) => s + p.qty, 0),
      products
    });
  } catch (err) {
    console.error('shop/inventory error:', err.message);
    res.status(500).json({ error: 'Failed to load inventory' });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Tekhouz Warehouse Management running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
