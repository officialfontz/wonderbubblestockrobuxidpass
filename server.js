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
const DATA_FILE = path.join(__dirname, 'data', 'shop_data.json');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

let shopData = null;
let lastUpdated = Date.now();
let sseClients = [];

/* ------------------------------------------------------------------ *
 * STORAGE
 *
 * Railway wipes the container filesystem on every deploy, so writing
 * data/shop_data.json is NOT persistence - it silently reverted the shop
 * to whatever snapshot was committed to git (this is how a full day of
 * orders was lost on 2026-08-30).
 *
 * When DATABASE_URL is present we keep the shop state in Postgres and
 * treat data/shop_data.json as a one-time bootstrap seed only.
 * Without DATABASE_URL we fall back to the file so local dev still works.
 * ------------------------------------------------------------------ */
let pool = null;

if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    const url = process.env.DATABASE_URL;
    pool = new Pool({
      connectionString: url,
      ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    });
    pool.on('error', (e) => console.error('PG pool error:', e.message));
    console.log('💾 Storage: Postgres');
  } catch (e) {
    console.error('!! DATABASE_URL is set but the "pg" package failed to load:', e.message);
    console.error('!! Falling back to file storage - data will NOT survive a redeploy.');
    pool = null;
  }
} else {
  console.warn('⚠️  DATABASE_URL is not set - using file storage.');
  console.warn('⚠️  Data will be LOST on the next deploy. Add a Postgres database in Railway.');
}

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
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(shopData, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write shop_data.json:', e.message);
  }
}

async function initStorage() {
  if (!pool) {
    shopData = readSeedFile();
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
    shopData = rows[0].data;
    lastUpdated = Number(rows[0].updated_at) || Date.now();
    console.log('Loaded ' + orderCount() + ' orders from Postgres.');
    return;
  }

  // First boot against an empty database: seed it from the committed file.
  shopData = readSeedFile();
  console.log('Postgres empty - seeding with ' + orderCount() + ' orders from file.');
  if (shopData) await writeState();
}

function orderCount() {
  return (shopData && Array.isArray(shopData.salesLogs)) ? shopData.salesLogs.length : 0;
}

