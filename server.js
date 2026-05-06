require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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

  // Backfill device_type for daily_orders rows where device_type IS NULL OR device_type = 'Other'
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

  // Seed default admin
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
    await dbTx(async (conn) => {
      for (const row of rows) {
        const od = parseXlDate(row['Order Date']);
        await conn.query(
          `INSERT INTO daily_orders
            (import_date, source, serial_no, order_id, order_date, item_sku, item_name, recipient, qty, price, device_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            importDate,
            g(row,'Source','source'),
            g(row,'Serial No.','Serial No','SERIAL_NO','serial_no'),
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
        count++;
      }
    });
    res.json({ success: true, imported: count });
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
    await dbTx(async (conn) => {
      for (const o of orders) {
        const oDate = o.orderDate ? o.orderDate.split('T')[0] : importDate;
        const store = o.advancedOptions?.storeName || 'ShipStation';
        const shippingPaid = o.shippingAmount || 0;
        for (const item of o.items || []) {
          await conn.query(
            `INSERT INTO daily_orders
              (import_date, source, serial_no, order_id, order_date, item_sku, item_name, recipient, qty, price, shipping_paid, device_type)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              importDate, store, '', String(o.orderNumber || o.orderId),
              oDate, item.sku || '', item.name || '',
              o.shipTo?.name || '', item.quantity || 1, item.unitPrice || 0, shippingPaid,
              inferDeviceType(item.name, item.sku)
            ]
          );
          count++;
        }
      }
    });
    res.json({ success: true, imported: count, ordersFound: orders.length });
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

    const hdr = ['Vendor','Month','Year','Lot ID','Invoice No','Device Type','Model','Description',
      'Serial Number','IMEI','Color','Storage','RAM','WiFi/Cellular','Screen Size',
      'Grade','Condition','Lock Status','Carrier','Missing Components','Damages',
      'SKU','PO Number','Price','PO Price','Facility','Remarks',
      'Overall Grade','Final Grade (Tested)','Test Date','Testing Owner','MDM Lock','D Grade Description',
      'LCD','Touch','Face ID/FP','Fingerprint','Front Camera','Rear Camera',
      'Speaker','Mic','WiFi','Cellular','Bluetooth','Charging','Vibration',
      'Keyboard','Trackpad','USB Ports','Hinge','Battery Health %','Battery Cycles','Test Notes'];

    const data = [hdr, ...rows.map(it => [
      it.vendor, it.month, it.year, it.lot_id||'', it.invoice_no||'', it.device_type, it.model||'', it.description||'',
      it.serial_number||'', it.imei||'', it.color||'', it.storage||'', it.ram||'', it.wifi_cellular||'', it.screen_size||'',
      it.grade||'', it.condition_grade||'', it.lock_status||'', it.carrier||'', it.missing_components||'', it.damages||'',
      it.sku||'', it.po_number||'', it.price||0, it.po_price||0, it.facility||'', it.remarks||'',
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

app.post('/api/inventory', auth, async (req, res) => {
  try {
    const d = req.body;
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

app.put('/api/inventory/:id', auth, async (req, res) => {
  try {
    const d = req.body;
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

          await conn.query(
            `INSERT INTO inventory
              (month, year, vendor, device_type, po_number, vendor_item_id, manufacturer, part_number,
               description, serial_number, imei, condition_grade, missing_components, damages,
               color, storage, ram, screen_size, grade, sku, facility, carrier, lock_status, price, po_price, remarks)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              month, parseInt(year), vendor, device_type,
              g(row,'PO','po','PO Number','PO#'),
              g(row,'Apto_id','id','S. No.','S.No.','Item_ID'),
              g(row,'MANUFACTURER','Manufacturer','Brand'),
              g(row,'PART_NUMBER','Part Number','PartNumber','Model Number'),
              g(row,'Description','DESCRIPTION','description','Item','FullModel','Model'),
              sn, imei,
              g(row,'CONDITION','Condition','Condition_Grade'),
              g(row,'Missing Components','MISSING COMPONENTS','Missing_Components'),
              g(row,'Damages','DAMAGES','Damage','Defects','Notes'),
              g(row,'Color','COLOR','color','Color.1'),
              g(row,'Storage','STORAGE','storage','Hard_Drive_1','Storage_Capacity'),
              g(row,'RAM','Ram','ram'),
              g(row,'Screen Size','SCREEN SIZE','Screen_Size'),
              g(row,'Grade','GRADE','grade','Grade.1','Condition'),
              g(row,"Sku's",'SKU','sku','Sku','SKUs'),
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

app.post('/api/po-items', auth, async (req, res) => {
  try {
    const d = req.body;
    const result = await dbRun(
      `INSERT INTO po_items (po_id,device_type,brand,model,sku,description,serial_number,imei,color,ram,storage,processor,wifi_cellular,qty,unit_price,notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.po_id,d.device_type||'',d.brand||'',d.model||'',d.sku||'',d.description||'',d.serial_number||'',d.imei||'',d.color||'',d.ram||'',d.storage||'',d.processor||'',d.wifi_cellular||'',d.qty||1,d.unit_price||0,d.notes||'']
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/po-items/:id', auth, async (req, res) => {
  try {
    const d = req.body;
    await dbRun(
      `UPDATE po_items SET device_type=?,brand=?,model=?,sku=?,description=?,serial_number=?,imei=?,color=?,ram=?,storage=?,processor=?,wifi_cellular=?,qty=?,unit_price=?,notes=? WHERE id=?`,
      [d.device_type||'',d.brand||'',d.model||'',d.sku||'',d.description||'',d.serial_number||'',d.imei||'',d.color||'',d.ram||'',d.storage||'',d.processor||'',d.wifi_cellular||'',d.qty||1,d.unit_price||0,d.notes||'',req.params.id]
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
          const [result] = await conn.query(
            `INSERT INTO inventory
              (vendor, month, year, device_type, model, color, ram, storage, wifi_cellular,
               serial_number, imei, sku, description, lot_id, invoice_no, po_id, price, po_price)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              item.vendor_name||'', item.purchase_month||'', item.purchase_year||null,
              item.device_type||'', item.model||'', item.color||'', item.ram||'', item.storage||'',
              item.wifi_cellular||'', sn, im, item.sku||'', item.description||'',
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
        for (let i = 0; i < qty; i++) {
          const sn = (qty === 1 ? item.serial_number||'' : '');
          const im = (qty === 1 ? item.imei||'' : '');
          const [result] = await conn.query(
            `INSERT INTO inventory
              (vendor, month, year, device_type, model, color, ram, storage, wifi_cellular,
               serial_number, imei, sku, description, lot_id, invoice_no, po_id, price, po_price)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              item.vendor_name||'', item.purchase_month||'', item.purchase_year||null,
              item.device_type||'', item.model||'', item.color||'', item.ram||'', item.storage||'',
              item.wifi_cellular||'', sn, im, item.sku||'', item.description||'',
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
    const rows = [['Device Type','Brand','Model','SKU','Description','Serial Number','IMEI','Color','RAM','Storage','Processor','WiFi/Cellular','Qty','Unit Price','Receive Status','Notes']];
    for (const it of items) {
      rows.push([it.device_type,it.brand,it.model,it.sku,it.description,it.serial_number,it.imei,it.color,it.ram,it.storage,it.processor,it.wifi_cellular,it.qty,it.unit_price,it.receive_status||'Pending',it.notes]);
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
        await conn.query(
          `INSERT INTO po_items (po_id,device_type,brand,model,sku,description,serial_number,imei,color,ram,storage,processor,wifi_cellular,qty,unit_price,notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            req.params.id,
            g(row,'Device Type','device_type','Type'),
            g(row,'Brand','brand','Manufacturer'),
            g(row,'Model','model'),
            g(row,'SKU','sku'),
            g(row,'Description','description','Item Name'),
            g(row,'Serial Number','serial_number','S/N','Serial No','Serial No.','Serial','SERIAL','SN','S.No.','SERIAL_NUMBER','Serial_Number','SerialNumber','serial','Serial #','S/N No'),
            g(row,'IMEI','imei','IMEI No','IMEI No.','IMEI Number','imei_number'),
            g(row,'Color','color'),
            g(row,'RAM','ram','Memory'),
            g(row,'Storage','storage','Capacity'),
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
