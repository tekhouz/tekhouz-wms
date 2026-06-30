// ─── State ─────────────────────────────────────────────────────────────────
const S = {
  token: localStorage.getItem('rt_token'),
  user: JSON.parse(localStorage.getItem('rt_user') || 'null'),
  screen: 'dashboard',
  orders: { orders: [], total: 0, sources: [], dates: [] },
  inventory: { items: [], total: 0, vendors: [], months: [], types: [] },
  dashboard: null,
  users: [],
  po: { pos: [], total: 0, filters: { search: '', vendor: '', month: '', year: '' }, currentPo: null, poItems: [], itemSearch: '' },
  returns: { list: [], stats: {}, filters: { status: '', return_from: '', search: '' } },
  requisitions: { list: [], stats: {}, filters: { status: '', priority: '', part_category: '', search: '' } },
  partspo: { list: [], stats: {}, filters: { status: '', vendor: '', search: '' } },
  serviceorders: { list: [], stats: {}, filters: { status: '', technician: '', repair_type: '', search: '' } },
  partsinventory: { list: [], stats: {}, filters: { category: '', part_type: '', search: '' } },
  catalog: null,
  oFilters: { date: '', source: '', search: '', delivery: '' },
  _oTypeTab: 'all',
  iFilters: { month: '', year: '', vendor: '', device_type: '', lot_id: '', search: '' },
  _invSelected: new Set(),
  _ordSelected: new Set(),
  _poItemSelected: new Set(),
};

// ─── API ───────────────────────────────────────────────────────────────────
async function api(method, path, body, isFile) {
  const opts = { method, headers: {} };
  if (S.token) opts.headers['Authorization'] = 'Bearer ' + S.token;
  if (isFile) { opts.body = body; }
  else if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  if (r.status === 401) { doLogout(); return; }
  // Safely parse — server might return HTML on crash/404
  const ct = r.headers.get('content-type') || '';
  let data;
  if (ct.includes('application/json')) {
    data = await r.json();
  } else {
    const text = await r.text();
    if (!r.ok) throw new Error(`Server error ${r.status}: ${text.replace(/<[^>]+>/g,'').trim().slice(0,120)}`);
    throw new Error(`Unexpected response (${r.status})`);
  }
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ─── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (S.token && S.user) { showApp(); nav('dashboard'); }
});

// ─── Auth ──────────────────────────────────────────────────────────────────
async function doLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-err');
  const username = document.getElementById('inp-username').value.trim();
  const password = document.getElementById('inp-password').value;
  err.textContent = '';
  btn.textContent = 'Signing in…';
  btn.disabled = true;
  try {
    const res = await api('POST', '/api/login', { username, password });
    S.token = res.token; S.user = res.user;
    localStorage.setItem('rt_token', res.token);
    localStorage.setItem('rt_user', JSON.stringify(res.user));
    showApp(); nav('dashboard');
  } catch (ex) {
    err.textContent = ex.message;
    btn.textContent = 'Sign In'; btn.disabled = false;
  }
}

function doLogout() {
  S.token = null; S.user = null;
  localStorage.removeItem('rt_token'); localStorage.removeItem('rt_user');
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-page').style.display = 'flex';
}

function showApp() {
  document.getElementById('login-page').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('sb-uname').textContent = S.user.username;
  document.getElementById('sb-urole').textContent = S.user.role;
  document.getElementById('sb-avatar').textContent = S.user.username[0].toUpperCase();
  if (S.user.role === 'admin') document.querySelectorAll('.admin-only').forEach(el => el.style.display = '');
  loadCatalog();
}

async function loadCatalog() {
  try {
    const catalog = await api('GET', '/api/settings/catalog');
    if (!catalog.vendors || !catalog.vendors.length) {
      catalog.vendors = [...VENDORS_DEFAULT];
      try { await api('PUT', '/api/settings/catalog', catalog); } catch {}
    }
    S.catalog = catalog;
  } catch {}
}

// ─── Navigation ────────────────────────────────────────────────────────────
function nav(screen) {
  S.screen = screen;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('screen-' + screen).classList.add('active');
  document.querySelector(`.nav-item[data-screen="${screen}"]`)?.classList.add('active');
  const renders = { dashboard: renderDashboard, orders: renderOrders, inventory: renderInventory, returns: renderReturns, users: renderUsers, po: renderPurchaseOrders, settings: renderSettings, requisitions: renderRequisitions, 'parts-po': renderPartsPO, 'service-orders': renderServiceOrders, 'parts-inventory': renderPartsInventory };
  renders[screen]?.();
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function fmt(v) { return v || '—'; }

// Replace the grade segment in a SKU string (e.g. ipad-7th-32gb-SG-A → ipad-7th-32gb-SG-A+)
// Grades are checked longest-first so "D-Fixable" is matched before "D" etc.
function updateSkuGrade(sku, newGrade) {
  if (!sku || !newGrade) return sku;
  const grades = ['A+','A','B+','B','C','D-Fixable','D-Parts','S-Scrap'];
  const upper = sku.toUpperCase();
  for (const g of grades) {
    if (upper.endsWith('-' + g.toUpperCase())) {
      // Strip the old grade (keep the trailing dash from the prefix)
      return sku.slice(0, sku.length - g.length) + newGrade;
    }
  }
  // No recognised grade at the end — just append
  return sku + '-' + newGrade;
}

// Color name → SKU abbreviation map (matches DEFAULT_CATALOG colors in server)
const COLOR_ABBR_MAP = {
  'Space Gray':'SG','Silver':'SL','Gold':'GD','Rose Gold':'RG',
  'Midnight':'MN','Starlight':'ST','Blue':'BL','Green':'GN',
  'Purple':'PR','Red':'RD','Black':'BK','White':'WT',
  'Yellow':'YL','Orange':'OR','Coral':'CO','Pacific Blue':'PB',
  'Alpine Green':'AG','Deep Purple':'DP','Natural Titanium':'NT',
  'Black Titanium':'BKT','White Titanium':'WTT'
};
function colorToAbbr(name) {
  if (!name) return '';
  return COLOR_ABBR_MAP[name] || name.replace(/\s+/g,'').slice(0,3).toUpperCase();
}

// Replace the color abbreviation segment in a SKU (e.g. ipad-32gb-SG-A → ipad-32gb-SL-A)
function updateSkuColor(sku, newColorAbbr) {
  if (!sku || !newColorAbbr) return sku;
  const grades = ['A+','A','B+','B','C','D-Fixable','D-Parts','S-Scrap'];
  const allAbbrs = Object.values(COLOR_ABBR_MAP);
  // Strip grade suffix
  let gradeSuffix = '', base = sku;
  for (const g of grades) {
    if (sku.toUpperCase().endsWith('-' + g.toUpperCase())) {
      gradeSuffix = '-' + g;
      base = sku.slice(0, sku.length - g.length - 1);
      break;
    }
  }
  // Replace known color abbreviation at end of base
  const baseUpper = base.toUpperCase();
  for (const abbr of allAbbrs) {
    if (baseUpper.endsWith('-' + abbr.toUpperCase())) {
      return base.slice(0, base.length - abbr.length) + newColorAbbr + gradeSuffix;
    }
  }
  // No match — insert before grade
  return base + '-' + newColorAbbr + gradeSuffix;
}

// Live preview shown below the Overall Grade dropdown in the testing modal
// Handles both grade and color changes in one preview line
function previewSkuUpdate() {
  const grade = document.getElementById('t-overall_grade')?.value;
  const colorName = document.getElementById('t-color')?.value;
  const currentSku = document.getElementById('t-current-sku')?.value;
  const preview = document.getElementById('sku-grade-preview');
  if (!preview) return;
  if (!currentSku) { preview.innerHTML = ''; return; }
  let newSku = currentSku;
  if (grade) newSku = updateSkuGrade(newSku, grade);
  if (colorName) { const abbr = colorToAbbr(colorName); if (abbr) newSku = updateSkuColor(newSku, abbr); }
  const changed = newSku !== currentSku;
  const gradeColors = { 'A+':'#15803d', A:'#22c55e', 'B+':'#0ea5e9', B:'#3b82f6', C:'#f59e0b', 'D-Fixable':'#f97316', 'D-Parts':'#ef4444', 'S-Scrap':'#7f1d1d' };
  const col = gradeColors[grade] || '#2563eb';
  preview.innerHTML = changed
    ? `<span style="color:var(--muted)">SKU → </span><span style="font-family:monospace;font-weight:700;color:${col}">${esc(newSku)}</span>`
    : `<span style="color:var(--muted);font-style:italic">SKU unchanged</span>`;
}
function previewSkuGrade() { previewSkuUpdate(); }
function fmtPrice(v) { return v ? '$' + parseFloat(v).toFixed(2) : '—'; }
function fmtDate(v) {
  if (!v) return '—';
  // Parse YYYY-MM-DD as local date (avoids UTC midnight → wrong day in US timezones)
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return new Date(y, m-1, d).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
  }
  try { const d = new Date(v); return isNaN(d) ? v : d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
  catch { return v; }
}
function esc(s) { const d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }

function detectDeviceType(name='', sku='') {
  const t = (name + ' ' + sku).toLowerCase();
  if (t.includes('iphone')) return 'iPhone';
  if (t.includes('macbook') || /\bmba\b|\bmbp\b/.test(t)) return 'MacBook';
  if (t.includes('ipad')) return 'iPad';
  if (t.includes('galaxy') || t.includes('sm-') || t.includes('pixel') || t.includes('motorola') || t.includes('oneplus')) return 'Smartphone';
  if (t.includes('surface') || t.includes('thinkpad') || t.includes('latitude') || t.includes('elitebook') || t.includes('inspiron')) return 'Laptop';
  if (t.includes('playstation') || t.includes('ps5') || t.includes('xbox')) return 'Gaming Console';
  if (t.includes('watch')) return 'Smartwatch';
  return 'Other';
}

function deliveryBadge(s) {
  const map = { Pending:'pending', Shipped:'shipped', Delivered:'delivered', Returned:'returned', Cancelled:'cancelled', 'Ready to Ship':'ready' };
  return `<span class="badge badge-${map[s]||'na'}">${s||'Pending'}</span>`;
}
function gradeBadge(g) {
  if (!g) return '<span class="badge badge-na">—</span>';
  return `<span class="badge badge-${g.toUpperCase()}">${g.toUpperCase()}</span>`;
}
function testBadge(v) {
  const map = { Pass:'pass', Fail:'fail', 'N/A':'na', 'Not Tested':'not-tested' };
  return `<span class="badge badge-${map[v]||'not-tested'}">${v||'Not Tested'}</span>`;
}

function showToast(msg, type='success') {
  const t = document.createElement('div');
  t.className = `alert alert-${type}`;
  t.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;min-width:280px;box-shadow:0 8px 24px rgba(0,0,0,.15)';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ─── Modal ──────────────────────────────────────────────────────────────────
function openModal(html) {
  document.getElementById('modal-box').innerHTML = html;
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal() { document.getElementById('modal-overlay').classList.remove('open'); }
function closeModalOnBg(e) { if (e.target === document.getElementById('modal-overlay')) closeModal(); }

// ─── DASHBOARD ─────────────────────────────────────────────────────────────
let _dashPeriod = 'month';
let _dashFrom = '';
let _dashTo = '';

async function renderDashboard(period) {
  if (period && period !== 'custom') { _dashPeriod = period; _dashFrom = ''; _dashTo = ''; }
  const el = document.getElementById('screen-dashboard');
  el.innerHTML = `<div class="screen-header"><h2>Dashboard</h2><p>Loading…</p></div><div style="text-align:center;padding:40px"><div class="loader"></div></div>`;
  try {
    let qs = _dashFrom && _dashTo
      ? `from=${_dashFrom}&to=${_dashTo}`
      : `period=${_dashPeriod}`;
    const d = await api('GET', '/api/dashboard?' + qs);
    S.dashboard = d;

    const periodLabel = { daily: 'Today', week: 'This Week', month: 'This Month', year: 'This Year' }[_dashPeriod];
    const pctBar = (val, max, color) => {
      const pct = max ? Math.min(100, Math.round(val / max * 100)) : 0;
      return `<div style="background:#f1f5f9;border-radius:4px;height:6px;margin-top:6px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${color};border-radius:4px;transition:.4s"></div></div>`;
    };

    // ── Inventory by Month ───────────────────────────────────────
    const maxMonthCount = Math.max(...d.inventory.byMonth.map(x => x.count), 1);
    const monthRows = d.inventory.byMonth.map(x => `
      <div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid #f1f5f9">
        <div style="width:110px;font-size:12px;font-weight:500;flex-shrink:0">${x.month?.slice(0,3)} ${x.year}</div>
        <div style="flex:1">${pctBar(x.count, maxMonthCount, 'var(--blue)')}</div>
        <div style="font-size:13px;font-weight:700;color:var(--blue);min-width:36px;text-align:right">${x.count}</div>
      </div>`).join('') || '<p style="color:var(--muted);font-size:13px">No data</p>';

    // ── Inventory by Vendor ──────────────────────────────────────
    const maxVendor = Math.max(...d.inventory.byVendor.map(x => x.count), 1);
    const vendorRows = d.inventory.byVendor.map(x => `
      <div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid #f1f5f9">
        <div style="width:110px;font-size:12px;font-weight:500;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(x.vendor)}">${esc(x.vendor)}</div>
        <div style="flex:1">${pctBar(x.count, maxVendor, 'var(--purple)')}</div>
        <div style="font-size:13px;font-weight:700;color:var(--purple);min-width:36px;text-align:right">${x.count}</div>
      </div>`).join('') || '<p style="color:var(--muted);font-size:13px">No vendors</p>';

    // ── Device by Type ───────────────────────────────────────────
    const maxType = Math.max(...d.inventory.byType.map(x => x.count), 1);
    const typeRows = d.inventory.byType.map(x => `
      <div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid #f1f5f9">
        <div style="width:130px;font-size:12px;flex-shrink:0">${typeIcon(x.device_type)} ${x.device_type||'Unknown'}</div>
        <div style="flex:1">${pctBar(x.count, maxType, 'var(--cyan)')}</div>
        <div style="font-size:13px;font-weight:700;color:var(--cyan);min-width:36px;text-align:right">${x.count}</div>
      </div>`).join('') || '<p style="color:var(--muted);font-size:13px">No inventory</p>';

    // ── Grade Distribution ───────────────────────────────────────
    const gradeColors = { 'A+':'#15803d', A:'#22c55e', 'B+':'#0ea5e9', B:'#3b82f6', C:'#f59e0b', 'D-Fixable':'#f97316', 'D-Parts':'#ef4444', 'S-Scrap':'#7f1d1d', Unknown:'var(--muted)' };
    const maxGrade = Math.max(...d.inventory.grades.map(x => x.count), 1);
    const gradeRows = d.inventory.grades.map(x => `
      <div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid #f1f5f9">
        <div style="min-width:80px;font-size:12px;font-weight:700;color:${gradeColors[x.grade]||'var(--muted)'};flex-shrink:0">${x.grade}</div>
        <div style="flex:1">${pctBar(x.count, maxGrade, gradeColors[x.grade]||'var(--muted)')}</div>
        <div style="font-size:13px;font-weight:700;min-width:36px;text-align:right">${x.count}</div>
      </div>`).join('') || '<p style="color:var(--muted);font-size:13px">No graded items</p>';

    // ── Not Tested ───────────────────────────────────────────────
    const notTestedRows = d.notTested.map(i => `
      <tr>
        <td><span class="chip ${deviceTypeClass(i.device_type)}" style="font-size:11px;padding:2px 6px">${typeIcon(i.device_type)} ${i.device_type||'—'}</span></td>
        <td style="font-weight:600;font-size:12px">${esc(i.model||'—')}</td>
        <td style="font-size:11px;color:var(--muted)">${esc(i.vendor)}</td>
        <td class="mono" style="font-size:11px">${esc(i.serial_number||'—')}</td>
        <td style="font-size:11px;color:var(--muted)">${i.month?.slice(0,3)||''} ${i.year||''}</td>
        <td><button class="btn btn-primary btn-sm" onclick="nav('inventory')">Test →</button></td>
      </tr>`).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--green);padding:16px;font-size:13px">✓ All items tested!</td></tr>`;

    el.innerHTML = `
      <div class="screen-header">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
          <div>
            <h2>Dashboard</h2>
            <p>${new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
          </div>
        </div>
      </div>

      <!-- Orders Section with period filter -->
      <div class="card" style="margin-bottom:18px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px">
          <div>
            <div class="card-title" style="margin-bottom:2px">📋 Orders</div>
            <div style="font-size:12px;color:var(--blue);font-weight:600">
              ${d.dateFrom ? `${fmtDate(d.dateFrom)} → ${fmtDate(d.dateTo)}` : 'All time'}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <!-- Quick period tabs -->
            <div style="display:flex;gap:3px;background:#f1f5f9;border-radius:8px;padding:3px">
              ${['daily','week','month','year'].map(p=>`
                <button onclick="renderDashboard('${p}')" style="padding:4px 11px;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:.15s;background:${(_dashPeriod===p&&!(_dashFrom&&_dashTo))?'#fff':'transparent'};color:${(_dashPeriod===p&&!(_dashFrom&&_dashTo))?'var(--blue)':'var(--muted)'};box-shadow:${(_dashPeriod===p&&!(_dashFrom&&_dashTo))?'var(--sh)':'none'}">
                  ${p==='daily'?'Today':p==='week'?'Week':p==='month'?'Month':'Year'}
                </button>`).join('')}
            </div>
            <!-- Custom date range -->
            <div style="display:flex;align-items:center;gap:6px;padding:4px 8px;background:${(_dashFrom&&_dashTo)?'#eff6ff':'#f8fafc'};border:1.5px solid ${(_dashFrom&&_dashTo)?'var(--blue)':'var(--border)'};border-radius:8px">
              <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" style="color:var(--muted);flex-shrink:0"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              <input type="date" id="dash-from" value="${_dashFrom || d.dateFrom || ''}" style="border:none;background:transparent;font-size:12px;color:var(--txt);outline:none;width:110px" onchange="_dashFrom=this.value;if(_dashFrom&&_dashTo)renderDashboard('custom')">
              <span style="color:var(--muted);font-size:12px">→</span>
              <input type="date" id="dash-to" value="${_dashTo || d.dateTo || ''}" style="border:none;background:transparent;font-size:12px;color:var(--txt);outline:none;width:110px" onchange="_dashTo=this.value;if(_dashFrom&&_dashTo)renderDashboard('custom')">
              ${(_dashFrom&&_dashTo)?`<button onclick="_dashFrom='';_dashTo='';renderDashboard('${_dashPeriod}')" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:16px;line-height:1;padding:0 2px" title="Clear custom range">×</button>`:''}
            </div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px">
          <div style="background:#eff6ff;border-radius:var(--r);padding:14px;border-left:3px solid var(--blue)">
            <div class="stat-label">Total Orders</div>
            <div style="font-size:28px;font-weight:700;color:var(--blue);margin-top:4px">${d.orders.total}</div>
          </div>
          <div style="background:#fff7ed;border-radius:var(--r);padding:14px;border-left:3px solid var(--amber)">
            <div class="stat-label">Pending</div>
            <div style="font-size:28px;font-weight:700;color:var(--amber);margin-top:4px">${d.orders.pending}</div>
            <div style="font-size:10px;color:var(--muted)">Awaiting delivery</div>
          </div>
          <div style="background:#f0fdf4;border-radius:var(--r);padding:14px;border-left:3px solid #7c3aed">
            <div class="stat-label">Shipped</div>
            <div style="font-size:28px;font-weight:700;color:#7c3aed;margin-top:4px">${d.orders.shipped}</div>
          </div>
          <div style="background:#f0fdf4;border-radius:var(--r);padding:14px;border-left:3px solid var(--green)">
            <div class="stat-label">Delivered</div>
            <div style="font-size:28px;font-weight:700;color:var(--green);margin-top:4px">${d.orders.delivered}</div>
          </div>
        </div>
      </div>

      <!-- Inventory KPIs -->
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-bottom:18px">
        <div class="stat-card blue"><div class="stat-label">Total Inventory</div><div class="stat-value">${d.inventory.total}</div></div>
        <div class="stat-card green"><div class="stat-label">Tested</div><div class="stat-value">${d.inventory.tested}</div><div class="stat-sub">${d.inventory.total?Math.round(d.inventory.tested/d.inventory.total*100):0}% of stock</div></div>
        <div class="stat-card red"><div class="stat-label">Not Tested</div><div class="stat-value">${d.inventory.notTested}</div><div class="stat-sub">Needs testing</div></div>
        <div class="stat-card green"><div class="stat-label">Working Rate</div><div class="stat-value">${d.inventory.workingRate}%</div><div class="stat-sub">Of tested units</div></div>
        <div class="stat-card amber"><div class="stat-label">MDM Locked</div><div class="stat-value">${d.inventory.mdmRate}%</div><div class="stat-sub">Of tested units</div></div>
      </div>

      <!-- PO KPIs -->
      <div class="card" style="margin-bottom:18px">
        <div class="card-title">🗂 Purchase Orders</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px">
          <div style="text-align:center;padding:12px;background:#f8fafc;border-radius:var(--r)">
            <div class="stat-label">Total POs</div>
            <div style="font-size:26px;font-weight:700;color:var(--blue)">${d.po.total}</div>
          </div>
          <div style="text-align:center;padding:12px;background:#f8fafc;border-radius:var(--r)">
            <div class="stat-label">Units Ordered</div>
            <div style="font-size:26px;font-weight:700;color:var(--txt)">${d.po.unitsOrdered}</div>
          </div>
          <div style="text-align:center;padding:12px;background:#f0fdf4;border-radius:var(--r)">
            <div class="stat-label">Units Received</div>
            <div style="font-size:26px;font-weight:700;color:var(--green)">${d.po.unitsReceived}</div>
          </div>
          <div style="text-align:center;padding:12px;background:#fff7ed;border-radius:var(--r)">
            <div class="stat-label">SKUs Pending</div>
            <div style="font-size:26px;font-weight:700;color:var(--amber)">${d.po.skusPending}</div>
          </div>
          <div style="text-align:center;padding:12px;background:#eff6ff;border-radius:var(--r)">
            <div class="stat-label">Receive Rate</div>
            <div style="font-size:26px;font-weight:700;color:var(--blue)">${d.po.receiveRate}%</div>
            ${pctBar(d.po.receiveRate, 100, 'var(--green)')}
          </div>
        </div>
      </div>

      <!-- 4 panel grid -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px">
        <div class="card">
          <div class="card-title">📅 Inventory by Month</div>
          ${monthRows}
          <div style="margin-top:10px;text-align:right"><button class="btn btn-outline btn-sm" onclick="nav('inventory')">View All →</button></div>
        </div>
        <div class="card">
          <div class="card-title">🏭 Total Devices by Vendor</div>
          ${vendorRows}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px">
        <div class="card">
          <div class="card-title">📱 Device by Type</div>
          ${typeRows}
        </div>
        <div class="card">
          <div class="card-title">🎯 Cosmetic Grade Distribution</div>
          ${gradeRows}
          <div style="margin-top:10px;font-size:11px;color:var(--muted)">Based on ${d.inventory.tested} tested items</div>
        </div>
      </div>

      <!-- Not Tested -->
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div class="card-title" style="margin-bottom:0">⚠ Devices Not Tested Yet <span class="badge badge-fail" style="margin-left:6px">${d.inventory.notTested}</span></div>
          <button class="btn btn-primary btn-sm" onclick="nav('inventory')">Go to Inventory →</button>
        </div>
        <div class="table-wrap" style="box-shadow:none">
          <table class="table-compact">
            <thead><tr><th>Type</th><th>Model</th><th>Vendor</th><th>Serial No.</th><th>Period</th><th></th></tr></thead>
            <tbody>${notTestedRows}</tbody>
          </table>
        </div>
        ${d.inventory.notTested > 8 ? `<div style="padding:10px 0 0;text-align:center;font-size:12px;color:var(--muted)">Showing 8 of ${d.inventory.notTested} untested items</div>` : ''}
      </div>`;

  } catch(ex) {
    el.innerHTML += `<div class="alert alert-error">${ex.message}</div>`;
  }
}

function typeIcon(t) {
  const m = {iPhone:'📱',Smartphone:'📱',MacBook:'💻',Laptop:'💻',iPad:'⬜',Tablet:'⬜','Gaming Console':'🎮',Smartwatch:'⌚',Other:'📦'};
  return m[t] || '📦';
}

// ─── DAILY ORDERS ──────────────────────────────────────────────────────────
async function renderOrders() {
  const el = document.getElementById('screen-orders');
  el.innerHTML = `<div class="screen-header"><h2>Daily Orders</h2><p>Import orders, capture testing results and track delivery status</p></div><div style="text-align:center;padding:40px"><div class="loader"></div></div>`;
  await loadOrders();
}

// ─── Daily Orders bulk-select helpers ────────────────────────────────────────
function toggleOrderSelect(id, checked) {
  if (checked) S._ordSelected.add(id); else S._ordSelected.delete(id);
  updateOrderBulkBar();
}
function toggleAllOrders(checked) {
  document.querySelectorAll('.ord-chk').forEach(chk => {
    const id = parseInt(chk.dataset.id);
    chk.checked = checked;
    if (checked) S._ordSelected.add(id); else S._ordSelected.delete(id);
  });
  updateOrderBulkBar();
}
function clearOrderSelection() {
  S._ordSelected.clear();
  document.querySelectorAll('.ord-chk').forEach(c => c.checked = false);
  const hdr = document.getElementById('ord-chk-all'); if (hdr) hdr.checked = false;
  updateOrderBulkBar();
}
function updateOrderBulkBar() {
  const bar = document.getElementById('ord-bulk-bar');
  const cnt = document.getElementById('ord-bulk-count');
  if (!bar) return;
  const n = S._ordSelected.size;
  if (n > 0) { bar.classList.remove('hidden'); if (cnt) cnt.textContent = `${n} order${n!==1?'s':''} selected`; }
  else bar.classList.add('hidden');
}
function restoreOrderCheckboxes() {
  S._ordSelected.forEach(id => {
    const chk = document.querySelector(`.ord-chk[data-id="${id}"]`);
    if (chk) chk.checked = true;
  });
  const allChks = document.querySelectorAll('.ord-chk');
  const hdr = document.getElementById('ord-chk-all');
  if (hdr && allChks.length > 0) hdr.checked = [...allChks].every(c => c.checked);
  updateOrderBulkBar();
}
async function deleteSelectedOrders() {
  const ids = [...S._ordSelected];
  if (!ids.length) return;
  if (!confirm(`Permanently delete ${ids.length} order${ids.length!==1?'s':''}?\n\nThis cannot be undone.`)) return;
  try {
    const r = await api('POST', '/api/orders/bulk-delete', { ids });
    showToast(`✓ Deleted ${r.deleted} order${r.deleted!==1?'s':''}`);
    S._ordSelected.clear();
    await loadOrders();
  } catch(ex) { showToast(ex.message, 'error'); }
}

async function loadOrders() {
  const el = document.getElementById('screen-orders');
  try {
    const p = new URLSearchParams();
    if (S.oFilters.date) p.set('date', S.oFilters.date);
    if (S.oFilters.source) p.set('source', S.oFilters.source);
    if (S.oFilters.search) p.set('search', S.oFilters.search);
    if (S.oFilters.delivery) p.set('delivery', S.oFilters.delivery);
    const d = await api('GET', '/api/orders?' + p);
    S.orders = d;

    // ── Device type tabs (client-side) ────────────────────────────────────────
    if (!S._oTypeTab) S._oTypeTab = 'all';
    const typeIcons = { iPhone:'📱', iPad:'📱', MacBook:'💻', Samsung:'📱', Laptop:'💻', Tablet:'📱', Smartphone:'📱', 'Gaming Console':'🎮', Smartwatch:'⌚', Other:'📦' };
    const typeCounts = { all: d.orders.length };
    // Use o.device_type from daily_orders (set at import time from item name/SKU) — always populated
    d.orders.forEach(o => { const t = o.device_type || 'Other'; typeCounts[t] = (typeCounts[t]||0)+1; });
    const typeOrder = ['iPhone','iPad','MacBook','Samsung','Laptop','Tablet','Smartphone','Gaming Console','Smartwatch','Other'];
    const presentTypes = typeOrder.filter(t => typeCounts[t]);
    const typeTabs = [`<button class="inv-tab ${S._oTypeTab==='all'?'active':''}" onclick="S._oTypeTab='all';loadOrders()">All <span class="tab-count">${typeCounts.all}</span></button>`]
      .concat(presentTypes.map(t =>
        `<button class="inv-tab ${S._oTypeTab===t?'active':''}" onclick="S._oTypeTab='${t}';loadOrders()">${typeIcons[t]||'📦'} ${t} <span class="tab-count">${typeCounts[t]}</span></button>`
      )).join('');

    // Filter by device_type stored on the order row itself (not from order_testing)
    const filteredOrders = S._oTypeTab === 'all' ? d.orders : d.orders.filter(o => (o.device_type||'Other') === S._oTypeTab);

    const dateOpts = d.dates.map(x => `<option value="${x}" ${S.oFilters.date===x?'selected':''}>${x}</option>`).join('');
    const srcOpts = d.sources.map(x => `<option value="${x}" ${S.oFilters.source===x?'selected':''}>${esc(x)}</option>`).join('');

    const rows = filteredOrders.map(o => {
      const hasTesting = !!o.test_id;
      const overallStatusMap = {'Tested Working':'pass','Not Working':'fail','Partial Working':'ready','On Hold':'pending','Other':'na','Not Tested':'not-tested'};
      const overallBadge = o.overall_status && o.overall_status !== 'Not Tested'
        ? `<span class="badge badge-${overallStatusMap[o.overall_status]||'na'}">${o.overall_status}</span>`
        : (hasTesting ? '<span class="badge badge-not-tested">Tested</span>' : '<span class="badge badge-not-tested">Not Tested</span>');
      const snHtml = o.serial_no
        ? `<span class="mono fw600" style="color:var(--txt)">${esc(o.serial_no)}</span>`
        : `<span style="color:var(--muted);font-style:italic;font-size:12px">— click to add —</span>`;
      const shippingPaidHtml = o.shipping_paid > 0
        ? `<span style="color:var(--green,#16a34a);font-weight:600">$${Number(o.shipping_paid).toFixed(2)}</span>`
        : `<span style="color:var(--muted)">—</span>`;
      return `
        <tr>
          ${S.user.role==='admin'?`<td class="inv-chk-wrap"><input type="checkbox" class="ord-chk inv-chk" data-id="${o.id}" onchange="toggleOrderSelect(${o.id},this.checked)"></td>`:''}
          <td><span class="tag">${esc(o.source)}</span></td>
          <td class="mono" style="font-size:12px">${esc(o.order_id)}</td>
          <td id="sn-cell-${o.id}" onclick="editSerialNo(${o.id},'${(o.serial_no||'').replace(/'/g,"\\'")}',this)"
              style="cursor:pointer;min-width:130px" title="Click to edit Serial No.">
            ${snHtml}
            <svg style="width:11px;height:11px;opacity:.4;margin-left:4px;vertical-align:middle" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(o.item_name)}">${esc(o.item_name)}</td>
          <td><span class="mono" style="font-size:11px;background:var(--surface2,#f1f5f9);padding:2px 6px;border-radius:4px;white-space:nowrap">${esc(o.item_sku||'—')}</span></td>
          <td style="font-size:12px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(o.inv_model||o.inv_full_config||'')}"><span style="color:${o.inv_model?'var(--txt)':'var(--muted)'}">${esc(o.inv_model||'—')}</span></td>
          <td style="font-size:12px">${o.inv_processor?`<span class="tag" style="font-size:11px;background:#ede9fe;color:#6d28d9;border-color:#c4b5fd">⚙ ${esc(o.inv_processor)}</span>`:`<span style="color:var(--muted)">—</span>`}</td>
          <td style="font-size:12px;text-align:center">${o.inv_ram?`<span class="tag" style="font-size:11px">🧠 ${esc(o.inv_ram)}</span>`:`<span style="color:var(--muted)">—</span>`}</td>
          <td style="font-size:12px;text-align:center">${o.inv_storage?`<span class="tag" style="font-size:11px">💾 ${esc(o.inv_storage)}</span>`:`<span style="color:var(--muted)">—</span>`}</td>
          <td style="font-size:12px">${o.inv_color?`<span style="white-space:nowrap">${esc(o.inv_color)}</span>`:`<span style="color:var(--muted)">—</span>`}</td>
          <td style="text-align:center">${o.inv_grade?gradeBadge(o.inv_grade):`<span style="color:var(--muted)">—</span>`}</td>
          <td style="text-align:center;font-weight:600">${o.qty||1}</td>
          <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(o.recipient)}">${esc(o.recipient||'—')}</td>
          <td>${shippingPaidHtml}</td>
          <td>${fmtDate(o.order_date)}</td>
          <td><span class="badge badge-shipped" title="Ship date">${fmtDate(o.import_date)}</span></td>
          <td>${overallBadge}</td>
          <td>${deliveryBadge(o.delivery_status)}</td>
          <td style="max-width:180px" title="${esc(o.notes||'')}">
            ${o.notes ? `<span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--txt-secondary,#64748b)">${esc(o.notes)}</span>` : `<span style="color:var(--muted);font-size:12px">—</span>`}
          </td>
          <td>
            <div style="display:flex;gap:4px">
              <button class="btn btn-primary btn-sm btn-icon" title="Test / Update" onclick="openOrderTesting(${o.id})">
                <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              ${S.user.role==='admin' ? `<button class="btn btn-danger btn-sm btn-icon" title="Delete" onclick="deleteOrder(${o.id})"><svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>` : ''}
            </div>
          </td>
        </tr>`;
    }).join('') || `<tr><td colspan="${S.user.role==='admin'?21:20}"><div class="empty-state"><p>No orders found. Import from Excel or ShipStation to get started.</p></div></td></tr>`;

    el.innerHTML = `
      <div class="screen-header"><h2>Daily Orders</h2><p>${d.total} total orders · click any Serial No. cell to enter/edit it</p></div>
      <div class="inv-type-tabs">${typeTabs}</div>
      <div class="toolbar" style="margin-top:0">
        <div class="toolbar-left">
          <input class="search-input" type="text" placeholder="Search serial, order ID, item, SKU…" value="${esc(S.oFilters.search)}" oninput="S.oFilters.search=this.value" onkeydown="if(event.key==='Enter')loadOrders()">
          <input type="date" title="Filter by Ship Date" value="${S.oFilters.date}" onchange="S.oFilters.date=this.value;loadOrders()" style="padding:7px 10px;border:1.5px solid var(--border);border-radius:var(--r);font-size:13px;color:${S.oFilters.date?'var(--txt)':'var(--muted)'}">
          <select onchange="S.oFilters.source=this.value;loadOrders()">
            <option value="">All Sources</option>${srcOpts}
          </select>
          <select onchange="S.oFilters.delivery=this.value;loadOrders()">
            <option value="" ${!S.oFilters.delivery?'selected':''}>All Delivery</option>
            <option value="Pending" ${S.oFilters.delivery==='Pending'?'selected':''}>Pending</option>
            <option value="Ready to Ship" ${S.oFilters.delivery==='Ready to Ship'?'selected':''}>Ready to Ship</option>
            <option value="Shipped" ${S.oFilters.delivery==='Shipped'?'selected':''}>Shipped</option>
            <option value="Delivered" ${S.oFilters.delivery==='Delivered'?'selected':''}>Delivered</option>
            <option value="Returned" ${S.oFilters.delivery==='Returned'?'selected':''}>Returned</option>
            <option value="Cancelled" ${S.oFilters.delivery==='Cancelled'?'selected':''}>Cancelled</option>
          </select>
          <button class="btn btn-outline btn-sm" onclick="S.oFilters={date:'',source:'',search:'',delivery:''};S._oTypeTab='all';loadOrders()">Clear</button>
        </div>
        <div class="toolbar-right">
          <button class="btn btn-outline" style="border-color:var(--purple);color:var(--purple)" onclick="openScanModal()">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/><line x1="7" y1="12" x2="7" y2="12.01"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="17" y1="12" x2="17" y2="12.01"/></svg>
            Scan Barcode
          </button>
          <button class="btn btn-outline" onclick="showShipStationModal()">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            ShipStation
          </button>
          <button class="btn btn-success" onclick="showManualOrderModal()">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New Manual Order
          </button>
          <button class="btn btn-primary" onclick="showImportOrders()">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Import Excel
          </button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            ${S.user.role==='admin'?`<th class="inv-chk-wrap"><input type="checkbox" class="inv-chk" id="ord-chk-all" title="Select all" onchange="toggleAllOrders(this.checked)"></th>`:''}
            <th>Source</th><th>Order ID</th><th>Serial No. ✏</th><th>Item</th><th>SKU</th><th>Model</th><th>Processor</th><th>RAM</th><th>Storage (SSD)</th><th>Color</th><th>Grade</th><th style="text-align:center">Qty</th><th>Recipient</th><th>Ship Paid</th><th>Order Date</th><th>Ship Date</th><th>Test Status</th><th>Delivery</th><th>Notes</th><th>Actions</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="table-foot"><span>Showing ${filteredOrders.length} of ${d.total}</span></div>
      </div>
      ${S.user.role==='admin'?`
      <div id="ord-bulk-bar" class="inv-bulk-bar hidden">
        <span class="bulk-count" id="ord-bulk-count">0 orders selected</span>
        <button class="bulk-clr" onclick="clearOrderSelection()">✕ Clear</button>
        <button class="bulk-del" onclick="deleteSelectedOrders()">
          <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M5 6l1-3h12l1 3"/></svg>
          Delete Selected
        </button>
      </div>`:''}`;
    restoreOrderCheckboxes();
  } catch(ex) {
    el.innerHTML += `<div class="alert alert-error">${ex.message}</div>`;
  }
}

function showImportOrders() {
  const today = new Date().toISOString().split('T')[0];
  openModal(`
    <div class="modal-header">
      <h3>Import Daily Orders (Excel)</h3>
      <button class="modal-close" onclick="closeModal()"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="modal-body">
      <div class="alert alert-success" style="margin-bottom:16px">
        <strong>Expected columns:</strong> Source, Serial No., Order ID, Order Date, Item SKU, Item Name, Recipient, Qty, Price
      </div>
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label>Ship Date (Date to be shipped) *</label>
          <input type="date" id="orders-ship-date" value="${today}" style="width:100%">
          <div style="font-size:11px;color:var(--muted);margin-top:4px">All imported orders will be tagged with this date</div>
        </div>
        <div class="form-group">
          <label>Select Excel File (.xlsx) *</label>
          <input type="file" id="orders-file" accept=".xlsx,.xls" style="width:100%">
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="doImportOrders()">Import</button>
    </div>`);
}

async function doImportOrders() {
  const file = document.getElementById('orders-file').files[0];
  const shipDate = document.getElementById('orders-ship-date').value;
  if (!file) { showToast('Please select a file', 'error'); return; }
  if (!shipDate) { showToast('Please select a ship date', 'error'); return; }
  const fd = new FormData(); fd.append('file', file); fd.append('ship_date', shipDate);
  try {
    const r = await api('POST', '/api/orders/import', fd, true);
    showToast(`✓ Imported ${r.imported} orders for ${shipDate}`);
    closeModal(); loadOrders();
  } catch(ex) { showToast(ex.message, 'error'); }
}

function showManualOrderModal() {
  const today = new Date().toISOString().split('T')[0];
  const closeX = `<button class="modal-close" onclick="closeModal()"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
  openModal(`
    <div class="modal-header"><h3>New Manual Order</h3>${closeX}</div>
    <div class="modal-body">
      <div class="alert alert-success" style="margin-bottom:16px;font-size:12px">
        If you enter a <strong>Serial No.</strong> or <strong>SKU</strong>, the matching inventory item will automatically be marked as sold and quantity reduced.
      </div>
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label>Order Date *</label>
          <input type="date" id="mo-date" value="${today}">
        </div>
        <div class="form-group">
          <label>Order ID / Reference</label>
          <input type="text" id="mo-order-id" placeholder="e.g. ORD-1234">
        </div>
        <div class="form-group">
          <label>Item Name *</label>
          <input type="text" id="mo-item-name" placeholder="e.g. iPhone 15 Pro 256GB Black">
        </div>
        <div class="form-group">
          <label>Item SKU</label>
          <input type="text" id="mo-sku" placeholder="e.g. IPH15PRO-256-BLK-A" style="font-family:monospace">
        </div>
        <div class="form-group">
          <label>Serial No. / IMEI</label>
          <input type="text" id="mo-serial" placeholder="Enter to auto-deduct inventory" style="font-family:monospace" onblur="checkSerialDuplicate(this)">
        </div>
        <div class="form-group">
          <label>Recipient</label>
          <input type="text" id="mo-recipient" placeholder="Customer name">
        </div>
        <div class="form-group">
          <label>Sale Price ($)</label>
          <input type="number" id="mo-price" placeholder="0.00" min="0" step="0.01">
        </div>
        <div class="form-group">
          <label>Qty</label>
          <input type="number" id="mo-qty" value="1" min="1">
        </div>
        <div class="form-group">
          <label>Delivery Status</label>
          <select id="mo-status">
            ${['Pending','Ready to Ship','Shipped','Delivered','Returned','Cancelled'].map(s=>`<option value="${s}">${s}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-success" onclick="doCreateManualOrder()">Create Order</button>
    </div>`);
}

function checkSerialDuplicate(input) {
  const val = input.value.trim();
  if (!val) return;
  const dup = (S.orders?.list||[]).find(o => o.serial_no && o.serial_no.toLowerCase() === val.toLowerCase());
  if (dup) {
    input.style.borderColor = '#f59e0b';
    input.style.background = '#fffbeb';
    showToast(`⚠ Serial ${val} already used on order #${dup.order_id}`, 'error');
  } else {
    input.style.borderColor = '';
    input.style.background = '';
  }
}

