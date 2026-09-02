/* ==========================================================================
 * Wonder Bubble Studio - shop client
 *
 * Rewritten from the single-file build. The three things that were actually
 * losing work, and what replaced them:
 *
 *  1. Boot used to scan every localStorage key and keep whichever cache held
 *     the MOST orders, regardless of age; applyServerData() then refused any
 *     server payload that had fewer rows and pushed the stale cache back up.
 *     A browser holding an end-of-month snapshot could therefore never see a
 *     newer day, and re-uploaded the old month over everybody else.
 *     Now: the server is always the base. Local rows the server has never
 *     seen are reported, not silently pushed.
 *
 *  2. Order ids were generated client-side as max+1, so two tills produced the
 *     same ORD-#### and the server merged the two orders into one. Every row
 *     now carries a `uid`; ORD-#### is only a label. Legacy rows get a uid
 *     derived deterministically from their own fields, so every client and the
 *     server agree on it without a migration.
 *
 *  3. Edits could only touch the overpress count and the note, so a row saved
 *     against the wrong customer, package or DATE could never be corrected.
 *     The edit dialog now covers every field on the order.
 * ========================================================================== */

'use strict';

/* ---------------------------------------------------------------- config */
const STORAGE_KEY = 'WONDER_BUBBLE_STUDIO_V1';
const LEGACY_PREFIX = 'COZY_ROBUX_STUDIO';
const ROBUX_ICON = 'https://img.bubbleshoproblox.store/img/2026-08/3a9b1e8f-f363-4469-8081-e6e708faa92b.webp';

/** USD charged by Roblox for each purchasable pack. */
const PACK_USD = { '80': 0.99, '500': 4.99, '1000': 9.99, '2000': 19.99 };
const PACK_KEYS = ['80', '500', '1000', '2000'];

const POLL_MS = 12000;
const PUSH_DEBOUNCE_MS = 600;
const PAGE_SIZE = 40;

const IS_HTTP = location.protocol === 'http:' || location.protocol === 'https:';

const FALLBACK = {
  settings: { defaultEvalRate: 25.5, employees: ['ฟ้อน', 'เม้กโกะกีระบิด', 'แอดมินบอส'], employeeEmojis: {} },
  packages: [
    { robux: 80, price: 35, usd: 0.99, pressGuide: 'กด 80R × 1' },
    { robux: 160, price: 69, usd: 1.98, pressGuide: 'กด 80R × 2' },
    { robux: 240, price: 99, usd: 2.97, pressGuide: 'กด 80R × 3' },
    { robux: 400, price: 159, usd: 4.95, pressGuide: 'กด 80R × 5' },
    { robux: 500, price: 169, usd: 4.99, pressGuide: 'กด 500R × 1' },
    { robux: 1000, price: 325, usd: 9.99, pressGuide: 'กด 1,000R × 1' },
    { robux: 2000, price: 639, usd: 19.99, pressGuide: 'กด 2,000R × 1' },
    { robux: 3000, price: 949, usd: 29.98, pressGuide: 'กด 2,000R × 1 + กด 1,000R × 1' },
    { robux: 4000, price: 1249, usd: 39.98, pressGuide: 'กด 2,000R × 2' },
    { robux: 5000, price: 1549, usd: 49.97, pressGuide: 'กด 2,000R × 2 + กด 1,000R × 1' },
    { robux: 10000, price: 2990, usd: 99.95, pressGuide: 'กด 2,000R × 5' },
    { robux: 20000, price: 5890, usd: 199.9, pressGuide: 'กด 2,000R × 10' }
  ],
  stockAccounts: [],
  salesLogs: [],
  deletedOrders: []
};

/* ----------------------------------------------------------------- utils */
const $ = (sel, root) => (root || document).querySelector(sel);
const byId = (id) => document.getElementById(id);

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Everything user-typed goes through this before it reaches innerHTML. */
function esc(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback || 0);
}
function round2(v) { return Math.round((num(v) + Number.EPSILON) * 100) / 100; }

function fmt(v) {
  return num(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(v) {
  return Math.round(num(v)).toLocaleString('th-TH');
}
/** ฿ needs the Thai face, not the mono one, or it collides with the digits. */
function baht(v, sign) {
  const n = num(v);
  const s = sign ? (n >= 0 ? '+' : '-') : (n < 0 ? '-' : '');
  return s + '<span class="baht">฿</span>' + fmt(Math.abs(n));
}

const pad2 = (n) => String(n).padStart(2, '0');

/** The shop's own clock. toISOString() is UTC and stamped every order 7h early. */
function localDateTime(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()) +
    ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes());
}
function localDate(d) { return localDateTime(d).slice(0, 10); }
function shiftDays(n, from) {
  const d = from ? new Date(from) : new Date();
  d.setDate(d.getDate() - n);
  return d;
}

/**
 * Accepts every shape the old build produced - 'YYYY-MM-DD', ISO with a T,
 * with or without seconds - and returns 'YYYY-MM-DD HH:MM'. A bare date keeps
 * a real time of 00:00 so sorting and the day grouping stop disagreeing.
 */
function normalizeStamp(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return localDateTime();
  return m[1] + '-' + m[2] + '-' + m[3] + ' ' + (m[4] || '00') + ':' + (m[5] || '00');
}
const dayOf = (log) => String(log && log.date || '').slice(0, 10);

/** FNV-1a. Must stay byte-identical to hash32() in server.js. */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
/**
 * Identity derived from the sale itself. Must match contentUid() in server.js.
 * `date` is expected to be normalised already.
 */
function contentUid(l) {
  return 'L' + hash32([l.id, l.date, l.username, l.robux, l.stockAccount].join('|'));
}

/**
 * Only a minted uid (leading 'O') is authoritative - it is random and cannot be
 * derived. Everything else is recomputed from content, so a cache carrying a
 * uid from the build that hashed unrepaired dates heals itself on load instead
 * of re-uploading a duplicate.
 */
function canonicalUid(row) {
  if (typeof row.uid === 'string' && row.uid.charAt(0) === 'O') return row.uid;
  return contentUid(row);
}
function newUid() {
  return 'O' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1679616).toString(36);
}

function debounce(fn, ms) {
  let t = null;
  return function () {
    const args = arguments;
    clearTimeout(t);
    t = setTimeout(() => fn.apply(null, args), ms);
  };
}

function svg(paths, cls) {
  return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
}
const ICON = {
  cashier: '<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  stock: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/>',
  tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><path d="M7 7h.01"/>',
  chart: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/>',
  down: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
  up: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  trend: '<path d="M23 6l-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/>',
  bars: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
  cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'
};

/* ----------------------------------------------------------------- state */
let data = clone(FALLBACK);

const state = {
  tab: 'cashier',
  selRobux: 1000,
  selStock: '',
  extras: emptyExtras(),
  showExtras: false,
  pricingRate: 25.5,
  hist: { range: '7d', from: '', to: '', q: '', limit: PAGE_SIZE, flag: '' },
  summaryRange: 'today',
  emojiFor: null,
  editStockIdx: null,
  adjustIdx: null,
  adjustType: 'count',
  editUid: null,
  editExtras: emptyExtras(),
  orphanCount: 0,
  online: false,
  storage: IS_HTTP ? 'server' : 'local'
};

/** uids changed here and not yet acknowledged by the server. Persisted, so an
 *  order taken while the wifi was down still goes up after a reload. */
let pendingUids = new Set();
let pendingMeta = false;
let serverStamp = 0;
let ws = null;
let sse = null;
let lastUndo = null;

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function emptyExtras() { return { '80': 0, '500': 0, '1000': 0, '2000': 0 }; }

/* --------------------------------------------------------- normalisation */
/**
 * Brings any historical shape up to the current one: gives every row a uid,
 * repairs date strings, coerces the money fields to numbers and drops rows
 * that are duplicated by uid.
 */
function normalize(raw) {
  const d = (raw && typeof raw === 'object') ? raw : {};
  const out = {
    settings: Object.assign({ defaultEvalRate: 25.5, employees: [], employeeEmojis: {} }, d.settings || {}),
    packages: Array.isArray(d.packages) && d.packages.length ? d.packages : clone(FALLBACK.packages),
    stockAccounts: Array.isArray(d.stockAccounts) ? d.stockAccounts : [],
    salesLogs: [],
    deletedOrders: Array.isArray(d.deletedOrders) ? d.deletedOrders.slice(-800) : []
  };
  if (!Array.isArray(out.settings.employees) || !out.settings.employees.length) {
    out.settings.employees = clone(FALLBACK.settings.employees);
  }
  if (!out.settings.employeeEmojis || typeof out.settings.employeeEmojis !== 'object') {
    out.settings.employeeEmojis = {};
  }

  out.stockAccounts = out.stockAccounts.filter(a => a && a.id).map(a => {
    const rate = num(a.rate) || 25.5;
    const seenAdj = new Set();
    return {
      id: String(a.id),
      email: String(a.email || ''),
      buyDate: String(a.buyDate || ''),
      initialUsd: num(a.initialUsd),
      rate: rate,
      investmentThb: num(a.investmentThb) || round2(num(a.initialUsd) * rate),
      status: a.status === 'ปิดใช้งาน' ? 'ปิดใช้งาน' : 'พร้อมใช้',
      note: String(a.note || ''),
      removedAdjustments: (Array.isArray(a.removedAdjustments) ? a.removedAdjustments : []).slice(-500),
      // Top-ups and stock counts. Kept as a list rather than folded into
      // initialUsd so the shop can see when the credit drifted and by how much.
      adjustments: (Array.isArray(a.adjustments) ? a.adjustments : [])
        .filter(x => x && typeof x === 'object')
        .map(x => ({
          uid: String(x.uid || newUid()),
          date: normalizeStamp(x.date),
          type: x.type === 'topup' ? 'topup' : 'count',
          usd: num(x.usd),
          rate: num(x.rate) || rate,
          thb: num(x.thb),
          note: String(x.note || ''),
          staff: String(x.staff || '')
        }))
        .filter(x => (seenAdj.has(x.uid) ? false : (seenAdj.add(x.uid), true)))
        .filter(x => (Array.isArray(a.removedAdjustments) ? a.removedAdjustments : []).indexOf(x.uid) === -1)
        .sort((x, y) => (x.date < y.date ? 1 : -1))
    };
  });

  const seen = new Set();
  (Array.isArray(d.salesLogs) ? d.salesLogs : []).forEach(l => {
    if (!l || typeof l !== 'object') return;
    const row = {
      uid: String(l.uid || ''),
      id: String(l.id || ''),
      date: normalizeStamp(l.date),
      username: String(l.username || ''),
      robux: num(l.robux),
      stockAccount: String(l.stockAccount || ''),
      priceThb: num(l.priceThb),
      pressGuide: String(l.pressGuide || ''),
      rate: num(l.rate),
      usd: num(l.usd),
      costThb: num(l.costThb),
      profitThb: num(l.profitThb),
      staff: String(l.staff || 'ไม่ระบุ'),
      status: String(l.status || 'สำเร็จ'),
      note: String(l.note || ''),
      extraPacks: Object.assign(emptyExtras(), l.extraPacks || {})
    };
    row.uid = canonicalUid(row);
    if (seen.has(row.uid)) return;
    seen.add(row.uid);
    out.salesLogs.push(row);
  });

  const tomb = new Set(out.deletedOrders);
  out.salesLogs = out.salesLogs.filter(l => !tomb.has(l.uid));
  sortLogs(out.salesLogs);
  return out;
}

/** Newest first, and stable when two rows share a timestamp. */
function sortLogs(list) {
  list.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return String(b.uid).localeCompare(String(a.uid));
  });
}

/* -------------------------------------------------------------- storage  */
function saveLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      data,
      pending: Array.from(pendingUids),
      pendingMeta,
      serverStamp,
      savedAt: Date.now()
    }));
  } catch (e) {
    console.error('local save failed', e);
  }
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const box = JSON.parse(raw);
    if (!box || !box.data) return null;
    pendingUids = new Set(Array.isArray(box.pending) ? box.pending : []);
    pendingMeta = !!box.pendingMeta;
    serverStamp = num(box.serverStamp);
    return normalize(box.data);
  } catch (e) {
    console.warn('local cache unreadable', e);
    return null;
  }
}

