import { corsHeaders } from './qbo-helpers.mjs';

// Handles the OAuth callback from Intuit after authorization
// Exchanges the auth code for access + refresh tokens
// Stores the refresh token in Netlify env vars

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

export async function handler(event) {
  const code = event.queryStringParameters?.code;
  const realmId = event.queryStringParameters?.realmId;
  const error = event.queryStringParameters?.error;

  if (error) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: errorPage(error) };
  }

  if (!code) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: errorPage('No authorization code received') };
  }

  try {
    const clientId = process.env.QBO_CLIENT_ID;
    const clientSecret = process.env.QBO_CLIENT_SECRET;
    const siteUrl = process.env.URL || 'https://apbg-billing.netlify.app';
    const redirectUri = `${siteUrl}/.netlify/functions/oauth-callback`;

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    // Exchange code for tokens
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Token exchange failed: ${res.status} ${err}`);
    }

    const tokens = await res.json();

    // Store the refresh token in Netlify env vars
    const siteId = process.env.NETLIFY_SITE_ID;
    const netlifyToken = process.env.NETLIFY_ACCESS_TOKEN;

    if (siteId && netlifyToken) {
      // Try to update via Netlify API
      try {
        // Delete existing
        await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/env/QBO_REFRESH_TOKEN`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${netlifyToken}` },
        });
        // Create new
        await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/env`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${netlifyToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([{
            key: 'QBO_REFRESH_TOKEN',
            scopes: ['builds', 'functions', 'runtime', 'post_processing'],
            values: [{ value: tokens.refresh_token, context: 'all' }],
          }]),
        });
      } catch (e) {
        console.warn('Auto-update of env var failed:', e.message);
      }
    }

    // Also update realm ID if different
    if (realmId && realmId !== process.env.QBO_REALM_ID && siteId && netlifyToken) {
      try {
        await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/env/QBO_REALM_ID`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${netlifyToken}` },
        });
        await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/env`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${netlifyToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([{
            key: 'QBO_REALM_ID',
            scopes: ['builds', 'functions', 'runtime', 'post_processing'],
            values: [{ value: realmId, context: 'all' }],
          }]),
        });
      } catch (e) {
        console.warn('Realm ID update failed:', e.message);
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: successPage(tokens.refresh_token, realmId),
    };
  } catch (err) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: errorPage(err.message) };
  }
}

function successPage(refreshToken, realmId) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QBO Connected</title>
<style>body{font-family:'DM Sans',sans-serif;background:#F4F6F9;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:#fff;border-radius:12px;border:1px solid #D1FAE5;padding:48px 40px;max-width:500px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.04)}
h1{color:#065F46;font-size:1.4rem;margin-bottom:12px}
p{color:#6B7280;font-size:0.9rem;margin-bottom:8px}
.token{font-family:monospace;font-size:0.7rem;background:#F4F6F9;padding:8px;border-radius:4px;word-break:break-all;margin:16px 0;color:#6B7280;max-height:60px;overflow:hidden}
a{display:inline-block;margin-top:20px;background:#1F4E79;color:#fff;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:600}
</style></head><body>
<div class="card">
<h1>✓ QuickBooks Connected</h1>
<p>APBG Billing Loader is now authorized to access QuickBooks.</p>
<p style="font-size:0.8rem;color:#9CA3AF;">Realm ID: ${realmId || 'same'}</p>
<div class="token">${refreshToken ? refreshToken.substring(0, 30) + '...' : 'Token stored'}</div>
<p style="font-size:0.78rem;color:#991B1B;">If the auto-update didn't work, copy the full refresh token below and set it as QBO_REFRESH_TOKEN in Netlify env vars, then redeploy.</p>
<div class="token" style="max-height:none;font-size:0.65rem;user-select:all">${refreshToken}</div>
<a href="/">Start Using Billing Loader →</a>
</div></body></html>`;
}

function errorPage(msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QBO Auth Error</title>
<style>body{font-family:'DM Sans',sans-serif;background:#F4F6F9;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:#fff;border-radius:12px;border:1px solid #F87171;padding:48px 40px;max-width:500px;text-align:center}
h1{color:#991B1B;font-size:1.4rem;margin-bottom:12px}
p{color:#6B7280;font-size:0.9rem}
.err{font-family:monospace;font-size:0.8rem;background:#FEE2E2;padding:12px;border-radius:6px;margin-top:16px;color:#991B1B;word-break:break-all}
</style></head><body>
<div class="card"><h1>✗ Authorization Failed</h1><p>QuickBooks did not authorize the connection.</p><div class="err">${msg}</div></div></body></html>`;
}
