require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const app = express();
const db = new Database('refurb.db');
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const morgan = require('morgan');

app.use(helmet({ contentSecurityPolicy: false })); // CSP off - inline scripts in SPA
app.use(compression());
if (process.env.NODE_ENV !== 'test') app.use(morgan('combined'));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500, message: { error: 'Too many requests' } }));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Schema ────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS daily_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_date TEXT,
    source TEXT,
    serial_no TEXT,
    order_id TEXT,
    order_date TEXT,
    item_sku TEXT,
    item_name TEXT,
    recipient TEXT,
    qty INTEGER DEFAULT 1,
    price REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS order_testing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_row_id INTEGER REFERENCES daily_orders(id) ON DELETE CASCADE,
    device_type TEXT DEFAULT 'iPhone',
    lcd_test TEXT DEFAULT 'Not Tested',
    touch_test TEXT DEFAULT 'Not Tested',
    battery_health INTEGER,
    battery_cycles INTEGER,
    face_id_test TEXT DEFAULT 'Not Tested',
    fingerprint_test TEXT DEFAULT 'Not Tested',
    front_camera_test TEXT DEFAULT 'Not Tested',
    rear_camera_test TEXT DEFAULT 'Not Tested',
    speaker_test TEXT DEFAULT 'Not Tested',
    mic_test TEXT DEFAULT 'Not Tested',
    wifi_test TEXT DEFAULT 'Not Tested',
    cellular_test TEXT DEFAULT 'Not Tested',
    bluetooth_test TEXT DEFAULT 'Not Tested',
    charging_test TEXT DEFAULT 'Not Tested',
    vibration_test TEXT DEFAULT 'Not Tested',
    keyboard_test TEXT DEFAULT 'Not Tested',
    trackpad_test TEXT DEFAULT 'Not Tested',
    usb_ports_test TEXT DEFAULT 'Not Tested',
    hinge_test TEXT DEFAULT 'Not Tested',
    cosmetic_grade TEXT,
    overall_status TEXT DEFAULT 'Not Tested',
    delivery_status TEXT DEFAULT 'Pending',
    notes TEXT,
    tested_by TEXT,
    test_date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,
    year INTEGER NOT NULL,
    vendor TEXT NOT NULL,
    device_type TEXT NOT NULL,
    po_number TEXT,
    vendor_item_id TEXT,
    manufacturer TEXT,
    part_number TEXT,
    description TEXT,
    serial_number TEXT,
    imei TEXT,
    condition_grade TEXT,
    missing_components TEXT,
    damages TEXT,
    color TEXT,
    storage TEXT,
    ram TEXT,
    screen_size TEXT,
    grade TEXT,
    sku TEXT,
    facility TEXT,
    carrier TEXT,
    lock_status TEXT,
    price REAL DEFAULT 0,
    po_price REAL DEFAULT 0,
    remarks TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS inventory_testing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inventory_id INTEGER REFERENCES inventory(id) ON DELETE CASCADE,
    device_type TEXT,
    lcd_test TEXT DEFAULT 'Not Tested',
    touch_test TEXT DEFAULT 'Not Tested',
    battery_health INTEGER,
    battery_cycles INTEGER,
    face_id_test TEXT DEFAULT 'Not Tested',
    fingerprint_test TEXT DEFAULT 'Not Tested',
    front_camera_test TEXT DEFAULT 'Not Tested',
    rear_camera_test TEXT DEFAULT 'Not Tested',
    speaker_test TEXT DEFAULT 'Not Tested',
    mic_test TEXT DEFAULT 'Not Tested',
    wifi_test TEXT DEFAULT 'Not Tested',
    cellular_test TEXT DEFAULT 'Not Tested',
    bluetooth_test TEXT DEFAULT 'Not Tested',
    charging_test TEXT DEFAULT 'Not Tested',
    vibration_test TEXT DEFAULT 'Not Tested',
    keyboard_test TEXT DEFAULT 'Not Tested',
    trackpad_test TEXT DEFAULT 'Not Tested',
    usb_ports_test TEXT DEFAULT 'Not Tested',
    hinge_test TEXT DEFAULT 'Not Tested',
    final_grade TEXT,
    notes TEXT,
    tested_by TEXT,
    test_date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lot_id TEXT,
    invoice_no TEXT,
    vendor_name TEXT NOT NULL,
    purchase_month TEXT,
    purchase_year INTEGER,
    device_types TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    modified_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS po_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id INTEGER REFERENCES purchase_orders(id) ON DELETE CASCADE,
    device_type TEXT,
    brand TEXT,
    model TEXT,
    sku TEXT,
    description TEXT,
    serial_number TEXT,
    imei TEXT,
    color TEXT,
    ram TEXT,
    storage TEXT,
    processor TEXT,
    wifi_cellular TEXT,
    qty INTEGER DEFAULT 1,
    unit_price REAL DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrations for existing databases
