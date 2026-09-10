import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SF_TOKEN_URL = "https://api.servicefusion.com/oauth/access_token";

function getSB() {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { db: { schema: "ops" } }
  );
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(page("error", error), { headers: { "Content-Type": "text/html" } });
  }

  if (!code) {
    return new Response(page("error", "No authorization code received"), { headers: { "Content-Type": "text/html" } });
  }

  try {
    const clientId = Deno.env.get("SF_CLIENT_ID") || "";
    const clientSecret = Deno.env.get("SF_CLIENT_SECRET") || "";
    const redirectUri = "https://gfsdpwiqzshhexkofiif.supabase.co/functions/v1/sf-oauth-callback";

    const res = await fetch(SF_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code&code=" + code + "&client_id=" + clientId + "&client_secret=" + clientSecret + "&redirect_uri=" + encodeURIComponent(redirectUri),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error("Token exchange failed: " + res.status + " " + err.substring(0, 300));
    }

    const tokens = await res.json();

    if (!tokens.access_token) {
      throw new Error("No access_token in response: " + JSON.stringify(tokens).substring(0, 300));
    }

    // Store in ops.sf_token_cache
    const sb = getSB();
    const { error: dbErr } = await sb.from("sf_token_cache").upsert({
      id: 1,
      access_token: tokens.access_token,
      access_expires_at: new Date(Date.now() + 50 * 60 * 1000).toISOString(),
      refresh_token: tokens.refresh_token || "none",
      updated_at: new Date().toISOString(),
    });

    if (dbErr) {
      throw new Error("Failed to save tokens to Supabase: " + dbErr.message);
    }

    // Log it
    await sb.from("sync_log").insert({
      source: "sf",
      sync_type: "oauth",
      status: "success",
      records_synced: 0,
      completed_at: new Date().toISOString(),
      metadata: { has_refresh: !!tokens.refresh_token },
    });

    return new Response(page("success", tokens.refresh_token || "(no refresh token returned)"), {
      headers: { "Content-Type": "text/html" },
    });
  } catch (err: any) {
    return new Response(page("error", err.message), {
      headers: { "Content-Type": "text/html" },
    });
  }
});

function page(type: string, data: string): string {
  if (type === "success") {
    return '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SF Connected</title><style>body{font-family:system-ui;background:#0B0C10;color:#c8cad8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:#111218;border-radius:12px;border:1px solid rgba(74,222,128,.2);padding:48px 40px;max-width:500px;text-align:center}h1{color:#4ade80;font-size:1.3rem;margin-bottom:12px}p{color:#6B6F82;font-size:.9rem;margin-bottom:8px}.token{font-family:monospace;font-size:.6rem;background:#08090d;padding:8px;border-radius:4px;word-break:break-all;margin:16px 0;color:#6B6F82;user-select:all}</style></head><body><div class="card"><h1>Service Fusion Connected</h1><p>Tokens saved to Supabase ops.sf_token_cache.</p><p>The sync-sf edge function can now pull jobs.</p><p style="font-size:.75rem;color:#f59e0b;">Backup token (copy if needed):</p><div class="token">' + data + '</div><p style="font-size:.8rem;color:#4ade80;">You can close this window.</p></div></body></html>';
  }
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SF Error</title><style>body{font-family:system-ui;background:#0B0C10;color:#c8cad8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:#111218;border-radius:12px;border:1px solid rgba(248,113,113,.2);padding:48px 40px;max-width:500px;text-align:center}h1{color:#f87171;font-size:1.3rem;margin-bottom:12px}.err{font-family:monospace;font-size:.75rem;background:rgba(248,113,113,.05);padding:12px;border-radius:6px;margin-top:16px;color:#f87171;word-break:break-all}</style></head><body><div class="card"><h1>SF Auth Failed</h1><div class="err">' + data + '</div></div></body></html>';
}
