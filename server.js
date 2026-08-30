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

try {
  if (fs.existsSync(DATA_FILE)) {
    shopData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
} catch (e) {
  console.error('Failed to load shop_data.json:', e);
}

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

function notifyAllClients(payload) {
  const msg = JSON.stringify(payload);
  
  // 1. Broadcast to all WebSocket clients
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });

  // 2. Broadcast to all SSE clients (mobile phones / safari)
  sseClients.forEach(client => {
    try {
      client.res.write(`data: ${msg}\n\n`);
    } catch (err) {
      // client dropped
    }
  });
}

// REST API: Fast version check (<1ms)
app.get('/api/version', (req, res) => {
  res.json({
    success: true,
    lastUpdated,
    orderCount: (shopData && shopData.salesLogs) ? shopData.salesLogs.length : 0
  });
});

// REST API: Full data
app.get('/api/data', (req, res) => {
  res.json({ success: true, data: shopData, lastUpdated });
});

// REST API: Sync update from any device
app.post('/api/sync', (req, res) => {
  const newData = req.body;
  if (newData && typeof newData === 'object') {
    shopData = newData;
    lastUpdated = Date.now();
    saveShopDataToFile();
    notifyAllClients({ type: 'DATA_SYNC', data: shopData, lastUpdated });
    res.json({ success: true, lastUpdated });
  } else {
    res.status(400).json({ error: 'Invalid data' });
  }
});

// SSE (Server-Sent Events) Stream Endpoint
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now() + Math.random();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  res.write(`data: ${JSON.stringify({ type: 'INIT', data: shopData, lastUpdated })}\n\n`);

  // Keep-alive heartbeat every 15s to prevent cloud proxies from dropping SSE
  const keepAliveInterval = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch (e) {
      clearInterval(keepAliveInterval);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAliveInterval);
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// WebSocket Server with Ping/Pong Heartbeat
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
        shopData = parsed.data;
        lastUpdated = Date.now();
        saveShopDataToFile();
        notifyAllClients({ type: 'DATA_SYNC', data: shopData, lastUpdated });
      }
    } catch (err) {
      console.error('WS message error:', err);
    }
  });
});

// WS Heartbeat ping every 20s
const wsInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);

server.on('close', () => clearInterval(wsInterval));

server.listen(PORT, () => {
  console.log(`🌸 Cozy Robux Studio 3-Layer Realtime server running on port ${PORT}`);
});
