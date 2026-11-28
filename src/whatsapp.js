// src/whatsapp.js
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage } = require('baileys');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');
const push = require('./push');
const EventEmitter = require('events');

const SESSION_DIR = path.join(__dirname, '../data/sessions');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

const MEDIA_DIR = path.join(__dirname, '../data/media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

const connections = {};
const waEvents = new EventEmitter();
waEvents.setMaxListeners(100);

// Gelen (WA JID) ve giden (kullanıcının yazdığı) numarayı aynı anahtara indirger —
// sohbet geçmişi gelen/giden mesajları aynı contact_phone altında eşleştirsin diye.
function normalizePhone(num) {
  let jid = (num || '').toString().replace(/\D/g, '');
  if (jid.startsWith('0')) jid = '90' + jid.slice(1);
  return jid;
}

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/aac': 'aac', 'audio/wav': 'wav',
  'application/pdf': 'pdf'
};

function extFromMime(mime, fallbackName) {
  if (fallbackName && path.extname(fallbackName)) return path.extname(fallbackName).slice(1);
  const clean = (mime || '').split(';')[0].trim();
  if (MIME_EXT[clean]) return MIME_EXT[clean];
  return (clean.split('/')[1] || 'bin');
}

function saveMediaBuffer(customerId, buffer, mimetype, fallbackName) {
  const dir = path.join(MEDIA_DIR, String(customerId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = `${uuidv4()}.${extFromMime(mimetype, fallbackName)}`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return filename;
}

// Tarayıcının MediaRecorder'ı sesli mesajı WEBM/Opus kabında kaydeder, WhatsApp'ın sesli mesaj
// (ptt) olarak OYNATABİLMESİ için gerçek bir OGG/Opus kabı ister — aksi halde mesaj ya hiç
// gitmez ya da karşı tarafta çalmaz. Burada yalnızca kap değişiyor, ses yeniden kodlanıyor
// (libopus) çünkü tarayıcı/cihaza göre girdi kodek/kap kombinasyonu değişebiliyor.
function webmToOggOpus(buffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-i', 'pipe:0', '-vn', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1']);
    const chunks = [];
    let stderr = '';
    ff.stdout.on('data', d => chunks.push(d));
    ff.stderr.on('data', d => { stderr += d; });
    ff.on('error', reject);
    ff.on('close', code => {
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg çıkış kodu ${code}: ${stderr.slice(-300)}`));
    });
    ff.stdin.write(buffer);
    ff.stdin.end();
  });
}

function fireWebhook(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    const body = JSON.stringify(payload);
    const url = new URL(webhookUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    });
    req.on('error', () => {});
    req.setTimeout(5000, () => req.destroy());
    req.write(body);
    req.end();
  } catch(e) {}
}

async function startConnection(customerId, method = 'qr', phoneNumber = null) {
  // Zaten bağlıysa döndür
  if (connections[customerId]?.status === 'connected') {
    return { status: 'already_connected' };
  }

  // Mevcut socket varsa kapat
  if (connections[customerId]?.socket) {
    try { connections[customerId].socket.end(); } catch(e) {}
    delete connections[customerId];
    await new Promise(r => setTimeout(r, 1000));
  }

  const sessionPath = path.join(SESSION_DIR, `customer_${customerId}`);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: require('pino')({ level: 'silent' }),
    browser: ['Mac OS', 'Chrome', '14.4.1'],
    defaultQueryTimeoutMs: undefined,
    connectTimeoutMs: 60000,
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: false,
  });

  connections[customerId] = {
    socket: sock,
    status: 'connecting',
    qr_base64: null,
    pairing_code: null,
    method,
    phone: null,
    pairingRequested: false,
  };

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR geldi
    if (qr) {
      try {
        const qr_base64 = await QRCode.toDataURL(qr);
        connections[customerId].qr_base64 = qr_base64;
        connections[customerId].status = 'qr_ready';
        waEvents.emit(`qr_${customerId}`, { qr_base64 });
        db.upsertConnection(customerId, { status: 'qr_ready' });
      } catch(e) {}

      // Pairing code yöntemi seçildiyse QR gelince iste
      if (method === 'pairing' && !connections[customerId].pairingRequested) {
        connections[customerId].pairingRequested = true;
        const phone = phoneNumber || db.getCustomerById(customerId)?.phone?.replace(/\D/g, '');
        if (phone) {
          try {
            const code = await sock.requestPairingCode(phone);
            connections[customerId].pairing_code = code;
            console.log(`✅ Pairing kodu: ${code} (müşteri: ${customerId})`);
            waEvents.emit(`pairing_${customerId}`, { code });
            db.upsertConnection(customerId, { status: 'pairing' });
          } catch(e) {
            console.error(`❌ Pairing code hatası (müşteri ${customerId}):`, e.message);
            waEvents.emit(`pairing_${customerId}`, { code: null, error: e.message });
          }
        }
      }
    }

    if (connection === 'close') {
      // NOT: instanceof Boom yerine .output?.statusCode'a doğrudan bakıyoruz — baileys kendi iç
      // node_modules'ünde AYRI bir @hapi/boom kopyası taşıyorsa (nested dependency) instanceof
      // yanlış sonuç verebilir (sınıf aynı görünse de farklı modül nesnesi), statusCode hep 0
      // çıkar ve asıl sebep gizli kalır — canlıda tam bu oldu.
      const errObj = lastDisconnect?.error;
      const statusCode = errObj?.output?.statusCode || errObj?.data?.statusCode || 0;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      // Gerçek sebep: WhatsApp'ın kendi gönderdiği "reason" kodu ve ham veri — teşhis için logla.
      console.error(`   ↳ müşteri ${customerId} bağlantı kapanma sebebi: mesaj="${errObj?.message || '(yok)'}" statusCode=${statusCode} data=`, JSON.stringify(errObj?.output?.payload || errObj?.data || {}));

      connections[customerId].status = 'disconnected';
      db.upsertConnection(customerId, { status: 'disconnected' });
      waEvents.emit(`status_${customerId}`, { status: 'disconnected' });

      if (shouldReconnect) {
        console.log(`🔄 Müşteri ${customerId} yeniden bağlanıyor... (kod: ${statusCode})`);
        setTimeout(() => {
          startConnection(customerId, method, phoneNumber);
        }, 3000);
      } else {
        console.log(`❌ Müşteri ${customerId} oturumu kapandı`);
        fs.rmSync(sessionPath, { recursive: true, force: true });
        delete connections[customerId];
        db.upsertConnection(customerId, { status: 'logged_out', wa_number: null });
        waEvents.emit(`status_${customerId}`, { status: 'logged_out' });
        // Yalnızca kendiliğinden düzelemeyecek (yeniden bağlanmayı denemeyen) gerçek kopmalarda
        // bildirim gönderiyoruz — her geçici ağ sıçramasında bildirim yağdırmamak için.
        const cust = db.getCustomerById(customerId);
        if (cust) {
          push.sendToCustomer(customerId, {
            title: 'WhatsApp bağlantısı koptu',
            body: 'Tekrar bağlanmak için panele girip QR okutun ya da telefon numarasıyla eşleştirin.',
            url: '/musteri?token=' + cust.token
          }).catch(() => {});
        }
      }
    }

    if (connection === 'open') {
      const waNumber = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0];
      connections[customerId].status = 'connected';
      connections[customerId].phone = waNumber;
      connections[customerId].qr_base64 = null;
      connections[customerId].pairingRequested = false;

      db.upsertConnection(customerId, {
        status: 'connected',
        wa_number: waNumber,
        connected_at: new Date().toISOString(),
        last_seen: new Date().toISOString()
      });

      waEvents.emit(`status_${customerId}`, { status: 'connected', phone: waNumber });
      console.log(`✅ Müşteri ${customerId} bağlandı: ${waNumber}`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    messages.forEach(async msg => {
      if (msg.key.fromMe) return;
      const isGroup = msg.key.remoteJid?.endsWith('@g.us');
      // WhatsApp bazı kişileri gerçek telefon numarası yerine dahili "LID" (Linked ID) ile
      // adresler — bu durumda remoteJid rehberdeki hiçbir numarayla eşleşmeyen, uzun, rastgele
      // görünen bir sayı taşıyan bir @lid kimliğidir. Baileys asıl telefon numarasını
      // remoteJidAlt alanında ayrıca verir (resmi WhatsApp uygulaması zaten bunu kullanır);
      // birebir sohbetlerde bunu tercih ediyoruz, yoksa rehberdeki tanıdık biri bile "bilinmeyen
      // gönderen" gibi görünür. Grup sohbetlerinde `from` zaten grubun kendi kimliğidir
      // (katılımcı değil) — webhook `from` alanının anlamını değiştirmemek için dokunmuyoruz.
      let senderJid = msg.key.remoteJid;
      if (!isGroup) {
        senderJid = msg.key.remoteJidAlt || msg.key.remoteJid;
        if (senderJid?.endsWith('@lid') && sock.signalRepository?.lidMapping) {
          try {
            const resolvedPn = await sock.signalRepository.lidMapping.getPNForLID(senderJid);
            if (resolvedPn) senderJid = resolvedPn;
          } catch (e) {}
        }
      }
      const from = senderJid?.replace('@s.whatsapp.net', '').replace('@g.us', '').replace('@lid', '');
      const m = msg.message;
      const text = m?.conversation || m?.extendedTextMessage?.text
        || m?.imageMessage?.caption || m?.videoMessage?.caption || '';
      const msgType = m?.imageMessage ? 'image'
        : m?.videoMessage ? 'video'
        : m?.audioMessage ? 'audio'
        : m?.documentMessage ? 'document'
        : m?.locationMessage ? 'location'
        : m?.contactMessage ? 'contact'
        : m?.stickerMessage ? 'sticker'
        : 'text';

      const payload = {
        event: 'message',
        customer_id: customerId,
        from,
        is_group: isGroup,
        type: msgType,
        message: text,
        timestamp: msg.messageTimestamp,
        message_id: msg.key.id
      };

      waEvents.emit(`message_${customerId}`, payload);

      const customer = db.getCustomerById(customerId);
      if (customer?.webhook_url) fireWebhook(customer.webhook_url, payload);

      // Sohbet geçmişi — yalnızca birebir (grup olmayan) konuşmalar; "rehber" tek kişilik kişilere göre kurulu.
      if (isGroup) return;
      const mediaMsg = m?.imageMessage || m?.videoMessage || m?.audioMessage || m?.documentMessage || m?.stickerMessage;
      let mediaPath = null, mediaMimetype = null;
      if (mediaMsg) {
        mediaMimetype = mediaMsg.mimetype || null;
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: require('pino')({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
          mediaPath = saveMediaBuffer(customerId, buffer, mediaMimetype, m?.documentMessage?.fileName);
        } catch (e) {
          console.error(`⚠️  Medya indirilemedi (müşteri ${customerId}):`, e.message);
        }
      }
      const phone = normalizePhone(from);
      const row = db.addMessage(customerId, phone, 'in', msgType, text || null, mediaPath, mediaMimetype, msg.key.id, 'received');
      db.unarchiveChat(customerId, phone); // Gerçek WhatsApp'ta olduğu gibi: yeni mesaj gelince arşivden kendiliğinden çıkar
      waEvents.emit(`chat_${customerId}_${phone}`, { event: 'message', ...row });

      const contact = db.getContactByPhone(customerId, phone);
      const typeLabel = { image: '📷 Fotoğraf', video: '🎬 Video', audio: '🎤 Sesli mesaj', document: '📄 Belge', location: '📍 Konum', contact: '👤 Kişi', sticker: '🌟 Çıkartma' };
      push.sendToCustomer(customerId, {
        title: contact?.name || phone,
        body: text || typeLabel[msgType] || 'Yeni mesaj',
        url: '/sohbet?token=' + customer?.token,
        unreadCount: db.getTotalUnreadCount(customerId)
      }).catch(() => {});
    });
  });

  function applyMessageStatus(key, status) {
    const jid = key.remoteJidAlt || key.remoteJid;
    const phone = normalizePhone(jid?.replace('@s.whatsapp.net', '').replace('@lid', ''));
    db.updateMessageStatusByWaId(customerId, key.id, status);
    waEvents.emit(`chat_${customerId}_${phone}`, { event: 'status', wa_message_id: key.id, status });

    const customer = db.getCustomerById(customerId);
    if (!customer?.webhook_url) return;
    fireWebhook(customer.webhook_url, {
      event: 'message_status',
      customer_id: customerId,
      message_id: key.id,
      to: phone,
      status
    });
  }

  // Grup/toplu yayın teslim-okundu bilgisi — Baileys bunu YALNIZCA grup/durum sohbetleri için yayınlar.
  sock.ev.on('message-receipt.update', updates => {
    updates.forEach(({ key, receipt }) => {
      const status = receipt?.readTimestamp ? 'read'
        : receipt?.receiptTimestamp ? 'delivered' : 'sent';
      applyMessageStatus(key, status);
    });
  });

  // Birebir (grup olmayan) sohbetlerde teslim/okundu bilgisi message-receipt.update ile DEĞİL,
  // buradan gelir (proto.WebMessageInfo.Status: 2=SERVER_ACK/gönderildi, 3=DELIVERY_ACK/teslim
  // edildi, 4=READ/okundu, 5=PLAYED/dinlendi) — Sohbet ekranındaki ✓/✓✓ tikleri bu olaya bağlı.
  sock.ev.on('messages.update', updates => {
    updates.forEach(({ key, update }) => {
      if (typeof update.status !== 'number' || !key.fromMe) return;
      const statusMap = { 0: 'failed', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' };
      const status = statusMap[update.status];
      if (status) applyMessageStatus(key, status);
    });
  });

  return { status: 'connecting' };
}

async function sendMessage(customerId, to, content) {
  const conn = connections[customerId];
  if (!conn || !conn.socket) throw new Error('WhatsApp bağlı değil');
  if (conn.status === 'disconnected' || conn.status === 'logged_out') {
    throw new Error('WhatsApp bağlantısı kesildi');
  }

  const jid = normalizePhone(to) + '@s.whatsapp.net';
  const msg = typeof content === 'string' ? { text: content } : content;

  // 15 saniye timeout ile gönder
  return await Promise.race([
    conn.socket.sendMessage(jid, msg),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Mesaj gönderme timeout (15s)')), 15000))
  ]);
}

// Sohbet ekranından gönderim — mesajı WhatsApp'a yollar VE geçmişe kaydeder.
async function sendChatMessage(customerId, to, opts) {
  const { type, text, mediaBuffer, mediaMimetype, filename, ptt } = opts;
  const phone = normalizePhone(to);

  let content;
  let finalBuffer = mediaBuffer;
  let finalMimetype = mediaMimetype;

  if (type === 'text') {
    content = { text: text || '' };
  } else if (type === 'image') {
    content = { image: mediaBuffer, caption: text || '' };
  } else if (type === 'video') {
    content = { video: mediaBuffer, caption: text || '' };
  } else if (type === 'audio') {
    let finalPtt = !!ptt;
    // Sesli mesaj (ptt) olarak gönderilecekse WhatsApp gerçek OGG/Opus bekler — tarayıcının
    // ürettiği WEBM'i öyleymiş gibi işaretlemek (yalnızca mimetype yazmak) çalışmaz, mesaj ya
    // gitmez ya da karşı tarafta oynatılamaz. Gerekirse burada gerçekten dönüştürüyoruz.
    if (finalPtt && finalMimetype && !finalMimetype.includes('ogg')) {
      try {
        finalBuffer = await webmToOggOpus(mediaBuffer);
        finalMimetype = 'audio/ogg; codecs=opus';
      } catch (e) {
        console.error(`⚠️  Sesli mesaj OGG'ye dönüştürülemedi (müşteri ${customerId}), normal ses dosyası olarak gönderiliyor:`, e.message);
        finalPtt = false; // ffmpeg yoksa/başarısızsa ptt:true + yanlış kap WhatsApp'ta sessiz kalır
      }
    }
    content = { audio: finalBuffer, mimetype: finalMimetype || 'audio/ogg; codecs=opus', ptt: finalPtt };
  } else if (type === 'document') {
    content = { document: mediaBuffer, fileName: filename || 'dosya', mimetype: mediaMimetype || 'application/octet-stream' };
  } else {
    throw new Error('Desteklenmeyen mesaj tipi');
  }

  const result = await sendMessage(customerId, phone, content);
  const waMessageId = result?.key?.id || null;
  const mediaPath = finalBuffer ? saveMediaBuffer(customerId, finalBuffer, finalMimetype, filename) : null;

  return db.addMessage(customerId, phone, 'out', type, text || null, mediaPath, finalMimetype || null, waMessageId, 'sent');
}

