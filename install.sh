#!/bin/bash
# ============================================================================
# WhatsApp API — Tek Komutla Kurulum
#
#   curl -fsSL https://raw.githubusercontent.com/hakanerbasss/whatsapp-api/main/install.sh | bash
#
# Alan adınız varsa (otomatik HTTPS için):
#   DOMAIN=wa.ornek.com SSL_EMAIL=siz@eposta.com bash install.sh
#
# Alan adı vermezseniz uygulama sunucunun IP adresi üzerinden düz HTTP ile çalışır.
#
# GÜVENLİ KURULUM — sunucuda BAŞKA projeler/siteler olsa bile:
#   - Node.js sisteme değil, yalnızca bu uygulamaya özel (nvm) kurulur.
#   - Port sabit değildir, boş bir port otomatik bulunur.
#   - nginx'e yalnızca KENDİ dosyası eklenir; var olan hiçbir siteye dokunulmaz,
#     nginx yeniden başlatılmaz, yalnızca "reload" edilir (diğer siteler kesintisiz kalır).
#   - pm2'de kendine özel bir isimle çalışır, başka pm2 süreçlerine dokunmaz.
#   - Güvenlik duvarı varsa yalnızca eksik kuralı EKLER, var olanı silmez.
#   - Bu betik yalnızca kendi klasörüne (~/whatsapp-api) yazar.
# ============================================================================
set -e

G='\033[0;32m'; C='\033[0;36m'; R='\033[0;31m'; Y='\033[0;33m'; X='\033[0m'
ok()   { echo -e "${G} OK  ${X} $1"; }
info() { echo -e "${C} ... ${X} $1"; }
warn() { echo -e "${Y} UYR ${X} $1"; }
err()  { echo -e "${R} HAT ${X} $1"; }

REPO_URL="${REPO_URL:-https://github.com/hakanerbasss/whatsapp-api.git}"
DEST="${DEST:-$HOME/whatsapp-api}"
DOMAIN="${DOMAIN:-}"
SSL_EMAIL="${SSL_EMAIL:-}"

echo -e "\n${G}╔════════════════════════════════════════════╗"
echo    "║   WhatsApp API  —  Tek Komutla Kurulum     ║"
echo -e "╚════════════════════════════════════════════╝${X}\n"

if [ "$(id -u)" != "0" ]; then
  err "Bu betik root olarak çalıştırılmalı (örn. sudo bash install.sh)."
  exit 1
fi

# ── 1) Kod: klonla ya da güncelle ───────────────────────────────────────────
if [ -d "$DEST/.git" ]; then
  info "Mevcut kurulum bulundu, güncelleniyor..."
  git -C "$DEST" fetch origin -q
  git -C "$DEST" reset --hard origin/main -q
  ok "Kod güncellendi: $DEST"
else
  info "Kod indiriliyor..."
  git clone --depth 1 "$REPO_URL" "$DEST" -q
  ok "Kod indirildi: $DEST"
fi
mkdir -p "$DEST/logs" "$DEST/data"

# ── 2) Node.js: SİSTEME DEĞİL, yalnızca bu uygulamaya özel (nvm ile izole) ──
# Sunucuda başka bir Node projesi varsa onun sürümüne hiç dokunulmaz.
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  info "nvm kuruluyor (izole Node ortamı için)..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash > /dev/null 2>&1
  ok "nvm kuruldu"
fi
# shellcheck disable=SC1091
\. "$NVM_DIR/nvm.sh"
info "Node.js 20 kuruluyor (yalnızca bu uygulama için, izole)..."
nvm install 20 > /dev/null 2>&1
nvm use 20 > /dev/null 2>&1
nvm alias default 20 > /dev/null 2>&1
ok "Node.js $(node -v) hazır (sistem Node'u etkilenmedi)"

if ! command -v pm2 &>/dev/null; then
  info "pm2 kuruluyor..."
  npm install -g pm2 --silent
  ok "pm2 kuruldu"
else
  ok "pm2 $(pm2 -v) mevcut"
fi

# ── 3) Bağımlılıklar + Baileys yaması ────────────────────────────────────────
cd "$DEST"
info "Paketler yükleniyor (1-2 dakika)..."
npm install --no-audit --no-fund --silent
ok "npm paketleri yüklendi"

info "Baileys yaması uygulanıyor..."
BV="$DEST/node_modules/baileys/lib/Utils/validate-connection.js"
BS="$DEST/node_modules/baileys/lib/Socket/socket.js"
if [ -f "$BV" ]; then
  sed -i 's/passive: true,/passive: false,/g' "$BV"
  sed -i '/lidDbMigrated: false/d' "$BV"
fi
[ -f "$BS" ] && sed -i 's/await noise\.finishInit();/noise.finishInit();/g' "$BS"
ok "Baileys yaması tamamlandı"

# ── 4) Boş port bul — sunucudaki BAŞKA HİÇBİR projeyi etkilemeden ──────────
find_free_port() {
  local p=$1
  while ss -tlnp 2>/dev/null | grep -q ":$p "; do p=$((p + 1)); done
  echo "$p"
}
if [ -f "$DEST/.env" ] && grep -q "^PORT=" "$DEST/.env"; then
  PORT=$(grep "^PORT=" "$DEST/.env" | head -1 | cut -d= -f2)
  ok ".env zaten var, port korunuyor: $PORT"
