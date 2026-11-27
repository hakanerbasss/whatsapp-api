// src/database.js — sql.js (saf JavaScript, derleme gerekmez)
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '../data/database.bin');
const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let SQL, db;

async function initDb() {
  if (db) return db;
  SQL = await require('sql.js')();
  if (fs.existsSync(DB_PATH)) {
    const data = fs.readFileSync(DB_PATH);
    db = new SQL.Database(data);
  } else {
    db = new SQL.Database();
  }
  createTables();
  setInterval(saveDb, 5000);
  return db;
}

function saveDb() {
  if (!db) return;
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch(e) {}
}

function getDb() {
  if (!db) throw new Error('DB henüz başlatılmadı.');
  return db;
}

function run(sql, params = []) { getDb().run(sql, params); saveDb(); }

function get(sql, params = []) {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free(); return null;
}

function all(sql, params = []) {
  const results = [];
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function createTables() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE, phone TEXT, token TEXT UNIQUE NOT NULL, plan TEXT DEFAULT 'basic', daily_limit INTEGER DEFAULT 100, status TEXT DEFAULT 'active', expires_at TEXT, created_at TEXT DEFAULT (datetime('now')), notes TEXT, webhook_url TEXT);
    CREATE TABLE IF NOT EXISTS connections (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, wa_number TEXT, status TEXT DEFAULT 'disconnected', connected_at TEXT, last_seen TEXT);
    CREATE TABLE IF NOT EXISTS message_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, to_number TEXT NOT NULL, message_type TEXT DEFAULT 'text', status TEXT DEFAULT 'pending', error TEXT, sent_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS daily_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, date TEXT NOT NULL, count INTEGER DEFAULT 0, UNIQUE(customer_id, date));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS blacklist (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE NOT NULL, name TEXT, reason TEXT DEFAULT 'demo_used', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, contact_phone TEXT NOT NULL, direction TEXT NOT NULL, message_type TEXT DEFAULT 'text', body TEXT, media_path TEXT, media_mimetype TEXT, wa_message_id TEXT, status TEXT DEFAULT 'sent', created_at TEXT DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(customer_id, contact_phone, id);
    CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), UNIQUE(customer_id, phone));
    CREATE TABLE IF NOT EXISTS chat_reads (customer_id INTEGER NOT NULL, contact_phone TEXT NOT NULL, last_read_id INTEGER DEFAULT 0, PRIMARY KEY(customer_id, contact_phone));
  `);
  saveDb();
}

function createAdmin(username, password) {
  const hash = bcrypt.hashSync(password, 10);
  try { run('INSERT INTO admins (username,password) VALUES (?,?)', [username, hash]); return true; }
  catch(e) { return false; }
}
function getAdmin(username) { return get('SELECT * FROM admins WHERE username=?', [username]); }
function adminExists() { return (get('SELECT COUNT(*) as c FROM admins')?.c || 0) > 0; }

function createCustomer(data) {
  const token = uuidv4().replace(/-/g,'');
  run('INSERT INTO customers (name,email,phone,token,plan,daily_limit,expires_at,notes) VALUES (?,?,?,?,?,?,?,?)',
    [data.name,data.email||null,data.phone||null,token,data.plan||'basic',data.daily_limit||100,data.expires_at||null,data.notes||null]);
  return getCustomerByToken(token);
}

function getCustomers() {
  return all(`SELECT c.*,
    (SELECT status FROM connections WHERE customer_id=c.id LIMIT 1) as wa_status,
    (SELECT wa_number FROM connections WHERE customer_id=c.id LIMIT 1) as wa_number,
    (SELECT COUNT(*) FROM message_logs WHERE customer_id=c.id) as total_messages,
    (SELECT count FROM daily_usage WHERE customer_id=c.id AND date=date('now')) as today_messages
    FROM customers c ORDER BY c.created_at DESC`);
}

function getCustomerByToken(token) { return get('SELECT * FROM customers WHERE token=?',[token]); }
function getCustomerById(id) { return get('SELECT * FROM customers WHERE id=?',[id]); }
function updateCustomer(id,data) { const f=Object.keys(data).map(k=>`${k}=?`).join(','); run(`UPDATE customers SET ${f} WHERE id=?`,[...Object.values(data),id]); }
function deleteCustomer(id) { run('DELETE FROM customers WHERE id=?',[id]); }
function toggleCustomer(id,status) { run('UPDATE customers SET status=? WHERE id=?',[status,id]); }

function upsertConnection(customerId,data) {
  const existing = get('SELECT id FROM connections WHERE customer_id=?',[customerId]);
  if (existing) { const f=Object.keys(data).map(k=>`${k}=?`).join(','); run(`UPDATE connections SET ${f} WHERE customer_id=?`,[...Object.values(data),customerId]); }
  else { const cols=['customer_id',...Object.keys(data)].join(','); const vals=Array(Object.keys(data).length+1).fill('?').join(','); run(`INSERT INTO connections (${cols}) VALUES (${vals})`,[customerId,...Object.values(data)]); }
}

function getConnection(customerId) { return get('SELECT * FROM connections WHERE customer_id=?',[customerId]); }

function checkAndIncrementUsage(customerId,limit) {
  const today=new Date().toISOString().split('T')[0];
  try { run('INSERT OR IGNORE INTO daily_usage (customer_id,date,count) VALUES (?,?,0)',[customerId,today]); } catch(e) {}
  const usage=get('SELECT count FROM daily_usage WHERE customer_id=? AND date=?',[customerId,today]);
  if ((usage?.count||0)>=limit) return false;
  run('UPDATE daily_usage SET count=count+1 WHERE customer_id=? AND date=?',[customerId,today]);
  return true;
}

function logMessage(customerId,toNumber,type,status,error=null) {
  run('INSERT INTO message_logs (customer_id,to_number,message_type,status,error) VALUES (?,?,?,?,?)',[customerId,toNumber,type,status,error]);
}

function getSetting(key) { return get('SELECT value FROM settings WHERE key=?',[key])?.value||null; }
function setSetting(key,value) { run('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)',[key,value]); }

function getStats() {
  return {
    total_customers: get("SELECT COUNT(*) as c FROM customers")?.c||0,
    active_customers: get("SELECT COUNT(*) as c FROM customers WHERE status='active'")?.c||0,
    connected_wa: get("SELECT COUNT(*) as c FROM connections WHERE status='connected'")?.c||0,
    today_messages: get("SELECT COALESCE(SUM(count),0) as c FROM daily_usage WHERE date=date('now')")?.c||0,
    total_messages: get("SELECT COUNT(*) as c FROM message_logs")?.c||0,
  };
}

function getCustomerByPhone(phone) { return get('SELECT * FROM customers WHERE phone=?',[phone]); }

// ── KARA LİSTE ───────────────────────────────────────────────────
function addBlacklist(phone, name, reason = 'demo_used') {
  try { run('INSERT OR IGNORE INTO blacklist (phone,name,reason) VALUES (?,?,?)',[phone,name,reason]); return true; }
  catch(e) { return false; }
}
function isBlacklisted(phone) { return !!get('SELECT id FROM blacklist WHERE phone=?',[phone]); }
function getBlacklist() { return all('SELECT * FROM blacklist ORDER BY created_at DESC'); }
function removeBlacklist(id) { run('DELETE FROM blacklist WHERE id=?',[id]); }
function searchBlacklist(q) { return all("SELECT * FROM blacklist WHERE phone LIKE ? OR name LIKE ? ORDER BY created_at DESC",[`%${q}%`,`%${q}%`]); }

// Bugün ilk kez limit aşıldıysa true döner (tekrar bildirim gönderme)
function isFirstLimitExceed(customerId) {
  const today = new Date().toISOString().split('T')[0];
  const key = `limit_notif_${customerId}_${today}`;
  if (getSetting(key)) return false;
  setSetting(key, '1');
  return true;
}

function getTodayUsage(customerId) {
  const today = new Date().toISOString().split('T')[0];
  return get('SELECT count FROM daily_usage WHERE customer_id=? AND date=?',[customerId,today])?.count || 0;
}

function getTotalUsage(customerId) {
  return get('SELECT COALESCE(SUM(count),0) as c FROM daily_usage WHERE customer_id=?',[customerId])?.c || 0;
}

// ── REHBER (SUNUCU TARAFLI KİŞİ LİSTESİ — Rehber ve Sohbet ekranları paylaşır) ──
function addContact(customerId, name, phone) {
  run(`INSERT INTO contacts (customer_id,name,phone) VALUES (?,?,?)
       ON CONFLICT(customer_id,phone) DO UPDATE SET name=excluded.name`, [customerId, name, phone]);
  return getContactByPhone(customerId, phone);
}

function bulkAddContacts(customerId, list) {
  const stmt = getDb().prepare(`INSERT INTO contacts (customer_id,name,phone) VALUES (?,?,?)
       ON CONFLICT(customer_id,phone) DO UPDATE SET name=excluded.name`);
  let count = 0;
  for (const row of list) {
    const name = (row.name || '').toString().trim();
    const phone = (row.phone || '').toString().trim();
    if (!name || !phone) continue;
    stmt.run([customerId, name, phone]);
    count++;
  }
  stmt.free();
  saveDb();
  return count;
}

function getContacts(customerId) { return all('SELECT * FROM contacts WHERE customer_id=? ORDER BY name COLLATE NOCASE', [customerId]); }
function getContactByPhone(customerId, phone) { return get('SELECT * FROM contacts WHERE customer_id=? AND phone=?', [customerId, phone]); }
function deleteContact(customerId, id) { run('DELETE FROM contacts WHERE customer_id=? AND id=?', [customerId, id]); }
function clearContacts(customerId) { run('DELETE FROM contacts WHERE customer_id=?', [customerId]); }

// ── SOHBET GEÇMİŞİ ──────────────────────────────────────────────
function addMessage(customerId, contactPhone, direction, type, body, mediaPath, mediaMimetype, waMessageId, status) {
  run(`INSERT INTO messages (customer_id,contact_phone,direction,message_type,body,media_path,media_mimetype,wa_message_id,status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    [customerId, contactPhone, direction, type || 'text', body || null, mediaPath || null, mediaMimetype || null, waMessageId || null, status || 'sent']);
  const id = get('SELECT last_insert_rowid() as id')?.id;
  return get('SELECT * FROM messages WHERE id=?', [id]);
}