/**
 * Caches written by the previous build, newest first. Only ever read on
 * demand, from the recovery dialog - never merged automatically, because
 * doing that automatically is what kept resurrecting last month.
 */
function legacyCaches() {
  const found = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || key.indexOf(LEGACY_PREFIX) !== 0) continue;
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      const logs = parsed && Array.isArray(parsed.salesLogs) ? parsed.salesLogs : null;
      if (!logs || !logs.length) continue;
      const days = logs.map(dayOf).filter(Boolean).sort();
      found.push({ key, count: logs.length, from: days[0], to: days[days.length - 1], data: parsed });
    } catch (e) { /* not ours */ }
  }
  return found.sort((a, b) => String(b.to).localeCompare(String(a.to)));
}

/* ----------------------------------------------------------------- sync  */
/**
 * The server copy is always the base. Rows we changed here and have not had
 * acknowledged are laid back on top; anything else that exists only in this
 * browser is counted and reported rather than pushed, so a forgotten tab can
 * no longer republish an old month.
 */
function applyServer(payload, stamp, source) {
  if (!payload) return;
  const incoming = normalize(payload);
  const localById = new Map(data.salesLogs.map(l => [l.uid, l]));
  const map = new Map(incoming.salesLogs.map(l => [l.uid, l]));

  pendingUids.forEach(uid => {
    const mine = localById.get(uid);
    if (mine) map.set(uid, mine);
  });

  let orphans = 0;
  const tomb = new Set(incoming.deletedOrders);
  localById.forEach((l, uid) => {
    if (!map.has(uid) && !tomb.has(uid)) orphans++;
  });
  state.orphanCount = orphans;

  incoming.salesLogs = Array.from(map.values());
  sortLogs(incoming.salesLogs);

  if (pendingMeta) {
    incoming.stockAccounts = data.stockAccounts;
    incoming.settings = data.settings;
  }

  data = incoming;
  serverStamp = num(stamp) || Date.now();
  state.online = true;
  saveLocal();
  render();
  if (pendingUids.size || pendingMeta) push();
  if (source) console.debug('[sync] applied from ' + source + ', ' + data.salesLogs.length + ' orders');
}

async function fetchServer() {
  if (!IS_HTTP) return;
  try {
    const res = await fetch('/api/data?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    const json = await res.json();
    if (json && json.data) applyServer(json.data, json.lastUpdated, 'fetch');
    state.storage = json && json.storage ? json.storage : 'server';
  } catch (e) {
    state.online = false;
    renderStatus();
  }
}

/** Only the rows this browser changed go up. The whole document used to be
 *  posted on every keystroke - 330 KB a time on a phone. */
function payload() {
  const pending = data.salesLogs.filter(l => pendingUids.has(l.uid));
  const body = { salesLogs: pending };
  if (pendingMeta) {
    body.stockAccounts = data.stockAccounts;
    body.settings = data.settings;
    body.packages = data.packages;
  }
  return body;
}

async function pushNow() {
  if (!IS_HTTP) { saveLocal(); return; }
  if (!pendingUids.size && !pendingMeta) return;
  const sending = Array.from(pendingUids);
  const sendingMeta = pendingMeta;
  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload())
    });
    if (!res.ok) throw new Error('http ' + res.status);
    const json = await res.json();
    sending.forEach(uid => pendingUids.delete(uid));
    if (sendingMeta) pendingMeta = false;
    serverStamp = num(json && json.lastUpdated) || serverStamp;
    state.online = true;
    saveLocal();
    renderStatus();
  } catch (e) {
    // Keep the uids queued; the next change or poll retries them.
    state.online = false;
    renderStatus();
  }
}
const push = debounce(pushNow, PUSH_DEBOUNCE_MS);

/** Call after any local mutation. `uids` are the order rows that changed. */
function commit(uids, meta) {
  (uids || []).forEach(u => pendingUids.add(u));
  if (meta) pendingMeta = true;
  saveLocal();
  push();
}

function openStreams() {
  if (!IS_HTTP) return;

  if (typeof EventSource !== 'undefined') {
    try {
      if (sse) sse.close();
      sse = new EventSource('/api/stream');
      sse.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg && msg.data && num(msg.lastUpdated) > serverStamp) {
            applyServer(msg.data, msg.lastUpdated, 'sse');
          }
        } catch (e) { /* heartbeat */ }
      };
    } catch (e) { /* proxy without SSE */ }
  }

  connectWs();
  setInterval(checkVersion, POLL_MS);
  window.addEventListener('focus', checkVersion);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
  window.addEventListener('online', () => { checkVersion(); pushNow(); });
}

function connectWs() {
  try {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws');
    ws.onopen = () => { state.online = true; renderStatus(); };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg && msg.data && num(msg.lastUpdated) > serverStamp) {
          applyServer(msg.data, msg.lastUpdated, 'ws');
        }
      } catch (e) { /* ignore */ }
    };
    ws.onclose = () => { ws = null; setTimeout(connectWs, 4000); };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  } catch (e) { /* ws unavailable */ }
}

async function checkVersion() {
  if (!IS_HTTP) return;
  try {
    const res = await fetch('/api/version?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    const json = await res.json();
    state.storage = json.storage || state.storage;
    state.online = true;
    if (num(json.lastUpdated) > serverStamp) await fetchServer();
    else renderStatus();
    if (pendingUids.size || pendingMeta) pushNow();
  } catch (e) {
    state.online = false;
    renderStatus();
  }
}

/* ------------------------------------------------------------- derived   */
/**
 * remaining = first top-up + every later top-up + every counted correction
 *             - the USD every order charged to this mail
 *
 * `variance` is the correction total on its own: credit that went missing (or
 * turned up) without an order to explain it. That is the number worth watching
 * - a mail that keeps needing the same size of correction is losing money
 * somewhere the till never sees.
 */
function stockBalances() {
  const bal = {};
  data.stockAccounts.forEach(a => {
    let topup = 0, variance = 0, investment = a.investmentThb;
    (a.adjustments || []).forEach(x => {
      if (x.type === 'topup') { topup += x.usd; investment += x.thb; }
      else variance += x.usd;
    });
    bal[a.id] = {
      initialUsd: a.initialUsd,
      topupUsd: topup,
      fundedUsd: a.initialUsd + topup,
      varianceUsd: variance,
      investmentThb: investment,
      usedUsd: 0,
      remainingUsd: a.initialUsd + topup + variance,
      salesThb: 0, profitThb: 0, orders: 0,
      lastCount: (a.adjustments || []).find(x => x.type === 'count') || null
    };
  });
  data.salesLogs.forEach(l => {
    const b = bal[l.stockAccount];
    if (!b) return;
    b.usedUsd += l.usd;
    b.remainingUsd -= l.usd;
    b.salesThb += l.priceThb;
    b.profitThb += l.profitThb;
    b.orders += 1;
  });
  return bal;
}

function activeStocks() {
  const open = data.stockAccounts.filter(s => s.status === 'พร้อมใช้');
  return open.length ? open : data.stockAccounts;
}

function findPackage(robux) {
  return data.packages.find(p => num(p.robux) === num(robux)) || data.packages[0];
}
function findStock(id) {
  return data.stockAccounts.find(s => s.id === id) || null;
}
function findLog(uid) {
  return data.salesLogs.find(l => l.uid === uid) || null;
}

function extrasUsd(extras) {
  return PACK_KEYS.reduce((s, k) => s + num(extras[k]) * PACK_USD[k], 0);
}
function extrasLabel(extras, sep) {
  return PACK_KEYS.filter(k => num(extras[k]) > 0)
    .map(k => '+' + fmtInt(k) + 'R × ' + extras[k]).join(sep || ' + ');
}
function hasExtras(extras) { return PACK_KEYS.some(k => num(extras[k]) > 0); }

/** Days covered by a named range, oldest first. null = everything. */
function rangeDays(key) {
  const today = new Date();
  if (key === 'today') return [localDate()];
  if (key === 'yesterday') return [localDate(shiftDays(1))];
  if (key === '7d') return Array.from({ length: 7 }, (_, i) => localDate(shiftDays(6 - i)));
  if (key === '30d') return Array.from({ length: 30 }, (_, i) => localDate(shiftDays(29 - i)));
  if (key === 'month') {
    return Array.from({ length: today.getDate() },
      (_, i) => localDate(new Date(today.getFullYear(), today.getMonth(), i + 1)));
  }
  if (key === 'lastmonth') {
    const end = new Date(today.getFullYear(), today.getMonth(), 0);
    return Array.from({ length: end.getDate() },
      (_, i) => localDate(new Date(end.getFullYear(), end.getMonth(), i + 1)));
  }
  return null;
}

function sum(list, pick) { return list.reduce((s, x) => s + num(pick(x)), 0); }

/* -------------------------------------------------------- data health    */
/**
 * The failures worth surfacing rather than hiding: dates in the future or
 * missing a time, ORD labels used twice, and rows charged to a mail that is
 * no longer in the list.
 */
function healthReport() {
  const today = localDate();
  const future = [], dupes = [], orphan = [];
  const idCount = new Map();

  data.salesLogs.forEach(l => {
    if (dayOf(l) > today) future.push(l);
    if (l.id) idCount.set(l.id, (idCount.get(l.id) || 0) + 1);
    if (l.stockAccount && !findStock(l.stockAccount)) orphan.push(l);
  });
  data.salesLogs.forEach(l => { if (l.id && idCount.get(l.id) > 1) dupes.push(l); });

  const bal = stockBalances();
  const negative = data.stockAccounts.filter(a => (bal[a.id] || {}).remainingUsd < -0.005);

  return { future, dupes, orphan, negative, total: future.length + dupes.length + orphan.length + negative.length };
}

/* =========================================================================
 * RENDER
 * ======================================================================= */
function render() {
  renderStatus();
  renderTopKpi();
  renderTabCounts();
  renderTab();
}

function renderTab() {
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('hidden', p.id !== 'panel-' + state.tab));
  document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
  const fn = { cashier: renderCashier, history: renderHistory, stocks: renderStocks, pricing: renderPricing, summary: renderSummary }[state.tab];
  if (fn) fn();
}

function renderStatus() {
  const el = byId('status');
  if (!el) return;
  let cls = 'status is-live', label = 'ซิงก์สด';
  if (!IS_HTTP) { cls = 'status is-local'; label = 'โหมดในเครื่อง'; }
  else if (!state.online) { cls = 'status is-off'; label = 'ออฟไลน์'; }
  else if (pendingUids.size || pendingMeta) { cls = 'status is-local'; label = 'กำลังส่งขึ้น ' + (pendingUids.size || 1); }
  else if (state.storage === 'file') { cls = 'status is-local'; label = 'เซิร์ฟเวอร์ (ไฟล์)'; }
  el.className = cls;
  el.innerHTML = '<span class="dot"></span><span>' + esc(label) + '</span>';
}

function renderTopKpi() {
  const box = byId('topkpi');
  if (!box) return;
  const today = localDate();
  const todays = data.salesLogs.filter(l => dayOf(l) === today);
  const sales = sum(todays, l => l.priceThb);
  const profit = sum(todays, l => l.profitThb);
  const cell = (k, v, cls) =>
    '<div><span class="t-xs">' + k + '</span><b class="' + (cls || '') + '">' + v + '</b></div>';
  box.innerHTML =
    cell('วันนี้', fmtInt(todays.length) + ' ออเดอร์') +
    '<span class="sep"></span>' +
    cell('ยอดขาย', baht(sales)) +
    '<span class="sep"></span>' +
    cell('กำไร', baht(profit), profit >= 0 ? 'pos' : 'neg');
}

function renderTabCounts() {
  const open = data.stockAccounts.filter(s => s.status === 'พร้อมใช้').length;
  document.querySelectorAll('[data-count="stocks"]').forEach(el => { el.textContent = open; });
  const h = healthReport();
  document.querySelectorAll('[data-count="history"]').forEach(el => {
    el.textContent = h.total ? h.total : fmtInt(data.salesLogs.length);
    el.classList.toggle('bad', h.total > 0);
  });
}

