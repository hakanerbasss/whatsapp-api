// src/database.js — sql.js (saf JavaScript, derleme gerekmez)
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

// ── MÜŞTERİ TOKEN'INI VERİTABANINDA ŞİFRELEME ────────────────────
// customers.token artık DÜZ METİN DEĞİL: aranabilir (WHERE token=?) olması için SHA-256 özeti
// tutuluyor, gerçek değer ise (panelde yeniden gösterebilmek için) AES-256-GCM ile şifrelenmiş
// halde token_enc sütununda. Anahtar TOKEN_ENC_KEY'den, o da yoksa (mevcut kurulumlar yeniden
// yapılandırma gerektirmesin diye) zaten her kurulumda benzersiz olan JWT_SECRET'ten türetilir.
const ENC_KEY = crypto.createHash('sha256')
  .update(process.env.TOKEN_ENC_KEY || process.env.JWT_SECRET || 'whatsapp-api-secret-2024')
  .digest();

function hashToken(plain) { return crypto.createHash('sha256').update(plain).digest('hex'); }

function encryptValue(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decryptValue(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// customers satırındaki token_enc'i çözüp token alanına düz metni koyar — çağıranların hepsi
// .token'ı hep düz metin olarak bekliyor, bu yüzden dönüş noktasında tek seferde hallediyoruz.
function withDecryptedToken(row) {
  if (row && row.token_enc) {
    try { row.token = decryptValue(row.token_enc); } catch (e) { /* eski/bozuk veri — token hash olarak kalır */ }
  }
  return row;
}

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
  migrate();
  // Her yazmada tüm veritabanını diske yeniden yazmak (sql.js'in doğası — artımlı değil,
  // db.export() her seferinde komple bir kopya üretir) veritabanı büyüdükçe pahalılaşıyordu.
  // Artık yazmalar "kirli" işaretlenip en çok ~300ms'de bir TEK seferde diske yazılıyor — art
  // arda gelen onlarca yazma (toplu kişi/mesaj kaydı gibi) tek bir diske yazmada toplanıyor.
  // Bu interval, dirty bayrağı yanlışlıkla set edilmeden kalırsa diye ucuz bir yedek güvence
  // (zaten temizse hiçbir şey yapmıyor) — asıl kaydı artık flushDbIfDirty üstleniyor.
  setInterval(flushDbIfDirty, 5000);
  process.on('SIGINT', () => { flushDbIfDirty(); process.exit(0); });
  process.on('SIGTERM', () => { flushDbIfDirty(); process.exit(0); });
  return db;
}

let dbDirty = false;
let saveTimer = null;
const SAVE_DEBOUNCE_MS = 300;

function saveDb() {
  if (!db) return;
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); } catch(e) {}
}

function flushDbIfDirty() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (dbDirty) { dbDirty = false; saveDb(); }
}

function scheduleSave() {
  dbDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(flushDbIfDirty, SAVE_DEBOUNCE_MS);
}

// Yedekleme için — db.export() bellekteki ANLIK tutarlı durumu döner (dosyayı kopyalamaktan
// farklı olarak, aynı anda süren bir yazmayla yarışmaz, çünkü Node tek iş parçacıklıdır).
function exportSnapshot() {
  return Buffer.from(getDb().export());
}

function getDb() {
  if (!db) throw new Error('DB henüz başlatılmadı.');
  return db;
}