try { db.exec("ALTER TABLE order_testing ADD COLUMN overall_status TEXT DEFAULT 'Not Tested'"); } catch {}
try { db.exec("ALTER TABLE order_testing DROP COLUMN tracking_number"); } catch {}
try { db.exec("ALTER TABLE inventory ADD COLUMN po_id INTEGER"); } catch {}
try { db.exec("ALTER TABLE inventory ADD COLUMN lot_id TEXT"); } catch {}
try { db.exec("ALTER TABLE inventory ADD COLUMN invoice_no TEXT"); } catch {}
try { db.exec("ALTER TABLE inventory ADD COLUMN model TEXT"); } catch {}
try { db.exec("ALTER TABLE inventory ADD COLUMN wifi_cellular TEXT"); } catch {}
try { db.exec("ALTER TABLE inventory_testing ADD COLUMN testing_owner TEXT"); } catch {}
try { db.exec("ALTER TABLE inventory_testing ADD COLUMN mdm_lock TEXT DEFAULT 'Off'"); } catch {}
try { db.exec("ALTER TABLE inventory_testing ADD COLUMN d_grade_description TEXT"); } catch {}
try { db.exec("ALTER TABLE inventory_testing ADD COLUMN overall_grade TEXT"); } catch {}
try { db.exec("ALTER TABLE po_items ADD COLUMN receive_status TEXT DEFAULT 'Pending'"); } catch {}
try { db.exec("ALTER TABLE po_items ADD COLUMN inventory_id INTEGER"); } catch {}

// Seed default admin
const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!adminExists) {
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
    'admin', bcrypt.hashSync('admin123', 10), 'admin'
  );
  console.log('Default admin created: admin / admin123');
}

// ─── Auth middleware ─────────────────────────────────────────────────────────
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

// ─── Helper ──────────────────────────────────────────────────────────────────
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

