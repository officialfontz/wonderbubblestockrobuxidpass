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

function loadShopData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      shopData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load shop_data.json:', e);
  }
}
loadShopData();

function saveShopDataToFile() {
  try {
    if (!fs.existsSync(path.join(__dirname, 'data'))) {
      fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(shopData, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save shop_data.json:', e);
  }
}

// SMART MERGE FUNCTION
function mergeShopData(incomingData) {
  if (!incomingData || typeof incomingData !== 'object') return shopData;
  if (!shopData) {
    shopData = incomingData;
    saveShopDataToFile();
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

  shopData.salesLogs = Array.from(map.values());
  saveShopDataToFile();
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

app.get('/api/version', (req, res) => {
  res.json({
    success: true,
    lastUpdated,
    orderCount: (shopData && shopData.salesLogs) ? shopData.salesLogs.length : 0
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
    res.json({ success: true, lastUpdated, count: shopData.salesLogs.length });
  } else {
    res.status(400).json({ error: 'Invalid data' });
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

server.listen(PORT, () => {
  console.log(`🌸 Cozy Robux Studio Bulletproof Zero-Loss server running on port ${PORT}`);
});