async function disconnectCustomer(customerId) {
  const conn = connections[customerId];
  if (conn?.socket) {
    try { await conn.socket.logout(); } catch(e) {}
    delete connections[customerId];
  }
  const sessionPath = path.join(SESSION_DIR, `customer_${customerId}`);
  fs.rmSync(sessionPath, { recursive: true, force: true });
  db.upsertConnection(customerId, { status: 'disconnected', wa_number: null });
}

function getStatus(customerId) {
  const conn = connections[customerId];
  if (!conn) return { status: 'disconnected' };
  return {
    status: conn.status,
    phone: conn.phone,
    qr_base64: conn.qr_base64,
    pairing_code: conn.pairing_code
  };
}

async function restoreConnections() {
  const customers = db.getCustomers();
  for (const c of customers) {
    if (c.status === 'active') {
      const sessionPath = path.join(SESSION_DIR, `customer_${c.id}`);
      const hasCreds = fs.existsSync(path.join(sessionPath, 'creds.json'));
      if (hasCreds) {
        console.log(`🔄 Müşteri ${c.id} (${c.name}) bağlantısı yenileniyor...`);
        await startConnection(c.id, 'qr').catch(e => console.error(`Bağlantı hatası ${c.id}:`, e.message));
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
}

function getConn(customerId) {
  return connections[customerId]?.socket || null;
}

module.exports = { startConnection, sendMessage, sendChatMessage, disconnectCustomer, getStatus, getConn, waEvents, restoreConnections, normalizePhone };
