import { corsHeaders } from './qbo-helpers.mjs';
import { getStore } from "@netlify/blobs";

function getBlobStore() {
  return getStore({
    name: "qbo-tokens",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_ACCESS_TOKEN,
  });
}

// Handles the OAuth callback from Intuit after authorization
// Exchanges the auth code for access + refresh tokens
// Stores tokens in Netlify Blobs (instant) + env vars (backup)

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
    const redirectUri = 'https://apbg-billing.netlify.app/.netlify/functions/oauth-callback';

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

    // Store in Netlify Blobs FIRST (instant, no redeploy needed)
    const store = getBlobStore();
    if (tokens.refresh_token) {
      await store.set("refresh-token", tokens.refresh_token);
      await store.set("refresh-token-updated", new Date().toISOString());
    }
    if (tokens.access_token) {
      await store.set("access-token", JSON.stringify({
        token: tokens.access_token,
        expires: Date.now() + 50 * 60 * 1000,
      }));
    }

    // Store realm ID in blobs if present
    if (realmId) {
      try { await store.set("realm-id", realmId); } catch(e) {}
    }

    // Also update env vars as backup
    const siteId = process.env.NETLIFY_SITE_ID;
    const netlifyToken = process.env.NETLIFY_ACCESS_TOKEN;

    if (siteId && netlifyToken) {
      try {
        await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/env/QBO_REFRESH_TOKEN`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${netlifyToken}` },
        });
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
      body: successPage(realmId),
    };
  } catch (err) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: errorPage(err.message) };
  }
}

function successPage(realmId) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QBO Connected</title>
<style>body{font-family:'DM Sans',sans-serif;background:#F4F6F9;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:#fff;border-radius:12px;border:1px solid #D1FAE5;padding:48px 40px;max-width:500px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.04)}
h1{color:#065F46;font-size:1.4rem;margin-bottom:12px}
p{color:#6B7280;font-size:0.9rem;margin-bottom:8px}
a{display:inline-block;margin-top:20px;background:#1F4E79;color:#fff;text-decoration:none;padding:12px 32px;border-radius:8px;font-weight:600}
</style></head><body>
<div class="card">
<h1>&#10003; QuickBooks Connected</h1>
<p>APBG Billing Loader is now authorized to access QuickBooks.</p>
<p style="font-size:0.8rem;color:#9CA3AF;">Realm ID: ${realmId || 'same'}</p>
<p style="font-size:0.85rem;color:#065F46;margin-top:16px;">Token saved automatically — no manual steps needed.</p>
<p style="font-size:0.75rem;color:#9CA3AF;">Stored at ${new Date().toLocaleString()}</p>
<a href="/">Start Using Billing Loader &#8594;</a>
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
