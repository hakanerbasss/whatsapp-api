// panel/pwa-install.js — Uygulamayı ana ekrana/masaüstüne kısayol olarak eklemeyi teşvik eder.
// Tüm sayfalarda ortak: zaten kurulmuşsa (standalone modda açılıyorsa) hiçbir şey göstermez.
// Değilse hem her zaman erişilebilir küçük bir "indir" ikonu hem de (kalıcı olarak
// kapatılmadıysa) sayfa her açıldığında kendiliğinden beliren bir bildirim kartı sunar.
(function () {
  const DISMISS_KEY = 'wa_pwa_prompt_dismissed';
  const INSTALLED_KEY = 'wa_pwa_installed';

  function isStandalone() {
    try { if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true; } catch (e) {}
    return window.navigator.standalone === true; // iOS Safari "Ana Ekrana Ekle" ile açılmış
  }

  function isInstalled() {
    return isStandalone() || localStorage.getItem(INSTALLED_KEY) === '1';
  }

  function isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  }

  let deferredPrompt = null;
  let bannerShown = false;

  const DOWNLOAD_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';
  const CLOSE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

  function injectStyle() {
    if (document.getElementById('pwa-install-style')) return;
    const style = document.createElement('style');
    style.id = 'pwa-install-style';
    style.textContent = `
      .pwa-install-banner{position:fixed;left:12px;right:12px;z-index:9998;background:var(--card,#111820);color:var(--text,#e8f4f8);border:1px solid var(--accent,#25D366);border-radius:14px;padding:14px 34px 14px 14px;box-shadow:0 8px 24px rgba(0,0,0,.35);display:flex;align-items:center;gap:10px;max-width:420px;margin:0 auto;transform:translateY(130%);opacity:0;transition:transform .3s ease,opacity .3s ease;}
      .pwa-install-banner.show{transform:translateY(0);opacity:1;}
      .pwa-install-banner-icon{flex-shrink:0;width:36px;height:36px;border-radius:10px;background:rgba(37,211,102,.15);color:var(--accent,#25D366);display:flex;align-items:center;justify-content:center;}
      .pwa-install-banner-text{flex:1;font-size:12.5px;line-height:1.4;}
      .pwa-install-banner-actions{display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex-shrink:0;}
      .pwa-install-banner-btn{padding:7px 12px;border-radius:8px;border:none;background:var(--accent,#25D366);color:#000;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;}
      .pwa-install-banner-dismiss{background:none;border:none;color:var(--muted,#4a6070);font-size:10.5px;cursor:pointer;text-decoration:underline;padding:2px;white-space:nowrap;}
      .pwa-install-banner-close{position:absolute;top:8px;right:8px;background:none;border:none;color:var(--muted,#4a6070);cursor:pointer;padding:3px;display:flex;}
    `;
    document.head.appendChild(style);
  }

  function updateButton() {
    const btn = document.getElementById('pwa-install-btn');
    if (!btn) return;
    btn.style.display = (!isInstalled() && (deferredPrompt || isIos())) ? 'inline-flex' : 'none';
  }

  function showInstructions() {
    const msg = isIos()
      ? 'Bu tarayıcıda otomatik kurulum yok: alttaki Paylaş (□↑) simgesine dokunun, sonra "Ana Ekrana Ekle"yi seçin.'
      : 'Tarayıcınızın adres çubuğundaki menüsünden "Yükle" ya da "Ana ekrana ekle" seçeneğini kullanın.';
    if (window.uiToast) uiToast(msg, 'info'); else alert(msg);
  }

  function hideBanner() {
    const el = document.getElementById('pwa-install-banner');
    if (!el) return;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }

  async function triggerInstall() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice.catch(() => null);
      deferredPrompt = null;
      updateButton();
      if (choice && choice.outcome === 'accepted') localStorage.setItem(INSTALLED_KEY, '1');
      hideBanner();
      return;
    }
    showInstructions();
  }

  function showBanner() {
    if (bannerShown || isInstalled() || localStorage.getItem(DISMISS_KEY) === '1') return;
    if (document.getElementById('pwa-install-banner')) return;
    bannerShown = true;
    injectStyle();

    // Sabit alt gezinme çubuğu varsa (musteri/toplu.html) onun üzerine binmesin diye yüksekliği
    // kadar yukarıdan başlasın; yoksa (admin paneli gibi) ekranın altına yakın dursun.
    const nav = document.querySelector('.bottom-nav');
    const navHeight = nav ? nav.getBoundingClientRect().height : 0;

    const el = document.createElement('div');
    el.className = 'pwa-install-banner';
    el.id = 'pwa-install-banner';
    el.style.bottom = (navHeight + 12) + 'px';
    el.innerHTML = `
      <button class="pwa-install-banner-close" aria-label="Kapat">${CLOSE_ICON}</button>
      <div class="pwa-install-banner-icon">${DOWNLOAD_ICON}</div>
      <div class="pwa-install-banner-text">Daha hızlı erişim için uygulamayı ana ekranınıza ya da masaüstünüze ekleyin.</div>
      <div class="pwa-install-banner-actions">
        <button class="pwa-install-banner-btn">İndir</button>
        <button class="pwa-install-banner-dismiss">Bir daha gösterme</button>
      </div>
    `;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    el.querySelector('.pwa-install-banner-btn').onclick = () => triggerInstall();
    el.querySelector('.pwa-install-banner-dismiss').onclick = () => { localStorage.setItem(DISMISS_KEY, '1'); hideBanner(); };
    el.querySelector('.pwa-install-banner-close').onclick = hideBanner;
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    updateButton();
  });

  window.addEventListener('appinstalled', () => {
    localStorage.setItem(INSTALLED_KEY, '1');
    deferredPrompt = null;
    updateButton();
    hideBanner();
  });

  function init() {
    const btn = document.getElementById('pwa-install-btn');
    if (btn) btn.addEventListener('click', triggerInstall);
    updateButton();
    if (isInstalled()) return;
    // Sayfa her açıldığında, kurulu değilse ve kalıcı olarak kapatılmadıysa (kısa bir
    // gecikmeyle, sayfa yüklenir yüklenmez karşılamasın diye) bildirim kartını göster.
    setTimeout(showBanner, 1800);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
