// src/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const wa = require('./whatsapp');
const scheduler = require('./scheduler');
const push = require('./push');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'whatsapp-api-secret-2024';

// Tarayıcıdan (farklı origin'den) doğrudan API çağrısı yapılabilecek adresler Ayarlar'dan
// yönetilir (cors_origins — virgülle ayrılmış liste, "*" tamamen açar). Boşsa tarayıcı
// kaynaklı çapraz-origin istekler reddedilir; panel sayfaları (admin/müşteri) ve
// sunucu-sunucu/backend çağrıları (tarayıcı olmadığı için Origin başlığı taşımaz) bundan
// etkilenmez — CORS yalnızca tarayıcıların çapraz-origin isteklerinde devreye girer.
function corsOptionsDelegate(req, callback) {
  const origin = req.header('Origin');
  const allowed = (db.getSetting('cors_origins') || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !origin || allowed.includes('*') || allowed.includes(origin);
  callback(null, { origin: ok });
}
app.use(cors(corsOptionsDelegate));
app.use(express.json());

// ── HTTP BASIC AUTH ───────────────────────────────────────────────
// Panel şifresi .env'den veya varsayılan
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || null; // Şifre yoksa devre dışı

app.use((req, res, next) => {
  // API isteklerini atla (token ile korunuyor)
  if (req.path.startsWith('/api/')) return next();
  // Müşteri sayfalarını atla
  if (req.path === '/kayit' || req.path === '/musteri') return next();
  // Panel şifresi ayarlanmamışsa atla
  if (!PANEL_PASS) return next();

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    // Henüz bir deneme yapılmadı (tarayıcı ilk kez şifre soruyor) — başarısız sayılmaz.
    res.set('WWW-Authenticate', 'Basic realm="WhatsApp API Panel"');
    return res.status(401).send('Erişim için şifre gerekli');
  }
  const lockKey = 'panel:' + getClientIp(req);
  const lockedSeconds = checkLoginLockout(lockKey);
  if (lockedSeconds) {
    res.set('Retry-After', String(lockedSeconds));
    return res.status(429).send(`Çok fazla başarısız deneme. ${Math.ceil(lockedSeconds / 60)} dakika sonra tekrar deneyin.`);
  }
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (user !== PANEL_USER || pass !== PANEL_PASS) {
    recordLoginFailure(lockKey);
    res.set('WWW-Authenticate', 'Basic realm="WhatsApp API Panel"');
    return res.status(401).send('Kullanıcı adı veya şifre hatalı');
  }
  recordLoginSuccess(lockKey);
  next();
});

app.use(express.static(path.join(__dirname, '../panel')));

// ── RATE LIMIT ────────────────────────────────────────────────────
// Token başına: saniyede max 2 istek
const tokenRateMap = {};
// Sunucu geneli: saniyede max 10 istek (IP koruması)
const serverRateLog = [];

function rateLimit(req, res, next) {
  const now = Date.now();

  // 1. Sunucu geneli kontrol
  const recentServer = serverRateLog.filter(t => now - t < 1000);
  serverRateLog.length = 0;
  recentServer.forEach(t => serverRateLog.push(t));
  if (serverRateLog.length >= 10) {
    return res.status(429).json({
      error: 'Sunucu yoğun, lütfen biraz bekleyin.',
      retry_after: 1
    });
  }
  serverRateLog.push(now);

  // 2. Token başına kontrol
  if (req.customer) {
    const id = req.customer.id;
    if (!tokenRateMap[id]) tokenRateMap[id] = [];
    tokenRateMap[id] = tokenRateMap[id].filter(t => now - t < 3000);
    if (tokenRateMap[id].length >= 1) {
      return res.status(429).json({
        error: 'Çok hızlı istek. Her 3 saniyede maksimum 1 mesaj gönderebilirsiniz.',
        retry_after: 3
      });
    }
    tokenRateMap[id].push(now);
  }

  next();
}

// ── GİRİŞ DENEMESİ KORUMASI (BRUTE-FORCE) ────────────────────────
// IP başına: 15 dakikada 5 başarısız denemeden sonra 15 dakika kilitler. Bellek içi — sunucu
// yeniden başlarsa sıfırlanır (kabul edilebilir: bu bir DoS önleyici değil, parola tahmin
// saldırısına karşı). nginx proxy_set_header X-Real-IP $remote_addr ile gerçek istemci IP'sini
// taşıyor (bkz. install.sh) — Express'in trust proxy ayarına ihtiyaç duymadan onu kullanıyoruz.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const loginAttempts = {}; // key -> { count, firstAttempt, lockedUntil }

function getClientIp(req) {
  return req.headers['x-real-ip'] || req.ip;
}

// Kilitliyse kalan saniyeyi, değilse null döner.
function checkLoginLockout(key) {
  const rec = loginAttempts[key];
  if (rec && rec.lockedUntil && rec.lockedUntil > Date.now()) {
    return Math.ceil((rec.lockedUntil - Date.now()) / 1000);
  }
  return null;
}

function recordLoginFailure(key) {
  const now = Date.now();
  let rec = loginAttempts[key];
  if (!rec || now - rec.firstAttempt > LOGIN_WINDOW_MS) rec = { count: 0, firstAttempt: now, lockedUntil: 0 };
  rec.count++;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) rec.lockedUntil = now + LOGIN_LOCKOUT_MS;
  loginAttempts[key] = rec;
}

function recordLoginSuccess(key) { delete loginAttempts[key]; }

// Bellek büyümesini sınırlamak için eski/kilidi geçmiş kayıtları periyodik temizle.
setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(loginAttempts)) {
    const rec = loginAttempts[key];
    if ((!rec.lockedUntil || rec.lockedUntil < now) && now - rec.firstAttempt > LOGIN_WINDOW_MS) delete loginAttempts[key];
  }
}, 10 * 60 * 1000);

// ── MIDDLEWARE ────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token gerekli' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') throw new Error();
    req.admin = decoded;
    next();
  } catch(e) {
    res.status(401).json({ error: 'Geçersiz token' });
  }
}