function run(sql, params = []) { getDb().run(sql, params); scheduleSave(); }

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
    CREATE TABLE IF NOT EXISTS scheduled_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, message_type TEXT NOT NULL, payload TEXT NOT NULL, media_path TEXT, media_mimetype TEXT, contacts TEXT NOT NULL, batch_size INTEGER, batch_delay_ms INTEGER, message_delay_ms INTEGER NOT NULL, run_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', sent_count INTEGER DEFAULT 0, fail_count INTEGER DEFAULT 0, next_index INTEGER DEFAULT 0, error TEXT, created_at TEXT DEFAULT (datetime('now')), started_at TEXT, finished_at TEXT);
    CREATE TABLE IF NOT EXISTS archived_chats (customer_id INTEGER NOT NULL, contact_phone TEXT NOT NULL, archived_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(customer_id, contact_phone));
    CREATE TABLE IF NOT EXISTS push_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, endpoint TEXT UNIQUE NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_username TEXT, action TEXT NOT NULL, target TEXT, details TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now')));
  `);
  saveDb();
}

// Zaten kurulu müşterilerin veritabanında scheduled_jobs tablosu önceden var —
// CREATE TABLE IF NOT EXISTS yeni sütunları eklemez, bu yüzden eksik sütunları
// elle (var olanı bozmadan) ekliyoruz. install.sh dışında ekstra bir adım gerekmez,
// sunucu her başladığında otomatik çalışır.
function migrate() {
  const columnAdditions = [
    { table: 'scheduled_jobs', column: 'recurrence', ddl: 'ALTER TABLE scheduled_jobs ADD COLUMN recurrence TEXT' },
    { table: 'scheduled_jobs', column: 'total_sent_count', ddl: 'ALTER TABLE scheduled_jobs ADD COLUMN total_sent_count INTEGER DEFAULT 0' },
    { table: 'scheduled_jobs', column: 'total_fail_count', ddl: 'ALTER TABLE scheduled_jobs ADD COLUMN total_fail_count INTEGER DEFAULT 0' },
    // SQLite ALTER TABLE ADD COLUMN ile sabit bir DEFAULT, var olan satırlara da uygulanır —
    // mevcut müşteriler ayrıca "kapalı" görünmesin diye varsayılan açık (1).
    { table: 'customers', column: 'notify_scheduled', ddl: 'ALTER TABLE customers ADD COLUMN notify_scheduled INTEGER DEFAULT 1' },
    { table: 'customers', column: 'token_enc', ddl: 'ALTER TABLE customers ADD COLUMN token_enc TEXT' },
    // Mevcut müşteriler bugüne kadarki davranışı (gelen mesajda bildirim) kaybetmesin diye
    // varsayılan açık (1) — kapatmak isteyen Bildirimler kartından kendi kapatır.
    { table: 'customers', column: 'notify_incoming_messages', ddl: 'ALTER TABLE customers ADD COLUMN notify_incoming_messages INTEGER DEFAULT 1' },
    // Token'ın en son ne zaman üretildiğini/yenilendiğini tutar — rotasyon hatırlatması için.
    // Sabit bir DEFAULT satır bazlı created_at'i taşıyamaz, bu yüzden NULL bırakılıp aşağıda
    // created_at'ten (hesap ne zaman açıldıysa token da o an üretilmişti) dolduruluyor.
    { table: 'customers', column: 'token_rotated_at', ddl: 'ALTER TABLE customers ADD COLUMN token_rotated_at TEXT' },
  ];
  for (const m of columnAdditions) {
    const existing = all(`PRAGMA table_info(${m.table})`).map(c => c.name);
    if (!existing.includes(m.column)) getDb().exec(m.ddl);
  }
  migrateTokenEncryption();
  getDb().run('UPDATE customers SET token_rotated_at = created_at WHERE token_rotated_at IS NULL');
  saveDb();
}

// Önceki sürümlerde customers.token düz metindi (32 hex karakter — uuidv4 tire'siz). Burada
// bulunan her satırı, aranabilir SHA-256 özetine çevirip gerçek değeri token_enc'e şifreli
// olarak taşıyoruz. Hash (64 hex) ile düz metin (32 hex) karıştırılmaz; zaten taşınmış satırlar
// (token_enc dolu) tekrar işlenmez — sunucu her başlangıçta migrate() çalıştırsa da idempotent.
function migrateTokenEncryption() {
  const rows = all('SELECT id, token FROM customers WHERE token_enc IS NULL');
  for (const row of rows) {
    if (!row.token || row.token.length !== 32) continue; // zaten hash (64) ya da beklenmedik biçim
    const plain = row.token;
    getDb().run('UPDATE customers SET token=?, token_enc=? WHERE id=?', [hashToken(plain), encryptValue(plain), row.id]);
  }
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
  run(`INSERT INTO customers (name,email,phone,token,token_enc,plan,daily_limit,expires_at,notes,token_rotated_at)
       VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`,
    [data.name,data.email||null,data.phone||null,hashToken(token),encryptValue(token),data.plan||'basic',data.daily_limit||100,data.expires_at||null,data.notes||null]);
  return getCustomerByToken(token);
}

function getCustomers() {
  return all(`SELECT c.*,
    (SELECT status FROM connections WHERE customer_id=c.id LIMIT 1) as wa_status,
    (SELECT wa_number FROM connections WHERE customer_id=c.id LIMIT 1) as wa_number,
    (SELECT COUNT(*) FROM message_logs WHERE customer_id=c.id) as total_messages,
    (SELECT count FROM daily_usage WHERE customer_id=c.id AND date=date('now')) as today_messages
    FROM customers c ORDER BY c.created_at DESC`).map(withDecryptedToken);
}

function getCustomerByToken(token) { return withDecryptedToken(get('SELECT * FROM customers WHERE token=?',[hashToken(token)])); }
function getCustomerById(id) { return withDecryptedToken(get('SELECT * FROM customers WHERE id=?',[id])); }
function updateCustomer(id,data) {
  const d = { ...data };
  if (d.token !== undefined) {
    const plain = d.token;
    d.token = hashToken(plain); d.token_enc = encryptValue(plain);
    d.token_rotated_at = new Date().toISOString().replace('T',' ').slice(0,19);
  }
  const f=Object.keys(d).map(k=>`${k}=?`).join(','); run(`UPDATE customers SET ${f} WHERE id=?`,[...Object.values(d),id]);
}
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

function getCustomerByPhone(phone) { return withDecryptedToken(get('SELECT * FROM customers WHERE phone=?',[phone])); }

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

// Bugün ilk kez kota %80'e ulaşıldıysa true döner (tekrar bildirim gönderme)
function isFirstQuotaWarning(customerId) {
  const today = new Date().toISOString().split('T')[0];
  const key = `quota80_notif_${customerId}_${today}`;
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

// LID (Linked ID) onarımı: eski bir sohbet kimliğini (oldPhone — genelde yanlışlıkla
// kaydedilmiş bir LID sayısı) gerçek numaraya (newPhone) taşır. messages'ta çakışma riski
// yok (benzersizlik kısıtı yok); chat_reads/archived_chats'te PRIMARY KEY(customer_id,
// contact_phone) olduğu için iki satır çakışabilir — en ileri okunan/arşiv durumunu koruyup
// eskisini silerek birleştiriyoruz. contacts'ta gerçek numarada zaten bir kişi varsa
// (beklenen durum) eski "hayalet" kişi sessizce silinir.
function mergeContactPhone(customerId, oldPhone, newPhone) {
  if (!oldPhone || !newPhone || oldPhone === newPhone) return { moved: 0 };
  const movedMessages = get('SELECT COUNT(*) as c FROM messages WHERE customer_id=? AND contact_phone=?', [customerId, oldPhone])?.c || 0;
  if (!movedMessages) return { moved: 0 }; // bu müşteri için hiç veri yoksa taşınacak bir şey de yok

  run('UPDATE messages SET contact_phone=? WHERE customer_id=? AND contact_phone=?', [newPhone, customerId, oldPhone]);

  const oldRead = get('SELECT last_read_id FROM chat_reads WHERE customer_id=? AND contact_phone=?', [customerId, oldPhone]);
  if (oldRead) {
    const newRead = get('SELECT last_read_id FROM chat_reads WHERE customer_id=? AND contact_phone=?', [customerId, newPhone]);
    const merged = Math.max(oldRead.last_read_id || 0, newRead?.last_read_id || 0);
    run(`INSERT INTO chat_reads (customer_id,contact_phone,last_read_id) VALUES (?,?,?)
         ON CONFLICT(customer_id,contact_phone) DO UPDATE SET last_read_id=excluded.last_read_id`, [customerId, newPhone, merged]);
    run('DELETE FROM chat_reads WHERE customer_id=? AND contact_phone=?', [customerId, oldPhone]);
  }

  const oldArchived = get('SELECT archived_at FROM archived_chats WHERE customer_id=? AND contact_phone=?', [customerId, oldPhone]);
  if (oldArchived) {
    run('INSERT OR IGNORE INTO archived_chats (customer_id,contact_phone,archived_at) VALUES (?,?,?)', [customerId, newPhone, oldArchived.archived_at]);
    run('DELETE FROM archived_chats WHERE customer_id=? AND contact_phone=?', [customerId, oldPhone]);
  }

  const oldContact = get('SELECT id FROM contacts WHERE customer_id=? AND phone=?', [customerId, oldPhone]);
  if (oldContact) {
    const newContact = get('SELECT id FROM contacts WHERE customer_id=? AND phone=?', [customerId, newPhone]);
    if (!newContact) run('UPDATE contacts SET phone=? WHERE id=?', [newPhone, oldContact.id]);
    else run('DELETE FROM contacts WHERE id=?', [oldContact.id]);
  }

  return { moved: movedMessages };
}

function markRead(customerId, phone) {
  const last = get('SELECT MAX(id) as m FROM messages WHERE customer_id=? AND contact_phone=?', [customerId, phone])?.m || 0;
  run(`INSERT INTO chat_reads (customer_id,contact_phone,last_read_id) VALUES (?,?,?)
       ON CONFLICT(customer_id,contact_phone) DO UPDATE SET last_read_id=excluded.last_read_id`, [customerId, phone, last]);
}

// ── SOHBET: ARŞİVLE / SİL ─────────────────────────────────────────
function archiveChat(customerId, phone) {
  run(`INSERT INTO archived_chats (customer_id,contact_phone) VALUES (?,?)
       ON CONFLICT(customer_id,contact_phone) DO UPDATE SET archived_at=datetime('now')`, [customerId, phone]);
}
function unarchiveChat(customerId, phone) {
  run('DELETE FROM archived_chats WHERE customer_id=? AND contact_phone=?', [customerId, phone]);
}
function getArchivedPhones(customerId) {
  return all('SELECT contact_phone FROM archived_chats WHERE customer_id=?', [customerId]).map(r => r.contact_phone);
}
// Sohbet geçmişini (mesajlar, okundu bilgisi, arşiv durumu) kalıcı olarak siler.
// Medya dosyalarının kendisi veritabanında tutulmadığı için silinen medya yollarını
// döner — diskten silmek çağıranın (index.js) işi.
function deleteChatHistory(customerId, phone) {
  const mediaFiles = all('SELECT media_path FROM messages WHERE customer_id=? AND contact_phone=? AND media_path IS NOT NULL', [customerId, phone]).map(r => r.media_path);
  run('DELETE FROM messages WHERE customer_id=? AND contact_phone=?', [customerId, phone]);
  run('DELETE FROM chat_reads WHERE customer_id=? AND contact_phone=?', [customerId, phone]);
  run('DELETE FROM archived_chats WHERE customer_id=? AND contact_phone=?', [customerId, phone]);
  return mediaFiles;
}

function getUnreadCounts(customerId) {
  return all(`
    SELECT m.contact_phone, COUNT(*) as unread
    FROM messages m
    LEFT JOIN chat_reads r ON r.customer_id=m.customer_id AND r.contact_phone=m.contact_phone
    WHERE m.customer_id=? AND m.direction='in' AND m.id > COALESCE(r.last_read_id,0)
    GROUP BY m.contact_phone`, [customerId]);
}

function getTotalUnreadCount(customerId) {
  return get(`
    SELECT COUNT(*) as c
    FROM messages m
    LEFT JOIN chat_reads r ON r.customer_id=m.customer_id AND r.contact_phone=m.contact_phone
    WHERE m.customer_id=? AND m.direction='in' AND m.id > COALESCE(r.last_read_id,0)`, [customerId])?.c || 0;
}

// ── PUSH BİLDİRİMLERİ ─────────────────────────────────────────────
function addPushSubscription(customerId, sub) {
  run(`INSERT INTO push_subscriptions (customer_id,endpoint,p256dh,auth) VALUES (?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET customer_id=excluded.customer_id, p256dh=excluded.p256dh, auth=excluded.auth`,
    [customerId, sub.endpoint, sub.keys.p256dh, sub.keys.auth]);
}
function removePushSubscription(endpoint) {
  run('DELETE FROM push_subscriptions WHERE endpoint=?', [endpoint]);
}
function getPushSubscriptions(customerId) {
  return all('SELECT * FROM push_subscriptions WHERE customer_id=?', [customerId]);
}

// ── İŞLEM KAYDI (AUDIT LOG) ───────────────────────────────────────
// Admin'in hassas/durum değiştiren işlemlerini (müşteri ekle/sil/askıya al, token sıfırla,
// ayar değiştir, duyuru gönder, kara liste vb.) kalıcı olarak kaydeder — "kim ne zaman ne
// yaptı" sorusuna sonradan cevap verebilmek için. details serbest biçimli bir JSON metnidir;
// token gibi hassas değerler asla burada tutulmaz, sadece hangi müşteri/alan etkilendiği.
function addAuditLog(adminUsername, action, target, details, ip) {
  run('INSERT INTO audit_log (admin_username, action, target, details, ip) VALUES (?,?,?,?,?)',
    [adminUsername || null, action, target || null, details ? JSON.stringify(details) : null, ip || null]);
}

function getAuditLog({ limit = 100, offset = 0 } = {}) {
  return all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset]);
}

// ── ZAMANLANMIŞ TOPLU GÖNDERİM ───────────────────────────────────
// Tarayıcı kapansa/telefon uyusa bile gönderilsin diye tamamen sunucu tarafında,
// veritabanına kaydedilmiş bir kuyruk olarak tutulur (bkz. src/scheduler.js).
function createScheduledJob(data) {
  run(`INSERT INTO scheduled_jobs
    (customer_id, message_type, payload, media_path, media_mimetype, contacts, batch_size, batch_delay_ms, message_delay_ms, run_at, recurrence, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending')`,
    [data.customerId, data.messageType, JSON.stringify(data.payload || {}), data.mediaPath || null, data.mediaMimetype || null,
     JSON.stringify(data.contacts), data.batchSize || null, data.batchDelayMs || null, data.messageDelayMs, data.runAt,
     data.recurrence ? JSON.stringify(data.recurrence) : null]);
  return get('SELECT * FROM scheduled_jobs WHERE id = last_insert_rowid()');
}