// ─── Auth routes ─────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// ─── Dashboard ───────────────────────────────────────────────────────────────
app.get('/api/dashboard', auth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const { period = 'month', from, to } = req.query;

  const r = (sql, ...p) => db.prepare(sql).get(...p);
  const a = (sql, ...p) => db.prepare(sql).all(...p);

  // Resolve date range — custom from/to takes priority over period
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

  // Inventory stats
  const invTotal = r('SELECT COUNT(*) c FROM inventory').c;
  const invTested = r('SELECT COUNT(*) c FROM inventory_testing').c;
  const invNotTested = invTotal - invTested;
  const working = r("SELECT COUNT(*) c FROM inventory_testing WHERE overall_grade = 'Working'").c;
  const testRate = invTested > 0 ? Math.round(working / invTested * 100) : 0;

  // Grade distribution
  const grades = a(`SELECT COALESCE(final_grade,'Unknown') grade, COUNT(*) count FROM inventory_testing GROUP BY final_grade ORDER BY count DESC`);

  // Overall grade breakdown
  const overallGrades = a(`SELECT COALESCE(overall_grade,'Unknown') grade, COUNT(*) count FROM inventory_testing GROUP BY overall_grade ORDER BY count DESC`);

  // PO stats
  const poTotal = r('SELECT COUNT(*) c FROM purchase_orders').c;
  const poUnitsOrdered = r('SELECT COALESCE(SUM(qty),0) c FROM po_items').c;
  const poUnitsReceived = r("SELECT COALESCE(SUM(qty),0) c FROM po_items WHERE receive_status='Received'").c;
  const poSkusPending = r("SELECT COUNT(*) c FROM po_items WHERE receive_status != 'Received' OR receive_status IS NULL").c;

  // Inventory by month (last 8 months)
  const byMonth = a(`SELECT year, month, COUNT(*) count FROM inventory WHERE year IS NOT NULL AND month != '' GROUP BY year, month ORDER BY year DESC, CASE month WHEN 'January' THEN 1 WHEN 'February' THEN 2 WHEN 'March' THEN 3 WHEN 'April' THEN 4 WHEN 'May' THEN 5 WHEN 'June' THEN 6 WHEN 'July' THEN 7 WHEN 'August' THEN 8 WHEN 'September' THEN 9 WHEN 'October' THEN 10 WHEN 'November' THEN 11 WHEN 'December' THEN 12 END DESC LIMIT 8`);

  // Not tested devices (most recent 8)
  const notTested = a(`SELECT i.id, i.vendor, i.model, i.device_type, i.serial_number, i.lot_id, i.month, i.year FROM inventory i LEFT JOIN inventory_testing t ON i.id = t.inventory_id WHERE t.id IS NULL ORDER BY i.created_at DESC LIMIT 8`);

  // MDM lock rate
  const mdmOn = r("SELECT COUNT(*) c FROM inventory_testing WHERE mdm_lock = 'On'").c;
  const mdmRate = invTested > 0 ? Math.round(mdmOn / invTested * 100) : 0;

  res.json({
    period: resolvedPeriod, dateFrom, dateTo,
    orders: {
      total:     r(`SELECT COUNT(*) c ${orderBase}`).c,
      pending:   r(`SELECT COUNT(*) c ${orderBase} AND COALESCE(t.delivery_status,'Pending') = 'Pending'`).c,
      shipped:   r(`SELECT COUNT(*) c ${orderBase} AND t.delivery_status = 'Shipped'`).c,
      delivered: r(`SELECT COUNT(*) c ${orderBase} AND t.delivery_status = 'Delivered'`).c,
    },
    inventory: {
      total: invTotal, tested: invTested, notTested: invNotTested,
      workingRate: testRate, mdmRate,
      byType:   a('SELECT device_type, COUNT(*) count FROM inventory WHERE device_type IS NOT NULL AND device_type != \'\' GROUP BY device_type ORDER BY count DESC'),
      byVendor: a('SELECT vendor, COUNT(*) count FROM inventory WHERE vendor IS NOT NULL AND vendor != \'\' GROUP BY vendor ORDER BY count DESC LIMIT 10'),
      byMonth,
      grades, overallGrades,
    },
    po: { total: poTotal, unitsOrdered: poUnitsOrdered, unitsReceived: poUnitsReceived, skusPending: poSkusPending,
          receiveRate: poUnitsOrdered > 0 ? Math.round(poUnitsReceived / poUnitsOrdered * 100) : 0 },
    notTested,
  });
});

// ─── Daily Orders ─────────────────────────────────────────────────────────────
app.get('/api/orders', auth, (req, res) => {
  const { date, source, search, page = 1, limit = 100 } = req.query;
  let q = `SELECT o.*, COALESCE(t.delivery_status,'Pending') delivery_status,
           t.cosmetic_grade, t.overall_status, t.id test_id, t.tested_by, t.test_date
           FROM daily_orders o LEFT JOIN order_testing t ON o.id = t.order_row_id WHERE 1=1`;
  const p = [];
  if (date) { q += ' AND o.import_date = ?'; p.push(date); }
  if (source) { q += ' AND o.source = ?'; p.push(source); }
  if (search) { q += ' AND (o.serial_no LIKE ? OR o.order_id LIKE ? OR o.item_name LIKE ? OR o.recipient LIKE ?)'; const s = `%${search}%`; p.push(s,s,s,s); }
  q += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
  p.push(parseInt(limit), (parseInt(page)-1) * parseInt(limit));

  const orders = db.prepare(q).all(...p);
  const total = db.prepare('SELECT COUNT(*) c FROM daily_orders').get().c;
  const sources = db.prepare('SELECT DISTINCT source FROM daily_orders ORDER BY source').all().map(r=>r.source);
  const dates = db.prepare('SELECT DISTINCT import_date FROM daily_orders ORDER BY import_date DESC LIMIT 30').all().map(r=>r.import_date);
  res.json({ orders, total, sources, dates });
});

