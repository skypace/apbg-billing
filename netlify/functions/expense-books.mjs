// expense-books.mjs — expense report books.
//
// A book bundles expenses that belong together for reporting, ACROSS payment
// types: a card charge, a check, an emailed vendor bill and an SF job expense
// can all sit in one book tied to a job or tag. Membership is explicit rather
// than a saved filter, because the whole point is grouping things a filter
// would not naturally group.
//
// GET                          → every book with its totals
// GET ?id=<uuid>               → one book, its lines, and its totals
// GET ?id=<uuid>&format=csv    → the same thing as a spreadsheet
// GET ?candidates=1&…          → expenses you could add (filtered)
// POST {action:'save'|'close'|'reopen'|'delete'|'add'|'remove'|'add_many'}
//
// Read: anyone in Brixpense. Write: the book's creator, or staff — matching
// the RLS, which is the real gate.

import { opsGet, opsInsert, opsPatch, srHeaders, requireBrixpense } from './lib/ap-inbox.mjs';
import { SUPABASE_URL } from './supabase-helpers.mjs';

const LINE_COLS = 'id,vendor_name,bill_number,total_amount,receipt_date,status,tag,job_number,'
  + 'customer_name,department,entity,as_bill,payment_account_name,payment_method,'
  + 'cogs_account_label,qbo_bill_id,qbo_purchase_id,submitter_email,created_at';