async function doCreateManualOrder() {
  const item_name = document.getElementById('mo-item-name').value.trim();
  if (!item_name) { showToast('Item name is required', 'error'); return; }
  const serial_no_val = document.getElementById('mo-serial').value.trim();
  if (serial_no_val) {
    const dup = (S.orders?.list||[]).find(o => o.serial_no && o.serial_no.toLowerCase() === serial_no_val.toLowerCase());
    if (dup) showToast(`⚠ Serial ${serial_no_val} already used on order #${dup.order_id}`, 'error');
  }
  const body = {
    order_date:  document.getElementById('mo-date').value,
    order_id:    document.getElementById('mo-order-id').value.trim() || null,
    item_name,
    item_sku:    document.getElementById('mo-sku').value.trim() || null,
    serial_no:        document.getElementById('mo-serial').value.trim() || null,
    recipient:        document.getElementById('mo-recipient').value.trim() || null,
    price:            parseFloat(document.getElementById('mo-price').value) || 0,
    qty:              parseInt(document.getElementById('mo-qty').value) || 1,
    delivery_status:  document.getElementById('mo-status')?.value || 'Pending',
  };
  try {
    const r = await api('POST', '/api/orders/manual', body);
    const inv = r.inventory_deducted ? ' · ✓ Inventory deducted' : '';
    showToast(`✓ Order created${inv}`);
    closeModal();
    loadOrders();
  } catch(ex) { showToast(ex.message, 'error'); }
}

// ─── ShipStation Modal ────────────────────────────────────────────────────
async function showShipStationModal() {
  const today = new Date().toISOString().split('T')[0];
  let saved = { apiKey: '', hasSecret: false };
  try { saved = await api('GET', '/api/settings/shipstation'); } catch {}
  openModal(`
    <div class="modal-header">
      <h3>Import from ShipStation</h3>
      <button class="modal-close" onclick="closeModal()"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="modal-body">
      <div class="form-section">
        <div class="form-section-title">API Credentials</div>
        <div class="form-grid form-grid-2">
          <div class="form-group">
            <label>API Key</label>
            <input type="text" id="ss-key" value="${esc(saved.apiKey)}" placeholder="ShipStation API Key">
          </div>
          <div class="form-group">
            <label>API Secret</label>
            <input type="password" id="ss-secret" placeholder="${saved.hasSecret ? '●●●●●●●● (stored)' : 'ShipStation API Secret'}">
          </div>
        </div>
        <div class="form-group">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;text-transform:none;font-weight:400">
            <input type="checkbox" id="ss-save" ${saved.apiKey ? 'checked' : ''}> Save credentials for future imports
          </label>
        </div>
      </div>
      <div class="form-section">
        <div class="form-section-title">Fetch Options</div>
        <div class="form-grid form-grid-2">
          <div class="form-group">
            <label>Ship Date *</label>
            <input type="date" id="ss-date" value="${today}">
            <div style="font-size:11px;color:var(--muted);margin-top:4px">Fetches orders created on this date</div>
          </div>
          <div class="form-group">
            <label>Order Status</label>
            <select id="ss-status">
              <option value="awaiting_shipment">Awaiting Shipment</option>
              <option value="awaiting_payment">Awaiting Payment</option>
              <option value="on_hold">On Hold</option>
              <option value="shipped">Shipped</option>
              <option value="">All Statuses</option>
            </select>
          </div>
        </div>
      </div>
      <div id="ss-result" style="display:none"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="ss-btn" onclick="doShipStationImport()">Fetch & Import</button>
    </div>`);
}

async function doShipStationImport() {
  const apiKey = document.getElementById('ss-key').value.trim();
  const apiSecret = document.getElementById('ss-secret').value.trim();
  const ship_date = document.getElementById('ss-date').value;
  const orderStatus = document.getElementById('ss-status').value;
  const saveCredentials = document.getElementById('ss-save').checked;
  const resultEl = document.getElementById('ss-result');
  const btn = document.getElementById('ss-btn');

  if (!apiKey) { showToast('API Key is required', 'error'); return; }
  if (!ship_date) { showToast('Please select a date', 'error'); return; }

  btn.textContent = 'Fetching…'; btn.disabled = true;
  resultEl.style.display = 'none';
  try {
    const r = await api('POST', '/api/orders/shipstation', { apiKey, apiSecret: apiSecret || undefined, ship_date, orderStatus, saveCredentials });
    resultEl.style.display = 'block';
    resultEl.innerHTML = `<div class="alert alert-success">✓ Found ${r.ordersFound} orders, imported ${r.imported} line items for ${ship_date}.<br><small>Serial numbers are blank — click each row in the table to enter them.</small></div>`;
    btn.textContent = 'Done'; btn.disabled = false;
    loadOrders();
  } catch(ex) {
    resultEl.style.display = 'block';
    resultEl.innerHTML = `<div class="alert alert-error">${ex.message}</div>`;
    btn.textContent = 'Fetch & Import'; btn.disabled = false;
  }
}