/* ------------------------------------------------------------- cashier   */
function renderCashier() {
  // package pills
  byId('pkg-grid').innerHTML = data.packages.map(p => {
    const on = num(p.robux) === state.selRobux;
    return '<button type="button" class="pkg" data-act="pick-pkg" data-robux="' + num(p.robux) + '" aria-pressed="' + on + '">' +
      '<span class="r"><img src="' + ROBUX_ICON + '" alt="" onerror="this.remove()"><span>' + fmtInt(p.robux) + '</span></span>' +
      '<span class="p">' + baht(p.price) + '</span></button>';
  }).join('');

  // staff
  const staffSel = byId('f-staff');
  const keepStaff = staffSel.value;
  staffSel.innerHTML = data.settings.employees
    .map(e => '<option value="' + esc(e) + '">' + esc(e) + '</option>').join('');
  if (keepStaff && data.settings.employees.indexOf(keepStaff) !== -1) staffSel.value = keepStaff;

  // mail account
  const bal = stockBalances();
  const list = activeStocks();
  if (!list.some(s => s.id === state.selStock)) {
    state.selStock = list.length ? list[list.length - 1].id : '';
  }
  byId('f-stock').innerHTML = list.length
    ? list.map(s => {
      const b = bal[s.id] || { remainingUsd: s.initialUsd };
      return '<option value="' + esc(s.id) + '"' + (s.id === state.selStock ? ' selected' : '') + '>' +
        esc(s.id) + ' · เหลือ $' + fmt(b.remainingUsd) + ' · เรท ' + fmt(s.rate) + '</option>';
    }).join('')
    : '<option value="">— ยังไม่มีเมลในระบบ —</option>';

  // overpress steppers
  byId('extras-box').classList.toggle('hidden', !state.showExtras);
  byId('btn-extras').innerHTML = state.showExtras ? '✕ ซ่อนช่องกดเกิน' : '+ มีเผลอกดเกิน';
  byId('extras-grid').innerHTML = PACK_KEYS.map(k => stepperHtml(k, state.extras[k], 'extra')).join('');

  renderGuide();
  renderRecent();
}

function stepperHtml(k, val, scope) {
  return '<div class="stepper' + (num(val) > 0 ? ' on' : '') + '">' +
    '<span class="cap">+' + fmtInt(k) + 'R</span>' +
    '<span class="ctl">' +
    '<button type="button" data-act="' + scope + '-step" data-k="' + k + '" data-d="-1" aria-label="ลด">−</button>' +
    '<output>' + num(val) + '</output>' +
    '<button type="button" data-act="' + scope + '-step" data-k="' + k + '" data-d="1" aria-label="เพิ่ม">+</button>' +
    '</span></div>';
}

/** Everything the cashier screen needs to price the sale in front of them. */
function quote(robux, extras, stockId, priceOverride) {
  const pkg = findPackage(robux);
  const stock = findStock(stockId) || activeStocks()[0] || null;
  const totalUsd = round2(num(pkg && pkg.usd) + extrasUsd(extras));
  const rate = stock ? stock.rate : 0;
  const costThb = round2(totalUsd * rate);
  const price = priceOverride === undefined || priceOverride === null || priceOverride === ''
    ? num(pkg && pkg.price) : num(priceOverride);
  const profitThb = round2(price - costThb);
  const bal = stockBalances();
  const remain = stock ? num((bal[stock.id] || {}).remainingUsd) : 0;
  return {
    pkg, stock, totalUsd, rate, costThb, price, profitThb,
    margin: price > 0 ? (profitThb / price) * 100 : 0,
    remain, remainAfter: remain - totalUsd, enough: !stock || remain >= totalUsd
  };
}

function renderGuide() {
  const box = byId('guide');
  const q = quote(state.selRobux, state.extras, state.selStock);

  if (!q.stock) {
    box.className = 'guide is-blocked';
    box.innerHTML = '<div class="guide-main"><div class="guide-badge">!</div><div class="grow">' +
      '<div class="guide-kicker">ยังบันทึกไม่ได้</div>' +
      '<div class="guide-text">ต้องเพิ่มสต็อกเมลก่อน</div></div>' +
      '<button type="button" class="btn btn-line sm" data-act="go" data-tab="stocks">ไปเพิ่มเมล</button></div>';
    return;
  }

  const blocked = !q.enough;
  box.className = 'guide' + (blocked ? ' is-blocked' : '');
  const extra = hasExtras(state.extras)
    ? '<span class="guide-extra">เผลอกดเกิน ' + esc(extrasLabel(state.extras)) + '</span>' : '';

  box.innerHTML =
    '<div class="guide-main">' +
      '<div class="guide-badge">' + (blocked ? '!' : '🎮') + '</div>' +
      '<div class="grow">' +
        '<div class="guide-kicker">' + (blocked ? 'เครดิตไม่พอ — เปลี่ยนเมลก่อน' : 'วิธีกดในเกม (ทำตามนี้)') + '</div>' +
        '<div class="guide-text"><span>👉</span><span>' + esc(q.pkg.pressGuide) + '</span>' + extra + '</div>' +
      '</div>' +
      '<span class="guide-usd"><img src="' + ROBUX_ICON + '" alt="" onerror="this.remove()">' +
        'ตัดเครดิต $' + q.totalUsd.toFixed(2) + '</span>' +
    '</div>' +
    '<div class="guide-stats">' +
      '<div class="guide-stat"><div class="k">เมลที่ตัด</div>' +
        '<div class="v brand">' + esc(q.stock.id) + '</div>' +
        '<div class="s">เรท ' + fmt(q.rate) + ' ฿/$ · เหลือ $' + fmt(q.remainAfter) + '</div></div>' +
      '<div class="guide-stat"><div class="k">ราคา / ทุน</div>' +
        '<div class="v">' + baht(q.price) + '</div>' +
        '<div class="s">ทุน ' + baht(q.costThb) + '</div></div>' +
      '<div class="guide-stat ' + (q.profitThb >= 0 ? 'profit' : 'loss') + '"><div class="k">กำไรสุทธิ</div>' +
        '<div class="v">' + baht(q.profitThb, true) + '</div>' +
        '<div class="s">มาร์จิ้น ' + q.margin.toFixed(1) + '%</div></div>' +
    '</div>';
}

function renderRecent() {
  const box = byId('recent-list');
  const recent = data.salesLogs.slice(0, 5);
  box.innerHTML = recent.length
    ? recent.map(orderHtml).join('')
    : '<div class="card empty"><div class="big">🌸</div>ยังไม่มีรายการเติม บันทึกออเดอร์แรกด้านบนได้เลย</div>';
  byId('recent-count').textContent = fmtInt(data.salesLogs.length) + ' รายการทั้งหมด';
}

function orderHtml(l) {
  const today = localDate();
  const flags = [];
  if (dayOf(l) > today) flags.push('วันที่อยู่ในอนาคต');
  if (l.stockAccount && !findStock(l.stockAccount)) flags.push('ไม่พบเมล ' + l.stockAccount);
  const flagged = flags.length > 0;

  return '<div class="order' + (flagged ? ' flagged' : '') + '">' +
    '<div class="order-tick">' + (flagged ? '!' : '✓') + '</div>' +
    '<div class="grow">' +
      '<div class="row between gap-sm">' +
        '<span class="order-name">' + esc(l.username || '(ไม่ระบุชื่อ)') + '</span>' +
        '<span class="order-money"><span class="p">' + baht(l.priceThb) + '</span><br>' +
          '<span class="g ' + (l.profitThb >= 0 ? 'pos' : 'neg') + '">' + baht(l.profitThb, true) + '</span></span>' +
      '</div>' +
      '<div class="row wrap gap-sm" style="margin-top:6px">' +
        '<span class="chip mono"><img src="' + ROBUX_ICON + '" alt="" onerror="this.remove()">' + fmtInt(l.robux) + '</span>' +
        '<span class="chip plain mono">' + esc(l.id || l.uid.slice(0, 8)) + '</span>' +
        (l.note ? '<span class="chip note break">' + esc(l.note) + '</span>' : '') +
        (flagged ? '<span class="chip bad">' + esc(flags.join(' · ')) + '</span>' : '') +
      '</div>' +
      '<div class="row between gap-sm" style="margin-top:6px;align-items:flex-end">' +
        '<span class="order-meta">' +
          '<span>' + esc(l.date) + '</span><span class="dot">•</span>' +
          '<span>ตัด ' + esc(l.stockAccount) + ' ($' + fmt(l.usd) + ')</span><span class="dot">•</span>' +
          '<span>' + esc(l.staff) + '</span>' +
        '</span>' +
        '<span class="order-actions">' +
          '<button class="iconbtn" data-act="edit-order" data-uid="' + esc(l.uid) + '" title="แก้ไขออเดอร์">' + svg(ICON.edit) + '</button>' +
          '<button class="iconbtn danger" data-act="del-order" data-uid="' + esc(l.uid) + '" title="ลบรายการ">' + svg(ICON.trash) + '</button>' +
        '</span>' +
      '</div>' +
    '</div></div>';
}

/* ------------------------------------------------------------- history   */
const HIST_RANGES = [
  { key: 'today', label: 'วันนี้' },
  { key: 'yesterday', label: 'เมื่อวาน' },
  { key: '7d', label: '7 วัน' },
  { key: '30d', label: '30 วัน' },
  { key: 'month', label: 'เดือนนี้' },
  { key: 'lastmonth', label: 'เดือนที่แล้ว' },
  { key: 'all', label: 'ทั้งหมด' },
  { key: 'custom', label: 'เลือกวันเอง' }
];

function historyLogs() {
  const h = state.hist;
  let list = data.salesLogs;

  if (h.flag) {
    const rep = healthReport();
    const pick = { future: rep.future, dupes: rep.dupes, orphan: rep.orphan }[h.flag] || [];
    const set = new Set(pick.map(l => l.uid));
    list = list.filter(l => set.has(l.uid));
  } else if (h.range === 'custom') {
    const from = h.from || '0000-00-00';
    const to = h.to || '9999-99-99';
    list = list.filter(l => { const d = dayOf(l); return d >= from && d <= to; });
  } else {
    const days = rangeDays(h.range);
    if (days) {
      const set = new Set(days);
      list = list.filter(l => set.has(dayOf(l)));
    }
  }

  const q = h.q.trim().toLowerCase();
  if (q) {
    list = list.filter(l =>
      l.username.toLowerCase().indexOf(q) !== -1 ||
      l.id.toLowerCase().indexOf(q) !== -1 ||
      l.stockAccount.toLowerCase().indexOf(q) !== -1 ||
      l.staff.toLowerCase().indexOf(q) !== -1 ||
      l.note.toLowerCase().indexOf(q) !== -1 ||
      String(l.robux).indexOf(q) !== -1);
  }
  return list;
}

