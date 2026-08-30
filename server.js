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

// Load data into memory
let shopData = null;
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

// Broadcast to all connected clients
function broadcast(payload, senderWs = null) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// REST API
app.get('/api/data', (req, res) => {
  res.json({ success: true, data: shopData });
});

app.post('/api/sync', (req, res) => {
  const newData = req.body;
  if (newData && typeof newData === 'object') {
    shopData = newData;
    saveShopDataToFile();
    broadcast({ type: 'DATA_SYNC', data: shopData });
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Invalid data' });
  }
});

// WebSocket Server
wss.on('connection', (ws) => {
  // Send current data immediately upon connection
  if (shopData) {
    ws.send(JSON.stringify({ type: 'INIT_DATA', data: shopData }));
  }

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message);
      if (parsed.type === 'UPDATE_DATA' && parsed.data) {
        shopData = parsed.data;
        saveShopDataToFile();
        // Broadcast update to all other connected clients
        broadcast({ type: 'DATA_SYNC', data: shopData }, ws);
      }
    } catch (err) {
      console.error('WS message error:', err);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🌸 Cozy Robux Studio server running on port ${PORT}`);
});
