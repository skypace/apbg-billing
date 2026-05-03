// Shared Supabase Auth gate for APBG admin pages.
//
// Reads the gateway's session blob from localStorage (key: 'apbg_session'),
// extracts the access_token JWT, and uses it as the Bearer for all API calls.
// The gateway uses a custom storage shape:
//   { token, refreshToken, expiresAt, user: { id, email, name, role } }
// rather than the Supabase JS default. The JWT itself is a real Supabase
// access_token, so server-side requireAuth verifies it via /auth/v1/user.
//
// Usage in any admin HTML page:
//   <script src="/billing/auth.js"></script>
//   <script>
//     APBG.auth.requireSuperadmin().then(({ session, user, role }) => {
//       // ... page init runs only after auth check passes
//     });
//   </script>
//
// All API calls to /billing/.netlify/functions/* should go through
// APBG.auth.authedFetch(...) so the bearer token is attached automatically.

(function () {
  var SUPABASE_URL = 'https://gfsdpwiqzshhexkofiif.supabase.co';
  var SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';
  var GATEWAY_URL = 'https://alamedapointbg.com/';
  var STORAGE_KEY = 'apbg_session';
  var ALLOWED_ROLES = ['superadmin'];

  function readSession() {
    var raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.token) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function decodeJwt(token) {
    try {
      var parts = String(token).split('.');
      if (parts.length < 2) return null;
      var payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (payload.length % 4) payload += '=';
      var decoded = atob(payload);
      // Decode UTF-8 properly
      try { decoded = decodeURIComponent(escape(decoded)); } catch (e) { /* ignore */ }
      return JSON.parse(decoded);
    } catch (e) {
      return null;
    }
  }

  function isExpired(session) {
    var ms = session && session.expiresAt;
    if (!ms) {
      var claims = decodeJwt(session && session.token);
      if (claims && claims.exp) ms = claims.exp * 1000;
    }
    if (!ms) return false;
    return Date.now() >= ms;
  }

  function redirectToLogin() {
    var next = location.pathname + location.search;
    location.href = GATEWAY_URL + '?next=' + encodeURIComponent(next);
  }

  function renderCard(opts) {
    document.body.innerHTML = '';
    var card = document.createElement('div');
    card.style.cssText =
      'font-family:system-ui,sans-serif;max-width:520px;margin:80px auto;padding:32px;text-align:center;border:1px solid ' +
      (opts.borderColor || '#FCA5A5') +
      ';border-radius:8px;background:' +
      (opts.bgColor || '#FEF2F2');
    var h1 = document.createElement('h1');
    h1.style.cssText = 'color:' + (opts.titleColor || '#991B1B') + ';font-size:1.2rem;margin-bottom:8px';
    h1.textContent = opts.title;
    var p = document.createElement('p');
    p.style.cssText = 'color:' + (opts.bodyColor || '#7F1D1D') + ';font-size:0.9rem;white-space:pre-wrap';
    p.textContent = opts.message;
    card.appendChild(h1);
    card.appendChild(p);
    if (opts.detail) {
      var pre = document.createElement('pre');
      pre.style.cssText =
        'margin-top:12px;padding:10px;background:#1F2937;color:#F3F4F6;font-size:0.72rem;border-radius:4px;text-align:left;overflow:auto;max-height:160px';
      pre.textContent = opts.detail;
      card.appendChild(pre);
    }
    var link = document.createElement('a');
    link.href = GATEWAY_URL;
    link.style.cssText = 'color:#1F4E79;display:inline-block;margin-top:16px';
    link.textContent = '← Back to gateway';
    card.appendChild(link);
    document.body.appendChild(card);
  }

  function showAccessDenied(role) {
    renderCard({
      title: 'Access denied',
      message:
        'Your role (' +
        (role || 'none') +
        ') does not have access to this page. This page requires superadmin.',
    });
  }

  function showError(message, detail) {
    renderCard({
      title: 'Auth check failed',
      message: message,
      detail: detail,
      borderColor: '#FBBF24',
      bgColor: '#FFFBEB',
      titleColor: '#92400E',
      bodyColor: '#78350F',
    });
  }

  async function requireSuperadmin() {
    var session = readSession();
    if (!session) {
      redirectToLogin();
      return new Promise(function () {});
    }
    if (isExpired(session)) {
      redirectToLogin();
      return new Promise(function () {});
    }
    // Role check — server still enforces via /auth/v1/user, this is UX only.
    // Prefer the JWT app_metadata claim (server-controlled) over the
    // gateway's user.role field (which mirrors user_metadata).
    var claims = decodeJwt(session.token);
    var role =
      (claims && claims.app_metadata && claims.app_metadata.role) ||
      (session.user && session.user.role) ||
      null;
    if (ALLOWED_ROLES.indexOf(role) === -1) {
      showAccessDenied(role);
      return new Promise(function () {});
    }
    // For pages that use supabase-js for direct queries (dashboard.html,
    // ops/index.html), seed the client with this session.
    var sb = null;
    if (window.supabase && window.supabase.createClient) {
      sb = getSupabase();
      try {
        await sb.auth.setSession({
          access_token: session.token,
          refresh_token: session.refreshToken,
        });
      } catch (e) { /* ignore — direct REST queries still work */ }
    }
    return {
      supabase: sb,
      session: session,
      user: session.user || null,
      role: role,
      accessToken: session.token,
    };
  }

  // Capture native fetch at module-load time. Classic <script>s share their
  // top-level let/const scope, so a `const fetch = APBG.auth.authedFetch` in
  // an admin page would otherwise shadow the bare `fetch` identifier here
  // and cause infinite recursion ("Maximum call stack size exceeded").
  var nativeFetch = window.fetch.bind(window);

  async function authedFetch(input, init) {
    init = init || {};
    var session = readSession();
    if (!session || isExpired(session)) {
      redirectToLogin();
      throw new Error('Not authenticated');
    }
    var headers = new Headers(init.headers || {});
    headers.set('Authorization', 'Bearer ' + session.token);
    var nextInit = {};
    for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) nextInit[k] = init[k];
    nextInit.headers = headers;
    return nativeFetch(input, nextInit);
  }

  function getSupabase() {
    if (window.__apbgSb) return window.__apbgSb;
    if (!window.supabase || !window.supabase.createClient) return null;
    window.__apbgSb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return window.__apbgSb;
  }

  window.APBG = window.APBG || {};
  window.APBG.auth = {
    requireSuperadmin: requireSuperadmin,
    authedFetch: authedFetch,
    getSupabase: getSupabase,
    GATEWAY_URL: GATEWAY_URL,
  };
})();
