// The 3rd-party service margin report, pinned against the real August 2026
// shape of THE MELT RESQ — the month it was built from and hand-checked in SQL.
//
// The fixture is deliberately made of REAL rows (real job numbers, real vendor
// names, the real duplicate pair QBO 173048/173049) rather than tidy invented
// ones, because every case worth testing here is a mess the pipeline actually
// produced: a job billed below cost, a vendor bill on a job number that is not
// an SF job id, a bill still sitting in draft, a $0 warranty invoice, and a
// cost dated in a neighbouring month that still belongs to this month's job.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildServiceMarginReport, renderReportHtml, renderReportText,
  monthBounds, previousMonth, lastCompletedMonth, billAmount, pgList,
} from '../netlify/functions/lib/service-margin.mjs';

const ACCOUNTS = [
  { qbo_customer_id: '1944', display_name: 'THE MELT RESQ' },
  { qbo_customer_id: '1945', display_name: 'STARBIRD CHICKEN RESQ' },
];

// invoice: [id, doc, date, sf_job_id, total, balance]
const MELT_AUG = [
  [1, '9989020257', '2026-08-04', '1093626679', 325.00, 325.00],
  [2, '9989020245', '2026-08-04', '1093648356', 174.96, 174.96],
  [3, '9989020387', '2026-08-11', '1094518903', 487.50, 487.50],   // the duplicate job
  [4, '9989020388', '2026-08-11', '1094627586', 125.33, 125.33],   // cost > revenue
  [5, '9989020366', '2026-08-11', '10292534',  4422.48, 4422.48],  // no cost recorded
  [6, '9989020453', '2026-08-14', '1094523212', 424.56, 424.56],   // draft bill
  [7, '9989020457', '2026-08-17', '1094865346',    0.00,    0.00], // warranty, $0
  [8, 'BTRF-0826-1944', '2026-08-01', null,        7.50,    7.50], // no job — tank rental
];

const MELT_BILLS = [
  // job-matched
  { id: 'a', job_number: '1093626679', vendor_name: 'Eric Serrano',   total_amount: '250.00', receipt_date: '2026-08-04', status: 'posted' },
  // dated in JULY, belongs to an August-invoiced job — the whole point of matching on the job
  { id: 'b', job_number: '1093648356', vendor_name: 'Pro Mechanical Services', total_amount: '134.59', receipt_date: '2026-07-31', status: 'posted' },
  { id: 'c', job_number: '1094518903', vendor_name: 'ARTURO SANTIAGO', total_amount: '375.00', receipt_date: '2026-08-11', status: 'posted', qbo_bill_id: '173048' },
  { id: 'd', job_number: '1094518903', vendor_name: 'ARTURO SANTIAGO', total_amount: '375.00', receipt_date: '2026-08-11', status: 'posted', qbo_bill_id: '173049' },
  { id: 'e', job_number: '1094627586', vendor_name: 'ORIGINS CRAFT SODA', total_amount: '600.00', receipt_date: '2026-08-10', status: 'posted' },
  { id: 'f', job_number: '1094523212', vendor_name: 'PRO MECHANICAL', total_amount: '326.59', receipt_date: '2026-08-14', status: 'draft' },
  // archived rows must not count
  { id: 'g', job_number: '1093626679', vendor_name: 'Eric Serrano', total_amount: '250.00', receipt_date: '2026-08-04', status: 'posted', archived_at: '2026-08-20T00:00:00Z' },
  // in-month, job number is not an SF job id and appears on no invoice anywhere
  { id: 'h', job_number: 'ResQ-R1061326-PMS', vendor_name: 'PRO MECHANICAL', total_amount: '3401.91', receipt_date: '2026-08-11', status: 'draft' },
];

