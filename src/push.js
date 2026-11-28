// src/push.js — Web Push bildirimleri. Ayrı bir servis/sunucu GEREKMEZ; standart Web Push
// protokolü üzerinden (VAPID anahtarlarıyla) doğrudan tarayıcının/OS'un push servisine gönderilir.
const webpush = require('web-push');
const db = require('./database');

let ready = false;

function ensureVapidKeys() {
  let publicKey = db.getSetting('vapid_public_key');
  let privateKey = db.getSetting('vapid_private_key');
  if (!publicKey || !privateKey) {
    const keys = webpush.generateVAPIDKeys();
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    db.setSetting('vapid_public_key', publicKey);
    db.setSetting('vapid_private_key', privateKey);
    console.log('🔑 Push bildirimleri için yeni VAPID anahtarı üretildi.');
  }
  webpush.setVapidDetails('mailto:destek@whatsapp-api.local', publicKey, privateKey);
  ready = true;
}

function getPublicKey() {
  if (!ready) ensureVapidKeys();
  return db.getSetting('vapid_public_key');
}

// Tek bir müşterinin kayıtlı TÜM cihazlarına (birden fazla tarayıcı/telefon olabilir) gönderir.
// Geçersiz/süresi dolmuş abonelikler (404/410) sessizce veritabanından silinir.
async function sendToCustomer(customerId, payload) {
  if (!ready) ensureVapidKeys();
  const subs = db.getPushSubscriptions(customerId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body
      );
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.removePushSubscription(sub.endpoint);
      } else {
        console.error(`⚠️  Push gönderilemedi (müşteri ${customerId}):`, e.message);
      }
    }
  }));
}

module.exports = { ensureVapidKeys, getPublicKey, sendToCustomer };