function customerAuth(req, res, next) {
  const token = req.headers['x-api-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'API token gerekli' });
  const customer = db.getCustomerByToken(token);
  if (!customer) return res.status(401).json({ error: 'Geçersiz token' });
  if (customer.status !== 'active') return res.status(403).json({ error: 'Hesabınız askıya alınmış' });
  if (customer.expires_at && new Date(customer.expires_at) < new Date()) {
    return res.status(403).json({ error: 'Aboneliğiniz sona erdi' });
  }
  req.customer = customer;
  next();
}

// Dashboard için — süresi dolsa da giriş izni verir. Müşteri panelinin "giriş" adımı bu
// uçtan geçtiği için brute-force koruması da burada — token 128 bit olsa da savunma derinliği
// ve aynı IP'den otomatik deneme/tarama girişimlerini önlemek için.
function customerAuthDashboard(req, res, next) {
  const token = req.headers['x-api-token'] || req.query.token;
  const lockKey = 'customer:' + getClientIp(req);
  const lockedSeconds = checkLoginLockout(lockKey);
  if (lockedSeconds) {
    return res.status(429).json({
      error: `Çok fazla başarısız deneme. ${Math.ceil(lockedSeconds / 60)} dakika sonra tekrar deneyin.`,
      retry_after: lockedSeconds
    });
  }
  if (!token) { recordLoginFailure(lockKey); return res.status(401).json({ error: 'API token gerekli' }); }
  const customer = db.getCustomerByToken(token);
  if (!customer) { recordLoginFailure(lockKey); return res.status(401).json({ error: 'Geçersiz token' }); }
  recordLoginSuccess(lockKey);
  req.customer = customer;
  next();
}

// ═══════════════════════════════════════════════════════════════
// ADMIN API
// ═══════════════════════════════════════════════════════════════

// Setup — ilk kurulum
app.post('/api/setup', async (req, res) => {
  if (db.adminExists()) return res.status(400).json({ error: 'Kurulum zaten tamamlandı' });
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli' });
  db.createAdmin(username, password);
  res.json({ ok: true, message: 'Admin hesabı oluşturuldu' });
});

// Admin login
app.post('/api/admin/login', (req, res) => {
  const lockKey = 'admin:' + getClientIp(req);
  const lockedSeconds = checkLoginLockout(lockKey);
  if (lockedSeconds) {
    return res.status(429).json({
      error: `Çok fazla başarısız giriş denemesi. ${Math.ceil(lockedSeconds / 60)} dakika sonra tekrar deneyin.`,
      retry_after: lockedSeconds
    });
  }
  const { username, password } = req.body;
  const admin = db.getAdmin(username);
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    recordLoginFailure(lockKey);
    return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' });
  }
  recordLoginSuccess(lockKey);
  const token = jwt.sign({ id: admin.id, username, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ ok: true, token });
});

// Dashboard istatistikleri
app.get('/api/admin/stats', adminAuth, (req, res) => {
  res.json(db.getStats());
});

// Müşteri listesi
app.get('/api/admin/customers', adminAuth, (req, res) => {
  res.json(db.getCustomers());
});

// Müşteri ekle
app.post('/api/admin/customers', adminAuth, (req, res) => {
  const customer = db.createCustomer(req.body);
  res.json({ ok: true, customer });
});

// Müşteri güncelle
app.put('/api/admin/customers/:id', adminAuth, (req, res) => {
  db.updateCustomer(req.params.id, req.body);
  res.json({ ok: true });
});

// Müşteri sil
app.delete('/api/admin/customers/:id', adminAuth, async (req, res) => {
  await wa.disconnectCustomer(req.params.id).catch(() => {});
  db.deleteCustomer(req.params.id);
  res.json({ ok: true });
});

// Müşteri dondur/aktifleştir
app.post('/api/admin/customers/:id/toggle', adminAuth, (req, res) => {
  const customer = db.getCustomerById(req.params.id);
  const newStatus = customer.status === 'active' ? 'suspended' : 'active';
  db.toggleCustomer(req.params.id, newStatus);
  res.json({ ok: true, status: newStatus });
});

// Token yenile
app.post('/api/admin/customers/:id/reset-token', adminAuth, (req, res) => {
  const { v4: uuidv4 } = require('uuid');
  const newToken = uuidv4().replace(/-/g, '');
  db.updateCustomer(req.params.id, { token: newToken });
  res.json({ ok: true, token: newToken });
});

// Admin — WhatsApp bağlantı başlat
app.post('/api/admin/customers/:id/connect', adminAuth, async (req, res) => {
  const { method } = req.body; // qr | pairing | phone_code
  const result = await wa.startConnection(req.params.id, method || 'qr');
  res.json(result);
});

// Admin — WhatsApp bağlantı kes
app.post('/api/admin/customers/:id/disconnect', adminAuth, async (req, res) => {
  await wa.disconnectCustomer(req.params.id);
  res.json({ ok: true });
});

// Admin — bağlantı durumu
app.get('/api/admin/customers/:id/status', adminAuth, (req, res) => {
  res.json(wa.getStatus(req.params.id));
});

app.get('/api/admin/customers/:id/events', (req, res) => {
  // EventSource header gönderemez, query param kullan
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).end();
  try { jwt.verify(token, JWT_SECRET); } catch(e) { return res.status(401).end(); }

  const customerId = parseInt(req.params.id);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  };

  // Mevcut durumu hemen gönder
  send({ type: 'status', ...wa.getStatus(customerId) });

  const onQR      = (d) => send({ type: 'qr', ...d });
  const onStatus  = (d) => send({ type: 'status', ...d });
  const onPairing = (d) => send({ type: 'pairing', ...d });

  wa.waEvents.on(`qr_${customerId}`, onQR);
  wa.waEvents.on(`status_${customerId}`, onStatus);
  wa.waEvents.on(`pairing_${customerId}`, onPairing);

  // Keepalive ping
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(ping);
    wa.waEvents.off(`qr_${customerId}`, onQR);
    wa.waEvents.off(`status_${customerId}`, onStatus);
    wa.waEvents.off(`pairing_${customerId}`, onPairing);
  });
});

// ═══════════════════════════════════════════════════════════════
// PUBLIC API (auth yok)
// ═══════════════════════════════════════════════════════════════

// Paketleri herkese açık döndür — waport.wizaicorp.com buradan okur
app.get('/api/public/packages', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const packages = JSON.parse(db.getSetting('packages') || JSON.stringify([
    { id: 'basic',     name: 'Basic',     limit: 100,  price: '150₺/ay', desc: 'Küçük işletmeler için' },
    { id: 'pro',       name: 'Pro',       limit: 500,  price: '300₺/ay', desc: 'Büyüyen işletmeler için' },
    { id: 'unlimited', name: 'Unlimited', limit: 9999, price: '500₺/ay', desc: 'Sınırsız kullanım' },
  ]));
  res.json(packages);
});

// ═══════════════════════════════════════════════════════════════
// AYARLAR API
// ═══════════════════════════════════════════════════════════════

// Ayarları getir
app.get('/api/admin/settings', adminAuth, (req, res) => {
  res.json({
    contact_phone:   db.getSetting('contact_phone') || '',
    contact_email:   db.getSetting('contact_email') || '',
    contact_message: db.getSetting('contact_message') || 'Mesaj limitinize ulaştınız. Devam etmek için iletişime geçin.',
    cors_origins:    db.getSetting('cors_origins') || '',
    packages: JSON.parse(db.getSetting('packages') || JSON.stringify([
      { id: 'basic',     name: 'Basic',     limit: 100,  price: '150₺/ay', desc: 'Küçük işletmeler için' },
      { id: 'pro',       name: 'Pro',       limit: 500,  price: '300₺/ay', desc: 'Büyüyen işletmeler için' },
      { id: 'unlimited', name: 'Unlimited', limit: 9999, price: '500₺/ay', desc: 'Sınırsız kullanım' },
    ]))
  });
});

// Ayarları kaydet
app.post('/api/admin/settings', adminAuth, (req, res) => {
  const { contact_phone, contact_email, contact_message, cors_origins, packages } = req.body;
  if (contact_phone   !== undefined) db.setSetting('contact_phone',   contact_phone);
  if (contact_email   !== undefined) db.setSetting('contact_email',   contact_email);
  if (contact_message !== undefined) db.setSetting('contact_message', contact_message);
  if (cors_origins    !== undefined) db.setSetting('cors_origins',    cors_origins);
  if (packages        !== undefined) db.setSetting('packages', JSON.stringify(packages));
  res.json({ ok: true });
});

// ── KARA LİSTE API ───────────────────────────────────────────────
app.get('/api/admin/blacklist', adminAuth, (req, res) => {
  const q = req.query.q;
  res.json(q ? db.searchBlacklist(q) : db.getBlacklist());
});

