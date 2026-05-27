// Shared ResQ API helpers — CSRF cookie auth + GraphQL
// Requires env vars: RESQ_EMAIL, RESQ_PASSWORD

const RESQ_GQL = 'https://api.getresq.com/api/graphql/';
const RESQ_LOGIN = 'https://api.getresq.com/api/auth/login/';
const RESQ_CSRF = 'https://api.getresq.com/api/auth/csrf/';

// A hung ResQ host used to take down both /api/health (melt) and
// /health-watchdog (apbg-billing) because every fetch here was uncapped.
// 10s is well above ResQ's healthy p99 and below the 15s gateway probe abort.
const RESQ_FETCH_TIMEOUT_MS = 10000;

async function fetchWithTimeout(url, opts = {}, timeoutMs = RESQ_FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`ResQ request timed out after ${timeoutMs}ms: ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Login as vendor (default) or facility
// Pass { facility: true } to use RESQ_FACILITY_EMAIL/PASSWORD
export async function resqLogin(opts = {}) {
  const email = opts.facility ? process.env.RESQ_FACILITY_EMAIL : process.env.RESQ_EMAIL;
  const password = opts.facility ? process.env.RESQ_FACILITY_PASSWORD : process.env.RESQ_PASSWORD;
  const label = opts.facility ? 'RESQ_FACILITY_EMAIL/PASSWORD' : 'RESQ_EMAIL/PASSWORD';
  if (!email || !password) throw new Error(`${label} not set`);

  // Get CSRF token
  const csrfRes = await fetchWithTimeout(RESQ_LOGIN, {
    method: 'OPTIONS',
    headers: { 'Accept': 'application/json' },
  });
  const setCookies = csrfRes.headers.getSetCookie?.() || [];
  let csrfToken = '';
  let cookies = [];
  for (const sc of setCookies) {
    const match = sc.match(/csrftokenproduction=([^;]+)/);
    if (match) csrfToken = match[1];
    cookies.push(sc.split(';')[0]);
  }

  // Fallback: dedicated CSRF endpoint
  if (!csrfToken) {
    const initRes = await fetchWithTimeout(RESQ_CSRF, {
      headers: { 'Accept': 'application/json' },
    });
    for (const sc of (initRes.headers.getSetCookie?.() || [])) {
      const match = sc.match(/csrftokenproduction=([^;]+)/);
      if (match) csrfToken = match[1];
      cookies.push(sc.split(';')[0]);
    }
  }

  // Login (ResQ expects "username", not "email")
  const loginRes = await fetchWithTimeout(RESQ_LOGIN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': csrfToken,
      'Cookie': cookies.join('; '),
      'Referer': 'https://app.getresq.com/',
    },
    body: JSON.stringify({ username: email, password }),
  });

  if (!loginRes.ok) {
    throw new Error('ResQ login failed: ' + loginRes.status + ' ' + (await loginRes.text()).substring(0, 200));
  }

  // Capture any updated CSRF token from login response
  for (const sc of (loginRes.headers.getSetCookie?.() || [])) {
    const match = sc.match(/csrftokenproduction=([^;]+)/);
    if (match) csrfToken = match[1];
    cookies.push(sc.split(';')[0]);
  }

  return { csrfToken, cookieStr: cookies.join('; ') };
}

export async function resqGql(session, query, variables) {
  const body = { query };
  if (variables) body.variables = variables;

  const res = await fetchWithTimeout(RESQ_GQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': session.csrfToken,
      'Cookie': session.cookieStr,
      'Referer': 'https://app.getresq.com/',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ResQ GraphQL ${res.status}: ${body.substring(0, 300)}`);
  }
  const data = await res.json();
  if (data.errors) throw new Error('ResQ GQL error: ' + JSON.stringify(data.errors[0]).substring(0, 300));
  return data;
}
