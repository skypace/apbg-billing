// Service Fusion OAuth callback
// Exchanges authorization code for access + refresh tokens
// Saves to BOTH Netlify Blobs (immediate) and env vars (survives deploys)

import { getStore } from '@netlify/blobs';

const SF_TOKEN_URL = 'https://api.servicefusion.com/oauth/access_token';

export async function handler(event) {
  const code = event.queryStringParameters?.code;
  const error = event.queryStringParameters?.error;

  if (error) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: page('error', error) };
  }
  if (!code) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: page('error', 'No authorization code received') };
  }

  try {
    const clientId = process.env.SF_CLIENT_ID;
    const clientSecret = process.env.SF_CLIENT_SECRET;
    const siteUrl = process.env.URL || 'https://apbg-billing.netlify.app';
    const redirectUri = `${siteUrl}/.netlify/functions/sf-oauth-callback`;

    const res = await fetch(SF_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=authorization_code&code=${code}&client_id=${clientId}&client_secret=${clientSecret}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Token exchange failed: ${res.status} ${err}`);
    }

    const tokens = await res.json();

    // Save to Netlify Blobs (immediate availability for sync functions)
    try {
      const store = getStore('sf-tokens');
      if (tokens.access_token) {
        await store.set('access-token', JSON.stringify({
          token: tokens.access_token,
          expires: Date.now() + 50 * 60 * 1000,
        }));
      }
      if (tokens.refresh_token) {
        await store.set('refresh-token', tokens.refresh_token);
      }
    } catch (e) {
      console.warn('Blob save failed:', e.message);
    }

    // Also save refresh token to Netlify env vars (survives deploys)
    const siteId = process.env.NETLIFY_SITE_ID;
    const netlifyToken = process.env.NETLIFY_ACCESS_TOKEN;

    if (siteId && netlifyToken && tokens.refresh_token) {
      try {
        const headers = { 'Authorization': `Bearer ${netlifyToken}`, 'Content-Type': 'application/json' };
        const base = `https://api.netlify.com/api/v1/sites/${siteId}/env`;
        await fetch(`${base}/SF_REFRESH_TOKEN`, { method: 'DELETE', headers });
        await fetch(base, {
          method: 'POST', headers,
          body: JSON.stringify([{
            key: 'SF_REFRESH_TOKEN',
            scopes: ['builds', 'functions', 'runtime', 'post_processing'],
            values: [{ value: tokens.refresh_token, context: 'all' }],
          }]),
        });
      } catch (e) {
        console.warn('SF env var save failed:', e.message);
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: page('success', tokens.refresh_token),
    };
  } catch (err) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: page('error', err.message) };
  }
}

function page(type, data) {
  if (type === 'success') {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SF Connected</title>
<style>body{font-family:'DM Sans',sans-serif;background:#F4F6F9;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:#fff;border-radius:12px;border:1px solid #D1FAE5;padding:48px 40px;max-width:500px;text-align:center}
h1{color:#065F46;font-size:1.4rem;margin-bottom:12px}p{color:#6B7280;font-size:0.9rem;margin-bottom:8px}
.token{font-family:monospace;font-size:0.65rem;background:#F4F6F9;padding:8px;border-radius:4px;word-break:break-all;margin:16px 0;color:#6B7280;user-select:all}
a{display:inline-block;margin-top:20px;background:#1F4E79;color:#fff;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:600}</style></head><body>
<div class="card"><h1>✓ Service Fusion Connected</h1><p>Tokens saved to both blob storage and environment variables.</p>
<p style="font-size:0.78rem;color:#991B1B;">Backup — copy this token if needed:</p>
<div class="token">${data}</div><a href="/sync.html">→ Go to Sync Dashboard</a></div></body></html>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SF Error</title>
<style>body{font-family:'DM Sans',sans-serif;background:#F4F6F9;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:#fff;border-radius:12px;border:1px solid #F87171;padding:48px 40px;max-width:500px;text-align:center}
h1{color:#991B1B;font-size:1.4rem;margin-bottom:12px}p{color:#6B7280;font-size:0.9rem}
.err{font-family:monospace;font-size:0.8rem;background:#FEE2E2;padding:12px;border-radius:6px;margin-top:16px;color:#991B1B;word-break:break-all}</style></head><body>
<div class="card"><h1>✗ Service Fusion Auth Failed</h1><div class="err">${data}</div></div></body></html>`;
}
