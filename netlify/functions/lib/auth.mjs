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

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdmc2Rwd2lxenNoaGV4a29maWlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1OTUyMzcsImV4cCI6MjA5MTE3MTIzN30.AygnPJwQ5NfIeKwPtkO6tgVYmkV3MAxL1lMFwN9HPnY';

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

  const role = user.app_metadata?.role || null;
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