function stubOps({ accounts = ACCOUNTS, invoices = MELT_AUG, bills = MELT_BILLS } = {}) {
  const calls = [];
  return {
    calls,
    async opsGet(qs) {
      calls.push(qs);
      if (qs.startsWith('qbo_customers?')) return accounts;

      if (qs.startsWith('qbo_invoices?customer_ref_id=')) {
        const id = decodeURIComponent(/customer_ref_id=eq\.([^&]+)/.exec(qs)[1]);
        const from = /txn_date=gte\.([\d-]+)/.exec(qs)[1];
        const to = /txn_date=lte\.([\d-]+)/.exec(qs)[1];
        if (id !== '1944') return [];
        return invoices
          .filter(([, , d]) => d >= from && d <= to)
          .map(([iid, doc, date, job, total, balance]) => ({
            id: iid, doc_number: doc, txn_date: date, sf_job_id: job,
            total_amount: total, balance, status: balance > 0 ? 'open' : 'paid',
            txn_type: 'Invoice',
          }));
      }

      // "is this job on ANY invoice" probe
      if (qs.startsWith('qbo_invoices?sf_job_id=in.')) {
        const wanted = qs.slice(qs.indexOf('in.(') + 4, qs.lastIndexOf(')')).replace(/"/g, '').split(',');
        return invoices.filter(([, , , job]) => job && wanted.includes(job)).map(([, , , job]) => ({ sf_job_id: job }));
      }

      if (qs.startsWith('qbo_invoice_lines?')) {
        return [{ invoice_id: 1, item_name: 'MSL-1', revenue_line: 'Service - General', amount: 325 }];
      }

      if (qs.startsWith('expense_requests?archived_at=is.null&customer_name=')) {
        const name = decodeURIComponent(/customer_name=eq\.([^&]+)/.exec(qs)[1]);
        const from = /receipt_date=gte\.([\d-]+)/.exec(qs)[1];
        const to = /receipt_date=lte\.([\d-]+)/.exec(qs)[1];
        if (name !== 'THE MELT RESQ') return [];
        return bills.filter((b) => !b.archived_at && b.receipt_date >= from && b.receipt_date <= to);
      }

      if (qs.startsWith('expense_requests?job_number=in.')) {
        const wanted = qs.slice(qs.indexOf('in.(') + 4, qs.lastIndexOf(')')).replace(/"/g, '').split(',');
        return bills.filter((b) => wanted.includes(b.job_number));
      }

      throw new Error(`unexpected query: ${qs}`);
    },
  };
}

const build = (over) => buildServiceMarginReport({ month: '2026-08', comparePrior: false, ...stubOps(over) });

test('month bounds handle leap years and year boundaries', () => {
  assert.equal(monthBounds('2026-08').end, '2026-08-31');
  assert.equal(monthBounds('2026-02').end, '2026-02-28');
  assert.equal(monthBounds('2024-02').end, '2024-02-29');
  assert.equal(previousMonth('2026-01'), '2025-12');
  assert.equal(lastCompletedMonth(new Date('2026-01-03T00:00:00Z')), '2025-12');
  assert.throws(() => monthBounds('2026-13'), /out of range/);
  assert.throws(() => monthBounds('August'), /YYYY-MM/);
});

test('a credit carries its sign from the flag, not the amount', () => {
  assert.equal(billAmount({ total_amount: '100', is_credit: false }), 100);
  assert.equal(billAmount({ total_amount: '100', is_credit: true }), -100);
});

test('a job number containing a comma cannot widen the filter', () => {
  assert.equal(pgList(['1094518903', 'ResQ-R1,PMS']), '("1094518903","ResQ-R1,PMS")');
  assert.match(pgList(['a"b']), /"a\\"b"/);
});

test('revenue and cost meet on the job, not the calendar month', async () => {
  const r = await build();
  const melt = r.accounts.find((a) => a.name === 'THE MELT RESQ');

  // The Pro Mechanical bill is dated 2026-07-31 and still counts: its job was
  // invoiced in August. This is the behaviour the whole report rests on.
  const july = melt.jobs.find((j) => j.jobId === '1093648356');
  assert.equal(july.cost, 134.59);
  assert.equal(july.gp, 40.37);

  assert.equal(melt.revenue, 5967.33);      // every invoice incl. the $7.50 tank rental
  assert.equal(melt.jobRevenue, 5959.83);   // job-linked only
  assert.equal(melt.cost, 2061.18);
  assert.equal(melt.gp, 3898.65);
});

test('an archived vendor bill does not count', async () => {
  const r = await build();
  const job = r.accounts[0].jobs.find((j) => j.jobId === '1093626679');
  assert.equal(job.cost, 250);   // not 500 — the archived twin is excluded
  assert.equal(job.billCount, 1);
});

test('two identical bills on one job are flagged with the exposure and the QBO ids', async () => {
  const r = await build();
  const melt = r.accounts.find((a) => a.name === 'THE MELT RESQ');
  assert.equal(melt.duplicates.length, 1);
  const d = melt.duplicates[0];
  assert.equal(d.jobId, '1094518903');
  assert.equal(d.count, 2);
  assert.equal(d.extra, 375);
  assert.deepEqual(d.refs.sort(), ['173048', '173049']);
  assert.equal(r.totals.duplicateExposure, 375);
});

test('a job billed below cost is called out, a $0 warranty job is not', async () => {
  const r = await build();
  const melt = r.accounts[0];
  const neg = melt.negativeJobs.map((j) => j.jobId).sort();
  assert.deepEqual(neg, ['1094518903', '1094627586']);
  // The $0 invoice has no revenue to be "below", so it must not read as a loss.
  assert.ok(!neg.includes('1094865346'));
  assert.deepEqual(melt.zeroRevenueJobs.map((j) => j.jobId), ['1094865346']);
});

test('cost on a job that was never invoiced is reported, not absorbed', async () => {
  const r = await build();
  const melt = r.accounts[0];
  assert.equal(melt.unbilledCosts.length, 1);
  assert.equal(melt.unbilledCosts[0].jobId, 'ResQ-R1061326-PMS');
  assert.equal(melt.unbilledTotal, 3401.91);
  assert.equal(r.totals.unbilled, 3401.91);
  // and it is NOT counted in the month's cost, which is job-matched
  assert.ok(melt.cost < 3401.91);
});

test('a draft vendor bill counts in cost but is named as unposted', async () => {
  const r = await build();
  const melt = r.accounts[0];
  assert.equal(melt.draftBills.length, 1);
  assert.equal(melt.draftBills[0].vendor, 'PRO MECHANICAL');
  const job = melt.jobs.find((j) => j.jobId === '1094523212');
  assert.equal(job.cost, 326.59);
  assert.ok(job.hasDraft);
});

test('a job with no vendor bill is flagged rather than read as pure profit', async () => {
  const r = await build();
  const melt = r.accounts[0];
  assert.deepEqual(melt.zeroCostJobs.map((j) => j.jobId), ['10292534']);
});

test('an account with no activity still appears, and is named as quiet', async () => {
  const r = await build();
  const sb = r.accounts.find((a) => a.name === 'STARBIRD CHICKEN RESQ');
  assert.equal(sb.invoiceCount, 0);
  assert.equal(sb.revenue, 0);
  assert.match(renderReportHtml(r), /No activity in August 2026: STARBIRD CHICKEN RESQ/);
});

test('no ResQ accounts is an error, never a zero report', async () => {
  await assert.rejects(
    () => buildServiceMarginReport({ month: '2026-08', comparePrior: false, ...stubOps({ accounts: [] }) }),
    /no ResQ accounts found/
  );
});

test('the rendered report states the labor caveat and every exception', async () => {
  const r = await build();
  const html = renderReportHtml(r);
  assert.match(html, /technicians’ time is not included/);
  assert.match(html, /Possible duplicate vendor bills/);
  assert.match(html, /billed below cost/);
  assert.match(html, /no invoice/);
  assert.match(html, /still in draft/);
  assert.match(html, /no cost recorded/);
  assert.match(html, /173048/);
  // The header total and the per-account total must agree.
  assert.match(html, /\$3,898\.65/);

  const text = renderReportText(r);
  assert.match(text, /THE MELT RESQ/);
  assert.match(text, /possible duplicate/);
});

test('vendor names are escaped — they come off OCR, not a controlled list', async () => {
  // The amount is large on purpose: a vendor name only reaches the HTML through
  // an exception block, so a cheap bill would leave this test asserting nothing.
  const bills = [{ id: 'x', job_number: '1093626679', vendor_name: '<script>alert(1)</script>', total_amount: '9999', receipt_date: '2026-08-04', status: 'posted' }];
  const r = await buildServiceMarginReport({ month: '2026-08', comparePrior: false, ...stubOps({ bills }) });
  const html = renderReportHtml(r);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});

// --- The Master Control panel -------------------------------------------
// control.html has no module loader and no build step, so its handler can only
// be checked by pulling it out of the page and running it. Two things here are
// worth pinning because both fail silently in a browser: the month the buttons
// default to (the report is for the month that just ENDED, not this one), and
// that Preview goes through a blob URL — the endpoint is superadmin-gated and a
// bare window.open carries no Authorization header, so a plain link can only
// ever render a 401.

import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../public/control.html', import.meta.url), 'utf8');
const LEGACY_BASE = 'https://stub.test/.netlify/functions';
const API_BASE = 'https://stub.test/api';

test('the panel is wired to the ids its handler looks up', () => {
  for (const id of ['marginMonth', 'marginPreviewBtn', 'marginSendBtn']) {
    assert.ok(PAGE.includes(`id="${id}"`), `missing element #${id}`);
  }
  assert.match(PAGE, /onclick="runServiceMargin\('preview'\)"/);
  assert.match(PAGE, /onclick="runServiceMargin\('send'\)"/);
  // The caveat must survive on the page, not just in the email.
  assert.match(PAGE, /own techs' time is not in it/);
});

function loadPanelFns(stubs) {
  const src = /\/\/ --- 3rd-Party Service Margin report ---[\s\S]*?\n\}\n(?=\n)/.exec(PAGE);
  assert.ok(src, 'could not extract the panel handler from control.html');
  // Both bases are supplied so the handler runs, and the test then asserts
  // WHICH one it used — calling the legacy base is the bug this pins.
  const factory = new Function(
    'document', 'fetch', 'URL', 'window', 'confirm', 'alert', 'log',
    'APBG_FN', 'APBG_API', 'authHeaders', 'setTimeout', 'Blob',
    `${src[0]}; return { marginMonthValue, runServiceMargin };`
  );
  return factory(
    stubs.document, stubs.fetch, stubs.URL, stubs.window, stubs.confirm,
    stubs.alert, stubs.log, LEGACY_BASE, API_BASE, stubs.authHeaders, stubs.setTimeout, stubs.Blob
  );
}

function panelStubs({ ok = true, body = '<h1>report</h1>', json = null, monthValue = '' } = {}) {
  const state = { requests: [], opened: [], logs: [], alerts: [], revoked: 0 };
  const btn = () => ({ disabled: false, textContent: 'x' });
  const els = { marginMonth: { value: monthValue }, marginPreviewBtn: btn(), marginSendBtn: btn() };
  return {
    state,
    stubs: {
      document: { getElementById: (id) => els[id] || null },
      fetch: async (url, opts) => {
        state.requests.push({ url, headers: opts?.headers });
        return {
          ok, status: ok ? 200 : 401,
          text: async () => body,
          json: async () => json,
        };
      },
      URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => { state.revoked += 1; } },
      window: { open: (u, t) => state.opened.push({ u, t }) },
      confirm: () => true,
      alert: (m) => state.alerts.push(m),
      log: (m, lvl) => state.logs.push({ m, lvl }),
      authHeaders: () => ({ Authorization: 'Bearer stub' }),
      setTimeout: () => 0,
      Blob: class { constructor(parts, opts) { this.parts = parts; this.opts = opts; } },
    },
  };
}

test('the panel defaults to the month that just ended, not the current one', () => {
  const { stubs } = panelStubs();
  const { marginMonthValue } = loadPanelFns(stubs);
  const now = new Date();
  const expect = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  assert.equal(
    marginMonthValue(),
    `${expect.getUTCFullYear()}-${String(expect.getUTCMonth() + 1).padStart(2, '0')}`
  );
  assert.equal(marginMonthValue(), lastCompletedMonth(now), 'page and server must agree on the default month');
});

test('a month typed into the picker wins over the default', () => {
  const { stubs } = panelStubs({ monthValue: '2026-03' });
  assert.equal(loadPanelFns(stubs).marginMonthValue(), '2026-03');
});

test('preview sends the bearer, asks for preview, and opens a blob — never a bare link', async () => {
  const { state, stubs } = panelStubs({ monthValue: '2026-08' });
  await loadPanelFns(stubs).runServiceMargin('preview');
  assert.equal(state.requests.length, 1);
  const req = state.requests[0];
  assert.match(req.url, /service-margin-report\?month=2026-08&preview=1/);
  assert.equal(req.headers.Authorization, 'Bearer stub');
  // The function declares config.path '/api/service-margin-report', so the
  // legacy /.netlify/functions route 404s. Calling the right base is the point.
  assert.ok(req.url.startsWith(API_BASE), `expected the /api base, got ${req.url}`);
  assert.ok(!req.url.includes('/.netlify/functions/'), 'called the legacy route');
  assert.deepEqual(state.opened, [{ u: 'blob:stub', t: '_blank' }]);
});

test('emailing it omits preview and reports what the server said', async () => {
  const { state, stubs } = panelStubs({
    monthValue: '2026-08',
    json: { label: 'August 2026', sent: true, to: ['service@brixbev.com'], totals: { jobRevenue: 1, gp: 2 } },
  });
  await loadPanelFns(stubs).runServiceMargin('send');
  assert.match(state.requests[0].url, /month=2026-08$/);
  assert.ok(!state.requests[0].url.includes('preview'));
  assert.equal(state.logs[0].lvl, 'ok');
  assert.match(state.logs[0].m, /August 2026/);
});

test('a refused request surfaces the status instead of opening an empty tab', async () => {
  const { state, stubs } = panelStubs({ ok: false, body: 'Forbidden', monthValue: '2026-08' });
  await loadPanelFns(stubs).runServiceMargin('preview');
  assert.equal(state.opened.length, 0);
  assert.match(state.alerts[0], /HTTP 401/);
  assert.equal(state.logs[0].lvl, 'error');
});