function renderHistory() {
  const h = state.hist;

  byId('hist-ranges').innerHTML = HIST_RANGES.map(r =>
    '<button data-act="hist-range" data-range="' + r.key + '" aria-pressed="' +
    (!h.flag && h.range === r.key) + '">' + r.label + '</button>').join('');

  byId('hist-custom').classList.toggle('hidden', h.range !== 'custom' || !!h.flag);
  byId('hist-from').value = h.from;
  byId('hist-to').value = h.to;
  if (byId('hist-search').value !== h.q) byId('hist-search').value = h.q;

  // health banner
  const rep = healthReport();
  const health = byId('hist-health');
  if (rep.total) {
    const bits = [];
    if (rep.future.length) bits.push('<button class="btn btn-line sm" data-act="hist-flag" data-flag="future">📅 วันที่อนาคต ' + rep.future.length + '</button>');
    if (rep.dupes.length) bits.push('<button class="btn btn-line sm" data-act="hist-flag" data-flag="dupes">🔁 เลขที่ซ้ำ ' + rep.dupes.length + '</button>');
    if (rep.orphan.length) bits.push('<button class="btn btn-line sm" data-act="hist-flag" data-flag="orphan">📦 เมลหาย ' + rep.orphan.length + '</button>');
    if (rep.negative.length) bits.push('<span class="chip bad">เครดิตติดลบ ' + rep.negative.length + ' เมล</span>');
    health.className = 'notice';
    health.innerHTML = '<span class="ic">⚠️</span><div class="grow"><b>พบรายการที่ควรตรวจ ' + rep.total + ' จุด</b>' +
      '<div class="row wrap gap-sm" style="margin-top:8px">' + bits.join('') +
      (h.flag ? '<button class="btn btn-ghost sm" data-act="hist-flag" data-flag="">ล้างตัวกรอง</button>' : '') +
      '</div></div>';
  } else {
    health.className = 'notice info hidden';
    health.innerHTML = '';
  }

  const list = historyLogs();
  const sales = sum(list, l => l.priceThb);
  const profit = sum(list, l => l.profitThb);
  byId('hist-summary').innerHTML =
    '<span class="chip mono">' + fmtInt(list.length) + ' ออเดอร์</span>' +
    '<span class="chip mono">ขาย ' + baht(sales) + '</span>' +
    '<span class="chip mono ' + (profit >= 0 ? 'good' : 'bad') + '">กำไร ' + baht(profit, true) + '</span>';

  const box = byId('hist-list');
  if (!list.length) {
    box.innerHTML = '<div class="card empty"><div class="big">🔍</div>ไม่พบรายการในช่วงนี้</div>';
    byId('hist-more').innerHTML = '';
    return;
  }
  box.innerHTML = list.slice(0, h.limit).map(orderHtml).join('');
  byId('hist-more').innerHTML = list.length > h.limit
    ? '<button class="btn btn-line" data-act="hist-more">แสดงเพิ่ม (เหลืออีก ' + fmtInt(list.length - h.limit) + ')</button>'
    : '<span class="t-xs muted-2">แสดงครบ ' + fmtInt(list.length) + ' รายการแล้ว</span>';
}

/* -------------------------------------------------------------- stocks   */
function renderStocks() {
  const bal = stockBalances();
  const grid = byId('stocks-grid');

  if (!data.stockAccounts.length) {
    grid.innerHTML = '<div class="card empty" style="grid-column:1/-1"><div class="big">📦</div>' +
      'ยังไม่มีสต็อกเมล กด “เพิ่มสต็อกเมล” เพื่อเริ่มต้น</div>';
    return;
  }

  grid.innerHTML = data.stockAccounts.map((a, i) => {
    const b = bal[a.id];
    const open = a.status === 'พร้อมใช้';
    const funded = b.fundedUsd;
    const pct = funded > 0 ? Math.max(0, Math.min(100, (b.remainingUsd / funded) * 100)) : 0;
    const tone = !open ? 'dead' : pct < 15 ? 'low' : pct < 35 ? 'mid' : 'ok';

    const counted = b.lastCount
      ? '<span class="chip plain t-xs">นับล่าสุด ' + esc(b.lastCount.date.slice(0, 10)) + '</span>'
      : '<span class="chip note t-xs">ยังไม่เคยนับ</span>';

    const variance = Math.abs(b.varianceUsd) > 0.004
      ? '<div class="row between t-xs ' + (b.varianceUsd < 0 ? 'neg' : 'pos') + '">' +
          '<span>ส่วนต่างจากการนับ</span>' +
          '<b class="mono">' + (b.varianceUsd < 0 ? '-' : '+') + '$' + fmt(Math.abs(b.varianceUsd)) +
          ' · ' + baht(b.varianceUsd * a.rate, true) + '</b></div>'
      : '';

    const topup = b.topupUsd > 0
      ? '<div class="row between t-xs muted"><span>เติมเพิ่มภายหลัง</span>' +
        '<b class="mono">+$' + fmt(b.topupUsd) + '</b></div>'
      : '';

    return '<div class="card stock' + (open ? '' : ' off') + '">' +
      '<div class="row between gap-sm">' +
        '<div class="row gap-sm grow" style="min-width:0">' +
          '<span class="stock-id">' + esc(a.id) + '</span>' +
          '<span class="t-sm semi truncate">' + esc(a.email || '(ไม่ระบุอีเมล)') + '</span>' +
        '</div>' +
        '<div class="row gap-xs shrink-0">' +
          '<button class="toggle' + (open ? '' : ' off') + '" data-act="toggle-stock" data-i="' + i + '">' +
            '<span class="dot"></span>' + (open ? 'พร้อมใช้' : 'ปิดใช้งาน') + '</button>' +
          '<button class="iconbtn" data-act="edit-stock" data-i="' + i + '" title="แก้ไขข้อมูลเมล">' + svg(ICON.edit) + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="row between gap-sm">' +
        '<div><div class="t-xs muted">คงเหลือ USD</div>' +
          '<div class="num t-lg ' + (b.remainingUsd < 0 ? 'neg' : open ? 'warn' : 'muted') + '">$' + fmt(b.remainingUsd) + '</div>' +
          '<div class="t-xs muted">เติมมาแล้วรวม $' + fmt(funded) + '</div></div>' +
        '<div class="right"><div class="t-xs muted">มูลค่าคงเหลือ</div>' +
          '<div class="num t-lg">' + baht(b.remainingUsd * a.rate) + '</div>' +
          '<div class="t-xs brand semi">เรท ' + fmt(a.rate) + ' ฿/$</div></div>' +
      '</div>' +
      '<div><div class="bar"><i class="' + tone + '" style="width:' + pct.toFixed(1) + '%"></i></div>' +
        '<div class="row between t-xs muted" style="margin-top:6px">' +
          '<span>ใช้ไป $' + fmt(b.usedUsd) + ' · ' + fmtInt(b.orders) + ' ออเดอร์</span>' +
          '<span>กำไร ' + baht(b.profitThb) + '</span></div></div>' +
      (topup || variance
        ? '<div class="subbox stack-sm" style="padding:9px 11px">' + topup + variance + '</div>' : '') +
      (a.note ? '<div class="t-xs muted break">📝 ' + esc(a.note) + '</div>' : '') +
      '<div class="row between gap-sm" style="padding-top:2px">' +
        counted +
        '<button class="btn btn-soft sm" data-act="adjust-stock" data-i="' + i + '">⚖️ กรอกยอดจริง / เติมเงิน</button>' +
      '</div>' +
      '</div>';
  }).join('');
}

