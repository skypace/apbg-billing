// admin-users — APBG-OPS Supabase project
//
// Lightweight wrapper around supabase.auth.admin for the dashboard's
// Settings → Users tab. Service role key stays server-side; the dashboard
// authenticates with the user's JWT and we verify it before performing
// admin actions. Only users whose user_metadata.role IN ('admin','superadmin')
// can manage other users; everyone else gets 403.
//
// Mirrors the gateway's admin-users.mjs but lives in the dashboard's
// project so it can be invoked over the same Supabase Auth session.

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ROLES = [
  { value: "admin",      label: "Administrator",         apps: ["sales"] },
  { value: "finance",    label: "Finance / Reporting",   apps: ["sales"] },
  { value: "sales",      label: "Sales User",            apps: ["sales"] },
  { value: "viewer",     label: "View Only",             apps: ["sales"] },
];

function jsonRes(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { "Content-Type": "application/json", ...CORS },
  });
}

function admin() {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: { persistSession: false } },
  );
}

// Verify the caller's JWT and return their user record + role.
async function authedCaller(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return { error: "missing bearer token", status: 401 };
  const sb = admin();
  const { data, error } = await sb.auth.getUser(m[1]);
  if (error || !data.user) return { error: "invalid token", status: 401 };
  const role = (data.user.user_metadata as any)?.role || null;
  return { user: data.user, role };
}

function isAdmin(role: string | null) {
  return role === "admin" || role === "superadmin";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || (req.method === "GET" ? "list" : "");

  // Public endpoint: role list (no auth needed)
  if (action === "roles") return jsonRes({ ok: true, roles: ROLES });

  // All other actions require an authenticated admin caller
  const caller = await authedCaller(req);
  if ("error" in caller) return jsonRes({ ok: false, error: caller.error }, caller.status);
  if (!isAdmin(caller.role)) {
    return jsonRes({ ok: false, error: "admin role required (yours: " + (caller.role || "none") + ")" }, 403);
  }

  const sb = admin();

  try {
    if (action === "list" || (req.method === "GET" && !action)) {
      const { data, error } = await sb.auth.admin.listUsers({ perPage: 200 });
      if (error) throw error;
      const users = (data.users || []).map((u: any) => ({
        id: u.id, email: u.email,
        role: u.user_metadata?.role || null,
        name: u.user_metadata?.name || null,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        confirmed_at: u.confirmed_at || u.email_confirmed_at,
      }));
      users.sort((a: any, b: any) => (a.email || "").localeCompare(b.email || ""));
      return jsonRes({ ok: true, users });
    }

    const body = req.method !== "GET" ? await req.json().catch(() => ({})) : {};

    if (action === "invite") {
      const email = String(body.email || "").trim().toLowerCase();
      const role = String(body.role || "viewer");
      const name = String(body.name || "").trim() || null;
      if (!email) return jsonRes({ ok: false, error: "email required" }, 400);
      const { data, error } = await sb.auth.admin.inviteUserByEmail(email, {
        data: { role, name },
      });
      if (error) throw error;
      return jsonRes({ ok: true, user: data.user });
    }

    if (action === "update_role") {
      const id = String(body.id || "");
      const role = String(body.role || "");
      if (!id || !role) return jsonRes({ ok: false, error: "id and role required" }, 400);
      // preserve other user_metadata
      const { data: u } = await sb.auth.admin.getUserById(id);
      const meta = Object.assign({}, (u?.user?.user_metadata as any) || {}, { role });
      const { data, error } = await sb.auth.admin.updateUserById(id, { user_metadata: meta });
      if (error) throw error;
      return jsonRes({ ok: true, user: data.user });
    }

    if (action === "delete") {
      const id = String(body.id || "");
      if (!id) return jsonRes({ ok: false, error: "id required" }, 400);
      if (id === caller.user.id) return jsonRes({ ok: false, error: "can't delete yourself" }, 400);
      const { error } = await sb.auth.admin.deleteUser(id);
      if (error) throw error;
      return jsonRes({ ok: true });
    }

    return jsonRes({ ok: false, error: "unknown action: " + action }, 400);
  } catch (err) {
    return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
