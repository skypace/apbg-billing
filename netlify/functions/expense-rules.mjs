// expense-rules.mjs — manage the auto-populate rules for inbound bills.
//
// GET                        → every rule, newest-matched first
// POST {action:'save'}       → create or update one
// POST {action:'archive'}    → soft-retire (never deleted; expense_requests
//                              reference it via applied_rule_id)
// POST {action:'test'}       → dry-run a rule against the last N real bills,
//                              so you can see what it would have claimed
//                              BEFORE it starts claiming things
//
// Read: anyone in Brixpense. Write: staff — matching the RLS.

// ⚠ Accounts-payable only. Bill rules decide the GL coding on emailed vendor
// bills, and the dry-run replays a draft rule against the last 100 REAL
// expenses (vendor, amount, account) through the service role — so the Test
// button was a company-wide expense read for anyone with Brixpense access.
import { opsGet, opsInsert, opsPatch, requireApAdmin } from './lib/ap-inbox.mjs';
import { pickRule, ruleMatches, applyRule, recurringNote } from './lib/expense-rules.mjs';

const PERIODS = ['weekly', 'monthly', 'quarterly', 'annual'];
const ENTITIES = ['brix', 'freeflow', 'shared', 'AS', 'FF'];

const TEXT_COLS = [
  'name', 'match_vendor', 'match_sender', 'match_text',
  'set_department', 'set_entity', 'set_cogs_account_id', 'set_cogs_account_label',
  'set_tag', 'set_job_number', 'set_customer_name', 'set_owner_email', 'set_memo',
  'recurring_period', 'notes',
];
const NUM_COLS = [
  'priority', 'match_min_amount', 'match_max_amount',
  'expected_amount', 'amount_tolerance_pct',
];

function clean(body) {
  const row = {};
  for (const c of TEXT_COLS) {
    if (body[c] === undefined) continue;
    const v = body[c] === null ? null : String(body[c]).trim();
    row[c] = v === '' ? null : v;
  }
  for (const c of NUM_COLS) {
    if (body[c] === undefined) continue;
    if (body[c] === null || body[c] === '') { row[c] = null; continue; }
    const n = Number(body[c]);
    if (!Number.isFinite(n)) throw new Error(`${c} must be a number`);
    row[c] = n;
  }
  if (body.active !== undefined) row.active = !!body.active;
  if (body.recurring !== undefined) row.recurring = !!body.recurring;
  if (row.set_owner_email) row.set_owner_email = row.set_owner_email.toLowerCase();
  return row;
}

function validate(row) {
  if (!row.name) return 'A rule needs a name.';
  const hasCondition = ['match_vendor', 'match_sender', 'match_text']
    .some((c) => row[c]) || row.match_min_amount != null || row.match_max_amount != null;
  // The DB CHECK enforces this too; catching it here gives a sentence instead
  // of a constraint violation. A rule with no conditions matches every bill.
  if (!hasCondition) return 'A rule needs at least one condition, or it would claim every bill that arrives.';
  if (row.recurring_period && !PERIODS.includes(row.recurring_period)) {
    return `recurring_period must be one of ${PERIODS.join(', ')}.`;
  }
  if (row.set_entity && !ENTITIES.includes(row.set_entity)) {
    return `entity must be one of ${ENTITIES.join(', ')}.`;
  }
  if (row.match_min_amount != null && row.match_max_amount != null
      && row.match_min_amount > row.match_max_amount) {
    return 'The minimum amount is above the maximum, so nothing could ever match.';
  }
  if (row.set_cogs_account_id && !row.set_cogs_account_label) {
    return 'Give the GL account a label as well — a row that shows one account and posts to another is worse than no rule.';
  }
  return null;
}

export default async function handler(req) {
  const auth = await requireApAdmin(req);
  if (!auth.ok) return auth.response;
  const isStaff = auth.isStaff;

  if (req.method === 'GET') {
    try {
      const rules = await opsGet(
        'expense_rules?archived_at=is.null&order=priority.asc,created_at.asc&limit=500&select=*',
      );
      return Response.json({ ok: true, rules, can_edit: isStaff });
    } catch (e) {
      return Response.json({ error: String(e?.message || e) }, { status: 500 });
    }
  }

  if (req.method !== 'POST') return Response.json({ error: 'GET or POST' }, { status: 405 });

  let body = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = body.action || 'save';

  // ── Dry run: what WOULD this rule have done? ──
  // Available to anyone who can read rules — it writes nothing, and being able
  // to check a rule before trusting it is the whole point.
  if (action === 'test') {
    try {
      const draft = clean(body.rule || {});
      const bad = validate(draft);
      if (bad) return Response.json({ error: bad }, { status: 400 });

      const recent = await opsGet(
        'expense_requests?archived_at=is.null&order=created_at.desc&limit=100'
        + '&select=id,vendor_name,submitter_email,memo,bill_number,total_amount,line_items,created_at,tag',
      );
      const matched = [];
      for (const r of recent) {
        const bill = {
          vendor: r.vendor_name,
          from_email: r.submitter_email,
          subject: null,
          memo: r.memo,
          bill_number: r.bill_number,
          total: r.total_amount == null ? null : Number(r.total_amount),
          line_items: r.line_items,
        };
        const hit = ruleMatches({ ...draft, active: true }, bill);
        if (!hit) continue;
        matched.push({
          id: r.id,
          vendor: r.vendor_name,
          amount: r.total_amount == null ? null : Number(r.total_amount),
          date: (r.created_at || '').slice(0, 10),
          why: hit.why,
          would_set: applyRule(draft, bill),
          recurring_note: recurringNote(draft, bill),
        });
      }
      return Response.json({
        ok: true,
        scanned: recent.length,
        matched: matched.length,
        sample: matched.slice(0, 25),
      });
    } catch (e) {
      return Response.json({ error: String(e?.message || e) }, { status: 500 });
    }
  }

  if (!isStaff) {
    return Response.json({ error: 'Only staff can change rules.' }, { status: 403 });
  }

  try {
    if (action === 'archive') {
      const id = String(body.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: 'id required' }, { status: 400 });
      await opsPatch('expense_rules', `id=eq.${id}`, {
        archived_at: new Date().toISOString(), active: false,
      });
      return Response.json({ ok: true, archived: id });
    }

    if (action === 'save') {
      const row = clean(body);
      const id = body.id ? String(body.id) : null;

      if (id) {
        if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: 'bad id' }, { status: 400 });
        // Validate the MERGED rule, not the patch — a partial update that
        // clears the last condition would otherwise slip past.
        const existing = (await opsGet(`expense_rules?id=eq.${id}&select=*&limit=1`))?.[0];
        if (!existing) return Response.json({ error: 'Rule not found' }, { status: 404 });
        const bad = validate({ ...existing, ...row });
        if (bad) return Response.json({ error: bad }, { status: 400 });
        await opsPatch('expense_rules', `id=eq.${id}`, row);
        return Response.json({ ok: true, id });
      }

      const bad = validate(row);
      if (bad) return Response.json({ error: bad }, { status: 400 });
      const created = await opsInsert('expense_rules', {
        ...row,
        created_by_email: auth.user?.email || null,
      });
      return Response.json({ ok: true, id: created?.id, rule: created });
    }

    return Response.json({ error: `unknown action ${action}` }, { status: 400 });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

export const config = { path: '/api/expense-rules' };
