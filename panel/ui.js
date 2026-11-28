// panel/ui.js — tarayıcının yerli alert()/confirm()/prompt() diyalogları güvenlik gereği
// (kimlik avını önlemek için) her zaman site adresini ("wa.site.com diyor ki...") başlıkta
// gösterir — bu CSS ile kaldırılamaz, tarayıcının kendi kararıdır. Bunun yerine uygulamanın
// kendi temasıyla (açık/koyu, mevcut CSS değişkenleriyle) uyumlu, markasız kendi diyaloglarımız.
(function () {
  function ensureRoot() {
    let root = document.getElementById('ui-dialog-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'ui-dialog-root';
      document.body.appendChild(root);
    }
    return root;
  }

  function injectStyle() {
    if (document.getElementById('ui-dialog-style')) return;
    const style = document.createElement('style');
    style.id = 'ui-dialog-style';
    style.textContent = `
      #ui-dialog-root{position:fixed;inset:0;pointer-events:none;z-index:9999;}
      .ui-toast-wrap{position:fixed;top:0;left:0;right:0;display:flex;flex-direction:column;align-items:center;padding-top:12px;gap:8px;pointer-events:none;}
      .ui-toast{pointer-events:auto;max-width:360px;width:calc(100% - 32px);background:var(--card,#111820);color:var(--text,#e8f4f8);border:1px solid var(--border,#1e2733);border-radius:12px;padding:12px 16px;font-size:13px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,.3);display:flex;align-items:center;gap:10px;transform:translateY(-16px);opacity:0;transition:transform .25s ease,opacity .25s ease;cursor:pointer;}
      .ui-toast.show{transform:translateY(0);opacity:1;}
      .ui-toast.ok{border-color:var(--accent,#25D366);}
      .ui-toast.err{border-color:var(--red,#ff4444);}
      .ui-toast-icon{flex-shrink:0;display:flex;}
      .ui-toast.ok .ui-toast-icon{color:var(--accent,#25D366);}
      .ui-toast.err .ui-toast-icon{color:var(--red,#ff4444);}
      .ui-toast.info .ui-toast-icon{color:var(--accent2,#00d4ff);}
      .ui-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:20px;pointer-events:auto;opacity:0;transition:opacity .2s ease;}
      .ui-modal-backdrop.show{opacity:1;}
      .ui-modal{background:var(--card,#111820);color:var(--text,#e8f4f8);border:1px solid var(--border,#1e2733);border-radius:14px;padding:20px;max-width:340px;width:100%;transform:scale(.95);transition:transform .2s ease;}
      .ui-modal-backdrop.show .ui-modal{transform:scale(1);}
      .ui-modal-msg{font-size:14px;line-height:1.6;margin-bottom:16px;white-space:pre-line;}
      .ui-modal-input{width:100%;background:var(--surface,#0f1419);color:var(--text,#e8f4f8);border:1px solid var(--border,#1e2733);border-radius:8px;padding:9px 12px;font-size:14px;outline:none;margin-bottom:16px;font-family:inherit;}
      .ui-modal-input:focus{border-color:var(--accent,#25D366);}
      .ui-modal-actions{display:flex;gap:8px;justify-content:flex-end;}
      .ui-modal-btn{padding:9px 16px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:700;font-family:inherit;}
      .ui-modal-btn.cancel{background:var(--surface,#0f1419);color:var(--muted,#4a6070);border:1px solid var(--border,#1e2733);}
      .ui-modal-btn.confirm{background:var(--accent,#25D366);color:#000;}
      .ui-modal-btn.confirm.danger{background:var(--red,#ff4444);color:#fff;}
      .ui-sheet{max-width:420px;max-height:85vh;display:flex;flex-direction:column;padding:0;}
      .ui-sheet-header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 18px;border-bottom:1px solid var(--border,#1e2733);flex-shrink:0;}
      .ui-sheet-title{font-size:15px;font-weight:700;}
      .ui-sheet-close{background:none;border:none;color:var(--muted,#4a6070);cursor:pointer;padding:4px;display:flex;flex-shrink:0;}
      .ui-sheet-body{padding:16px 18px;overflow-y:auto;font-size:13px;line-height:1.6;}
    `;
    document.head.appendChild(style);
  }

  function getToastWrap() {
    const root = ensureRoot();
    let wrap = root.querySelector('.ui-toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'ui-toast-wrap';
      root.appendChild(wrap);
    }
    return wrap;
  }

  const ICONS = {
    ok: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>',
    err: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
    info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
  };

  // type: 'ok' | 'err' | 'info' (öntanımlı 'info')
  function uiToast(message, type) {
    injectStyle();
    type = (type === 'ok' || type === 'err') ? type : 'info';
    const wrap = getToastWrap();
    const el = document.createElement('div');
    el.className = 'ui-toast ' + type;
    el.innerHTML = `<span class="ui-toast-icon">${ICONS[type]}</span><span></span>`;
    el.lastElementChild.textContent = message; // XSS'e kapalı: metin olarak yazılır
    wrap.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    const hide = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); };
    const timer = setTimeout(hide, type === 'err' ? 4500 : 3000);
    el.addEventListener('click', () => { clearTimeout(timer); hide(); });
  }

  // confirm() yerine — await edilmeli. opts: { confirmLabel, cancelLabel, danger }
  function uiConfirm(message, opts) {
    opts = opts || {};
    injectStyle();
    const root = ensureRoot();
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'ui-modal-backdrop';
      const msgEl = document.createElement('div');
      msgEl.className = 'ui-modal-msg';
      msgEl.textContent = message;
      backdrop.innerHTML = `<div class="ui-modal"></div>`;
      const modal = backdrop.firstElementChild;
      modal.appendChild(msgEl);
      const actions = document.createElement('div');
      actions.className = 'ui-modal-actions';
      actions.innerHTML = `
        <button class="ui-modal-btn cancel"></button>
        <button class="ui-modal-btn confirm${opts.danger ? ' danger' : ''}"></button>`;
      actions.querySelector('.cancel').textContent = opts.cancelLabel || 'Vazgeç';
      actions.querySelector('.confirm').textContent = opts.confirmLabel || 'Onayla';
      modal.appendChild(actions);
      root.appendChild(backdrop);
      requestAnimationFrame(() => backdrop.classList.add('show'));
      const close = (result) => { backdrop.classList.remove('show'); setTimeout(() => backdrop.remove(), 200); resolve(result); };
      actions.querySelector('.cancel').onclick = () => close(false);
      actions.querySelector('.confirm').onclick = () => close(true);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
    });
  }

  // prompt() yerine — await edilmeli, iptalde null döner
  function uiPrompt(message, defaultValue) {
    injectStyle();
    const root = ensureRoot();
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'ui-modal-backdrop';
      backdrop.innerHTML = `<div class="ui-modal"></div>`;
      const modal = backdrop.firstElementChild;
      const msgEl = document.createElement('div');
      msgEl.className = 'ui-modal-msg';
      msgEl.textContent = message;
      modal.appendChild(msgEl);
      const input = document.createElement('input');
      input.className = 'ui-modal-input';
      input.type = 'text';
      input.value = defaultValue || '';
      modal.appendChild(input);
      const actions = document.createElement('div');
      actions.className = 'ui-modal-actions';
      actions.innerHTML = `<button class="ui-modal-btn cancel"></button><button class="ui-modal-btn confirm"></button>`;
      actions.querySelector('.cancel').textContent = 'Vazgeç';
      actions.querySelector('.confirm').textContent = 'Tamam';
      modal.appendChild(actions);
      root.appendChild(backdrop);
      requestAnimationFrame(() => backdrop.classList.add('show'));
      setTimeout(() => input.focus(), 50);
      const close = (result) => { backdrop.classList.remove('show'); setTimeout(() => backdrop.remove(), 200); resolve(result); };
      actions.querySelector('.cancel').onclick = () => close(null);
      actions.querySelector('.confirm').onclick = () => close(input.value);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(input.value); });
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
    });
  }

  const CLOSE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

  // Serbest HTML içerikli büyük panel (detay görünümü gibi) — confirm/prompt'tan farklı olarak
  // await edilmez, kapanınca { closed: true } ile resolve olan bir promise döner (gerekirse).
  // bodyHtml ÇAĞIRANIN kendi ürettiği, güvendiği HTML'dir (kullanıcı girdisi escape edilerek
  // önceden metne çevrilmiş olmalı) — burada ayrıca escape edilmez.
  function uiSheet(title, bodyHtml) {
    injectStyle();
    const root = ensureRoot();
    const backdrop = document.createElement('div');
    backdrop.className = 'ui-modal-backdrop';
    backdrop.innerHTML = `
      <div class="ui-modal ui-sheet">
        <div class="ui-sheet-header">
          <div class="ui-sheet-title"></div>
          <button class="ui-sheet-close" aria-label="Kapat">${CLOSE_ICON}</button>
        </div>
        <div class="ui-sheet-body"></div>
      </div>`;
    const modal = backdrop.querySelector('.ui-modal');
    modal.querySelector('.ui-sheet-title').textContent = title;
    modal.querySelector('.ui-sheet-body').innerHTML = bodyHtml;
    root.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('show'));
    const close = () => { backdrop.classList.remove('show'); setTimeout(() => backdrop.remove(), 200); };
    modal.querySelector('.ui-sheet-close').onclick = close;
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    return { close, bodyEl: modal.querySelector('.ui-sheet-body') };
  }

  window.uiToast = uiToast;
  window.uiConfirm = uiConfirm;
  window.uiPrompt = uiPrompt;
  window.uiSheet = uiSheet;
})();