async function opsDelete(table, filter) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'DELETE', headers: srHeaders({ Prefer: 'return=minimal' }),
  });
  if (!res.ok) throw new Error(`ops.${table} delete failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/**
 * How an expense was actually paid — the axis an expense report has to be
 * read on, and one that no single column carries.
 */
export function payentRail(r) {
  if (r.as_bill) return r.qbo_bill_id ? 'Bill (posted)' : 'Bill (unposted)';
  if (r.payment_account_name) return r.payment_account_name;
  if (r.payment_method) return r.payment_method;
  return 'Paid — account not recorded';
}

function summarise(lines) {
  const byRail = new Map();
  const byAccount = new Map();
  const byEntity = new Map();
  let total = 0, posted = 0, unposted = 0;

  for (const r of lines) {
    const amt = Number(r.total_amount) || 0;
    total += amt;
    if (r.qbo_bill_id || r.qbo_purchase_id) posted += amt; else unposted += amt;
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + amt);
    bump(byRail, payentRail(r));
    bump(byAccount, r.cogs_account_label || 'Uncoded');
    bump(byEntity, r.entity || 'unset');
  }
  const rows = (m) => [...m.entries()]
    .map(([label, amount]) => ({ label, amount: Math.round(amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount);

  return {
    count: lines.length,
    total: Math.round(total * 100) / 100,
    posted: Math.round(posted * 100) / 100,
    unposted: Math.round(unposted * 100) / 100,
    by_payment: rows(byRail),
    by_account: rows(byAccount),
    by_entity: rows(byEntity),
  };
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  // Excel treats a leading =, +, - or @ as a formula. Vendor names come off
  // OCR'd PDFs, so prefix-quote them rather than hand someone a live formula.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv(book, lines, totals) {
  const out = [];
  out.push(['Expense report', book.name].map(csvCell).join(','));
  if (book.period_start || book.period_end) {
    out.push(['Period', `${book.period_start || ''} to ${book.period_end || ''}`].map(csvCell).join(','));
  }
  for (const [k, v] of [['Tag', book.tag], ['Job', book.job_number],
    ['Customer', book.customer_name], ['Entity', book.entity]]) {
    if (v) out.push([k, v].map(csvCell).join(','));
  }
  out.push(['Total', totals.total.toFixed(2)].map(csvCell).join(','));
  out.push('');
  out.push(['Date', 'Vendor', 'Bill #', 'Amount', 'Paid with', 'GL account',
    'Department', 'Entity', 'Job', 'Customer', 'Posted to QBO', 'Submitted by', 'Note']
    .map(csvCell).join(','));
  for (const r of lines) {
    out.push([
      r.receipt_date || (r.created_at || '').slice(0, 10),
      r.vendor_name, r.bill_number,
      r.total_amount == null ? '' : Number(r.total_amount).toFixed(2),
      payentRail(r), r.cogs_account_label, r.department, r.entity,
      r.job_number, r.customer_name,
      (r.qbo_bill_id || r.qbo_purchase_id) ? 'yes' : 'no',
      r.submitter_email, r._note,
    ].map(csvCell).join(','));
  }
  out.push('');
  out.push(['Totals by payment type'].map(csvCell).join(','));
  for (const b of totals.by_payment) out.push([b.label, b.amount.toFixed(2)].map(csvCell).join(','));
  out.push('');
  out.push(['Totals by GL account'].map(csvCell).join(','));
  for (const b of totals.by_account) out.push([b.label, b.amount.toFixed(2)].map(csvCell).join(','));
  return out.join('\n');
}

async function loadBookLines(bookId) {
  const items = await opsGet(
    `expense_book_items?book_id=eq.${bookId}&order=added_at.asc&limit=1000&select=id,expense_id,note,added_by,added_at`,
  );
  if (!items.length) return { items, lines: [] };
  const ids = items.map((i) => i.expense_id);
  const rows = await opsGet(`expense_requests?id=in.(${ids.join(',')})&select=${LINE_COLS}`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lines = items
    .map((i) => {
      const r = byId.get(i.expense_id);
      return r ? { ...r, _item_id: i.id, _note: i.note } : null;
    })
    .filter(Boolean);
  return { items, lines };
}

export default async function handler(req) {
  const auth = await requireBrixpense(req);
  if (!auth.ok) return auth.response;
  const isStaff = auth.isStaff;
  const me = auth.user?.email || null;
  const url = new URL(req.url);

  const mayEdit = (book) => isStaff || (book?.created_by_email || '').toLowerCase() === String(me).toLowerCase();

  if (req.method === 'GET') {
    try {
      // ── Candidate expenses to add to a book ──
      if (url.searchParams.get('candidates')) {
        const params = ['archived_at=is.null', 'order=created_at.desc', 'limit=200', `select=${LINE_COLS}`];
        const q = (k) => url.searchParams.get(k);
        if (q('tag')) params.push(`tag=eq.${encodeURIComponent(q('tag'))}`);
        if (q('job')) params.push(`job_number=eq.${encodeURIComponent(q('job'))}`);
        if (q('entity')) params.push(`entity=eq.${encodeURIComponent(q('entity'))}`);
        if (q('from')) params.push(`receipt_date=gte.${q('from')}`);
        if (q('to')) params.push(`receipt_date=lte.${q('to')}`);
        if (q('vendor')) params.push(`vendor_name=ilike.*${encodeURIComponent(q('vendor'))}*`);
        const rows = await opsGet(`expense_requests?${params.join('&')}`);
        return Response.json({
          ok: true,
          candidates: rows.map((r) => ({ ...r, paid_with: payentRail(r) })),
        });
      }

      const id = url.searchParams.get('id');
      if (id) {
        if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: 'bad id' }, { status: 400 });
        const book = (await opsGet(`expense_books?id=eq.${id}&select=*&limit=1`))?.[0];
        if (!book) return Response.json({ error: 'Book not found' }, { status: 404 });
        const { lines } = await loadBookLines(id);
        const totals = summarise(lines);

        if (url.searchParams.get('format') === 'csv') {
          const slug = (book.name || 'expense-report').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60);
          return new Response(toCsv(book, lines, totals), {
            status: 200,
            headers: {
              'Content-Type': 'text/csv; charset=utf-8',
              'Content-Disposition': `attachment; filename="${slug}.csv"`,
            },
          });
        }
        return Response.json({
          ok: true, book, totals, can_edit: mayEdit(book),
          lines: lines.map((r) => ({ ...r, paid_with: payentRail(r) })),
        });
      }

      // ── The list ──
      const books = await opsGet('expense_books?order=created_at.desc&limit=200&select=*');
      const totals = books.length
        ? await opsGet(`v_expense_book_totals?book_id=in.(${books.map((b) => b.id).join(',')})&select=*`)
        : [];
      const byId = new Map(totals.map((t) => [t.book_id, t]));
      return Response.json({
        ok: true, me,
        books: books.map((b) => ({
          ...b,
          can_edit: mayEdit(b),
          totals: byId.get(b.id) || { item_count: 0, total_amount: 0 },
        })),
      });
    } catch (e) {
      return Response.json({ error: String(e?.message || e) }, { status: 500 });
    }
  }

  if (req.method !== 'POST') return Response.json({ error: 'GET or POST' }, { status: 405 });

  let body = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = body.action || 'save';

  try {
    if (action === 'save') {
      const fields = {};
      for (const c of ['name', 'description', 'tag', 'job_number', 'customer_name', 'entity']) {
        if (body[c] !== undefined) {
          const v = body[c] === null ? null : String(body[c]).trim();
          fields[c] = v === '' ? null : v;
        }
      }
      for (const c of ['period_start', 'period_end']) {
        if (body[c] !== undefined) fields[c] = body[c] || null;
      }
      if (body.id) {
        const id = String(body.id);
        if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: 'bad id' }, { status: 400 });
        const book = (await opsGet(`expense_books?id=eq.${id}&select=*&limit=1`))?.[0];
        if (!book) return Response.json({ error: 'Book not found' }, { status: 404 });
        if (!mayEdit(book)) return Response.json({ error: 'This is not your book.' }, { status: 403 });
        if (book.status === 'closed') return Response.json({ error: 'Reopen the book before editing it.' }, { status: 409 });
        await opsPatch('expense_books', `id=eq.${id}`, fields);
        return Response.json({ ok: true, id });
      }
      if (!fields.name) return Response.json({ error: 'A report needs a name.' }, { status: 400 });
      const created = await opsInsert('expense_books', {
        ...fields, created_by: auth.user?.id || null, created_by_email: me,
      });
      return Response.json({ ok: true, id: created?.id, book: created });
    }

    // Everything below needs a book we're allowed to touch.
    const bookId = String(body.book_id || body.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(bookId)) return Response.json({ error: 'book_id required' }, { status: 400 });
    const book = (await opsGet(`expense_books?id=eq.${bookId}&select=*&limit=1`))?.[0];
    if (!book) return Response.json({ error: 'Book not found' }, { status: 404 });
    if (!mayEdit(book)) return Response.json({ error: 'This is not your book.' }, { status: 403 });

    if (action === 'close' || action === 'reopen') {
      const closing = action === 'close';
      await opsPatch('expense_books', `id=eq.${bookId}`, {
        status: closing ? 'closed' : 'open',
        closed_at: closing ? new Date().toISOString() : null,
        closed_by: closing ? me : null,
      });
      return Response.json({ ok: true, status: closing ? 'closed' : 'open' });
    }

    if (action === 'delete') {
      // The book is a grouping, not a record of the money — deleting it
      // removes the memberships (ON DELETE CASCADE) and touches no expense.
      await opsDelete('expense_books', `id=eq.${bookId}`);
      return Response.json({ ok: true, deleted: bookId });
    }

    if (book.status === 'closed') {
      return Response.json({ error: 'This report is closed. Reopen it to change what is in it.' }, { status: 409 });
    }

    if (action === 'add' || action === 'add_many') {
      const ids = action === 'add'
        ? [String(body.expense_id || '')]
        : (Array.isArray(body.expense_ids) ? body.expense_ids.map(String) : []);
      const valid = ids.filter((i) => /^[0-9a-f-]{36}$/i.test(i));
      if (!valid.length) return Response.json({ error: 'expense_id(s) required' }, { status: 400 });

      // An expense can sit in more than one book, so re-adding is a no-op
      // rather than an error — the unique index makes that safe.
      let added = 0;
      for (const expenseId of valid) {
        try {
          const row = await opsInsert('expense_book_items', {
            book_id: bookId, expense_id: expenseId,
            note: body.note ? String(body.note).slice(0, 500) : null,
            added_by: me,
          }, { ignoreDuplicates: true });
          if (row) added++;
        } catch (e) {
          // A bad expense id (FK violation) must not abort the rest of a bulk add.
          console.warn('[expense-books] could not add', expenseId, e?.message || e);
        }
      }
      return Response.json({ ok: true, added, requested: valid.length });
    }

    if (action === 'remove') {
      const expenseId = String(body.expense_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(expenseId)) return Response.json({ error: 'expense_id required' }, { status: 400 });
      await opsDelete('expense_book_items', `book_id=eq.${bookId}&expense_id=eq.${expenseId}`);
      return Response.json({ ok: true, removed: expenseId });
    }

    return Response.json({ error: `unknown action ${action}` }, { status: 400 });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

export const config = { path: '/api/expense-books' };
