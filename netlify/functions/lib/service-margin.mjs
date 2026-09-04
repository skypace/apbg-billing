// service-margin.mjs — what we billed a 3rd-party dispatch account for a month,
// what the work cost us, and what is wrong with the picture.
//
// THE ACCOUNTS. A "ResQ account" is a QuickBooks customer whose name contains
// RESQ — today THE MELT RESQ (1944) and STARBIRD CHICKEN RESQ (1945). They are
// discovered by NAME rather than hard-coded ids, so a third chain that signs a
// dispatch agreement is picked up by the next run with no deploy. The trade is
// that renaming one of those customers in QuickBooks drops it out of the
// report — which is why the report prints the accounts it found.
//
// THE MATCH. Every ResQ invoice carries the Service Fusion job it came from in
// ops.qbo_invoices.sf_job_id, and every subcontractor bill carries the same
// number in ops.expense_requests.job_number. That shared key is the whole
// reason this report can exist: revenue and cost meet on the JOB, not on the
// month. A cost billed in September for a job invoiced in August belongs to
// the August job, and that is how it is counted here.
//
// ⚠ THIS IS SUBCONTRACTOR COST ONLY. It is not fully-loaded job cost. Our own
// technicians' time is not in it, because nothing records it: ops.service_jobs
// (the table sync-sf writes tech names into) has taken almost nothing since
// April 2026 — the sync scans ten jobs a run and skips them all while
// reporting success. Until that is fixed, a job our own tech did reads as
// 100% margin here. The report says so on its face rather than leaving a
// reader to assume the number is complete; see `laborCaveat`.
//
// ⚠ A CREDIT IS NEGATIVE. expense_requests.is_credit carries the sign (the
// amount column stays positive — the 2026-08-26 vendor-credit design), so
// summing total_amount without checking the flag overstates cost by twice
// every credit memo.
//
// Consumed by service-margin-report.mjs (monthly email + on-demand preview).

const MONTHS = ['January','February','March','April','May','June','July','August',
  'September','October','November','December'];