// ─── Inline Serial No. Edit ───────────────────────────────────────────────
function editSerialNo(orderId, currentVal, cell) {
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = currentVal || '';
  inp.placeholder = 'Enter serial number…';
  inp.style.cssText = 'width:100%;padding:4px 8px;border:2px solid var(--blue);border-radius:5px;font-family:\'SF Mono\',Menlo,monospace;font-size:12px;font-weight:600;outline:none;min-width:160px';
  inp.onclick = e => e.stopPropagation();

  const restore = (val) => {
    const snHtml = val
      ? `<span class="mono fw600" style="color:var(--txt)">${esc(val)}</span>`
      : `<span style="color:var(--muted);font-style:italic;font-size:12px">— click to add —</span>`;
    cell.innerHTML = snHtml + `<svg style="width:11px;height:11px;opacity:.4;margin-left:4px;vertical-align:middle" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  };

  const save = async () => {
    const newVal = inp.value.trim();
    if (newVal === currentVal) { restore(currentVal); return; }
    try {
      await api('PUT', `/api/orders/${orderId}`, { serial_no: newVal });
      restore(newVal);
      showToast('S/N updated');
    } catch(ex) { showToast(ex.message, 'error'); restore(currentVal); }
  };

  inp.addEventListener('blur', save);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') inp.blur();
    if (e.key === 'Escape') { inp.removeEventListener('blur', save); restore(currentVal); }
  });

  cell.innerHTML = '';
  cell.appendChild(inp);
  inp.focus(); inp.select();
}

async function deleteOrder(id) {
  if (!confirm('Delete this order?')) return;
  try { await api('DELETE', '/api/orders/' + id); showToast('Order deleted'); loadOrders(); }
  catch(ex) { showToast(ex.message, 'error'); }
}

// ─── Barcode Scanner ──────────────────────────────────────────────────────────
let _scanResult = null; // holds looked-up inventory item

function openScanModal() {
  const closeX = `<button class="modal-close" onclick="closeModal()"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
  _scanResult = null;
  openModal(`
    <div class="modal-header">
      <div>
        <h3>Scan Device Barcode</h3>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">Scan label or type serial / IMEI / SKU to find the inventory item</div>
      </div>
      ${closeX}
    </div>
    <div class="modal-body">

      <!-- Scanner input -->
      <div style="position:relative;margin-bottom:16px">
        <div style="position:absolute;left:12px;top:50%;transform:translateY(-50%);pointer-events:none">
          <svg width="18" height="18" fill="none" stroke="var(--muted)" viewBox="0 0 24 24" stroke-width="2"><path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/><line x1="7" y1="12" x2="7" y2="12.01"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="17" y1="12" x2="17" y2="12.01"/></svg>
        </div>
        <input type="text" id="scan-input"
          placeholder="Scan barcode or type serial / IMEI / SKU…"
          style="width:100%;padding:12px 12px 12px 42px;font-size:15px;border:2px solid var(--purple);border-radius:var(--r);font-family:monospace;outline:none"
          onkeydown="if(event.key==='Enter')doScanLookup()"
          oninput="document.getElementById('scan-result-area').innerHTML=''"
          autocomplete="off" autocorrect="off" spellcheck="false">
        <button class="btn btn-primary btn-sm" onclick="doScanLookup()"
          style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:var(--purple);border-color:var(--purple)">
          Look Up
        </button>
      </div>

      <!-- Result area -->
      <div id="scan-result-area"></div>

      <!-- Order assignment area -->
      <div id="scan-order-area"></div>

    </div>
    <div class="modal-footer" id="scan-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>`);

  setTimeout(() => document.getElementById('scan-input')?.focus(), 80);
}

async function doScanLookup() {
  const val = document.getElementById('scan-input')?.value?.trim();
  if (!val) return;
  const resultArea = document.getElementById('scan-result-area');
  resultArea.innerHTML = `<div style="text-align:center;padding:20px"><div class="loader"></div></div>`;
  document.getElementById('scan-order-area').innerHTML = '';
  document.getElementById('scan-footer').innerHTML = `<button class="btn btn-outline" onclick="closeModal()">Cancel</button>`;

  try {
    _scanResult = await api('GET', `/api/inventory/scan?q=${encodeURIComponent(val)}`);
    const inv = _scanResult;
    const grade = inv.overall_grade || inv.tested_grade || inv.grade || '—';
    const gradeColor = { 'A+':'#15803d', A:'#22c55e', 'B+':'#0ea5e9', B:'#3b82f6', C:'#f59e0b', 'D-Fixable':'#f97316', 'D-Parts':'#ef4444', 'S-Scrap':'#7f1d1d' }[grade] || 'var(--muted)';
    const serial = inv.serial_number || inv.imei || '—';

    resultArea.innerHTML = `
      <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:var(--r);padding:14px;margin-bottom:16px">
        <div style="font-size:11px;font-weight:700;color:var(--green);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">✓ Device Found in Inventory</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div><div class="stat-label">Model</div><div style="font-weight:600;font-size:13px">${esc(inv.model||inv.device_type||'—')}</div></div>
          <div><div class="stat-label">Serial / IMEI</div><div style="font-weight:700;font-family:monospace;font-size:13px;color:var(--blue)">${esc(serial)}</div></div>
          <div><div class="stat-label">SKU</div><div style="font-size:12px;font-family:monospace">${esc(inv.sku||'—')}</div></div>
          <div><div class="stat-label">Grade</div><div style="font-weight:700;color:${gradeColor}">${grade}</div></div>
          <div><div class="stat-label">Specs</div><div style="font-size:12px">${[inv.color,inv.storage,inv.ram].filter(Boolean).join(' · ')||'—'}</div></div>
          <div><div class="stat-label">Vendor / Period</div><div style="font-size:12px">${esc(inv.vendor||'—')} · ${esc(inv.month||'')} ${inv.year||''}</div></div>
        </div>
      </div>`;

    // ── Block if already sold ─────────────────────────────────────────────
    if (inv.status === 'sold') {
      const soldInfo = inv.sold_to_order_ref
        ? `Order <strong>#${esc(inv.sold_to_order_ref)}</strong>${inv.sold_date ? ` on ${fmtDate(inv.sold_date)}` : ''}`
        : 'a previous order';
      document.getElementById('scan-order-area').innerHTML = `
        <div style="background:#fff7ed;border:1.5px solid #fed7aa;border-radius:var(--r);padding:14px;display:flex;gap:12px;align-items:flex-start;margin-top:12px">
          <svg width="22" height="22" fill="none" stroke="#ea580c" viewBox="0 0 24 24" stroke-width="2" style="flex-shrink:0;margin-top:1px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <div>
            <div style="font-weight:700;color:#9a3412;font-size:13px">Device Already Sold</div>
            <div style="font-size:12px;color:#c2410c;margin-top:3px">
              Serial <strong>${esc(serial)}</strong> has already been assigned to ${soldInfo}.<br>
              Cannot assign to another order.
            </div>
          </div>
        </div>`;
      document.getElementById('scan-footer').innerHTML = `<button class="btn btn-outline" onclick="closeModal()">Close</button>`;
      return;
    }

    // Load pending orders for assignment
    await loadOrdersForScan(serial);

  } catch(ex) {
    _scanResult = null;
    resultArea.innerHTML = `
      <div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:var(--r);padding:14px;display:flex;gap:10px;align-items:center">
        <svg width="20" height="20" fill="none" stroke="var(--red)" viewBox="0 0 24 24" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        <div>
          <div style="font-weight:600;color:var(--red)">Not Found</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(ex.message)}</div>
        </div>
      </div>`;
  }
}

async function loadOrdersForScan(serial) {
  const orderArea = document.getElementById('scan-order-area');
  orderArea.innerHTML = `<div style="text-align:center;padding:12px"><div class="loader"></div></div>`;
  try {
    const d = await api('GET', '/api/orders?limit=200');
    // Only show orders that have NO serial yet (available for assignment)
    const available = d.orders.filter(o => !o.serial_no);
    // Also show orders that already have THIS serial (already assigned — show as done)
    const alreadyThisSerial = d.orders.filter(o => o.serial_no === serial);

    if (alreadyThisSerial.length) {
      orderArea.innerHTML = `
        <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:var(--r);padding:14px;display:flex;gap:12px;align-items:center;margin-top:10px">
          <svg width="20" height="20" fill="none" stroke="#16a34a" viewBox="0 0 24 24" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          <div>
            <div style="font-weight:700;color:#15803d">Already Assigned</div>
            <div style="font-size:12px;color:#166534;margin-top:2px">
              Serial <strong>${esc(serial)}</strong> is already linked to order <strong>#${esc(alreadyThisSerial[0].order_id)}</strong>.
            </div>
          </div>
        </div>`;
      document.getElementById('scan-footer').innerHTML = `<button class="btn btn-outline" onclick="closeModal()">Close</button>`;
      return;
    }

    if (!available.length) {
      orderArea.innerHTML = `
        <div style="text-align:center;color:var(--muted);padding:16px;font-size:13px">
          No open orders without a serial number.<br>All orders already have serials assigned.
        </div>`;
      document.getElementById('scan-footer').innerHTML = `<button class="btn btn-outline" onclick="closeModal()">Close</button>`;
      return;
    }

    const safeSerial = serial.replace(/'/g, "\\'");
    const rows = available.map(o => `
      <tr id="scan-order-row-${o.id}" style="cursor:pointer" onclick="assignScanToOrder(${o.id},'${safeSerial}')">
        <td><span class="tag" style="font-size:11px">${esc(o.source)}</span></td>
        <td><strong class="mono" style="font-size:12px">${esc(o.order_id)}</strong></td>
        <td><div style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">${esc(o.item_name)}</div></td>
        <td style="font-size:11px;color:var(--muted)">${fmtDate(o.import_date)}</td>
        <td>
          <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();assignScanToOrder(${o.id},'${safeSerial}')">
            Assign
          </button>
        </td>
      </tr>`).join('');

    orderArea.innerHTML = `
      <div style="margin-top:12px">
        <div style="font-size:12px;font-weight:600;color:var(--txt);margin-bottom:6px">
          Assign <span class="mono" style="color:var(--blue)">${esc(serial)}</span> to which order?
        </div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:8px">${available.length} open order${available.length!==1?'s':''} without a serial</div>
        <div id="scan-assign-error"></div>
        <div class="table-wrap" style="box-shadow:none;max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--r)">
          <table class="table-compact">
            <thead><tr><th>Source</th><th>Order ID</th><th>Item</th><th>Date</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;

    document.getElementById('scan-footer').innerHTML = `
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <div style="font-size:12px;color:var(--muted)">Click a row or Assign button to link serial</div>`;

  } catch(ex) {
    orderArea.innerHTML = `<div class="alert alert-error">${ex.message}</div>`;
  }
}

async function assignScanToOrder(orderId, serial) {
  // Disable the clicked row to prevent double-clicks
  const row = document.getElementById('scan-order-row-' + orderId);
  if (row) { row.style.opacity = '0.5'; row.style.pointerEvents = 'none'; }

  try {
    const result = await api('POST', `/api/orders/${orderId}/assign-serial`, { serial });
    const toastMsg = result.inventory_updated
      ? `✓ Serial assigned & inventory marked as sold`
      : `✓ Serial ${serial} assigned to order`;
    showToast(toastMsg);
    closeModal();
    loadOrders();
  } catch(ex) {
    // Re-enable the row on error
    if (row) { row.style.opacity = ''; row.style.pointerEvents = ''; }
    // Show inline error in the assign area
    const errEl = document.getElementById('scan-assign-error');
    if (errEl) {
      errEl.innerHTML = `
        <div style="background:#fef2f2;border:1.5px solid #fecaca;border-radius:var(--r);padding:10px 14px;display:flex;gap:10px;align-items:center;margin-bottom:10px">
          <svg width="18" height="18" fill="none" stroke="var(--red)" viewBox="0 0 24 24" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          <div style="font-weight:600;color:var(--red);font-size:12px">${esc(ex.message)}</div>
        </div>`;
    } else {
      showToast(ex.message, 'error');
    }
  }
}

// ─── Order Testing Modal ──────────────────────────────────────────────────
async function openOrderTesting(orderId) {
  const order = S.orders.orders.find(o => o.id === orderId);
  if (!order) return;
  const existing = await api('GET', `/api/orders/${orderId}/testing`).catch(() => null);
  const deviceType = existing?.device_type || detectDeviceType(order.item_name, order.item_sku);

  openModal(`
    <div class="modal-header">
      <div>
        <h3>Testing & Delivery — Order #${esc(order.order_id)}</h3>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(order.serial_no)} · ${esc(order.item_name)}</div>
      </div>
      <button class="modal-close" onclick="closeModal()"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="modal-body">
      <div class="form-section">
        <div class="form-section-title">Device Info</div>
        <div class="form-grid form-grid-2">
          <div class="form-group">
            <label>Device Type</label>
            <select id="t-device_type" onchange="refreshTestFields(${orderId}, 'order')">
              ${['iPhone','Smartphone','MacBook','Laptop','iPad','Gaming Console','Smartwatch','Other'].map(t=>`<option ${deviceType===t?'selected':''}>${t}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Cosmetic Grade</label>
            <select id="t-cosmetic_grade">
              <option value="">— Select —</option>
              ${['A','B','C','D','New'].map(g=>`<option ${existing?.cosmetic_grade===g?'selected':''}>${g}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
      <div class="form-section" id="test-fields-container"></div>
      <div class="form-section">
        <div class="form-section-title">Overall Result & Delivery</div>
        <div class="form-grid form-grid-2">
          <div class="form-group">
            <label>Overall Testing Status</label>
            <select id="t-overall_status">
              ${['Not Tested','Tested Working','Not Working','Partial Working','On Hold','Other'].map(s=>`<option ${(existing?.overall_status||'Not Tested')===s?'selected':''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Delivery Status</label>
            <select id="t-delivery_status">
              ${['Pending','Ready to Ship','Shipped','Delivered','Returned','Cancelled'].map(s=>`<option ${(existing?.delivery_status||'Pending')===s?'selected':''}>${s}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
      <div class="form-section">
        <div class="form-section-title">Additional Info</div>
        <div class="form-grid form-grid-3">
          <div class="form-group">
            <label>Tested By</label>
            <input type="text" id="t-tested_by" value="${esc(existing?.tested_by||S.user.username)}" placeholder="Your name">
          </div>
          <div class="form-group">
            <label>Test Date</label>
            <input type="date" id="t-test_date" value="${existing?.test_date||new Date().toISOString().split('T')[0]}">
          </div>
          <div class="form-group">
            <label>Battery Health %</label>
            <input type="number" id="t-battery_health" min="0" max="100" value="${existing?.battery_health||''}" placeholder="e.g. 87">
          </div>
        </div>
        <div class="form-group mt8">
          <label>Notes</label>
          <textarea id="t-notes" placeholder="Additional notes…">${esc(existing?.notes||'')}</textarea>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveOrderTesting(${orderId})">Save Results</button>
    </div>`);

  buildTestFields('test-fields-container', deviceType, existing, 'order');
}

function buildTestFields(containerId, deviceType, existing, kind) {
  const fields = getTestFields(deviceType);
  const html = `
    <div class="form-section-title">Test Results</div>
    <div class="test-grid">
      ${fields.map(f => `
        <div class="test-item">
          <label>${f.label}</label>
          <select id="t-${f.key}">
            ${['Not Tested','Pass','Fail','N/A'].map(v=>`<option ${(existing?.[f.key]||'Not Tested')===v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>`).join('')}
      ${deviceType==='MacBook'||deviceType==='Laptop' ? `
        <div class="test-item">
          <label>Battery Cycles</label>
          <input type="number" id="t-battery_cycles" value="${existing?.battery_cycles||''}" placeholder="e.g. 450" style="width:100%;padding:6px 8px;font-size:13px;border:1.5px solid var(--border);border-radius:6px">
        </div>` : ''}
    </div>`;
  document.getElementById(containerId).innerHTML = html;
}

function refreshTestFields(id, kind) {
  const dt = document.getElementById('t-device_type').value;
  buildTestFields('test-fields-container', dt, null, kind);
}

function getTestFields(deviceType) {
  const common = [
    {key:'lcd_test',label:'LCD / Display'},
    {key:'touch_test',label:'Touch Screen'},
    {key:'front_camera_test',label:'Front Camera'},
    {key:'rear_camera_test',label:'Rear Camera'},
    {key:'speaker_test',label:'Speaker'},
    {key:'mic_test',label:'Microphone'},
    {key:'wifi_test',label:'WiFi'},
    {key:'bluetooth_test',label:'Bluetooth'},
    {key:'charging_test',label:'Charging Port'},
  ];
  const phoneExtra = [{key:'cellular_test',label:'Cellular / SIM'},{key:'vibration_test',label:'Vibration'}];
  const macExtra = [{key:'keyboard_test',label:'Keyboard'},{key:'trackpad_test',label:'Trackpad'},{key:'usb_ports_test',label:'USB Ports'},{key:'hinge_test',label:'Hinge/Lid'}];

  if (deviceType === 'iPhone') return [...common, {key:'face_id_test',label:'Face ID / Touch ID'}, ...phoneExtra];
  if (deviceType === 'Smartphone') return [...common, {key:'fingerprint_test',label:'Fingerprint Sensor'}, ...phoneExtra];
  if (deviceType === 'iPad') return [...common, {key:'face_id_test',label:'Face ID / Home Button'},{key:'cellular_test',label:'Cellular / SIM'}];
  if (deviceType === 'MacBook') return [{key:'lcd_test',label:'LCD / Display'},{key:'keyboard_test',label:'Keyboard'},{key:'trackpad_test',label:'Trackpad'},{key:'wifi_test',label:'WiFi'},{key:'bluetooth_test',label:'Bluetooth'},{key:'charging_test',label:'Charging'},{key:'front_camera_test',label:'Camera'},{key:'speaker_test',label:'Speaker'},{key:'mic_test',label:'Microphone'},{key:'usb_ports_test',label:'USB Ports'},{key:'hinge_test',label:'Hinge/Lid'}];
  if (deviceType === 'Laptop') return [{key:'lcd_test',label:'LCD / Display'},{key:'keyboard_test',label:'Keyboard'},{key:'trackpad_test',label:'Trackpad'},{key:'wifi_test',label:'WiFi'},{key:'bluetooth_test',label:'Bluetooth'},{key:'charging_test',label:'Charging'},{key:'front_camera_test',label:'Webcam'},{key:'speaker_test',label:'Speaker'},{key:'mic_test',label:'Microphone'},{key:'usb_ports_test',label:'USB Ports'},{key:'hinge_test',label:'Hinge'}];
  return common;
}

async function saveOrderTesting(orderId) {
  const gv = id => { const el = document.getElementById(id); return el ? el.value : undefined; };
  const fields = getTestFields(gv('t-device_type'));
  const payload = { device_type: gv('t-device_type'), cosmetic_grade: gv('t-cosmetic_grade'), overall_status: gv('t-overall_status'), delivery_status: gv('t-delivery_status'), tested_by: gv('t-tested_by'), test_date: gv('t-test_date'), notes: gv('t-notes') };
  const bh = gv('t-battery_health'); if (bh) payload.battery_health = parseInt(bh);
  const bc = gv('t-battery_cycles'); if (bc) payload.battery_cycles = parseInt(bc);
  fields.forEach(f => { payload[f.key] = gv('t-' + f.key) || 'Not Tested'; });
  try {
    await api('POST', `/api/orders/${orderId}/testing`, payload);
    showToast('✓ Testing results saved'); closeModal(); loadOrders();
  } catch(ex) { showToast(ex.message, 'error'); }
}

// ─── INVENTORY ─────────────────────────────────────────────────────────────
async function renderInventory() {
  const el = document.getElementById('screen-inventory');
  el.innerHTML = `<div class="screen-header"><h2>Inventory</h2><p>Monthly inventory from vendors with detailed testing records</p></div><div style="text-align:center;padding:40px"><div class="loader"></div></div>`;
  await loadInventory();
}

// ─── Inventory bulk-select helpers ──────────────────────────────────────────
function toggleInvSelect(id, checked) {
  if (checked) S._invSelected.add(id); else S._invSelected.delete(id);
  updateInvBulkBar();
}
function toggleInvGroupSelect(gid, checked) {
  const body = document.getElementById('inv-card-body-' + gid);
  if (!body) return;
  body.querySelectorAll('.inv-chk').forEach(chk => {
    const id = parseInt(chk.dataset.id);
    chk.checked = checked;
    if (checked) S._invSelected.add(id); else S._invSelected.delete(id);
  });
  updateInvBulkBar();
}
function clearInvSelection() {
  S._invSelected.clear();
  document.querySelectorAll('.inv-chk').forEach(c => c.checked = false);
  document.querySelectorAll('[id^="inv-chk-grp-"]').forEach(c => c.checked = false);
  updateInvBulkBar();
}
function updateInvBulkBar() {
  const bar = document.getElementById('inv-bulk-bar');
  const cnt = document.getElementById('inv-bulk-count');
  if (!bar) return;
  const n = S._invSelected.size;
  if (n > 0) { bar.classList.remove('hidden'); if (cnt) cnt.textContent = `${n} item${n!==1?'s':''} selected`; }
  else bar.classList.add('hidden');
}
function restoreInvCheckboxes() {
  S._invSelected.forEach(id => {
    const chk = document.querySelector(`.inv-chk[data-id="${id}"]`);
    if (chk) chk.checked = true;
  });
  updateInvBulkBar();
}
async function deleteSelectedInventory() {
  const ids = [...S._invSelected];
  if (!ids.length) return;
  if (!confirm(`Permanently delete ${ids.length} item${ids.length!==1?'s':''}?\n\nThis cannot be undone.`)) return;
  try {
    const r = await api('POST', '/api/inventory/bulk-delete', { ids });
    showToast(`✓ Deleted ${r.deleted} item${r.deleted!==1?'s':''}`);
    S._invSelected.clear();
    await loadInventory();
  } catch(ex) { showToast(ex.message, 'error'); }
}

async function loadInventory() {
  const el = document.getElementById('screen-inventory');
  try {
    const p = new URLSearchParams();
    if (S.iFilters.month) p.set('month', S.iFilters.month);
    if (S.iFilters.year) p.set('year', S.iFilters.year);
    if (S.iFilters.vendor) p.set('vendor', S.iFilters.vendor);
    if (S.iFilters.device_type) p.set('device_type', S.iFilters.device_type);
    if (S.iFilters.lot_id) p.set('lot_id', S.iFilters.lot_id);
    if (S.iFilters.search) p.set('search', S.iFilters.search);
    p.set('limit', 10000);
    const d = await api('GET', '/api/inventory?' + p);
    S.inventory = d;

    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthOpts = months.map(m=>`<option value="${m}" ${S.iFilters.month===m?'selected':''}>${m}</option>`).join('');
    const vendorOpts = d.vendors.map(v=>`<option value="${v}" ${S.iFilters.vendor===v?'selected':''}>${esc(v)}</option>`).join('');
    const typeOpts = d.types.map(t=>`<option value="${t}" ${S.iFilters.device_type===t?'selected':''}>${t}</option>`).join('');

    // Final Cosmetic Grade (functional status) → badge class
    const finalGradeMap = { 'Working':'pass','Partial Working':'ready','Not Working':'fail','On Hold':'pending','Parts':'pending','Scrap':'fail' };
    // Overall Grade letter scale → hex color
    const cosC = { 'A+':'#15803d', A:'#22c55e', 'B+':'#0ea5e9', B:'#3b82f6', C:'#f59e0b', 'D-Fixable':'#f97316', 'D-Parts':'#ef4444', 'S-Scrap':'#7f1d1d' };
    const lockMap = v => {
      if (!v) return '—';
      const lo = v.toLowerCase();
      if (lo==='unlocked'||lo==='unlock') return `<span class="badge badge-pass" style="font-size:10px">Unlocked</span>`;
      return `<span class="badge badge-pending" style="font-size:10px">${esc(v)}</span>`;
    };

    // ── Type tab counts ──────────────────────────────────────────────────────
    if (!S._iTypeTab) S._iTypeTab = 'all';
    const typeCounts = { all: d.items.length };
    d.items.forEach(it => { const t = it.device_type||'Other'; typeCounts[t] = (typeCounts[t]||0)+1; });
    const typeOrder = ['iPhone','iPad','MacBook','Samsung','Laptop','Tablet','Smartphone','Gaming Console','Smartwatch','Other'];
    const presentTypes = typeOrder.filter(t => typeCounts[t]).concat(Object.keys(typeCounts).filter(t => t!=='all' && !typeOrder.includes(t) && typeCounts[t]));
    const typeTabIcons = { iPhone:'📱', iPad:'📱', MacBook:'💻', Samsung:'📱', Laptop:'💻', Tablet:'📱', Smartphone:'📱', 'Gaming Console':'🎮', Smartwatch:'⌚', Other:'📦' };

    // ── Filter items by active type tab ─────────────────────────────────────
    const displayItems = S._iTypeTab === 'all' ? d.items : d.items.filter(it => (it.device_type||'Other') === S._iTypeTab);

    // ── Group filtered items by model ───────────────────────────────────────
    const groupMap = {};
    displayItems.forEach(item => {
      const key = (item.model||'Unknown');
      if (!groupMap[key]) groupMap[key] = { type: item.device_type||'Unknown', model: item.model||'Unknown', items: [] };
      groupMap[key].items.push(item);
    });
    const safeId = k => k.replace(/[^a-zA-Z0-9]/g, '_');

    // ── Grade distribution bar + pills for a model group ────────────────────
    const gradeSummary = items => {
      const availItems = items.filter(it => it.status !== 'sold');
      const dist = {};
      availItems.forEach(it => { const g = it.overall_grade||it.cosmetic_grade||it.grade||it.condition_grade; if(g) dist[g]=(dist[g]||0)+1; });
      const untested = availItems.filter(it => !it.overall_grade && !it.cosmetic_grade && !it.grade && !it.condition_grade).length;
      const soldCount = items.filter(it => it.status === 'sold').length;
      const total = availItems.length;
      const gradeOrder = ['A+','A','B+','B','C','D-Fixable','D-Parts','S-Scrap'];
      const barSegs = gradeOrder.filter(g=>dist[g]).map(g => {
        const pct = Math.round(dist[g]/total*100);
        return `<div style="width:${pct}%;background:${cosC[g]};min-width:3px" title="Grade ${g}: ${dist[g]}"></div>`;
      }).join('');
      const untestedPct = untested ? Math.round(untested/total*100) : 0;
      const bar = `<div class="inv-grade-bar">${barSegs}${untestedPct?`<div style="width:${untestedPct}%;background:#d1d5db" title="Untested: ${untested}"></div>`:''}</div>`;
      const pills = gradeOrder.filter(g=>dist[g]).map(g =>
        `<span class="inv-grade-pill" style="background:${cosC[g]}18;color:${cosC[g]};border-color:${cosC[g]}44">Grade ${g} <strong>${dist[g]}</strong></span>`
      ).join('') + (untested ? `<span class="inv-grade-pill" style="background:#f1f5f9;color:#6b7280;border-color:#d1d5db">Untested <strong>${untested}</strong></span>` : '');
      const soldPill = soldCount ? `<span class="inv-grade-pill" style="background:#fef9c3;color:#854d0e;border-color:#fde047">Sold <strong>${soldCount}</strong></span>` : '';
      return bar + `<div class="inv-grade-pills">${pills}${soldPill}</div>`;
    };

    const testItems = [
      ['LCD/Display','lcd_test'],['Touch Screen','touch_test'],['Face ID / Home','face_id_test'],
      ['Fingerprint','fingerprint_test'],['Front Camera','front_camera_test'],['Rear Camera','rear_camera_test'],
      ['Speaker','speaker_test'],['Microphone','mic_test'],['WiFi','wifi_test'],
      ['Cellular','cellular_test'],['Bluetooth','bluetooth_test'],['Charging','charging_test'],
      ['Vibration','vibration_test'],['Keyboard','keyboard_test'],['Trackpad','trackpad_test'],
      ['USB Ports','usb_ports_test'],['Hinge/Lid','hinge_test']
    ];

    // ── Build model accordion cards ─────────────────────────────────────────
    let cardsHtml = '';
    if (displayItems.length === 0) {
      cardsHtml = `<div class="empty-state"><p>No inventory found for this filter.</p></div>`;
    } else {
      Object.entries(groupMap).forEach(([key, group]) => {
        const gid = safeId(key);
        let unitRows = '';
        group.items.forEach(item => {
          const hasTesting = !!item.test_id;
          const cosGrade = item.overall_grade || item.cosmetic_grade || item.grade || item.condition_grade;
          const cosColor = cosC[cosGrade] || '#9ca3af';
          const detailHtml = hasTesting ? `
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:14px">
              ${testItems.map(([label,k]) => {
                const v = item[k]; if (!v||v==='Not Tested') return '';
                const cls={Pass:'badge-pass',Fail:'badge-fail','N/A':'badge-na'}[v]||'badge-not-tested';
                return `<div style="background:#fff;border:1px solid var(--border);border-radius:6px;padding:8px"><div style="font-size:10px;font-weight:600;color:var(--muted);margin-bottom:4px">${label}</div><span class="badge ${cls}">${v}</span></div>`;
              }).join('')}
            </div>
            <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:12px;padding-top:10px;border-top:1px solid #c7d2fe">
              ${item.battery_health?`<div><span style="color:var(--muted)">Battery:</span> <strong>${item.battery_health}%</strong>${item.battery_cycles?` / ${item.battery_cycles} cycles`:''}</div>`:''}
              ${item.mdm_lock==='On'?`<div><span style="color:var(--muted)">MDM:</span> <span class="badge badge-fail">ON</span></div>`:''}
              ${item.d_grade_description?`<div><span style="color:var(--muted)">D Note:</span> <strong style="color:var(--red)">${esc(item.d_grade_description)}</strong></div>`:''}
              ${item.test_notes?`<div><span style="color:var(--muted)">Notes:</span> ${esc(item.test_notes)}</div>`:''}
            </div>` :
            `<div style="text-align:center;color:var(--muted);padding:12px;font-size:13px">No testing results yet — click ✏ to add.</div>`;

          unitRows += `
            <tr id="inv-row-${item.id}">
              ${S.user.role==='admin'?`<td class="inv-chk-wrap"><input type="checkbox" class="inv-chk" data-id="${item.id}" onchange="toggleInvSelect(${item.id},this.checked)"></td>`:''}
              <td style="min-width:100px">
                ${item.status==='sold'?`<span style="display:inline-block;background:#fef3c7;color:#92400e;border:1px solid #fcd34d;border-radius:4px;font-size:9px;font-weight:800;padding:1px 5px;letter-spacing:.04em;margin-bottom:3px">SOLD</span><br>`:''}
                <div style="font-size:11px;font-weight:600">${esc(item.vendor)}</div>
                <div style="color:var(--muted);font-size:10px">${esc(item.month)} ${item.year}</div>
                ${item.lot_id?`<div class="mono" style="font-size:10px;color:var(--blue)">${esc(item.lot_id)}</div>`:''}
                ${item.sku?`<div class="mono" style="font-size:10px;color:var(--muted)">${esc(item.sku)}</div>`:''}
              </td>
              <td style="min-width:120px">
                <div class="mono" style="font-size:11px;font-weight:600">${esc(item.serial_number||'—')}</div>
                ${item.imei?`<div class="mono" style="font-size:10px;color:var(--muted)">IMEI: ${esc(item.imei)}</div>`:''}
              </td>
              <td style="min-width:140px;font-size:11px">
                ${item.color?`<div style="font-weight:600;margin-bottom:3px">${esc(item.color)}</div>`:''}
                <div style="display:flex;gap:3px;flex-wrap:wrap">
                  ${item.storage?`<span class="tag" style="font-size:10px;padding:1px 5px" title="SSD/Storage">💾 ${esc(item.storage)}</span>`:''}
                  ${item.ram?`<span class="tag" style="font-size:10px;padding:1px 5px" title="RAM">🧠 ${esc(item.ram)}</span>`:''}
                  ${item.processor?`<span class="tag" style="font-size:10px;padding:1px 5px;background:#ede9fe;color:#6d28d9;border-color:#c4b5fd" title="Processor">⚙ ${esc(item.processor)}</span>`:''}
                  ${item.wifi_cellular?`<span class="tag" style="font-size:10px;padding:1px 5px">${esc(item.wifi_cellular)}</span>`:''}
                </div>
              </td>
              <td style="min-width:90px">
                ${lockMap(item.lock_status)}
                ${item.carrier&&item.carrier!==item.lock_status?`<div style="font-size:10px;color:var(--muted)">${esc(item.carrier)}</div>`:''}
                ${item.mdm_lock==='On'?`<span class="badge badge-fail" style="font-size:9px;margin-top:2px;display:inline-block">MDM ON</span>`:''}
              </td>
              <td style="text-align:center;min-width:70px">
                ${cosGrade
                  ? `<span style="display:inline-flex;align-items:center;justify-content:center;min-width:36px;padding:0 6px;height:30px;border-radius:7px;background:${cosColor}18;color:${cosColor};border:2px solid ${cosColor};font-size:12px;font-weight:800;white-space:nowrap">${cosGrade}</span>`
                  : `<span style="color:#cbd5e1;font-size:16px;font-weight:700">—</span>`}
              </td>
              <td style="min-width:110px">
                ${item.tested_grade
                  ? `<span class="badge badge-${finalGradeMap[item.tested_grade]||'na'}" style="font-size:10px">${item.tested_grade}</span>`
                  : (hasTesting?`<span class="badge badge-na" style="font-size:10px">—</span>`:`<span class="badge badge-not-tested" style="font-size:10px">Untested</span>`)}
                ${item.test_date?`<div style="font-size:10px;color:var(--muted);margin-top:2px">${fmtDate(item.test_date)}</div>`:''}
              </td>
              <td>
                <div style="display:flex;gap:3px;align-items:center">
                  <button id="inv-exp-${item.id}" class="btn btn-outline btn-sm btn-icon" onclick="toggleInvDetail(${item.id})" title="Test details" style="font-size:10px;padding:3px 6px">▶</button>
                  <button class="btn btn-outline btn-sm btn-icon" title="Print Label" onclick="showInventoryLabel(${item.id})" style="color:var(--purple);border-color:var(--purple)">
                    <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                  </button>
                  <button class="btn btn-sm btn-icon" title="Edit Specs" onclick="showEditInventoryItem(${item.id})" style="background:#dcfce7;color:#15803d;border:1px solid #86efac">
                    <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  </button>
                  <button class="btn btn-primary btn-sm btn-icon" title="Test/Update" onclick="openInventoryTesting(${item.id})">
                    <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  </button>
                  ${S.user.role==='admin'?`<button class="btn btn-danger btn-sm btn-icon" title="Delete" onclick="deleteInventory(${item.id})"><svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg></button>`:''}
                </div>
              </td>
            </tr>
            <tr id="inv-det-${item.id}" style="display:none">
              <td colspan="${S.user.role==='admin'?8:7}" style="padding:0">
                <div class="inv-det-panel">
                  <div style="font-size:11px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">
                    Test Results · S/N: ${esc(item.serial_number||'—')}
                    ${item.testing_owner||item.tested_by?`<span style="font-weight:400;color:var(--muted);margin-left:8px">by ${esc(item.testing_owner||item.tested_by)}</span>`:''}
                    ${item.d_grade_description?`<span style="color:var(--red);margin-left:8px">⚠ ${esc(item.d_grade_description)}</span>`:''}
                  </div>
                  ${detailHtml}
                </div>
              </td>
            </tr>`;
        });

        cardsHtml += `
        <div class="inv-model-card" id="inv-card-${gid}">
          <div class="inv-card-header" onclick="toggleInvCard('${gid}')">
            <span class="chip ${deviceTypeClass(group.type)}" style="font-size:11px;padding:2px 8px;flex-shrink:0">${typeIcon(group.type)} ${esc(group.type)}</span>
            <span class="inv-card-model">${esc(group.model)}</span>
            <span class="inv-card-count">${(()=>{ const avail=group.items.filter(i=>i.status!=='sold').length; const total=group.items.length; return avail===total?`${total} unit${total!==1?'s':''}` : `${avail} available · ${total-avail} sold`; })()}</span>
            <div class="inv-grade-bar-wrap">${gradeSummary(group.items)}</div>
            <span id="inv-card-toggle-${gid}" class="inv-card-toggle">▶</span>
          </div>
          <div class="inv-card-body" id="inv-card-body-${gid}">
            <table class="inv-unit-table">
              <thead><tr>
                ${S.user.role==='admin'?`<th class="inv-chk-wrap"><input type="checkbox" class="inv-chk" title="Select all in group" onchange="toggleInvGroupSelect('${gid}',this.checked)" id="inv-chk-grp-${gid}"></th>`:''}
                <th>Vendor / Period</th><th>Serial / IMEI</th><th>Specs</th>
                <th>Lock / MDM</th><th style="text-align:center">Overall Grade</th>
                <th>Condition</th><th>Actions</th>
              </tr></thead>
              <tbody>${unitRows}</tbody>
            </table>
          </div>
        </div>`;
      });
    }

    // ── Type tab buttons ─────────────────────────────────────────────────────
    const typeTabs = [`<button class="inv-tab ${S._iTypeTab==='all'?'active':''}" onclick="S._iTypeTab='all';loadInventory()">All <span class="tab-count">${typeCounts.all}</span></button>`]
      .concat(presentTypes.map(t =>
        `<button class="inv-tab ${S._iTypeTab===t?'active':''}" onclick="S._iTypeTab='${t}';loadInventory()">${typeTabIcons[t]||'📦'} ${t} <span class="tab-count">${typeCounts[t]}</span></button>`
      )).join('');

    el.innerHTML = `
      <div class="screen-header"><h2>Inventory</h2><p>${d.total} total units · ${Object.keys(groupMap).length} model${Object.keys(groupMap).length!==1?'s':''} · click a card to expand</p></div>
      <div class="inv-type-tabs">${typeTabs}</div>
      <div class="toolbar" style="margin-top:0">
        <div class="toolbar-left">
          <input class="search-input" type="text" placeholder="Search S/N, model…" value="${esc(S.iFilters.search)}" oninput="S.iFilters.search=this.value" onkeydown="if(event.key==='Enter')loadInventory()">
          <input type="text" placeholder="Lot ID" value="${esc(S.iFilters.lot_id)}" oninput="S.iFilters.lot_id=this.value" onkeydown="if(event.key==='Enter')loadInventory()" style="width:100px">
          <select onchange="S.iFilters.month=this.value;loadInventory()">
            <option value="">All Months</option>${monthOpts}
          </select>
          <select onchange="S.iFilters.year=this.value;loadInventory()">
            <option value="">All Years</option>
            <option value="2026" ${S.iFilters.year==='2026'?'selected':''}>2026</option>
            <option value="2025" ${S.iFilters.year==='2025'?'selected':''}>2025</option>
          </select>
          <select onchange="S.iFilters.vendor=this.value;loadInventory()">
            <option value="">All Vendors</option>${vendorOpts}
          </select>
          <button class="btn btn-outline btn-sm" onclick="S.iFilters={month:'',year:'',vendor:'',device_type:'',lot_id:'',search:''};S._iTypeTab='all';loadInventory()">Clear</button>
        </div>
        <div class="toolbar-right">
          <button class="btn btn-outline btn-sm" onclick="toggleAllInvCards(true)">Expand All</button>
          <button class="btn btn-outline btn-sm" onclick="toggleAllInvCards(false)">Collapse All</button>
          <button class="btn btn-success" onclick="doExportInventory()">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export
          </button>
          <button class="btn btn-success" onclick="showAddInventory()">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Manual
          </button>
          <button class="btn btn-primary" onclick="showImportInventory()">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Import
          </button>
        </div>
      </div>
      <div class="inv-model-cards">${cardsHtml}</div>
      <div style="padding:10px 0;color:var(--muted);font-size:12px">${displayItems.length === d.total ? `${d.total} items total` : `Showing ${displayItems.length} of ${d.total} items`}</div>
      ${S.user.role==='admin'?`
      <div id="inv-bulk-bar" class="inv-bulk-bar hidden">
        <span class="bulk-count" id="inv-bulk-count">0 items selected</span>
        <button class="bulk-clr" onclick="clearInvSelection()">✕ Clear</button>
        <button class="bulk-del" onclick="deleteSelectedInventory()">
          <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M5 6l1-3h12l1 3"/></svg>
          Delete Selected
        </button>
      </div>`:''}`;
    restoreInvCheckboxes();
  } catch(ex) {
    el.innerHTML += `<div class="alert alert-error">${ex.message}</div>`;
  }
}

// Toggle a single model accordion card
function toggleInvCard(gid) {
  const body = document.getElementById('inv-card-body-' + gid);
  const tog  = document.getElementById('inv-card-toggle-' + gid);
  if (!body) return;
  const open = body.classList.contains('open');
  if (open) {
    body.classList.remove('open');
    if (tog) tog.textContent = '▶';
    // Close any open test-detail panels inside
    body.querySelectorAll('[id^="inv-det-"]').forEach(r => { r.style.display = 'none'; });
    body.querySelectorAll('[id^="inv-exp-"]').forEach(b => { b.textContent = '▶'; });
  } else {
    body.classList.add('open');
    if (tog) tog.textContent = '▼';
  }
}

// Expand or collapse ALL model cards at once
function toggleAllInvCards(expand) {
  document.querySelectorAll('[id^="inv-card-body-"]').forEach(body => {
    const gid = body.id.replace('inv-card-body-', '');
    const tog = document.getElementById('inv-card-toggle-' + gid);
    if (expand) {
      body.classList.add('open');
      if (tog) tog.textContent = '▼';
    } else {
      body.classList.remove('open');
      if (tog) tog.textContent = '▶';
      body.querySelectorAll('[id^="inv-det-"]').forEach(r => { r.style.display = 'none'; });
      body.querySelectorAll('[id^="inv-exp-"]').forEach(b => { b.textContent = '▶'; });
    }
  });
}

// Toggle test-detail panel for a single unit row inside a card
function toggleInvDetail(id) {
  const det = document.getElementById('inv-det-' + id);
  const btn = document.getElementById('inv-exp-' + id);
  if (!det) return;
  const open = det.style.display !== 'none';
  det.style.display = open ? 'none' : '';
  if (btn) btn.textContent = open ? '▶' : '▼';
}

async function doExportInventory() {
  try {
    const p = new URLSearchParams();
    if (S.iFilters.month) p.set('month', S.iFilters.month);
    if (S.iFilters.year) p.set('year', S.iFilters.year);
    if (S.iFilters.vendor) p.set('vendor', S.iFilters.vendor);
    if (S.iFilters.device_type) p.set('device_type', S.iFilters.device_type);
    if (S.iFilters.lot_id) p.set('lot_id', S.iFilters.lot_id);
    if (S.iFilters.search) p.set('search', S.iFilters.search);
    const resp = await fetch('/api/inventory/export?' + p, { headers: { Authorization: 'Bearer ' + S.token } });
    if (!resp.ok) throw new Error('Export failed');
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Inventory_${new Date().toISOString().slice(0,10)}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast('✓ Inventory exported');
  } catch(ex) { showToast(ex.message, 'error'); }
}

function deviceTypeClass(t) {
  const m = {iPhone:'blue',Smartphone:'blue',MacBook:'purple',Laptop:'purple',iPad:'cyan',Tablet:'cyan','Gaming Console':'amber',Smartwatch:'green',Other:'gray'};
  return m[t] || 'gray';
}

function showImportInventory() {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const curMonth = months[new Date().getMonth()];
  openModal(`
    <div class="modal-header">
      <h3>Import Inventory (Excel)</h3>
      <button class="modal-close" onclick="closeModal()"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="modal-body">
      <div class="alert alert-success" style="margin-bottom:16px">
        Supports multiple sheet formats: Apto, Digicircle, Urban, Minnesota, Sycamore and others. All sheets in the file will be imported.
      </div>
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label>Vendor Name *</label>
          <input type="text" id="imp-vendor" placeholder="e.g. Apto, Digicircle, Urban…">
        </div>
        <div class="form-group">
          <label>Device Type *</label>
          <select id="imp-device_type">
            ${['iPhone','Smartphone','MacBook','Laptop','iPad','Gaming Console','Smartwatch','Other'].map(t=>`<option>${t}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Month *</label>
          <select id="imp-month">
            ${months.map(m=>`<option ${m===curMonth?'selected':''}>${m}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Year *</label>
          <input type="number" id="imp-year" value="${new Date().getFullYear()}" min="2020" max="2030">
        </div>
      </div>
      <div class="form-group mt8">
        <label>Select Excel File (.xlsx) *</label>
        <input type="file" id="inv-file" accept=".xlsx,.xls" style="width:100%">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="doImportInventory()">Import</button>
    </div>`);
}

async function doImportInventory() {
  const file = document.getElementById('inv-file').files[0];
  const vendor = document.getElementById('imp-vendor').value.trim();
  if (!file || !vendor) { showToast('Please fill all required fields', 'error'); return; }
  const fd = new FormData();
  fd.append('file', file);
  fd.append('vendor', vendor);
  fd.append('month', document.getElementById('imp-month').value);
  fd.append('year', document.getElementById('imp-year').value);
  fd.append('device_type', document.getElementById('imp-device_type').value);
  try {
    const r = await api('POST', '/api/inventory/import', fd, true);
    showToast(`✓ Imported ${r.imported} items`);
    closeModal(); loadInventory();
  } catch(ex) { showToast(ex.message, 'error'); }
}

function showAddInventory() {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const curMonth = months[new Date().getMonth()];
  const closeX = `<button class="modal-close" onclick="closeModal()"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
  openModal(`
    <div class="modal-header"><h3>Add Inventory Item</h3>${closeX}</div>
    <div class="modal-body">
      <div class="form-section">
        <div class="form-section-title">Source Info</div>
        <div class="form-grid form-grid-3">
          <div class="form-group"><label>Vendor *</label><input type="text" id="ai-vendor" placeholder="Vendor name"></div>
          <div class="form-group"><label>Month *</label>
            <select id="ai-month">${months.map(m=>`<option ${m===curMonth?'selected':''}>${m}</option>`).join('')}</select>
          </div>
          <div class="form-group"><label>Year *</label><input type="number" id="ai-year" value="${new Date().getFullYear()}"></div>
        </div>
        <div class="form-grid form-grid-3">
          <div class="form-group"><label>Device Type *</label>
            <select id="ai-device_type">${['iPhone','Smartphone','MacBook','Laptop','iPad','Gaming Console','Smartwatch','Other'].map(t=>`<option>${t}</option>`).join('')}</select>
          </div>
          <div class="form-group"><label>Lot ID</label><input type="text" id="ai-lot_id" placeholder="e.g. LOT-2024-001"></div>
          <div class="form-group"><label>Invoice No.</label><input type="text" id="ai-invoice_no" placeholder="Invoice number"></div>
        </div>
        <div class="form-group"><label>PO Number</label><input type="text" id="ai-po_number" placeholder="PO#"></div>
      </div>
      <div class="form-section">
        <div class="form-section-title">Device Details</div>
        <div class="form-grid form-grid-2">
          <div class="form-group"><label>Model</label><input type="text" id="ai-model" placeholder="e.g. iPhone 15 Pro, MacBook Air M2"></div>
          <div class="form-group"><label>Description</label><input type="text" id="ai-description" placeholder="Full device description"></div>
        </div>
        <div class="form-grid form-grid-3">
          <div class="form-group"><label>Serial Number</label><input type="text" id="ai-serial_number" placeholder="S/N"></div>
          <div class="form-group"><label>IMEI</label><input type="text" id="ai-imei" placeholder="IMEI (phones/tablets)"></div>
          <div class="form-group"><label>Manufacturer</label><input type="text" id="ai-manufacturer" placeholder="e.g. Apple, Samsung"></div>
          <div class="form-group"><label>Color</label><input type="text" id="ai-color" placeholder="Color"></div>
          <div class="form-group"><label>Storage / SSD</label><input type="text" id="ai-storage" placeholder="e.g. 128GB, 256GB"></div>
          <div class="form-group"><label>RAM</label><input type="text" id="ai-ram" placeholder="e.g. 8GB, 16GB"></div>
          <div class="form-group"><label>Processor / Chip</label><input type="text" id="ai-processor" placeholder="e.g. M2, i7-1260P, Snapdragon 8 Gen 3"></div>
          <div class="form-group"><label>WiFi / Cellular</label>
            <select id="ai-wifi_cellular">
              <option value="">—</option>
              ${['WiFi Only','WiFi + Cellular','5G','4G LTE','N/A'].map(v=>`<option>${v}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>Screen Size</label><input type="text" id="ai-screen_size" placeholder="e.g. 13-inch"></div>
          <div class="form-group"><label>Part Number</label><input type="text" id="ai-part_number" placeholder="Part/Model #"></div>
        </div>
      </div>
      <div class="form-section">
        <div class="form-section-title">Condition</div>
        <div class="form-grid form-grid-3">
          <div class="form-group"><label>Grade</label>
            <select id="ai-grade"><option value="">—</option>${['A','B','C','D','New','New Open Box'].map(g=>`<option>${g}</option>`).join('')}</select>
          </div>
          <div class="form-group"><label>Condition</label><input type="text" id="ai-condition_grade" placeholder="e.g. B, New"></div>
          <div class="form-group"><label>Lock Status</label>
            <select id="ai-lock_status"><option value="">—</option>${['Unlocked','Locked','iCloud Locked','Carrier Locked'].map(v=>`<option>${v}</option>`).join('')}</select>
          </div>
          <div class="form-group"><label>Carrier</label><input type="text" id="ai-carrier" placeholder="e.g. Unlocked, T-Mobile"></div>
          <div class="form-group"><label>Missing Components</label><input type="text" id="ai-missing_components" placeholder="e.g. AC Adapter, Box"></div>
          <div class="form-group"><label>Damages</label><input type="text" id="ai-damages" placeholder="e.g. Minor scratches"></div>
        </div>
      </div>
      <div class="form-section">
        <div class="form-section-title">Pricing & SKU</div>
        <div class="form-grid form-grid-3">
          <div class="form-group"><label>SKU</label><input type="text" id="ai-sku" placeholder="SKU"></div>
          <div class="form-group"><label>Price ($)</label><input type="number" id="ai-price" step="0.01" placeholder="0.00"></div>
          <div class="form-group"><label>PO Price ($)</label><input type="number" id="ai-po_price" step="0.01" placeholder="0.00"></div>
          <div class="form-group"><label>Facility</label><input type="text" id="ai-facility" placeholder="e.g. GA, CA"></div>
          <div class="form-group"><label>Remarks</label><input type="text" id="ai-remarks" placeholder="Any notes"></div>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="doAddInventory()">Add Item</button>
    </div>`);
}

async function doAddInventory() {
  const gv = id => document.getElementById(id)?.value || '';
  const payload = {
    vendor: gv('ai-vendor'), month: gv('ai-month'), year: parseInt(gv('ai-year')),
    device_type: gv('ai-device_type'), po_number: gv('ai-po_number'),
    lot_id: gv('ai-lot_id'), invoice_no: gv('ai-invoice_no'),
    model: gv('ai-model'), description: gv('ai-description'),
    serial_number: gv('ai-serial_number'), imei: gv('ai-imei'),
    manufacturer: gv('ai-manufacturer'), part_number: gv('ai-part_number'),
    color: gv('ai-color'), storage: gv('ai-storage'), ram: gv('ai-ram'),
    processor: gv('ai-processor'), wifi_cellular: gv('ai-wifi_cellular'), screen_size: gv('ai-screen_size'),
    grade: gv('ai-grade'), condition_grade: gv('ai-condition_grade'),
    lock_status: gv('ai-lock_status'), carrier: gv('ai-carrier'),
    missing_components: gv('ai-missing_components'), damages: gv('ai-damages'),
    sku: gv('ai-sku'), facility: gv('ai-facility'),
    price: parseFloat(gv('ai-price')) || 0, po_price: parseFloat(gv('ai-po_price')) || 0,
    remarks: gv('ai-remarks'),
  };
  if (!payload.vendor) { showToast('Vendor is required', 'error'); return; }
  try {
    await api('POST', '/api/inventory', payload);
    showToast('✓ Item added'); closeModal(); loadInventory();
  } catch(ex) { showToast(ex.message, 'error'); }
}

async function deleteInventory(id) {
  if (!confirm('Delete this inventory item?')) return;
  try { await api('DELETE', '/api/inventory/' + id); showToast('Item deleted'); loadInventory(); }
  catch(ex) { showToast(ex.message, 'error'); }
}

// ─── Inventory Label / Barcode ────────────────────────────────────────────
function showInventoryLabel(itemId) {
  const item = S.inventory.items.find(i => i.id === itemId);
  if (!item) return;

  const barcodeVal = item.serial_number || item.imei || item.sku || `INV-${item.id}`;
  const grade = item.overall_grade || item.tested_grade || item.grade || item.condition_grade || '—';
  const gradeColor = { 'A+':'#15803d', A:'#16a34a', 'B+':'#0ea5e9', B:'#2563eb', C:'#d97706', 'D-Fixable':'#ea580c', 'D-Parts':'#dc2626', 'S-Scrap':'#7f1d1d' }[grade] || '#64748b';

  const closeX = `<button class="modal-close" onclick="closeModal()"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
  openModal(`
    <div class="modal-header"><h3>Device Label — Preview</h3>${closeX}</div>
    <div class="modal-body" style="padding-bottom:8px">
      <div style="margin-bottom:14px;font-size:12px;color:var(--muted)">
        Preview below. Click <strong>Print Label</strong> to send to printer.
      </div>

      <!-- Label preview -->
      <div id="modal-label-preview" style="border:2px dashed var(--border);border-radius:var(--r);padding:16px;background:#fff;display:flex;justify-content:center">
        ${buildLabelHTML(item, barcodeVal, grade, gradeColor)}
      </div>

      <div style="margin-top:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <div class="form-group" style="margin:0;flex:1;min-width:120px">
          <label style="font-size:11px">Label Size</label>
          <select id="label-size-sel" onchange="updateLabelSize(${itemId})" style="padding:5px 8px;font-size:12px">
            <option value="small">Small (50×30mm)</option>
            <option value="medium" selected>Medium (80×50mm)</option>
            <option value="large">Large (100×70mm)</option>
          </select>
        </div>
        <div class="form-group" style="margin:0;flex:1;min-width:120px">
          <label style="font-size:11px">Copies</label>
          <input type="number" id="label-copies" value="1" min="1" max="50" style="padding:5px 8px;font-size:12px">
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-outline" onclick="updateLabelSize(${itemId})">
        <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.21"/></svg>
        Refresh Preview
      </button>
      <button class="btn btn-primary" onclick="printInventoryLabel(${itemId})" style="background:var(--purple);border-color:var(--purple)">
        <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        Print Label
      </button>
    </div>`);

  // Render barcode after modal is in DOM
  setTimeout(() => renderBarcode('modal-barcode-svg', barcodeVal), 50);
}

function buildLabelHTML(item, barcodeVal, grade, gradeColor, size) {
  const s = size || 'medium';
  const w = s === 'small' ? '189px' : s === 'large' ? '378px' : '302px';   // ~50/80/100mm at 96dpi
  const h = s === 'small' ? '113px' : s === 'large' ? '265px' : '189px';

  const specs = [item.storage, item.ram, item.color, item.wifi_cellular].filter(Boolean).join(' · ');
  const snLabel = item.serial_number ? 'S/N' : item.imei ? 'IMEI' : 'REF';

  return `
    <div class="label-card" style="width:${w};min-height:${h};border:1.5px solid #000;border-radius:4px;padding:8px;font-family:'Helvetica Neue',Arial,sans-serif;background:#fff;box-sizing:border-box">
      <!-- Header -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #000;padding-bottom:5px;margin-bottom:5px">
        <div>
          <div style="font-size:8px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#000">Tekhouz WMS</div>
          <div style="font-size:${s==='small'?'7':'9'}px;font-weight:700;color:#000;margin-top:1px;max-width:${s==='small'?'100':'160'}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.model||item.device_type||'Device')}</div>
        </div>
        <div style="background:${gradeColor};color:#fff;font-size:${s==='small'?'10':'14'}px;font-weight:800;padding:2px 7px;border-radius:3px;letter-spacing:.02em">${grade}</div>
      </div>

      <!-- SKU -->
      <div style="display:flex;gap:4px;margin-bottom:3px;align-items:baseline">
        <span style="font-size:7px;font-weight:700;text-transform:uppercase;color:#666;min-width:28px">SKU</span>
        <span style="font-size:${s==='small'?'7':'8'}px;font-weight:600;font-family:monospace;color:#000;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.sku||'—')}</span>
      </div>

      <!-- Serial / IMEI -->
      <div style="display:flex;gap:4px;margin-bottom:3px;align-items:baseline">
        <span style="font-size:7px;font-weight:700;text-transform:uppercase;color:#666;min-width:28px">${snLabel}</span>
        <span style="font-size:${s==='small'?'7':'8'}px;font-weight:600;font-family:monospace;color:#000">${esc(item.serial_number||item.imei||'—')}</span>
      </div>

      ${specs ? `<div style="font-size:7px;color:#444;margin-bottom:4px">${esc(specs)}</div>` : ''}

      <!-- Barcode -->
      <div style="text-align:center;margin-top:4px">
        <svg id="modal-barcode-svg" style="max-width:100%;height:${s==='small'?'30':'40'}px"></svg>
        <div style="font-size:6px;color:#666;margin-top:1px;font-family:monospace">${esc(barcodeVal)}</div>
      </div>

      <!-- Footer -->
      <div style="display:flex;justify-content:flex-end;margin-top:4px;padding-top:3px;border-top:1px solid #eee">
        <span style="font-size:6px;color:#888">${esc(item.month||'')} ${item.year||''}</span>
      </div>
    </div>`;
}

function renderBarcode(svgId, value) {
  const el = document.getElementById(svgId);
  if (!el || !value) return;
  try {
    JsBarcode(`#${svgId}`, value, {
      format: 'CODE128', displayValue: false,
      margin: 0, background: 'transparent', lineColor: '#000',
      width: 1.4, height: 36
    });
  } catch(e) {
    // If value can't be encoded, show a placeholder
    el.innerHTML = `<text x="50%" y="50%" text-anchor="middle" font-size="8" fill="#999">Cannot encode value</text>`;
  }
}

function updateLabelSize(itemId) {
  const item = S.inventory.items.find(i => i.id === itemId);
  if (!item) return;
  const size = document.getElementById('label-size-sel')?.value || 'medium';
  const barcodeVal = item.serial_number || item.imei || item.sku || `INV-${item.id}`;
  const grade = item.overall_grade || item.tested_grade || item.grade || item.condition_grade || '—';
  const gradeColor = { 'A+':'#15803d', A:'#16a34a', 'B+':'#0ea5e9', B:'#2563eb', C:'#d97706', 'D-Fixable':'#ea580c', 'D-Parts':'#dc2626', 'S-Scrap':'#7f1d1d' }[grade] || '#64748b';
  const preview = document.getElementById('modal-label-preview');
  if (preview) {
    preview.innerHTML = buildLabelHTML(item, barcodeVal, grade, gradeColor, size);
    setTimeout(() => renderBarcode('modal-barcode-svg', barcodeVal), 30);
  }
}

function printInventoryLabel(itemId) {
  const item = S.inventory.items.find(i => i.id === itemId);
  if (!item) return;
  const copies = Math.max(1, parseInt(document.getElementById('label-copies')?.value) || 1);
  const size = document.getElementById('label-size-sel')?.value || 'medium';
  const barcodeVal = item.serial_number || item.imei || item.sku || `INV-${item.id}`;
  const grade = item.overall_grade || item.tested_grade || item.grade || item.condition_grade || '—';
  const gradeColor = { 'A+':'#15803d', A:'#16a34a', 'B+':'#0ea5e9', B:'#2563eb', C:'#d97706', 'D-Fixable':'#ea580c', 'D-Parts':'#dc2626', 'S-Scrap':'#7f1d1d' }[grade] || '#64748b';

  const labelHtml = Array.from({length: copies}, () => buildLabelHTML(item, barcodeVal, grade, gradeColor, size)).join('<div style="height:8px"></div>');
  const printArea = document.getElementById('label-print-area');
  printArea.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:8px;padding:12px">${labelHtml}</div>`;

  // Render all barcodes in print area
  const svgs = printArea.querySelectorAll('[id^="modal-barcode-svg"]');
  // Give unique IDs for multi-copy
  printArea.querySelectorAll('svg').forEach((svg, i) => {
    svg.id = `print-barcode-${i}`;
    try {
      JsBarcode(`#print-barcode-${i}`, barcodeVal, {
        format: 'CODE128', displayValue: false,
        margin: 0, background: 'transparent', lineColor: '#000',
        width: 1.4, height: 36
      });
    } catch(e) {}
  });

  setTimeout(() => { window.print(); }, 100);
}

// ─── Inventory Testing Modal ──────────────────────────────────────────────
async function openInventoryTesting(itemId) {
  const item = S.inventory.items.find(i => i.id === itemId);
  if (!item) return;
  const existing = await api('GET', `/api/inventory/${itemId}/testing`).catch(() => null);
  const deviceType = existing?.device_type || item.device_type || detectDeviceType(item.description, item.sku);
  const closeX = `<button class="modal-close" onclick="closeModal()"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;

  openModal(`
    <div class="modal-header">
      <div>
        <h3>Device Testing — ${esc(item.model||item.device_type)}</h3>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(item.serial_number||item.imei||'—')} · ${esc(item.vendor)} · ${esc(item.month)} ${item.year}</div>
      </div>
      ${closeX}
    </div>
    <div class="modal-body">
      <div style="background:#f8fafc;border-radius:8px;padding:12px;margin-bottom:16px;font-size:12px;color:var(--muted)">
        <strong style="color:var(--txt)">${esc(item.model||item.description||'')}</strong>
        ${item.color?` · ${esc(item.color)}`:''}${item.storage?` · ${esc(item.storage)}`:''}
        ${item.wifi_cellular?` · ${esc(item.wifi_cellular)}`:''}${item.grade?` · Grade ${esc(item.grade)}`:''}
        ${item.missing_components?`<div style="color:var(--amber);margin-top:4px">⚠ Missing: ${esc(item.missing_components)}</div>`:''}
      </div>

      <div class="form-section">
        <div class="form-section-title">Device Identification</div>
        <div class="form-grid form-grid-2">
          <div class="form-group">
            <label>Serial Number</label>
            <input type="text" id="t-serial_number" value="${esc(item.serial_number||'')}" placeholder="e.g. C8QF7K9N" style="font-family:monospace">
          </div>
          <div class="form-group">
            <label>IMEI</label>
            <input type="text" id="t-imei" value="${esc(item.imei||'')}" placeholder="15-digit IMEI" style="font-family:monospace">
          </div>
        </div>
      </div>

      <div class="form-section">
        <div class="form-section-title">Device Specs</div>
        <div class="form-grid form-grid-3">
          <div class="form-group"><label>Model</label><input type="text" id="t-model" value="${esc(item.model||'')}" placeholder="e.g. MacBook Air M2, iPhone 15 Pro"></div>
          <div class="form-group">
            <label>Variant (Pro/Air/etc)</label>
            <select id="t-model_variant">
              ${['','Air','Pro','Pro Max','Mini','Plus','Ultra'].map(v=>`<option value="${v}" ${(item.model_variant||'')=== v?'selected':''}>${v||'—'}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>Year</label><input type="number" id="t-year" value="${item.year||new Date().getFullYear()}" min="2010" max="2030"></div>
          <div class="form-group"><label>Processor / Chip</label><input type="text" id="t-processor" value="${esc(item.processor||'')}" placeholder="e.g. M2, i7-1260P, A17 Pro"></div>
          <div class="form-group"><label>RAM</label><input type="text" id="t-ram" value="${esc(item.ram||'')}" placeholder="e.g. 8GB, 16GB"></div>
          <div class="form-group"><label>Storage / SSD</label><input type="text" id="t-storage" value="${esc(item.storage||'')}" placeholder="e.g. 256GB, 512GB"></div>
          <div class="form-group"><label>Screen Size</label><input type="text" id="t-screen_size" value="${esc(item.screen_size||'')}" placeholder="e.g. 13-inch, 6.1-inch"></div>
          <div class="form-group"><label>Grade</label>
            <select id="t-grade">
              <option value="">—</option>
              ${['A','B','C','D','New','New Open Box'].map(g=>`<option value="${g}" ${(item.grade||'')=== g?'selected':''}>${g}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>

      <div class="form-section">
        <div class="form-section-title">Device & Overall Results</div>
        <div class="form-grid form-grid-4">
          <div class="form-group">
            <label>Device Type</label>
            <select id="t-device_type" onchange="refreshTestFields(${itemId}, 'inventory')">
              ${['iPhone','Smartphone','MacBook','Laptop','iPad','Gaming Console','Smartwatch','Other'].map(t=>`<option ${deviceType===t?'selected':''}>${t}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Overall Grade</label>
            <input type="hidden" id="t-current-sku" value="${esc(item.sku||'')}">
            <select id="t-overall_grade" onchange="previewSkuUpdate()">
              <option value="">— Select —</option>
              ${['A+','A','B+','B','C','D-Fixable','D-Parts','S-Scrap'].map(g=>`<option ${(existing?.overall_grade||'')===g?'selected':''}>${g}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Color</label>
            <select id="t-color" onchange="previewSkuUpdate()">
              <option value="">— Select —</option>
              ${(S.catalog?.colors||[]).map(c=>`<option value="${esc(c)}" ${(item.color||'')===c?'selected':''}>${esc(c)} (${colorToAbbr(c)})</option>`).join('')}
            </select>
            <div id="sku-grade-preview" style="margin-top:5px;font-size:11px;min-height:16px"></div>
          </div>
          <div class="form-group">
            <label>Final Cosmetic Grade</label>
            <select id="t-final_grade">
              <option value="">— Select —</option>
              ${['Working','Partial Working','Not Working','On Hold','Parts','Scrap'].map(g=>`<option ${(existing?.final_grade||'')===g?'selected':''}>${g}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>

      <div class="form-section" id="test-fields-container"></div>

      <div class="form-section">
        <div class="form-section-title">Device Status</div>
        <div class="form-grid form-grid-3">
          <div class="form-group">
            <label>Lock / Unlock Status</label>
            <select id="t-lock_status">
              <option value="">—</option>
              ${['Unlocked','Locked','iCloud Locked','Carrier Locked','Activation Locked'].map(v=>`<option ${(item.lock_status||'')===v?'selected':''}>${v}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Locked Carrier</label>
            <input type="text" id="t-locked_carrier" value="${esc(item.carrier||'')}" placeholder="e.g. AT&T, T-Mobile">
          </div>
          <div class="form-group">
            <label>MDM Lock Status</label>
            <select id="t-mdm_lock">
              <option value="Off" ${(existing?.mdm_lock||'Off')==='Off'?'selected':''}>Off</option>
              <option value="On" ${(existing?.mdm_lock||'')==='On'?'selected':''}>On</option>
            </select>
          </div>
        </div>
        <div class="form-group mt8">
          <label>D Grade Description</label>
          <input type="text" id="t-d_grade_description" value="${esc(existing?.d_grade_description||'')}" placeholder="Describe issues (screen damage, broken port, etc.) — required for Grade D">
        </div>
      </div>

      <div class="form-section">
        <div class="form-section-title">Testing Info</div>
        <div class="form-grid form-grid-3">
          <div class="form-group"><label>Testing Owner</label><input type="text" id="t-testing_owner" value="${esc(existing?.testing_owner||'')}" placeholder="Assigned to"></div>
          <div class="form-group"><label>Tested By</label><input type="text" id="t-tested_by" value="${esc(existing?.tested_by||S.user.username)}" placeholder="Who tested"></div>
          <div class="form-group"><label>Test Date</label><input type="date" id="t-test_date" value="${existing?.test_date||new Date().toISOString().split('T')[0]}"></div>
        </div>
        <div class="form-grid form-grid-2">
          <div class="form-group"><label>Battery Health %</label><input type="number" id="t-battery_health" min="0" max="100" value="${existing?.battery_health||''}" placeholder="e.g. 87"></div>
          <div class="form-group"><label>Battery Cycles</label><input type="number" id="t-battery_cycles" value="${existing?.battery_cycles||''}" placeholder="e.g. 450"></div>
        </div>
        <div class="form-group mt8"><label>Notes</label><textarea id="t-notes" placeholder="Observations, defects, special notes…">${esc(existing?.notes||'')}</textarea></div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveInventoryTesting(${itemId})">Save Results</button>
    </div>`);

  buildTestFields('test-fields-container', deviceType, existing, 'inventory');
  // Show preview for any pre-selected grade/color
  setTimeout(previewSkuUpdate, 0);
}

async function saveInventoryTesting(itemId) {
  const gv = id => { const el = document.getElementById(id); return el ? el.value : undefined; };
  const fields = getTestFields(gv('t-device_type'));
  const payload = {
    device_type: gv('t-device_type'),
    overall_grade: gv('t-overall_grade'),
    final_grade: gv('t-final_grade'),
    testing_owner: gv('t-testing_owner'),
    tested_by: gv('t-tested_by'),
    test_date: gv('t-test_date'),
    mdm_lock: gv('t-mdm_lock'),
    d_grade_description: gv('t-d_grade_description'),
    notes: gv('t-notes'),
  };
  const bh = gv('t-battery_health'); if (bh) payload.battery_health = parseInt(bh);
  const bc = gv('t-battery_cycles'); if (bc) payload.battery_cycles = parseInt(bc);
  fields.forEach(f => { payload[f.key] = gv('t-' + f.key) || 'Not Tested'; });

  // Also update inventory item fields: serial, imei, lock_status, carrier, specs, and SKU grade
  const invUpdate = {};
  const sn = gv('t-serial_number'); if (sn !== undefined) invUpdate.serial_number = sn;
  const im = gv('t-imei'); if (im !== undefined) invUpdate.imei = im;
  const lockStatus = gv('t-lock_status'); if (lockStatus !== undefined) invUpdate.lock_status = lockStatus;
  const carrier = gv('t-locked_carrier'); if (carrier !== undefined) invUpdate.carrier = carrier;
  // Spec fields from Device Specs section
  const tModel = gv('t-model'); if (tModel !== undefined) invUpdate.model = tModel;
  const tVariant = gv('t-model_variant'); if (tVariant !== undefined) invUpdate.model_variant = tVariant;
  const tYear = gv('t-year'); if (tYear) invUpdate.year = parseInt(tYear);
  const tProcessor = gv('t-processor'); if (tProcessor !== undefined) invUpdate.processor = tProcessor;
  const tRam = gv('t-ram'); if (tRam !== undefined) invUpdate.ram = tRam;
  const tStorage = gv('t-storage'); if (tStorage !== undefined) invUpdate.storage = tStorage;
  const tScreenSize = gv('t-screen_size'); if (tScreenSize !== undefined) invUpdate.screen_size = tScreenSize;
  const tGrade = gv('t-grade'); if (tGrade !== undefined) invUpdate.grade = tGrade;

  // Auto-update SKU: apply color abbreviation then grade segment
  const newGrade = gv('t-overall_grade');
  const newColor = gv('t-color');
  const currentSku = gv('t-current-sku');
  if (newColor) invUpdate.color = newColor;
  if (currentSku) {
    let updatedSku = currentSku;
    if (newColor) { const abbr = colorToAbbr(newColor); if (abbr) updatedSku = updateSkuColor(updatedSku, abbr); }
    if (newGrade) updatedSku = updateSkuGrade(updatedSku, newGrade);
    if (updatedSku !== currentSku) invUpdate.sku = updatedSku;
  }

  if (Object.keys(invUpdate).length) {
    await api('PUT', `/api/inventory/${itemId}`, invUpdate).catch(() => {});
  }

  try {
    await api('POST', `/api/inventory/${itemId}/testing`, payload);
    showToast('✓ Testing results saved'); closeModal(); loadInventory();
  } catch(ex) { showToast(ex.message, 'error'); }
}

function showEditInventoryItem(itemId) {
  const item = S.inventory.items.find(i => i.id === itemId);
  if (!item) return;
  const closeX = `<button class="modal-close" onclick="closeModal()"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  openModal(`
    <div class="modal-header"><h3>Edit Item — ${esc(item.model||'Item')}</h3>${closeX}</div>
    <div class="modal-body">
      <div class="form-section">
        <div class="form-section-title">Source Info</div>
        <div class="form-grid form-grid-3">
          <div class="form-group"><label>Vendor</label><input type="text" id="ei-vendor" value="${esc(item.vendor||'')}" placeholder="Vendor name"></div>
          <div class="form-group"><label>Month</label>
            <select id="ei-month">${months.map(m=>`<option ${(item.month||'')=== m?'selected':''}>${m}</option>`).join('')}</select>
          </div>
          <div class="form-group"><label>Year</label><input type="number" id="ei-year" value="${item.year||new Date().getFullYear()}" min="2010" max="2030"></div>
        </div>
        <div class="form-grid form-grid-3">
          <div class="form-group"><label>Device Type</label>
            <select id="ei-device_type">${['iPhone','Smartphone','MacBook','Laptop','iPad','Gaming Console','Smartwatch','Other'].map(t=>`<option ${(item.device_type||'')=== t?'selected':''}>${t}</option>`).join('')}</select>
          </div>
          <div class="form-group"><label>Lot ID</label><input type="text" id="ei-lot_id" value="${esc(item.lot_id||'')}" placeholder="e.g. LOT-2024-001"></div>
          <div class="form-group"><label>Invoice No.</label><input type="text" id="ei-invoice_no" value="${esc(item.invoice_no||'')}" placeholder="Invoice number"></div>
        </div>
      </div>
      <div class="form-section">
        <div class="form-section-title">Device Details</div>
        <div class="form-grid form-grid-2">
          <div class="form-group"><label>Model</label><input type="text" id="ei-model" value="${esc(item.model||'')}" placeholder="e.g. iPhone 15 Pro, MacBook Air M2"></div>
          <div class="form-group"><label>Description</label><input type="text" id="ei-description" value="${esc(item.description||'')}" placeholder="Full device description"></div>
        </div>
        <div class="form-grid form-grid-3">
          <div class="form-group"><label>Serial Number</label><input type="text" id="ei-serial_number" value="${esc(item.serial_number||'')}" placeholder="S/N" style="font-family:monospace"></div>
          <div class="form-group"><label>IMEI</label><input type="text" id="ei-imei" value="${esc(item.imei||'')}" placeholder="IMEI" style="font-family:monospace"></div>
          <div class="form-group"><label>Manufacturer</label><input type="text" id="ei-manufacturer" value="${esc(item.manufacturer||item.brand||'')}" placeholder="e.g. Apple, Samsung"></div>
        </div>
      </div>
      <div class="form-section">
        <div class="form-section-title">Specifications</div>
        <div class="form-grid form-grid-3">
          <div class="form-group"><label>Color</label><input type="text" id="ei-color" value="${esc(item.color||'')}" placeholder="e.g. Space Gray, Silver"></div>
          <div class="form-group"><label>Storage / SSD</label><input type="text" id="ei-storage" value="${esc(item.storage||'')}" placeholder="e.g. 256GB, 512GB"></div>
          <div class="form-group"><label>RAM</label><input type="text" id="ei-ram" value="${esc(item.ram||'')}" placeholder="e.g. 8GB, 16GB"></div>
          <div class="form-group"><label>Processor / Chip</label><input type="text" id="ei-processor" value="${esc(item.processor||'')}" placeholder="e.g. M2, i7-1260P"></div>
          <div class="form-group"><label>Screen Size</label><input type="text" id="ei-screen_size" value="${esc(item.screen_size||'')}" placeholder="e.g. 13-inch, 6.1-inch"></div>
          <div class="form-group"><label>Variant (Pro/Air/etc)</label>
            <select id="ei-model_variant">
              ${['','Air','Pro','Pro Max','Mini','Plus','Ultra'].map(v=>`<option value="${v}" ${(item.model_variant||'')=== v?'selected':''}>${v||'—'}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>WiFi / Cellular</label>
            <select id="ei-wifi_cellular">
              <option value="">—</option>
              ${['WiFi Only','WiFi + Cellular','5G','4G LTE','N/A'].map(v=>`<option ${(item.wifi_cellular||'')=== v?'selected':''}>${v}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
      <div class="form-section">
        <div class="form-section-title">Condition</div>
        <div class="form-grid form-grid-3">
          <div class="form-group"><label>Grade</label>
            <select id="ei-grade">
              <option value="">—</option>
              ${['A','B','C','D','New','New Open Box'].map(g=>`<option value="${g}" ${(item.grade||'')=== g?'selected':''}>${g}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>Condition</label><input type="text" id="ei-condition_grade" value="${esc(item.condition_grade||'')}" placeholder="e.g. B, New"></div>
          <div class="form-group"><label>Lock Status</label>
            <select id="ei-lock_status">
              <option value="">—</option>
              ${['Unlocked','Locked','iCloud Locked','Carrier Locked'].map(v=>`<option ${(item.lock_status||'')=== v?'selected':''}>${v}</option>`).join('')}
            </select>
          </div>
          <div class="form-group"><label>Carrier</label><input type="text" id="ei-carrier" value="${esc(item.carrier||'')}" placeholder="e.g. Unlocked, T-Mobile"></div>
          <div class="form-group"><label>Missing Components</label><input type="text" id="ei-missing_components" value="${esc(item.missing_components||'')}" placeholder="e.g. AC Adapter, Box"></div>
          <div class="form-group"><label>Damages</label><input type="text" id="ei-damages" value="${esc(item.damages||'')}" placeholder="e.g. Minor scratches"></div>
        </div>
      </div>
      <div class="form-section">
        <div class="form-section-title">Pricing & Other</div>
        <div class="form-grid form-grid-3">
          <div class="form-group"><label>Price ($)</label><input type="number" id="ei-price" value="${item.price||''}" step="0.01" placeholder="0.00"></div>
          <div class="form-group"><label>PO Price ($)</label><input type="number" id="ei-po_price" value="${item.po_price||''}" step="0.01" placeholder="0.00"></div>
          <div class="form-group"><label>Facility</label><input type="text" id="ei-facility" value="${esc(item.facility||'')}" placeholder="e.g. GA, CA"></div>
          <div class="form-group"><label>Remarks</label><input type="text" id="ei-remarks" value="${esc(item.remarks||'')}" placeholder="Any notes"></div>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="doEditInventoryItem(${itemId})">Save Changes</button>
    </div>`);
}

async function doEditInventoryItem(itemId) {
  const gv = id => document.getElementById(id)?.value?.trim() || '';
  const payload = {
    vendor: gv('ei-vendor'), month: gv('ei-month'),
    year: parseInt(document.getElementById('ei-year')?.value) || null,
    device_type: gv('ei-device_type'), lot_id: gv('ei-lot_id'), invoice_no: gv('ei-invoice_no'),
    model: gv('ei-model'), description: gv('ei-description'),
    serial_number: gv('ei-serial_number'), imei: gv('ei-imei'), manufacturer: gv('ei-manufacturer'),
    color: gv('ei-color'), storage: gv('ei-storage'), ram: gv('ei-ram'),
    processor: gv('ei-processor'), screen_size: gv('ei-screen_size'),
    model_variant: gv('ei-model_variant'), wifi_cellular: gv('ei-wifi_cellular'),
    grade: gv('ei-grade'), condition_grade: gv('ei-condition_grade'),
    lock_status: gv('ei-lock_status'), carrier: gv('ei-carrier'),
    missing_components: gv('ei-missing_components'), damages: gv('ei-damages'),
    price: parseFloat(document.getElementById('ei-price')?.value) || null,
    po_price: parseFloat(document.getElementById('ei-po_price')?.value) || null,
    facility: gv('ei-facility'), remarks: gv('ei-remarks'),
  };
  try {
    await api('PUT', `/api/inventory/${itemId}`, payload);
    showToast('✓ Item updated'); closeModal(); loadInventory();
  } catch(ex) { showToast(ex.message, 'error'); }
}

// ─── USERS ─────────────────────────────────────────────────────────────────
async function renderUsers() {
  const el = document.getElementById('screen-users');
  el.innerHTML = `<div class="screen-header"><h2>Users</h2><p>Manage system users and access</p></div><div style="text-align:center;padding:40px"><div class="loader"></div></div>`;
  try {
    const users = await api('GET', '/api/users');
    S.users = users;
    const rows = users.map(u => `
      <tr>
        <td>${u.id}</td>
        <td><strong>${esc(u.username)}</strong></td>
        <td><span class="badge ${u.role==='admin'?'badge-pass':'badge-shipped'}">${u.role}</span></td>
        <td>${fmtDate(u.created_at)}</td>
        <td>
          ${u.id !== S.user.id ? `<button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id})">Delete</button>` : '<span class="badge badge-na">Current</span>'}
        </td>
      </tr>`).join('');

    el.innerHTML = `
      <div class="screen-header"><h2>Users</h2><p>Manage system access</p></div>
      <div class="toolbar">
        <div class="toolbar-right" style="margin-left:auto">
          <button class="btn btn-primary" onclick="showAddUser()">+ Add User</button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>#</th><th>Username</th><th>Role</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch(ex) {
    el.innerHTML += `<div class="alert alert-error">${ex.message}</div>`;
  }
}

function showAddUser() {
  openModal(`
    <div class="modal-header">
      <h3>Add User</h3>
      <button class="modal-close" onclick="closeModal()"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div class="modal-body">
      <div class="form-grid">
        <div class="form-group"><label>Username</label><input type="text" id="nu-username" placeholder="Username"></div>
        <div class="form-group"><label>Password</label><input type="password" id="nu-password" placeholder="Password"></div>
        <div class="form-group"><label>Role</label>
          <select id="nu-role"><option value="user">User</option><option value="admin">Admin</option></select>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="doAddUser()">Create User</button>
    </div>`);
}

async function doAddUser() {
  const username = document.getElementById('nu-username').value.trim();
  const password = document.getElementById('nu-password').value;
  const role = document.getElementById('nu-role').value;
  if (!username || !password) { showToast('Username and password are required', 'error'); return; }
  try {
    await api('POST', '/api/users', { username, password, role });
    showToast('✓ User created'); closeModal(); renderUsers();
  } catch(ex) { showToast(ex.message, 'error'); }
}

async function deleteUser(id) {
  if (!confirm('Delete this user?')) return;
  try { await api('DELETE', '/api/users/' + id); showToast('User deleted'); renderUsers(); }
  catch(ex) { showToast(ex.message, 'error'); }
}

// ─── DEVICE CATALOG ──────────────────────────────────────────────────────────
const DEVICE_CATALOG = {
  brands: ['Apple','Samsung','Google','Dell','HP','Lenovo','Microsoft','Motorola','OnePlus','Other'],
  models: {
    'Apple': [
      'iPhone 6','iPhone 6 Plus','iPhone 6s','iPhone 6s Plus','iPhone 7','iPhone 7 Plus',
      'iPhone 8','iPhone 8 Plus','iPhone X','iPhone XR','iPhone XS','iPhone XS Max',
      'iPhone 11','iPhone 11 Pro','iPhone 11 Pro Max',
      'iPhone 12','iPhone 12 Mini','iPhone 12 Pro','iPhone 12 Pro Max',
      'iPhone 13','iPhone 13 Mini','iPhone 13 Pro','iPhone 13 Pro Max',
      'iPhone 14','iPhone 14 Plus','iPhone 14 Pro','iPhone 14 Pro Max',
      'iPhone 15','iPhone 15 Plus','iPhone 15 Pro','iPhone 15 Pro Max',
      'iPhone 16','iPhone 16 Plus','iPhone 16 Pro','iPhone 16 Pro Max',
      'iPad (5th Gen 2017)','iPad (6th Gen 2018)','iPad (7th Gen 2019)','iPad (8th Gen 2020)','iPad (9th Gen 2021)','iPad (10th Gen 2022)',
      'iPad Mini 1','iPad Mini 2','iPad Mini 3','iPad Mini 4','iPad Mini 5','iPad Mini 6','iPad Mini A17 Pro',
      'iPad Air 1','iPad Air 2','iPad Air 3','iPad Air 4','iPad Air 5','iPad Air M2','iPad Air M3',
      'iPad Pro 9.7"','iPad Pro 10.5"','iPad Pro 12.9" 1st Gen','iPad Pro 12.9" 2nd Gen',
      'iPad Pro 11" 1st Gen','iPad Pro 11" 2nd Gen','iPad Pro 11" 3rd Gen','iPad Pro 11" 4th Gen','iPad Pro 11" M4',
      'iPad Pro 12.9" 3rd Gen','iPad Pro 12.9" 4th Gen','iPad Pro 12.9" 5th Gen','iPad Pro 12.9" 6th Gen','iPad Pro 13" M4',
      'MacBook Air M1','MacBook Air M2','MacBook Air M3','MacBook Air M4',
      'MacBook Pro 13" M1','MacBook Pro 13" M2',
      'MacBook Pro 14" M1 Pro','MacBook Pro 14" M1 Max','MacBook Pro 14" M2 Pro','MacBook Pro 14" M2 Max',
      'MacBook Pro 14" M3 Pro','MacBook Pro 14" M3 Max','MacBook Pro 14" M4 Pro','MacBook Pro 14" M4 Max',
      'MacBook Pro 16" M1 Pro','MacBook Pro 16" M1 Max','MacBook Pro 16" M2 Pro','MacBook Pro 16" M2 Max',
      'MacBook Pro 16" M3 Pro','MacBook Pro 16" M3 Max','MacBook Pro 16" M4 Pro','MacBook Pro 16" M4 Max',
      'Apple Watch Series 6','Apple Watch Series 7','Apple Watch Series 8','Apple Watch Series 9','Apple Watch Series 10',
      'Apple Watch Ultra','Apple Watch Ultra 2','Apple Watch SE 2'
    ],
    'Samsung': [
      'Galaxy S21','Galaxy S21+','Galaxy S21 Ultra',
      'Galaxy S22','Galaxy S22+','Galaxy S22 Ultra',
      'Galaxy S23','Galaxy S23+','Galaxy S23 Ultra','Galaxy S23 FE',
      'Galaxy S24','Galaxy S24+','Galaxy S24 Ultra','Galaxy S24 FE',
      'Galaxy S25','Galaxy S25+','Galaxy S25 Ultra',
      'Galaxy A13','Galaxy A14','Galaxy A15','Galaxy A15 5G',
      'Galaxy A32','Galaxy A33 5G','Galaxy A34 5G','Galaxy A52s','Galaxy A53 5G','Galaxy A54 5G','Galaxy A55 5G',
      'Galaxy Note 20','Galaxy Note 20 Ultra',
      'Galaxy Z Fold 4','Galaxy Z Fold 5','Galaxy Z Fold 6','Galaxy Z Fold 7',
      'Galaxy Z Flip 4','Galaxy Z Flip 5','Galaxy Z Flip 6','Galaxy Z Flip 7',
      'Galaxy Tab S8','Galaxy Tab S8+','Galaxy Tab S8 Ultra',
      'Galaxy Tab S9','Galaxy Tab S9+','Galaxy Tab S9 Ultra',
      'Galaxy Tab S10','Galaxy Tab S10+','Galaxy Tab S10 Ultra'
    ],
    'Google': [
      'Pixel 6','Pixel 6 Pro','Pixel 6a','Pixel 7','Pixel 7 Pro','Pixel 7a',
      'Pixel 8','Pixel 8 Pro','Pixel 8a','Pixel 9','Pixel 9 Pro','Pixel 9 Pro XL','Pixel 9 Pro Fold',
      'Pixel Tablet'
    ],
    'Dell': [
      'XPS 13 9310','XPS 13 9315','XPS 13 9320','XPS 13 9340',
      'XPS 15 9510','XPS 15 9520','XPS 15 9530',
      'XPS 17 9710','XPS 17 9720','XPS 17 9730',
      'Latitude 3420','Latitude 3520','Latitude 3540',
      'Latitude 5320','Latitude 5420','Latitude 5520',
      'Latitude 5330','Latitude 5430','Latitude 5530',
      'Latitude 7320','Latitude 7420','Latitude 7520',
      'Latitude 7330','Latitude 7430','Latitude 7530',
      'Inspiron 15 3511','Inspiron 15 3525','Inspiron 15 5510','Inspiron 15 5515',
      'Inspiron 16 5620','Inspiron 16 Plus 7620',
      'Precision 3560','Precision 3570','Precision 3580',
      'Precision 5550','Precision 5560','Precision 5570',
      'Precision 7550','Precision 7560','Precision 7570'
    ],
    'HP': [
      'Spectre x360 13','Spectre x360 14','Spectre x360 15',
      'ENVY 13','ENVY 14','ENVY 15','ENVY 17','ENVY x360 13','ENVY x360 15',
      'EliteBook 840 G8','EliteBook 840 G9','EliteBook 840 G10',
      'EliteBook 850 G8','EliteBook 850 G9','EliteBook 860 G9','EliteBook 860 G10',
      'EliteBook x360 1040 G8','EliteBook x360 1040 G9',
      'ProBook 440 G8','ProBook 440 G9','ProBook 440 G10',
      'ProBook 450 G8','ProBook 450 G9','ProBook 450 G10','ProBook 650 G8',
      'Omen 15','Omen 16','Omen 17',
      'Pavilion 14','Pavilion 15','Pavilion Plus 14'
    ],
    'Lenovo': [
      'ThinkPad X1 Carbon Gen 9','ThinkPad X1 Carbon Gen 10','ThinkPad X1 Carbon Gen 11',
      'ThinkPad X1 Carbon Gen 12','ThinkPad X1 Carbon Gen 13',
      'ThinkPad X1 Yoga Gen 7','ThinkPad X1 Yoga Gen 8','ThinkPad X1 Yoga Gen 9',
      'ThinkPad E14 Gen 3','ThinkPad E14 Gen 4','ThinkPad E14 Gen 5',
      'ThinkPad E15 Gen 3','ThinkPad E15 Gen 4',
      'ThinkPad T14 Gen 3','ThinkPad T14 Gen 4','ThinkPad T14 Gen 5',
      'ThinkPad T14s Gen 3','ThinkPad T14s Gen 4',
      'ThinkPad T16 Gen 1','ThinkPad T16 Gen 2','ThinkPad T16 Gen 3',
      'ThinkPad L14 Gen 3','ThinkPad L14 Gen 4','ThinkPad L15 Gen 3','ThinkPad L15 Gen 4',
      'IdeaPad 5 14','IdeaPad 5 15','IdeaPad 5 Pro 14','IdeaPad 5 Pro 16',
      'IdeaPad 3 14','IdeaPad 3 15','IdeaPad Slim 5','IdeaPad Slim 5 Pro',
      'Yoga 6','Yoga 7','Yoga 7i','Yoga 9','Yoga 9i','Yoga Slim 7','Yoga Slim 7 Pro',
      'Legion 5 Gen 7','Legion 5 Gen 8','Legion 5 Gen 9',
      'Legion 5 Pro Gen 7','Legion 5 Pro Gen 8',
      'Legion 7 Gen 7','Legion 7 Gen 8','Legion 7i Gen 9',
      'Legion Slim 5 Gen 8','Legion Slim 7 Gen 8'
    ],
    'Microsoft': [
      'Surface Pro 9','Surface Pro 10','Surface Pro 11',
      'Surface Pro X','Surface Pro X (2021)',
      'Surface Laptop 4 13"','Surface Laptop 4 15"',
      'Surface Laptop 5 13"','Surface Laptop 5 15"',
      'Surface Laptop 6 13"','Surface Laptop 6 15"',
      'Surface Laptop 7th Edition 13"','Surface Laptop 7th Edition 15"',
      'Surface Laptop Go 2','Surface Laptop Go 3',
      'Surface Laptop Studio','Surface Laptop Studio 2',
      'Surface Book 3 13"','Surface Book 3 15"',
      'Surface Go 3','Surface Go 4','Surface Studio 2+'
    ],
    'Motorola': [
      'Moto G Power (2022)','Moto G Power (2023)','Moto G Power 5G (2024)',
      'Moto G Stylus (2023)','Moto G Stylus 5G (2024)',
      'Moto G 5G (2022)','Moto G 5G (2023)','Moto G Play (2023)',
      'Edge 30','Edge 30 Pro','Edge 40','Edge 40 Pro',
      'Edge 50','Edge 50 Pro','Edge 50 Ultra',
      'Razr 2023','Razr+ 2023','Razr 2024','Razr+ 2024'
    ],
    'OnePlus': [
      'OnePlus 10 Pro','OnePlus 10T','OnePlus 11','OnePlus 11R',
      'OnePlus 12','OnePlus 12R','OnePlus Nord CE 3','OnePlus Nord 3','OnePlus Open'
    ],
    'Other': []
  }
};

// ─── PURCHASE ORDERS ─────────────────────────────────────────────────────────
async function renderPurchaseOrders() {
  if (S.po.currentPo) {
    await renderPODetail(S.po.currentPo);
  } else {
    await renderPOList();
  }
}

async function renderPOList() {
  const el = document.getElementById('screen-po');
  el.innerHTML = `<div class="screen-header"><h2>Purchase Orders</h2><p>Manage purchase orders and track devices by lot</p></div><div style="text-align:center;padding:40px"><div class="loader"></div></div>`;
  try {
    const p = new URLSearchParams();
    if (S.po.filters.search) p.set('search', S.po.filters.search);
    if (S.po.filters.vendor) p.set('vendor', S.po.filters.vendor);
    if (S.po.filters.month) p.set('month', S.po.filters.month);
    if (S.po.filters.year) p.set('year', S.po.filters.year);
    const d = await api('GET', '/api/purchase-orders?' + p);
    S.po.pos = d.pos; S.po.total = d.total;

    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthOpts = months.map(m => `<option value="${m}" ${S.po.filters.month===m?'selected':''}>${m}</option>`).join('');

    const rows = d.pos.map(po => {
      const types = (po.device_types||'').split(',').map(t=>t.trim()).filter(Boolean);
      const rcvd = po.received_count || 0;
      const skus = po.item_count || 0;
      return `<tr onclick="openPODetail(${po.id})" style="cursor:pointer">
        <td><strong class="mono">${esc(po.lot_id)||'—'}</strong></td>
        <td>${esc(po.invoice_no)||'—'}</td>
        <td><strong>${esc(po.vendor_name)}</strong></td>
        <td>${po.purchase_month ? `${esc(po.purchase_month)} ${po.purchase_year||''}` : '—'}</td>
        <td><div class="inline-badge-row">${types.map(t=>`<span class="chip ${deviceTypeClass(t)}">${typeIcon(t)} ${t}</span>`).join('')||'—'}</div></td>
        <td style="white-space:nowrap">
          <div style="font-size:18px;font-weight:700;color:var(--blue)">${po.total_qty||0}</div>
          <div style="font-size:10px;color:var(--muted)">${skus} SKU${skus!==1?'s':''}</div>
        </td>
        <td style="white-space:nowrap">
          <span class="badge ${rcvd===skus&&skus>0?'badge-delivered':rcvd>0?'badge-processing':'badge-pending'}">${rcvd}/${skus} rcvd</span>
        </td>
        <td style="font-size:11px;color:var(--muted)">${fmtDate((po.created_at||'').slice(0,10))}</td>
        <td onclick="event.stopPropagation()">
          <div style="display:flex;gap:4px">
            <button class="btn btn-outline btn-sm" onclick="openPODetail(${po.id})">View</button>
            <button class="btn btn-primary btn-sm btn-icon" title="Edit" onclick="showEditPO(${po.id})">
              <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            ${S.user.role==='admin'?`<button class="btn btn-danger btn-sm btn-icon" title="Delete" onclick="deletePO(${po.id})"><svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg></button>`:''}
          </div>
        </td>
      </tr>`;
    }).join('') || `<tr><td colspan="9"><div class="empty-state"><p>No purchase orders yet. Click "New PO" to create one.</p></div></td></tr>`;

    el.innerHTML = `
      <div class="screen-header"><h2>Purchase Orders</h2><p>${d.total} total purchase orders</p></div>
      <div class="toolbar">
        <div class="toolbar-left">
          <input class="search-input" type="text" placeholder="Search lot ID, vendor, invoice…" value="${esc(S.po.filters.search)}" oninput="S.po.filters.search=this.value" onkeydown="if(event.key==='Enter')renderPOList()">
          <input type="text" placeholder="Filter vendor" value="${esc(S.po.filters.vendor)}" oninput="S.po.filters.vendor=this.value" onkeydown="if(event.key==='Enter')renderPOList()" style="width:140px">
          <select onchange="S.po.filters.month=this.value;renderPOList()">
            <option value="">All Months</option>${monthOpts}
          </select>
          <select onchange="S.po.filters.year=this.value;renderPOList()">
            <option value="">All Years</option>
            ${['2026','2025','2024'].map(y=>`<option value="${y}" ${S.po.filters.year===y?'selected':''}>${y}</option>`).join('')}
          </select>
          <button class="btn btn-outline btn-sm" onclick="S.po.filters={search:'',vendor:'',month:'',year:''};renderPOList()">Clear</button>
        </div>
        <div class="toolbar-right">
          <button class="btn btn-primary" onclick="showAddPO()">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New PO
          </button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Lot ID</th><th>Invoice No.</th><th>Vendor</th><th>Period</th><th>Device Types</th><th>Total Qty</th><th>Received</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="table-foot"><span>Showing ${d.pos.length} of ${d.total}</span></div>
      </div>`;
  } catch(ex) {
    el.innerHTML += `<div class="alert alert-error">${ex.message}</div>`;
  }
}

async function openPODetail(poId) {
  S.po.currentPo = S.po.pos.find(p => p.id === poId) || { id: poId };
  S.po.itemSearch = '';
  await renderPODetail(S.po.currentPo);
}

// ─── PO Items bulk-select helpers ────────────────────────────────────────────
function togglePoItemSelect(id, checked) {
  if (checked) S._poItemSelected.add(id); else S._poItemSelected.delete(id);
  updatePoItemBulkBar();
}
function toggleAllPoItems(checked) {
  document.querySelectorAll('.poi-chk').forEach(chk => {
    const id = parseInt(chk.dataset.id);
    chk.checked = checked;
    if (checked) S._poItemSelected.add(id); else S._poItemSelected.delete(id);
  });
  updatePoItemBulkBar();
}
function clearPoItemSelection() {
  S._poItemSelected.clear();
  document.querySelectorAll('.poi-chk').forEach(c => c.checked = false);
  const hdr = document.getElementById('poi-chk-all'); if (hdr) hdr.checked = false;
  updatePoItemBulkBar();
}
function updatePoItemBulkBar() {
  const bar = document.getElementById('poi-bulk-bar');
  const cnt = document.getElementById('poi-bulk-count');
  if (!bar) return;
  const n = S._poItemSelected.size;
  if (n > 0) { bar.classList.remove('hidden'); if (cnt) cnt.textContent = `${n} item${n!==1?'s':''} selected`; }
  else bar.classList.add('hidden');
}
function restorePoItemCheckboxes() {
  S._poItemSelected.forEach(id => {
    const chk = document.querySelector(`.poi-chk[data-id="${id}"]`);
    if (chk) chk.checked = true;
  });
  const allChks = document.querySelectorAll('.poi-chk');
  const hdr = document.getElementById('poi-chk-all');
  if (hdr && allChks.length > 0) hdr.checked = [...allChks].every(c => c.checked);
  updatePoItemBulkBar();
}
async function deleteSelectedPoItems() {
  const ids = [...S._poItemSelected];
  if (!ids.length) return;
  if (!confirm(`Permanently delete ${ids.length} PO item${ids.length!==1?'s':''}?\n\nThis cannot be undone.`)) return;
  try {
    const r = await api('POST', '/api/po-items/bulk-delete', { ids });
    showToast(`✓ Deleted ${r.deleted} item${r.deleted!==1?'s':''}`);
    S._poItemSelected.clear();
    await renderPODetail(S.po.currentPo);
  } catch(ex) { showToast(ex.message, 'error'); }
}

async function renderPODetail(po) {
  const el = document.getElementById('screen-po');
  if (!po.vendor_name) {
    try {
      const d = await api('GET', '/api/purchase-orders?search=');
      const found = d.pos.find(p => p.id === po.id);
      if (found) { S.po.currentPo = found; po = found; }
    } catch {}
  }
  el.innerHTML = `<div style="text-align:center;padding:40px"><div class="loader"></div></div>`;
  try {
    const qs = S.po.itemSearch ? '?search=' + encodeURIComponent(S.po.itemSearch) : '';
    const items = await api('GET', `/api/purchase-orders/${po.id}/items${qs}`);
    S.po.poItems = items;
    const types = (po.device_types||'').split(',').map(t=>t.trim()).filter(Boolean);

    const statusBadge = s => {
      const m = { 'Received': 'badge-delivered', 'Partial': 'badge-processing', 'Pending': 'badge-pending' };
      return `<span class="badge ${m[s]||'badge-pending'}">${s||'Pending'}</span>`;
    };

    const rows = items.map((item, i) => `
      <tr>
        ${S.user.role==='admin'?`<td class="inv-chk-wrap"><input type="checkbox" class="poi-chk inv-chk" data-id="${item.id}" onchange="togglePoItemSelect(${item.id},this.checked)"></td>`:''}
        <td style="color:var(--muted);font-size:11px">${i+1}</td>
        <td><span class="chip ${deviceTypeClass(item.device_type)}">${typeIcon(item.device_type)} ${item.device_type||'—'}</span></td>
        <td>
          <div style="font-weight:600;font-size:13px">${esc(item.brand||'—')}</div>
          <div style="font-size:11px;color:var(--muted);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.model||'')}</div>
        </td>
        <td>
          <div style="font-size:12px">${esc(item.color||'')}</div>
          <div style="display:flex;gap:4px;margin-top:2px;flex-wrap:wrap">
            ${item.storage?`<span class="tag">${esc(item.storage)}</span>`:''}
            ${item.ram?`<span class="tag">${esc(item.ram)}</span>`:''}
            ${item.wifi_cellular?`<span style="font-size:10px;color:var(--muted)">${esc(item.wifi_cellular)}</span>`:''}
          </div>
        </td>
        <td class="mono" style="font-size:11px">
          ${item.serial_number?`<div>${esc(item.serial_number)}</div>`:''}
          ${item.imei?`<div style="color:var(--muted)">${esc(item.imei)}</div>`:''}
          ${!item.serial_number&&!item.imei?'—':''}
        </td>
        <td style="text-align:center;font-weight:700;font-size:15px;color:var(--blue)">${item.qty}</td>
        <td style="font-size:12px;color:var(--muted)">${item.unit_price?`$${item.unit_price}`:'—'}</td>
        <td>${statusBadge(item.receive_status)}</td>
        <td>
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            <button class="btn btn-outline btn-sm" onclick="showReceivePOItem(${item.id})" title="Update receive status">Receive</button>
            <button class="btn btn-primary btn-sm btn-icon" title="Edit" onclick="showEditPOItem(${item.id})">
              <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            ${S.user.role==='admin'?`<button class="btn btn-danger btn-sm btn-icon" title="Delete" onclick="deletePOItem(${item.id})"><svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg></button>`:''}
          </div>
        </td>
      </tr>`).join('') || `<tr><td colspan="${S.user.role==='admin'?10:9}"><div class="empty-state"><p>No items yet. Click "Add Item" to add devices to this PO.</p></div></td></tr>`;

    el.innerHTML = `
      <div class="screen-header">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <button class="btn btn-outline btn-sm" onclick="S.po.currentPo=null;renderPOList()">← Back</button>
          <div>
            <h2>PO: ${esc(po.lot_id||'—')} <span style="font-size:14px;font-weight:400;color:var(--muted)">· ${esc(po.vendor_name||'')}</span></h2>
            <p>${po.purchase_month||''} ${po.purchase_year||''} · Invoice: ${esc(po.invoice_no||'—')} · ${items.length} item${items.length!==1?'s':''}</p>
          </div>
        </div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <div class="card-title" style="margin-bottom:0">PO Header</div>
          <button class="btn btn-outline btn-sm" onclick="showEditPO(${po.id}, true)">Edit PO</button>
        </div>
        <div class="grid3">
          <div><div class="stat-label">Lot ID</div><div style="font-size:15px;font-weight:600;font-family:monospace;margin-top:4px">${esc(po.lot_id||'—')}</div></div>
          <div><div class="stat-label">Invoice No.</div><div style="font-size:15px;font-weight:600;margin-top:4px">${esc(po.invoice_no||'—')}</div></div>
          <div><div class="stat-label">Vendor</div><div style="font-size:15px;font-weight:600;margin-top:4px">${esc(po.vendor_name)}</div></div>
          <div><div class="stat-label">Purchase Period</div><div style="font-size:14px;margin-top:4px">${esc(po.purchase_month||'—')} ${po.purchase_year||''}</div></div>
          <div><div class="stat-label">Device Types</div><div class="inline-badge-row" style="margin-top:6px">${types.map(t=>`<span class="chip ${deviceTypeClass(t)}">${typeIcon(t)} ${t}</span>`).join('')||'—'}</div></div>
          <div><div class="stat-label">SKU Lines</div><div style="font-size:24px;font-weight:700;color:var(--blue);margin-top:4px">${items.length}</div></div>
          <div><div class="stat-label">Total Units (Qty)</div><div style="font-size:24px;font-weight:700;color:var(--green);margin-top:4px">${items.reduce((s,i)=>s+(i.qty||1),0)}</div></div>
        </div>
        ${po.notes?`<div style="margin-top:12px;font-size:12px;color:var(--muted);padding-top:12px;border-top:1px solid var(--border)">Notes: ${esc(po.notes)}</div>`:''}
      </div>
      <div class="toolbar">
        <div class="toolbar-left">
          <input class="search-input" type="text" placeholder="Search items, S/N, model…" value="${esc(S.po.itemSearch)}" oninput="S.po.itemSearch=this.value" onkeydown="if(event.key==='Enter')renderPODetail(S.po.currentPo)">
          <button class="btn btn-outline btn-sm" onclick="S.po.itemSearch='';renderPODetail(S.po.currentPo)">Clear</button>
        </div>
        <div class="toolbar-right">
          <button class="btn btn-outline" onclick="linkPOToInventory('${esc(po.lot_id||'')}','${esc(po.vendor_name||'')}')">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path d="M20 7H4a2 2 0 00-2 2v6a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg>
            View Inventory
          </button>
          <button class="btn btn-outline" onclick="showImportPOItems(${po.id})">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Import
          </button>
          <button class="btn btn-success" onclick="doExportPO(${po.id},'${esc(po.lot_id||po.id)}','${esc(po.vendor_name||'')}')">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Export Excel
          </button>
          ${items.some(i => (i.receive_status||'Pending') !== 'Received') ? `
          <button class="btn btn-outline" style="border-color:var(--green);color:var(--green)" onclick="doReceiveAll(${po.id})">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Receive All
          </button>` : ''}
          <button class="btn btn-primary" onclick="showAddPOItem(${po.id})">
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Item
          </button>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            ${S.user.role==='admin'?`<th class="inv-chk-wrap"><input type="checkbox" class="inv-chk" id="poi-chk-all" title="Select all" onchange="toggleAllPoItems(this.checked)"></th>`:''}
            <th>#</th><th>Type</th><th>Brand / Model</th><th>Specs</th><th>Serial / IMEI</th><th>Qty</th><th>Price</th><th>Status</th><th>Actions</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="table-foot"><span>${items.length} item${items.length!==1?'s':''}</span></div>
      </div>
      ${S.user.role==='admin'?`
      <div id="poi-bulk-bar" class="inv-bulk-bar hidden">
        <span class="bulk-count" id="poi-bulk-count">0 items selected</span>
        <button class="bulk-clr" onclick="clearPoItemSelection()">✕ Clear</button>
        <button class="bulk-del" onclick="deleteSelectedPoItems()">
          <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M5 6l1-3h12l1 3"/></svg>
          Delete Selected
        </button>
      </div>`:''}`;
    restorePoItemCheckboxes();
  } catch(ex) {
    el.innerHTML += `<div class="alert alert-error">${ex.message}</div>`;
  }
}

function linkPOToInventory(lotId, vendorName) {
  S.iFilters = { month: '', year: '', vendor: vendorName || '', device_type: '', search: lotId || '' };
  nav('inventory');
}

// ─── PO Header CRUD ───────────────────────────────────────────────────────────
async function refreshLotId() {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthName = document.getElementById('po-purchase_month')?.value;
  const year = document.getElementById('po-purchase_year')?.value;
  if (!monthName || !year) return;
  const monthNum = String(months.indexOf(monthName) + 1).padStart(2, '0');
  try {
    const data = await api('GET', `/api/purchase-orders/next-lot-id?year=${year}&month=${monthNum}`);
    const el = document.getElementById('po-lot_id');
    if (el) el.value = data.lot_id;
  } catch(e) { /* silently ignore */ }
}

function poHeaderModalBody(po) {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const curMonth = months[new Date().getMonth()];
  const deviceTypes = ['iPhone','Smartphone','iPad','MacBook','Laptop','Gaming Console','Smartwatch','Other'];
  const existingTypes = (po?.device_types||'').split(',').map(t=>t.trim()).filter(Boolean);
  const isNew = !po;
  const monthOnChange = isNew ? ' onchange="refreshLotId()"' : '';
  const yearOnChange = isNew ? ' onchange="refreshLotId()"' : '';
  return `
    <div class="form-section">
      <div class="form-section-title">PO Identification</div>
      <div class="form-grid form-grid-2">
        <div class="form-group"><label>Lot ID</label><input type="text" id="po-lot_id" value="${esc(po?.lot_id||'')}" placeholder="Auto-generated"></div>
        <div class="form-group"><label>Invoice No.</label><input type="text" id="po-invoice_no" value="${esc(po?.invoice_no||'')}" placeholder="Invoice number"></div>
      </div>
      <div class="form-group"><label>Vendor Name *</label><input type="text" id="po-vendor_name" value="${esc(po?.vendor_name||'')}" placeholder="Vendor / Supplier name"></div>
    </div>
    <div class="form-section">
      <div class="form-section-title">Purchase Details</div>
      <div class="form-grid form-grid-2">
        <div class="form-group"><label>Purchase Month</label>
          <select id="po-purchase_month"${monthOnChange}>${months.map(m=>`<option ${(po?.purchase_month||curMonth)===m?'selected':''}>${m}</option>`).join('')}</select>
        </div>
        <div class="form-group"><label>Purchase Year</label>
          <input type="number" id="po-purchase_year" value="${po?.purchase_year||new Date().getFullYear()}" min="2020" max="2030"${yearOnChange}>
        </div>
      </div>
      <div class="form-group">
        <label>Device Types (select all that apply)</label>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px">
          ${deviceTypes.map(t=>`<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--txt)">
            <input type="checkbox" name="po-device-type" value="${t}" ${existingTypes.includes(t)?'checked':''} style="width:auto;margin:0"> ${typeIcon(t)} ${t}
          </label>`).join('')}
        </div>
      </div>
    </div>
    <div class="form-group"><label>Notes</label><textarea id="po-notes" placeholder="Additional notes…">${esc(po?.notes||'')}</textarea></div>`;
}

function poHeaderPayload() {
  const gv = id => document.getElementById(id)?.value?.trim() || '';
  const vendor = gv('po-vendor_name');
  if (!vendor) { showToast('Vendor Name is required', 'error'); return null; }
  const checkedTypes = [...document.querySelectorAll('input[name="po-device-type"]:checked')].map(c=>c.value).join(', ');
  return {
    lot_id: gv('po-lot_id'), invoice_no: gv('po-invoice_no'), vendor_name: vendor,
    purchase_month: gv('po-purchase_month'), purchase_year: parseInt(gv('po-purchase_year'))||null,
    device_types: checkedTypes, notes: gv('po-notes')
  };
}

async function showAddPO() {
  const closeX = `<button class="modal-close" onclick="closeModal()"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
  openModal(`
    <div class="modal-header"><h3>New Purchase Order</h3>${closeX}</div>
    <div class="modal-body">${poHeaderModalBody(null)}</div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="doAddPO()">Create PO</button>
    </div>`);
  await refreshLotId();
}

async function doAddPO() {
  const payload = poHeaderPayload();
  if (!payload) return;
  try {
    await api('POST', '/api/purchase-orders', payload);
    showToast('✓ Purchase Order created');
    closeModal();
    await renderPOList();
  } catch(ex) { showToast(ex.message, 'error'); }
}

async function showEditPO(poId, fromDetail) {
  const po = S.po.pos.find(p => p.id === poId) || S.po.currentPo;
  if (!po) return;
  const closeX = `<button class="modal-close" onclick="closeModal()"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
  openModal(`
    <div class="modal-header"><h3>Edit Purchase Order</h3>${closeX}</div>
    <div class="modal-body">${poHeaderModalBody(po)}</div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="doEditPO(${poId},${!!fromDetail})">Save Changes</button>
    </div>`);
}

async function doEditPO(poId, fromDetail) {
  const payload = poHeaderPayload();
  if (!payload) return;
  try {
    await api('PUT', `/api/purchase-orders/${poId}`, payload);
    showToast('✓ PO updated');
    closeModal();
    if (fromDetail) {
      Object.assign(S.po.currentPo, payload);
      await renderPODetail(S.po.currentPo);
    } else {
      await renderPOList();
    }
  } catch(ex) { showToast(ex.message, 'error'); }
}

async function deletePO(poId) {
  if (!confirm('Delete this purchase order and all its items? This cannot be undone.')) return;
  try { await api('DELETE', '/api/purchase-orders/' + poId); showToast('PO deleted'); renderPOList(); }
  catch(ex) { showToast(ex.message, 'error'); }
}

// ─── PO Items CRUD ────────────────────────────────────────────────────────────
function poItemModalBody(item) {
  const deviceTypes = ['iPhone','Smartphone','iPad','MacBook','Laptop','Gaming Console','Smartwatch','Other'];
  const brand = item?.brand || '';
  const closeX = '';
  return `
    <div class="form-section">
      <div class="form-section-title">Device Classification</div>
      <div class="form-grid form-grid-3">
        <div class="form-group">
          <label>Device Type</label>
          <select id="pi-device_type">
            <option value="">— Select —</option>
            ${deviceTypes.map(t=>`<option ${(item?.device_type||'')=== t?'selected':''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Brand</label>
          <select id="pi-brand" onchange="updatePOModelDropdown()">
            <option value="">— Select Brand —</option>
            ${DEVICE_CATALOG.brands.map(b=>`<option ${brand===b?'selected':''}>${b}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Model</label>
          <input type="text" id="pi-model" list="pi-model-list" value="${esc(item?.model||'')}" placeholder="Select or type model…">
          <datalist id="pi-model-list"></datalist>
        </div>
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-title">Item Details</div>
      <div class="form-grid form-grid-2">
        <div class="form-group"><label>SKU</label><input type="text" id="pi-sku" value="${esc(item?.sku||'')}" placeholder="SKU"></div>
        <div class="form-group"><label>Qty</label><input type="number" id="pi-qty" value="${item?.qty||1}" min="1"></div>
      </div>
      <div class="form-group"><label>Description</label><input type="text" id="pi-description" value="${esc(item?.description||'')}" placeholder="Full device description"></div>
    </div>
    <div class="form-section">
      <div class="form-section-title">Identification</div>
      <div class="form-grid form-grid-2">
        <div class="form-group"><label>Serial Number</label><input type="text" id="pi-serial_number" value="${esc(item?.serial_number||'')}" placeholder="S/N"></div>
        <div class="form-group"><label>IMEI</label><input type="text" id="pi-imei" value="${esc(item?.imei||'')}" placeholder="IMEI (phones/tablets)"></div>
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-title">Specifications</div>
      <div class="form-grid form-grid-3">
        <div class="form-group">
          <label>Color</label>
          <input type="text" id="pi-color" list="pi-color-list" value="${esc(item?.color||'')}" placeholder="e.g. Space Gray">
          <datalist id="pi-color-list">${(S.catalog?.colors||[]).map(c=>`<option value="${esc(c)}">`).join('')}</datalist>
        </div>
        <div class="form-group">
          <label>RAM</label>
          <input type="text" id="pi-ram" list="pi-ram-list" value="${esc(item?.ram||'')}" placeholder="e.g. 8GB, 16GB">
          <datalist id="pi-ram-list">${(S.catalog?.ram||[]).map(r=>`<option value="${esc(r)}">`).join('')}</datalist>
        </div>
        <div class="form-group">
          <label>Storage</label>
          <input type="text" id="pi-storage" list="pi-storage-list" value="${esc(item?.storage||'')}" placeholder="e.g. 128GB, 256GB">
          <datalist id="pi-storage-list">${(S.catalog?.storage||[]).map(s=>`<option value="${esc(s)}">`).join('')}</datalist>
        </div>
        <div class="form-group"><label>Processor</label><input type="text" id="pi-processor" value="${esc(item?.processor||'')}" placeholder="e.g. M2, i7-1260P"></div>
        <div class="form-group"><label>Screen Size</label><input type="text" id="pi-screen_size" value="${esc(item?.screen_size||'')}" placeholder="e.g. 13-inch, 6.1-inch"></div>
        <div class="form-group"><label>Year</label><input type="number" id="pi-year" value="${item?.year||new Date().getFullYear()}" min="2010" max="2030"></div>
        <div class="form-group">
          <label>Variant (Pro/Air/etc)</label>
          <select id="pi-model_variant">
            ${['','Air','Pro','Pro Max','Mini','Plus','Ultra'].map(v=>`<option value="${v}" ${(item?.model_variant||'')=== v?'selected':''}>${v||'—'}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>WiFi / Cellular</label>
          <select id="pi-wifi_cellular">
            <option value="">—</option>
            ${['WiFi Only','WiFi + Cellular','5G','4G LTE','N/A'].map(v=>`<option ${(item?.wifi_cellular||'')=== v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label>Unit Price ($)</label><input type="number" id="pi-unit_price" value="${item?.unit_price||0}" step="0.01" min="0"></div>
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-title">Condition</div>
      <div class="form-grid form-grid-3">
        <div class="form-group"><label>Grade</label>
          <select id="pi-grade">
            <option value="">—</option>
            ${['A','B','C','D','New','New Open Box'].map(g=>`<option value="${g}" ${(item?.grade||'')=== g?'selected':''}>${g}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label>Condition</label><input type="text" id="pi-condition_grade" value="${esc(item?.condition_grade||'')}" placeholder="e.g. B, New"></div>
        <div class="form-group"><label>Lock Status</label>
          <select id="pi-lock_status">
            <option value="">—</option>
            ${['Unlocked','Locked','iCloud Locked','Carrier Locked'].map(v=>`<option ${(item?.lock_status||'')=== v?'selected':''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label>Carrier</label><input type="text" id="pi-carrier" value="${esc(item?.carrier||'')}" placeholder="e.g. Unlocked, T-Mobile"></div>
        <div class="form-group"><label>Missing Components</label><input type="text" id="pi-missing_components" value="${esc(item?.missing_components||'')}" placeholder="e.g. AC Adapter, Box"></div>
        <div class="form-group"><label>Damages</label><input type="text" id="pi-damages" value="${esc(item?.damages||'')}" placeholder="e.g. Minor scratches"></div>
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-title">Other</div>
      <div class="form-grid form-grid-2">
        <div class="form-group"><label>PO Price ($)</label><input type="number" id="pi-po_price" value="${item?.po_price||''}" step="0.01" placeholder="0.00"></div>
        <div class="form-group"><label>Facility</label><input type="text" id="pi-facility" value="${esc(item?.facility||'')}" placeholder="e.g. GA, CA"></div>
        <div class="form-group"><label>Remarks</label><input type="text" id="pi-remarks" value="${esc(item?.remarks||'')}" placeholder="Any notes"></div>
      </div>
    </div>
    <div class="form-group"><label>Notes</label><textarea id="pi-notes" placeholder="Additional notes…">${esc(item?.notes||'')}</textarea></div>`;
}

function updatePOModelDropdown() {
  const brand = document.getElementById('pi-brand')?.value || '';
  const dl = document.getElementById('pi-model-list');
  if (!dl) return;
  const models = DEVICE_CATALOG.models[brand] || [];
  dl.innerHTML = models.map(m => `<option value="${esc(m)}">`).join('');
}

function getPOItemPayload(poId) {
  const gv = id => document.getElementById(id)?.value?.trim() || '';
  return {
    po_id: poId,
    device_type: gv('pi-device_type'), brand: gv('pi-brand'), model: gv('pi-model'),
    sku: gv('pi-sku'), description: gv('pi-description'),
    serial_number: gv('pi-serial_number'), imei: gv('pi-imei'),
    color: gv('pi-color'), ram: gv('pi-ram'), storage: gv('pi-storage'),
    processor: gv('pi-processor'), wifi_cellular: gv('pi-wifi_cellular'),
    screen_size: gv('pi-screen_size'),
    year: parseInt(document.getElementById('pi-year')?.value)||null,
    model_variant: gv('pi-model_variant'),
    grade: gv('pi-grade'), condition_grade: gv('pi-condition_grade'),
    lock_status: gv('pi-lock_status'), carrier: gv('pi-carrier'),
    missing_components: gv('pi-missing_components'), damages: gv('pi-damages'),
    po_price: parseFloat(document.getElementById('pi-po_price')?.value)||null,
    facility: gv('pi-facility'), remarks: gv('pi-remarks'),
    qty: parseInt(document.getElementById('pi-qty')?.value)||1,
    unit_price: parseFloat(document.getElementById('pi-unit_price')?.value)||0,
    notes: gv('pi-notes')
  };
}

function showAddPOItem(poId) {
  const closeX = `<button class="modal-close" onclick="closeModal()"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
  openModal(`
    <div class="modal-header"><h3>Add Item to PO</h3>${closeX}</div>
    <div class="modal-body">${poItemModalBody(null)}</div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="doAddPOItem(${poId})">Add Item</button>
    </div>`);
  updatePOModelDropdown();
}

async function doAddPOItem(poId) {
  const payload = getPOItemPayload(poId);
  try {
    await api('POST', '/api/po-items', payload);
    showToast('✓ Item added');
    closeModal();
    await renderPODetail(S.po.currentPo);
  } catch(ex) { showToast(ex.message, 'error'); }
}

function showEditPOItem(itemId) {
  const item = S.po.poItems.find(i => i.id === itemId);
  if (!item) return;
  const closeX = `<button class="modal-close" onclick="closeModal()"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
  openModal(`
    <div class="modal-header"><h3>Edit Item</h3>${closeX}</div>
    <div class="modal-body">${poItemModalBody(item)}</div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="doEditPOItem(${itemId},${item.po_id})">Save</button>
    </div>`);
  updatePOModelDropdown();
}

async function doEditPOItem(itemId, poId) {
  const payload = getPOItemPayload(poId);
  delete payload.po_id;
  try {
    await api('PUT', `/api/po-items/${itemId}`, payload);
    showToast('✓ Item updated');
    closeModal();
    await renderPODetail(S.po.currentPo);
  } catch(ex) { showToast(ex.message, 'error'); }
}

async function deletePOItem(itemId) {
  if (!confirm('Delete this item?')) return;
  try { await api('DELETE', '/api/po-items/' + itemId); showToast('Item deleted'); await renderPODetail(S.po.currentPo); }
  catch(ex) { showToast(ex.message, 'error'); }
}

// ─── Receive PO Item ──────────────────────────────────────────────────────────
function showReceivePOItem(itemId) {
  const item = S.po.poItems.find(i => i.id === itemId);
  if (!item) return;
  const qty = item.qty || 1;
  const closeX = `<button class="modal-close" onclick="closeModal()"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
  const statuses = ['Pending','Received','Partial'];

  const unitRows = qty > 1 ? `
    <div class="form-section" style="margin-top:16px">
      <div class="form-section-title">Serial / IMEI per Unit (${qty} units)</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:10px">Enter serial or IMEI for each individual device. Leave blank if unknown — you can update later in Inventory.</div>
      <div style="max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--r);padding:10px;display:flex;flex-direction:column;gap:8px">
        ${Array.from({length:qty},(_,i)=>`
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:12px;color:var(--muted);min-width:22px;text-align:right">${i+1}.</span>
            <input type="text" id="recv-sn-${i}" placeholder="Serial number" style="flex:1;padding:5px 8px;border:1.5px solid var(--border);border-radius:5px;font-size:12px;font-family:monospace">
            <input type="text" id="recv-imei-${i}" placeholder="IMEI (optional)" style="flex:1;padding:5px 8px;border:1.5px solid var(--border);border-radius:5px;font-size:12px;font-family:monospace">
          </div>`).join('')}
      </div>
    </div>` : `
    <div class="form-group" style="margin-top:12px">
      <label>Serial Number</label>
      <input type="text" id="recv-sn-0" value="${esc(item.serial_number||'')}" placeholder="Serial number" style="font-family:monospace">
    </div>
    <div class="form-group">
      <label>IMEI</label>
      <input type="text" id="recv-imei-0" value="${esc(item.imei||'')}" placeholder="IMEI (if applicable)" style="font-family:monospace">
    </div>`;

  openModal(`
    <div class="modal-header"><h3>Receive Item</h3>${closeX}</div>
    <div class="modal-body">
      <div style="margin-bottom:16px;padding:12px;background:var(--bg);border-radius:var(--r);display:flex;align-items:center;gap:12px">
        <div>
          <div style="font-weight:600">${esc(item.brand||'')} ${esc(item.model||'')}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(item.color||'')} ${item.storage?'· '+esc(item.storage):''} ${item.ram?'· '+esc(item.ram):''}</div>
        </div>
        <div style="margin-left:auto;text-align:right">
          <div style="font-size:22px;font-weight:700;color:var(--blue)">${qty}</div>
          <div style="font-size:10px;color:var(--muted)">unit${qty!==1?'s':''}</div>
        </div>
      </div>
      <div class="form-group">
        <label>Receive Status</label>
        <select id="recv-status" onchange="document.getElementById('recv-units-wrap').style.display=this.value==='Received'?'block':'none'">
          ${statuses.map(s=>`<option ${(item.receive_status||'Pending')===s?'selected':''}>${s}</option>`).join('')}
        </select>
      </div>
      <div id="recv-units-wrap" style="display:${(item.receive_status||'Pending')==='Received'?'block':'none'}">
        ${unitRows}
      </div>
      ${item.receive_status==='Received'&&item.inventory_id?`<div class="alert alert-success" style="margin-top:12px;padding:10px;border-radius:var(--r);background:#f0fdf4;border:1px solid #bbf7d0;color:#15803d;font-size:12px">Previously received · Inventory #${item.inventory_id}</div>`:''}
      <div style="margin-top:12px;padding:10px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:var(--r);color:#1d4ed8;font-size:12px">
        Setting to <strong>Received</strong> creates <strong>${qty} individual inventory record${qty!==1?'s':''}</strong> — one per unit — for serial-level tracking.
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="doReceivePOItem(${itemId},${qty})">Save</button>
    </div>`);
}

async function doReceiveAll(poId) {
  const pending = S.po.poItems.filter(i => (i.receive_status||'Pending') !== 'Received');
  if (!pending.length) { showToast('All items already received', 'error'); return; }
  const totalUnits = pending.reduce((s,i) => s + (i.qty||1), 0);
  if (!confirm(`Receive all ${pending.length} pending item${pending.length!==1?'s':''} (${totalUnits} unit${totalUnits!==1?'s':''})?\n\nThis will create ${totalUnits} inventory record${totalUnits!==1?'s':''} with the item details from this PO. Serial numbers can be filled in later from the Inventory screen.`)) return;
  try {
    const r = await api('POST', `/api/purchase-orders/${poId}/receive-all`, {});
    showToast(`✓ Received ${r.items_received} item${r.items_received!==1?'s':''} · ${r.units_created} inventory record${r.units_created!==1?'s':''} created`);
    await renderPODetail(S.po.currentPo);
  } catch(ex) { showToast(ex.message, 'error'); }
}

async function doReceivePOItem(itemId, qty) {
  const status = document.getElementById('recv-status')?.value;
  const units = [];
  if (status === 'Received') {
    for (let i = 0; i < qty; i++) {
      units.push({
        serial_number: document.getElementById(`recv-sn-${i}`)?.value?.trim() || '',
        imei: document.getElementById(`recv-imei-${i}`)?.value?.trim() || ''
      });
    }
  }
  try {
    const r = await api('POST', `/api/po-items/${itemId}/receive`, { receive_status: status, units });
    showToast(status === 'Received'
      ? `✓ Received — ${r.count} inventory record${r.count!==1?'s':''} created`
      : '✓ Status updated');
    closeModal();
    await renderPODetail(S.po.currentPo);
  } catch(ex) { showToast(ex.message, 'error'); }
}

// ─── PO Export / Import ───────────────────────────────────────────────────────
async function doExportPO(poId, lotId, vendor) {
  try {
    const resp = await fetch(`/api/purchase-orders/${poId}/export`, {
      headers: { Authorization: 'Bearer ' + S.token }
    });
    if (!resp.ok) throw new Error('Export failed');
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `PO_${(lotId||poId).replace(/[^a-z0-9_-]/gi,'_')}_${(vendor||'').replace(/\s+/g,'_')}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch(ex) { showToast(ex.message, 'error'); }
}

function showImportPOItems(poId) {
  const closeX = `<button class="modal-close" onclick="closeModal()"><svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
  openModal(`
    <div class="modal-header"><h3>Import Items from Excel</h3>${closeX}</div>
    <div class="modal-body">
      <div class="alert alert-success" style="margin-bottom:16px">
        <strong>Expected columns:</strong> Device Type, Brand, Model, SKU, Description, Serial Number, IMEI, Color, RAM, Storage, Processor, WiFi/Cellular, Qty, Unit Price, Notes
      </div>
      <div class="form-group">
        <label>Select Excel File (.xlsx) *</label>
        <input type="file" id="poi-file" accept=".xlsx,.xls" style="width:100%">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="doImportPOItems(${poId})">Import</button>
    </div>`);
}

async function doImportPOItems(poId) {
  const file = document.getElementById('poi-file').files[0];
  if (!file) { showToast('Please select a file', 'error'); return; }
  const fd = new FormData(); fd.append('file', file);
  try {
    const r = await api('POST', `/api/purchase-orders/${poId}/import-items`, fd, true);
    showToast(`✓ Imported ${r.imported} items`);
    closeModal();
    await renderPODetail(S.po.currentPo);
  } catch(ex) { showToast(ex.message, 'error'); }
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function doBackupDownload() {
  const btn = document.getElementById('backup-btn');
  if (btn) { btn.textContent = 'Preparing…'; btn.disabled = true; }
  try {
    const resp = await fetch('/api/backup/download', { headers: { Authorization: 'Bearer ' + S.token } });
    if (!resp.ok) { const e = await resp.json(); throw new Error(e.error); }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0,10);
    a.href = url; a.download = `Tekhouz-Backup-${date}.xlsx`; a.click();
    URL.revokeObjectURL(url);
    showToast('Backup downloaded successfully', 'success');
  } catch(ex) {
    showToast('Backup failed: ' + ex.message, 'error');
  } finally {
    if (btn) { btn.textContent = 'Download Full Backup (.xlsx)'; btn.disabled = false; }
  }
}

async function renderSettings() {
  const el = document.getElementById('screen-settings');
  el.innerHTML = `<div class="screen-header"><h2>Settings</h2><p>Manage device catalog and application configuration</p></div><div style="text-align:center;padding:40px"><div class="loader"></div></div>`;
  try {
    const catalog = await api('GET', '/api/settings/catalog');
    // Seed vendors from defaults if none saved yet
    if (!catalog.vendors || !catalog.vendors.length) {
      catalog.vendors = [...VENDORS_DEFAULT];
      await api('PUT', '/api/settings/catalog', catalog);
    }
    S.catalog = catalog;
    renderSettingsUI(catalog);
  } catch(ex) {
    el.innerHTML += `<div class="alert alert-error">${ex.message}</div>`;
  }
}

function renderSettingsUI(catalog) {
  const el = document.getElementById('screen-settings');
  const allBrands = DEVICE_CATALOG.brands;

  const modelsHtml = allBrands.map(brand => {
    const builtIn = DEVICE_CATALOG.models[brand] || [];
    const custom = (catalog.models?.[brand] || []).filter(m => !builtIn.includes(m));
    const allModels = [...builtIn, ...custom];
    return `
      <div class="card" style="margin-bottom:16px">
        <div class="card-title">${brand}</div>
        <div id="models-list-${brand.replace(/\s+/g,'_')}" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
          ${allModels.map(m => `
            <span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:3px 8px;font-size:12px">
              ${esc(m)}
              ${!builtIn.includes(m)?`<button onclick="removeCustomModel('${esc(brand)}','${esc(m)}')" style="background:none;border:none;cursor:pointer;color:var(--muted);padding:0;font-size:14px;line-height:1" title="Remove">×</button>`:'<span style="color:var(--muted);font-size:10px"> ●</span>'}
            </span>`).join('')}
        </div>
        <div style="display:flex;gap:8px">
          <input type="text" id="new-model-${brand.replace(/\s+/g,'_')}" placeholder="Add new model…" style="flex:1;padding:6px 10px;border:1.5px solid var(--border);border-radius:var(--r);font-size:13px">
          <button class="btn btn-primary btn-sm" onclick="addCustomModel('${esc(brand)}')">Add</button>
        </div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="screen-header"><h2>Settings</h2><p>Manage device catalog and application configuration</p></div>

    ${S.user.role === 'admin' ? `
    <div class="card" style="margin-bottom:20px;border-left:4px solid var(--blue)">
      <div class="card-title" style="display:flex;align-items:center;gap:8px">
        <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Database Backup
      </div>
      <p style="color:var(--muted);font-size:13px;margin:4px 0 14px">Download a full export of all data — orders, inventory, purchase orders, testing results. Store safely after each import session.</p>
      <button class="btn btn-primary" onclick="doBackupDownload()" id="backup-btn">
        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download Full Backup (.xlsx)
      </button>
    </div>` : ''}

    <div class="card" style="margin-bottom:20px">
      <div class="card-title">Parts Vendors</div>
      <p style="color:var(--muted);font-size:12px;margin:0 0 10px">Vendors available in Parts Purchase Orders and Requisitions.</p>
      <div id="vendors-wrap" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
        ${(catalog.vendors||[]).map(v=>`
          <span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:3px 8px;font-size:12px">
            ${esc(v)}
            <button onclick="removeCatalogItem('vendors','${esc(v)}')" style="background:none;border:none;cursor:pointer;color:var(--muted);padding:0;font-size:14px;line-height:1" title="Remove">×</button>
          </span>`).join('')}
      </div>
      <div style="display:flex;gap:8px">
        <input type="text" id="new-vendor" placeholder="Add new vendor…" style="flex:1;padding:6px 10px;border:1.5px solid var(--border);border-radius:var(--r);font-size:13px">
        <button class="btn btn-primary btn-sm" onclick="addCatalogItem('vendors','new-vendor')">Add</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="card-title">Color Options</div>
      <div id="colors-wrap" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
        ${(catalog.colors||[]).map(c=>`
          <span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:3px 8px;font-size:12px">
            ${esc(c)}
            <button onclick="removeCatalogItem('colors','${esc(c)}')" style="background:none;border:none;cursor:pointer;color:var(--muted);padding:0;font-size:14px;line-height:1" title="Remove">×</button>
          </span>`).join('')}
      </div>
      <div style="display:flex;gap:8px">
        <input type="text" id="new-color" placeholder="Add new color…" style="flex:1;padding:6px 10px;border:1.5px solid var(--border);border-radius:var(--r);font-size:13px">
        <button class="btn btn-primary btn-sm" onclick="addCatalogItem('colors','new-color')">Add</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="card-title">RAM Options</div>
      <div id="ram-wrap" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
        ${(catalog.ram||[]).map(r=>`
          <span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:3px 8px;font-size:12px">
            ${esc(r)}
            <button onclick="removeCatalogItem('ram','${esc(r)}')" style="background:none;border:none;cursor:pointer;color:var(--muted);padding:0;font-size:14px;line-height:1" title="Remove">×</button>
          </span>`).join('')}
      </div>
      <div style="display:flex;gap:8px">
        <input type="text" id="new-ram" placeholder="e.g. 48GB" style="flex:1;padding:6px 10px;border:1.5px solid var(--border);border-radius:var(--r);font-size:13px">
        <button class="btn btn-primary btn-sm" onclick="addCatalogItem('ram','new-ram')">Add</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:20px">
      <div class="card-title">Storage Options</div>
      <div id="storage-wrap" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
        ${(catalog.storage||[]).map(s=>`
          <span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:3px 8px;font-size:12px">
            ${esc(s)}
            <button onclick="removeCatalogItem('storage','${esc(s)}')" style="background:none;border:none;cursor:pointer;color:var(--muted);padding:0;font-size:14px;line-height:1" title="Remove">×</button>
          </span>`).join('')}
      </div>
      <div style="display:flex;gap:8px">
        <input type="text" id="new-storage" placeholder="e.g. 8TB" style="flex:1;padding:6px 10px;border:1.5px solid var(--border);border-radius:var(--r);font-size:13px">
        <button class="btn btn-primary btn-sm" onclick="addCatalogItem('storage','new-storage')">Add</button>
      </div>
    </div>

    <div class="screen-header" style="margin-top:8px"><h2 style="font-size:16px">Device Models by Brand</h2><p style="font-size:12px">Built-in models (●) cannot be removed. Add custom models per brand.</p></div>
    ${modelsHtml}`;
}

async function saveCatalog() {
  try {
    await api('PUT', '/api/settings/catalog', S.catalog);
    showToast('✓ Catalog saved');
  } catch(ex) { showToast(ex.message, 'error'); }
}

function addCatalogItem(field, inputId) {
  const val = document.getElementById(inputId)?.value?.trim();
  if (!val) return;
  if (!S.catalog) S.catalog = { colors: [], ram: [], storage: [], models: {} };
  if (!S.catalog[field].includes(val)) {
    S.catalog[field].push(val);
    saveCatalog().then(() => renderSettingsUI(S.catalog));
  }
  document.getElementById(inputId).value = '';
}

function removeCatalogItem(field, val) {
  if (!S.catalog?.[field]) return;
  S.catalog[field] = S.catalog[field].filter(v => v !== val);
  saveCatalog().then(() => renderSettingsUI(S.catalog));
}

function addCustomModel(brand) {
  const key = brand.replace(/\s+/g,'_');
  const val = document.getElementById(`new-model-${key}`)?.value?.trim();
  if (!val) return;
  if (!S.catalog) S.catalog = { colors: [], ram: [], storage: [], models: {} };
  if (!S.catalog.models) S.catalog.models = {};
  if (!S.catalog.models[brand]) S.catalog.models[brand] = [];
  if (!S.catalog.models[brand].includes(val) && !(DEVICE_CATALOG.models[brand]||[]).includes(val)) {
    S.catalog.models[brand].push(val);
    saveCatalog().then(() => renderSettingsUI(S.catalog));
  }
  document.getElementById(`new-model-${key}`).value = '';
}

function removeCustomModel(brand, model) {
  if (!S.catalog?.models?.[brand]) return;
  S.catalog.models[brand] = S.catalog.models[brand].filter(m => m !== model);
  saveCatalog().then(() => renderSettingsUI(S.catalog));
}

// ─── RETURNS ───────────────────────────────────────────────────────────────────

const RETURN_FROM_OPTIONS = ['Back Market','Amazon','eBay','Walmart','BestBuy','BestBuy CA','Reebelo','Reebelo CA','Appzlogic'];
const RETURN_REASON_OPTIONS = ['Technical issue','Changed mind','Tekhouz shipment issue','Wrong item sent','Damaged in transit','Not as described','Missing accessories','Customer changed mind','Defective on arrival','Other'];
const CONDITION_OPTIONS = ['Unlocked','Locked','Passcode Locked','MDM Locked','Dead'];
const NEXT_ACTION_OPTIONS = ['Complete','Hold','N/A','Ops Action','Warehouse Action'];
const RESELL_ACTION_OPTIONS = ['Yes','No','Need to test','We can repair','Battery replaced','Locked'];
const FINAL_ACTION_OPTIONS = ['Same device sent back','Replacement sent','Back to inventory'];

const RETURN_STATUS_MAP = {
  awaiting_shipment: { label: 'Awaiting Shipment', color: '#d97706', bg: '#fffbeb' },
  received:          { label: 'Received',           color: '#0891b2', bg: '#ecfeff' },
  testing:           { label: 'Testing',            color: '#7c3aed', bg: '#faf5ff' },
  ops_review:        { label: 'Ops Review',         color: '#2563eb', bg: '#eff6ff' },
  resolved:          { label: 'Resolved',           color: '#16a34a', bg: '#f0fdf4' },
};

function returnStatusBadge(status) {
  const s = RETURN_STATUS_MAP[status] || { label: status || '—', color: '#64748b', bg: '#f1f5f9' };
  return `<span style="display:inline-flex;align-items:center;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600;color:${s.color};background:${s.bg};white-space:nowrap">${s.label}</span>`;
}

function returnGradeBadge(g) {
  if (!g) return '<span style="color:#94a3b8">—</span>';
  const colors = { A:'#16a34a', B:'#2563eb', C:'#d97706', D:'#dc2626' };
  const c = colors[g.toUpperCase()] || '#64748b';
  return `<span style="font-weight:700;color:${c}">${g}</span>`;
}

function testBadgeSmall(v) {
  if (!v || v === 'Not Tested') return `<span style="color:#94a3b8;font-size:11px">—</span>`;
  const c = v === 'Pass' ? '#16a34a' : v === 'Fail' ? '#dc2626' : '#64748b';
  return `<span style="color:${c};font-size:11px;font-weight:600">${v}</span>`;
}

function fmtDateShort(v) {
  if (!v) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number);
    return new Date(y, m-1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return v;
}

async function renderReturns() {
  const el = document.getElementById('screen-returns');
  el.innerHTML = `<div class="screen-header"><h2>Returns & Replacements</h2><p>Loading…</p></div><div style="text-align:center;padding:60px"><div class="loader"></div></div>`;
  try {
    const f = S.returns.filters;
    const qs = new URLSearchParams();
    if (f.status) qs.set('status', f.status);
    if (f.return_from) qs.set('return_from', f.return_from);
    if (f.search) qs.set('search', f.search);
    const data = await api('GET', '/api/returns?' + qs.toString());
    S.returns.list = data.returns;
    S.returns.stats = data.stats;
    _renderReturnsList(data);
  } catch (err) {
    el.innerHTML = `<div class="screen-header"><h2>Returns & Replacements</h2></div><div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

function _renderReturnsList(data) {
  const el = document.getElementById('screen-returns');
  const { returns, stats } = data;
  const f = S.returns.filters;

  const statCards = Object.entries(RETURN_STATUS_MAP).map(([key, s]) => {
    const cnt = stats[key] || 0;
    return `<div class="stat-card" style="border-left-color:${s.color};cursor:pointer" onclick="returnsFilterStatus('${key}')">
      <div class="stat-label">${s.label}</div>
      <div class="stat-value" style="color:${s.color}">${cnt}</div>
    </div>`;
  }).join('');

  const tableRows = returns.length ? returns.map(r => `
    <tr onclick="openReturnDetail(${r.id})" style="cursor:pointer">
      <td style="font-weight:600;color:var(--blue)">#${r.id}</td>
      <td>${returnStatusBadge(r.status)}</td>
      <td>${esc(r.return_from || '—')}</td>
      <td><span style="font-weight:600">${esc(r.order_id || '—')}</span></td>
      <td><span style="font-family:monospace;font-size:12px;color:var(--txt)">${esc(r.sku || '—')}</span></td>
      <td>${esc(r.customer_name || '—')}</td>
      <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.device_config_sent || '')}">${esc(r.device_config_sent || '—')}</td>
      <td>${esc(r.return_reason || '—')}</td>
      <td>${returnGradeBadge(r.grade)}</td>
      <td>${esc(r.final_action || '—')}</td>
      <td style="color:var(--muted);font-size:12px">${fmtDateShort(r.return_date)}</td>
    </tr>`).join('') : `<tr><td colspan="10"><div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 10h10a8 8 0 018 8v2M3 10l6 6M3 10l6-6"/></svg><p>No returns found</p></div></td></tr>`;

  el.innerHTML = `
  <div class="screen-header" style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px">
    <div><h2>Returns &amp; Replacements</h2><p style="color:var(--muted);font-size:13px;margin-top:3px">${data.total} total return${data.total !== 1 ? 's' : ''}</p></div>
    <button class="btn btn-primary" onclick="openReturnIntakeModal()">
      <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      New Return
    </button>
  </div>

  <div class="stats-grid" style="grid-template-columns:repeat(5,1fr)">${statCards}</div>

  <div class="toolbar">
    <div class="toolbar-left">
      <input type="text" class="search-input" placeholder="Search order ID, customer, device…" value="${esc(f.search)}" oninput="S.returns.filters.search=this.value" onkeydown="if(event.key==='Enter')renderReturns()" style="width:260px">
      <select onchange="S.returns.filters.return_from=this.value;renderReturns()">
        <option value="">All Marketplaces</option>
        ${RETURN_FROM_OPTIONS.map(o => `<option value="${esc(o)}" ${f.return_from===o?'selected':''}>${esc(o)}</option>`).join('')}
      </select>
      <select onchange="S.returns.filters.status=this.value;renderReturns()">
        <option value="">All Statuses</option>
        ${Object.entries(RETURN_STATUS_MAP).map(([k,s]) => `<option value="${k}" ${f.status===k?'selected':''}>${s.label}</option>`).join('')}
      </select>
    </div>
    <div class="toolbar-right">
      <button class="btn btn-outline btn-sm" onclick="S.returns.filters={status:'',return_from:'',search:''};renderReturns()">Clear</button>
    </div>
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>#</th><th>Status</th><th>From</th><th>Order ID</th><th>SKU</th><th>Customer</th>
        <th>Device Sent</th><th>Return Reason</th><th>Grade</th><th>Final Action</th><th>Return Date</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
    <div class="table-foot"><span>${returns.length} records</span></div>
  </div>`;
}

function returnsFilterStatus(status) {
  S.returns.filters.status = S.returns.filters.status === status ? '' : status;
  renderReturns();
}

// ─── Intake Modal ─────────────────────────────────────────────────────────────
function openReturnIntakeModal(prefill = {}) {
  const today = new Date().toISOString().split('T')[0];
  openModal(`
  <div class="modal-header">
    <h3>📦 New Return — Intake</h3>
    <button class="modal-close" onclick="closeModal()">✕</button>
  </div>
  <div class="modal-body">
    <div class="form-section">
      <div class="form-section-title">Order Information</div>
      <div class="form-grid form-grid-3" style="gap:14px">
        <div class="form-group">
          <label>Return From *</label>
          <select id="ri-return_from">
            <option value="">— Select Marketplace —</option>
            ${RETURN_FROM_OPTIONS.map(o => `<option value="${esc(o)}" ${prefill.return_from===o?'selected':''}>${esc(o)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Order ID</label>
          <input type="text" id="ri-order_id" value="${esc(prefill.order_id||'')}" placeholder="e.g. BM-123456">
        </div>
        <div class="form-group">
          <label>Return Date</label>
          <input type="date" id="ri-return_date" value="${prefill.return_date||today}">
        </div>
      </div>
      <div class="form-group" style="margin-top:14px">
        <label>SKU <span style="color:var(--red);font-weight:700">*</span> <span style="font-weight:400;color:var(--muted);text-transform:none;font-size:11px">— primary identifier for this return</span></label>
        <input type="text" id="ri-sku" value="${esc(prefill.sku||'')}" placeholder="e.g. iphone-14-pro-256gb-SG-A" style="font-family:monospace">
      </div>
      <div class="form-grid form-grid-2" style="gap:14px;margin-top:14px">
        <div class="form-group">
          <label>Customer Name</label>
          <input type="text" id="ri-customer_name" value="${esc(prefill.customer_name||'')}" placeholder="Full name">
        </div>
        <div class="form-group">
          <label>Tracking Number</label>
          <input type="text" id="ri-tracking_number" value="${esc(prefill.tracking_number||'')}" placeholder="Return tracking #">
        </div>
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title">Device & Return Reason</div>
      <div class="form-group" style="margin-bottom:14px">
        <label>Device Config Sent (what we shipped)</label>
        <input type="text" id="ri-device_config_sent" value="${esc(prefill.device_config_sent||'')}" placeholder="e.g. iPhone 14 Pro 256GB Space Black">
      </div>
      <div class="form-grid form-grid-2" style="gap:14px">
        <div class="form-group">
          <label>Return Reason</label>
          <select id="ri-return_reason">
            <option value="">— Select Reason —</option>
            ${RETURN_REASON_OPTIONS.map(o => `<option value="${esc(o)}" ${prefill.return_reason===o?'selected':''}>${esc(o)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Initial Status</label>
          <select id="ri-status">
            <option value="awaiting_shipment" ${(!prefill.status||prefill.status==='awaiting_shipment')?'selected':''}>Awaiting Shipment</option>
            <option value="received" ${prefill.status==='received'?'selected':''}>Received</option>
          </select>
        </div>
      </div>
      <div class="form-group" style="margin-top:14px">
        <label>Customer Complaint / Need</label>
        <textarea id="ri-customer_complaint" rows="3" placeholder="What the customer reported…">${esc(prefill.customer_complaint||'')}</textarea>
      </div>
    </div>
  </div>
  <div class="modal-footer">
    <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="saveReturnIntake(${prefill.id||0})">
      ${prefill.id ? 'Save Changes' : 'Create Return'}
    </button>
  </div>`);
}

async function saveReturnIntake(id = 0) {
  const body = {
    return_from: document.getElementById('ri-return_from').value,
    order_id: document.getElementById('ri-order_id').value.trim(),
    sku: document.getElementById('ri-sku').value.trim(),
    return_date: document.getElementById('ri-return_date').value,
    customer_name: document.getElementById('ri-customer_name').value.trim(),
    tracking_number: document.getElementById('ri-tracking_number').value.trim(),
    device_config_sent: document.getElementById('ri-device_config_sent').value.trim(),
    return_reason: document.getElementById('ri-return_reason').value,
    customer_complaint: document.getElementById('ri-customer_complaint').value.trim(),
    status: document.getElementById('ri-status').value,
  };
  if (!body.return_from) { alert('Please select a marketplace.'); return; }
  if (!body.sku) { alert('SKU is required — it is the primary identifier for this return.'); return; }
  try {
    if (id) {
      // preserve other fields
      const existing = S.returns.list.find(r => r.id === id) || {};
      await api('PUT', '/api/returns/' + id, { ...existing, ...body });
    } else {
      await api('POST', '/api/returns', body);
    }
    closeModal();
    showToast(id ? 'Return updated.' : 'Return created!');
    renderReturns();
  } catch (err) { alert(err.message); }
}

// ─── Detail / Full Edit Modal ─────────────────────────────────────────────────
async function openReturnDetail(id) {
  let r;
  try { r = await api('GET', '/api/returns/' + id); } catch (err) { alert(err.message); return; }

  const statusOpts = Object.entries(RETURN_STATUS_MAP).map(([k,s]) =>
    `<option value="${k}" ${r.status===k?'selected':''}>${s.label}</option>`).join('');

  const testField = (id, label, val) => `
    <div class="test-item">
      <label>${label}</label>
      <select id="${id}">
        <option value="Not Tested" ${(!val||val==='Not Tested')?'selected':''}>Not Tested</option>
        <option value="Pass" ${val==='Pass'?'selected':''}>Pass</option>
        <option value="Fail" ${val==='Fail'?'selected':''}>Fail</option>
        <option value="N/A" ${val==='N/A'?'selected':''}>N/A</option>
      </select>
    </div>`;

  openModal(`
  <div class="modal-header">
    <h3>Return #${r.id} — ${esc(r.order_id||'No Order ID')}</h3>
    <button class="modal-close" onclick="closeModal()">✕</button>
  </div>
  <div class="modal-body" style="font-size:13px">

    <!-- Status bar -->
    <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;background:#f8fafc;border-radius:8px;margin-bottom:20px;flex-wrap:wrap">
      <span style="font-weight:600;color:var(--muted);font-size:12px">STATUS:</span>
      <select id="rd-status" style="font-weight:600;border:none;background:transparent;font-size:13px;cursor:pointer;outline:none">${statusOpts}</select>
      <span style="margin-left:auto;color:var(--muted);font-size:11px">Created ${fmtDateShort(r.created_at?.split('T')[0]||'')} by ${esc(r.created_by||'—')}</span>
    </div>

    <!-- Section 1: Intake Info -->
    <div class="form-section">
      <div class="form-section-title">📦 Intake Information</div>
      <div class="form-group" style="margin-bottom:12px">
        <label>SKU <span style="color:var(--red)">*</span></label>
        <input type="text" id="rd-sku" value="${esc(r.sku||'')}" placeholder="e.g. iphone-14-pro-256gb-SG-A" style="font-family:monospace;font-weight:600">
      </div>
      <div class="form-grid form-grid-3" style="gap:12px">
        <div class="form-group">
          <label>Return From</label>
          <select id="rd-return_from">
            <option value="">—</option>
            ${RETURN_FROM_OPTIONS.map(o => `<option value="${esc(o)}" ${r.return_from===o?'selected':''}>${esc(o)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Order ID</label>
          <input type="text" id="rd-order_id" value="${esc(r.order_id||'')}">
        </div>
        <div class="form-group">
          <label>Return Date</label>
          <input type="date" id="rd-return_date" value="${r.return_date?r.return_date.split('T')[0]:''}">
        </div>
        <div class="form-group">
          <label>Customer Name</label>
          <input type="text" id="rd-customer_name" value="${esc(r.customer_name||'')}">
        </div>
        <div class="form-group">
          <label>Tracking Number</label>
          <input type="text" id="rd-tracking_number" value="${esc(r.tracking_number||'')}">
        </div>
        <div class="form-group">
          <label>Return Reason</label>
          <select id="rd-return_reason">
            <option value="">—</option>
            ${RETURN_REASON_OPTIONS.map(o => `<option value="${esc(o)}" ${r.return_reason===o?'selected':''}>${esc(o)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group" style="margin-top:12px">
        <label>Device Config Sent</label>
        <input type="text" id="rd-device_config_sent" value="${esc(r.device_config_sent||'')}" placeholder="What we originally shipped">
      </div>
      <div class="form-group" style="margin-top:12px">
        <label>Customer Complaint / Need</label>
        <textarea id="rd-customer_complaint" rows="2">${esc(r.customer_complaint||'')}</textarea>
      </div>
    </div>

    <!-- Section 2: Received / Testing -->
    <div class="form-section">
      <div class="form-section-title">🔬 Received &amp; Testing</div>
      <div class="form-grid form-grid-3" style="gap:12px;margin-bottom:12px">
        <div class="form-group">
          <label>Received Date</label>
          <input type="date" id="rd-received_date" value="${r.received_date?r.received_date.split('T')[0]:''}">
        </div>
        <div class="form-group">
          <label>Condition Received</label>
          <select id="rd-condition_received">
            <option value="">—</option>
            ${CONDITION_OPTIONS.map(o => `<option value="${esc(o)}" ${r.condition_received===o?'selected':''}>${esc(o)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Charger Included</label>
          <select id="rd-charger_included">
            <option value="">—</option>
            <option value="Yes" ${r.charger_included==='Yes'?'selected':''}>Yes</option>
            <option value="No" ${r.charger_included==='No'?'selected':''}>No</option>
          </select>
        </div>
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label>Device Config Received (what came back)</label>
        <input type="text" id="rd-device_config_received" value="${esc(r.device_config_received||'')}" placeholder="What was actually returned">
      </div>

      <div style="font-size:11px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Hardware Tests</div>
      <div class="test-grid">
        ${testField('rd-lcd_test','LCD Display', r.lcd_test)}
        ${testField('rd-touch_test','Touch / Digitizer', r.touch_test)}
        ${testField('rd-face_id_test','Face ID', r.face_id_test)}
        ${testField('rd-fingerprint_test','Fingerprint', r.fingerprint_test)}
        ${testField('rd-front_camera_test','Front Camera', r.front_camera_test)}
        ${testField('rd-rear_camera_test','Rear Camera', r.rear_camera_test)}
        ${testField('rd-speaker_test','Speaker', r.speaker_test)}
        ${testField('rd-mic_test','Microphone', r.mic_test)}
        ${testField('rd-wifi_test','Wi-Fi', r.wifi_test)}
        ${testField('rd-cellular_test','Cellular', r.cellular_test)}
        ${testField('rd-charging_test','Charging', r.charging_test)}
        <div class="test-item">
          <label>Battery Health %</label>
          <input type="number" id="rd-battery_health" value="${r.battery_health||''}" min="0" max="100" placeholder="e.g. 87" style="width:100%;padding:6px 8px;font-size:13px">
        </div>
      </div>
      <div class="form-grid form-grid-3" style="gap:12px;margin-top:12px">
        <div class="form-group">
          <label>Grade</label>
          <select id="rd-grade">
            <option value="">—</option>
            <option value="A" ${r.grade==='A'?'selected':''}>A — Like New</option>
            <option value="B" ${r.grade==='B'?'selected':''}>B — Good</option>
            <option value="C" ${r.grade==='C'?'selected':''}>C — Fair</option>
            <option value="D" ${r.grade==='D'?'selected':''}>D — Poor</option>
          </select>
        </div>
        <div class="form-group">
          <label>Tested By</label>
          <input type="text" id="rd-tested_by" value="${esc(r.tested_by||'')}">
        </div>
        <div class="form-group">
          <label>Test Date</label>
          <input type="date" id="rd-test_date" value="${r.test_date?r.test_date.split('T')[0]:''}">
        </div>
      </div>
      <div class="form-group" style="margin-top:12px">
        <label>Technician Notes</label>
        <textarea id="rd-tech_notes" rows="2">${esc(r.tech_notes||'')}</textarea>
      </div>
    </div>

    <!-- Section 2b: Media / Evidence -->
    <div class="form-section">
      <div class="form-section-title">📷 Photos &amp; Videos — Evidence</div>
      <div id="media-gallery-${r.id}" style="min-height:60px">
        <div style="text-align:center;padding:16px"><div class="loader"></div></div>
      </div>
      <div class="media-dropzone" id="media-dropzone-${r.id}" style="margin-top:12px"
           ondragover="event.preventDefault();this.classList.add('drag-over')"
           ondragleave="this.classList.remove('drag-over')"
           ondrop="handleMediaDrop(event,${r.id})">
        <input type="file" id="media-input-${r.id}" multiple accept="image/*,video/*"
               onchange="uploadReturnMedia(${r.id},this.files)">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"/>
        </svg>
        <p><strong>Click to upload</strong> or drag &amp; drop</p>
        <div class="dz-hint">Photos (JPG, PNG, HEIC) and Videos (MP4, MOV) • Max 200MB per file</div>
      </div>
      <div class="media-upload-progress" id="media-progress-${r.id}">⏳ Uploading…</div>
    </div>

    <!-- Section 3: Ops Decision -->
    <div class="form-section">
      <div class="form-section-title">✅ Ops Decision</div>
      <div class="form-grid form-grid-3" style="gap:12px">
        <div class="form-group">
          <label>Next Action Item</label>
          <select id="rd-next_action">
            <option value="">—</option>
            ${NEXT_ACTION_OPTIONS.map(o => `<option value="${esc(o)}" ${r.next_action===o?'selected':''}>${esc(o)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Status — Ops</label>
          <select id="rd-ops_status">
            <option value="">—</option>
            <option value="Yes" ${r.ops_status==='Yes'?'selected':''}>Yes</option>
            <option value="No" ${r.ops_status==='No'?'selected':''}>No</option>
            <option value="N/A" ${r.ops_status==='N/A'?'selected':''}>N/A</option>
          </select>
        </div>
        <div class="form-group">
          <label>Status — Warehouse</label>
          <select id="rd-warehouse_status">
            <option value="">—</option>
            <option value="Yes" ${r.warehouse_status==='Yes'?'selected':''}>Yes</option>
            <option value="No" ${r.warehouse_status==='No'?'selected':''}>No</option>
            <option value="N/A" ${r.warehouse_status==='N/A'?'selected':''}>N/A</option>
          </select>
        </div>
        <div class="form-group">
          <label>Resell / Action</label>
          <select id="rd-resell_action">
            <option value="">—</option>
            ${RESELL_ACTION_OPTIONS.map(o => `<option value="${esc(o)}" ${r.resell_action===o?'selected':''}>${esc(o)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Final Action</label>
          <select id="rd-final_action">
            <option value="">—</option>
            ${FINAL_ACTION_OPTIONS.map(o => `<option value="${esc(o)}" ${r.final_action===o?'selected':''}>${esc(o)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Ops Review Date</label>
          <input type="date" id="rd-ops_review_date" value="${r.ops_review_date?r.ops_review_date.split('T')[0]:''}">
        </div>
      </div>
      <div class="form-group" style="margin-top:12px">
        <label>Ops Notes</label>
        <textarea id="rd-ops_notes" rows="2">${esc(r.ops_notes||'')}</textarea>
      </div>
    </div>
  </div>
  <div class="modal-footer" style="justify-content:space-between">
    <button class="btn btn-danger btn-sm admin-only" onclick="deleteReturn(${r.id})">Delete</button>
    <div style="display:flex;gap:10px">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveReturnDetail(${r.id})">Save Changes</button>
    </div>
  </div>`);

  // show/hide delete based on role
  document.querySelectorAll('#modal-box .admin-only').forEach(el => {
    el.style.display = (S.user?.role === 'admin') ? '' : 'none';
  });

  // Load media gallery
  loadReturnMedia(r.id);
}

async function saveReturnDetail(id) {
  const g = id => document.getElementById(id)?.value || null;
  const body = {
    status: g('rd-status'),
    return_from: g('rd-return_from'),
    order_id: document.getElementById('rd-order_id').value.trim() || null,
    sku: document.getElementById('rd-sku').value.trim() || null,
    return_date: g('rd-return_date'),
    customer_name: document.getElementById('rd-customer_name').value.trim() || null,
    tracking_number: document.getElementById('rd-tracking_number').value.trim() || null,
    return_reason: g('rd-return_reason'),
    customer_complaint: document.getElementById('rd-customer_complaint').value.trim() || null,
    device_config_sent: document.getElementById('rd-device_config_sent').value.trim() || null,
    received_date: g('rd-received_date'),
    device_config_received: document.getElementById('rd-device_config_received').value.trim() || null,
    condition_received: g('rd-condition_received'),
    charger_included: g('rd-charger_included'),
    lcd_test: g('rd-lcd_test') || 'Not Tested',
    touch_test: g('rd-touch_test') || 'Not Tested',
    battery_health: document.getElementById('rd-battery_health').value || null,
    face_id_test: g('rd-face_id_test') || 'Not Tested',
    fingerprint_test: g('rd-fingerprint_test') || 'Not Tested',
    front_camera_test: g('rd-front_camera_test') || 'Not Tested',
    rear_camera_test: g('rd-rear_camera_test') || 'Not Tested',
    speaker_test: g('rd-speaker_test') || 'Not Tested',
    mic_test: g('rd-mic_test') || 'Not Tested',
    wifi_test: g('rd-wifi_test') || 'Not Tested',
    cellular_test: g('rd-cellular_test') || 'Not Tested',
    charging_test: g('rd-charging_test') || 'Not Tested',
    grade: g('rd-grade'),
    tech_notes: document.getElementById('rd-tech_notes').value.trim() || null,
    tested_by: document.getElementById('rd-tested_by').value.trim() || null,
    test_date: g('rd-test_date'),
    next_action: g('rd-next_action'),
    ops_status: g('rd-ops_status'),
    warehouse_status: g('rd-warehouse_status'),
    resell_action: g('rd-resell_action'),
    final_action: g('rd-final_action'),
    ops_review_date: g('rd-ops_review_date'),
    ops_notes: document.getElementById('rd-ops_notes').value.trim() || null,
    ops_reviewed_by: S.user?.username || null,
  };
  try {
    await api('PUT', '/api/returns/' + id, body);
    closeModal();
    showToast('Return saved!');
    renderReturns();
  } catch (err) { alert(err.message); }
}

async function deleteReturn(id) {
  if (!confirm('Delete this return? This cannot be undone.')) return;
  try {
    await api('DELETE', '/api/returns/' + id);
    closeModal();
    showToast('Return deleted.');
    renderReturns();
  } catch (err) { alert(err.message); }
}

// ─── RETURN MEDIA ──────────────────────────────────────────────────────────────

function fmtFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function isVideo(mimetype) {
  return mimetype && mimetype.startsWith('video/');
}

async function loadReturnMedia(returnId) {
  const gallery = document.getElementById('media-gallery-' + returnId);
  if (!gallery) return;
  try {
    const files = await api('GET', '/api/returns/' + returnId + '/media');
    renderMediaGallery(returnId, files);
  } catch (err) {
    gallery.innerHTML = `<p style="color:var(--muted);font-size:12px;text-align:center">Could not load media: ${esc(err.message)}</p>`;
  }
}

function renderMediaGallery(returnId, files) {
  const gallery = document.getElementById('media-gallery-' + returnId);
  if (!gallery) return;

  if (!files || files.length === 0) {
    gallery.innerHTML = `<p style="color:var(--muted);font-size:12px;text-align:center;padding:12px 0">No photos or videos uploaded yet. Use the upload area below.</p>`;
    return;
  }

  const thumbs = files.map(f => {
    const url = '/uploads/returns/' + f.filename;
    const isVid = isVideo(f.mimetype);
    const thumb = isVid
      ? `<div class="vid-thumb" onclick="openLightbox('${url}','${esc(f.original_name||f.filename)}','${esc(f.caption||'')}',true)">
           <svg fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
         </div>`
      : `<img src="${url}" alt="${esc(f.original_name||f.filename)}" loading="lazy"
             onclick="openLightbox('${url}','${esc(f.original_name||f.filename)}','${esc(f.caption||'')}',false)">`;

    const canDelete = (S.user?.username === f.uploaded_by || S.user?.role === 'admin');
    return `
      <div class="media-thumb" id="media-file-${f.id}">
        ${thumb}
        <div class="media-actions">
          ${canDelete ? `<button class="media-del-btn" onclick="deleteReturnMedia(${f.id},${returnId})" title="Delete">✕</button>` : ''}
        </div>
        <div class="media-thumb-info">
          <div class="media-thumb-name" title="${esc(f.original_name||f.filename)}">${esc(f.original_name||f.filename)}</div>
          <div class="media-thumb-meta">${fmtFileSize(f.size)} · ${esc(f.uploaded_by||'')}</div>
        </div>
        ${f.caption ? `<div class="media-caption" title="${esc(f.caption)}">${esc(f.caption)}</div>` : ''}
      </div>`;
  }).join('');

  gallery.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
      <span style="font-size:12px;color:var(--muted);font-weight:600">${files.length} file${files.length!==1?'s':''} uploaded</span>
    </div>
    <div class="media-grid">${thumbs}</div>`;
}

async function uploadReturnMedia(returnId, files) {
  if (!files || files.length === 0) return;
  const progress = document.getElementById('media-progress-' + returnId);
  const dropzone = document.getElementById('media-dropzone-' + returnId);
  if (progress) { progress.style.display = 'block'; progress.textContent = `⏳ Uploading ${files.length} file${files.length>1?'s':''}…`; }
  if (dropzone) dropzone.style.opacity = '0.5';

  try {
    const formData = new FormData();
    for (const f of files) formData.append('files', f);

    const opts = { method: 'POST', headers: {} };
    if (S.token) opts.headers['Authorization'] = 'Bearer ' + S.token;
    opts.body = formData;

    const r = await fetch('/api/returns/' + returnId + '/media', opts);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Upload failed');

    if (progress) { progress.textContent = `✅ ${data.uploaded} file${data.uploaded>1?'s':''} uploaded!`; setTimeout(() => { progress.style.display = 'none'; }, 3000); }
    showToast(`${data.uploaded} file${data.uploaded>1?'s':''} uploaded!`);
    // Reset file input
    const inp = document.getElementById('media-input-' + returnId);
    if (inp) inp.value = '';
    loadReturnMedia(returnId);
  } catch (err) {
    if (progress) { progress.textContent = `❌ Upload failed: ${err.message}`; progress.style.background = '#fef2f2'; progress.style.color = 'var(--red)'; setTimeout(() => { progress.style.display='none'; progress.style.background=''; progress.style.color=''; }, 4000); }
    showToast(err.message, 'error');
  } finally {
    if (dropzone) dropzone.style.opacity = '1';
  }
}

function handleMediaDrop(event, returnId) {
  event.preventDefault();
  const dropzone = document.getElementById('media-dropzone-' + returnId);
  if (dropzone) dropzone.classList.remove('drag-over');
  const files = event.dataTransfer.files;
  if (files.length) uploadReturnMedia(returnId, files);
}

async function deleteReturnMedia(mediaId, returnId) {
  if (!confirm('Delete this file? This cannot be undone.')) return;
  try {
    await api('DELETE', '/api/returns/media/' + mediaId);
    const el = document.getElementById('media-file-' + mediaId);
    if (el) el.remove();
    // refresh count
    loadReturnMedia(returnId);
    showToast('File deleted.');
  } catch (err) { alert(err.message); }
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────
function openLightbox(url, name, caption, isVid) {
  const lb = document.getElementById('lightbox');
  const content = document.getElementById('lightbox-content');
  const capEl = document.getElementById('lightbox-caption');
  if (!lb || !content) return;

  if (isVid) {
    content.innerHTML = `<video src="${url}" controls autoplay style="max-width:92vw;max-height:88vh;border-radius:8px;outline:none" onclick="event.stopPropagation()"></video>`;
  } else {
    content.innerHTML = `<img src="${url}" alt="${esc(name)}" style="max-width:92vw;max-height:88vh;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,.5)" onclick="event.stopPropagation()">`;
  }

  if (caption) { capEl.textContent = caption; capEl.style.display = ''; }
  else capEl.style.display = 'none';

  lb.style.display = 'flex';
  document.addEventListener('keydown', _lightboxKeyHandler);
}

function closeLightbox() {
  const lb = document.getElementById('lightbox');
  if (!lb) return;
  lb.style.display = 'none';
  const content = document.getElementById('lightbox-content');
  if (content) content.innerHTML = '';
  document.removeEventListener('keydown', _lightboxKeyHandler);
}

function _lightboxKeyHandler(e) {
  if (e.key === 'Escape') closeLightbox();
}

// ─── Parts Requisition ────────────────────────────────────────────────────────

// Device brands used in parts requisition (granular, not just Apple/Samsung)
const PARTS_DEVICE_BRANDS = [
  'iPhone','iPad','iPad Mini','iPad Air','iPad Pro',
  'MacBook Air','MacBook Pro','Samsung','Google','Other'
];

// Return models from catalog for a given device brand
function reqModelsForBrand(brand) {
  const builtIn = DEVICE_CATALOG.models || {};
  const custom  = S.catalog?.models || {};

  // Merge + deduplicate helper
  const merge = (...keys) => {
    const all = [];
    keys.forEach(k => {
      (builtIn[k] || []).forEach(m => { if (!all.includes(m)) all.push(m); });
      (custom[k]  || []).forEach(m => { if (!all.includes(m)) all.push(m); });
    });
    return all.sort();
  };

  const apple   = merge('Apple');
  const samsung = merge('Samsung');
  const google  = merge('Google');

  switch (brand) {
    case 'iPhone':
      return apple.filter(m => /iphone/i.test(m));
    case 'iPad':
      return apple.filter(m => /^ipad\s*(\(|\d)/i.test(m) && !/mini|air|pro/i.test(m));
    case 'iPad Mini':
      return apple.filter(m => /ipad mini/i.test(m));
    case 'iPad Air':
      return apple.filter(m => /ipad air/i.test(m));
    case 'iPad Pro':
      return apple.filter(m => /ipad pro/i.test(m));
    case 'MacBook Air':
      return apple.filter(m => /macbook air/i.test(m));
    case 'MacBook Pro':
      return apple.filter(m => /macbook pro/i.test(m));
    case 'Samsung':
      return samsung;
    case 'Google':
      return google;
    default:
      return [];
  }
}

// Detect brand from a model string (for prefilling when editing)
function detectBrandFromModel(model) {
  if (!model) return '';
  const m = model.toLowerCase();
  if (/iphone/.test(m))       return 'iPhone';
  if (/ipad pro/.test(m))     return 'iPad Pro';
  if (/ipad air/.test(m))     return 'iPad Air';
  if (/ipad mini/.test(m))    return 'iPad Mini';
  if (/^ipad/.test(m))        return 'iPad';
  if (/macbook air/.test(m))  return 'MacBook Air';
  if (/macbook pro/.test(m))  return 'MacBook Pro';
  if (/galaxy|samsung/.test(m)) return 'Samsung';
  if (/pixel/.test(m))        return 'Google';
  return 'Other';
}

const PART_TYPES = [
  { code: 'BTRY', label: 'Battery',              colorNA: true  },
  { code: 'SCRN', label: 'Screen (LCD+Touch)',    colorNA: false },
  { code: 'DIGI', label: 'Digitizer (Touch Only)',colorNA: false },
  { code: 'HOUS', label: 'Housing / Back Cover',  colorNA: false },
  { code: 'CAMR', label: 'Camera',                colorNA: false },
  { code: 'SPKR', label: 'Speaker',               colorNA: true  },
  { code: 'CHRG', label: 'Charging Port',         colorNA: true  },
  { code: 'OTHR', label: 'Other',                 colorNA: false },
];

const PART_CATEGORIES = [
  'iPhone Parts','iPad Parts','iPad Pro Parts','iPad Air Parts',
  'MacBook Air Parts','MacBook Pro Parts','Samsung Parts','Other Parts'
];

const REQ_STATUSES = ['Requested','Approved','Converted to PO','Rejected','Cancelled'];

const WAREHOUSE_LOCATIONS = ['Milpitas 741','San Jose 100','Fremont 200','Remote'];

const REQ_STATUS_STYLE = {
  'Requested':       { bg:'#fffbeb', color:'#d97706' },
  'Approved':        { bg:'#eff6ff', color:'#2563eb' },
  'Converted to PO': { bg:'#f0fdf4', color:'#16a34a' },
  'Rejected':        { bg:'#fef2f2', color:'#dc2626' },
  'Cancelled':       { bg:'#f1f5f9', color:'#64748b' },
};

function reqStatusBadge(s) {
  const st = REQ_STATUS_STYLE[s] || { bg:'#f1f5f9', color:'#64748b' };
  return `<span class="badge" style="background:${st.bg};color:${st.color}">${esc(s||'Requested')}</span>`;
}

function reqPriorityBadge(p) {
  if (p === 'Urgent') return `<span class="badge" style="background:#fef2f2;color:#dc2626">Urgent</span>`;
  return `<span class="badge" style="background:#f1f5f9;color:#64748b">Normal</span>`;
}

function inferPartCategory(model) {
  if (!model) return '';
  const m = model.toLowerCase();
  if (m.includes('ipad pro'))  return 'iPad Pro Parts';
  if (m.includes('ipad air'))  return 'iPad Air Parts';
  if (m.includes('ipad'))      return 'iPad Parts';
  if (m.includes('iphone'))    return 'iPhone Parts';
  if (m.includes('macbook air'))  return 'MacBook Air Parts';
  if (m.includes('macbook pro'))  return 'MacBook Pro Parts';
  if (m.includes('macbook'))   return 'MacBook Air Parts';
  if (m.includes('galaxy') || m.includes('samsung')) return 'Samsung Parts';
  return 'Other Parts';
}

function buildSku(typeCode, model, color, quality) {
  const t = typeCode || 'OTHR';
  const m = model || 'Unknown';
  const c = color || 'NA';
  const q = quality || 'OEM';
  return `${t}-${m}-${c}-${q}`;
}

function allCatalogModels() {
  if (!S.catalog || !S.catalog.models) return [];
  const groups = [];
  for (const [brand, models] of Object.entries(S.catalog.models)) {
    if (Array.isArray(models) && models.length) groups.push({ brand, models });
  }
  return groups;
}

function catalogModelOptions(selectedModel) {
  const groups = allCatalogModels();
  if (!groups.length) return `<option value="">— No models in catalog —</option>`;
  return groups.map(g =>
    `<optgroup label="${esc(g.brand)}">${g.models.map(m =>
      `<option value="${esc(m)}" ${m === selectedModel ? 'selected' : ''}>${esc(m)}</option>`
    ).join('')}</optgroup>`
  ).join('');
}

// ─── Render screen ────────────────────────────────────────────────────────────
async function renderRequisitions() {
  const el = document.getElementById('screen-requisitions');
  el.innerHTML = `<div class="screen-header"><h2>Parts Requisitions</h2><p style="color:var(--muted)">Loading…</p></div><div style="text-align:center;padding:60px"><div class="loader"></div></div>`;
  try {
    const f = S.requisitions.filters;
    const qs = new URLSearchParams();
    if (f.status)       qs.set('status', f.status);
    if (f.priority)     qs.set('priority', f.priority);
    if (f.part_category) qs.set('part_category', f.part_category);
    if (f.search)       qs.set('search', f.search);
    const data = await api('GET', '/api/requisitions?' + qs.toString());
    S.requisitions.list  = data.requisitions;
    S.requisitions.stats = data.stats;
    _renderRequisitionsList(data);
  } catch (err) {
    el.innerHTML = `<div class="screen-header"><h2>Parts Requisitions</h2></div><div class="alert alert-error">${esc(err.message)}</div>`;
  }
}

function _renderRequisitionsList(data) {
  const el = document.getElementById('screen-requisitions');
  const { requisitions, stats, total } = data;
  const f = S.requisitions.filters;

  const statDefs = [
    { key: null,              label: 'Total',          color: 'var(--blue)',  value: total },
    { key: 'Requested',       label: 'Requested',      color: '#d97706',      value: stats['Requested'] || 0 },
    { key: 'Approved',        label: 'Approved',       color: '#2563eb',      value: stats['Approved'] || 0 },
    { key: 'Converted to PO', label: 'Converted to PO',color: '#16a34a',     value: stats['Converted to PO'] || 0 },
    { key: 'Rejected',        label: 'Rejected',       color: '#dc2626',      value: stats['Rejected'] || 0 },
  ];

  const statCards = statDefs.map(d => `
    <div class="stat-card" style="border-left-color:${d.color};cursor:pointer" onclick="${d.key ? `S.requisitions.filters.status='${d.key}';renderRequisitions()` : `S.requisitions.filters.status='';renderRequisitions()`}">
      <div class="stat-label">${d.label}</div>
      <div class="stat-value" style="color:${d.color}">${d.value}</div>
    </div>`).join('');

  const rows = requisitions.length ? requisitions.map(r => `
    <tr onclick="openRequisitionDetail(${r.id})" style="cursor:pointer">
      <td style="font-weight:600;color:var(--blue)">#${r.id}</td>
      <td>${reqStatusBadge(r.status)}</td>
      <td>${reqPriorityBadge(r.priority)}</td>
      <td class="mono" style="color:var(--blue)">${esc(r.part_sku || '—')}</td>
      <td>${esc(r.model_compatibility || '—')}</td>
      <td>${esc(r.part_category || '—')}</td>
      <td style="text-align:center;font-weight:600">${r.quantity_needed ?? '—'}</td>
      <td style="text-align:center;color:var(--muted)">${r.actual_ordered != null ? r.actual_ordered : '—'}</td>
      <td>${esc(r.requested_by || '—')}</td>
      <td style="color:var(--muted);font-size:12px">${r.request_date ? r.request_date.slice(0,10) : '—'}</td>
      <td style="display:flex;gap:6px;align-items:center">
        <button class="btn btn-outline btn-sm" onclick="event.stopPropagation();openRequisitionDetail(${r.id})">Edit</button>
        ${r.status === 'Approved' ? `<button class="btn btn-sm" style="background:#7c3aed;color:#fff" onclick="event.stopPropagation();convertReqToPO(${r.id})">→ PO</button>` : ''}
      </td>
    </tr>`).join('')
    : `<tr><td colspan="11"><div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="12" y2="16"/></svg>
        <p>No requisitions found</p></div></td></tr>`;

  el.innerHTML = `
  <div class="screen-header" style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px">
    <div><h2>Parts Requisitions</h2><p style="color:var(--muted);font-size:13px;margin-top:3px">${total} total requisition${total !== 1 ? 's' : ''}</p></div>
    <button class="btn btn-primary" onclick="openRequisitionModal()">
      <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      New Request
    </button>
  </div>

  <div class="stats-grid" style="grid-template-columns:repeat(5,1fr)">${statCards}</div>

  <div class="toolbar">
    <div class="toolbar-left">
      <input type="text" class="search-input" placeholder="Search SKU, model, requested by…"
        value="${esc(f.search)}"
        oninput="S.requisitions.filters.search=this.value"
        onkeydown="if(event.key==='Enter')renderRequisitions()"
        style="width:260px">
      <select onchange="S.requisitions.filters.status=this.value;renderRequisitions()">
        <option value="">All Statuses</option>
        ${REQ_STATUSES.map(s => `<option value="${esc(s)}" ${f.status===s?'selected':''}>${esc(s)}</option>`).join('')}
      </select>
      <select onchange="S.requisitions.filters.priority=this.value;renderRequisitions()">
        <option value="">All Priorities</option>
        <option value="Urgent" ${f.priority==='Urgent'?'selected':''}>Urgent</option>
        <option value="Normal" ${f.priority==='Normal'?'selected':''}>Normal</option>
      </select>
      <select onchange="S.requisitions.filters.part_category=this.value;renderRequisitions()">
        <option value="">All Categories</option>
        ${PART_CATEGORIES.map(c => `<option value="${esc(c)}" ${f.part_category===c?'selected':''}>${esc(c)}</option>`).join('')}
      </select>
    </div>
    <div class="toolbar-right">
      <button class="btn btn-outline btn-sm" onclick="S.requisitions.filters={status:'',priority:'',part_category:'',search:''};renderRequisitions()">Clear</button>
    </div>
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>#</th><th>Status</th><th>Priority</th><th>Part SKU</th><th>Model</th>
        <th>Category</th><th>Qty Needed</th><th>Actual Ordered</th>
        <th>Requested By</th><th>Date</th><th>Actions</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ─── New/Edit modal ───────────────────────────────────────────────────────────
function openRequisitionModal(prefill = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const typeOpts = PART_TYPES.map(t =>
    `<option value="${t.code}" ${prefill.part_type === t.code ? 'selected' : ''}>${t.code} — ${t.label}</option>`
  ).join('');
  const colorOpts = ['NA','Black','White','Silver','Gold','Rose Gold','Blue','Green','Purple','Red','Yellow'].map(c =>
    `<option value="${c}" ${(prefill.color || 'NA') === c ? 'selected' : ''}>${c}</option>`
  ).join('');
  const warehouseOpts = WAREHOUSE_LOCATIONS.map(w =>
    `<option value="${w}" ${prefill.warehouse_location === w ? 'selected' : ''}>${w}</option>`
  ).join('');

  openModal(`
    <div class="modal-header">
      <h3>New Parts Request</h3>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-grid form-grid-2" style="margin-bottom:14px">
        <div class="form-group">
          <label>Request Date</label>
          <input type="date" id="rq-date" value="${prefill.request_date || today}">
        </div>
        <div class="form-group">
          <label>Priority</label>
          <select id="rq-priority">
            <option value="Normal" ${(prefill.priority||'Normal')==='Normal'?'selected':''}>Normal</option>
            <option value="Urgent" ${prefill.priority==='Urgent'?'selected':''}>Urgent</option>
          </select>
        </div>
      </div>

      <div class="form-group" style="margin-bottom:14px">
        <label>Requested By</label>
        <input type="text" id="rq-requested-by" value="${esc(prefill.requested_by || (S.user?.username || ''))}">
      </div>

      <div class="form-grid form-grid-2" style="margin-bottom:14px">
        <div class="form-group">
          <label>Part Type</label>
          <select id="rq-part-type" onchange="reqTypeChanged()">
            <option value="">— Select —</option>
            ${typeOpts}
          </select>
        </div>
        <div class="form-group">
          <label>Quality</label>
          <select id="rq-quality" onchange="reqUpdateSkuPreview()">
            <option value="OEM" ${(prefill.quality||'OEM')==='OEM'?'selected':''}>OEM</option>
            <option value="Aftermarket" ${prefill.quality==='Aftermarket'?'selected':''}>Aftermarket</option>
          </select>
        </div>
      </div>

      <div class="form-grid form-grid-3" style="margin-bottom:14px">
        <div class="form-group">
          <label>Device Brand</label>
          <select id="rq-brand" onchange="reqBrandChanged()">
            <option value="">— Select Brand —</option>
            ${PARTS_DEVICE_BRANDS.map(b => `<option value="${esc(b)}" ${detectBrandFromModel(prefill.model_compatibility)===b?'selected':''}>${esc(b)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Model Compatibility</label>
          <select id="rq-model" onchange="reqModelChanged()">
            <option value="">— Select brand first —</option>
          </select>
        </div>
        <div class="form-group">
          <label>Color</label>
          <select id="rq-color" onchange="reqUpdateSkuPreview()">
            ${colorOpts}
          </select>
        </div>
      </div>

      <div class="form-group" style="margin-bottom:14px">
        <label>Part Category</label>
        <select id="rq-part-category">
          <option value="">— Select —</option>
          ${PART_CATEGORIES.map(c => `<option value="${esc(c)}" ${(prefill.part_category||'')===c?'selected':''}>${esc(c)}</option>`).join('')}
        </select>
      </div>

      <div style="background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:8px;padding:12px 16px;margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">SKU Preview</div>
        <div id="rq-sku-preview" style="font-family:'SF Mono',Menlo,monospace;font-size:15px;font-weight:700;color:#1e40af;letter-spacing:.03em">${esc(prefill.part_sku || 'OTHR-Unknown-NA-OEM')}</div>
      </div>

      <div class="form-grid form-grid-2" style="margin-bottom:14px">
        <div class="form-group">
          <label>Quantity Needed</label>
          <input type="number" id="rq-qty" value="${prefill.quantity_needed || 1}" min="1">
        </div>
        <div class="form-group">
          <label>Warehouse Location</label>
          <select id="rq-warehouse">
            <option value="">— Select —</option>
            ${warehouseOpts}
          </select>
        </div>
      </div>

      <div class="form-group">
        <label>Notes</label>
        <textarea id="rq-notes" rows="3">${esc(prefill.notes || '')}</textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveRequisition(0)">Submit Request</button>
    </div>
  `);

  // Trigger initial state
  if (prefill.part_type) reqTypeChanged(true);
  // Populate models for pre-filled brand
  reqBrandChanged(prefill.model_compatibility);
}

function reqBrandChanged(preselect) {
  const brand = document.getElementById('rq-brand')?.value || '';
  const modelSel = document.getElementById('rq-model');
  if (!modelSel) return;
  const models = reqModelsForBrand(brand);
  if (!models.length) {
    modelSel.innerHTML = '<option value="">— Select brand first —</option>';
  } else {
    modelSel.innerHTML = '<option value="">— Select model —</option>' +
      models.map(m => `<option value="${esc(m)}" ${(preselect||'')===m?'selected':''}>${esc(m)}</option>`).join('');
  }
  if (!preselect) reqUpdateSkuPreview();
}

function reqTypeChanged(skipPreview) {
  const typeCode = document.getElementById('rq-part-type')?.value;
  const pt = PART_TYPES.find(t => t.code === typeCode);
  const colorSel = document.getElementById('rq-color');
  if (!colorSel) return;
  if (pt && pt.colorNA) {
    colorSel.value = 'NA';
    colorSel.disabled = true;
  } else {
    colorSel.disabled = false;
  }
  if (!skipPreview) reqUpdateSkuPreview();
}

function reqModelChanged() {
  const model = document.getElementById('rq-model')?.value;
  const catSel = document.getElementById('rq-part-category');
  if (catSel && model) {
    const cat = inferPartCategory(model);
    if (cat) catSel.value = cat;
  }
  reqUpdateSkuPreview();
}

function reqUpdateSkuPreview() {
  const typeCode = document.getElementById('rq-part-type')?.value || 'OTHR';
  const model    = document.getElementById('rq-model')?.value || 'Unknown';
  const color    = document.getElementById('rq-color')?.value || 'NA';
  const quality  = document.getElementById('rq-quality')?.value || 'OEM';
  const sku = buildSku(typeCode, model, color, quality);
  const preview = document.getElementById('rq-sku-preview');
  if (preview) preview.textContent = sku;
}

async function saveRequisition(id) {
  const typeCode = document.getElementById('rq-part-type')?.value;
  const model    = document.getElementById('rq-model')?.value;
  const color    = document.getElementById('rq-color')?.value || 'NA';
  const quality  = document.getElementById('rq-quality')?.value || 'OEM';
  const sku = buildSku(typeCode || 'OTHR', model || 'Unknown', color, quality);

  const body = {
    request_date:        document.getElementById('rq-date')?.value,
    requested_by:        document.getElementById('rq-requested-by')?.value?.trim(),
    part_type:           typeCode,
    part_category:       document.getElementById('rq-part-category')?.value,
    model_compatibility: model,
    color,
    quality,
    part_sku:            sku,
    quantity_needed:     parseInt(document.getElementById('rq-qty')?.value) || 1,
    priority:            document.getElementById('rq-priority')?.value || 'Normal',
    status:              'Requested',
    warehouse_location:  document.getElementById('rq-warehouse')?.value,
    notes:               document.getElementById('rq-notes')?.value?.trim(),
  };

  if (!body.request_date) return alert('Request date is required.');
  if (!body.requested_by) return alert('Requested By is required.');

  try {
    if (id) {
      await api('PUT', '/api/requisitions/' + id, body);
      showToast('Requisition updated.');
    } else {
      await api('POST', '/api/requisitions', body);
      showToast('Request submitted.');
    }
    closeModal();
    renderRequisitions();
  } catch (err) { alert(err.message); }
}

// ─── Detail / Edit modal ──────────────────────────────────────────────────────
async function openRequisitionDetail(id) {
  openModal(`<div class="modal-body" style="text-align:center;padding:40px"><div class="loader"></div></div>`);
  try {
    const r = await api('GET', '/api/requisitions/' + id);
    _showRequisitionDetail(r);
  } catch (err) { alert(err.message); closeModal(); }
}

function _showRequisitionDetail(r) {
  const isAdmin = S.user?.role === 'admin';
  const showActualOrdered = ['Approved','Converted to PO'].includes(r.status);
  const typeOpts = PART_TYPES.map(t =>
    `<option value="${t.code}" ${r.part_type === t.code ? 'selected' : ''}>${t.code} — ${t.label}</option>`
  ).join('');
  const colorOpts = ['NA','Black','White','Silver','Gold','Rose Gold','Blue','Green','Purple','Red','Yellow'].map(c =>
    `<option value="${c}" ${(r.color || 'NA') === c ? 'selected' : ''}>${c}</option>`
  ).join('');
  const warehouseOpts = WAREHOUSE_LOCATIONS.map(w =>
    `<option value="${w}" ${r.warehouse_location === w ? 'selected' : ''}>${w}</option>`
  ).join('');

  openModal(`
    <div class="modal-header">
      <div>
        <h3 style="display:flex;align-items:center;gap:10px">
          Requisition #${r.id}
          ${reqStatusBadge(r.status)}
          ${reqPriorityBadge(r.priority)}
        </h3>
        <div style="font-family:'SF Mono',Menlo,monospace;font-size:13px;color:var(--blue);margin-top:4px">${esc(r.part_sku || '')}</div>
      </div>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">

      <div class="form-section-title">Status &amp; Priority</div>
      <div class="form-grid form-grid-2" style="margin-bottom:14px">
        <div class="form-group">
          <label>Status</label>
          <select id="rd-status" onchange="rdStatusChanged()">
            ${REQ_STATUSES.map(s => `<option value="${esc(s)}" ${r.status===s?'selected':''}>${esc(s)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Priority</label>
          <select id="rd-priority">
            <option value="Normal" ${(r.priority||'Normal')==='Normal'?'selected':''}>Normal</option>
            <option value="Urgent" ${r.priority==='Urgent'?'selected':''}>Urgent</option>
          </select>
        </div>
      </div>

      <div id="rd-actual-ordered-wrap" style="margin-bottom:14px;display:${showActualOrdered?'block':'none'}">
        <div class="form-group">
          <label>Actual Ordered</label>
          <input type="number" id="rd-actual-ordered" value="${r.actual_ordered != null ? r.actual_ordered : ''}" min="0" style="width:100%">
        </div>
      </div>

      <div id="rd-po-details-wrap" style="margin-bottom:14px;display:${r.status==='Converted to PO'&&!r.po_id?'block':'none'}">
        <div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:8px;padding:12px 16px">
          <div style="font-size:11px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">🛒 PO Details</div>
          <div class="form-grid form-grid-2">
            <div class="form-group">
              <label>Vendor <span style="color:var(--red)">*</span></label>
              <select id="rd-po-vendor">
                <option value="">— Select Vendor —</option>
                ${getCatalogVendors().map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Expected Delivery</label>
              <input type="date" id="rd-po-delivery" value="">
            </div>
          </div>
        </div>
      </div>

      ${r.po_id ? `<div style="margin-bottom:14px;padding:10px 14px;background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:8px;font-size:13px">
        📦 Linked to <strong>PO #${r.po_id}</strong> — <a href="#" onclick="event.preventDefault();closeModal();renderPartsPO();" style="color:var(--blue)">View in Parts PO</a>
      </div>` : ''}

      <div class="form-section-title" style="margin-top:8px">Part Details</div>
      <div class="form-grid form-grid-2" style="margin-bottom:14px">
        <div class="form-group">
          <label>Part Type</label>
          <select id="rd-part-type" onchange="rdTypeChanged()">
            <option value="">— Select —</option>
            ${typeOpts}
          </select>
        </div>
        <div class="form-group">
          <label>Quality</label>
          <select id="rd-quality" onchange="rdUpdateSku()">
            <option value="OEM" ${(r.quality||'OEM')==='OEM'?'selected':''}>OEM</option>
            <option value="Aftermarket" ${r.quality==='Aftermarket'?'selected':''}>Aftermarket</option>
          </select>
        </div>
      </div>

      <div class="form-grid form-grid-3" style="margin-bottom:14px">
        <div class="form-group">
          <label>Device Brand</label>
          <select id="rd-brand" onchange="rdBrandChanged()">
            <option value="">— Select Brand —</option>
            ${PARTS_DEVICE_BRANDS.map(b => `<option value="${esc(b)}" ${detectBrandFromModel(r.model_compatibility)===b?'selected':''}>${esc(b)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Model Compatibility</label>
          <select id="rd-model" onchange="rdModelChanged()">
            <option value="">— Select brand first —</option>
          </select>
        </div>
        <div class="form-group">
          <label>Color</label>
          <select id="rd-color" onchange="rdUpdateSku()">
            ${colorOpts}
          </select>
        </div>
      </div>

      <div class="form-group" style="margin-bottom:14px">
        <label>Part Category</label>
        <select id="rd-part-category">
          <option value="">— Select —</option>
          ${PART_CATEGORIES.map(c => `<option value="${esc(c)}" ${(r.part_category||'')===c?'selected':''}>${esc(c)}</option>`).join('')}
        </select>
      </div>

      <div style="background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:8px;padding:12px 16px;margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">SKU Preview</div>
        <div id="rd-sku-preview" style="font-family:'SF Mono',Menlo,monospace;font-size:15px;font-weight:700;color:#1e40af;letter-spacing:.03em">${esc(r.part_sku || '')}</div>
      </div>

      <div class="form-section-title">Request Info</div>
      <div class="form-grid form-grid-2" style="margin-bottom:14px">
        <div class="form-group">
          <label>Request Date</label>
          <input type="date" id="rd-date" value="${r.request_date ? r.request_date.slice(0,10) : ''}">
        </div>
        <div class="form-group">
          <label>Quantity Needed</label>
          <input type="number" id="rd-qty" value="${r.quantity_needed || 1}" min="1">
        </div>
      </div>

      <div class="form-grid form-grid-2" style="margin-bottom:14px">
        <div class="form-group">
          <label>Requested By</label>
          <input type="text" id="rd-requested-by" value="${esc(r.requested_by || '')}">
        </div>
        <div class="form-group">
          <label>Warehouse Location</label>
          <select id="rd-warehouse">
            <option value="">— Select —</option>
            ${warehouseOpts}
          </select>
        </div>
      </div>

      <div class="form-group">
        <label>Notes</label>
        <textarea id="rd-notes" rows="3">${esc(r.notes || '')}</textarea>
      </div>

      ${r.created_by ? `<div style="margin-top:12px;font-size:11px;color:var(--muted)">Created by ${esc(r.created_by)} · ${r.created_at ? r.created_at.slice(0,10) : ''}</div>` : ''}
    </div>
    <div class="modal-footer">
      ${isAdmin ? `<button class="btn btn-danger" onclick="deleteRequisition(${r.id})" style="margin-right:auto">Delete</button>` : ''}
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveRequisitionDetail(${r.id})">Save Changes</button>
    </div>
  `);

  // init color disable state + brand cascade
  rdTypeChanged(true);
  rdBrandChanged(r.model_compatibility);
}

function rdStatusChanged() {
  const status = document.getElementById('rd-status')?.value;
  const wrap = document.getElementById('rd-actual-ordered-wrap');
  if (wrap) wrap.style.display = ['Approved','Converted to PO'].includes(status) ? 'block' : 'none';
  // Show PO details section only when newly setting to Converted to PO (no existing po_id)
  const poWrap = document.getElementById('rd-po-details-wrap');
  if (poWrap) poWrap.style.display = status === 'Converted to PO' ? 'block' : 'none';
}

function rdTypeChanged(skipPreview) {
  const typeCode = document.getElementById('rd-part-type')?.value;
  const pt = PART_TYPES.find(t => t.code === typeCode);
  const colorSel = document.getElementById('rd-color');
  if (!colorSel) return;
  if (pt && pt.colorNA) {
    colorSel.value = 'NA';
    colorSel.disabled = true;
  } else {
    colorSel.disabled = false;
  }
  if (!skipPreview) rdUpdateSku();
}

function rdBrandChanged(preselect) {
  const brand = document.getElementById('rd-brand')?.value || '';
  const modelSel = document.getElementById('rd-model');
  if (!modelSel) return;
  const models = reqModelsForBrand(brand);
  if (!models.length) {
    modelSel.innerHTML = '<option value="">— Select brand first —</option>';
  } else {
    modelSel.innerHTML = '<option value="">— Select model —</option>' +
      models.map(m => `<option value="${esc(m)}" ${(preselect||'')===m?'selected':''}>${esc(m)}</option>`).join('');
  }
  if (!preselect) rdUpdateSku();
}

function rdModelChanged() {
  const model = document.getElementById('rd-model')?.value;
  const catSel = document.getElementById('rd-part-category');
  if (catSel && model) {
    const cat = inferPartCategory(model);
    if (cat) catSel.value = cat;
  }
  rdUpdateSku();
}

function rdUpdateSku() {
  const typeCode = document.getElementById('rd-part-type')?.value || 'OTHR';
  const model    = document.getElementById('rd-model')?.value || 'Unknown';
  const color    = document.getElementById('rd-color')?.value || 'NA';
  const quality  = document.getElementById('rd-quality')?.value || 'OEM';
  const sku = buildSku(typeCode, model, color, quality);
  const preview = document.getElementById('rd-sku-preview');
  if (preview) preview.textContent = sku;
}

async function saveRequisitionDetail(id) {
  const typeCode = document.getElementById('rd-part-type')?.value;
  const model    = document.getElementById('rd-model')?.value;
  const color    = document.getElementById('rd-color')?.value || 'NA';
  const quality  = document.getElementById('rd-quality')?.value || 'OEM';
  const status   = document.getElementById('rd-status')?.value || 'Requested';
  const sku = buildSku(typeCode || 'OTHR', model || 'Unknown', color, quality);

  const actualOrderedVal = document.getElementById('rd-actual-ordered')?.value;

  const body = {
    request_date:        document.getElementById('rd-date')?.value,
    requested_by:        document.getElementById('rd-requested-by')?.value?.trim(),
    part_type:           typeCode,
    part_category:       document.getElementById('rd-part-category')?.value,
    model_compatibility: model,
    color,
    quality,
    part_sku:            sku,
    quantity_needed:     parseInt(document.getElementById('rd-qty')?.value) || 1,
    actual_ordered:      actualOrderedVal !== '' && actualOrderedVal != null ? parseInt(actualOrderedVal) : null,
    priority:            document.getElementById('rd-priority')?.value || 'Normal',
    status,
    warehouse_location:  document.getElementById('rd-warehouse')?.value,
    notes:               document.getElementById('rd-notes')?.value?.trim(),
  };

  if (!body.request_date) return alert('Request date is required.');
  if (!body.requested_by) return alert('Requested By is required.');

  // If converting to PO and no PO exists yet, validate vendor is selected
  const poDetailsVisible = document.getElementById('rd-po-details-wrap')?.style.display !== 'none';
  const poVendor = document.getElementById('rd-po-vendor')?.value || '';
  const poDelivery = document.getElementById('rd-po-delivery')?.value || null;
  if (status === 'Converted to PO' && poDetailsVisible && !poVendor) {
    return alert('Please select a vendor to create the Purchase Order.');
  }

  try {
    await api('PUT', '/api/requisitions/' + id, body);

    // Create the PO if status was just set to Converted to PO
    if (status === 'Converted to PO' && poDetailsVisible && poVendor) {
      const poResult = await api('POST', '/api/parts-pos/from-requisition/' + id, {
        vendor: poVendor,
        expected_delivery: poDelivery
      });
      showToast('Requisition updated & PO #' + poResult.id + ' created!');
    } else {
      showToast('Requisition updated.');
    }
    closeModal();
    renderRequisitions();
    if (S.screen === 'parts-po') renderPartsPO();
  } catch (err) { alert(err.message); }
}

async function deleteRequisition(id) {
  if (!confirm(`Delete Requisition #${id}? This cannot be undone.`)) return;
  try {
    await api('DELETE', '/api/requisitions/' + id);
    showToast('Requisition deleted.');
    closeModal();
    renderRequisitions();
  } catch (err) { alert(err.message); }
}

// ─── Parts PO Constants ────────────────────────────────────────────────────────
const PO_STATUSES = ['Open','Partial','Closed','Cancelled'];
const SO_STATUSES = ['Open','In Progress','Completed','Cancelled'];
const REPAIR_TYPES = ['Battery Replacement','Screen Replacement','Digitizer Replacement','Housing Replacement','Camera Repair','Speaker Repair','Charging Port Repair','Water Damage','Other'];
const VENDORS_DEFAULT = ['Rewa','Maya Parts','Mobilesentrix','APTO','Loacal_CA','Other'];
function getCatalogVendors() {
  return (S.catalog?.vendors?.length) ? S.catalog.vendors : VENDORS_DEFAULT;
}
const WAREHOUSES = ['Milpitas 741','Other'];

// ─── Badge Helpers ──────────────────────────────────────────────────────────────
function poStatusBadge(s) {
  const map = { 'Open': 'background:#fef3c7;color:#92400e', 'Partial': 'background:#dbeafe;color:#1d4ed8', 'Closed': 'background:#dcfce7;color:#15803d', 'Cancelled': 'background:#f1f5f9;color:#374151' };
  return `<span class="badge" style="${map[s]||'background:#f1f5f9;color:#374151'}">${esc(s||'Open')}</span>`;
}
function soStatusBadge(s) {
  const map = { 'Open': 'background:#fef3c7;color:#92400e', 'In Progress': 'background:#dbeafe;color:#1d4ed8', 'Completed': 'background:#dcfce7;color:#15803d', 'Cancelled': 'background:#f1f5f9;color:#374151' };
  return `<span class="badge" style="${map[s]||'background:#f1f5f9;color:#374151'}">${esc(s||'Open')}</span>`;
}
function stockLevelBadge(qty) {
  qty = Number(qty) || 0;
  if (qty <= 0) return `<span class="badge" style="background:#fee2e2;color:#b91c1c">${qty}</span>`;
  if (qty <= 5) return `<span class="badge" style="background:#fef3c7;color:#92400e">${qty}</span>`;
  return `<span class="badge" style="background:#dcfce7;color:#15803d">${qty}</span>`;
}

// ─── Convert Req → PO ──────────────────────────────────────────────────────────
function convertReqToPO(reqId) {
  const vendorOpts = getCatalogVendors().map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  const today = new Date().toISOString().slice(0,10);
  openModal(`
    <div class="modal-header">
      <h3>Convert Req #${reqId} → Purchase Order</h3>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group" style="margin-bottom:14px">
        <label>Vendor <span style="color:var(--red)">*</span></label>
        <select id="ctp-vendor">
          <option value="">— Select Vendor —</option>
          ${vendorOpts}
        </select>
      </div>
      <div class="form-group" style="margin-bottom:14px">
        <label>Expected Delivery Date</label>
        <input type="date" id="ctp-delivery" value="">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="doConvertReqToPO(${reqId})">Create PO</button>
    </div>
  `);
}

async function doConvertReqToPO(reqId) {
  const vendor = document.getElementById('ctp-vendor')?.value;
  if (!vendor) return alert('Please select a vendor.');
  const expected_delivery = document.getElementById('ctp-delivery')?.value || null;
  try {
    const r = await api('POST', '/api/parts-pos/from-requisition/' + reqId, { vendor, expected_delivery });
    showToast('PO #' + r.id + ' created!');
    closeModal();
    renderRequisitions();
    if (S.screen === 'parts-po') renderPartsPO();
  } catch (err) { alert(err.message); }
}

// ─── Parts PO Items Editor (shared) ────────────────────────────────────────────
function poItemsTableHtml(items = []) {
  const rows = items.map((it, i) => `
    <tr id="po-item-row-${i}">
      <td><input type="text" class="poi-sku" value="${esc(it.part_sku||'')}" style="width:100%;font-family:monospace;font-size:12px" placeholder="BTRY-iPhone13-NA-OEM"></td>
      <td><input type="number" class="poi-qty" value="${it.quantity_ordered||1}" min="1" style="width:60px" oninput="updatePOTotal()"></td>
      <td><input type="number" class="poi-rxd" value="${it.received_quantity||0}" min="0" style="width:60px"></td>
      <td><input type="number" class="poi-price" value="${it.unit_price||0}" min="0" step="0.01" style="width:80px" oninput="updatePOTotal()"></td>
      <td style="text-align:right;font-size:12px;font-weight:600;white-space:nowrap;color:var(--blue)">$<span class="poi-line-total">${((it.quantity_ordered||1)*(it.unit_price||0)).toFixed(2)}</span></td>
      <td><button class="btn btn-danger btn-sm btn-icon" onclick="removePOItemRow(${i});updatePOTotal()" title="Remove">✕</button></td>
    </tr>`).join('');
  return `
    <table style="width:100%;border-collapse:collapse;font-size:13px" id="po-items-table">
      <thead><tr style="background:#f8fafc">
        <th style="padding:6px 8px;text-align:left;font-size:11px;color:var(--muted);font-weight:600">Part SKU</th>
        <th style="padding:6px 8px;text-align:left;font-size:11px;color:var(--muted);font-weight:600">Qty Ord.</th>
        <th style="padding:6px 8px;text-align:left;font-size:11px;color:var(--muted);font-weight:600">Rcvd</th>
        <th style="padding:6px 8px;text-align:left;font-size:11px;color:var(--muted);font-weight:600">Unit ($)</th>
        <th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted);font-weight:600">Line Total</th>
        <th style="padding:6px 8px"></th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr style="background:#eff6ff;border-top:2px solid #bfdbfe">
        <td colspan="4" style="padding:8px;font-size:12px;font-weight:700;color:#1d4ed8;text-align:right">TOTAL PO AMOUNT</td>
        <td style="padding:8px;text-align:right;font-size:14px;font-weight:800;color:#1d4ed8">$<span id="po-grand-total">${items.reduce((s,it)=>s+(it.quantity_ordered||1)*(it.unit_price||0),0).toFixed(2)}</span></td>
        <td></td>
      </tr></tfoot>
    </table>`;
}
function updatePOTotal() {
  const qtys   = document.querySelectorAll('.poi-qty');
  const prices  = document.querySelectorAll('.poi-price');
  const lineTotals = document.querySelectorAll('.poi-line-total');
  let grand = 0;
  for (let i = 0; i < qtys.length; i++) {
    const q = parseFloat(qtys[i]?.value) || 0;
    const p = parseFloat(prices[i]?.value) || 0;
    const line = q * p;
    grand += line;
    if (lineTotals[i]) lineTotals[i].textContent = line.toFixed(2);
  }
  const grandEl = document.getElementById('po-grand-total');
  if (grandEl) grandEl.textContent = grand.toFixed(2);
}
function addPOItemRow() {
  const tbody = document.querySelector('#po-items-table tbody');
  if (!tbody) return;
  const i = tbody.rows.length;
  const tr = document.createElement('tr');
  tr.id = 'po-item-row-' + i;
  tr.innerHTML = `
    <td><input type="text" class="poi-sku" value="" style="width:100%;font-family:monospace;font-size:12px" placeholder="BTRY-iPhone13-NA-OEM"></td>
    <td><input type="number" class="poi-qty" value="1" min="1" style="width:60px" oninput="updatePOTotal()"></td>
    <td><input type="number" class="poi-rxd" value="0" min="0" style="width:60px"></td>
    <td><input type="number" class="poi-price" value="0" min="0" step="0.01" style="width:80px" oninput="updatePOTotal()"></td>
    <td style="text-align:right;font-size:12px;font-weight:600;color:var(--blue)">$<span class="poi-line-total">0.00</span></td>
    <td><button class="btn btn-danger btn-sm btn-icon" onclick="this.closest('tr').remove();updatePOTotal()" title="Remove">✕</button></td>`;
  tbody.appendChild(tr);
}
function removePOItemRow(i) {
  const row = document.getElementById('po-item-row-' + i);
  if (row) row.remove();
}
function collectPOItems() {
  const skus = document.querySelectorAll('.poi-sku');
  const qtys = document.querySelectorAll('.poi-qty');
  const rxds = document.querySelectorAll('.poi-rxd');
  const prices = document.querySelectorAll('.poi-price');
  const items = [];
  for (let i = 0; i < skus.length; i++) {
    const sku = skus[i].value.trim();
    if (!sku) continue;
    items.push({ part_sku: sku, quantity_ordered: parseInt(qtys[i]?.value)||1, received_quantity: parseInt(rxds[i]?.value)||0, unit_price: parseFloat(prices[i]?.value)||0 });
  }
  return items;
}

// ─── renderPartsPO ──────────────────────────────────────────────────────────────
async function renderPartsPO() {
  const el = document.getElementById('screen-parts-po');
  el.innerHTML = `<div class="screen-header"><h2>Parts Purchase Orders</h2><p style="color:var(--muted);font-size:13px">Loading…</p></div><div style="text-align:center;padding:40px"><div class="loader"></div></div>`;
  try {
    const f = S.partspo.filters;
    const qs = new URLSearchParams();
    if (f.status) qs.set('status', f.status);
    if (f.vendor) qs.set('vendor', f.vendor);
    if (f.search) qs.set('search', f.search);
    const data = await api('GET', '/api/parts-pos?' + qs.toString());
    S.partspo.list = data.pos;
    S.partspo.stats = data.stats;
    _renderPartsPOList(data);
  } catch (err) {
    el.innerHTML = `<div class="alert alert-error">Failed to load: ${esc(err.message)}</div>`;
  }
}

function _renderPartsPOList(data) {
  const el = document.getElementById('screen-parts-po');
  const { pos, stats, total } = data;
  const f = S.partspo.filters;
  const statCards = [
    { label: 'Total POs', value: total, color: 'blue', key: '' },
    { label: 'Open', value: stats['Open'] || 0, color: 'amber', key: 'Open' },
    { label: 'Partial', value: stats['Partial'] || 0, color: 'blue', key: 'Partial' },
    { label: 'Closed', value: stats['Closed'] || 0, color: 'green', key: 'Closed' },
  ].map(d => `
    <div class="stat-card ${d.color}" style="cursor:pointer" onclick="S.partspo.filters.status='${d.key}';renderPartsPO()">
      <div class="stat-label">${d.label}</div>
      <div class="stat-value">${d.value}</div>
    </div>`).join('');

  const rows = pos.length ? pos.map(p => {
    const ordQty  = parseInt(p.total_ordered)  || 0;
    const rxdQty  = parseInt(p.total_received) || 0;
    const pct     = ordQty > 0 ? Math.round(rxdQty / ordQty * 100) : 0;
    const isActive = !['Closed','Cancelled'].includes(p.status);
    const rxdColor = rxdQty >= ordQty && ordQty > 0 ? '#15803d' : rxdQty > 0 ? '#1d4ed8' : 'var(--muted)';
    return `
    <tr onclick="openPartsPODetail(${p.id})" style="cursor:pointer">
      <td style="font-weight:600;color:var(--blue)">#${p.id}</td>
      <td>${poStatusBadge(p.status)}</td>
      <td>${esc(p.vendor)}</td>
      <td style="text-align:center;font-weight:600">${ordQty}</td>
      <td style="text-align:center">
        <div style="font-weight:700;color:${rxdColor}">${rxdQty}</div>
        ${ordQty > 0 ? `<div style="margin-top:3px;height:4px;background:#e2e8f0;border-radius:2px;width:60px;margin-inline:auto">
          <div style="height:4px;border-radius:2px;width:${pct}%;background:${rxdQty>=ordQty?'#16a34a':'#3b82f6'}"></div>
        </div>` : ''}
      </td>
      <td style="text-align:right;font-weight:600;color:var(--txt)">$${parseFloat(p.total_amount||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
      <td>${fmtDate(p.order_date)}</td>
      <td>${p.expected_delivery ? fmtDate(p.expected_delivery) : '<span style="color:var(--muted)">—</span>'}</td>
      <td style="color:var(--muted);font-size:12px">${esc(p.warehouse_destination || '—')}</td>
      <td style="white-space:nowrap">
        ${isActive ? `<button class="btn btn-success btn-sm" onclick="event.stopPropagation();openReceivePOModal(${p.id})" style="margin-right:6px">Receive</button>` : ''}
        <button class="btn btn-outline btn-sm" onclick="event.stopPropagation();openPartsPODetail(${p.id})">View</button>
      </td>
    </tr>`;
  }).join('')
    : `<tr><td colspan="10"><div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><p>No purchase orders found</p></div></td></tr>`;

  el.innerHTML = `
  <div class="screen-header" style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px">
    <div><h2>Parts Purchase Orders</h2><p style="color:var(--muted);font-size:13px;margin-top:3px">${total} total PO${total !== 1 ? 's' : ''}</p></div>
    <button class="btn btn-primary" onclick="openPartsPOModal()">
      <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      New PO
    </button>
  </div>
  <div class="stats-grid" style="grid-template-columns:repeat(4,1fr)">${statCards}</div>
  <div class="toolbar">
    <div class="toolbar-left">
      <input type="text" class="search-input" placeholder="Search PO# or vendor…" value="${esc(f.search)}"
        oninput="S.partspo.filters.search=this.value"
        onkeydown="if(event.key==='Enter')renderPartsPO()" style="width:220px">
      <select onchange="S.partspo.filters.vendor=this.value;renderPartsPO()">
        <option value="">All Vendors</option>
        ${getCatalogVendors().map(v => `<option value="${esc(v)}" ${f.vendor===v?'selected':''}>${esc(v)}</option>`).join('')}
      </select>
      <select onchange="S.partspo.filters.status=this.value;renderPartsPO()">
        <option value="">All Statuses</option>
        ${PO_STATUSES.map(s => `<option value="${esc(s)}" ${f.status===s?'selected':''}>${esc(s)}</option>`).join('')}
      </select>
      <button class="btn btn-outline btn-sm" onclick="S.partspo.filters={status:'',vendor:'',search:''};renderPartsPO()">Clear</button>
    </div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>PO #</th><th>Status</th><th>Vendor</th>
        <th style="text-align:center">Ordered Qty</th>
        <th style="text-align:center">Received Qty</th>
        <th style="text-align:right">Total ($)</th>
        <th>Order Date</th><th>Expected Delivery</th><th>Warehouse</th><th>Actions</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="table-foot">${total} record${total !== 1 ? 's' : ''}</div>
  </div>`;
}

// ─── openPartsPOModal ───────────────────────────────────────────────────────────
function openPartsPOModal(prefill = {}) {
  const today = new Date().toISOString().slice(0, 10);
  openModal(`
    <div class="modal-header">
      <h3>New Parts Purchase Order</h3>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-section">
        <div class="form-section-title">PO Header</div>
        <div class="form-grid form-grid-2">
          <div class="form-group">
            <label>Vendor *</label>
            <select id="po-vendor">
              ${getCatalogVendors().map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Warehouse</label>
            <select id="po-warehouse">
              ${WAREHOUSES.map(w => `<option value="${esc(w)}" ${w==='Milpitas 741'?'selected':''}>${esc(w)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>Order Date *</label>
            <input type="date" id="po-order-date" value="${today}">
          </div>
          <div class="form-group">
            <label>Expected Delivery</label>
            <input type="date" id="po-expected-delivery">
          </div>
        </div>
        <div class="form-group" style="margin-top:10px">
          <label>Notes</label>
          <textarea id="po-notes" rows="2"></textarea>
        </div>
      </div>
      <div class="form-section">
        <div class="form-section-title">Line Items</div>
        <div id="po-items-wrap">${poItemsTableHtml([{ part_sku: '', quantity_ordered: 1, received_quantity: 0, unit_price: 0 }])}</div>
        <button class="btn btn-outline btn-sm mt8" onclick="addPOItemRow()">+ Add Part</button>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveNewPO()">Create PO</button>
    </div>`);
}

async function saveNewPO() {
  const vendor = document.getElementById('po-vendor')?.value;
  const order_date = document.getElementById('po-order-date')?.value;
  const expected_delivery = document.getElementById('po-expected-delivery')?.value;
  const warehouse_destination = document.getElementById('po-warehouse')?.value;
  const notes = document.getElementById('po-notes')?.value?.trim();
  if (!vendor || !order_date) return alert('Vendor and Order Date are required.');
  const items = collectPOItems();
  try {
    const r = await api('POST', '/api/parts-pos', { vendor, order_date, expected_delivery: expected_delivery || null, warehouse_destination, notes, items });
    showToast('PO #' + r.id + ' created!');
    closeModal();
    renderPartsPO();
  } catch (err) { alert(err.message); }
}

// ─── openPartsPODetail ──────────────────────────────────────────────────────────
async function openPartsPODetail(id) {
  openModal(`<div class="modal-body" style="text-align:center;padding:40px"><div class="loader"></div></div>`);
  try {
    const po = await api('GET', '/api/parts-pos/' + id);
    const isAdmin = S.user?.role === 'admin';
    const totalOrdered = (po.items || []).reduce((s, i) => s + (i.quantity_ordered || 0), 0);
    const totalReceived = (po.items || []).reduce((s, i) => s + (i.received_quantity || 0), 0);
    const totalAmount = (po.items || []).reduce((s, i) => s + (i.quantity_ordered || 0) * (i.unit_price || 0), 0);
    const itemRows = (po.items || []).map((it, idx) => `
      <tr>
        <td class="mono" style="font-size:12px">${esc(it.part_sku)}</td>
        <td style="text-align:center">${it.quantity_ordered}</td>
        <td style="text-align:center"><input type="number" id="rxd-${it.id}" value="${it.received_quantity||0}" min="0" max="${it.quantity_ordered}" style="width:60px;text-align:center"></td>
        <td style="text-align:right">$${parseFloat(it.unit_price||0).toFixed(2)}</td>
        <td style="text-align:right;font-weight:600;color:var(--blue)">$${((it.quantity_ordered||0)*(it.unit_price||0)).toFixed(2)}</td>
        <td>${it.received_quantity >= it.quantity_ordered ? '<span class="badge" style="background:#dcfce7;color:#15803d">Done</span>' : ''}</td>
      </tr>`).join('');

    openModal(`
      <div class="modal-header">
        <h3>PO #${po.id} — ${esc(po.vendor)} ${poStatusBadge(po.status)}</h3>
        <button class="modal-close" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-section">
          <div class="form-section-title">Header</div>
          <div class="form-grid form-grid-2">
            <div class="form-group"><label>Vendor</label>
              <select id="dpod-vendor">
                ${getCatalogVendors().map(v => `<option value="${esc(v)}" ${po.vendor===v?'selected':''}>${esc(v)}</option>`).join('')}
                ${!getCatalogVendors().includes(po.vendor) && po.vendor ? `<option value="${esc(po.vendor)}" selected>${esc(po.vendor)}</option>` : ''}
              </select>
            </div>
            <div class="form-group"><label>Warehouse</label>
              <select id="dpod-warehouse">${WAREHOUSES.map(w => `<option value="${esc(w)}" ${po.warehouse_destination===w?'selected':''}>${esc(w)}</option>`).join('')}</select>
            </div>
            <div class="form-group"><label>Order Date</label><input type="date" id="dpod-order-date" value="${(po.order_date||'').slice(0,10)}"></div>
            <div class="form-group"><label>Expected Delivery</label><input type="date" id="dpod-exp-delivery" value="${(po.expected_delivery||'').slice(0,10)}"></div>
          </div>
          ${isAdmin ? `
          <div class="form-group" style="margin-top:10px">
            <label>Status (Admin)</label>
            <select id="dpod-status">${PO_STATUSES.map(s => `<option value="${esc(s)}" ${po.status===s?'selected':''}>${esc(s)}</option>`).join('')}</select>
          </div>` : ''}
          <div class="form-group" style="margin-top:10px"><label>Notes</label><textarea id="dpod-notes" rows="2">${esc(po.notes||'')}</textarea></div>
        </div>
        <div class="form-section">
          <div class="form-section-title">Line Items — ${totalReceived}/${totalOrdered} received</div>
          ${(po.items || []).length ? `
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead><tr style="background:#f8fafc">
                <th style="padding:6px 8px;text-align:left;font-size:11px;color:var(--muted);font-weight:600">Part SKU</th>
                <th style="padding:6px 8px;text-align:center;font-size:11px;color:var(--muted);font-weight:600">Ordered</th>
                <th style="padding:6px 8px;text-align:center;font-size:11px;color:var(--muted);font-weight:600">Received</th>
                <th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted);font-weight:600">Unit ($)</th>
                <th style="padding:6px 8px;text-align:right;font-size:11px;color:var(--muted);font-weight:600">Line Total</th>
                <th></th>
              </tr></thead>
              <tbody>${itemRows}</tbody>
              <tfoot><tr style="background:#eff6ff;border-top:2px solid #bfdbfe">
                <td colspan="4" style="padding:8px;font-size:12px;font-weight:700;color:#1d4ed8;text-align:right">TOTAL PO AMOUNT</td>
                <td style="padding:8px;text-align:right;font-size:15px;font-weight:800;color:#1d4ed8">$${totalAmount.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                <td></td>
              </tr></tfoot>
            </table>
          </div>
          <div style="margin-top:10px;display:flex;gap:8px">
            <button class="btn btn-success btn-sm" onclick="markAllReceived(${JSON.stringify(po.items||[]).replace(/"/g,'&quot;')})">Mark All Received</button>
          </div>` : '<p style="color:var(--muted);font-size:13px">No line items.</p>'}
        </div>
      </div>
      <div class="modal-footer">
        ${isAdmin ? `<button class="btn btn-danger" onclick="deletePO(${po.id})">Delete</button>` : ''}
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="savePartsPODetail(${po.id}, ${JSON.stringify(po.items||[]).replace(/"/g,'&quot;')})">Save Changes</button>
      </div>`);
  } catch (err) { openModal(`<div class="modal-body"><div class="alert alert-error">${esc(err.message)}</div></div>`); }
}

function markAllReceived(items) {
  (items || []).forEach(it => {
    const inp = document.getElementById('rxd-' + it.id);
    if (inp) inp.value = it.quantity_ordered;
  });
}

async function savePartsPODetail(poId, items) {
  const vendor = document.getElementById('dpod-vendor')?.value?.trim();
  const order_date = document.getElementById('dpod-order-date')?.value;
  const expected_delivery = document.getElementById('dpod-exp-delivery')?.value;
  const warehouse_destination = document.getElementById('dpod-warehouse')?.value;
  const notes = document.getElementById('dpod-notes')?.value?.trim();
  const status = document.getElementById('dpod-status')?.value;
  if (!vendor || !order_date) return alert('Vendor and Order Date are required.');
  // Save header
  try {
    await api('PUT', '/api/parts-pos/' + poId, { vendor, order_date, expected_delivery: expected_delivery || null, warehouse_destination, notes, status });
    // Save each item's received quantity
    for (const it of items) {
      const inp = document.getElementById('rxd-' + it.id);
      if (!inp) continue;
      const rxd = parseInt(inp.value) || 0;
      if (rxd !== (it.received_quantity || 0)) {
        await api('PUT', '/api/parts-pos/' + poId + '/items/' + it.id, { ...it, received_quantity: rxd });
      }
    }
    showToast('PO #' + poId + ' saved!');
    closeModal();
    renderPartsPO();
  } catch (err) { alert(err.message); }
}

async function deletePO(id) {
  if (!confirm(`Delete PO #${id}? This cannot be undone.`)) return;
  try {
    await api('DELETE', '/api/parts-pos/' + id);
    showToast('PO deleted.');
    closeModal();
    renderPartsPO();
  } catch (err) { alert(err.message); }
}

// ─── Receive PO Modal ──────────────────────────────────────────────────────────
async function openReceivePOModal(poId) {
  openModal(`<div class="modal-body" style="text-align:center;padding:40px"><div class="loader"></div></div>`);
  try {
    const po = await api('GET', '/api/parts-pos/' + poId);
    const items = po.items || [];
    if (!items.length) { openModal(`<div class="modal-body"><div class="alert alert-error">No line items on this PO.</div><div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">Close</button></div></div>`); return; }

    const itemRows = items.map(it => {
      const outstanding = Math.max(0, (it.quantity_ordered || 0) - (it.received_quantity || 0));
      const pct = it.quantity_ordered > 0 ? Math.round((it.received_quantity||0) / it.quantity_ordered * 100) : 0;
      const done = (it.received_quantity||0) >= (it.quantity_ordered||0);
      return `
      <tr style="${done ? 'opacity:.55' : ''}">
        <td style="font-family:monospace;font-size:12px;padding:8px 6px">${esc(it.part_sku)}</td>
        <td style="text-align:center;padding:8px 6px">${it.quantity_ordered}</td>
        <td style="text-align:center;padding:8px 6px">
          <span style="font-weight:700;color:${done?'#15803d':'var(--muted)'}">${it.received_quantity||0}</span>
          <div style="margin-top:3px;height:4px;background:#e2e8f0;border-radius:2px">
            <div style="height:4px;border-radius:2px;width:${pct}%;background:${done?'#16a34a':'#3b82f6'}"></div>
          </div>
        </td>
        <td style="text-align:center;padding:8px 6px">
          ${done
            ? `<span class="badge" style="background:#dcfce7;color:#15803d">✓ Complete</span>`
            : `<input type="number" id="recv-qty-${it.id}" value="${outstanding}" min="0" max="${outstanding}" style="width:65px;text-align:center;border:1.5px solid var(--border);border-radius:var(--r);padding:4px 6px;font-size:13px">`
          }
        </td>
      </tr>`;
    }).join('');

    openModal(`
      <div class="modal-header">
        <div>
          <h3>Receive Stock — PO #${po.id}</h3>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(po.vendor)} · ${esc(po.warehouse_destination||'')}</div>
        </div>
        <button class="modal-close" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body">
        <div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:13px;color:#15803d">
          Enter quantities received for each part. Received items are immediately added to Parts Inventory.
        </div>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="background:#f8fafc">
              <th style="padding:6px 8px;text-align:left;font-size:11px;color:var(--muted);font-weight:600">Part SKU</th>
              <th style="padding:6px 8px;text-align:center;font-size:11px;color:var(--muted);font-weight:600">Ordered</th>
              <th style="padding:6px 8px;text-align:center;font-size:11px;color:var(--muted);font-weight:600">Already Received</th>
              <th style="padding:6px 8px;text-align:center;font-size:11px;color:var(--muted);font-weight:600">Qty Receiving Now</th>
            </tr></thead>
            <tbody>${itemRows}</tbody>
          </table>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn btn-outline btn-sm" onclick="receiveMarkAll(${JSON.stringify(items).replace(/"/g,'&quot;')})">Mark All Outstanding</button>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-success" onclick="submitReceivePO(${po.id}, ${JSON.stringify(items).replace(/"/g,'&quot;')})">
          ✓ Confirm Receipt &amp; Add to Inventory
        </button>
      </div>`);
  } catch (err) { openModal(`<div class="modal-body"><div class="alert alert-error">${esc(err.message)}</div></div>`); }
}

function receiveMarkAll(items) {
  items.forEach(it => {
    const inp = document.getElementById('recv-qty-' + it.id);
    if (inp) inp.value = Math.max(0, (it.quantity_ordered||0) - (it.received_quantity||0));
  });
}

async function submitReceivePO(poId, originalItems) {
  // Build payload: new total received = prior received + qty entered now
  const payload = originalItems
    .filter(it => {
      const inp = document.getElementById('recv-qty-' + it.id);
      return inp && parseInt(inp.value) > 0;
    })
    .map(it => ({
      id: it.id,
      received_quantity: (it.received_quantity || 0) + (parseInt(document.getElementById('recv-qty-' + it.id)?.value) || 0)
    }));

  if (!payload.length) return alert('No quantities entered. Please enter how many units you are receiving.');

  try {
    const r = await api('POST', '/api/parts-pos/' + poId + '/receive', { items: payload });
    const statusMsg = r.status ? ` — PO is now ${r.status}` : '';
    showToast(`✓ Stock received${statusMsg}`);
    closeModal();
    renderPartsPO();
    // Refresh inventory screen if it's open
    if (S.screen === 'parts-inventory') renderPartsInventory();
  } catch (err) { alert(err.message); }
}

// ─── renderServiceOrders ────────────────────────────────────────────────────────
async function renderServiceOrders() {
  const el = document.getElementById('screen-service-orders');
  el.innerHTML = `<div class="screen-header"><h2>Service Orders</h2><p style="color:var(--muted);font-size:13px">Loading…</p></div><div style="text-align:center;padding:40px"><div class="loader"></div></div>`;
  try {
    const f = S.serviceorders.filters;
    const qs = new URLSearchParams();
    if (f.status) qs.set('status', f.status);
    if (f.technician) qs.set('technician', f.technician);
    if (f.repair_type) qs.set('repair_type', f.repair_type);
    if (f.search) qs.set('search', f.search);
    const data = await api('GET', '/api/service-orders?' + qs.toString());
    S.serviceorders.list = data.orders;
    S.serviceorders.stats = data.stats;
    _renderServiceOrdersList(data);
  } catch (err) {
    el.innerHTML = `<div class="alert alert-error">Failed to load: ${esc(err.message)}</div>`;
  }
}

function _renderServiceOrdersList(data) {
  const el = document.getElementById('screen-service-orders');
  const { orders, stats, total } = data;
  const f = S.serviceorders.filters;
  const statCards = [
    { label: 'Total', value: total, color: 'blue', key: '' },
    { label: 'Open', value: stats['Open'] || 0, color: 'amber', key: 'Open' },
    { label: 'In Progress', value: stats['In Progress'] || 0, color: 'blue', key: 'In Progress' },
    { label: 'Completed', value: stats['Completed'] || 0, color: 'green', key: 'Completed' },
  ].map(d => `
    <div class="stat-card ${d.color}" style="cursor:pointer" onclick="S.serviceorders.filters.status='${d.key}';renderServiceOrders()">
      <div class="stat-label">${d.label}</div>
      <div class="stat-value">${d.value}</div>
    </div>`).join('');

  // Unique technicians for filter
  const techs = [...new Set(S.serviceorders.list.map(o => o.assigned_technician).filter(Boolean))];

  const rows = orders.length ? orders.map(o => `
    <tr onclick="openServiceOrderDetail(${o.id})" style="cursor:pointer">
      <td style="font-weight:600;color:var(--blue)">#${o.id}</td>
      <td>${soStatusBadge(o.status)}</td>
      <td>${fmtDate(o.date_created)}</td>
      <td>${esc(o.customer_name || '—')}</td>
      <td class="mono" style="font-size:12px">${esc(o.imei_serial || '—')}</td>
      <td>${esc(o.repair_type || '—')}</td>
      <td style="text-align:center;font-weight:600">${o.parts_count || 0}</td>
      <td>${esc(o.assigned_technician || '—')}</td>
      <td><button class="btn btn-outline btn-sm" onclick="event.stopPropagation();openServiceOrderDetail(${o.id})">View</button></td>
    </tr>`).join('')
    : `<tr><td colspan="9"><div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg><p>No service orders found</p></div></td></tr>`;

  el.innerHTML = `
  <div class="screen-header" style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px">
    <div><h2>Service Orders</h2><p style="color:var(--muted);font-size:13px;margin-top:3px">${total} total</p></div>
    <button class="btn btn-primary" onclick="openServiceOrderModal()">
      <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      New Service Order
    </button>
  </div>
  <div class="stats-grid" style="grid-template-columns:repeat(4,1fr)">${statCards}</div>
  <div class="toolbar">
    <div class="toolbar-left">
      <input type="text" class="search-input" placeholder="Search IMEI, customer…" value="${esc(f.search)}"
        oninput="S.serviceorders.filters.search=this.value"
        onkeydown="if(event.key==='Enter')renderServiceOrders()" style="width:220px">
      <select onchange="S.serviceorders.filters.technician=this.value;renderServiceOrders()">
        <option value="">All Technicians</option>
        ${techs.map(t => `<option value="${esc(t)}" ${f.technician===t?'selected':''}>${esc(t)}</option>`).join('')}
      </select>
      <select onchange="S.serviceorders.filters.repair_type=this.value;renderServiceOrders()">
        <option value="">All Repair Types</option>
        ${REPAIR_TYPES.map(r => `<option value="${esc(r)}" ${f.repair_type===r?'selected':''}>${esc(r)}</option>`).join('')}
      </select>
      <select onchange="S.serviceorders.filters.status=this.value;renderServiceOrders()">
        <option value="">All Statuses</option>
        ${SO_STATUSES.map(s => `<option value="${esc(s)}" ${f.status===s?'selected':''}>${esc(s)}</option>`).join('')}
      </select>
      <button class="btn btn-outline btn-sm" onclick="S.serviceorders.filters={status:'',technician:'',repair_type:'',search:''};renderServiceOrders()">Clear</button>
    </div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>SO #</th><th>Status</th><th>Date</th><th>Customer</th><th>IMEI/Serial</th>
        <th>Repair Type</th><th style="text-align:center">Parts</th><th>Technician</th><th>Actions</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="table-foot">${total} record${total !== 1 ? 's' : ''}</div>
  </div>`;
}

// ─── SO Parts — Inventory Search ───────────────────────────────────────────────
// State: list of {part_sku, quantity, available_stock} being added to this SO
let _soSelectedParts = [];

function soPartsSearchHtml(existingParts = []) {
  // seed from existing parts (edit mode)
  _soSelectedParts = existingParts.map(p => ({ part_sku: p.part_sku, quantity: p.quantity || 1, available_stock: null }));
  const typeOpts = PART_TYPES.map(t => `<option value="${t.code}">${t.code} — ${t.label}</option>`).join('');
  const colorOpts = ['NA','Black','White','Silver','Gold','Rose Gold','Blue','Green','Purple','Red','Yellow']
    .map(c => `<option value="${c}">${c}</option>`).join('');
  const brandOpts = PARTS_DEVICE_BRANDS.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('');
  return `
    <div style="background:#f8fafc;border:1.5px solid var(--border);border-radius:8px;padding:14px;margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">🔍 Search Parts from Inventory</div>
      <div class="form-grid form-grid-3" style="margin-bottom:10px">
        <div class="form-group">
          <label style="font-size:11px">Part Type</label>
          <select id="sop-filter-type" onchange="soFilterBrandModel()">
            <option value="">All Types</option>
            ${typeOpts}
          </select>
        </div>
        <div class="form-group">
          <label style="font-size:11px">Quality</label>
          <select id="sop-filter-quality" onchange="soSearchParts()">
            <option value="">Any</option>
            <option value="OEM">OEM</option>
            <option value="Aftermarket">Aftermarket</option>
          </select>
        </div>
        <div class="form-group">
          <label style="font-size:11px">Color</label>
          <select id="sop-filter-color" onchange="soSearchParts()">
            <option value="">Any Color</option>
            ${colorOpts}
          </select>
        </div>
      </div>
      <div class="form-grid form-grid-2" style="margin-bottom:10px">
        <div class="form-group">
          <label style="font-size:11px">Device Brand</label>
          <select id="sop-filter-brand" onchange="soFilterBrandChanged()">
            <option value="">All Brands</option>
            ${brandOpts}
          </select>
        </div>
        <div class="form-group">
          <label style="font-size:11px">Model</label>
          <select id="sop-filter-model" onchange="soSearchParts()">
            <option value="">All Models</option>
          </select>
        </div>
      </div>
      <div class="form-group" style="margin-bottom:10px">
        <label style="font-size:11px">Keyword / SKU search</label>
        <input type="text" id="sop-filter-search" placeholder="e.g. iPhone 13, BTRY…"
          oninput="clearTimeout(window._soSearchTimer);window._soSearchTimer=setTimeout(soSearchParts,300)"
          style="width:100%">
      </div>
      <div id="sop-results" style="min-height:40px">
        <p style="color:var(--muted);font-size:12px;text-align:center;padding:10px 0">Select filters or type to search parts with available stock</p>
      </div>
    </div>
    <div id="sop-added-wrap">
      ${_soSelectedPartsHtml()}
    </div>`;
}

function soFilterBrandChanged() {
  const brand = document.getElementById('sop-filter-brand')?.value || '';
  const modelSel = document.getElementById('sop-filter-model');
  if (!modelSel) return;
  const models = reqModelsForBrand(brand);
  modelSel.innerHTML = '<option value="">All Models</option>' +
    models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  soSearchParts();
}

function soFilterBrandModel() {
  soSearchParts();
}

async function soSearchParts() {
  const type    = document.getElementById('sop-filter-type')?.value || '';
  const quality = document.getElementById('sop-filter-quality')?.value || '';
  const color   = document.getElementById('sop-filter-color')?.value || '';
  const brand   = document.getElementById('sop-filter-brand')?.value || '';
  const model   = document.getElementById('sop-filter-model')?.value || '';
  const search  = document.getElementById('sop-filter-search')?.value?.trim() || '';
  const resultsEl = document.getElementById('sop-results');
  if (!resultsEl) return;

  // Build query — combine model + brand into search if no keyword
  const qs = new URLSearchParams();
  if (type)   qs.set('part_type', type);
  if (model)  qs.set('model', model);
  else if (brand) qs.set('model', brand); // fallback: search by brand name in model field
  if (search) qs.set('search', search);

  resultsEl.innerHTML = '<p style="color:var(--muted);font-size:12px;text-align:center;padding:10px 0"><span class="loader" style="width:16px;height:16px;display:inline-block"></span> Searching…</p>';

  try {
    const data = await api('GET', '/api/parts-inventory?' + qs.toString());
    let parts = (data.parts || []).filter(p => p.current_stock > 0);

    // Client-side filter quality and color from SKU pattern (e.g. -OEM, -Black)
    if (quality) parts = parts.filter(p => p.part_sku.toUpperCase().includes('-' + quality.toUpperCase()));
    if (color && color !== 'NA') parts = parts.filter(p => p.part_sku.toLowerCase().includes('-' + color.toLowerCase()));
    if (color === 'NA') parts = parts.filter(p => p.part_sku.includes('-NA-'));

    if (!parts.length) {
      resultsEl.innerHTML = '<p style="color:var(--muted);font-size:12px;text-align:center;padding:10px 0">No parts found in inventory with available stock.</p>';
      return;
    }

    resultsEl.innerHTML = `
      <div style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead style="position:sticky;top:0;background:#f1f5f9;z-index:1">
            <tr>
              <th style="padding:6px 8px;text-align:left;font-weight:600;color:var(--muted)">Part SKU</th>
              <th style="padding:6px 8px;text-align:left;font-weight:600;color:var(--muted)">Model</th>
              <th style="padding:6px 8px;text-align:center;font-weight:600;color:var(--muted)">In Stock</th>
              <th style="padding:6px 8px"></th>
            </tr>
          </thead>
          <tbody>
            ${parts.map(p => `
              <tr style="border-top:1px solid var(--border)" onmouseenter="this.style.background='#f8fafc'" onmouseleave="this.style.background=''">
                <td style="padding:7px 8px;font-family:monospace;font-size:11px">${esc(p.part_sku)}</td>
                <td style="padding:7px 8px;color:var(--muted);font-size:11px">${esc(p.model_compatibility||'—')}</td>
                <td style="padding:7px 8px;text-align:center">
                  <span style="font-weight:700;color:${p.current_stock <= 2 ? '#b45309' : '#15803d'}">${p.current_stock}</span>
                </td>
                <td style="padding:7px 8px;text-align:right">
                  <button class="btn btn-primary btn-sm" onclick="soAddInventoryPart('${esc(p.part_sku)}',${p.current_stock})">+ Add</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (err) {
    resultsEl.innerHTML = `<p style="color:var(--red);font-size:12px;text-align:center;padding:10px 0">Error: ${esc(err.message)}</p>`;
  }
}

function soAddInventoryPart(sku, availableStock) {
  const existing = _soSelectedParts.find(p => p.part_sku === sku);
  if (existing) {
    existing.quantity = Math.min(existing.quantity + 1, availableStock);
  } else {
    _soSelectedParts.push({ part_sku: sku, quantity: 1, available_stock: availableStock });
  }
  document.getElementById('sop-added-wrap').innerHTML = _soSelectedPartsHtml();
}

function soRemoveSelectedPart(sku) {
  _soSelectedParts = _soSelectedParts.filter(p => p.part_sku !== sku);
  document.getElementById('sop-added-wrap').innerHTML = _soSelectedPartsHtml();
}

function soUpdateSelectedQty(sku, val) {
  const part = _soSelectedParts.find(p => p.part_sku === sku);
  if (part) part.quantity = Math.max(1, parseInt(val) || 1);
}

function _soSelectedPartsHtml() {
  if (!_soSelectedParts.length) {
    return `<div style="text-align:center;padding:14px;color:var(--muted);font-size:12px;border:1.5px dashed var(--border);border-radius:6px">No parts added yet — search above and click + Add</div>`;
  }
  const rows = _soSelectedParts.map(p => `
    <tr>
      <td style="padding:7px 8px;font-family:monospace;font-size:12px;font-weight:600">${esc(p.part_sku)}</td>
      <td style="padding:7px 8px;text-align:center">
        <input type="number" value="${p.quantity}" min="1" ${p.available_stock ? `max="${p.available_stock}"` : ''}
          style="width:65px;text-align:center;border:1.5px solid var(--border);border-radius:var(--r);padding:4px 6px;font-size:13px"
          onchange="soUpdateSelectedQty('${esc(p.part_sku)}',this.value)">
      </td>
      ${p.available_stock != null ? `<td style="padding:7px 8px;text-align:center;font-size:11px;color:var(--muted)">of ${p.available_stock}</td>` : '<td></td>'}
      <td style="padding:7px 8px;text-align:right">
        <button class="btn btn-danger btn-sm btn-icon" onclick="soRemoveSelectedPart('${esc(p.part_sku)}')">✕</button>
      </td>
    </tr>`).join('');
  return `
    <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Parts to Use (${_soSelectedParts.length})</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid var(--border);border-radius:6px;overflow:hidden">
      <thead style="background:#f8fafc">
        <tr>
          <th style="padding:6px 8px;text-align:left;font-size:11px;color:var(--muted);font-weight:600">Part SKU</th>
          <th style="padding:6px 8px;text-align:center;font-size:11px;color:var(--muted);font-weight:600">Qty</th>
          <th style="padding:6px 8px;text-align:center;font-size:11px;color:var(--muted);font-weight:600">Available</th>
          <th style="padding:6px 8px"></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function collectSOParts() {
  // Collect from _soSelectedParts (which is kept in sync via soUpdateSelectedQty/soRemoveSelectedPart)
  return _soSelectedParts
    .filter(p => p.part_sku && p.quantity > 0)
    .map(p => ({ part_sku: p.part_sku, quantity: p.quantity }));
}

function soFormHtml(so = {}, parts = []) {
  const today = new Date().toISOString().slice(0, 10);
  return `
    <div class="form-section">
      <div class="form-section-title">Order Details</div>
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label>Date Created *</label>
          <input type="date" id="so-date" value="${so.date_created ? so.date_created.slice(0,10) : today}">
        </div>
        <div class="form-group">
          <label>Customer Name</label>
          <input type="text" id="so-customer" value="${esc(so.customer_name || 'Tekhouz')}">
        </div>
        <div class="form-group">
          <label>IMEI / Serial Number</label>
          <input type="text" id="so-imei" value="${esc(so.imei_serial || '')}" placeholder="357500964474983">
        </div>
        <div class="form-group">
          <label>Repair Type</label>
          <select id="so-repair-type">
            <option value="">— Select —</option>
            ${REPAIR_TYPES.map(r => `<option value="${esc(r)}" ${so.repair_type===r?'selected':''}>${esc(r)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Assigned Technician</label>
          <input type="text" id="so-tech" value="${esc(so.assigned_technician || (S.user?.username || ''))}">
        </div>
        <div class="form-group">
          <label>Status</label>
          <select id="so-status">
            ${SO_STATUSES.map(s => `<option value="${esc(s)}" ${so.status===s?'selected':''}>${esc(s)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Warehouse Source</label>
          <select id="so-warehouse">
            ${WAREHOUSES.map(w => `<option value="${esc(w)}" ${so.warehouse_source===w?'selected':''}>${esc(w)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group" style="margin-top:10px">
        <label>Issue Description</label>
        <textarea id="so-issue" rows="2">${esc(so.issue_description || '')}</textarea>
      </div>
      <div class="form-group" style="margin-top:10px">
        <label>Notes</label>
        <textarea id="so-notes" rows="2">${esc(so.notes || '')}</textarea>
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-title">Parts Used</div>
      ${soPartsSearchHtml(parts)}
    </div>`;
}

function openServiceOrderModal(prefill = {}) {
  openModal(`
    <div class="modal-header">
      <h3>New Service Order</h3>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">${soFormHtml()}</div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveNewSO()">Create Service Order</button>
    </div>`);
}

async function saveNewSO() {
  const date_created = document.getElementById('so-date')?.value;
  const customer_name = document.getElementById('so-customer')?.value?.trim();
  const imei_serial = document.getElementById('so-imei')?.value?.trim();
  const issue_description = document.getElementById('so-issue')?.value?.trim();
  const repair_type = document.getElementById('so-repair-type')?.value;
  const assigned_technician = document.getElementById('so-tech')?.value?.trim();
  const status = document.getElementById('so-status')?.value;
  const warehouse_source = document.getElementById('so-warehouse')?.value;
  const notes = document.getElementById('so-notes')?.value?.trim();
  if (!date_created) return alert('Date Created is required.');
  const parts = collectSOParts();
  try {
    const r = await api('POST', '/api/service-orders', { date_created, customer_name, imei_serial, issue_description, repair_type, assigned_technician, status, warehouse_source, notes, parts });
    showToast('Service Order #' + r.id + ' created!');
    closeModal();
    renderServiceOrders();
  } catch (err) { alert(err.message); }
}

async function openServiceOrderDetail(id) {
  openModal(`<div class="modal-body" style="text-align:center;padding:40px"><div class="loader"></div></div>`);
  try {
    const so = await api('GET', '/api/service-orders/' + id);
    const isAdmin = S.user?.role === 'admin';
    openModal(`
      <div class="modal-header">
        <h3>Service Order #${so.id} ${soStatusBadge(so.status)}</h3>
        <button class="modal-close" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body">${soFormHtml(so, so.parts || [])}</div>
      <div class="modal-footer">
        ${isAdmin ? `<button class="btn btn-danger" onclick="deleteSO(${so.id})">Delete</button>` : ''}
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveSODetail(${so.id})">Save Changes</button>
      </div>`);
  } catch (err) { openModal(`<div class="modal-body"><div class="alert alert-error">${esc(err.message)}</div></div>`); }
}

async function saveSODetail(soId) {
  const date_created = document.getElementById('so-date')?.value;
  const customer_name = document.getElementById('so-customer')?.value?.trim();
  const imei_serial = document.getElementById('so-imei')?.value?.trim();
  const issue_description = document.getElementById('so-issue')?.value?.trim();
  const repair_type = document.getElementById('so-repair-type')?.value;
  const assigned_technician = document.getElementById('so-tech')?.value?.trim();
  const status = document.getElementById('so-status')?.value;
  const warehouse_source = document.getElementById('so-warehouse')?.value;
  const notes = document.getElementById('so-notes')?.value?.trim();
  if (!date_created) return alert('Date Created is required.');
  const parts = collectSOParts();
  try {
    await api('PUT', '/api/service-orders/' + soId, { date_created, customer_name, imei_serial, issue_description, repair_type, assigned_technician, status, warehouse_source, notes, parts });
    showToast('Service Order #' + soId + ' saved!');
    closeModal();
    renderServiceOrders();
  } catch (err) { alert(err.message); }
}

async function deleteSO(id) {
  if (!confirm(`Delete Service Order #${id}? This cannot be undone.`)) return;
  try {
    await api('DELETE', '/api/service-orders/' + id);
    showToast('Service Order deleted.');
    closeModal();
    renderServiceOrders();
  } catch (err) { alert(err.message); }
}

// ─── renderPartsInventory ───────────────────────────────────────────────────────
async function renderPartsInventory() {
  const el = document.getElementById('screen-parts-inventory');
  el.innerHTML = `<div class="screen-header"><h2>Parts Inventory</h2><p style="color:var(--muted);font-size:13px">Loading…</p></div><div style="text-align:center;padding:40px"><div class="loader"></div></div>`;
  try {
    const f = S.partsinventory.filters;
    const qs = new URLSearchParams();
    if (f.category) qs.set('category', f.category);
    if (f.part_type) qs.set('part_type', f.part_type);
    if (f.search) qs.set('search', f.search);
    const data = await api('GET', '/api/parts-inventory?' + qs.toString());
    S.partsinventory.list = data.parts;
    _renderPartsInventoryList(data);
  } catch (err) {
    el.innerHTML = `<div class="alert alert-error">Failed to load: ${esc(err.message)}</div>`;
  }
}

function _renderPartsInventoryList(data) {
  const el = document.getElementById('screen-parts-inventory');
  const { parts, total, stats } = data;
  const f = S.partsinventory.filters;

  // Unique categories and types for filters
  const categories = [...new Set(parts.map(p => p.part_category).filter(Boolean))];
  const types = [...new Set(parts.map(p => p.part_type).filter(Boolean))];

  const statCards = [
    { label: 'Total Parts', value: total, color: 'blue' },
    { label: 'Total Stock', value: stats.total_stock || 0, color: 'green' },
    { label: 'Low Stock ≤2', value: stats.low_stock_count || 0, color: 'amber' },
    { label: 'Out of Stock', value: stats.out_of_stock_count || 0, color: 'red' },
  ].map(d => `
    <div class="stat-card ${d.color}">
      <div class="stat-label">${d.label}</div>
      <div class="stat-value">${d.value}</div>
    </div>`).join('');

  const rows = parts.length ? parts.map(p => `
    <tr>
      <td class="mono" style="color:var(--blue);font-size:12px">${esc(p.part_sku)}</td>
      <td>${p.part_type ? `<span class="badge badge-shipped">${esc(p.part_type)}</span>` : '—'}</td>
      <td style="font-size:12px;color:var(--muted)">${esc(p.part_category || '—')}</td>
      <td style="font-size:12px">${esc(p.model_compatibility || '—')}</td>
      <td style="text-align:center;color:var(--muted)">${p.total_stock_in || 0}</td>
      <td style="text-align:center;color:var(--muted)">${p.total_stock_out || 0}</td>
      <td style="text-align:center">${stockLevelBadge(p.current_stock)}</td>
      <td style="text-align:center;color:var(--blue)">${p.open_po_qty || 0}</td>
      <td style="text-align:center;color:var(--amber)">${p.open_req_qty || 0}</td>
    </tr>`).join('')
    : `<tr><td colspan="9"><div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg><p>No parts tracked yet. Create POs or Service Orders to populate inventory.</p></div></td></tr>`;

  el.innerHTML = `
  <div class="screen-header">
    <h2>Parts Inventory</h2>
    <p style="color:var(--muted);font-size:13px;margin-top:3px">Computed stock levels across all POs and Service Orders</p>
  </div>
  <div class="stats-grid" style="grid-template-columns:repeat(4,1fr)">${statCards}</div>
  <div class="toolbar">
    <div class="toolbar-left">
      <input type="text" class="search-input" placeholder="Search SKU or model…" value="${esc(f.search)}"
        oninput="S.partsinventory.filters.search=this.value"
        onkeydown="if(event.key==='Enter')renderPartsInventory()" style="width:220px">
      <select onchange="S.partsinventory.filters.category=this.value;renderPartsInventory()">
        <option value="">All Categories</option>
        ${categories.map(c => `<option value="${esc(c)}" ${f.category===c?'selected':''}>${esc(c)}</option>`).join('')}
      </select>
      <select onchange="S.partsinventory.filters.part_type=this.value;renderPartsInventory()">
        <option value="">All Types</option>
        ${types.map(t => `<option value="${esc(t)}" ${f.part_type===t?'selected':''}>${esc(t)}</option>`).join('')}
      </select>
      <button class="btn btn-outline btn-sm" onclick="S.partsinventory.filters={category:'',part_type:'',search:''};renderPartsInventory()">Clear</button>
    </div>
    <div class="toolbar-right">
      <button class="btn btn-outline btn-sm" onclick="renderPartsInventory()">
        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
        Refresh
      </button>
    </div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Part SKU</th><th>Type</th><th>Category</th><th>Model</th>
        <th style="text-align:center">Total In</th><th style="text-align:center">Total Out</th>
        <th style="text-align:center">Current Stock</th><th style="text-align:center">Open POs</th><th style="text-align:center">Open Reqs</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="table-foot">${total} part${total !== 1 ? 's' : ''} tracked</div>
  </div>`;
}
