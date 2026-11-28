// src/scheduler.js — zamanlanmış toplu gönderimleri arka planda işler.
// Tarayıcı kapansa, telefon uyusa, hatta sunucu yeniden başlasa bile devam etsin diye
// tamamen sunucu içinde, veritabanına kaydedilmiş bir kuyruk üzerinden çalışır
// (bkz. database.js'deki scheduled_jobs tablosu). Ayrı bir servis/cron GEREKMEZ —
// Node süreci her başladığında start() ile kendiliğinden devreye girer.
const fs = require('fs');
const db = require('./database');
const wa = require('./whatsapp');

const CHECK_INTERVAL_MS = 20 * 1000;

function buildContent(job, contact) {
  const payload = JSON.parse(job.payload || '{}');
  const text = (payload.text || '').split('{isim}').join(contact.name);

  if (job.message_type === 'text') return { text };

  if (job.message_type === 'audio' && payload.audioUrl) {
    return { audio: { url: payload.audioUrl }, mimetype: 'audio/mp4', ptt: false };
  }

  if (['image', 'video', 'audio', 'document'].includes(job.message_type)) {
    if (!job.media_path || !fs.existsSync(job.media_path)) throw new Error('Medya dosyası bulunamadı');
    const buffer = fs.readFileSync(job.media_path);
    if (job.message_type === 'image') return { image: buffer, caption: text };
    if (job.message_type === 'video') return { video: buffer, caption: text };
    if (job.message_type === 'audio') return { audio: buffer, mimetype: job.media_mimetype || 'audio/mp4', ptt: !!payload.ptt };
    return { document: buffer, fileName: payload.filename || 'dosya', mimetype: job.media_mimetype || 'application/octet-stream' };
  }

  if (job.message_type === 'location') {
    if (payload.live) {
      return {
        liveLocation: {
          degreesLatitude: payload.latitude, degreesLongitude: payload.longitude,
          accuracyInMeters: 10, speedInMps: 0, degreesClockwiseFromMagneticNorth: 0,
          name: payload.name || '', address: payload.address || ''
        },
        caption: '', jpegThumbnail: null, sequenceNumber: BigInt(0), timeOffset: 0,
        duration: payload.duration_seconds || 3600
      };
    }
    return { location: { degreesLatitude: payload.latitude, degreesLongitude: payload.longitude, name: payload.name || '', address: payload.address || '' } };
  }

  throw new Error('Desteklenmeyen zamanlanmış mesaj tipi: ' + job.message_type);
}

function cleanupMedia(job) {
  if (job.media_path) { try { fs.unlinkSync(job.media_path); } catch (e) {} }
}

const activeJobs = new Set();

async function runJob(job) {
  if (activeJobs.has(job.id)) return; // aynı iş iki kez başlatılmasın
  activeJobs.add(job.id);
  try {
    const contacts = JSON.parse(job.contacts || '[]');
    let sent = job.sent_count || 0;
    let fail = job.fail_count || 0;

    for (let i = job.next_index || 0; i < contacts.length; i++) {
      const fresh = db.getScheduledJob(job.id);
      if (!fresh || fresh.status !== 'running') return; // bu sırada iptal edilmiş

      const contact = contacts[i];
      try {
        const customer = db.getCustomerById(job.customer_id);
        if (!customer || customer.status !== 'active') throw new Error('Hesap aktif değil');
        const allowed = db.checkAndIncrementUsage(job.customer_id, customer.daily_limit);
        if (!allowed) throw new Error('Günlük mesaj limiti doldu');
        const content = buildContent(job, contact);
        await wa.sendMessage(job.customer_id, contact.phone, content);
        db.logMessage(job.customer_id, contact.phone, job.message_type, 'sent');
        sent++;
      } catch (e) {
        fail++;
        db.logMessage(job.customer_id, contact.phone, job.message_type, 'failed', e.message);
      }

      db.updateScheduledJob(job.id, { sent_count: sent, fail_count: fail, next_index: i + 1 });

      const isLast = i === contacts.length - 1;
      if (!isLast) {
        const atBatchBoundary = job.batch_size > 0 && (i + 1) % job.batch_size === 0;
        const waitMs = atBatchBoundary ? job.batch_delay_ms : job.message_delay_ms;
        await new Promise(r => setTimeout(r, waitMs));
      }
    }

    db.updateScheduledJob(job.id, { status: 'completed', finished_at: new Date().toISOString() });
    cleanupMedia(job);
  } catch (e) {
    db.updateScheduledJob(job.id, { status: 'failed', error: e.message, finished_at: new Date().toISOString() });
    cleanupMedia(job);
  } finally {
    activeJobs.delete(job.id);
  }
}

let checking = false;
function checkDue() {
  if (checking) return;
  checking = true;
  try {
    const now = new Date();
    const due = db.getPendingScheduledJobs().filter(j => new Date(j.run_at) <= now);
    for (const job of due) {
      db.updateScheduledJob(job.id, { status: 'running', started_at: new Date().toISOString() });
      runJob(db.getScheduledJob(job.id));
    }
  } finally {
    checking = false;
  }
}

// Sunucu kapanırken/çökerken 'running' durumda kalmış işler (yarıda kesilmiş) olabilir —
// next_index sayesinde kaldığı yerden devam eder, baştan başlamaz.
function resumeInterrupted() {
  for (const job of db.getRunningScheduledJobs()) runJob(job);
}

function start() {
  resumeInterrupted();
  checkDue();
  setInterval(checkDue, CHECK_INTERVAL_MS);
}

module.exports = { start };
