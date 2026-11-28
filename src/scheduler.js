// src/scheduler.js — zamanlanmış toplu gönderimleri arka planda işler.
// Tarayıcı kapansa, telefon uyusa, hatta sunucu yeniden başlasa bile devam etsin diye
// tamamen sunucu içinde, veritabanına kaydedilmiş bir kuyruk üzerinden çalışır
// (bkz. database.js'deki scheduled_jobs tablosu). Ayrı bir servis/cron GEREKMEZ —
// Node süreci her başladığında start() ile kendiliğinden devreye girer.
const fs = require('fs');
const db = require('./database');
const wa = require('./whatsapp');
const push = require('./push');

const CHECK_INTERVAL_MS = 20 * 1000;

function buildContent(job, contact) {
  const payload = JSON.parse(job.payload || '{}');
  const text = (payload.text || '').split('{isim}').join(contact.name);
  // Resim/video altyazısı toplu.html'de ayrı bir "caption" alanı olarak gönderiliyor
  // (metin mesajındaki "text" alanından farklı) — buradan okunmazsa altyazı sessizce kaybolur.
  const caption = (payload.caption || '').split('{isim}').join(contact.name);

  if (job.message_type === 'text') return { text };

  if (job.message_type === 'audio' && payload.audioUrl) {
    return { audio: { url: payload.audioUrl }, mimetype: 'audio/mp4', ptt: false };
  }

  if (['image', 'video', 'audio', 'document'].includes(job.message_type)) {
    if (!job.media_path || !fs.existsSync(job.media_path)) throw new Error('Medya dosyası bulunamadı');
    const buffer = fs.readFileSync(job.media_path);
    if (job.message_type === 'image') return { image: buffer, caption };
    if (job.message_type === 'video') return { video: buffer, caption };
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

// Periyodik (tekrarlanan) işler için bir sonraki çalışma zamanını hesaplar.
// recurrence: { type: 'daily'|'weekly'|'monthly', hour, minute, dayOfWeek?, dayOfMonth? }
// Takvim bileşenleriyle (setDate/setHours) ilerletiyoruz, epoch-ms toplamıyla değil —
// böylece yaz saati geçişlerinde bile aynı yerel saat korunur (örn. "her pazartesi 02:00").
function stepRecurrenceOnce(recurrence, from) {
  const next = new Date(from);
  if (recurrence.type === 'daily') {
    next.setDate(next.getDate() + 1);
    next.setHours(recurrence.hour, recurrence.minute, 0, 0);
    return next;
  }
  if (recurrence.type === 'weekly') {
    next.setDate(next.getDate() + 7);
    next.setHours(recurrence.hour, recurrence.minute, 0, 0);
    return next;
  }
  if (recurrence.type === 'monthly') {
    const firstOfNextMonth = new Date(next.getFullYear(), next.getMonth() + 1, 1);
    const lastDayOfThatMonth = new Date(firstOfNextMonth.getFullYear(), firstOfNextMonth.getMonth() + 1, 0).getDate();
    firstOfNextMonth.setDate(Math.min(recurrence.dayOfMonth, lastDayOfThatMonth));
    firstOfNextMonth.setHours(recurrence.hour, recurrence.minute, 0, 0);
    return firstOfNextMonth;
  }
  throw new Error('Geçersiz tekrar tipi: ' + recurrence.type);
}

// Sunucu uzun süre kapalı kalmışsa (örn. birkaç gün) kaçırılan periyotları art arda
// göndermesin diye, bulunduğumuz andan sonraki ilk uygun zamana kadar ileri sarıyoruz.
function computeNextRun(recurrence, fromDate) {
  let next = stepRecurrenceOnce(recurrence, fromDate);
  const now = new Date();
  // Günlük tekrarda sunucu yıllarca kapalı kalsa bile geleceğe ulaşabilsin diye üst sınır
  // yüksek tutuldu (basit tarih matematiği olduğu için 20000 adım bile milisaniyeler sürer).
  let guard = 0;
  while (next <= now && guard < 20000) { next = stepRecurrenceOnce(recurrence, next); guard++; }
  return next;
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

    finishCycle(job, { sent, fail });
  } catch (e) {
    finishCycle(job, { error: e.message });
  } finally {
    activeJobs.delete(job.id);
  }
}

// Müşteri "zamanlanmış/periyodik gönderim bildirimleri"ni açtıysa, bir döngü bitince
// (başarılı ya da başarısız) ayrıca push bildirimi atar — ana "bildirimleri aç" anahtarından
// bağımsız, kendi tercihi (bkz. POST /api/notify-prefs). sendToCustomer zaten abonelik
// yoksa sessizce no-op olduğundan ayrıca kontrol etmeye gerek yok.
function notifyJobOutcome(job, recurrence, { sent, fail, error }) {
  const customer = db.getCustomerById(job.customer_id);
  if (!customer || !customer.notify_scheduled) return;
  const url = '/toplu?token=' + customer.token;
  // Medya eksikliği, geçersiz numara gibi kişi bazlı hatalar döngünün kendisini kesmiyor
  // (fail_count'a yazılıp devam ediyor) — o yüzden "herkese gönderilemedi" durumunu da
  // gerçek bir hata gibi ele alıyoruz, "0 kişiye gönderildi" demek yanıltıcı olurdu.
  const allFailed = !error && (sent || 0) === 0 && (fail || 0) > 0;
  let title, body;
  if (error) {
    title = recurrence ? 'Periyodik mesaj gönderiminde hata' : 'Zamanlanmış mesaj gönderilemedi';
    body = error + (recurrence ? ' — bir sonraki periyotta tekrar denenecek.' : '');
  } else if (allFailed) {
    title = 'Zamanlanmış mesaj gönderilemedi';
    body = `${fail} kişiye gönderilemedi — kişi listesini ve medya dosyasını kontrol edin.`;
  } else {
    title = recurrence ? 'Periyodik mesaj gönderildi' : 'Zamanlanmış mesaj gönderildi';
    body = `${sent || 0} kişiye gönderildi` + (fail ? `, ${fail} başarısız` : '');
  }
  push.sendToCustomer(job.customer_id, { title, body, url }).catch(() => {});
}

// Bir döngü bitince: tek seferlikse işi 'completed'/'failed' olarak kapatır ve medyayı siler.
// Periyodikse bir sonraki çalışma zamanını hesaplayıp işi 'pending'e döndürür (medya SİLİNMEZ —
// bir sonraki periyotta da lazım) ve toplam gönderim sayaçlarını biriktirir.
function finishCycle(job, { sent, fail, error } = {}) {
  const recurrence = job.recurrence ? JSON.parse(job.recurrence) : null;
  const now = new Date().toISOString();
  notifyJobOutcome(job, recurrence, { sent, fail, error });

  if (!recurrence) {
    db.updateScheduledJob(job.id, error
      ? { status: 'failed', error, finished_at: now }
      : { status: 'completed', finished_at: now });
    cleanupMedia(job);
    return;
  }

  const nextRun = computeNextRun(recurrence, new Date(job.run_at));
  db.updateScheduledJob(job.id, {
    status: 'pending',
    run_at: nextRun.toISOString(),
    next_index: 0,
    sent_count: 0,
    fail_count: 0,
    total_sent_count: (job.total_sent_count || 0) + (sent || 0),
    total_fail_count: (job.total_fail_count || 0) + (fail || 0),
    started_at: null,
    finished_at: now,
    error: error || null
  });
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
