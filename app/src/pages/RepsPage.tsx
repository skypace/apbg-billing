import { useEffect, useState } from 'react';
import { KPICard } from '../components/KPICard';
import { fm, fp } from '../lib/formatters';
import { btnDanger, btnPrimary, btnSecondary, inp } from '../lib/styles';
import { sbDelete, sbInsert, sbUpdate } from '../lib/rpc';
import { SB_KEY, SB_URL, _sbToken } from '../lib/supabase';
import {
  CommissionRule,
  RepScorecardRow,
  fetchCommissionRules,
  fetchRepScorecard,
} from '../lib/reps';
import { RepBookView } from './reps/RepBookView';

export function RepsPage() {
  const today = new Date().toISOString().slice(0, 10);
  const ytdStart = new Date().getFullYear() + '-01-01';

  const [start, setStart] = useState(ytdStart);
  const [end, setEnd] = useState(today);
  const [rows, setRows] = useState<RepScorecardRow[] | null>(null);
  const [rules, setRules] = useState<Record<string, CommissionRule>>({});
  const [activeRep, setActiveRep] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  function loadAll() {
    Promise.all([fetchRepScorecard(start, end), fetchCommissionRules()])
      .then(([rs, cr]) => {
        setRows(rs ?? []);
        const byCode: Record<string, CommissionRule> = {};
        for (const r of cr ?? []) byCode[r.rep_code] = r;
        setRules(byCode);
      })
      .catch(() => setRows([]));
  }
  useEffect(loadAll, [start, end]);

  function saveRule(rep_code: string, patch: Partial<CommissionRule>) {
    if (rules[rep_code]) {
      sbUpdate<CommissionRule>('commission_rules', 'rep_code=eq.' + encodeURIComponent(rep_code), {
        ...patch,
        updated_at: new Date().toISOString(),
      } as Partial<CommissionRule>).then(loadAll);
    } else {
      sbInsert<Partial<CommissionRule>>('commission_rules', {
        rep_code,
        rate_revenue: 0,
        rate_margin: 0,
        draw_monthly: 0,
        applies_to: 'primary',
        ...patch,
      }).then(loadAll);
    }
  }

  function deleteRule(rep_code: string) {
    if (!confirm('Remove commission rule for ' + rep_code + '?')) return;
    sbDelete('commission_rules', 'rep_code=eq.' + encodeURIComponent(rep_code)).then(loadAll);
  }

  async function pushReps(commit: boolean) {
    setMsg(commit ? 'pushing to QBO…' : 'dry-run…');
    try {
      const token = await _sbToken();
      const res = await fetch(SB_URL + '/functions/v1/push-qbo-sales-rep', {
        method: 'POST',
        headers: {
          apikey: SB_KEY,
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ commit }),
      });
      const j = await res.json();
      if (!j.ok) { setMsg('FAIL: ' + (j.error ?? 'unknown')); return; }
      const s = j.summary || {};
      setMsg(
        (commit ? 'COMMITTED ' : 'DRY-RUN ') +
        'updated=' + (s.updated || 0) +
        ' would_update=' + (s.would_update || 0) +
        ' already_correct=' + (s.already_correct || 0) +
        ' skipped_no_field=' + (s.skipped_no_field?.length || 0) +
        ' errors=' + (s.errors?.length || 0) +
        (j.setup_note ? ' · ' + j.setup_note : ''),
      );
    } catch (e) {
      setMsg('ERROR: ' + (e as Error).message);
    }
  }

  if (activeRep) {
    return <RepBookView repCode={activeRep} start={start} end={end} onBack={() => setActiveRep(null)} />;
  }

  if (!rows) return <div className="ld">Loading reps…</div>;

  const totals = rows.reduce(
    (t, r) => {
      t.rev += Number(r.revenue ?? 0);
      t.margin += Number(r.est_margin ?? 0);
      t.commission += Number(r.commission ?? 0);
      t.customers += Number(r.customer_count ?? 0);
      return t;
    },
    { rev: 0, margin: 0, commission: 0, customers: 0 },
  );

  return (
    <div>
      <div className="pt">Sales Reps <span className="bg bg-l">PERFORMANCE</span></div>

      <div className="gr g4" style={{ marginBottom: 12 }}>
        <KPICard title="TOTAL REVENUE" value={fm(totals.rev)} sub={rows.length + ' active reps'} />
        <KPICard
          title="TOTAL EST MARGIN"
          value={fm(totals.margin)}
          sub={totals.rev > 0 ? fp(totals.margin / totals.rev) : '—'}
        />
        <KPICard title="CUSTOMERS COVERED" value={totals.customers} sub="unique customer-rep links" />
        <KPICard
          title="EARNED COMMISSION"
          value={fm(totals.commission)}
          accent="var(--ac)"
          sub="rate × revenue + rate × margin"
        />
      </div>

      <div
        className="cd"
        style={{
          padding: '10px 12px',
          marginBottom: 10,
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
          fontSize: 11,
        }}
      >
        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>Period</span>
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} style={inp()} />
        <span style={{ color: 'var(--mt)' }}>to</span>
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} style={inp()} />
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={() => pushReps(false)} style={btnSecondary()}>PUSH REPS TO QBO (DRY)</button>
          <button onClick={() => pushReps(true)} style={btnPrimary()}>PUSH REPS TO QBO (COMMIT)</button>
        </span>
      </div>

      {msg && (
        <div
          style={{
            padding: '8px 12px',
            marginBottom: 10,
            fontSize: 11,
            color: 'var(--mt)',
            background: 'var(--sf2)',
            border: '1px solid var(--bd)',
            borderRadius: 4,
          }}
        >
          {msg}
        </div>
      )}

      <div className="cd" style={{ padding: 0 }}>
        {rows.length === 0 ? (
          <div className="ld">
            No reps configured. Add reps in Settings → Sales Reps and assign customers to reps.
          </div>
        ) : (
          <div style={{ maxHeight: '62vh', overflow: 'auto' }}>
            <table>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                <tr>
                  <th>Rep</th>
                  <th style={{ textAlign: 'right' }}>Customers</th>
                  <th style={{ textAlign: 'right' }}>Active 30d</th>
                  <th style={{ textAlign: 'right' }}>Inactive 60d</th>
                  <th style={{ textAlign: 'right' }}>Invoices</th>
                  <th style={{ textAlign: 'right' }}>Revenue</th>
                  <th style={{ textAlign: 'right' }}>Margin</th>
                  <th style={{ textAlign: 'right' }}>Margin %</th>
                  <th style={{ textAlign: 'right' }}>AOV</th>
                  <th style={{ textAlign: 'right' }}>Rate Rev</th>
                  <th style={{ textAlign: 'right' }}>Rate GP</th>
                  <th style={{ textAlign: 'right' }}>Commission</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const rule = rules[r.rep_code];
                  const rRev = rule?.rate_revenue ?? r.rate_revenue;
                  const rGP  = rule?.rate_margin  ?? r.rate_margin;
                  const mp = r.margin_pct != null ? Number(r.margin_pct) : null;
                  return (
                    <tr key={r.rep_code}>
                      <td style={{ fontWeight: 600 }}>
                        <a
                          href="#"
                          onClick={(e) => { e.preventDefault(); setActiveRep(r.rep_code); }}
                          style={{ color: 'var(--ac)', textDecoration: 'none' }}
                        >
                          {r.rep_name}
                        </a>
                      </td>
                      <td className="mn" style={{ textAlign: 'right' }}>{r.customer_count}</td>
                      <td className="mn" style={{ textAlign: 'right', color: 'var(--gn)' }}>{r.active_30d}</td>
                      <td
                        className="mn"
                        style={{
                          textAlign: 'right',
                          color: Number(r.inactive_60d) > 0 ? 'var(--am)' : 'var(--mt)',
                        }}
                      >
                        {r.inactive_60d}
                      </td>
                      <td className="mn" style={{ textAlign: 'right' }}>{r.invoice_count}</td>
                      <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>{fm(r.revenue)}</td>
                      <td className="mn" style={{ textAlign: 'right' }}>{fm(r.est_margin)}</td>
                      <td
                        className="mn"
                        style={{
                          textAlign: 'right',
                          color:
                            mp == null
                              ? 'var(--mt)'
                              : mp >= 0.4
                                ? 'var(--gn)'
                                : 'var(--am)',
                        }}
                      >
                        {fp(r.margin_pct)}
                      </td>
                      <td className="mn" style={{ textAlign: 'right' }}>
                        {r.avg_order_value != null ? fm(r.avg_order_value) : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <input
                          type="number"
                          step={0.001}
                          defaultValue={Number(rRev) || 0}
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (v !== Number(rRev)) saveRule(r.rep_code, { rate_revenue: v });
                          }}
                          style={{ ...inp(), width: 62, fontSize: 10, textAlign: 'right' }}
                        />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <input
                          type="number"
                          step={0.01}
                          defaultValue={Number(rGP) || 0}
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (v !== Number(rGP)) saveRule(r.rep_code, { rate_margin: v });
                          }}
                          style={{ ...inp(), width: 62, fontSize: 10, textAlign: 'right' }}
                        />
                      </td>
                      <td className="mn" style={{ textAlign: 'right', fontWeight: 600, color: 'var(--ac)' }}>
                        {fm(r.commission)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {rule && (
                          <button onClick={() => deleteRule(r.rep_code)} style={btnDanger()}>×</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