function getMessages(customerId, contactPhone, opts = {}) {
  const limit = Math.min(opts.limit || 50, 200);
  if (opts.afterId) {
    return all('SELECT * FROM messages WHERE customer_id=? AND contact_phone=? AND id>? ORDER BY id ASC LIMIT ?',
      [customerId, contactPhone, opts.afterId, limit]);
  }
  if (opts.beforeId) {
    const rows = all('SELECT * FROM messages WHERE customer_id=? AND contact_phone=? AND id<? ORDER BY id DESC LIMIT ?',
      [customerId, contactPhone, opts.beforeId, limit]);
    return rows.reverse();
  }
  const rows = all('SELECT * FROM messages WHERE customer_id=? AND contact_phone=? ORDER BY id DESC LIMIT ?',
    [customerId, contactPhone, limit]);
  return rows.reverse();
}

function updateMessageStatusByWaId(customerId, waMessageId, status) {
  run('UPDATE messages SET status=? WHERE customer_id=? AND wa_message_id=?', [status, customerId, waMessageId]);
}

function getConversations(customerId) {
  return all(`
    SELECT m.contact_phone, m.message_type, m.body, m.direction, m.status, m.created_at
    FROM messages m
    WHERE m.customer_id=? AND m.id IN (
      SELECT MAX(id) FROM messages WHERE customer_id=? GROUP BY contact_phone
    )
    ORDER BY m.created_at DESC`, [customerId, customerId]);
}

