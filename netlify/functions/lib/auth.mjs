// Auth helpers for Netlify functions.
//
// Verifies the Supabase JWT from Authorization: Bearer <token> and rejects
// requests without a valid superadmin role. Reads role from app_metadata.role
// (server-controlled, not user-tamperable).
//
// Two handler styles are supported:
//   - v1 legacy:  export async function handler(event) { ... }   (event.headers is plain object)
//   - v2 modern:  export default async (req, context) => { ... } (req.headers is Headers instance)
//
// Usage (v1):
//   const auth = await requireAuth(event);
//   if (!auth.ok) return auth.response;
//
// Usage (v2):
//   const auth = await requireAuth(req);
//   if (!auth.ok) return auth.response;
//
// Both return { ok, response?, user?, role?, jwt? }.

// Use the validated anon-key resolver from supabase-helpers.mjs rather than
// reading process.env.SUPABASE_ANON_KEY directly. The Netlify env var is
// currently set to a value that fails project-ref validation — the brixpense
// commits (5165bf2 / 8480239 / 7753f84 / f03c518) discovered and worked
// around this; this file was left reading the env var directly, which made
// every Supabase /auth/v1/user call use the broken key and return 401, so
// requireAuth interpreted that as "Invalid or expired token" and 401'd
// every authed function (resq-sf-sync, health-watchdog, pacer-health,
// expense-to-bill, approve-bill, master-health, etc.) — meanwhile brixpense
// (notify/decide/expense-ocr) kept working because those endpoints use the
// helper. Fix the asymmetry by routing this file through the same helper.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../supabase-helpers.mjs';

const DEFAULT_ROLES = ['superadmin'];

const ERR_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function isV2(reqOrEvent) {
  return typeof reqOrEvent?.headers?.get === 'function';
}

function getAuthHeader(reqOrEvent) {
  if (isV2(reqOrEvent)) return reqOrEvent.headers.get('authorization') || '';
  const h = reqOrEvent?.headers || {};
  return h.authorization || h.Authorization || '';
}

function makeError(reqOrEvent, status, message) {
  const body = JSON.stringify({ error: message });
  if (isV2(reqOrEvent)) {
    return new Response(body, { status, headers: ERR_HEADERS });
  }
  return { statusCode: status, headers: ERR_HEADERS, body };
}

export async function requireAuth(reqOrEvent, allowedRoles = DEFAULT_ROLES) {
  // Internal-cron bypass: cron functions invoke handlers in-process with this flag.
  // Synthetic-event field; not settable from an external HTTP request.
  if (reqOrEvent && reqOrEvent._internalCron === true) {
    return { ok: true, user: null, role: 'cron', jwt: null, scheduled: true };
  }

  const authHeader = getAuthHeader(reqOrEvent);
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim());
  if (!m) {
    return {
      ok: false,
      response: makeError(reqOrEvent, 401, 'Missing Authorization bearer token'),
    };
  }
  const jwt = m[1];

  let user;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${jwt}`,
      },
    });
    if (!res.ok) {
      // Distinguish a Supabase-side outage from a genuinely-invalid token.
      // Mapping every non-2xx to 401 'Invalid or expired token' made a
      // paused / 5xx-ing project look like every user's session had
      // simultaneously expired — operators chased phantom token issues
      // while the real problem was an upstream outage.
      // 5xx → upstream auth degraded (502); 4xx → real token problem (401).
      if (res.status >= 500) {
        return {
          ok: false,
          response: makeError(
            reqOrEvent,
            502,
            `Auth service degraded — Supabase /auth/v1/user returned ${res.status}`
          ),
        };
      }
      return {
        ok: false,
        response: makeError(reqOrEvent, 401, 'Invalid or expired token'),
      };
    }
    user = await res.json();
  } catch (e) {
    return {
      ok: false,
      response: makeError(reqOrEvent, 503, 'Auth service unavailable'),
    };
  }

  if (!user || !user.id) {
    return { ok: false, response: makeError(reqOrEvent, 401, 'Invalid token') };
  }

  // Role lives in user_metadata.role — that is where the gateway admin
  // (admin-users.mjs), the cross-app Staff console (brix-order admin-staff),
  // and the gateway's own client-side gate (auth.js) all WRITE and READ it.
  // This file previously read ONLY app_metadata.role, which the writers never
  // populate, so every staff account managed through the current tooling
  // resolved to role "none" and 403'd every authed Master Control panel
  // (cardholder user list, Connections, health-watchdog). Prefer the stronger
  // app_metadata claim when present, but fall back to user_metadata so the
  // reader matches the writers. brix-order's admin-staff gate already trusts
  // user_metadata.role server-side, so this only aligns with the live posture.
  const role = user.app_metadata?.role || user.user_metadata?.role || null;
  if (allowedRoles && !allowedRoles.includes(role)) {
    return {
      ok: false,
      response: makeError(
        reqOrEvent,
        403,
        `Forbidden — role "${role || 'none'}" not allowed`
      ),
    };
  }

  return { ok: true, user, role, jwt };
}

// Cron-only gate. Use in scheduled functions to reject manual HTTP hits.
// Netlify v2 runtime sets context.next_run / context.scheduled_time for scheduled invocations.
export function requireScheduled(_req, context) {
  const isScheduled = !!(
    context?.next_run ||
    context?.scheduledTime ||
    context?.scheduled_time
  );
  if (isScheduled) return { ok: true, scheduled: true };
  return {
    ok: false,
    response: new Response(
      JSON.stringify({ error: 'Forbidden — cron-only endpoint' }),
      { status: 403, headers: ERR_HEADERS }
    ),
  };
}

// Either scheduled invocation (Netlify cron) or authenticated superadmin.
export async function requireScheduledOrAuth(
  req,
  context,
  allowedRoles = DEFAULT_ROLES
) {
  const isScheduled = !!(
    context?.next_run ||
    context?.scheduledTime ||
    context?.scheduled_time
  );
  if (isScheduled) return { ok: true, scheduled: true };
  return requireAuth(req, allowedRoles);
}