app.put('/api/orders/:id', auth, (req, res) => {
  const allowed = ['serial_no', 'item_name', 'item_sku', 'recipient', 'price', 'import_date'];
  const data = {};
  for (const k of allowed) { if (req.body[k] !== undefined) data[k] = req.body[k]; }
  if (!Object.keys(data).length) return res.status(400).json({ error: 'No valid fields' });
  const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE daily_orders SET ${sets} WHERE id = ?`).run(...Object.values(data), req.params.id);
  res.json({ success: true });
});

app.post('/api/orders/import', auth, upload.single('file'), (req, res) => {
  const wb = XLSX.read(req.file.buffer, {cellDates: true});
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, {cellDates: true});
  const importDate = req.body.ship_date || new Date().toISOString().split('T')[0];

  const stmt = db.prepare(`INSERT INTO daily_orders
    (import_date, source, serial_no, order_id, order_date, item_sku, item_name, recipient, qty, price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

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
  const run = db.transaction(() => {
    for (const row of rows) {
      const od = parseXlDate(row['Order Date']);
      stmt.run(importDate,
        g(row,'Source','source'),
        g(row,'Serial No.','Serial No','SERIAL_NO','serial_no'),
        g(row,'Order ID','order_id','OrderID'),
        od,
        g(row,'Item SKU','item_sku','SKU'),
        g(row,'Item Name','item_name','Description'),
        g(row,'Recipient','recipient'),
        parseInt(row['Qty'] || row['qty'] || 1) || 1,
        gNum(row,'Price','price')
      );
      count++;
    }
  });
  run();
  res.json({ success: true, imported: count });
});

app.delete('/api/orders/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM daily_orders WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── ShipStation ──────────────────────────────────────────────────────────────
app.get('/api/settings/shipstation', auth, (req, res) => {
  const key = db.prepare("SELECT value FROM settings WHERE key = 'ss_api_key'").get();
  const sec = db.prepare("SELECT value FROM settings WHERE key = 'ss_api_secret'").get();
  res.json({ apiKey: key?.value || '', hasSecret: !!sec?.value });
});

app.put('/api/settings/shipstation', auth, (req, res) => {
  const { apiKey, apiSecret } = req.body;
  if (apiKey !== undefined) db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('ss_api_key',?)").run(apiKey);
  if (apiSecret !== undefined) db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('ss_api_secret',?)").run(apiSecret);
  res.json({ success: true });
});

app.post('/api/orders/shipstation', auth, async (req, res) => {
  let { apiKey, apiSecret, ship_date, orderStatus, saveCredentials } = req.body;

  if (!apiKey) apiKey = db.prepare("SELECT value FROM settings WHERE key='ss_api_key'").get()?.value;
  if (!apiSecret) apiSecret = db.prepare("SELECT value FROM settings WHERE key='ss_api_secret'").get()?.value;
  if (!apiKey || !apiSecret) return res.status(400).json({ error: 'ShipStation API credentials not configured' });

  if (saveCredentials) {
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('ss_api_key',?)").run(apiKey);
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('ss_api_secret',?)").run(apiSecret);
  }

  const importDate = ship_date || new Date().toISOString().split('T')[0];
  const creds = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const qs = new URLSearchParams({ orderStatus: orderStatus || 'awaiting_shipment', pageSize: '500' });
  if (ship_date) { qs.set('createDateStart', ship_date + ' 00:00:00'); qs.set('createDateEnd', ship_date + ' 23:59:59'); }

  try {
    const resp = await fetch(`https://ssapi.shipstation.com/orders?${qs}`, {
      headers: { Authorization: `Basic ${creds}` }
    });
    if (!resp.ok) {
      const txt = await resp.text();
      return res.status(resp.status).json({ error: `ShipStation: ${resp.status} — ${txt.slice(0,200)}` });
    }
    const data = await resp.json();
    const orders = data.orders || [];

    const stmt = db.prepare(`INSERT INTO daily_orders
      (import_date, source, serial_no, order_id, order_date, item_sku, item_name, recipient, qty, price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    let count = 0;
    db.transaction(() => {
      for (const o of orders) {
        const oDate = o.orderDate ? o.orderDate.split('T')[0] : importDate;
        const store = o.advancedOptions?.storeName || 'ShipStation';
        for (const item of o.items || []) {
          stmt.run(importDate, store, '', String(o.orderNumber || o.orderId),
            oDate, item.sku || '', item.name || '',
            o.shipTo?.name || '', item.quantity || 1, item.unitPrice || 0);
          count++;
        }
      }
    })();
    res.json({ success: true, imported: count, ordersFound: orders.length });
  } catch (ex) {
    res.status(500).json({ error: ex.message });
  }
});

app.get('/api/orders/:id/testing', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM order_testing WHERE order_row_id = ?').get(req.params.id) || null);
});

app.post('/api/orders/:id/testing', auth, (req, res) => {
  const existing = db.prepare('SELECT id FROM order_testing WHERE order_row_id = ?').get(req.params.id);
  const data = { ...req.body };
  delete data.id; delete data.order_row_id; delete data.created_at;

  if (existing) {
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE order_testing SET ${sets} WHERE order_row_id = ?`).run(...Object.values(data), req.params.id);
    res.json({ success: true, action: 'updated' });
  } else {
    const keys = Object.keys(data);
    db.prepare(`INSERT INTO order_testing (order_row_id, ${keys.join(', ')}) VALUES (?, ${keys.map(()=>'?').join(', ')})`).run(req.params.id, ...Object.values(data));
    res.json({ success: true, action: 'created' });
  }
});

// ─── Inventory barcode lookup ─────────────────────────────────────────────────
app.get('/api/inventory/scan', auth, (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'No scan value' });
  const val = q.trim();
  // Match by serial_number, imei, sku, or INV-{id}
  let item = db.prepare(`SELECT i.*, t.final_grade tested_grade, t.overall_grade, t.mdm_lock, t.battery_health
    FROM inventory i LEFT JOIN inventory_testing t ON i.id = t.inventory_id
    WHERE i.serial_number = ? OR i.imei = ? LIMIT 1`).get(val, val);
  if (!item && val.toUpperCase().startsWith('INV-')) {
    const id = parseInt(val.split('-')[1]);
    item = db.prepare(`SELECT i.*, t.final_grade tested_grade, t.overall_grade, t.mdm_lock
      FROM inventory i LEFT JOIN inventory_testing t ON i.id = t.inventory_id WHERE i.id = ?`).get(id);
  }
  if (!item) {
    item = db.prepare(`SELECT i.*, t.final_grade tested_grade, t.overall_grade, t.mdm_lock
      FROM inventory i LEFT JOIN inventory_testing t ON i.id = t.inventory_id
      WHERE i.sku = ? LIMIT 1`).get(val);
  }
  if (!item) return res.status(404).json({ error: `No inventory item found for: ${val}` });
  res.json(item);
});

