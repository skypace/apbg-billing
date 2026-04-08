// Proxy health check for Pacer Finance
// Tests QBO and Zoho MCP endpoints server-side (no CORS issues)
// Called by control dashboard frontend

const MCP_KEY = process.env.MCP_API_KEY || process.env.QBO_PROXY_KEY;
const PACER_BASE = 'https://pacerfinance.netlify.app';

async function checkEndpoint(path, toolName) {
  try {
    const res = await fetch(`${PACER_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': MCP_KEY || '',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 1,
      }),
    });

    if (res.status === 404 || res.status === 502 || res.status === 503) {
      return { ok: false, message: `Endpoint down (HTTP ${res.status})` };
    }

    // Any other response means the function is alive and processing
    // 200 = working, 400/401/406 = alive but auth/format issue
    const alive = res.status < 500;
    let detail = `HTTP ${res.status}`;

    if (res.ok) {
      try {
        const data = await res.json();
        const toolCount = data?.result?.tools?.length;
        if (toolCount) detail = `${toolCount} tools available`;
        else detail = 'Connected';
      } catch(e) {
        detail = 'Connected (non-JSON response)';
      }
    }

    return { ok: alive, message: alive ? detail : `Error (HTTP ${res.status})` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

export async function handler(event) {
  const results = {
    qbo: await checkEndpoint('/qbo', 'QuickBooks'),
    zoho: await checkEndpoint('/zoho', 'Zoho'),
    checkedAt: new Date().toISOString(),
  };

  const allOk = results.qbo.ok && results.zoho.ok;
  const anyOk = results.qbo.ok || results.zoho.ok;
  results.overall = allOk ? 'healthy' : anyOk ? 'degraded' : 'down';

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(results),
  };
}