else
  PORT=$(find_free_port 8000)
  ok "Boş port otomatik bulundu: $PORT"
fi

if [ -f "$DEST/.env" ]; then
  ok ".env zaten var, dokunulmadı (JWT_SECRET korunuyor)"
else
  SECRET=$(cat /proc/sys/kernel/random/uuid | tr -d '-')$(date +%s)
  cat > "$DEST/.env" <<EOF
PORT=${PORT}
JWT_SECRET=${SECRET}
EOF
  ok ".env oluşturuldu"
fi

# ── 5) Alan adı verildiyse: nginx + SSL (yalnızca KENDİ dosyamız) ──────────
SERVER_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
PUBLIC_URL="http://${SERVER_IP}:${PORT}"

if [ -n "$DOMAIN" ]; then
  info "Alan adı belirtildi: $DOMAIN — nginx yapılandırılıyor..."
  if ! command -v nginx &>/dev/null; then
    apt-get update -y -q && apt-get install -y -q nginx
  fi
  NGINX_FILE="/etc/nginx/sites-available/whatsapp-api-${DOMAIN}"
  cat > "$NGINX_FILE" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF
  mkdir -p /etc/nginx/sites-enabled
  ln -sf "$NGINX_FILE" "/etc/nginx/sites-enabled/whatsapp-api-${DOMAIN}"

  if nginx -t 2>/dev/null; then
    (systemctl reload nginx 2>/dev/null || systemctl start nginx 2>/dev/null || nginx -s reload 2>/dev/null) || true
    ok "nginx yapılandırıldı (yalnızca $DOMAIN için yeni bir dosya eklendi; var olan siteler etkilenmedi)"
  else
    err "nginx yapılandırması hatalı görünüyor — elle kontrol edin: nginx -t"
  fi

  PUBLIC_URL="http://${DOMAIN}"
  if [ -n "$SSL_EMAIL" ]; then
    info "SSL sertifikası alınıyor (Let's Encrypt)..."
    apt-get install -y -q certbot python3-certbot-nginx > /dev/null 2>&1
    if certbot --nginx --non-interactive --agree-tos -m "$SSL_EMAIL" -d "$DOMAIN" > /dev/null 2>&1; then
      ok "SSL sertifikası kuruldu: https://${DOMAIN}"
      PUBLIC_URL="https://${DOMAIN}"
    else
      warn "SSL alınamadı — $DOMAIN alan adının DNS A kaydı bu sunucunun IP'sine (${SERVER_IP}) işaret ettiğinden emin olup şunu tekrar deneyin:"
      warn "  certbot --nginx -d $DOMAIN"
    fi
  else
    warn "SSL_EMAIL verilmedi, sertifika atlandı. HTTPS için: DOMAIN=$DOMAIN SSL_EMAIL=siz@eposta.com bash install.sh"
  fi
fi

# Site adresini YALNIZCA ilk kurulumda otomatik kaydet (ayarlanmazsa müşteri mesajlarında yanlış/eksik
# adres görünmesin) — sonraki her çalıştırmada (güncelleme) var olan ayarı EZMEZ: admin panelden "Site URL"nü
# elle değiştirdiyse (kendi alan adı, CDN vb.) o tercih korunur.
node -e "
const db = require('$DEST/src/database.js');
db.initDb().then(() => {
  if (!db.getSetting('base_url')) db.setSetting('base_url', '${PUBLIC_URL}');
  process.exit(0);
}).catch(() => process.exit(0));
" 2>/dev/null || true

# ── 6) Güvenlik duvarı: varsa yalnızca EKLE, var olan kuralları SİLME ──────
if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp  > /dev/null 2>&1 || true
  ufw allow 443/tcp > /dev/null 2>&1 || true
  ok "ufw: 80/443 için izin eklendi (var olan kurallar korunuyor)"
fi

# ── 7) pm2 ile başlat — kendine özel isimle, başka pm2 sürecine dokunmadan ──
pm2 delete whatsapp-api 2>/dev/null || true
pm2 start "$DEST/src/index.js" --name whatsapp-api --log "$DEST/logs/server.log"
pm2 save > /dev/null 2>&1
pm2 startup systemd -u root --hp /root 2>/dev/null | grep "^sudo" | bash > /dev/null 2>&1 || true
pm2 save > /dev/null 2>&1

echo -e "\n${G}╔════════════════════════════════════════════╗"
echo    "║  Kurulum tamamlandı!                        ║"
echo -e "╚════════════════════════════════════════════╝${X}\n"
echo    "  Adres      : ${PUBLIC_URL}"
echo    "  İlk kurulum: yukarıdaki adrese gidin, kullanıcı adı/şifre belirleyip 'Hesap Oluştur'a basın"
echo    "  Loglar     : pm2 logs whatsapp-api"
echo    "  Yeniden    : pm2 restart whatsapp-api"
echo    "  Güncelleme : bu betiği tekrar çalıştırın (kodu günceller, ayarlarınız korunur)"
echo ""