// ─── Inventory ────────────────────────────────────────────────────────────────
app.get('/api/inventory', auth, (req, res) => {
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
  if (search) { q += ' AND (i.serial_number LIKE ? OR i.imei LIKE ? OR i.description LIKE ? OR i.sku LIKE ? OR i.model LIKE ?)'; const s=`%${search}%`; p.push(s,s,s,s,s); }
  q += ' ORDER BY i.created_at DESC LIMIT ? OFFSET ?';
  p.push(parseInt(limit), (parseInt(page)-1)*parseInt(limit));

  const items = db.prepare(q).all(...p);
  const total = db.prepare('SELECT COUNT(*) c FROM inventory').get().c;
  const vendors = db.prepare('SELECT DISTINCT vendor FROM inventory ORDER BY vendor').all().map(r=>r.vendor);
  const months = db.prepare('SELECT DISTINCT month, year FROM inventory ORDER BY year DESC, month DESC').all();
  const types = db.prepare('SELECT DISTINCT device_type FROM inventory ORDER BY device_type').all().map(r=>r.device_type);
  res.json({ items, total, vendors, months, types });
});

app.get('/api/inventory/export', auth, (req, res) => {
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
  if (search) { q += ' AND (i.serial_number LIKE ? OR i.imei LIKE ? OR i.description LIKE ? OR i.sku LIKE ? OR i.model LIKE ?)'; const s=`%${search}%`; p.push(s,s,s,s,s); }
  q += ' ORDER BY i.created_at DESC';
  const rows = db.prepare(q).all(...p);

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
});

app.post('/api/inventory', auth, (req, res) => {
  const d = req.body;
  const keys = Object.keys(d).filter(k => k !== 'id' && k !== 'created_at');
  const result = db.prepare(`INSERT INTO inventory (${keys.join(', ')}) VALUES (${keys.map(()=>'?').join(', ')})`).run(...keys.map(k=>d[k]));
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/inventory/:id', auth, (req, res) => {
  const d = req.body;
  const keys = Object.keys(d).filter(k => k !== 'id' && k !== 'created_at');
  db.prepare(`UPDATE inventory SET ${keys.map(k=>`${k}=?`).join(', ')} WHERE id = ?`).run(...keys.map(k=>d[k]), req.params.id);
  res.json({ success: true });
});