async function writeState() {
  if (!pool) { writeSeedFile(); return; }
  await pool.query(
    `INSERT INTO shop_state (id, data, updated_at) VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(shopData), lastUpdated]
  );
}

// Keep a rolling history so a bad write is always recoverable.
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

// Syncs arrive every couple of seconds, so coalesce the writes.
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
  }, 2000);
}

/* ------------------------------------------------------------------ *
 * MERGE - orders are only ever added or updated, never dropped, so that a
 * client syncing a stale copy can never erase somebody else's work.
 *
 * That also meant deletes did not stick: the row was removed on the client,
 * the next sync merged it straight back, and the trash button looked broken.
 * Deletions therefore go through /api/delete-order and leave a tombstone,
 * which the merge honours so a stale client cannot resurrect the row.
 * ------------------------------------------------------------------ */
const MAX_TOMBSTONES = 500;

function logSig(l) {
  return [l && l.id, l && l.date, l && l.username].join('|');
}

function isDeleted(l) {
  const tombs = (shopData && shopData.deletedOrders) || [];
  return tombs.indexOf(logSig(l)) !== -1;
}

function mergeShopData(incomingData) {
  if (!incomingData || typeof incomingData !== 'object') return shopData;
  if (!shopData) {
    shopData = incomingData;
    persist();
    return shopData;
  }

  const existingLogs = shopData.salesLogs || [];
  const incomingLogs = incomingData.salesLogs || [];

  const map = new Map();
  existingLogs.forEach(log => {
    if (log && log.id) map.set(log.id, log);
    else if (log && log.username && log.date) map.set(log.username + '_' + log.date, log);
  });

  incomingLogs.forEach(log => {
    if (log && log.id) {
      if (!map.has(log.id)) {
        map.set(log.id, log);
      } else {
        map.set(log.id, { ...map.get(log.id), ...log });
      }
    } else if (log && log.username && log.date) {
      const key = log.username + '_' + log.date;
      if (!map.has(key)) map.set(key, log);
    }
  });

  if (incomingData.stockAccounts && incomingData.stockAccounts.length > 0) {
    shopData.stockAccounts = incomingData.stockAccounts;
  }
  if (incomingData.settings) {
    shopData.settings = incomingData.settings;
  }
  if (incomingData.packages && incomingData.packages.length > 0) {
    shopData.packages = incomingData.packages;
  }

  shopData.salesLogs = Array.from(map.values()).filter(l => !isDeleted(l));
  persist();
  return shopData;
}

function notifyAllClients(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
  sseClients.forEach(client => {
    try { client.res.write(`data: ${msg}\n\n`); } catch (err) {}
  });
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */
app.get('/api/version', (req, res) => {
  res.json({
    success: true,
    lastUpdated,
    orderCount: orderCount(),
    storage: pool ? 'postgres' : 'file'
  });
});

app.get('/api/data', (req, res) => {
  res.json({ success: true, data: shopData, lastUpdated });
});

app.post('/api/sync', (req, res) => {
  const newData = req.body;
  if (newData && typeof newData === 'object') {
    mergeShopData(newData);
    lastUpdated = Date.now();
    notifyAllClients({ type: 'DATA_SYNC', data: shopData, lastUpdated });
    res.json({ success: true, lastUpdated, count: orderCount() });
  } else {
    res.status(400).json({ error: 'Invalid data' });
  }
});

// Delete exactly one order. Matched on id + date + username because older data
// contains repeated ids (a client bug assigned ORD-0001 to many orders), and
// deleting by id alone would take all of them.
app.post('/api/delete-order', (req, res) => {
  const { id, date, username } = req.body || {};
  if (!id) return res.status(400).json({ success: false, error: 'id required' });
  if (!shopData || !Array.isArray(shopData.salesLogs)) {
    return res.status(409).json({ success: false, error: 'no data loaded' });
  }

  const sig = [id, date, username].join('|');
  const i = shopData.salesLogs.findIndex(l => logSig(l) === sig);
  if (i === -1) {
    return res.json({ success: true, removed: 0, count: orderCount(), lastUpdated });
  }

  shopData.salesLogs.splice(i, 1);
  shopData.deletedOrders = (shopData.deletedOrders || []).concat(sig).slice(-MAX_TOMBSTONES);
  lastUpdated = Date.now();
  persist();
  notifyAllClients({ type: 'DATA_SYNC', data: shopData, lastUpdated });
  res.json({ success: true, removed: 1, count: orderCount(), lastUpdated });
});

// Download the whole shop as a backup file.
app.get('/api/backup', (req, res) => {
  const name = 'cozy-robux-backup-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.json';
  res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify({ success: true, data: shopData, lastUpdated }, null, 2));
});

// History of previous states, newest first.
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
    const { rows } = await pool.query('SELECT data, order_count, created_at FROM shop_snapshots WHERE id = $1',
      [req.params.id]);
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
  res.flushHeaders();

  const clientId = Date.now() + Math.random();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  res.write(`data: ${JSON.stringify({ type: 'INIT', data: shopData, lastUpdated })}\n\n`);

  const keepAliveInterval = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(keepAliveInterval); }
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAliveInterval);
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

wss.on('connection', (ws) => {
  if (shopData) {
    ws.send(JSON.stringify({ type: 'INIT_DATA', data: shopData, lastUpdated }));
  }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message);
      if (parsed.type === 'UPDATE_DATA' && parsed.data) {
        mergeShopData(parsed.data);
        lastUpdated = Date.now();
        notifyAllClients({ type: 'DATA_SYNC', data: shopData, lastUpdated });
      }
    } catch (err) {
      console.error('WS message error:', err);
    }
  });
});

const wsInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);

server.on('close', () => clearInterval(wsInterval));

initStorage()
  .catch(e => {
    console.error('Storage init failed, falling back to file:', e.message);
    pool = null;
    shopData = readSeedFile();
  })
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`🌸 Cozy Robux Studio running on port ${PORT} - ` +
        orderCount() + ' orders, storage: ' + (pool ? 'postgres' : 'file'));
    });
  });
