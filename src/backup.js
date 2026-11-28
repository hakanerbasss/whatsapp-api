// src/backup.js — otomatik yedekleme: veritabanı + WhatsApp oturum dosyaları.
// Kasıtlı olarak data/media ve data/scheduled_media HARİÇ tutulur — bunlar zamanla çok
// büyüyebilir ve her yedekte (saklanan son N yedek × bu boyut) diski hızla doldurabilir.
// Kaybedilmesi gerçekten pahalı olan iki şey yedeklenir: müşteri/mesaj/ayar verisi (veritabanı)
// ve WhatsApp oturumları (olmazsa her müşteri telefonunu yeniden eşleştirmek zorunda kalır).
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const db = require('./database');

const DATA_DIR = path.join(__dirname, '../data');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const FILENAME_RE = /^backup-\d{8}-\d{6}\.tar\.gz$/;

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} çıkış kodu ${code}: ${stderr.slice(-300)}`)));
  });
}

async function createBackup() {
  const ts = timestamp();
  const tmpDir = path.join(BACKUP_DIR, `_tmp_${ts}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    // Veritabanı: canlı dosyayı kopyalamak yerine bellekteki tutarlı anlık görüntüyü yazıyoruz
    // (aynı anda süren bir yazmayla yarışma riski olmadan).
    fs.writeFileSync(path.join(tmpDir, 'database.bin'), db.exportSnapshot());
    if (fs.existsSync(SESSION_DIR)) {
      fs.cpSync(SESSION_DIR, path.join(tmpDir, 'sessions'), { recursive: true });
    }
    const filename = `backup-${ts}.tar.gz`;
    await run('tar', ['-czf', path.join(BACKUP_DIR, filename), '-C', tmpDir, '.']);
    return filename;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function listBackups() {
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => FILENAME_RE.test(f))
    .map(f => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, size: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.filename.localeCompare(a.filename));
}

function pruneOldBackups(retention) {
  const backups = listBackups();
  for (const b of backups.slice(retention)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, b.filename)); } catch (e) {}
  }
}

// filename her zaman FILENAME_RE'ye karşı doğrulanmalı — admin uçlarında path traversal
// önlemek için çağıranlar bunu kontrol eder, burada da tekrar kontrol ediyoruz.
function getBackupPath(filename) {
  if (!FILENAME_RE.test(filename)) return null;
  const full = path.join(BACKUP_DIR, filename);
  return fs.existsSync(full) ? full : null;
}

function deleteBackup(filename) {
  const full = getBackupPath(filename);
  if (!full) return false;
  fs.unlinkSync(full);
  return true;
}

async function runScheduledBackup() {
  try {
    if (db.getSetting('backup_enabled') === '0') return;
    const retention = parseInt(db.getSetting('backup_retention')) || 7;
    await createBackup();
    pruneOldBackups(retention);
  } catch (e) {
    console.error('⚠️  Otomatik yedekleme hatası:', e.message);
  }
}

function start() {
  // Sunucu her başladığında bir kez, sonra 24 saatte bir.
  setTimeout(runScheduledBackup, 60 * 1000);
  setInterval(runScheduledBackup, 24 * 60 * 60 * 1000);
}

module.exports = { createBackup, listBackups, pruneOldBackups, getBackupPath, deleteBackup, start };
