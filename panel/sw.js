const CACHE = 'wa-panel-v5';
// HTML sayfaları artık burada YOK — bkz. aşağıdaki fetch yorumu. Yalnızca gerçek statik
// varlıklar önbelleğe alınır.
const SHELL = ['/manifest.json', '/manifest-admin.json', '/icons/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Sayfa gezintileri (HTML — /, /musteri, /toplu, /sohbet) HİÇBİR ZAMAN önbellekten
  // dönmesin, her zaman doğrudan sunucudan gelsin. Bu araç zaten canlı bir WhatsApp
  // bağlantısı gerektiriyor, "çevrimdışı kabuk" göstermenin faydası şuna değmiyor: önceki
  // "önce önbellek" stratejisi bir düzeltmenin telefona HİÇ ulaşmamasına, uygulamayı kapatıp
  // açsanız bile eski/bozuk sürümün gösterilmeye devam etmesine yol açtı — teşhisi çok zor,
  // "düzelttim ama hâlâ bozuk" türünden hatalar.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request));
    return;
  }

  // Yalnızca ikon/manifest gibi gerçek statik varlıklar için: önce ağdan dener, yalnızca
  // çevrimdışıyken önbelleğe düşer.
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