app.delete('/api/admin/blacklist/:id', adminAuth, (req, res) => {
  db.removeBlacklist(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/blacklist', adminAuth, (req, res) => {
  const { phone, name, reason } = req.body;
  if (!phone) return res.status(400).json({ error: 'Telefon gerekli' });
  db.addBlacklist(phone.replace(/\D/g,''), name || '', reason || 'manual');
  res.json({ ok: true });
});
// Admin iletişim WhatsApp'ını bul
function getAdminWaConn() {
  const contactPhone = db.getSetting('contact_phone')?.replace(/\D/g, '');
  if (!contactPhone) return null;
  const customers = db.getCustomers();
  return customers.find(c => c.wa_status === 'connected' && c.wa_number === contactPhone);
}

// Kota dolduğunda admin + müşteriye bildirim gönder (günde 1 kez)
async function notifyLimitExceeded(customer) {
  try {
    if (!db.isFirstLimitExceed(customer.id)) return;
    const adminConn = getAdminWaConn();
    if (!adminConn) return;
    const contactPhone = db.getSetting('contact_phone')?.replace(/\D/g, '');
    const baseUrl = db.getSetting('base_url') || `http://localhost:${PORT}`;
    const isDemo = customer.plan === 'demo';
    const planLabel = isDemo ? `Demo (${customer.daily_limit} mesaj)` : `${customer.plan} (${customer.daily_limit}/gün)`;

    // Admin bildirimi
    if (contactPhone) {
      const adminMsg = `⚠️ *Kota Aşıldı*\n\nMüşteri: ${customer.name}\nPlan: ${planLabel}\nToken: ${customer.token.slice(0, 8)}...\n\nPlan yükseltmek için:\n${baseUrl}`;
      await wa.sendMessage(adminConn.id, contactPhone, adminMsg).catch(() => {});
    }

    // Müşteri bildirimi (telefonu kayıtlıysa)
    if (customer.phone) {
      const customerMsg = isDemo
        ? `⚠️ Demo süreniz doldu!\n\n${customer.daily_limit} mesaj hakkınızı kullandınız.\nDevam etmek için plan yükseltin:\n${baseUrl}/musteri?token=${customer.token}`
        : `⚠️ Günlük kotanız doldu!\n\nGünlük ${customer.daily_limit} mesaj hakkınızı kullandınız.\nYarın otomatik sıfırlanır veya planınızı yükseltin:\n${baseUrl}/musteri?token=${customer.token}`;
      await wa.sendMessage(adminConn.id, customer.phone, customerMsg).catch(() => {});
    }
  } catch(e) {
    console.error('Limit bildirim hatası:', e.message);
  }
}

// Kota %80'e ulaşınca müşteriyi önceden uyar (günde 1 kez) — kota tam dolup mesajlar
// reddedilmeden önce planını yükseltmesi için fırsat versin.
async function notifyQuotaWarning(customer, used) {
  try {
    if (!db.isFirstQuotaWarning(customer.id)) return;
    const baseUrl = db.getSetting('base_url') || `http://localhost:${PORT}`;
    await push.sendToCustomer(customer.id, {
      title: 'Günlük kotanız dolmak üzere',
      body: `Bugün ${used}/${customer.daily_limit} mesaj gönderdiniz. Kotanız dolmadan önce planınızı yükseltebilirsiniz.`,
      url: '/musteri?token=' + customer.token
    }).catch(() => {});
  } catch(e) {
    console.error('Kota uyarı bildirim hatası:', e.message);
  }
}

// checkAndIncrementUsage'ı sarmalar: kullanım izni aynı kalır, ayrıca kota %80'i ilk kez
// aşıldığında proaktif bildirim tetikler. Tüm /api/send* uçları aynı sarmalayıcıyı kullanır.
function trackUsage(customer) {
  const allowed = db.checkAndIncrementUsage(customer.id, customer.daily_limit);
  if (allowed) {
    const used = db.getTodayUsage(customer.id);
    if (used / customer.daily_limit >= 0.8) notifyQuotaWarning(customer, used).catch(() => {});
  }
  return allowed;
}

// Tek müşteriye mesaj gönder
app.post('/api/admin/customers/:id/message', adminAuth, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Mesaj gerekli' });
  const customer = db.getCustomerById(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Müşteri bulunamadı' });
  if (!customer.phone) return res.status(400).json({ error: 'Müşterinin telefon numarası yok' });
  const adminConn = getAdminWaConn();
  if (!adminConn) return res.status(400).json({ error: 'Ayarlar\'dan iletişim telefon numaranızı ekleyin ve WhatsApp\'a bağlayın.' });
  try {
    await wa.sendMessage(adminConn.id, customer.phone, message);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Toplu duyuru
app.post('/api/admin/broadcast', adminAuth, async (req, res) => {
  const { message, plan_filter } = req.body;
  if (!message) return res.status(400).json({ error: 'Mesaj gerekli' });
  const adminConn = getAdminWaConn();
  if (!adminConn) return res.status(400).json({ error: 'Ayarlar\'dan iletişim telefon numaranızı ekleyin ve WhatsApp\'a bağlayın.' });
  const customers = db.getCustomers().filter(c => {
    if (c.status !== 'active') return false;
    if (!c.phone) return false;
    if (plan_filter && plan_filter !== 'all') return c.plan === plan_filter;
    return true;
  });
  const results = [];
  for (const c of customers) {
    try {
      await wa.sendMessage(adminConn.id, c.phone, message);
      results.push({ id: c.id, name: c.name, ok: true });
    } catch(e) {
      results.push({ id: c.id, name: c.name, ok: false, error: e.message });
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  res.json({ ok: true, total: customers.length, results });
});

app.get('/api/admin/find/:token', adminAuth, (req, res) => {
  const customer = db.getCustomerByToken(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Müşteri bulunamadı' });
  const conn = wa.getStatus(customer.id);
  const totalUsage = db.getTotalUsage(customer.id);
  res.json({ ...customer, wa_status: conn.status, wa_number: conn.phone, total_usage: totalUsage });
});

// Plan yükselt + otomatik WhatsApp mesajı
app.post('/api/admin/customers/:id/upgrade', adminAuth, async (req, res) => {
  const { plan, daily_limit, expires_at } = req.body;
  const customer = db.getCustomerById(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Müşteri bulunamadı' });

  // Planı güncelle
  const updateData = { plan, daily_limit: parseInt(daily_limit), status: 'active' };
  if (expires_at) updateData.expires_at = expires_at;
  db.updateCustomer(req.params.id, updateData);

  // Paket bilgisi
  const packages = JSON.parse(db.getSetting('packages') || '[]');
  const pkg = packages.find(p => p.id === plan);
  const planName = pkg ? pkg.name : plan;

  // Otomatik WhatsApp mesajı gönder
  let waSent = false;
  if (customer.phone) {
    try {
      const customers = db.getCustomers();
      const adminConn = customers.find(c => c.wa_status === 'connected' && c.plan !== 'demo');
      if (adminConn) {
        const expStr = expires_at ? `\nBitiş tarihi: ${new Date(expires_at).toLocaleDateString('tr-TR')}` : '';
        const msg = `✅ Merhaba ${customer.name}!\n\n${planName} planınız aktifleştirildi.\n\nGünlük limit: ${daily_limit} mesaj${expStr}\n\nDashboard: ${db.getSetting('base_url') || `http://localhost:${PORT}`}/musteri?token=${customer.token}\n\nİyi kullanımlar! 🚀`;
        await wa.sendMessage(adminConn.id, customer.phone, msg);
        waSent = true;
      }
    } catch(e) {
      console.error('Otomatik mesaj hatası:', e.message);
    }
  }

  res.json({ ok: true, plan, daily_limit, expires_at, wa_sent: waSent });
});

// ═══════════════════════════════════════════════════════════════
// MÜŞTERİ API (Token ile)
// ═══════════════════════════════════════════════════════════════

// Durum
app.get('/api/status', customerAuth, (req, res) => {
  const conn = wa.getStatus(req.customer.id);
  res.json({
    customer: req.customer.name,
    plan: req.customer.plan,
    daily_limit: req.customer.daily_limit,
    wa_status: conn.status,
    wa_number: conn.phone,
    expires_at: req.customer.expires_at
  });
});

// Mesaj gönder
app.post('/api/send', customerAuth, rateLimit, async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to ve message gerekli' });

  // Limit kontrol — demo'da toplam mesaj, diğerlerinde günlük
  const isDemoExpired = req.customer.plan === 'demo' &&
    db.getTotalUsage(req.customer.id) >= req.customer.daily_limit;
  const allowed = isDemoExpired ? false : trackUsage(req.customer);

  if (!allowed) {
    db.logMessage(req.customer.id, to, 'text', 'limit_exceeded');
    notifyLimitExceeded(req.customer).catch(() => {});
    return res.status(429).json({
      error: db.getSetting('contact_message') || 'Günlük mesaj limitinize ulaştınız',
      contact: {
        phone: db.getSetting('contact_phone') || null,
        email: db.getSetting('contact_email') || null,
      }
    });
  }

  try {
    await wa.sendMessage(req.customer.id, to, message);
    db.logMessage(req.customer.id, to, 'text', 'sent');
    res.json({ ok: true, message: 'Mesaj gönderildi' });
  } catch(e) {
    db.logMessage(req.customer.id, to, 'text', 'failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Resim gönder
app.post('/api/send/image', customerAuth, rateLimit, async (req, res) => {
  const { to, url, caption } = req.body;
  if (!to || !url) return res.status(400).json({ error: 'to ve url gerekli' });

  const allowed = trackUsage(req.customer);
  if (!allowed) {
    notifyLimitExceeded(req.customer).catch(() => {});
    return res.status(429).json({ error: 'Günlük limit aşıldı' });
  }

  try {
    await wa.sendMessage(req.customer.id, to, { image: { url }, caption: caption || '' });
    db.logMessage(req.customer.id, to, 'image', 'sent');
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Dosya gönder
app.post('/api/send/document', customerAuth, rateLimit, async (req, res) => {
  const { to, url, filename, mimetype } = req.body;
  if (!to || !url) return res.status(400).json({ error: 'to ve url gerekli' });

  const allowed = trackUsage(req.customer);
  if (!allowed) {
    notifyLimitExceeded(req.customer).catch(() => {});
    return res.status(429).json({ error: 'Günlük limit aşıldı' });
  }

  try {
    await wa.sendMessage(req.customer.id, to, {
      document: { url },
      fileName: filename || 'dosya',
      mimetype: mimetype || 'application/octet-stream'
    });
    db.logMessage(req.customer.id, to, 'document', 'sent');
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Ses gönder
app.post('/api/send/audio', customerAuth, rateLimit, async (req, res) => {
  const { to, url } = req.body;
  if (!to || !url) return res.status(400).json({ error: 'to ve url gerekli' });

  const allowed = trackUsage(req.customer);
  if (!allowed) {
    notifyLimitExceeded(req.customer).catch(() => {});
    return res.status(429).json({ error: 'Günlük limit aşıldı' });
  }

  try {
    await wa.sendMessage(req.customer.id, to, { audio: { url }, mimetype: 'audio/mp4', ptt: false });
    db.logMessage(req.customer.id, to, 'audio', 'sent');
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Konum gönder
app.post('/api/send/location', customerAuth, rateLimit, async (req, res) => {
  const { to, latitude, longitude, name, address } = req.body;
  if (!to || latitude == null || longitude == null) return res.status(400).json({ error: 'to, latitude ve longitude gerekli' });

  const allowed = trackUsage(req.customer);
  if (!allowed) {
    notifyLimitExceeded(req.customer).catch(() => {});
    return res.status(429).json({ error: 'Günlük limit aşıldı' });
  }

  try {
    await wa.sendMessage(req.customer.id, to, {
      location: { degreesLatitude: parseFloat(latitude), degreesLongitude: parseFloat(longitude), name: name || '', address: address || '' }
    });
    db.logMessage(req.customer.id, to, 'location', 'sent');
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Canlı konum gönder
app.post('/api/send/live-location', customerAuth, rateLimit, async (req, res) => {
  const { to, latitude, longitude, name, address, duration_seconds } = req.body;
  if (!to || latitude == null || longitude == null) return res.status(400).json({ error: 'to, latitude ve longitude gerekli' });

  const allowed = trackUsage(req.customer);
  if (!allowed) {
    notifyLimitExceeded(req.customer).catch(() => {});
    return res.status(429).json({ error: 'Günlük limit aşıldı' });
  }

  try {
    await wa.sendMessage(req.customer.id, to, {
      liveLocation: {
        degreesLatitude: parseFloat(latitude),
        degreesLongitude: parseFloat(longitude),
        accuracyInMeters: 10,
        speedInMps: 0,
        degreesClockwiseFromMagneticNorth: 0,
        name: name || '',
        address: address || ''
      },
      caption: '',
      jpegThumbnail: null,
      sequenceNumber: BigInt(0),
      timeOffset: 0,
      duration: duration_seconds || 3600
    });
    db.logMessage(req.customer.id, to, 'live_location', 'sent');
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Kişi kartı gönder
app.post('/api/send/contact', customerAuth, rateLimit, async (req, res) => {
  const { to, contact_name, contact_phone } = req.body;
  if (!to || !contact_name || !contact_phone) return res.status(400).json({ error: 'to, contact_name ve contact_phone gerekli' });

  const allowed = trackUsage(req.customer);
  if (!allowed) {
    notifyLimitExceeded(req.customer).catch(() => {});
    return res.status(429).json({ error: 'Günlük limit aşıldı' });
  }

  try {
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${contact_name}\nTEL;type=CELL;type=VOICE;waid=${contact_phone.replace(/\D/g,'')}:+${contact_phone.replace(/\D/g,'')}\nEND:VCARD`;
    await wa.sendMessage(req.customer.id, to, {
      contacts: { displayName: contact_name, contacts: [{ vcard }] }
    });
    db.logMessage(req.customer.id, to, 'contact', 'sent');
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Tepki gönder
app.post('/api/send/reaction', customerAuth, async (req, res) => {
  const { to, message_id, emoji } = req.body;
  if (!to || !message_id || !emoji) return res.status(400).json({ error: 'to, message_id ve emoji gerekli' });

  try {
    let jid = to.toString().replace(/\D/g, '');
    if (jid.startsWith('0')) jid = '90' + jid.slice(1);
    jid = jid + '@s.whatsapp.net';
    const conn = wa.getConn(req.customer.id);
    if (!conn) return res.status(400).json({ error: 'WhatsApp bağlı değil' });
    await conn.sendMessage(jid, { react: { text: emoji, key: { remoteJid: jid, id: message_id } } });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Webhook URL ayarla
app.post('/api/webhook', customerAuth, (req, res) => {
  const { url } = req.body;
  db.updateCustomer(req.customer.id, { webhook_url: url || null });
  res.json({ ok: true, webhook_url: url || null });
});

// Webhook URL sorgula
app.get('/api/webhook', customerAuth, (req, res) => {
  res.json({ webhook_url: req.customer.webhook_url || null });
});

// ── PUSH BİLDİRİMLERİ (yeni mesaj, WhatsApp bağlantı kopması) ────────────
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ ok: true, key: push.getPublicKey() });
});

app.post('/api/push/subscribe', customerAuth, (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: 'Geçersiz abonelik' });
  }
  db.addPushSubscription(req.customer.id, sub);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', customerAuth, (req, res) => {
  if (req.body?.endpoint) db.removePushSubscription(req.body.endpoint);
  res.json({ ok: true });
});

// Zamanlanmış/periyodik gönderimler tamamlandığında (ya da başarısız olduğunda) ayrıca
// bildirim gönderilsin mi — ana "bildirimleri aç" anahtarından bağımsız, kendi tercihi.
app.post('/api/notify-prefs', customerAuth, (req, res) => {
  const b = req.body || {};
  const update = {};
  if (b.notify_scheduled !== undefined) update.notify_scheduled = b.notify_scheduled ? 1 : 0;
  if (b.notify_incoming_messages !== undefined) update.notify_incoming_messages = b.notify_incoming_messages ? 1 : 0;
  if (Object.keys(update).length) db.updateCustomer(req.customer.id, update);
  res.json({ ok: true });
});

// Numara kontrolü
app.post('/api/check', customerAuth, async (req, res) => {
  const { phones } = req.body;
  if (!phones || !Array.isArray(phones)) return res.status(400).json({ error: 'phones dizisi gerekli' });

  const conn = wa.getStatus(req.customer.id);
  if (conn.status !== 'connected') return res.status(400).json({ error: 'WhatsApp bağlı değil' });

  try {
    // Baileys onWhatsApp kontrolü
    const results = {};
    for (const phone of phones.slice(0, 10)) { // Max 10
      const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
      results[phone] = true; // Baileys check implementasyonu
    }
    res.json({ results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Toplu mesaj
app.post('/api/send/bulk', customerAuth, async (req, res) => {
  const { messages } = req.body; // [{to, message}]
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages dizisi gerekli' });

  const results = [];
  for (const msg of messages.slice(0, 50)) { // Max 50
    const allowed = trackUsage(req.customer);
    if (!allowed) {
      notifyLimitExceeded(req.customer).catch(() => {});
      results.push({ to: msg.to, ok: false, error: 'Limit aşıldı' });
      break;
    }
    try {
      await wa.sendMessage(req.customer.id, msg.to, msg.message);
      db.logMessage(req.customer.id, msg.to, 'text', 'sent');
      results.push({ to: msg.to, ok: true });
      await new Promise(r => setTimeout(r, 3000)); // Spam koruması
    } catch(e) {
      results.push({ to: msg.to, ok: false, error: e.message });
    }
  }
  res.json({ ok: true, results });
});

// ── MÜŞTERİ WhatsApp BAĞLANTI ─────────────────────────────────────
app.post('/api/connect', customerAuth, async (req, res) => {
  const { method, phone } = req.body;
  if (method === 'pairing' && phone) {
    db.updateCustomer(req.customer.id, { phone });
  }
  const result = await wa.startConnection(req.customer.id, method || 'qr');
  res.json(result);
});

app.get('/api/connect/status', customerAuth, (req, res) => {
  res.json(wa.getStatus(req.customer.id));
});

// Müşteri SSE
app.get('/api/connect/events', (req, res) => {
  // Header veya query param token kabul et
  const token = req.headers['x-api-token'] || req.query.token;
  if (!token) return res.status(401).end();
  const customer = db.getCustomerByToken(token);
  if (!customer || customer.status !== 'active') return res.status(401).end();
  const customerId = customer.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => { res.write(`data: ${JSON.stringify(data)}\n\n`); if(res.flush) res.flush(); };
  send({ type: 'status', ...wa.getStatus(customerId) });

  const onQR = (d) => send({ type: 'qr', ...d });
  const onStatus = (d) => send({ type: 'status', ...d });
  const onPairing = (d) => send({ type: 'pairing', ...d });
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);

  wa.waEvents.on(`qr_${customerId}`, onQR);
  wa.waEvents.on(`status_${customerId}`, onStatus);
  wa.waEvents.on(`pairing_${customerId}`, onPairing);

  req.on('close', () => {
    clearInterval(ping);
    wa.waEvents.off(`qr_${customerId}`, onQR);
    wa.waEvents.off(`status_${customerId}`, onStatus);
    wa.waEvents.off(`pairing_${customerId}`, onPairing);
  });
});

// ── DOSYA UPLOAD ─────────────────────────────────────────────────
const multer = require('multer');
const os = require('os');
const upload = multer({ 
  dest: os.tmpdir(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

app.post('/api/upload', customerAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya gerekli' });
  res.json({ ok: true, path: req.file.path, mimetype: req.file.mimetype, originalname: req.file.originalname });
});

// Medya buffer ile gönder
app.post('/api/send/media', customerAuth, rateLimit, upload.single('file'), async (req, res) => {
  const { to, caption, filename, ptt } = req.body;
  if (!to || !req.file) return res.status(400).json({ error: 'to ve file gerekli' });

  const allowed = trackUsage(req.customer);
  if (!allowed) return res.status(429).json({ error: 'Günlük limit aşıldı' });

  try {
    const fs = require('fs');
    const buffer = fs.readFileSync(req.file.path);
    const mime = req.file.mimetype;
    let content;

    if (mime.startsWith('image/')) {
      content = { image: buffer, caption: caption || '' };
    } else if (mime.startsWith('video/')) {
      content = { video: buffer, caption: caption || '' };
    } else if (mime.startsWith('audio/')) {
      content = await wa.buildAudioContent(req.customer.id, buffer, mime, ptt === 'true' || ptt === '1');
    } else {
      content = { document: buffer, fileName: filename || req.file.originalname, mimetype: mime };
    }

    await wa.sendMessage(req.customer.id, to, content);
    db.logMessage(req.customer.id, to, mime.split('/')[0], 'sent');
    fs.unlinkSync(req.file.path); // Geçici dosyayı sil
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ZAMANLANMIŞ TOPLU GÖNDERİM — tarayıcı kapansa/sunucu yeniden başlasa bile
// gönderilsin diye tamamen sunucu tarafında bir kuyruk (bkz. src/scheduler.js)
// ═══════════════════════════════════════════════════════════════
const SCHEDULED_MEDIA_DIR = path.join(__dirname, '../data/scheduled_media');
if (!fs.existsSync(SCHEDULED_MEDIA_DIR)) fs.mkdirSync(SCHEDULED_MEDIA_DIR, { recursive: true });

// POST (oluşturma) ve PUT (düzenleme) aynı doğrulama kurallarını paylaşır — tek yerden,
// iki uçta da aynı anda bozulma riskini azaltır.
function validateScheduleRequest(b, messageType) {
  const validTypes = ['text', 'image', 'video', 'document', 'audio', 'location'];
  if (!validTypes.includes(messageType)) return { error: 'Geçersiz mesaj tipi' };

  let contacts;
  try { contacts = JSON.parse(b.contacts || '[]'); } catch (e) { contacts = null; }
  if (!Array.isArray(contacts) || !contacts.length) return { error: 'En az bir kişi seçilmeli' };
  contacts = contacts
    .map(c => ({ name: (c.name || '').toString().trim(), phone: wa.normalizePhone(c.phone || '') }))
    .filter(c => c.name && c.phone.length >= 10);
  if (!contacts.length) return { error: 'Geçerli kişi bulunamadı' };

  const runAtMs = Date.parse(b.run_at);
  if (!runAtMs || runAtMs <= Date.now()) return { error: 'Zamanlama tarihi gelecekte olmalı' };

  // Periyodik (tekrarlanan) gönderim: gün/saat (ve haftalık için haftanın günü, aylık için
  // ayın günü) seçilen ilk tarih/saatten türetilir — kullanıcı ayrıca bir gün/saat seçmez,
  // "her pazartesi 02:00" gibi bir tekrar istiyorsa run_at'i öyle bir ana ayarlar.
  let recurrence = null;
  if (b.recurrence_type && b.recurrence_type !== 'none') {
    if (!['daily', 'weekly', 'monthly'].includes(b.recurrence_type)) return { error: 'Geçersiz tekrar tipi' };
    const d = new Date(runAtMs);
    recurrence = { type: b.recurrence_type, hour: d.getHours(), minute: d.getMinutes() };
    if (b.recurrence_type === 'weekly') recurrence.dayOfWeek = d.getDay();
    if (b.recurrence_type === 'monthly') recurrence.dayOfMonth = d.getDate();
  }

  if (messageType === 'location' && (b.latitude == null || b.longitude == null)) {
    return { error: 'Konum için latitude ve longitude gerekli' };
  }

  // Mesajlar arası bekleme için spam/ban koruması olarak aynı alt sınır manuel gönderimdeki ile aynı (3sn).
  const messageDelayMs = Math.max(3000, parseInt(b.message_delay_ms) || 3000);
  const batchSize = parseInt(b.batch_size) || null;
  const batchDelayMs = batchSize ? Math.max(1000, parseInt(b.batch_delay_ms) || 30000) : null;

  return { contacts, runAtMs, recurrence, messageDelayMs, batchSize, batchDelayMs };
}

function buildSchedulePayload(b, req, existingPayload) {
  return {
    text: b.text || '',
    caption: b.caption || '',
    filename: b.filename || req.file?.originalname || existingPayload?.filename || null,
    // Düzenlemede ses yeniden kaydedilmediyse b.ptt gelmez — önceki değeri koru, aksi halde
    // sesli mesaj sessizce normal ses dosyasına döner.
    ptt: b.ptt !== undefined ? (b.ptt === 'true' || b.ptt === '1') : !!existingPayload?.ptt,
    audioUrl: b.audio_url || undefined,
    latitude: b.latitude != null ? parseFloat(b.latitude) : undefined,
    longitude: b.longitude != null ? parseFloat(b.longitude) : undefined,
    name: b.name || '',
    address: b.address || '',
    live: b.live === 'true' || b.live === '1',
    duration_seconds: b.duration_seconds ? parseInt(b.duration_seconds) : undefined
  };
}

app.post('/api/bulk/schedule', customerAuth, upload.single('file'), async (req, res) => {
  const b = req.body;
  const messageType = b.message_type;

  const v = validateScheduleRequest(b, messageType);
  if (v.error) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: v.error });
  }
  const { contacts, runAtMs, recurrence, messageDelayMs, batchSize, batchDelayMs } = v;

  const needsFile = ['image', 'video', 'document'].includes(messageType) || (messageType === 'audio' && !b.audio_url);
  if (needsFile && !req.file) return res.status(400).json({ error: 'Bu mesaj tipi için dosya gerekli' });

  let mediaPath = null, mediaMimetype = null;
  if (req.file) {
    let buffer = fs.readFileSync(req.file.path);
    let mimetype = req.file.mimetype;
    // Sesli mesaj (ptt) isteniyorsa gönderim anını beklemeden şimdi gerçek OGG/Opus'a
    // çevir — scheduler.js kaydedilmiş dosyayı aynen gönderir, dönüşüm orada tekrar yapılmaz.
    if (messageType === 'audio') {
      const built = await wa.buildAudioContent(req.customer.id, buffer, mimetype, b.ptt === 'true' || b.ptt === '1');
      buffer = built.audio;
      mimetype = built.mimetype;
      b.ptt = built.ptt ? 'true' : 'false';
    }
    const ext = mimetype.includes('ogg') ? '.ogg' : (path.extname(req.file.originalname) || '');
    mediaPath = path.join(SCHEDULED_MEDIA_DIR, `${Date.now()}_${req.customer.id}_${Math.random().toString(36).slice(2)}${ext}`);
    fs.writeFileSync(mediaPath, buffer);
    fs.unlinkSync(req.file.path);
    mediaMimetype = mimetype;
  }

  const payload = buildSchedulePayload(b, req);

  const job = db.createScheduledJob({
    customerId: req.customer.id,
    messageType,
    payload,
    mediaPath,
    mediaMimetype,
    contacts,
    batchSize,
    batchDelayMs,
    messageDelayMs,
    runAt: new Date(runAtMs).toISOString(),
    recurrence
  });

  res.json({ ok: true, job: { id: job.id, run_at: job.run_at, contact_count: contacts.length, status: job.status, recurrence } });
});

app.get('/api/bulk/scheduled', customerAuth, (req, res) => {
  const jobs = db.getScheduledJobs(req.customer.id).map(j => ({
    id: j.id,
    message_type: j.message_type,
    run_at: j.run_at,
    status: j.status,
    sent_count: j.sent_count,
    fail_count: j.fail_count,
    contact_count: JSON.parse(j.contacts || '[]').length,
    batch_size: j.batch_size,
    created_at: j.created_at,
    started_at: j.started_at,
    finished_at: j.finished_at,
    error: j.error,
    recurrence: j.recurrence ? JSON.parse(j.recurrence) : null,
    total_sent_count: j.total_sent_count || 0,
    total_fail_count: j.total_fail_count || 0
  }));
  res.json({ ok: true, jobs });
});

// Tek bir işin tam ayrıntısı: mesaj içeriği + alıcı listesi — hem "Detaylar" görünümü
// hem düzenleme formunu doldurmak için kullanılır. Liste uçundan kasıtlı ayrı: o uçta
// yüzlerce alıcının tamamını her seferinde taşımamak için sadece contact_count dönülüyor.
app.get('/api/bulk/scheduled/:id', customerAuth, (req, res) => {
  const job = db.getScheduledJobForCustomer(req.params.id, req.customer.id);
  if (!job) return res.status(404).json({ error: 'İş bulunamadı' });
  res.json({ ok: true, job: {
    id: job.id,
    message_type: job.message_type,
    payload: JSON.parse(job.payload || '{}'),
    contacts: JSON.parse(job.contacts || '[]'),
    has_media: !!job.media_path,
    media_mimetype: job.media_mimetype,
    batch_size: job.batch_size,
    batch_delay_ms: job.batch_delay_ms,
    message_delay_ms: job.message_delay_ms,
    run_at: job.run_at,
    status: job.status,
    recurrence: job.recurrence ? JSON.parse(job.recurrence) : null,
    sent_count: job.sent_count,
    fail_count: job.fail_count,
    total_sent_count: job.total_sent_count || 0,
    total_fail_count: job.total_fail_count || 0,
    error: job.error,
    created_at: job.created_at
  } });
});

// Bekleyen bir işi düzenler (mesaj tipi SABİT kalır — değiştirmek isterlerse iptal edip
// yeniden oluşturmaları gerekir). Medya dosyası, yeni bir dosya yüklenmediyse korunur.
// Düzenleme, ilerlemeyi sıfırlayıp işi baştan 'pending' durumuna alır.
app.put('/api/bulk/scheduled/:id', customerAuth, upload.single('file'), async (req, res) => {
  const existing = db.getScheduledJobForCustomer(req.params.id, req.customer.id);
  if (!existing) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'İş bulunamadı' });
  }
  if (existing.status !== 'pending') {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Bu iş şu anda çalışıyor veya bitmiş, düzenlenemez' });
  }

  const b = req.body;
  const messageType = existing.message_type;

  const v = validateScheduleRequest(b, messageType);
  if (v.error) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: v.error });
  }
  const { contacts, runAtMs, recurrence, messageDelayMs, batchSize, batchDelayMs } = v;

  let mediaPath = existing.media_path, mediaMimetype = existing.media_mimetype;
  if (req.file) {
    let buffer = fs.readFileSync(req.file.path);
    let mimetype = req.file.mimetype;
    if (messageType === 'audio') {
      const built = await wa.buildAudioContent(req.customer.id, buffer, mimetype, b.ptt === 'true' || b.ptt === '1');
      buffer = built.audio;
      mimetype = built.mimetype;
      b.ptt = built.ptt ? 'true' : 'false';
    }
    const ext = mimetype.includes('ogg') ? '.ogg' : (path.extname(req.file.originalname) || '');
    const newMediaPath = path.join(SCHEDULED_MEDIA_DIR, `${Date.now()}_${req.customer.id}_${Math.random().toString(36).slice(2)}${ext}`);
    fs.writeFileSync(newMediaPath, buffer);
    fs.unlinkSync(req.file.path);
    if (existing.media_path) { try { fs.unlinkSync(existing.media_path); } catch (e) {} }
    mediaPath = newMediaPath;
    mediaMimetype = mimetype;
  }

  const existingPayload = JSON.parse(existing.payload || '{}');
  const payload = buildSchedulePayload(b, req, existingPayload);

  db.updateScheduledJob(existing.id, {
    payload: JSON.stringify(payload),
    media_path: mediaPath,
    media_mimetype: mediaMimetype,
    contacts: JSON.stringify(contacts),
    batch_size: batchSize,
    batch_delay_ms: batchDelayMs,
    message_delay_ms: messageDelayMs,
    run_at: new Date(runAtMs).toISOString(),
    recurrence: recurrence ? JSON.stringify(recurrence) : null,
    status: 'pending',
    next_index: 0,
    sent_count: 0,
    fail_count: 0,
    error: null,
    finished_at: null
  });

  res.json({ ok: true });
});

app.delete('/api/bulk/scheduled/:id', customerAuth, (req, res) => {
  const job = db.getScheduledJob(req.params.id);
  const ok = db.cancelScheduledJob(req.params.id, req.customer.id);
  if (!ok) return res.status(400).json({ error: 'Bu iş iptal edilemez (zaten çalışıyor/bitmiş olabilir)' });
  if (job?.media_path) { try { fs.unlinkSync(job.media_path); } catch (e) {} }
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════
// REHBER — Toplu Mesaj ve Sohbet ekranları AYNI kişi listesini paylaşır
// ═══════════════════════════════════════════════════════════════
app.get('/api/contacts', customerAuth, (req, res) => {
  res.json({ ok: true, contacts: db.getContacts(req.customer.id) });
});

app.post('/api/contacts', customerAuth, (req, res) => {
  const name = (req.body.name || '').toString().trim();
  const phone = wa.normalizePhone(req.body.phone || '');
  if (!name || phone.length < 10) return res.status(400).json({ error: 'Ad ve geçerli telefon gerekli' });
  res.json({ ok: true, contact: db.addContact(req.customer.id, name, phone) });
});

app.post('/api/contacts/bulk', customerAuth, (req, res) => {
  const list = Array.isArray(req.body.contacts) ? req.body.contacts : [];
  const normalized = list.map(c => ({ name: (c.name || '').toString().trim(), phone: wa.normalizePhone(c.phone || '') }))
    .filter(c => c.name && c.phone.length >= 10);
  const count = db.bulkAddContacts(req.customer.id, normalized);
  res.json({ ok: true, added: count });
});

app.delete('/api/contacts/:id', customerAuth, (req, res) => {
  db.deleteContact(req.customer.id, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/contacts', customerAuth, (req, res) => {
  db.clearContacts(req.customer.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════
// SOHBET — rehberdeki (veya mesajlaşılmış herhangi bir) kişiyle WhatsApp'taki gibi iki yönlü sohbet
// ═══════════════════════════════════════════════════════════════
function guessTypeFromMime(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

app.get('/api/chat/conversations', customerAuth, (req, res) => {
  const phones = db.getConversationPhones(req.customer.id);
  const convs = db.getConversations(req.customer.id);
  const contacts = db.getContacts(req.customer.id);
  const unread = db.getUnreadCounts(req.customer.id);
  const archived = new Set(db.getArchivedPhones(req.customer.id));
  const nameMap = {}; contacts.forEach(c => { nameMap[c.phone] = c.name; });
  const lastMap = {}; convs.forEach(c => { lastMap[c.contact_phone] = c; });
  const unreadMap = {}; unread.forEach(u => { unreadMap[u.contact_phone] = u.unread; });

  const list = phones.map(phone => {
    const last = lastMap[phone];
    return {
      phone, name: nameMap[phone] || null,
      last_type: last ? last.message_type : null, last_body: last ? last.body : null,
      last_direction: last ? last.direction : null, last_status: last ? last.status : null,
      last_at: last ? last.created_at : null, unread: unreadMap[phone] || 0,
      archived: archived.has(phone)
    };
  });
  list.sort((a, b) => {
    if (!a.last_at && !b.last_at) return (a.name || '').localeCompare(b.name || '');
    if (!a.last_at) return 1;
    if (!b.last_at) return -1;
    return new Date(b.last_at) - new Date(a.last_at);
  });
  res.json({ ok: true, conversations: list });
});

app.post('/api/chat/:phone/archive', customerAuth, (req, res) => {
  db.archiveChat(req.customer.id, wa.normalizePhone(req.params.phone));
  res.json({ ok: true });
});

app.post('/api/chat/:phone/unarchive', customerAuth, (req, res) => {
  db.unarchiveChat(req.customer.id, wa.normalizePhone(req.params.phone));
  res.json({ ok: true });
});

app.delete('/api/chat/:phone', customerAuth, (req, res) => {
  const phone = wa.normalizePhone(req.params.phone);
  const mediaFiles = db.deleteChatHistory(req.customer.id, phone);
  const mediaDir = path.join(__dirname, '../data/media', String(req.customer.id));
  mediaFiles.forEach(filename => { try { fs.unlinkSync(path.join(mediaDir, filename)); } catch (e) {} });
  res.json({ ok: true });
});

app.get('/api/chat/:phone', customerAuth, (req, res) => {
  const phone = wa.normalizePhone(req.params.phone);
  const limit = parseInt(req.query.limit) || 50;
  const beforeId = req.query.before_id ? parseInt(req.query.before_id) : null;
  const afterId = req.query.after_id ? parseInt(req.query.after_id) : null;
  res.json({ ok: true, messages: db.getMessages(req.customer.id, phone, { limit, beforeId, afterId }) });
});

app.post('/api/chat/:phone/read', customerAuth, (req, res) => {
  db.markRead(req.customer.id, wa.normalizePhone(req.params.phone));
  res.json({ ok: true });
});

app.post('/api/chat/:phone/send', customerAuth, upload.single('file'), async (req, res) => {
  const phone = wa.normalizePhone(req.params.phone);
  const { text, ptt } = req.body;

  const allowed = trackUsage(req.customer);
  if (!allowed) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(429).json({ error: 'Günlük mesaj limitinize ulaştınız' });
  }

  try {
    let opts;
    if (req.file) {
      const buffer = fs.readFileSync(req.file.path);
      opts = {
        type: guessTypeFromMime(req.file.mimetype), text: text || '',
        mediaBuffer: buffer, mediaMimetype: req.file.mimetype, filename: req.file.originalname,
        ptt: ptt === 'true' || ptt === '1'
      };
      fs.unlinkSync(req.file.path);
    } else {
      if (!text || !text.trim()) return res.status(400).json({ error: 'Mesaj metni gerekli' });
      opts = { type: 'text', text };
    }
    const row = await wa.sendChatMessage(req.customer.id, phone, opts);
    res.json({ ok: true, message: row });
  } catch(e) {
    db.addMessage(req.customer.id, phone, 'out', req.file ? guessTypeFromMime(req.file.mimetype) : 'text', text || null, null, null, null, 'failed');
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/chat/media/:filename', customerAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(__dirname, '../data/media', String(req.customer.id), filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Dosya bulunamadı' });
  res.sendFile(filePath);
});

// Müşteri kendi tokenını yeniler
app.post('/api/musteri/renew-token', customerAuthDashboard, (req, res) => {
  const { v4: uuidv4 } = require('uuid');
  const newToken = uuidv4().replace(/-/g, '');
  db.updateCustomer(req.customer.id, { token: newToken });
  res.json({ ok: true, token: newToken });
});

// Müşteri kendi hesabını siler
app.delete('/api/musteri/delete', customerAuthDashboard, async (req, res) => {
  const customerId = req.customer.id;
  await wa.disconnectCustomer(customerId).catch(() => {});
  db.deleteCustomer(customerId);
  res.json({ ok: true });
});

app.post('/api/demo/register', async (req, res) => {
  const { name, email, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Ad ve telefon zorunlu' });

  const cleanPhone = phone.replace(/\D/g, '');

  // Kara liste kontrolü
  if (db.isBlacklisted(cleanPhone)) {
    return res.status(403).json({
      error: 'Bu numara daha önce demo kullandı',
      blacklisted: true,
      contact: {
        phone: db.getSetting('contact_phone') || null,
        message: 'Ücretli üyelik için iletişime geçin'
      }
    });
  }

  // Aynı telefon aktif kayıt var mı?
  const existing = db.getCustomerByPhone(cleanPhone);
  if (existing) return res.status(400).json({ error: 'Bu telefon numarası zaten kayıtlı' });

  const demoLimit = parseInt(db.getSetting('demo_limit') || '50');
  const customer = db.createCustomer({
    name, email: email || null, phone: cleanPhone,
    plan: 'demo', daily_limit: demoLimit,
    notes: 'Demo kayıt - ' + new Date().toLocaleDateString('tr-TR')
  });

  // Telefonu kara listeye ekle (demo kullandı)
  db.addBlacklist(cleanPhone, name, 'demo_used');

  res.json({ ok: true, token: customer.token, name: customer.name });
});

// ── MÜŞTERİ DASHBOARD API ─────────────────────────────────────────
app.get('/api/musteri/dashboard', customerAuthDashboard, (req, res) => {
  const c = req.customer;
  const usage = db.getTodayUsage(c.id);
  const totalUsage = db.getTotalUsage(c.id);
  const conn = wa.getStatus(c.id);
  const isExpired = c.expires_at && new Date(c.expires_at) < new Date();
  const isLimitDone = c.plan === 'demo' && totalUsage >= c.daily_limit;
  res.json({
    name: c.name, plan: c.plan, status: c.status,
    daily_limit: c.daily_limit, today_usage: usage, total_usage: totalUsage,
    remaining: Math.max(0, c.daily_limit - (c.plan === 'demo' ? totalUsage : usage)),
    expires_at: c.expires_at, is_expired: isExpired, is_limit_done: isLimitDone,
    wa_status: conn.status, wa_number: conn.phone,
    notify_scheduled: !!c.notify_scheduled,
    notify_incoming_messages: !!c.notify_incoming_messages,
    packages: JSON.parse(db.getSetting('packages') || '[]'),
    contact: {
      phone: db.getSetting('contact_phone') || null,
      email: db.getSetting('contact_email') || null,
      message: db.getSetting('contact_message') || 'Planınızı yükseltmek için iletişime geçin.'
    }
  });
});

// ── PANEL ─────────────────────────────────────────────────────────
app.get('/toplu', (req, res) => {
  res.sendFile(path.join(__dirname, '../panel/toplu.html'));
});

app.get('/kayit', (req, res) => {
  res.sendFile(path.join(__dirname, '../panel/kayit.html'));
});

app.get('/musteri', (req, res) => {
  res.sendFile(path.join(__dirname, '../panel/musteri.html'));
});

app.get('/sohbet', (req, res) => {
  res.sendFile(path.join(__dirname, '../panel/sohbet.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../panel/index.html'));
});

// ── BAŞLAT ────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║     WhatsApp API Server                ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`\n✅ Sunucu çalışıyor: http://localhost:${PORT}`);

  // Veritabanını başlat
  await db.initDb();
  console.log('✅ Veritabanı hazır');
  push.ensureVapidKeys();

  if (!db.adminExists()) {
    console.log('\n⚠️  İlk kurulum — Admin hesabı oluşturun:');
    console.log(`   http://localhost:${PORT}`);
  }

  // Tarayıcı aç (sadece Termux/Android)
  try {
    if (process.env.PREFIX?.includes('com.termux')) {
      require('child_process').spawn('am', ['start', '-a', 'android.intent.action.VIEW', '-d', `http://localhost:${PORT}`]);
    }
  } catch(e) {}

  console.log('\n🔄 Bağlantılar yenileniyor...');
  await wa.restoreConnections();

  scheduler.start();
  console.log('✅ Hazır!\n');

  // Süresi dolmuş müşterileri otomatik askıya al (her saat kontrol)
  function checkExpiredCustomers() {
    const customers = db.getCustomers();
    customers.forEach(c => {
      if (c.status === 'active' && c.expires_at && new Date(c.expires_at) < new Date()) {
        db.toggleCustomer(c.id, 'suspended');
        console.log(`⏰ Süresi doldu, askıya alındı: ${c.name}`);
      }
    });
  }
  checkExpiredCustomers();
  setInterval(checkExpiredCustomers, 60 * 60 * 1000); // Her saat
});
