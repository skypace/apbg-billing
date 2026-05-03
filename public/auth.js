// Shared Supabase Auth gate for APBG admin pages.
//
// Usage in any admin HTML page:
//   <script src="https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
//   <script src="/billing/auth.js"></script>
//   <script>
//     APBG.auth.requireSuperadmin().then(({ supabase, session }) => {
//       // ... page init runs only after auth check passes
//     });
//   </script>
//
// All API calls to /billing/.netlify/functions/* should go through
// APBG.auth.authedFetch(...) instead of plain fetch() so the bearer token
// is attached automatically.

(function () {
  var SUPABASE_URL = 'https://gfsdpwiqzshhexkofiif.supabase.co';
  var SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';
  var GATEWAY_URL = 'https://alamedapointbg.com/';
  var ALLOWED_ROLES = ['superadmin'];

  function getSb() {
    if (window.__apbgSb) return window.__apbgSb;
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error(
        'Supabase JS SDK not loaded — include the @supabase/supabase-js script before /billing/auth.js'
      );
    }
    window.__apbgSb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return window.__apbgSb;
  }

  function redirectToLogin() {
    var next = location.pathname + location.search;
    location.href = GATEWAY_URL + '?next=' + encodeURIComponent(next);
  }

  function showAccessDenied(role) {
    document.body.innerHTML = '';
    var card = document.createElement('div');
    card.style.cssText =
      'font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:32px;text-align:center;border:1px solid #FCA5A5;border-radius:8px;background:#FEF2F2';
    var h1 = document.createElement('h1');
    h1.style.cssText = 'color:#991B1B;font-size:1.2rem;margin-bottom:8px';
    h1.textContent = 'Access denied';
    var p = document.createElement('p');
    p.style.cssText = 'color:#7F1D1D;font-size:0.9rem';
    p.textContent =
      'Your role (' +
      (role || 'none') +
      ') does not have access to this page. This page requires superadmin.';
    var link = document.createElement('a');
    link.href = GATEWAY_URL;
    link.style.cssText = 'color:#1F4E79;display:inline-block;margin-top:16px';
    link.textContent = '← Back to gateway';
    card.appendChild(h1);
    card.appendChild(p);
    card.appendChild(link);
    document.body.appendChild(card);
  }

  async function requireSuperadmin() {
    var sb = getSb();
    var sessionResult = await sb.auth.getSession();
    var session = sessionResult.data && sessionResult.data.session;
    if (!session || !session.user) {
      redirectToLogin();
      return new Promise(function () {}); // never resolves; page is redirecting
    }
    var role =
      session.user.app_metadata && session.user.app_metadata.role
        ? session.user.app_metadata.role
        : null;
    if (ALLOWED_ROLES.indexOf(role) === -1) {
      showAccessDenied(role);
      return new Promise(function () {}); // never resolves; access denied
    }
    sb.auth.onAuthStateChange(function (event, newSession) {
      if (event === 'SIGNED_OUT' || !newSession) {
        redirectToLogin();
      }
    });
    return { supabase: sb, session: session, user: session.user, role: role };
  }

  async function authedFetch(input, init) {
    init = init || {};
    var sb = getSb();
    var sessionResult = await sb.auth.getSession();
    var session = sessionResult.data && sessionResult.data.session;
    if (!session) {
      redirectToLogin();
      throw new Error('Not authenticated');
    }
    var headers = new Headers(init.headers || {});
    headers.set('Authorization', 'Bearer ' + session.access_token);
    var nextInit = {};
    for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) nextInit[k] = init[k];
    nextInit.headers = headers;
    return fetch(input, nextInit);
  }

  window.APBG = window.APBG || {};
  window.APBG.auth = {
    requireSuperadmin: requireSuperadmin,
    authedFetch: authedFetch,
    getSupabase: getSb,
    GATEWAY_URL: GATEWAY_URL,
  };
})();