/* ------------------------------------------------------------- pricing   */
function renderPricing() {
  byId('rate-input').value = state.pricingRate;
  const rows = data.packages.map(p => {
    const cost = round2(num(p.usd) * state.pricingRate);
    const profit = round2(num(p.price) - cost);
    const margin = num(p.price) > 0 ? (profit / num(p.price)) * 100 : 0;
    const cls = margin < 15 ? 'bad' : margin < 20 ? 'note' : 'good';
    return '<tr>' +
      '<td><span class="row gap-sm"><img src="' + ROBUX_ICON + '" style="width:16px;height:16px" alt="" onerror="this.remove()">' +
        '<b class="mono">' + fmtInt(p.robux) + '</b></span></td>' +
      '<td class="muted">' + esc(p.pressGuide) + '</td>' +
      '<td class="r num brand">' + baht(p.price) + '</td>' +
      '<td class="r mono muted">$' + num(p.usd).toFixed(2) + ' · ' + baht(cost) + '</td>' +
      '<td class="r num ' + (profit >= 0 ? 'pos' : 'neg') + '">' + baht(profit, true) + '</td>' +
      '<td class="c"><span class="chip ' + cls + '">' + margin.toFixed(1) + '%</span></td>' +
      '</tr>';
  }).join('');

  byId('pricing-table').innerHTML =
    '<div class="table-wrap"><table class="table"><thead><tr>' +
    '<th>แพ็กเกจ</th><th>วิธีกด</th><th class="r">ราคาขาย</th><th class="r">ต้นทุน</th>' +
    '<th class="r">กำไรสุทธิ</th><th class="c">มาร์จิ้น</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

/* ------------------------------------------------------------- summary   */
const SUM_RANGES = [
  { key: 'today', label: 'วันนี้' },
  { key: 'yesterday', label: 'เมื่อวาน' },
  { key: '7d', label: '7 วัน' },
  { key: '30d', label: '30 วัน' },
  { key: 'month', label: 'เดือนนี้' },
  { key: 'lastmonth', label: 'เดือนที่แล้ว' },
  { key: 'all', label: 'ทั้งหมด' }
];

function renderSummary() {
  const all = data.salesLogs;
  const days = rangeDays(state.summaryRange);
  const set = days ? new Set(days) : null;
  const logs = set ? all.filter(l => set.has(dayOf(l))) : all;
  const label = (SUM_RANGES.find(r => r.key === state.summaryRange) || {}).label || '';

  byId('sum-ranges').innerHTML = SUM_RANGES.map(r =>
    '<button data-act="sum-range" data-range="' + r.key + '" aria-pressed="' +
    (state.summaryRange === r.key) + '">' + r.label + '</button>').join('');

  const sales = sum(logs, l => l.priceThb);
  const profit = sum(logs, l => l.profitThb);
  const robux = sum(logs, l => l.robux);
  const margin = sales > 0 ? (profit / sales) * 100 : 0;
  const avg = logs.length ? sales / logs.length : 0;

  const kpi = (o) => '<div class="card kpi' + (o.accent ? ' accent' : '') + '">' +
    '<div class="row between gap-sm" style="align-items:flex-start">' +
      '<span class="k">' + o.k + '</span><span class="icon">' + svg(o.icon) + '</span></div>' +
    '<div><div class="v ' + (o.cls || '') + '">' + o.v + '</div><div class="s">' + o.s + '</div></div></div>';

  byId('sum-kpi').innerHTML =
    kpi({ k: 'ออเดอร์ · ' + label, v: fmtInt(logs.length), s: 'ทั้งหมด ' + fmtInt(all.length) + ' ออเดอร์', icon: ICON.cart }) +
    kpi({ k: 'ยอดขาย · ' + label, v: baht(sales), s: 'ทั้งหมด ' + baht(sum(all, l => l.priceThb)), icon: ICON.cashier }) +
    kpi({ k: 'กำไร · ' + label, v: baht(profit, true), s: 'มาร์จิ้น ' + margin.toFixed(1) + '% · สะสม ' + baht(sum(all, l => l.profitThb)), icon: ICON.trend, accent: true }) +
    kpi({ k: 'เฉลี่ยต่อออเดอร์', v: baht(avg), s: 'ขาย Robux รวม ' + fmtInt(robux), icon: ICON.bars, cls: 'brand' });

  renderTrend(all, days);
  renderTopPackages(logs, label);
  renderStockHealth();
  renderStaff(logs, label);
  renderHealthCard();
}

function renderTrend(all, days) {
  let chartDays = days;
  if (!chartDays) {
    chartDays = Array.from(new Set(all.map(dayOf).filter(Boolean))).sort().slice(-30);
  } else if (chartDays.length === 1) {
    // One day is not a trend; show the fortnight around it instead.
    const anchor = new Date(chartDays[0] + 'T00:00:00');
    chartDays = Array.from({ length: 14 }, (_, i) => localDate(shiftDays(13 - i, anchor)));
  }
  if (!chartDays.length) chartDays = [localDate()];

  const byDay = {};
  chartDays.forEach(d => { byDay[d] = { n: 0, sales: 0, profit: 0 }; });
  all.forEach(l => {
    const b = byDay[dayOf(l)];
    if (!b) return;
    b.n += 1; b.sales += l.priceThb; b.profit += l.profitThb;
  });

  const max = Math.max(1, ...chartDays.map(d => byDay[d].sales));
  const best = chartDays.reduce((a, d) => (byDay[d].sales > byDay[a].sales ? d : a), chartDays[0]);
  const dayLabel = (d) => d.slice(8, 10) + '/' + d.slice(5, 7);

  const bars = chartDays.map(d => {
    const b = byDay[d];
    const h = b.sales > 0 ? Math.max(4, Math.round((b.sales / max) * 100)) : 2;
    const share = b.sales > 0 ? Math.max(0, Math.min(100, Math.round((b.profit / b.sales) * 100))) : 0;
    return '<div class="col' + (d === best && b.sales > 0 ? ' best' : '') + '" title="' + d + ' · ' +
      b.n + ' ออเดอร์ · ขาย ฿' + fmt(b.sales) + ' · กำไร ฿' + fmt(b.profit) + '">' +
      '<div style="height:' + h + '%"><i style="height:' + share + '%"></i></div></div>';
  }).join('');

  byId('sum-trend').innerHTML = '<div class="card">' +
    '<div class="row between wrap gap-sm" style="margin-bottom:12px">' +
      '<h3 class="t-md">ยอดขายรายวัน</h3>' +
      '<span class="legend"><span><i style="background:var(--mint-500)"></i>กำไร</span>' +
      '<span><i style="background:var(--violet-100)"></i>ต้นทุน</span></span></div>' +
    '<div class="chart">' + bars + '</div>' +
    '<div class="row between t-xs muted mono" style="margin-top:10px">' +
      '<span>' + dayLabel(chartDays[0]) + '</span>' +
      '<span class="brand semi">ขายดีสุด ' + dayLabel(best) + ' · ' + baht(byDay[best].sales) + '</span>' +
      '<span>' + dayLabel(chartDays[chartDays.length - 1]) + '</span></div></div>';
}

function renderTopPackages(logs, label) {
  const by = {};
  logs.forEach(l => {
    const k = l.robux;
    if (!by[k]) by[k] = { robux: k, n: 0, sales: 0, profit: 0 };
    by[k].n += 1; by[k].sales += l.priceThb; by[k].profit += l.profitThb;
  });
  const top = Object.values(by).sort((a, b) => b.n - a.n).slice(0, 6);
  const max = Math.max(1, ...top.map(p => p.n));

  byId('sum-packages').innerHTML = '<div class="card stack-sm" style="height:100%">' +
    '<div class="row between"><h3 class="t-md">แพ็กเกจขายดี</h3><span class="t-xs muted">' + label + '</span></div>' +
    (top.length ? top.map(p => '<div class="rank">' +
      '<div class="rank-head"><b class="mono">' + fmtInt(p.robux) + ' R</b>' +
      '<span class="t-xs muted mono">' + fmtInt(p.n) + ' ครั้ง · ' + baht(p.sales) +
      ' · <span class="pos">' + baht(p.profit, true) + '</span></span></div>' +
      '<div class="bar"><i class="ok" style="width:' + Math.round((p.n / max) * 100) + '%"></i></div></div>').join('')
      : '<div class="empty t-sm">ยังไม่มีออเดอร์ในช่วงนี้</div>') +
    '</div>';
}

function renderStockHealth() {
  const bal = stockBalances();
  const rows = data.stockAccounts.map(a => {
    const b = bal[a.id] || {};
    const remain = num(b.remainingUsd, a.initialUsd);
    const funded = num(b.fundedUsd, a.initialUsd);
    const pct = funded > 0 ? Math.max(0, Math.min(100, (remain / funded) * 100)) : 0;
    return { a, remain, funded, pct, low: remain <= 20, variance: num(b.varianceUsd) };
  }).sort((x, y) => y.remain - x.remain);

  const drift = rows.reduce((s, r) => s + r.variance, 0);

  byId('sum-stocks').innerHTML = '<div class="card stack-sm" style="height:100%">' +
    '<div class="row between"><h3 class="t-md">เครดิตคงเหลือแต่ละเมล</h3>' +
    '<span class="t-xs brand semi mono">รวม $' + fmt(rows.reduce((s, r) => s + r.remain, 0)) + '</span></div>' +
    (Math.abs(drift) > 0.004
      ? '<div class="t-xs ' + (drift < 0 ? 'neg' : 'pos') + '">' +
        'ส่วนต่างจากการนับสะสมทุกเมล ' + (drift > 0 ? '+' : '') + '$' + fmt(drift) + '</div>'
      : '') +
    '<div class="scroll-y max-h-64 stack-sm">' + (rows.length ? rows.map(r => '<div class="rank">' +
      '<div class="rank-head"><b class="mono ' + (r.low ? 'neg' : '') + '">' + esc(r.a.id) +
      (r.a.status !== 'พร้อมใช้' ? ' <span class="t-xs muted-2">ปิด</span>' : '') + '</b>' +
      '<span class="mono t-xs ' + (r.low ? 'neg bold' : 'muted') + '">$' + fmt(r.remain) + ' / $' + fmtInt(r.a.initialUsd) + '</span></div>' +
      '<div class="bar"><i class="' + (r.low ? 'low' : 'ok') + '" style="width:' + r.pct.toFixed(1) + '%"></i></div></div>').join('')
      : '<div class="empty t-sm">ยังไม่มีเมล</div>') + '</div></div>';
}

const STAFF_EMOJIS = ['🐰', '🐱', '🐶', '🦊', '🐼', '🐨', '🐯', '🦁', '🐸', '🐧', '🐥', '🐹',
  '🦄', '🦈', '🐙', '🌸', '🍓', '🍰', '🍭', '🌈', '⭐', '💜', '🔥', '👑'];

function renderStaff(logs, label) {
  const stats = {};
  data.settings.employees.forEach(n => { stats[n] = { name: n, n: 0, sales: 0, profit: 0 }; });
  logs.forEach(l => {
    const name = l.staff || 'ไม่ระบุ';
    if (!stats[name]) stats[name] = { name, n: 0, sales: 0, profit: 0 };
    stats[name].n += 1; stats[name].sales += l.priceThb; stats[name].profit += l.profitThb;
  });
  const ranked = Object.values(stats).sort((a, b) => b.profit - a.profit);
  const medal = ['🥇', '🥈', '🥉'];

  byId('sum-staff').innerHTML = '<div class="card stack-sm" style="height:100%">' +
    '<div class="row between"><h3 class="t-md">ผลงานพนักงาน</h3>' +
    '<span class="t-xs muted">' + label + ' · ' + data.settings.employees.length + ' คน</span></div>' +
    ranked.map((s, i) => {
      const emoji = data.settings.employeeEmojis[s.name] || '';
      const picker = state.emojiFor === s.name
        ? '<div class="emoji-grid">' + STAFF_EMOJIS.map(e =>
          '<button data-act="set-emoji" data-name="' + esc(s.name) + '" data-emoji="' + e + '">' + e + '</button>').join('') + '</div>'
        : '';
      return '<div><div class="staff-row">' +
        '<button class="staff-avatar" data-act="pick-emoji" data-name="' + esc(s.name) + '" title="เปลี่ยนอีโมจิ">' +
          (emoji || esc(s.name.slice(0, 1))) +
          (i < 3 && s.n > 0 ? '<span class="medal">' + medal[i] + '</span>' : '') + '</button>' +
        '<div class="grow"><div class="semi truncate">' + esc(s.name) + '</div>' +
          '<div class="t-xs muted mono">' + fmtInt(s.n) + ' ออเดอร์</div></div>' +
        '<div class="right mono shrink-0"><div class="t-xs muted">ขาย ' + baht(s.sales) + '</div>' +
          '<b class="pos t-sm">' + baht(s.profit, true) + '</b></div>' +
        '<div class="row gap-xs shrink-0">' +
          '<button class="iconbtn" data-act="rename-staff" data-name="' + esc(s.name) + '" title="เปลี่ยนชื่อ">✏️</button>' +
          '<button class="iconbtn danger" data-act="del-staff" data-name="' + esc(s.name) + '" title="ลบ">✕</button>' +
        '</div></div>' + picker + '</div>';
    }).join('') +
    '<form class="row gap-sm" data-act="add-staff" style="padding-top:10px;border-top:1px solid var(--line-soft)">' +
      '<input class="input sm grow" id="new-staff" placeholder="ชื่อพนักงานใหม่...">' +
      '<button class="btn btn-primary sm" type="submit">+ เพิ่ม</button></form></div>';
}

function renderHealthCard() {
  const rep = healthReport();
  const box = byId('sum-health');
  const rows = [];
  if (rep.future.length) rows.push(['📅', 'ออเดอร์ที่ลงวันที่ล่วงหน้า', rep.future.length + ' รายการ', 'future']);
  if (rep.dupes.length) rows.push(['🔁', 'เลขออเดอร์ซ้ำกัน', rep.dupes.length + ' รายการ', 'dupes']);
  if (rep.orphan.length) rows.push(['📦', 'ตัดจากเมลที่ไม่มีในระบบแล้ว', rep.orphan.length + ' รายการ', 'orphan']);
  if (rep.negative.length) rows.push(['💸', 'เมลที่เครดิตติดลบ', rep.negative.map(a => a.id).join(', '), '']);
  if (state.orphanCount) rows.push(['💾', 'ออเดอร์ในเครื่องนี้ที่ยังไม่มีบนเซิร์ฟเวอร์', state.orphanCount + ' รายการ', '']);

  box.innerHTML = '<div class="card stack-sm">' +
    '<h3 class="section-title">' + svg(ICON.shield) + 'ตรวจสุขภาพข้อมูล</h3>' +
    (rows.length
      ? rows.map(r => '<div class="row between gap-sm t-sm" style="padding:8px 0;border-bottom:1px solid var(--line-soft)">' +
        '<span class="row gap-sm"><span>' + r[0] + '</span><span>' + esc(r[1]) + '</span></span>' +
        '<span class="row gap-sm shrink-0"><b class="warn t-xs">' + esc(r[2]) + '</b>' +
        (r[3] ? '<button class="btn btn-line sm" data-act="goflag" data-flag="' + r[3] + '">ดู</button>' : '') +
        '</span></div>').join('')
      : '<div class="notice info"><span class="ic">✅</span><div>ข้อมูลปกติดี ไม่พบวันที่เพี้ยน เลขซ้ำ หรือเมลหาย</div></div>') +
    '</div>';
}

/* =========================================================================
 * ACTIONS
 * ======================================================================= */
function toast(msg, kind, undo) {
  const box = byId('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || 'info');
  el.innerHTML = '<span>' + esc(msg) + '</span>' + (undo ? '<button data-act="undo">เลิกทำ</button>' : '');
  box.appendChild(el);
  const kill = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  };
  setTimeout(kill, undo ? 7000 : 3200);
  el.addEventListener('click', (e) => { if (e.target.dataset.act === 'undo') { doUndo(); kill(); } });
}

function nextOrderLabel() {
  let max = 0;
  data.salesLogs.forEach(l => {
    const n = parseInt(String(l.id).replace(/\D/g, ''), 10);
    if (Number.isFinite(n) && n > max) max = n;
  });
  return 'ORD-' + String(max + 1).padStart(4, '0');
}

function submitOrder(e) {
  e.preventDefault();
  const nameInput = byId('f-username');
  const username = nameInput.value.trim();
  if (!username) { toast('กรุณากรอก Username ในเกม', 'error'); nameInput.focus(); return; }

  const q = quote(state.selRobux, state.extras, state.selStock);
  if (!q.stock) { toast('ยังไม่มีบัญชีสต็อกเมล เพิ่มเมลก่อน', 'error'); return; }
  if (!q.enough && !confirm(
    'เครดิตของ ' + q.stock.id + ' ไม่พอ\n\n' +
    'เหลือ $' + q.remain.toFixed(2) + ' แต่รายการนี้ใช้ $' + q.totalUsd.toFixed(2) + '\n\n' +
    'กดตกลงเพื่อบันทึกต่อ (ยอดจะติดลบ)')) return;

  const row = {
    uid: newUid(),
    id: nextOrderLabel(),
    date: localDateTime(),
    username,
    robux: num(q.pkg.robux),
    stockAccount: q.stock.id,
    priceThb: q.price,
    pressGuide: q.pkg.pressGuide,
    rate: q.rate,
    usd: q.totalUsd,
    costThb: q.costThb,
    profitThb: q.profitThb,
    staff: byId('f-staff').value || 'ไม่ระบุ',
    status: 'สำเร็จ',
    note: hasExtras(state.extras) ? 'กดเกิน: ' + extrasLabel(state.extras, ', ') : '',
    extraPacks: Object.assign({}, state.extras)
  };

  data.salesLogs.unshift(row);
  sortLogs(data.salesLogs);
  commit([row.uid]);

  nameInput.value = '';
  state.extras = emptyExtras();
  state.showExtras = false;
  render();
  nameInput.focus();
  toast('บันทึกแล้ว · ' + username + ' ' + fmtInt(row.robux) + 'R · ตัด ' + row.stockAccount, 'success');
}

/** Tombstone a uid server-side so no client can file it again. */
function retireUid(uid, onFail) {
  if (!IS_HTTP) return;
  fetch('/api/delete-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid })
  })
    .then(r => r.json())
    .then(j => { serverStamp = num(j && j.lastUpdated) || serverStamp; })
    .catch(() => { if (onFail) onFail(); });
}

