// /shared/offline-banner.js
// Tiny self-contained offline indicator for client-facing pages.
// Listens to window online/offline events, shows a fixed banner while offline.
// No deps, safe to include once per page via <script src="/shared/offline-banner.js"></script>.

(function() {
  if (window.__mrOfflineBanner) return;
  window.__mrOfflineBanner = true;

  var style = document.createElement('style');
  style.textContent =
    '#mr-offline-banner{position:fixed;left:0;right:0;top:0;background:#F59E0B;color:#1A1A2E;' +
    'font-family:Inter,-apple-system,sans-serif;font-size:.88rem;font-weight:500;' +
    'padding:.6rem 1rem;text-align:center;z-index:99999;box-shadow:0 2px 6px rgba(0,0,0,.08);' +
    'transform:translateY(-110%);transition:transform .25s ease;}' +
    '#mr-offline-banner.show{transform:translateY(0);}';
  document.head.appendChild(style);

  var banner = document.createElement('div');
  banner.id = 'mr-offline-banner';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  banner.textContent = 'You appear to be offline. Reconnect to continue.';
  // Append once body exists.
  function mount() { if (document.body) document.body.appendChild(banner); else setTimeout(mount, 50); }
  mount();

  function render() {
    if (navigator.onLine) banner.classList.remove('show');
    else banner.classList.add('show');
  }
  window.addEventListener('online', render);
  window.addEventListener('offline', render);
  render();
})();
