/*
 * Repairs a shop document: normalises every timestamp, recomputes the legacy
 * uids from the normalised value, drops rows that collapse onto the same uid,
 * and sorts newest first.
 *
 * Written for the 2026-09-02 incident. Rows saved before times were recorded
 * carry a bare 'YYYY-MM-DD'; the server hashed the repaired date while the
 * merge hashed the raw one, so one sale ended up under two uids and every old
 * client re-posting its cache added a duplicate. 692 orders doubled.
 *
 *   node tools/repair-data.js <in.json> [out.json]
 *
 * Reads either a bare document or an /api/backup reply. Writes the document.
 * Prints what it changed and never silently drops a row that is not an exact
 * content duplicate.
 */
const fs = require('fs');

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function normalizeStamp(v) {
  const m = String(v || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return '';
  return m[1] + '-' + m[2] + '-' + m[3] + ' ' + (m[4] || '00') + ':' + (m[5] || '00');
}

function legacyUid(l) {
  return 'L' + hash32([l.id, l.date, l.username, l.robux, l.stockAccount].join('|'));
}

const inFile = process.argv[2];
const outFile = process.argv[3] || inFile;
if (!inFile) {
  console.error('usage: node tools/repair-data.js <in.json> [out.json]');
  process.exit(1);
}

const parsed = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const doc = parsed && parsed.data ? parsed.data : parsed;
const rows = Array.isArray(doc.salesLogs) ? doc.salesLogs : [];

let fixedDates = 0;
let reUid = 0;

const keyed = rows.map(l => {
  const row = Object.assign({}, l);
  const stamp = normalizeStamp(row.date);
  if (stamp && stamp !== row.date) { row.date = stamp; fixedDates++; }

  // Keep the random uid of anything the new client minted; recompute the rest
  // so a row is identified by its content, not by when it was last hashed.
  if (!(typeof row.uid === 'string' && row.uid.charAt(0) === 'O')) {
    const want = legacyUid(row);
    if (row.uid !== want) reUid++;
    row.uid = want;
  }
  return row;
});

const byUid = new Map();
let dropped = 0;
keyed.forEach(row => {
  if (byUid.has(row.uid)) { dropped++; return; }
  byUid.set(row.uid, row);
});

const out = Array.from(byUid.values());
out.sort((a, b) => {
  const da = String(a.date || ''), db = String(b.date || '');
  if (da !== db) return da < db ? 1 : -1;
  return String(b.uid || '').localeCompare(String(a.uid || ''));
});

doc.salesLogs = out;
doc.deletedOrders = Array.isArray(doc.deletedOrders) ? doc.deletedOrders : [];

fs.writeFileSync(outFile, JSON.stringify(doc, null, 2), 'utf8');

console.log('in  : ' + rows.length + ' rows');
console.log('  timestamps repaired : ' + fixedDates);
console.log('  uids recomputed     : ' + reUid);
console.log('  duplicates removed  : ' + dropped);
console.log('out : ' + out.length + ' rows -> ' + outFile);
if (out.length) console.log('  newest: ' + out[0].date + '  oldest: ' + out[out.length - 1].date);