function deleteOrder(uid) {
  const l = findLog(uid);
  if (!l) return;
  if (!confirm('ลบรายการของ ' + l.username + ' (' + fmtInt(l.robux) + 'R)?\n' +
    'ระบบจะคืนเครดิต $' + fmt(l.usd) + ' ให้เมล ' + l.stockAccount)) return;

  const idx = data.salesLogs.findIndex(x => x.uid === uid);
  lastUndo = { row: clone(l), idx };
  data.salesLogs.splice(idx, 1);
  data.deletedOrders.push(uid);
  pendingUids.delete(uid);
  saveLocal();
  render();

  retireUid(uid, () => toast('ลบในเครื่องแล้ว แต่ยังไม่ได้ซิงก์', 'warn'));
  toast('ลบรายการและคืนเครดิตแล้ว', 'info', true);
}

function doUndo() {
  if (!lastUndo) return;
  const row = lastUndo.row;
  data.deletedOrders = data.deletedOrders.filter(u => u !== row.uid);
  // A restored row is a new fact for the server; give it a fresh identity so
  // the tombstone it just wrote cannot swallow it again.
  row.uid = newUid();
  data.salesLogs.splice(Math.min(lastUndo.idx, data.salesLogs.length), 0, row);
  sortLogs(data.salesLogs);
  lastUndo = null;
  commit([row.uid]);
  render();
  toast('กู้คืนรายการแล้ว', 'success');
}

/* ------------------------------------------------------ order edit modal */
function openOrderEdit(uid) {
  const l = findLog(uid);
  if (!l) return;
  state.editUid = uid;
  state.editExtras = Object.assign(emptyExtras(), l.extraPacks);

  byId('oe-title').textContent = 'แก้ไข ' + (l.id || 'ออเดอร์');
  byId('oe-username').value = l.username;
  byId('oe-date').value = l.date.slice(0, 10);
  byId('oe-time').value = l.date.slice(11, 16);
  byId('oe-price').value = l.priceThb;
  byId('oe-note').value = l.note;
  byId('oe-zero').checked = (l.profitThb === 0 && l.costThb > 0);

  byId('oe-pkg').innerHTML = data.packages
    .map(p => '<option value="' + num(p.robux) + '"' + (num(p.robux) === l.robux ? ' selected' : '') + '>' +
      fmtInt(p.robux) + ' R · ' + fmt(p.price) + ' ฿</option>').join('') +
    (data.packages.some(p => num(p.robux) === l.robux) ? ''
      : '<option value="' + l.robux + '" selected>' + fmtInt(l.robux) + ' R (ไม่อยู่ในตารางแล้ว)</option>');

  byId('oe-staff').innerHTML = data.settings.employees
    .map(n => '<option value="' + esc(n) + '"' + (n === l.staff ? ' selected' : '') + '>' + esc(n) + '</option>').join('') +
    (data.settings.employees.indexOf(l.staff) === -1
      ? '<option value="' + esc(l.staff) + '" selected>' + esc(l.staff) + '</option>' : '');

  const opts = data.stockAccounts.map(a => '<option value="' + esc(a.id) + '"' + (a.id === l.stockAccount ? ' selected' : '') + '>' +
    esc(a.id) + ' · เรท ' + fmt(a.rate) + (a.status === 'พร้อมใช้' ? '' : ' (ปิด)') + '</option>');
  if (!findStock(l.stockAccount)) {
    opts.unshift('<option value="' + esc(l.stockAccount) + '" selected>' + esc(l.stockAccount) +
      ' · เรท ' + fmt(l.rate) + ' (ไม่อยู่ในระบบแล้ว)</option>');
  }
  byId('oe-stock').innerHTML = opts.join('');

  renderEditExtras();
  openModal('modal-order');
  byId('oe-username').focus();
}

function renderEditExtras() {
  byId('oe-extras').innerHTML = PACK_KEYS.map(k => stepperHtml(k, state.editExtras[k], 'oe')).join('');
  renderEditPreview();
}

/** Recomputes from the fields as they stand, so the dialog always shows the
 *  number that will actually be saved. */
function editQuote() {
  const l = findLog(state.editUid);
  if (!l) return null;
  const robux = num(byId('oe-pkg').value, l.robux);
  const pkg = findPackage(robux) || { usd: l.usd, price: l.priceThb, pressGuide: l.pressGuide, robux };
  const stockId = byId('oe-stock').value;
  const stock = findStock(stockId) || { id: stockId, rate: l.rate };
  const totalUsd = round2(num(pkg.usd) + extrasUsd(state.editExtras));
  const costThb = round2(totalUsd * num(stock.rate));
  const price = num(byId('oe-price').value, l.priceThb);
  const profitThb = byId('oe-zero').checked ? 0 : round2(price - costThb);
  return { l, pkg, robux, stock, totalUsd, costThb, price, profitThb };
}

function renderEditPreview() {
  const q = editQuote();
  if (!q) return;
  const moved = q.stock.id !== q.l.stockAccount;
  byId('oe-preview').innerHTML =
    '<div class="row between t-sm"><span class="muted">ตัดเครดิตจริง</span>' +
      '<b class="mono brand">$' + q.totalUsd.toFixed(2) + '</b></div>' +
    '<div class="row between t-sm" style="margin-top:6px"><span class="muted">ต้นทุน ' + baht(q.costThb) + '</span>' +
      '<b class="mono ' + (q.profitThb >= 0 ? 'pos' : 'neg') + '">กำไร ' + baht(q.profitThb, true) + '</b></div>' +
    (moved ? '<div class="t-xs warn" style="margin-top:6px">ย้ายจาก ' + esc(q.l.stockAccount) +
      ' → ' + esc(q.stock.id) + ' · เรทใหม่ ' + fmt(q.stock.rate) + ' ฿/$</div>' : '');
}

function saveOrderEdit(e) {
  e.preventDefault();
  const q = editQuote();
  if (!q) return;
  const l = q.l;

  const username = byId('oe-username').value.trim();
  if (!username) { toast('กรุณากรอก Username', 'error'); return; }

  const d = byId('oe-date').value || l.date.slice(0, 10);
  const t = byId('oe-time').value || '00:00';
  const stamp = normalizeStamp(d + ' ' + t);
  if (stamp.slice(0, 10) > localDate() &&
    !confirm('วันที่ ' + stamp.slice(0, 10) + ' อยู่ในอนาคต\nยืนยันจะบันทึกแบบนี้หรือไม่?')) return;

  let note = byId('oe-note').value.trim();
  if (!note && hasExtras(state.editExtras)) note = 'กดเกิน: ' + extrasLabel(state.editExtras, ', ');

  l.username = username;
  l.date = stamp;
  l.robux = q.robux;
  l.pressGuide = q.pkg.pressGuide || l.pressGuide;
  l.stockAccount = q.stock.id;
  l.rate = num(q.stock.rate);
  l.usd = q.totalUsd;
  l.priceThb = q.price;
  l.costThb = q.costThb;
  l.profitThb = q.profitThb;
  l.staff = byId('oe-staff').value || l.staff;
  l.note = note;
  l.extraPacks = Object.assign({}, state.editExtras);

  // A legacy uid is derived from the very fields this dialog just changed, so
  // once the content moves the row needs a minted identity and the old derived
  // one has to be retired - otherwise the pre-edit copy lives on server-side
  // under a uid nothing points at any more.
  const oldUid = l.uid;
  if (oldUid.charAt(0) !== 'O' && contentUid(l) !== oldUid) {
    l.uid = newUid();
    data.deletedOrders.push(oldUid);
    pendingUids.delete(oldUid);
    retireUid(oldUid);
  }

  sortLogs(data.salesLogs);
  commit([l.uid]);
  closeModal();
  render();
  toast('อัปเดตออเดอร์ ' + (l.id || '') + ' แล้ว', 'success');
}

/* ------------------------------------------------------ stock modal      */
function openStockModal(idx) {
  state.editStockIdx = (idx === undefined || idx === null) ? null : idx;
  const editing = state.editStockIdx !== null;
  const a = editing ? data.stockAccounts[state.editStockIdx] : null;

  byId('sm-title').textContent = editing ? 'แก้ไขสต็อก ' + a.id : 'เพิ่มสต็อกเมลใหม่';
  byId('sm-id').value = editing ? a.id : suggestStockId();
  byId('sm-email').value = editing ? a.email : '';
  byId('sm-buydate').value = editing ? (a.buyDate || localDate()) : localDate();
  byId('sm-usd').value = editing ? a.initialUsd : '';
  byId('sm-rate').value = editing ? a.rate : (data.settings.defaultEvalRate || 25.5);
  byId('sm-status').value = editing ? a.status : 'พร้อมใช้';
  byId('sm-note').value = editing ? a.note : '';
  byId('sm-delete').classList.toggle('hidden', !editing);

  calcStockPreview();
  openModal('modal-stock');
}

/** The old build used /PC-(d+)/ - a missing backslash, so it matched a literal
 *  "d" and always suggested PC-001, colliding with the existing account. */