app.delete('/api/inventory/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM inventory WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/inventory/import', auth, upload.single('file'), (req, res) => {
  const { vendor, month, year, device_type } = req.body;
  const wb = XLSX.read(req.file.buffer);
  let totalImported = 0;

  const stmt = db.prepare(`INSERT INTO inventory
    (month, year, vendor, device_type, po_number, vendor_item_id, manufacturer, part_number,
     description, serial_number, imei, condition_grade, missing_components, damages,
     color, storage, ram, screen_size, grade, sku, facility, carrier, lock_status, price, po_price, remarks)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const run = db.transaction(() => {
    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
      for (const row of rows) {
        // Extract serial from description brackets for Digicircle format
        let sn = g(row,'SERIAL_NUMBER','Serial Number','SERIAL NUMBER','Serial_Number');
        let imei = g(row,'IMEI','IMEI No.','imei','IMEI No');
        if (!sn && !imei) {
          const desc = g(row,'Description','description');
          const match = desc.match(/\[(\d{10,20})\]/);
          if (match) imei = match[1];
        }

        stmt.run(
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
        );
        totalImported++;
      }
    }
  });
  run();
  res.json({ success: true, imported: totalImported });
});

app.get('/api/inventory/:id/testing', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM inventory_testing WHERE inventory_id = ?').get(req.params.id) || null);
});

app.post('/api/inventory/:id/testing', auth, (req, res) => {
  const existing = db.prepare('SELECT id FROM inventory_testing WHERE inventory_id = ?').get(req.params.id);
  const data = { ...req.body };
  delete data.id; delete data.inventory_id; delete data.created_at;

  if (existing) {
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE inventory_testing SET ${sets} WHERE inventory_id = ?`).run(...Object.values(data), req.params.id);
    res.json({ success: true, action: 'updated' });
  } else {
    const keys = Object.keys(data);
    db.prepare(`INSERT INTO inventory_testing (inventory_id, ${keys.join(', ')}) VALUES (?, ${keys.map(()=>'?').join(', ')})`).run(req.params.id, ...Object.values(data));
    res.json({ success: true, action: 'created' });
  }
});

// ─── Users ────────────────────────────────────────────────────────────────────
app.get('/api/users', auth, adminOnly, (req, res) => {
  res.json(db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at').all());
});

app.post('/api/users', auth, adminOnly, (req, res) => {
  const { username, password, role } = req.body;
  try {
    const result = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, bcrypt.hashSync(password, 10), role || 'user');
    res.json({ success: true, id: result.lastInsertRowid });
  } catch {
    res.status(400).json({ error: 'Username already exists' });
  }
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.put('/api/users/:id/password', auth, adminOnly, (req, res) => {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.password, 10), req.params.id);
  res.json({ success: true });
});

// ─── Catalog Settings ─────────────────────────────────────────────────────────
const DEFAULT_CATALOG = {
  colors: ['Space Gray','Silver','Gold','Rose Gold','Midnight','Starlight','Blue','Green','Purple','Red','Black','White','Yellow','Orange','Coral','Pacific Blue','Alpine Green','Deep Purple','Natural Titanium','Black Titanium','White Titanium'],
  ram: ['2GB','3GB','4GB','6GB','8GB','12GB','16GB','24GB','32GB','64GB','96GB','128GB'],
  storage: ['8GB','16GB','32GB','64GB','128GB','256GB','512GB','1TB','2TB','4TB'],
  models: {}
};

app.get('/api/settings/catalog', auth, (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'device_catalog'").get();
  if (row) {
    try { return res.json(JSON.parse(row.value)); } catch {}
  }
  res.json(DEFAULT_CATALOG);
});

app.put('/api/settings/catalog', auth, adminOnly, (req, res) => {
  const catalog = req.body;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('device_catalog', ?)").run(JSON.stringify(catalog));
  res.json({ success: true });
});

// ─── Purchase Orders ──────────────────────────────────────────────────────────
app.get('/api/purchase-orders', auth, (req, res) => {
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
  const pos = db.prepare(q).all(...p);
  const total = db.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c;
  res.json({ pos, total });
});

