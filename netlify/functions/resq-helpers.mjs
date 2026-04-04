// Shared ResQ API helpers — CSRF cookie auth + GraphQL
// Requires env vars: RESQ_EMAIL, RESQ_PASSWORD

const RESQ_GQL = 'https://api.getresq.com/api/graphql/';
const RESQ_LOGIN = 'https://api.getresq.com/api/auth/login/';
const RESQ_CSRF = 'https://api.getresq.com/api/auth/csrf/';

export async function resqLogin() {
  const email = process.env.RESQ_EMAIL;
  const password = process.env.RESQ_PASSWORD;
  if (!email || !password) throw new Error('RESQ_EMAIL / RESQ_PASSWORD not set');

  // Get CSRF token
  const csrfRes = await fetch(RESQ_LOGIN, {
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
    const initRes = await fetch(RESQ_CSRF, {
      headers: { 'Accept': 'application/json' },
    });
    for (const sc of (initRes.headers.getSetCookie?.() || [])) {
      const match = sc.match(/csrftokenproduction=([^;]+)/);
      if (match) csrfToken = match[1];
      cookies.push(sc.split(';')[0]);
    }
  }

  // Login (ResQ expects "username", not "email")
  const loginRes = await fetch(RESQ_LOGIN, {
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

  const res = await fetch(RESQ_GQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': session.csrfToken,
      'Cookie': session.cookieStr,
      'Referer': 'https://app.getresq.com/',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error('ResQ GraphQL failed: ' + res.status);
  const data = await res.json();
  if (data.errors) throw new Error('ResQ GQL error: ' + data.errors[0]?.message);
  return data;
}