function suggestStockId() {
  let max = 0;
  data.stockAccounts.forEach(a => {
    const m = String(a.id).match(/^PC-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'PC-' + String(max + 1).padStart(3, '0');
}

function calcStockPreview() {
  const usd = num(byId('sm-usd').value);
  const rate = num(byId('sm-rate').value);
  byId('sm-preview').innerHTML = baht(usd * rate);
}

function saveStock(e) {
  e.preventDefault();
  const id = byId('sm-id').value.trim();
  const usd = num(byId('sm-usd').value);
  const rate = num(byId('sm-rate').value);

  if (!id) { toast('กรุณากรอกรหัสเมล', 'error'); return; }
  const clash = data.stockAccounts.findIndex(a => a.id === id);
  if (clash !== -1 && clash !== state.editStockIdx) { toast('มีเมล ' + id + ' อยู่แล้ว', 'error'); return; }
  if (!(usd > 0)) { toast('กรุณากรอกยอด USD ให้ถูกต้อง', 'error'); return; }
  if (!(rate > 0)) { toast('กรุณากรอกเรทให้ถูกต้อง', 'error'); return; }

  const prev = state.editStockIdx !== null ? data.stockAccounts[state.editStockIdx] : null;
  const obj = {
    id, email: byId('sm-email').value.trim(), buyDate: byId('sm-buydate').value,
    initialUsd: usd, rate, investmentThb: round2(usd * rate),
    status: byId('sm-status').value, note: byId('sm-note').value.trim(),
    // This form rebuilds the account from its fields, so the credit log has to
    // be carried across explicitly or editing an email address would erase
    // every top-up and stock count on the mail.
    adjustments: (prev && prev.adjustments) || [],
    removedAdjustments: (prev && prev.removedAdjustments) || []
  };

  if (state.editStockIdx !== null) {
    const old = data.stockAccounts[state.editStockIdx];
    // Renaming a mail would orphan every order booked against the old code.
    if (old.id !== id) data.salesLogs.forEach(l => { if (l.stockAccount === old.id) l.stockAccount = id; });
    data.stockAccounts[state.editStockIdx] = obj;
  } else {
    data.stockAccounts.push(obj);
  }

  commit([], true);
  closeModal();
  render();
  toast((state.editStockIdx !== null ? 'อัปเดตสต็อก ' : 'เพิ่มสต็อก ') + id + ' แล้ว', 'success');
}

function deleteStock() {
  const i = state.editStockIdx;
  if (i === null) return;
  const a = data.stockAccounts[i];
  const used = data.salesLogs.filter(l => l.stockAccount === a.id).length;
  if (used && !confirm('เมล ' + a.id + ' ถูกใช้ใน ' + used + ' ออเดอร์\n' +
    'ถ้าลบ ออเดอร์เหล่านั้นจะหาต้นทุนไม่เจอ\n\nยืนยันลบ?')) return;
  if (!used && !confirm('ลบสต็อก ' + a.id + ' ใช่หรือไม่?')) return;

  data.stockAccounts.splice(i, 1);
  commit([], true);
  closeModal();
  render();
  toast('ลบสต็อก ' + a.id + ' แล้ว', 'info');
}

/* ------------------------------------------- credit count / top-up      */
/**
 * The computed balance drifts from the real one: an order goes unlogged, gets
 * charged to the wrong mail, or Roblox takes a different amount. Rather than
 * quietly rewriting the opening balance, a correction is recorded as its own
 * line so the shop can see when the credit moved and by how much.
 */
function openAdjustModal(idx) {
  const a = data.stockAccounts[idx];
  if (!a) return;
  state.adjustIdx = idx;
  state.adjustType = 'count';

  const b = stockBalances()[a.id];
  byId('adj-title').textContent = 'ยอดเครดิต ' + a.id;
  byId('adj-computed').innerHTML = '$' + fmt(b.remainingUsd);
  byId('adj-usd').value = '';
  byId('adj-rate').value = a.rate;
  byId('adj-note').value = '';

  byId('adj-staff').innerHTML = data.settings.employees
    .map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');

  renderAdjustType();
  renderAdjustHistory();
  openModal('modal-adjust');
  setTimeout(() => byId('adj-usd').focus(), 50);
}

function renderAdjustType() {
  const isCount = state.adjustType === 'count';
  byId('adj-tabs').innerHTML =
    '<button type="button" data-act="adj-type" data-t="count" aria-pressed="' + isCount + '">⚖️ นับยอดจริง</button>' +
    '<button type="button" data-act="adj-type" data-t="topup" aria-pressed="' + !isCount + '">➕ เติมเงินเข้าเมล</button>';

  byId('adj-usd-label').textContent = isCount
    ? 'ยอดที่เห็นในบัญชีจริงตอนนี้ ($)'
    : 'เติมเงินเข้าไปเพิ่ม ($)';
  byId('adj-usd').placeholder = isCount ? 'เช่น 152.40' : 'เช่น 300.00';
  byId('adj-rate-field').classList.toggle('hidden', isCount);
  byId('adj-note').placeholder = isCount ? 'เช่น นับจากหน้าเว็บ Roblox' : 'เช่น เติมล็อตใหม่';
  renderAdjustPreview();
}

function renderAdjustPreview() {
  const a = data.stockAccounts[state.adjustIdx];
  if (!a) return;
  const b = stockBalances()[a.id];
  const box = byId('adj-preview');
  const raw = byId('adj-usd').value;

  if (raw === '') {
    box.innerHTML = '<span class="muted t-sm">กรอกตัวเลขเพื่อดูผลก่อนบันทึก</span>';
    return;
  }
  const v = num(raw);

  if (state.adjustType === 'count') {
    const diff = round2(v - b.remainingUsd);
    const cls = Math.abs(diff) < 0.005 ? '' : diff < 0 ? 'neg' : 'pos';
    box.innerHTML =
      '<div class="row between t-sm"><span class="muted">ระบบคิดว่าเหลือ</span>' +
        '<b class="mono">$' + fmt(b.remainingUsd) + '</b></div>' +
      '<div class="row between t-sm" style="margin-top:5px"><span class="muted">คุณนับได้จริง</span>' +
        '<b class="mono">$' + fmt(v) + '</b></div>' +
      '<div class="row between t-sm" style="margin-top:7px;padding-top:7px;border-top:1px solid var(--line)">' +
        '<span class="muted">ส่วนต่างที่จะบันทึก</span>' +
        '<b class="mono ' + cls + '">' + (diff > 0 ? '+' : '') + '$' + fmt(diff) +
        ' · ' + baht(diff * a.rate, true) + '</b></div>' +
      (Math.abs(diff) < 0.005
        ? '<div class="t-xs pos" style="margin-top:6px">✅ ตรงกันพอดี ไม่ต้องบันทึกก็ได้</div>'
        : '<div class="t-xs muted" style="margin-top:6px">ยอดคงเหลือจะถูกปรับเป็น $' + fmt(v) +
          ' และบันทึกส่วนต่างไว้เป็นประวัติ (ออเดอร์เดิมไม่ถูกแก้)</div>');
  } else {
    const rate = num(byId('adj-rate').value) || a.rate;
    box.innerHTML =
      '<div class="row between t-sm"><span class="muted">จ่ายเงินไป</span>' +
        '<b class="mono brand">' + baht(v * rate) + '</b></div>' +
      '<div class="row between t-sm" style="margin-top:5px"><span class="muted">เครดิตหลังเติม</span>' +
        '<b class="mono">$' + fmt(b.remainingUsd + v) + '</b></div>' +
      '<div class="t-xs muted" style="margin-top:6px">' + fmt(v) + ' × ' + fmt(rate) + ' ฿/$ — ' +
      'จะถูกนับรวมเป็นต้นทุนของเมลนี้ด้วย</div>';
  }
}

function renderAdjustHistory() {
  const a = data.stockAccounts[state.adjustIdx];
  const list = (a.adjustments || []);
  byId('adj-history').innerHTML = list.length
    ? list.map(x => '<div class="row between gap-sm t-xs" style="padding:7px 0;border-bottom:1px solid var(--line-soft)">' +
        '<div class="grow" style="min-width:0">' +
          '<b>' + (x.type === 'topup' ? '➕ เติมเงิน' : '⚖️ นับยอด') + '</b> ' +
          '<span class="muted mono">' + esc(x.date) + '</span>' +
          (x.staff ? ' <span class="muted">· ' + esc(x.staff) + '</span>' : '') +
          (x.note ? '<div class="muted break">' + esc(x.note) + '</div>' : '') +
        '</div>' +
        '<b class="mono shrink-0 ' + (x.usd < 0 ? 'neg' : 'pos') + '">' +
          (x.usd > 0 ? '+' : '') + '$' + fmt(x.usd) + '</b>' +
        '<button type="button" class="iconbtn danger shrink-0" data-act="del-adjust" data-uid="' +
          esc(x.uid) + '" title="ลบรายการนี้">' + svg(ICON.trash) + '</button>' +
      '</div>').join('')
    : '<div class="muted t-xs" style="padding:8px 0">ยังไม่มีประวัติการปรับยอด</div>';
}

function saveAdjust(e) {
  e.preventDefault();
  const a = data.stockAccounts[state.adjustIdx];
  if (!a) return;
  const raw = byId('adj-usd').value;
  if (raw === '') { toast('กรุณากรอกตัวเลข', 'error'); return; }
  const v = num(raw);

  const b = stockBalances()[a.id];
  let usd, thb, rate = a.rate;

  if (state.adjustType === 'count') {
    if (v < 0) { toast('ยอดคงเหลือติดลบไม่ได้', 'error'); return; }
    usd = round2(v - b.remainingUsd);
    if (Math.abs(usd) < 0.005) { toast('ยอดตรงกันอยู่แล้ว ไม่ต้องปรับ', 'info'); return; }
    thb = 0;
  } else {
    if (!(v > 0)) { toast('ยอดเติมต้องมากกว่า 0', 'error'); return; }
    rate = num(byId('adj-rate').value) || a.rate;
    if (!(rate > 0)) { toast('กรุณากรอกเรทให้ถูกต้อง', 'error'); return; }
    usd = round2(v);
    thb = round2(v * rate);
  }

  a.adjustments = a.adjustments || [];
  a.adjustments.unshift({
    uid: newUid(),
    date: localDateTime(),
    type: state.adjustType,
    usd, rate, thb,
    note: byId('adj-note').value.trim(),
    staff: byId('adj-staff').value || ''
  });

  commit([], true);
  renderAdjustHistory();
  renderAdjustPreview();
  byId('adj-usd').value = '';
  byId('adj-computed').innerHTML = '$' + fmt(stockBalances()[a.id].remainingUsd);
  render();
  toast(state.adjustType === 'count'
    ? 'ปรับยอด ' + a.id + ' เป็น $' + fmt(v) + ' แล้ว (ส่วนต่าง ' + (usd > 0 ? '+' : '') + '$' + fmt(usd) + ')'
    : 'เติมเครดิต ' + a.id + ' +$' + fmt(v) + ' แล้ว', 'success');
}

function deleteAdjustment(uid) {
  const a = data.stockAccounts[state.adjustIdx];
  if (!a || !confirm('ลบรายการปรับยอดนี้? ยอดคงเหลือจะเปลี่ยนกลับ')) return;
  a.adjustments = (a.adjustments || []).filter(x => x.uid !== uid);
  // Tombstoned, or the next sync merges it straight back from the server.
  a.removedAdjustments = (a.removedAdjustments || []).concat(uid).slice(-500);
  commit([], true);
  renderAdjustHistory();
  byId('adj-computed').innerHTML = '$' + fmt(stockBalances()[a.id].remainingUsd);
  renderAdjustPreview();
  render();
  toast('ลบรายการปรับยอดแล้ว', 'info');
}

/* ------------------------------------------------------------ staff      */
function addStaff(e) {
  e.preventDefault();
  const input = byId('new-staff');
  const name = input ? input.value.trim() : '';
  if (!name) return;
  if (data.settings.employees.indexOf(name) !== -1) { toast('มีชื่อนี้แล้ว', 'error'); return; }
  data.settings.employees.push(name);
  commit([], true);
  render();
  toast('เพิ่มพนักงาน "' + name + '" แล้ว', 'success');
}

function removeStaff(name) {
  const n = data.salesLogs.filter(l => l.staff === name).length;
  if (!confirm('ลบพนักงาน "' + name + '"?' + (n ? '\nประวัติ ' + n + ' ออเดอร์จะยังคงชื่อนี้ไว้' : ''))) return;
  data.settings.employees = data.settings.employees.filter(e => e !== name);
  delete data.settings.employeeEmojis[name];
  commit([], true);
  render();
  toast('ลบพนักงานแล้ว', 'info');
}

function renameStaff(oldName) {
  const answer = prompt('เปลี่ยนชื่อพนักงาน "' + oldName + '" เป็น:', oldName);
  if (answer === null) return;
  const name = answer.trim();
  if (!name || name === oldName) return;
  if (data.settings.employees.indexOf(name) !== -1) { toast('มีชื่อนี้อยู่แล้ว', 'error'); return; }

  data.settings.employees = data.settings.employees.map(e => (e === oldName ? name : e));
  if (data.settings.employeeEmojis[oldName]) {
    data.settings.employeeEmojis[name] = data.settings.employeeEmojis[oldName];
    delete data.settings.employeeEmojis[oldName];
  }
  // Orders store the name as text; carry them across or this person's history
  // silently drops to zero.
  const moved = [];
  data.salesLogs.forEach(l => { if (l.staff === oldName) { l.staff = name; moved.push(l.uid); } });
  commit(moved, true);
  render();
  toast('เปลี่ยนเป็น "' + name + '" แล้ว (ย้าย ' + fmtInt(moved.length) + ' ออเดอร์)', 'success');
}

function setStaffEmoji(name, emoji) {
  data.settings.employeeEmojis[name] = emoji;
  state.emojiFor = null;
  commit([], true);
  render();
}

/* ------------------------------------------------------- export / import */
function csvCell(v) { return '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"'; }

function exportCsv() {
  const head = ['Order ID', 'วันที่', 'Username', 'Robux', 'สต็อกเมล', 'ราคาขาย (฿)',
    'ต้นทุน USD', 'เรท (฿/$)', 'ต้นทุน (฿)', 'กำไร (฿)', 'ผู้ทำรายการ', 'หมายเหตุ'];
  const rows = historyLogs().map(o => [o.id, o.date, o.username, o.robux, o.stockAccount,
    o.priceThb, o.usd, o.rate, o.costThb, o.profitThb, o.staff, o.note].map(csvCell).join(','));
  download('﻿' + head.map(csvCell).join(',') + '\r\n' + rows.join('\r\n'),
    'WonderBubble_' + localDate() + '.csv', 'text/csv;charset=utf-8;');
  toast('ดาวน์โหลด CSV แล้ว (' + fmtInt(rows.length) + ' แถว ตามตัวกรองในแท็บประวัติ)', 'success');
}

function exportJson() {
  download(JSON.stringify(data, null, 2),
    'WonderBubble_Backup_' + localDate() + '.json', 'application/json');
  toast('ดาวน์โหลด Backup แล้ว', 'success');
}

function download(text, name, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importBackup(ev) {
  const input = ev.target;
  const file = input.files && input.files[0];
  if (!file) return;
  const clear = () => { try { input.value = ''; } catch (e) {} };

  const reader = new FileReader();
  reader.onerror = () => { toast('อ่านไฟล์ไม่สำเร็จ', 'error'); clear(); };
  reader.onload = () => {
    let parsed;
    try { parsed = JSON.parse(String(reader.result)); }
    catch (e) { toast('ไฟล์นี้อ่านไม่ออก ต้องเป็น .json จากระบบ', 'error'); clear(); return; }

    const src = (parsed && Array.isArray(parsed.salesLogs)) ? parsed
      : (parsed && parsed.data && Array.isArray(parsed.data.salesLogs)) ? parsed.data : null;
    if (!src) { toast('ไฟล์นี้ไม่มีข้อมูลออเดอร์', 'error'); clear(); return; }

    mergeIn(normalize(src), 'ไฟล์สำรอง');
    clear();
  };
  reader.readAsText(file);
}

/** Shared by the file import and the browser-cache recovery: adds only rows we
 *  do not already have, never removes anything. */
function mergeIn(incoming, sourceLabel) {
  const have = new Set(data.salesLogs.map(l => l.uid));
  const tomb = new Set(data.deletedOrders);
  const fresh = incoming.salesLogs.filter(l => !have.has(l.uid) && !tomb.has(l.uid));
  const knownStock = new Set(data.stockAccounts.map(a => a.id));
  const freshStock = incoming.stockAccounts.filter(a => !knownStock.has(a.id));

  if (!fresh.length && !freshStock.length) {
    toast('ไม่มีอะไรใหม่จาก' + sourceLabel + ' ข้อมูลครบอยู่แล้ว', 'info');
    return;
  }
  const days = fresh.map(dayOf).filter(Boolean).sort();
  if (!confirm('นำเข้าจาก' + sourceLabel + '?\n\n' +
    '• ออเดอร์ใหม่ ' + fresh.length + ' รายการ' +
    (days.length ? ' (' + days[0] + ' ถึง ' + days[days.length - 1] + ')' : '') + '\n' +
    '• เมลใหม่ ' + freshStock.length + ' บัญชี\n\n' +
    'ข้อมูลเดิมไม่ถูกลบ ระบบจะรวมเข้าด้วยกันและส่งขึ้นเซิร์ฟเวอร์')) return;

  data.salesLogs.push(...fresh);
  data.stockAccounts.push(...freshStock);
  sortLogs(data.salesLogs);
  commit(fresh.map(l => l.uid), freshStock.length > 0);
  state.orphanCount = 0;
  render();
  toast('นำเข้าแล้ว · ' + fmtInt(fresh.length) + ' ออเดอร์, ' + freshStock.length + ' เมล', 'success');
}

/** Explicit, opt-in version of the old automatic "data rescue". */
function openRecovery() {
  const caches = legacyCaches();
  const body = byId('rc-body');
  if (!caches.length) {
    body.innerHTML = '<div class="empty"><div class="big">🗃️</div>ไม่พบข้อมูลเก่าค้างอยู่ในเบราว์เซอร์นี้</div>';
  } else {
    body.innerHTML = '<div class="notice info"><span class="ic">ℹ️</span><div>' +
      'นี่คือข้อมูลที่ระบบเวอร์ชันเก่าเก็บไว้ในเบราว์เซอร์เครื่องนี้ ' +
      'ระบบใหม่<b>จะไม่ดึงขึ้นเองอัตโนมัติ</b> เพราะเคยทำให้ข้อมูลเดือนเก่าไปทับของใหม่ ' +
      'ถ้าออเดอร์ช่วงไหนหายไป ให้กดนำเข้าเฉพาะชุดนั้น</div></div>' +
      caches.map((c, i) => '<div class="row between gap-sm subbox" style="margin-top:10px">' +
        '<div class="grow"><div class="semi t-sm mono">' + esc(c.key) + '</div>' +
        '<div class="t-xs muted">' + fmtInt(c.count) + ' ออเดอร์ · ' + esc(c.from) + ' ถึง ' + esc(c.to) + '</div></div>' +
        '<button class="btn btn-soft sm" data-act="rc-import" data-i="' + i + '">นำเข้า</button></div>').join('');
  }
  state.recoveryCaches = caches;
  openModal('modal-recovery');
}

function resetLocal() {
  if (prompt('ล้างข้อมูลในเครื่องนี้?\n\nพิมพ์  RESET  เพื่อยืนยัน\n' +
    'ข้อมูลบนเซิร์ฟเวอร์จะไม่ถูกลบ และจะถูกดึงกลับมาให้ทันที') !== 'RESET') {
    toast('ยกเลิกการรีเซ็ต', 'info');
    return;
  }
  // Deliberately local-only; nothing empty is ever pushed up.
  pendingUids.clear();
  pendingMeta = false;
  data = clone(FALLBACK);
  serverStamp = 0;
  saveLocal();
  render();
  toast('ล้างข้อมูลในเครื่องแล้ว กำลังดึงจากเซิร์ฟเวอร์', 'info');
  fetchServer();
}

/* ------------------------------------------------------------- modals    */
let openModalId = null;
function openModal(id) {
  byId(id).classList.remove('hidden');
  openModalId = id;
}
function closeModal() {
  if (!openModalId) return;
  byId(openModalId).classList.add('hidden');
  openModalId = null;
  state.editUid = null;
  state.editStockIdx = null;
}

/* =========================================================================
 * EVENTS - one delegated listener instead of inline onclick, which is what
 * broke whenever a username or note contained a quote.
 * ======================================================================= */
function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const d = el.dataset;

  switch (act) {
    case 'go': state.tab = d.tab; render(); break;
    case 'goflag':
      state.tab = 'history'; state.hist.flag = d.flag; state.hist.limit = PAGE_SIZE; render(); break;

    case 'pick-pkg': state.selRobux = num(d.robux); renderCashier(); break;
    case 'toggle-extras': state.showExtras = !state.showExtras; renderCashier(); break;
    case 'extra-step':
      state.extras[d.k] = Math.max(0, num(state.extras[d.k]) + num(d.d));
      renderCashier(); break;
    case 'clear-extras': state.extras = emptyExtras(); renderCashier(); break;

    case 'oe-step':
      state.editExtras[d.k] = Math.max(0, num(state.editExtras[d.k]) + num(d.d));
      renderEditExtras(); break;
    case 'oe-clear': state.editExtras = emptyExtras(); renderEditExtras(); break;

    case 'edit-order': openOrderEdit(d.uid); break;
    case 'del-order': deleteOrder(d.uid); break;
    case 'undo': doUndo(); break;

    case 'hist-range':
      state.hist.range = d.range; state.hist.flag = ''; state.hist.limit = PAGE_SIZE; renderHistory(); break;
    case 'hist-flag':
      state.hist.flag = d.flag; state.hist.limit = PAGE_SIZE; renderHistory(); break;
    case 'hist-more': state.hist.limit += PAGE_SIZE * 2; renderHistory(); break;

    case 'sum-range': state.summaryRange = d.range; renderSummary(); break;

    case 'add-stock': openStockModal(null); break;
    case 'edit-stock': openStockModal(num(d.i)); break;
    case 'del-stock': deleteStock(); break;
    case 'adjust-stock': openAdjustModal(num(d.i)); break;
    case 'adj-type': state.adjustType = d.t; renderAdjustType(); break;
    case 'del-adjust': deleteAdjustment(d.uid); break;
    case 'toggle-stock': {
      const a = data.stockAccounts[num(d.i)];
      a.status = a.status === 'พร้อมใช้' ? 'ปิดใช้งาน' : 'พร้อมใช้';
      commit([], true); render();
      toast(a.id + ' → ' + a.status, 'success');
      break;
    }

    case 'pick-emoji': state.emojiFor = state.emojiFor === d.name ? null : d.name; renderSummary(); break;
    case 'set-emoji': setStaffEmoji(d.name, d.emoji); break;
    case 'rename-staff': renameStaff(d.name); break;
    case 'del-staff': removeStaff(d.name); break;

    case 'export-csv': exportCsv(); break;
    case 'export-json': exportJson(); break;
    case 'recovery': openRecovery(); break;
    case 'rc-import': {
      const c = (state.recoveryCaches || [])[num(d.i)];
      if (c) { closeModal(); mergeIn(normalize(c.data), 'ข้อมูลเก่าในเบราว์เซอร์'); }
      break;
    }
    case 'reset-local': resetLocal(); break;
    case 'close-modal': closeModal(); break;
    case 'sync-now': checkVersion(); pushNow(); toast('กำลังซิงก์...', 'info'); break;
  }
}

function bind() {
  document.addEventListener('click', onClick);

  document.querySelectorAll('.tab').forEach(b => {
    b.addEventListener('click', () => { state.tab = b.dataset.tab; state.hist.flag = ''; render(); });
  });

  byId('cashier-form').addEventListener('submit', submitOrder);
  byId('f-stock').addEventListener('change', (e) => { state.selStock = e.target.value; renderGuide(); });
  byId('btn-extras').addEventListener('click', () => { state.showExtras = !state.showExtras; renderCashier(); });

  byId('modal-stock').addEventListener('submit', saveStock);
  ['sm-usd', 'sm-rate'].forEach(id => byId(id).addEventListener('input', calcStockPreview));

  byId('modal-adjust').addEventListener('submit', saveAdjust);
  ['adj-usd', 'adj-rate'].forEach(id => byId(id).addEventListener('input', renderAdjustPreview));

  byId('modal-order').addEventListener('submit', saveOrderEdit);
  ['oe-pkg', 'oe-stock', 'oe-zero', 'oe-price'].forEach(id =>
    byId(id).addEventListener('input', renderEditPreview));

  const search = debounce(() => { state.hist.limit = PAGE_SIZE; renderHistory(); }, 180);
  byId('hist-search').addEventListener('input', (e) => { state.hist.q = e.target.value; search(); });
  byId('hist-from').addEventListener('change', (e) => { state.hist.from = e.target.value; state.hist.range = 'custom'; renderHistory(); });
  byId('hist-to').addEventListener('change', (e) => { state.hist.to = e.target.value; state.hist.range = 'custom'; renderHistory(); });

  byId('rate-input').addEventListener('input', (e) => {
    const r = num(e.target.value);
    if (r > 0) { state.pricingRate = r; renderPricing(); }
  });

  byId('import-file').addEventListener('change', importBackup);

  document.addEventListener('submit', (e) => {
    if (e.target.dataset.act === 'add-staff') addStaff(e);
  });

  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('mousedown', (e) => { if (e.target === m) closeModal(); });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      state.tab = 'history'; render();
      byId('hist-search').focus();
    }
  });

  window.addEventListener('beforeunload', () => { if (pendingUids.size || pendingMeta) saveLocal(); });
}

/* --------------------------------------------------------------- boot    */
function boot() {
  const cached = loadLocal();
  if (cached) data = cached;
  else data = normalize(window.SEED_DATA || FALLBACK);

  state.pricingRate = num(data.settings.defaultEvalRate, 25.5);
  const open = activeStocks();
  state.selStock = open.length ? open[open.length - 1].id : '';
  if (!data.packages.some(p => num(p.robux) === state.selRobux)) {
    state.selRobux = num(data.packages[0] && data.packages[0].robux, 80);
  }

  bind();
  render();

  if (IS_HTTP) {
    fetchServer().then(openStreams);
  } else {
    state.online = false;
    renderStatus();
  }
}

// Script is loaded with `defer`, so the DOM is ready and this runs exactly
// once. The old build called its init twice and opened two of every socket.
boot();