app.post('/api/purchase-orders', auth, (req, res) => {
  const d = req.body;
  const result = db.prepare(`INSERT INTO purchase_orders (lot_id, invoice_no, vendor_name, purchase_month, purchase_year, device_types, notes)
    VALUES (?,?,?,?,?,?,?)`).run(d.lot_id||'', d.invoice_no||'', d.vendor_name, d.purchase_month||'', d.purchase_year||null, d.device_types||'', d.notes||'');
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/purchase-orders/:id', auth, (req, res) => {
  const d = req.body;
  db.prepare(`UPDATE purchase_orders SET lot_id=?,invoice_no=?,vendor_name=?,purchase_month=?,purchase_year=?,device_types=?,notes=?,modified_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(d.lot_id||'', d.invoice_no||'', d.vendor_name, d.purchase_month||'', d.purchase_year||null, d.device_types||'', d.notes||'', req.params.id);
  res.json({ success: true });
});

app.delete('/api/purchase-orders/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/purchase-orders/:id/items', auth, (req, res) => {
  const { search, brand, device_type } = req.query;
  let q = 'SELECT * FROM po_items WHERE po_id = ?';
  const p = [req.params.id];
  if (search) { q += ' AND (serial_number LIKE ? OR imei LIKE ? OR model LIKE ? OR sku LIKE ? OR description LIKE ? OR brand LIKE ?)'; const s=`%${search}%`; p.push(s,s,s,s,s,s); }
  if (brand) { q += ' AND brand = ?'; p.push(brand); }
  if (device_type) { q += ' AND device_type = ?'; p.push(device_type); }
  q += ' ORDER BY id';
  res.json(db.prepare(q).all(...p));
});

app.post('/api/po-items', auth, (req, res) => {
  const d = req.body;
  const result = db.prepare(`INSERT INTO po_items (po_id,device_type,brand,model,sku,description,serial_number,imei,color,ram,storage,processor,wifi_cellular,qty,unit_price,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(d.po_id,d.device_type||'',d.brand||'',d.model||'',d.sku||'',d.description||'',d.serial_number||'',d.imei||'',d.color||'',d.ram||'',d.storage||'',d.processor||'',d.wifi_cellular||'',d.qty||1,d.unit_price||0,d.notes||'');
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/po-items/:id', auth, (req, res) => {
  const d = req.body;
  db.prepare(`UPDATE po_items SET device_type=?,brand=?,model=?,sku=?,description=?,serial_number=?,imei=?,color=?,ram=?,storage=?,processor=?,wifi_cellular=?,qty=?,unit_price=?,notes=? WHERE id=?`)
    .run(d.device_type||'',d.brand||'',d.model||'',d.sku||'',d.description||'',d.serial_number||'',d.imei||'',d.color||'',d.ram||'',d.storage||'',d.processor||'',d.wifi_cellular||'',d.qty||1,d.unit_price||0,d.notes||'',req.params.id);
  res.json({ success: true });
});

app.delete('/api/po-items/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM po_items WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/po-items/:id/receive', auth, (req, res) => {
  const item = db.prepare('SELECT pi.*, po.lot_id, po.invoice_no, po.vendor_name, po.purchase_month, po.purchase_year FROM po_items pi JOIN purchase_orders po ON pi.po_id = po.id WHERE pi.id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const { receive_status, units } = req.body;

  let inventoryIds = [];
  if (receive_status === 'Received') {
    // Delete any previously created inventory records for re-receive scenario
    if (item.inventory_id) {
      db.prepare('DELETE FROM inventory WHERE id = ? AND po_id = ?').run(item.inventory_id, item.po_id);
    }
    const qty = item.qty || 1;
    const insertInv = db.prepare(`INSERT INTO inventory
      (vendor, month, year, device_type, model, color, ram, storage, wifi_cellular,
       serial_number, imei, sku, description, lot_id, invoice_no, po_id, price, po_price)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      for (let i = 0; i < qty; i++) {
        const u = units?.[i] || {};
        const sn = u.serial_number !== undefined ? u.serial_number : (qty === 1 ? item.serial_number||'' : '');
        const im = u.imei !== undefined ? u.imei : (qty === 1 ? item.imei||'' : '');
        const r = insertInv.run(
          item.vendor_name||'', item.purchase_month||'', item.purchase_year||null,
          item.device_type||'', item.model||'', item.color||'', item.ram||'', item.storage||'',
          item.wifi_cellular||'', sn, im, item.sku||'', item.description||'',
          item.lot_id||'', item.invoice_no||'', item.po_id,
          item.unit_price||0, item.unit_price||0
        );
        inventoryIds.push(r.lastInsertRowid);
      }
    })();
  }

  db.prepare('UPDATE po_items SET receive_status=?, inventory_id=? WHERE id=?').run(
    receive_status, inventoryIds[0]||item.inventory_id||null, req.params.id
  );
  res.json({ success: true, inventory_ids: inventoryIds, count: inventoryIds.length });
});

app.post('/api/purchase-orders/:id/receive-all', auth, (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const items = db.prepare("SELECT pi.*, po.lot_id, po.invoice_no, po.vendor_name, po.purchase_month, po.purchase_year FROM po_items pi JOIN purchase_orders po ON pi.po_id = po.id WHERE pi.po_id = ? AND (pi.receive_status IS NULL OR pi.receive_status != 'Received')").all(req.params.id);

  const insertInv = db.prepare(`INSERT INTO inventory
    (vendor, month, year, device_type, model, color, ram, storage, wifi_cellular,
     serial_number, imei, sku, description, lot_id, invoice_no, po_id, price, po_price)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  let totalUnits = 0;
  db.transaction(() => {
    for (const item of items) {
      const qty = item.qty || 1;
      let firstId = null;
      for (let i = 0; i < qty; i++) {
        const sn = (qty === 1 ? item.serial_number||'' : '');
        const im = (qty === 1 ? item.imei||'' : '');
        const r = insertInv.run(
          item.vendor_name||'', item.purchase_month||'', item.purchase_year||null,
          item.device_type||'', item.model||'', item.color||'', item.ram||'', item.storage||'',
          item.wifi_cellular||'', sn, im, item.sku||'', item.description||'',
          item.lot_id||'', item.invoice_no||'', item.po_id,
          item.unit_price||0, item.unit_price||0
        );
        if (i === 0) firstId = r.lastInsertRowid;
        totalUnits++;
      }
      db.prepare("UPDATE po_items SET receive_status='Received', inventory_id=? WHERE id=?").run(firstId, item.id);
    }
  })();

  res.json({ success: true, items_received: items.length, units_created: totalUnits });
});

app.get('/api/purchase-orders/:id/export', auth, (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const items = db.prepare('SELECT * FROM po_items WHERE po_id = ? ORDER BY id').all(req.params.id);
  const wb = XLSX.utils.book_new();
  const hdr = [['Lot ID','Invoice No','Vendor Name','Month','Year','Device Types','Notes','Created'],
    [po.lot_id,po.invoice_no,po.vendor_name,po.purchase_month,po.purchase_year,po.device_types,po.notes,po.created_at]];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(hdr), 'PO Header');
  const rows = [['Device Type','Brand','Model','SKU','Description','Serial Number','IMEI','Color','RAM','Storage','Processor','WiFi/Cellular','Qty','Unit Price','Receive Status','Notes']];
  for (const it of items) rows.push([it.device_type,it.brand,it.model,it.sku,it.description,it.serial_number,it.imei,it.color,it.ram,it.storage,it.processor,it.wifi_cellular,it.qty,it.unit_price,it.receive_status||'Pending',it.notes]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'PO Items');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fname = `PO_${(po.lot_id||po.id).replace(/[^a-z0-9_-]/gi,'_')}_${po.vendor_name.replace(/\s+/g,'_')}.xlsx`;
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.post('/api/purchase-orders/:id/import-items', auth, upload.single('file'), (req, res) => {
  const po = db.prepare('SELECT id FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const wb = XLSX.read(req.file.buffer);
  const sn = wb.SheetNames.find(n => n.toLowerCase().includes('item')) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn]);
  const stmt = db.prepare(`INSERT INTO po_items (po_id,device_type,brand,model,sku,description,serial_number,imei,color,ram,storage,processor,wifi_cellular,qty,unit_price,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let count = 0;
  db.transaction(() => {
    for (const row of rows) {
      stmt.run(req.params.id,
        g(row,'Device Type','device_type','Type'),g(row,'Brand','brand','Manufacturer'),g(row,'Model','model'),
        g(row,'SKU','sku'),g(row,'Description','description','Item Name'),
        g(row,'Serial Number','serial_number','S/N','Serial No','Serial No.','Serial','SERIAL','SN','S.No.','SERIAL_NUMBER','Serial_Number','SerialNumber','serial','Serial #','S/N No'),
        g(row,'IMEI','imei','IMEI No','IMEI No.','IMEI Number','imei_number'),
        g(row,'Color','color'),g(row,'RAM','ram','Memory'),g(row,'Storage','storage','Capacity'),
        g(row,'Processor','processor','CPU'),g(row,'WiFi/Cellular','wifi_cellular','Connectivity'),
        parseInt(g(row,'Qty','qty','Quantity'))||1,parseFloat(g(row,'Unit Price','unit_price','Price'))||0,
        g(row,'Notes','notes','Remarks'));
      count++;
    }
  })();
  res.json({ success: true, imported: count });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\nTekhouz Warehouse Management running at http://localhost:${PORT}\nLogin: admin / admin123\n`));
