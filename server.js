/* ==========================================================================
 * Wonder Bubble Studio - sync server
 *
 * Two changes matter most here:
 *
 *  - Orders merge on `uid`, not on the human ORD-#### label. Clients used to
 *    mint ids as max+1 locally, so two tills serving at once produced the same
 *    label and this merge folded the two sales into one row. Legacy rows get a
 *    uid derived from their own fields (hash32 below is byte-identical to the
 *    client's), so nothing needs migrating.
 *
 *  - `salesLogs` in a sync body is a DELTA - only the rows a client actually
 *    changed. It is never the full truth, so a client with a stale copy can no
 *    longer remove anything. Deletes go through /api/delete-order and leave a
 *    tombstone.
 * ========================================================================== */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'shop_data.json');
const MAX_TOMBSTONES = 2000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname, { extensions: ['html'] }));

let shopData = null;
let lastUpdated = Date.now();
let sseClients = [];

/* ------------------------------------------------------------------ *
 * STORAGE
 *
 * Railway wipes the container filesystem on every deploy, so writing
 * data/shop_data.json is NOT persistence - it silently reverts the shop to
 * whatever snapshot was committed to git. That is how a full day of orders was
 * lost on 2026-08-30.
 *
 * With DATABASE_URL the state lives in Postgres and the JSON file is only a
 * first-boot seed. Without it we fall back to the file so local dev works, and
 * shout about it on every boot.
 * ------------------------------------------------------------------ */
let pool = null;

if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    const url = process.env.DATABASE_URL;
    pool = new Pool({
      connectionString: url,
      ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }
    });
    pool.on('error', (e) => console.error('PG pool error:', e.message));
    console.log('💾 Storage: Postgres');
  } catch (e) {
    console.error('!! DATABASE_URL is set but "pg" failed to load:', e.message);
    pool = null;
  }
}

if (!pool) {
  console.warn('');
  console.warn('  ╔══════════════════════════════════════════════════════════════╗');
  console.warn('  ║  ⚠️  DATABASE_URL is not set - storing orders in a FILE.      ║');
  console.warn('  ║                                                              ║');
  console.warn('  ║  On Railway the filesystem is wiped on every deploy, so any  ║');
  console.warn('  ║  order taken since the last git commit WILL BE LOST.         ║');
  console.warn('  ║  Add a Postgres database in Railway and this goes away.      ║');
  console.warn('  ╚══════════════════════════════════════════════════════════════╝');
  console.warn('');
}

/* ---------------------------------------------------------------- utils */
/** FNV-1a. Must stay byte-identical to hash32() in assets/app.js. */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function legacyUid(l) {
  return 'L' + hash32([l.id, l.date, l.username, l.robux, l.stockAccount].join('|'));
}

/** Same repair the client does: 'YYYY-MM-DD' or ISO -> 'YYYY-MM-DD HH:MM'. */
function normalizeStamp(v) {
  const m = String(v || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return '';
  return m[1] + '-' + m[2] + '-' + m[3] + ' ' + (m[4] || '00') + ':' + (m[5] || '00');
}

/**
 * The uid of a row, always derived from its NORMALISED date.
 *
 * Getting this wrong duplicated 692 orders on 2026-09-02: rows written before
 * times were recorded hold a bare 'YYYY-MM-DD'. hydrate() repaired the date
 * before hashing while the merge hashed first, so the same sale produced two
 * different uids and every old client re-posting its cache added a second copy.
 * Normalise, then hash - never the other way round.
 */
function uidOf(l) {
  if (!l || typeof l !== 'object') return null;
  if (l.uid) return String(l.uid);
  return legacyUid(Object.assign({}, l, { date: normalizeStamp(l.date) || l.date }));
}

/** Newest first, so even a client that does no sorting shows today at the top. */
function sortLogs(list) {
  list.sort((a, b) => {
    const da = String(a.date || ''), db = String(b.date || '');
    if (da !== db) return da < db ? 1 : -1;
    return String(b.uid || '').localeCompare(String(a.uid || ''));
  });
}

function orderCount() {
  return (shopData && Array.isArray(shopData.salesLogs)) ? shopData.salesLogs.length : 0;
}

/** Gives every row a uid and a usable timestamp exactly once, at load. */
function hydrate(doc) {
  const d = (doc && typeof doc === 'object') ? doc : {};
  d.settings = d.settings || {};
  d.packages = Array.isArray(d.packages) ? d.packages : [];
  d.stockAccounts = Array.isArray(d.stockAccounts) ? d.stockAccounts : [];
  d.deletedOrders = Array.isArray(d.deletedOrders) ? d.deletedOrders : [];
  d.salesLogs = Array.isArray(d.salesLogs) ? d.salesLogs : [];

  const seen = new Set();
  d.salesLogs = d.salesLogs.filter(l => {
    if (!l || typeof l !== 'object') return false;
    const stamp = normalizeStamp(l.date);
    if (stamp) l.date = stamp;
    l.uid = uidOf(l);
    if (seen.has(l.uid)) return false;
    seen.add(l.uid);
    return true;
  });

  const tomb = new Set(d.deletedOrders);
  d.salesLogs = d.salesLogs.filter(l => !tomb.has(l.uid));
  sortLogs(d.salesLogs);
  return d;
}

/* -------------------------------------------------------------- storage */
function readSeedFile() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to read seed file:', e.message);
  }
  return null;
}

function writeSeedFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Write then rename, so a crash mid-write cannot leave a truncated file.
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(shopData, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('Failed to write shop_data.json:', e.message);
  }
}

async function initStorage() {
  if (!pool) {
    shopData = hydrate(readSeedFile() || {});
    console.log('Loaded ' + orderCount() + ' orders from file.');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_state (
      id          INT PRIMARY KEY,
      data        JSONB  NOT NULL,
      updated_at  BIGINT NOT NULL
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_snapshots (
      id          BIGSERIAL PRIMARY KEY,
      data        JSONB  NOT NULL,
      order_count INT    NOT NULL,
      created_at  BIGINT NOT NULL
    )`);

  const { rows } = await pool.query('SELECT data, updated_at FROM shop_state WHERE id = 1');
  if (rows.length && rows[0].data) {
    shopData = hydrate(rows[0].data);
    lastUpdated = Number(rows[0].updated_at) || Date.now();
    console.log('Loaded ' + orderCount() + ' orders from Postgres.');
    return;
  }

  // First boot against an empty database: seed from the committed file.
  shopData = hydrate(readSeedFile() || {});
  console.log('Postgres empty - seeding with ' + orderCount() + ' orders from file.');
  await writeState();
}

async function writeState() {
  if (!pool) { writeSeedFile(); return; }
  await pool.query(
    `INSERT INTO shop_state (id, data, updated_at) VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(shopData), lastUpdated]
  );
}

/** Rolling history so a bad write is always recoverable. */
let lastSnapshotCount = -1;
async function writeSnapshot() {
  if (!pool) return;
  const count = orderCount();
  if (count === lastSnapshotCount) return;
  lastSnapshotCount = count;
  await pool.query(
    'INSERT INTO shop_snapshots (data, order_count, created_at) VALUES ($1, $2, $3)',
    [JSON.stringify(shopData), count, Date.now()]
  );
  await pool.query(
    `DELETE FROM shop_snapshots WHERE id NOT IN
       (SELECT id FROM shop_snapshots ORDER BY id DESC LIMIT 200)`
  );
}

// Syncs arrive in bursts, so coalesce the writes.
let persistTimer = null;
let persistPending = false;
function persist() {
  persistPending = true;
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    if (!persistPending) return;
    persistPending = false;
    try {
      await writeState();
      await writeSnapshot();
    } catch (e) {
      console.error('Persist failed:', e.message);
      writeSeedFile(); // last-resort local copy
    }
  }, 1500);
}

/* ---------------------------------------------------------------- merge */
/**
 * `incoming.salesLogs` is a delta: rows to add or update, keyed by uid.
 * Absence never means deletion.
 */
function mergeShopData(incoming) {
  if (!incoming || typeof incoming !== 'object') return shopData;
  if (!shopData) { shopData = hydrate(incoming); persist(); return shopData; }

  const tomb = new Set(shopData.deletedOrders || []);
  const byUid = new Map((shopData.salesLogs || []).map(l => [l.uid, l]));

  let added = 0, updated = 0;
  (Array.isArray(incoming.salesLogs) ? incoming.salesLogs : []).forEach(row => {
    if (!row || typeof row !== 'object') return;
    const uid = uidOf(row);
    if (!uid || tomb.has(uid)) return;           // never resurrect a deleted row
    const stamp = normalizeStamp(row.date);
    const clean = Object.assign({}, row, { uid });
    if (stamp) clean.date = stamp;
    if (byUid.has(uid)) { byUid.set(uid, Object.assign({}, byUid.get(uid), clean)); updated++; }
    else { byUid.set(uid, clean); added++; }
  });

  shopData.salesLogs = Array.from(byUid.values());
  sortLogs(shopData.salesLogs);

  // Stock accounts merge per id, so a stale client cannot wipe a mail somebody
  // else added a minute ago.
  if (Array.isArray(incoming.stockAccounts) && incoming.stockAccounts.length) {
    const acc = new Map((shopData.stockAccounts || []).map(a => [a.id, a]));
    incoming.stockAccounts.forEach(a => { if (a && a.id) acc.set(a.id, a); });
    shopData.stockAccounts = Array.from(acc.values());
  }
  if (incoming.settings && typeof incoming.settings === 'object') {
    shopData.settings = Object.assign({}, shopData.settings, incoming.settings);
  }
  if (Array.isArray(incoming.packages) && incoming.packages.length) {
    shopData.packages = incoming.packages;
  }

  if (added || updated) persist();
  return shopData;
}

