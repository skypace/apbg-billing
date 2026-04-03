export default async (req, context) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    return new Response(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#1a1d21;color:#f0f0f2">
      <h2 style="color:#f87171">Failed</h2><p>${error || 'No authorization code received'}</p></body></html>`,
      { headers: { 'Content-Type': 'text/html' } }
    );
  }

  try {
    const clientId = Netlify.env.get('QBO_CLIENT_ID');
    const clientSecret = Netlify.env.get('QBO_CLIENT_SECRET');
    const redirectUri = 'https://apbg-billing.netlify.app/.netlify/functions/oauth-callback';
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();

    // Auto-save refresh token
    try {
      const pat = Netlify.env.get('NETLIFY_ACCESS_TOKEN');
      const sid = Netlify.env.get('NETLIFY_SITE_ID');
      if (pat && sid && data.refresh_token) {
        await fetch(`https://api.netlify.com/api/v1/sites/${sid}/env/QBO_REFRESH_TOKEN`, {
          method: 'DELETE', headers: { 'Authorization': `Bearer ${pat}` },
        });
        await fetch(`https://api.netlify.com/api/v1/sites/${sid}/env`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${pat}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([{ key: 'QBO_REFRESH_TOKEN', scopes: ['builds','functions','post_processing','runtime'], values: [{ value: data.refresh_token, context: 'all' }] }]),
        });
      }
    } catch (e) { /* skip */ }

    return new Response(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#1a1d21;color:#f0f0f2">
      <h2 style="color:#4ade80">Connected to QuickBooks</h2>
      <p>Copy this refresh token and paste it to Claude:</p>
      <div style="background:#0f1114;border:1px solid #4a4a52;border-radius:8px;padding:16px;margin:16px 0;word-break:break-all;font-family:monospace;font-size:14px;color:#ff6b35;cursor:pointer" onclick="navigator.clipboard.writeText(this.innerText).then(()=>this.style.border='2px solid #4ade80')">${data.refresh_token}</div>
      <p style="font-size:12px;color:#9a9aaa">Click the token above to copy it to clipboard</p>
      </body></html>`,
      { headers: { 'Content-Type': 'text/html' } }
    );
  } catch (err) {
    return new Response(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#1a1d21;color:#f0f0f2">
      <h2 style="color:#f87171">Error</h2><p>${err.message}</p></body></html>`,
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
};