export function monthBounds(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || '').trim());
  if (!m) throw new Error(`month must be YYYY-MM, got "${month}"`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error(`month out of range: "${month}"`);
  // Day 0 of the NEXT month is the last day of this one — leap years included.
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return {
    month,
    start: `${m[1]}-${m[2]}-01`,
    end: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}`,
    label: `${MONTHS[mo - 1]} ${y}`,
  };
}

export function previousMonth(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || '').trim());
  if (!m) throw new Error(`month must be YYYY-MM, got "${month}"`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = new Date(Date.UTC(y, mo - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// The month that just ended, in UTC. What the monthly cron reports on.
export function lastCompletedMonth(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
export const money = (v) =>
  `$${(Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const pct = (v) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A vendor bill's signed contribution to cost. See the credit note in the header.
export function billAmount(row) {
  const amt = Number(row?.total_amount) || 0;
  return row?.is_credit ? -amt : amt;
}

// PostgREST in.(...) needs values that contain a comma, quote or paren wrapped
// and escaped. Job numbers are things like "1094518903" and
// "ResQ-R1061326-PMS", but they are OPERATOR-TYPED in Service Fusion, so a
// stray comma is a matter of time — and unescaped it would silently split one
// filter value into two and quietly widen the query.
export function pgList(values) {
  return `(${values
    .map((v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',')})`;
}

// Chunk so a long in.(...) can't blow the URL length limit on a big month.
function chunk(arr, size = 60) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchByKey(opsGet, table, column, values, select) {
  const out = [];
  for (const part of chunk([...new Set(values)].filter(Boolean))) {
    if (!part.length) continue;
    out.push(...(await opsGet(`${table}?${column}=in.${pgList(part)}&select=${select}`)));
  }
  return out;
}

// ---------------------------------------------------------------------------

// One account's numbers for one month.
async function buildAccount(opsGet, account, bounds) {
  const invoices = await opsGet(
    `qbo_invoices?customer_ref_id=eq.${encodeURIComponent(account.qbo_customer_id)}` +
    `&txn_date=gte.${bounds.start}&txn_date=lte.${bounds.end}` +
    `&select=id,doc_number,txn_date,sf_job_id,total_amount,balance,status,txn_type&order=txn_date`
  );

  // A credit memo reduces what we billed. Invoice totals are positive on both
  // types in the mirror, so the sign has to come from txn_type.
  const signed = (inv) => (inv.txn_type === 'CreditMemo' ? -Number(inv.total_amount || 0) : Number(inv.total_amount || 0));

  const jobIds = invoices.map((i) => i.sf_job_id).filter(Boolean);

  const lines = invoices.length
    ? await fetchByKey(opsGet, 'qbo_invoice_lines', 'invoice_id',
        invoices.map((i) => i.id), 'invoice_id,item_name,revenue_line,amount')
    : [];

  // Cost matched on the JOB, whenever the bill was dated.
  const matched = jobIds.length
    ? await fetchByKey(opsGet, 'expense_requests', 'job_number', jobIds,
        'id,job_number,vendor_name,total_amount,is_credit,receipt_date,status,qbo_bill_id,qbo_purchase_id,archived_at')
    : [];
  const liveMatched = matched.filter((e) => !e.archived_at);

  // Everything billed to this account IN the month, to find cost that never
  // reached an invoice. customer_name is what the SF lander stamps.
  const monthBills = await opsGet(
    `expense_requests?archived_at=is.null&customer_name=eq.${encodeURIComponent(account.display_name)}` +
    `&receipt_date=gte.${bounds.start}&receipt_date=lte.${bounds.end}` +
    `&select=id,job_number,vendor_name,total_amount,is_credit,receipt_date,status`
  );

  // A month bill whose job is on NO invoice, at any date — not just this
  // month's. Asking only about this month's invoices would flag every bill for
  // a job invoiced in a neighbouring month as unbilled, which is noise.
  const strayCandidates = monthBills
    .filter((b) => b.job_number && !jobIds.includes(b.job_number))
    .map((b) => b.job_number);
  const everInvoiced = new Set(
    strayCandidates.length
      ? (await fetchByKey(opsGet, 'qbo_invoices', 'sf_job_id', strayCandidates, 'sf_job_id'))
          .map((r) => r.sf_job_id)
      : []
  );
  const unbilledCosts = monthBills.filter(
    (b) => b.job_number && !jobIds.includes(b.job_number) && !everInvoiced.has(b.job_number)
  );

  // Roll cost up per job.
  const costByJob = new Map();
  for (const e of liveMatched) {
    const cur = costByJob.get(e.job_number) || { cost: 0, bills: [] };
    cur.cost = n2(cur.cost + billAmount(e));
    cur.bills.push(e);
    costByJob.set(e.job_number, cur);
  }

  const jobs = invoices
    .filter((i) => i.sf_job_id)
    .map((inv) => {
      const c = costByJob.get(inv.sf_job_id) || { cost: 0, bills: [] };
      const revenue = n2(signed(inv));
      return {
        docNumber: inv.doc_number,
        date: inv.txn_date,
        jobId: inv.sf_job_id,
        revenue,
        cost: n2(c.cost),
        gp: n2(revenue - c.cost),
        margin: revenue > 0 ? (revenue - c.cost) / revenue : null,
        vendors: [...new Set(c.bills.map((b) => b.vendor_name).filter(Boolean))],
        billCount: c.bills.length,
        hasDraft: c.bills.some((b) => b.status === 'draft'),
      };
    });

  const revenue = n2(invoices.reduce((s, i) => s + signed(i), 0));
  const jobRevenue = n2(jobs.reduce((s, j) => s + j.revenue, 0));
  const cost = n2(jobs.reduce((s, j) => s + j.cost, 0));
  const gp = n2(jobRevenue - cost);

  // Two bills on one job from one vendor for one amount is a duplicate until
  // somebody says otherwise. It is the single most expensive error this
  // pipeline makes (the SF re-land, 2026-08-14) and it is invisible in a total.
  const dupes = [];
  for (const [jobId, c] of costByJob) {
    const seen = new Map();
    for (const b of c.bills) {
      const key = `${(b.vendor_name || '').trim().toLowerCase()}|${n2(b.total_amount)}`;
      const list = seen.get(key) || [];
      list.push(b);
      seen.set(key, list);
    }
    for (const [, list] of seen) {
      if (list.length > 1) {
        dupes.push({
          jobId,
          vendor: list[0].vendor_name,
          amount: n2(list[0].total_amount),
          count: list.length,
          extra: n2(list[0].total_amount * (list.length - 1)),
          refs: list.map((b) => b.qbo_bill_id || b.qbo_purchase_id).filter(Boolean),
        });
      }
    }
  }

  const revenueMix = [...lines.reduce((m, l) => {
    const k = l.revenue_line || '(unclassified)';
    m.set(k, n2((m.get(k) || 0) + Number(l.amount || 0)));
    return m;
  }, new Map())].map(([revenueLine, amount]) => ({ revenueLine, amount }))
    .sort((a, b) => b.amount - a.amount);

  const drafts = liveMatched.filter((e) => e.status === 'draft');

  return {
    id: account.qbo_customer_id,
    name: account.display_name,
    invoiceCount: invoices.length,
    revenue,
    jobRevenue,
    cost,
    gp,
    margin: jobRevenue > 0 ? gp / jobRevenue : null,
    jobs: jobs.sort((a, b) => a.gp - b.gp),
    revenueMix,
    outstanding: n2(invoices.reduce((s, i) => s + (Number(i.balance) || 0), 0)),
    // Exceptions — the half of the report that is worth acting on.
    negativeJobs: jobs.filter((j) => j.revenue > 0 && j.gp < 0),
    zeroCostJobs: jobs.filter((j) => j.billCount === 0 && j.revenue > 0),
    zeroRevenueJobs: jobs.filter((j) => j.revenue === 0),
    duplicates: dupes,
    draftBills: drafts.map((e) => ({
      vendor: e.vendor_name, amount: n2(e.total_amount), jobId: e.job_number, date: e.receipt_date,
    })),
    unbilledCosts: unbilledCosts.map((e) => ({
      vendor: e.vendor_name, amount: n2(billAmount(e)), jobId: e.job_number,
      date: e.receipt_date, status: e.status,
    })),
    unbilledTotal: n2(unbilledCosts.reduce((s, e) => s + billAmount(e), 0)),
  };
}

export async function buildServiceMarginReport({ month, opsGet, comparePrior = true }) {
  const bounds = monthBounds(month);

  const accounts = await opsGet(
    'qbo_customers?display_name=ilike.*resq*&select=qbo_customer_id,display_name&order=display_name'
  );
  if (!accounts.length) {
    // Never silently report zero: no accounts found means the name rule stopped
    // matching, which looks identical to a quiet month and is not.
    throw new Error('no ResQ accounts found in ops.qbo_customers — has one been renamed?');
  }

  const results = [];
  for (const a of accounts) results.push(await buildAccount(opsGet, a, bounds));

  let prior = null;
  if (comparePrior) {
    const pb = monthBounds(previousMonth(month));
    const pr = [];
    for (const a of accounts) pr.push(await buildAccount(opsGet, a, pb));
    prior = {
      label: pb.label,
      revenue: n2(pr.reduce((s, r) => s + r.jobRevenue, 0)),
      cost: n2(pr.reduce((s, r) => s + r.cost, 0)),
    };
    prior.gp = n2(prior.revenue - prior.cost);
    prior.margin = prior.revenue > 0 ? prior.gp / prior.revenue : null;
  }

  const revenue = n2(results.reduce((s, r) => s + r.revenue, 0));
  const jobRevenue = n2(results.reduce((s, r) => s + r.jobRevenue, 0));
  const cost = n2(results.reduce((s, r) => s + r.cost, 0));
  const gp = n2(jobRevenue - cost);

  return {
    ...bounds,
    generatedAt: new Date().toISOString(),
    accounts: results,
    totals: {
      revenue, jobRevenue, cost, gp,
      margin: jobRevenue > 0 ? gp / jobRevenue : null,
      outstanding: n2(results.reduce((s, r) => s + r.outstanding, 0)),
      unbilled: n2(results.reduce((s, r) => s + r.unbilledTotal, 0)),
      duplicateExposure: n2(results.reduce((s, r) => s + r.duplicates.reduce((x, d) => x + d.extra, 0), 0)),
    },
    prior,
    laborCaveat:
      'Cost is subcontractor bills only. Our own technicians’ time is not included — ' +
      'ops.service_jobs has recorded almost nothing since April 2026, so a job worked in-house reads here as 100% margin.',
  };
}

// ---------------------------------------------------------------------------
// Rendering. House style: DM Sans, navy #1F4E79 header, #E4E9F0 rules — the
// same chrome as the remittance advice and the PO, so this reads as ours.

function tile(label, value, sub) {
  return `<td style="padding:10px 12px;border:1px solid #E4E9F0;border-radius:8px;vertical-align:top">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#64748B">${esc(label)}</div>
    <div style="font-size:19px;font-weight:700;color:#0F172A;margin-top:3px">${esc(value)}</div>
    ${sub ? `<div style="font-size:11px;color:#64748B;margin-top:2px">${esc(sub)}</div>` : ''}
  </td>`;
}

function warnBlock(title, body) {
  return `<div style="border-left:3px solid #D97706;background:#FFFBEB;padding:10px 12px;margin:10px 0;border-radius:0 6px 6px 0">
    <div style="font-weight:700;color:#92400E;font-size:13px">${esc(title)}</div>
    <div style="font-size:13px;color:#0F172A;margin-top:4px;line-height:1.5">${body}</div>
  </div>`;
}

function jobRows(jobs) {
  if (!jobs.length) return '<tr><td colspan="6" style="padding:8px;color:#64748B;font-size:12px">No job-linked invoices.</td></tr>';
  return jobs
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((j) => {
      const bad = j.revenue > 0 && j.gp < 0;
      const thin = !bad && j.margin !== null && j.margin < 0.1;
      const colour = bad ? '#B91C1C' : thin ? '#B45309' : '#0F172A';
      return `<tr>
        <td style="padding:5px 8px;border-top:1px solid #E4E9F0;font-size:12px;white-space:nowrap">${esc(j.date)}</td>
        <td style="padding:5px 8px;border-top:1px solid #E4E9F0;font-size:12px">${esc(j.docNumber || '—')}</td>
        <td style="padding:5px 8px;border-top:1px solid #E4E9F0;font-size:12px;color:#64748B">${esc(j.jobId)}</td>
        <td style="padding:5px 8px;border-top:1px solid #E4E9F0;font-size:12px;text-align:right">${money(j.revenue)}</td>
        <td style="padding:5px 8px;border-top:1px solid #E4E9F0;font-size:12px;text-align:right">${j.billCount ? money(j.cost) : '<span style="color:#94A3B8">none recorded</span>'}</td>
        <td style="padding:5px 8px;border-top:1px solid #E4E9F0;font-size:12px;text-align:right;color:${colour};font-weight:${bad || thin ? 700 : 400}">${money(j.gp)}${j.margin !== null ? ` <span style="color:#94A3B8;font-weight:400">${pct(j.margin)}</span>` : ''}</td>
      </tr>`;
    })
    .join('');
}

function accountSection(a) {
  const warnings = [];

  if (a.duplicates.length) {
    warnings.push(warnBlock(
      `Possible duplicate vendor bills — ${money(a.duplicates.reduce((s, d) => s + d.extra, 0))} overstated`,
      a.duplicates.map((d) =>
        `${esc(d.vendor)} · ${money(d.amount)} × ${d.count} on job ${esc(d.jobId)}` +
        (d.refs.length ? ` (QBO ${d.refs.map(esc).join(', ')})` : '')).join('<br>') +
      '<br><span style="color:#64748B">Same vendor, same amount, same job. Delete the extra in QuickBooks if confirmed.</span>'
    ));
  }

  if (a.negativeJobs.length) {
    warnings.push(warnBlock(
      `${a.negativeJobs.length} job${a.negativeJobs.length > 1 ? 's' : ''} billed below cost`,
      a.negativeJobs.map((j) =>
        `${esc(j.docNumber)} · job ${esc(j.jobId)} — billed ${money(j.revenue)}, cost ${money(j.cost)} → <b>${money(j.gp)}</b>` +
        (j.vendors.length ? ` <span style="color:#64748B">(${j.vendors.map(esc).join(', ')})</span>` : '')).join('<br>')
    ));
  }

  if (a.unbilledCosts.length) {
    warnings.push(warnBlock(
      `${money(a.unbilledTotal)} of vendor cost on jobs with no invoice`,
      a.unbilledCosts.map((c) =>
        `${esc(c.vendor)} · ${money(c.amount)} · job ${esc(c.jobId)} · ${esc(c.date)}${c.status === 'draft' ? ' <span style="color:#B45309">(draft)</span>' : ''}`).join('<br>') +
      '<br><span style="color:#64748B">Either billed under a different job number, or not billed at all.</span>'
    ));
  }

  if (a.draftBills.length) {
    warnings.push(warnBlock(
      `${a.draftBills.length} vendor bill${a.draftBills.length > 1 ? 's' : ''} still in draft`,
      a.draftBills.map((d) => `${esc(d.vendor)} · ${money(d.amount)} · job ${esc(d.jobId)}`).join('<br>') +
      '<br><span style="color:#64748B">Counted in the cost above, but not yet posted to QuickBooks.</span>'
    ));
  }

  if (a.zeroCostJobs.length) {
    const tot = a.zeroCostJobs.reduce((s, j) => s + j.revenue, 0);
    warnings.push(warnBlock(
      `${a.zeroCostJobs.length} job${a.zeroCostJobs.length > 1 ? 's' : ''} with no cost recorded — ${money(tot)} billed`,
      'Worked in-house, or the vendor bill has not landed yet. These show as 100% margin and inflate the total.'
    ));
  }

  const noRevenue = a.zeroRevenueJobs.length
    ? `<div style="font-size:12px;color:#64748B;margin-top:6px">${a.zeroRevenueJobs.length} job${a.zeroRevenueJobs.length > 1 ? 's' : ''} invoiced at $0 (warranty / no-charge).</div>`
    : '';

  return `
  <h2 style="font-size:15px;margin:26px 0 8px;color:#1F4E79;border-bottom:2px solid #1F4E79;padding-bottom:4px">${esc(a.name)}</h2>
  <table style="border-collapse:separate;border-spacing:6px 0;width:100%;margin:8px 0"><tr>
    ${tile('Billed', money(a.revenue), `${a.invoiceCount} invoice${a.invoiceCount === 1 ? '' : 's'}`)}
    ${tile('Subcontractor cost', money(a.cost), 'matched on the job')}
    ${tile('Gross profit', money(a.gp), pct(a.margin))}
    ${tile('Still unpaid', money(a.outstanding), 'as of this run')}
  </tr></table>
  ${warnings.join('')}
  ${a.jobs.length ? `
  <table style="border-collapse:collapse;width:100%;margin-top:10px">
    <tr style="background:#F8FAFC">
      <th align="left" style="padding:6px 8px;font-size:11px;text-transform:uppercase;color:#64748B">Date</th>
      <th align="left" style="padding:6px 8px;font-size:11px;text-transform:uppercase;color:#64748B">Invoice</th>
      <th align="left" style="padding:6px 8px;font-size:11px;text-transform:uppercase;color:#64748B">SF job</th>
      <th align="right" style="padding:6px 8px;font-size:11px;text-transform:uppercase;color:#64748B">Billed</th>
      <th align="right" style="padding:6px 8px;font-size:11px;text-transform:uppercase;color:#64748B">Cost</th>
      <th align="right" style="padding:6px 8px;font-size:11px;text-transform:uppercase;color:#64748B">GP</th>
    </tr>
    ${jobRows(a.jobs)}
  </table>` : '<div style="font-size:13px;color:#64748B;margin-top:6px">No activity this month.</div>'}
  ${noRevenue}`;
}

export function renderReportHtml(r) {
  const t = r.totals;
  const delta = r.prior && r.prior.revenue
    ? `vs ${r.prior.label}: ${money(r.prior.revenue)} billed · ${pct(r.prior.margin)}`
    : null;

  const quiet = r.accounts.filter((a) => a.invoiceCount === 0).map((a) => a.name);

  return `<div style="font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:760px;margin:0 auto">
  <div style="background:#1F4E79;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">
    <div style="font-size:17px;font-weight:700">3rd-Party Service Margin — ${esc(r.label)}</div>
    <div style="font-size:12px;opacity:.85;margin-top:2px">ResQ dispatch accounts · what we billed, what the work cost</div>
  </div>
  <div style="border:1px solid #E4E9F0;border-top:none;border-radius:0 0 10px 10px;padding:18px 20px;color:#0F172A">

    <table style="border-collapse:separate;border-spacing:6px 0;width:100%"><tr>
      ${tile('Billed', money(t.revenue), `${r.accounts.reduce((s, a) => s + a.invoiceCount, 0)} invoices`)}
      ${tile('Subcontractor cost', money(t.cost), null)}
      ${tile('Gross profit', money(t.gp), pct(t.margin))}
      ${tile('Still unpaid', money(t.outstanding), null)}
    </tr></table>
    ${delta ? `<div style="font-size:12px;color:#64748B;margin-top:8px">${esc(delta)}</div>` : ''}

    <div style="border-left:3px solid #94A3B8;background:#F8FAFC;padding:9px 12px;margin:14px 0;border-radius:0 6px 6px 0;font-size:12px;color:#475569;line-height:1.5">
      <b>What this number is.</b> Revenue and cost are matched on the Service Fusion job, not the calendar —
      a bill dated next month for a job invoiced this month counts here.
      ${esc(r.laborCaveat)}
    </div>

    ${t.duplicateExposure > 0 || t.unbilled > 0 ? `
    <div style="border-left:3px solid #B91C1C;background:#FEF2F2;padding:10px 12px;margin:12px 0;border-radius:0 6px 6px 0;font-size:13px;color:#0F172A">
      <b style="color:#991B1B">Needs a decision this month</b><br>
      ${t.duplicateExposure > 0 ? `${money(t.duplicateExposure)} of suspected duplicate vendor bills.<br>` : ''}
      ${t.unbilled > 0 ? `${money(t.unbilled)} of vendor cost sitting on jobs with no invoice.` : ''}
    </div>` : ''}

    ${r.accounts.filter((a) => a.invoiceCount > 0).map(accountSection).join('')}

    ${quiet.length ? `<div style="font-size:12px;color:#64748B;margin-top:20px;border-top:1px solid #E4E9F0;padding-top:10px">
      No activity in ${esc(r.label)}: ${quiet.map(esc).join(', ')}.</div>` : ''}

    <div style="font-size:11px;color:#94A3B8;margin-top:18px;border-top:1px solid #E4E9F0;padding-top:10px">
      Generated ${esc(r.generatedAt.slice(0, 16).replace('T', ' '))} UTC from the QuickBooks mirror and Brixpense.
      Accounts are found by name (any QuickBooks customer containing “RESQ”): ${r.accounts.map((a) => esc(a.name)).join(', ')}.
    </div>
  </div>
</div>`;
}

export function renderReportText(r) {
  const t = r.totals;
  const L = [
    `3rd-Party Service Margin — ${r.label}`,
    '',
    `Billed              ${money(t.revenue)}`,
    `Subcontractor cost  ${money(t.cost)}`,
    `Gross profit        ${money(t.gp)}  (${pct(t.margin)})`,
    `Still unpaid        ${money(t.outstanding)}`,
    '',
    r.laborCaveat,
    '',
  ];
  for (const a of r.accounts) {
    L.push(`--- ${a.name} ---`);
    if (!a.invoiceCount) { L.push('  no activity', ''); continue; }
    L.push(`  billed ${money(a.revenue)} · cost ${money(a.cost)} · GP ${money(a.gp)} (${pct(a.margin)})`);
    if (a.duplicates.length) L.push(`  ! ${a.duplicates.length} possible duplicate bill(s)`);
    if (a.negativeJobs.length) L.push(`  ! ${a.negativeJobs.length} job(s) billed below cost`);
    if (a.unbilledCosts.length) L.push(`  ! ${money(a.unbilledTotal)} cost with no invoice`);
    if (a.draftBills.length) L.push(`  ! ${a.draftBills.length} vendor bill(s) still in draft`);
    L.push('');
  }
  return L.join('\n');
}