function notifyAll(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
  sseClients.forEach(c => { try { c.res.write('data: ' + msg + '\n\n'); } catch (e) {} });
}

/* ------------------------------------------------------------------ API */
app.get('/api/version', (req, res) => {
  res.json({
    success: true,
    lastUpdated,
    orderCount: orderCount(),
    storage: pool ? 'postgres' : 'file'
  });
});

app.get('/api/data', (req, res) => {
  res.json({ success: true, data: shopData, lastUpdated, storage: pool ? 'postgres' : 'file' });
});

app.post('/api/sync', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid data' });
  mergeShopData(body);
  lastUpdated = Date.now();
  notifyAll({ type: 'DATA_SYNC', data: shopData, lastUpdated });
  res.json({ success: true, lastUpdated, count: orderCount() });
});

/**
 * Delete exactly one order. Matched on uid; the id/date/username in the body
 * are only a fallback for a client that predates uids.
 */
app.post('/api/delete-order', (req, res) => {
  const { uid, id, date, username, robux, stockAccount } = req.body || {};
  if (!shopData || !Array.isArray(shopData.salesLogs)) {
    return res.status(409).json({ success: false, error: 'no data loaded' });
  }

  const target = uid || (id
    ? legacyUid({ id, date: normalizeStamp(date) || date, username, robux, stockAccount })
    : null);
  if (!target) return res.status(400).json({ success: false, error: 'uid or id required' });

  const i = shopData.salesLogs.findIndex(l => l.uid === target);
  if (i !== -1) shopData.salesLogs.splice(i, 1);

  shopData.deletedOrders = (shopData.deletedOrders || [])
    .filter(u => u !== target).concat(target).slice(-MAX_TOMBSTONES);

  lastUpdated = Date.now();
  persist();
  notifyAll({ type: 'DATA_SYNC', data: shopData, lastUpdated });
  res.json({ success: true, removed: i === -1 ? 0 : 1, count: orderCount(), lastUpdated });
});

app.get('/api/backup', (req, res) => {
  const name = 'wonder-bubble-backup-' +
    new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.json';
  res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify({ success: true, data: shopData, lastUpdated }, null, 2));
});

app.get('/api/snapshots', async (req, res) => {
  if (!pool) return res.json({ success: false, error: 'snapshots require Postgres', snapshots: [] });
  try {
    const { rows } = await pool.query(
      'SELECT id, order_count, created_at FROM shop_snapshots ORDER BY id DESC LIMIT 200');
    res.json({ success: true, snapshots: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/snapshots/:id', async (req, res) => {
  if (!pool) return res.status(400).json({ success: false, error: 'snapshots require Postgres' });
  try {
    const { rows } = await pool.query(
      'SELECT data, order_count, created_at FROM shop_snapshots WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, ...rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const id = Date.now() + Math.random();
  sseClients.push({ id, res });
  res.write('data: ' + JSON.stringify({ type: 'INIT', data: shopData, lastUpdated }) + '\n\n');

  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(keepAlive); }
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients = sseClients.filter(c => c.id !== id);
  });
});

/* ------------------------------------------------------------ websocket */
wss.on('connection', (ws) => {
  if (shopData) ws.send(JSON.stringify({ type: 'INIT_DATA', data: shopData, lastUpdated }));
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message);
      if (parsed.type === 'UPDATE_DATA' && parsed.data) {
        mergeShopData(parsed.data);
        lastUpdated = Date.now();
        notifyAll({ type: 'DATA_SYNC', data: shopData, lastUpdated });
      }
    } catch (err) {
      console.error('WS message error:', err.message);
    }
  });
});

const wsPing = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);
server.on('close', () => clearInterval(wsPing));

/* ----------------------------------------------------------------- boot */
initStorage()
  .catch(e => {
    console.error('Storage init failed, falling back to file:', e.message);
    pool = null;
    shopData = hydrate(readSeedFile() || {});
  })
  .finally(() => {
    server.listen(PORT, () => {
      console.log('🌸 Wonder Bubble Studio on port ' + PORT + ' - ' +
        orderCount() + ' orders, storage: ' + (pool ? 'postgres' : 'file'));
    });
  });