function getScheduledJobs(customerId) {
  return all('SELECT * FROM scheduled_jobs WHERE customer_id=? ORDER BY created_at DESC', [customerId]);
}

function getScheduledJob(id) { return get('SELECT * FROM scheduled_jobs WHERE id=?', [id]); }

function getScheduledJobForCustomer(id, customerId) {
  return get('SELECT * FROM scheduled_jobs WHERE id=? AND customer_id=?', [id, customerId]);
}

// Zamanı gelmiş olanları JS tarafında belirliyoruz (sql.js'in datetime() formatıyla
// ISO string karşılaştırması güvenilir değil) — bekleyen iş sayısı küçük olduğundan sorun değil.
function getPendingScheduledJobs() {
  return all("SELECT * FROM scheduled_jobs WHERE status='pending'");
}

function getRunningScheduledJobs() {
  return all("SELECT * FROM scheduled_jobs WHERE status='running'");
}

function updateScheduledJob(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  run(`UPDATE scheduled_jobs SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`, [...keys.map(k => fields[k]), id]);
}

function cancelScheduledJob(id, customerId) {
  const job = get('SELECT * FROM scheduled_jobs WHERE id=? AND customer_id=?', [id, customerId]);
  if (!job || job.status !== 'pending') return false;
  run("UPDATE scheduled_jobs SET status='cancelled', finished_at=datetime('now') WHERE id=?", [id]);
  return true;
}

module.exports = { initDb, saveDb, exportSnapshot, createAdmin, getAdmin, adminExists, createCustomer, getCustomers, getCustomerByToken, getCustomerById, getCustomerByPhone, updateCustomer, deleteCustomer, toggleCustomer, upsertConnection, getConnection, checkAndIncrementUsage, logMessage, getSetting, setSetting, getStats, getTodayUsage, getTotalUsage, addBlacklist, isBlacklisted, getBlacklist, removeBlacklist, searchBlacklist, isFirstLimitExceed, isFirstQuotaWarning, addContact, bulkAddContacts, getContacts, getContactByPhone, deleteContact, clearContacts, addMessage, getMessages, updateMessageStatusByWaId, getConversations, getConversationPhones, mergeContactPhone, markRead, getUnreadCounts, createScheduledJob, getScheduledJobs, getScheduledJob, getScheduledJobForCustomer, getPendingScheduledJobs, getRunningScheduledJobs, updateScheduledJob, cancelScheduledJob, archiveChat, unarchiveChat, getArchivedPhones, deleteChatHistory, getTotalUnreadCount, addPushSubscription, removePushSubscription, getPushSubscriptions, addAuditLog, getAuditLog };