// Sohbet listesi yalnızca gerçekten konuşulmuş (mesajlaşma geçmişi olan) ya da kullanıcının
// bilerek açtığı (chat_reads'e düşmüş — bkz. markRead) kişileri gösterir; rehberdeki her kişi
// otomatik "sohbet" sayılmaz, aksi halde toplu gönderim için eklenmiş yüzlerce kişi burada da
// (hiç yazışılmamış halde) listelenirdi.
function getConversationPhones(customerId) {
  return all(`
    SELECT contact_phone FROM messages WHERE customer_id=?
    UNION
    SELECT contact_phone FROM chat_reads WHERE customer_id=?`, [customerId, customerId]).map(r => r.contact_phone);
}

function markRead(customerId, phone) {
  const last = get('SELECT MAX(id) as m FROM messages WHERE customer_id=? AND contact_phone=?', [customerId, phone])?.m || 0;
  run(`INSERT INTO chat_reads (customer_id,contact_phone,last_read_id) VALUES (?,?,?)
       ON CONFLICT(customer_id,contact_phone) DO UPDATE SET last_read_id=excluded.last_read_id`, [customerId, phone, last]);
}

function getUnreadCounts(customerId) {
  return all(`
    SELECT m.contact_phone, COUNT(*) as unread
    FROM messages m
    LEFT JOIN chat_reads r ON r.customer_id=m.customer_id AND r.contact_phone=m.contact_phone
    WHERE m.customer_id=? AND m.direction='in' AND m.id > COALESCE(r.last_read_id,0)
    GROUP BY m.contact_phone`, [customerId]);
}

module.exports = { initDb, saveDb, createAdmin, getAdmin, adminExists, createCustomer, getCustomers, getCustomerByToken, getCustomerById, getCustomerByPhone, updateCustomer, deleteCustomer, toggleCustomer, upsertConnection, getConnection, checkAndIncrementUsage, logMessage, getSetting, setSetting, getStats, getTodayUsage, getTotalUsage, addBlacklist, isBlacklisted, getBlacklist, removeBlacklist, searchBlacklist, isFirstLimitExceed, addContact, bulkAddContacts, getContacts, getContactByPhone, deleteContact, clearContacts, addMessage, getMessages, updateMessageStatusByWaId, getConversations, getConversationPhones, markRead, getUnreadCounts };
