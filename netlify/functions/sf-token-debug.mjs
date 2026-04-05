// Diagnostic: check SF token blob state + test blob read/write
import { getStore } from '@netlify/blobs';

export async function handler(event) {
  const results = {};

  // 1. Check blob store
  try {
    const store = getStore('sf-tokens');
    results.blobsAvailable = true;

    // Read access token
    try {
      const at = await store.get('access-token');
      if (at) {
        const parsed = JSON.parse(at);
        results.accessToken = {
          exists: true,
          expired: parsed.expires < Date.now(),
          expiresIn: Math.round((parsed.expires - Date.now()) / 1000) + 's',
          tokenPreview: parsed.token ? parsed.token.substring(0, 10) + '...' : null,
        };
      } else {
        results.accessToken = { exists: false };
      }
    } catch (e) { results.accessToken = { error: e.message }; }

    // Read refresh token
    try {
      const rt = await store.get('refresh-token');
      results.refreshToken = {
        exists: !!rt,
        preview: rt ? rt.substring(0, 8) + '...' : null,
      };
    } catch (e) { results.refreshToken = { error: e.message }; }

    // Test write/read
    try {
      await store.set('_test', 'hello-' + Date.now());
      const v = await store.get('_test');
      results.blobWriteRead = v ? 'OK' : 'WRITE_OK_READ_FAIL';
    } catch (e) { results.blobWriteRead = 'FAIL: ' + e.message; }

  } catch (e) {
    results.blobsAvailable = false;
    results.blobError = e.message;
  }

  // 2. Check env var
  results.envRefreshToken = process.env.SF_REFRESH_TOKEN
    ? process.env.SF_REFRESH_TOKEN.substring(0, 8) + '...'
    : 'NOT SET';
  results.envClientId = process.env.SF_CLIENT_ID ? 'SET' : 'NOT SET';

  // 3. If action=fix, manually save the provided token to blobs
  const qs = event.queryStringParameters || {};
  if (qs.action === 'fix' && qs.token) {
    try {
      const store = getStore('sf-tokens');
      await store.set('refresh-token', qs.token);

      // Also try to get an access token right now
      const clientId = process.env.SF_CLIENT_ID;
      const clientSecret = process.env.SF_CLIENT_SECRET;
      const res = await fetch('https://api.servicefusion.com/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: qs.token,
        }),
      });

      if (res.ok) {
        const tokens = await res.json();
        await store.set('access-token', JSON.stringify({
          token: tokens.access_token,
          expires: Date.now() + 50 * 60 * 1000,
        }));
        if (tokens.refresh_token) {
          await store.set('refresh-token', tokens.refresh_token);
        }
        results.fix = {
          status: 'SUCCESS',
          accessTokenSaved: true,
          newRefreshToken: tokens.refresh_token ? tokens.refresh_token.substring(0, 8) + '...' : 'same',
        };
      } else {
        results.fix = { status: 'REFRESH_FAILED', code: res.status, body: (await res.text()).substring(0, 200) };
      }
    } catch (e) {
      results.fix = { status: 'ERROR', message: e.message };
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2),
  };
}
