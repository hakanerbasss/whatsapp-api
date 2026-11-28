# WhatsApp API

**v1.0.0** · Geliştirici: Hakan Erbaş (iletişim bilgileri en altta)

Kendi sunucunuzda, kendi verinizle çalışan WhatsApp API ve toplu mesaj paneli. Müşteri yönetimi, mesaj limiti, kara liste ve toplu mesaj gönderimi dahil.

## Kurulum — tek komut

Kendi (Ubuntu) sunucunuzda, root olarak:

```bash
curl -fsSL https://raw.githubusercontent.com/hakanerbasss/whatsapp-api/main/install.sh | bash
```

Bu kadar. Betik Node.js, pm2 ve uygulamayı kendi başına kurar, başlatır. Bittiğinde ekranda bir adres verir (`http://SUNUCU_IP:PORT`) — o adrese gidip kullanıcı adı/şifre belirleyerek kurulumu tamamlarsınız.

### Alan adınız varsa (önerilir)

Alan adınızın DNS A kaydını önce sunucunuzun IP adresine çevirin, sonra:

```bash
DOMAIN=wa.siteniz.com SSL_EMAIL=siz@eposta.com curl -fsSL https://raw.githubusercontent.com/hakanerbasss/whatsapp-api/main/install.sh | bash
```

Bu durumda betik ayrıca nginx kurar ve Let's Encrypt ile ücretsiz, otomatik HTTPS sertifikası alır. Cloudflare ya da başka bir servise ihtiyaç yoktur — sertifika doğrudan sunucuda, kendi başına alınır.

### Sunucuda başka bir proje/site varsa ne olur?

Hiçbir şeyi bozmaz. Kurulum betiği:

- Node.js'i **sisteme değil**, yalnızca bu uygulamaya özel, izole bir ortama (`nvm`) kurar — sunucudaki başka bir Node projesinin sürümüne dokunmaz.
- Port'u sabit varsaymaz, boş bir port otomatik bulur.
- nginx kullanılıyorsa yalnızca **kendi, ayrı bir dosyasını** ekler; var olan hiçbir sitenin ayarına dokunmaz ve nginx'i yeniden başlatmak yerine **reload** eder (diğer siteler kesintisiz çalışmaya devam eder).
- pm2'de kendine özel bir isimle (`whatsapp-api`) çalışır, başka bir pm2 sürecine dokunmaz.
- Güvenlik duvarı (ufw) açıksa yalnızca eksik portu ekler, var olan kuralları silmez.
- Yalnızca kendi klasörüne (`~/whatsapp-api`) yazar.

## Güncelleme

Aynı komutu tekrar çalıştırmanız yeterli — kodu günceller, ayarlarınızı (`.env`, veritabanı) korur:

```bash
bash ~/whatsapp-api/install.sh
```

## Yararlı komutlar

```bash
pm2 logs whatsapp-api      # loglar
pm2 restart whatsapp-api   # yeniden başlat
pm2 status                 # durum
node ~/whatsapp-api/reset-password.js   # admin şifresini sıfırla
```

## Dosya yapısı

```
~/whatsapp-api/
├── src/            # Sunucu kodu (Express + Baileys)
├── panel/          # Admin ve müşteri paneli (web arayüzü)
├── data/           # Veritabanı (database.bin) — yedekleyin
├── logs/           # Sunucu logları
└── .env            # PORT ve JWT_SECRET (kurulumda otomatik üretilir)
```

> **Önemli:** `data/database.bin` dosyası tüm müşteri verilerini ve WhatsApp oturumlarını tutar. Düzenli yedekleyin.

## Sorun giderme

**Port zaten kullanılıyor / kurulum başka bir şeyi bozdu sandınız:** Betik boş bir port otomatik seçer ve var olan hiçbir dosyaya dokunmaz; `pm2 status` ve `nginx -t` ile mevcut durumu kontrol edebilirsiniz.

**WhatsApp bağlantısı kopuyor:** Panelden tekrar QR okutun ya da telefon numarasıyla eşleştirin.

**Admin şifresini unuttunuz:** Önce servisi durdurun, sonra sıfırlayın, sonra tekrar başlatın (çalışırken sıfırlarsanız birkaç saniye içinde servisin kendi otomatik kaydı eski şifreyi geri yazar):
```bash
pm2 stop whatsapp-api
cd ~/whatsapp-api && node reset-password.js
pm2 start whatsapp-api
```

## Ne yapmaz

Bu bir bilgilendirme/otomasyon aracıdır; WhatsApp'ın resmî bir ürünü değildir, resmî API'si yerine geçmez. Kendi sorumluluğunuzda, kendi sunucunuzda çalışır — veriler yalnızca sizin sunucunuzda tutulur.

## İletişim / Geliştirici

**Hakan Erbaş** — İstanbul, Türkiye

- WhatsApp: [+90 553 093 03 25](https://wa.me/905530930325)
- E-posta: [wizaicorp@gmail.com](mailto:wizaicorp@gmail.com) · [hakanerbasss@gmail.com](mailto:hakanerbasss@gmail.com)

Kurulumla ilgili bir sorun yaşarsanız ya da özellik önerisi/talebiniz varsa yukarıdaki kanallardan ulaşabilirsiniz. Uygulama içinde aynı bilgiler **Hesabım → Geliştirici** bölümünde de yer alır.
