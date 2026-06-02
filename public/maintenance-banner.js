/* maintenance-banner.js — drop-in maintenance notice.
 *
 * Include with: <script src="/billing/maintenance-banner.js"></script>
 *
 * Reads ops.site_settings(key='maintenance') directly with the public anon key
 * (RLS allows SELECT), so it works on any page/app with zero backend wiring.
 * Toggled from the Master Control panel (public/control.html). Non-blocking:
 * a fixed top bar; the app stays usable underneath. Re-checks every 60s so
 * turning maintenance off clears the bar without a reload.
 */
(function () {
  var SUPABASE_URL = 'https://gfsdpwiqzshhexkofiif.supabase.co';
  var ANON =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';
  var BANNER_ID = 'apbg-maint-banner';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function remove() {
    var el = document.getElementById(BANNER_ID);
    if (el) {
      el.parentNode.removeChild(el);
      document.body.style.paddingTop = el.getAttribute('data-prev-pad') || '';
    }
  }

  function show(cfg) {
    if (document.getElementById(BANNER_ID)) return;
    if (sessionStorage.getItem('apbg-maint-dismissed') === '1') return;
    var title = esc(cfg.title || '🛠️ System Maintenance');
    var message = esc(cfg.message || 'This system is being updated — please check back later.');
    var bar = document.createElement('div');
    bar.id = BANNER_ID;
    bar.setAttribute('data-prev-pad', document.body.style.paddingTop || '');
    bar.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
      'background:linear-gradient(90deg,#B45309,#D97706);color:#fff;' +
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
      'padding:10px 44px 10px 16px;font-size:14px;line-height:1.4;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.25);text-align:center';
    bar.innerHTML =
      '<strong style="font-weight:700">' + title + '</strong> ' +
      '<span style="opacity:.95">' + message + '</span>' +
      '<button aria-label="Dismiss" style="position:absolute;top:6px;right:10px;background:transparent;' +
      'border:0;color:#fff;font-size:20px;line-height:1;cursor:pointer;opacity:.85">×</button>';
    bar.querySelector('button').onclick = function () {
      sessionStorage.setItem('apbg-maint-dismissed', '1');
      remove();
    };
    document.body.appendChild(bar);
    // Nudge content down so the bar doesn't cover fixed headers.
    var h = bar.offsetHeight || 44;
    document.body.style.paddingTop = (parseInt(document.body.style.paddingTop || '0', 10) + h) + 'px';
  }

  function check() {
    fetch(
      SUPABASE_URL + '/rest/v1/site_settings?key=eq.maintenance&select=value',
      { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON, 'Accept-Profile': 'ops' } }
    )
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        var v = (rows && rows[0] && rows[0].value) || {};
        if (v.enabled) show(v); else remove();
      })
      .catch(function () { /* fail safe: no banner */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }
  setInterval(check, 60000);
})();
