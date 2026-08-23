// /api/expense-departments — list + create QBO Departments (a.k.a. Locations).
//
// QBO's "Department" is the location-tracking dimension. Brixpense lets a
// submitter tag any expense with one (dropdown + add-new); the chosen id is
// stamped on ops.expense_requests.qbo_department_id and posted as DepartmentRef
// on the resulting QBO Bill / Purchase (see expense-request-notify).
//
//   GET  → { departments: [{ id, name }] }   (active only)
//   POST → { name }  → creates the department, returns { id, name }
//
// Bearer-gated (any authenticated user). Requires "Track locations/departments"
// to be enabled in QBO; if it isn't, the query returns an empty list and the
// form falls back to free-text-free behaviour (no location).

import { qboQuery, qboRequest } from './qbo-helpers.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

function json(d, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: CORS });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Unauthorized — Bearer token required' }, 401);
  }

  if (req.method === 'GET') {
    try {
      const result = await qboQuery(
        `SELECT Id, Name, Active FROM Department WHERE Active = true MAXRESULTS 1000`,
      );
      const departments = (result?.QueryResponse?.Department || [])
        .map((d) => ({ id: String(d.Id), name: d.Name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return json({ departments });
    } catch (e) {
      // Location tracking may be off, or QBO hiccup — degrade to empty.
      return json({ departments: [], warning: e.message?.substring(0, 200) || String(e) });
    }
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    const name = (body?.name || '').trim();
    if (!name) return json({ error: 'name is required' }, 400);

    try {
      const res = await qboRequest('POST', '/department', { Name: name });
      const d = res?.Department;
      if (!d?.Id) return json({ error: 'QBO did not return a Department id' }, 502);
      return json({ id: String(d.Id), name: d.Name });
    } catch (e) {
      return json({ error: `QBO create department failed: ${e.message?.substring(0, 300) || e}` }, 502);
    }
  }

  return json({ error: 'GET or POST only' }, 405);
}

// Reachable only at this path (see netlify.toml /expense/api/* rewrite).
export const config = { path: '/api/expense-departments' };
