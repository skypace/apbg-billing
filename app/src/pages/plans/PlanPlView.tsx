// Renders a sales plan as a Profit & Loss statement:
// Revenue rows → Revenue subtotal → COGS rows → COGS subtotal → Gross Margin →
// OpEx rows → OpEx subtotal → Net Income.

import { useEffect, useState } from 'react';
import { MONTHS_SHORT, PlanPlRollupRow, fetchPlanPlRollup } from '../../lib/plans';
import { fm } from '../../lib/formatters';

const MONTH_KEYS = ['m1','m2','m3','m4','m5','m6','m7','m8','m9','m10','m11','m12'] as const;
type MonthKey = typeof MONTH_KEYS[number];

interface SectionTotal {
  m: number[];
  total: number;
}

function emptyTotal(): SectionTotal {
  return { m: Array(12).fill(0), total: 0 };
}

function addInto(t: SectionTotal, r: PlanPlRollupRow) {
  MONTH_KEYS.forEach((k, i) => { t.m[i] += Number(r[k] ?? 0); });
  t.total += Number(r.total ?? 0);
}

const SECTION_LABEL: Record<string, string> = {
  revenue: 'REVENUE',
  cogs:    'COST OF GOODS SOLD',
  opex:    'OPERATING EXPENSES',
  other:   'OTHER',
};

export function PlanPlView({ planId }: { planId: string }) {
  const [rows, setRows] = useState<PlanPlRollupRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setRows(null); setErr(null);
    fetchPlanPlRollup(planId).then(setRows).catch((e: Error) => setErr(e.message));
  }, [planId]);

  if (err) return <div className="cd" style={{ padding: 14, color: 'var(--rd)' }}>P&amp;L rollup error: {err}</div>;
  if (!rows) return <div className="cd ld">Computing P&amp;L…</div>;
  if (rows.length === 0) {
    return <div className="cd ld">No lines in this plan yet. Use Plan Lines to add some, or use Build… to populate from history.</div>;
  }

  // Group rows by section in document order, and compute section subtotals.
  const sections: Record<string, { rows: PlanPlRollupRow[]; total: SectionTotal }> = {};
  for (const r of rows) {
    if (!sections[r.section]) sections[r.section] = { rows: [], total: emptyTotal() };
    sections[r.section].rows.push(r);
    addInto(sections[r.section].total, r);
  }

  const rev   = sections.revenue?.total ?? emptyTotal();
  const cogs  = sections.cogs?.total    ?? emptyTotal();
  const opex  = sections.opex?.total    ?? emptyTotal();
  const other = sections.other?.total   ?? emptyTotal();

  const gm: SectionTotal = {
    m: rev.m.map((v, i) => v - cogs.m[i]),
    total: rev.total - cogs.total,
  };
  const net: SectionTotal = {
    m: gm.m.map((v, i) => v - opex.m[i] - other.m[i]),
    total: gm.total - opex.total - other.total,
  };
  const gmPct  = rev.total > 0 ? (gm.total  / rev.total) * 100 : null;
  const netPct = rev.total > 0 ? (net.total / rev.total) * 100 : null;

  // Lay out in the canonical P&L order: revenue → cogs → GM → opex → other → net
  const blocks: { key: string; section?: string; subtotal?: SectionTotal; subtotalLabel?: string; pct?: number | null; highlight?: 'gm' | 'net' }[] = [
    { key: 'rev_h',  section: 'revenue' },
    { key: 'rev_t',  subtotal: rev,  subtotalLabel: 'TOTAL REVENUE' },
    { key: 'cogs_h', section: 'cogs' },
    { key: 'cogs_t', subtotal: cogs, subtotalLabel: 'TOTAL COGS' },
    { key: 'gm',     subtotal: gm,   subtotalLabel: 'GROSS MARGIN', pct: gmPct, highlight: 'gm' },
    { key: 'opex_h', section: 'opex' },
    { key: 'opex_t', subtotal: opex, subtotalLabel: 'TOTAL OPERATING EXPENSES' },
    ...(other.total !== 0 ? [{ key: 'other_h', section: 'other' }, { key: 'other_t', subtotal: other, subtotalLabel: 'TOTAL OTHER' }] : []),
    { key: 'net',    subtotal: net,  subtotalLabel: 'NET INCOME', pct: netPct, highlight: 'net' as const },
  ];

  return (
    <div className="cd" style={{ padding: 0 }}>
      <div style={{ maxHeight: '70vh', overflow: 'auto' }}>
        <table style={{ width: '100%' }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
            <tr>
              <th style={{ minWidth: 220 }}>Line</th>
              <th style={{ fontSize: 9, color: 'var(--mt)' }}>Account</th>
              <th style={{ fontSize: 9, color: 'var(--mt)' }}>Item Category</th>
              {MONTHS_SHORT.map((m) => (
                <th key={m} style={{ textAlign: 'right', fontSize: 9 }}>{m}</th>
              ))}
              <th style={{ textAlign: 'right' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {blocks.map((b) => {
              if (b.section) {
                const sec = sections[b.section];
                if (!sec || sec.rows.length === 0) {
                  return (
                    <tr key={b.key}>
                      <td colSpan={16} style={sectionHeaderStyle()}>{SECTION_LABEL[b.section]}</td>
                    </tr>
                  );
                }
                return (
                  <>
                    <tr key={b.key + '_h'}>
                      <td colSpan={16} style={sectionHeaderStyle()}>{SECTION_LABEL[b.section]}</td>
                    </tr>
                    {sec.rows.map((r, i) => (
                      <tr key={b.section + '_r_' + i}>
                        <td style={{ fontWeight: 600 }}>{r.pl_line}</td>
                        <td style={{ fontSize: 10, color: 'var(--mt)' }}>{r.account_name}</td>
                        <td style={{ fontSize: 10, color: 'var(--mt)' }}>{r.item_category}</td>
                        {MONTH_KEYS.map((k) => (
                          <td key={k} className="mn" style={{ textAlign: 'right', fontSize: 10 }}>
                            {fm(Number(r[k] ?? 0))}
                          </td>
                        ))}
                        <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>{fm(Number(r.total ?? 0))}</td>
                      </tr>
                    ))}
                  </>
                );
              }
              // Subtotal row
              const sub = b.subtotal!;
              const bgFor = b.highlight === 'gm'  ? 'rgba(91,181,240,0.10)'
                          : b.highlight === 'net' ? 'rgba(58,167,113,0.12)'
                          : 'transparent';
              const colorFor = b.highlight === 'gm' ? 'var(--ac)' : b.highlight === 'net' ? 'var(--gn)' : 'var(--tx)';
              return (
                <tr key={b.key} style={{ background: bgFor }}>
                  <td colSpan={3} style={{ ...subtotalLabelStyle(), color: colorFor }}>
                    {b.subtotalLabel}
                    {b.pct != null ? ` · ${b.pct.toFixed(1)}%` : ''}
                  </td>
                  {sub.m.map((v, i) => (
                    <td key={'m' + i} className="mn" style={subtotalCellStyle(colorFor)}>{fm(v)}</td>
                  ))}
                  <td className="mn" style={{ ...subtotalCellStyle(colorFor), borderTopWidth: 2 }}>{fm(sub.total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function sectionHeaderStyle(): React.CSSProperties {
  return {
    background: 'var(--sf2)',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 1,
    color: 'var(--mt)',
    padding: '8px 10px',
    borderTop: '1px solid var(--bd)',
    borderBottom: '1px solid var(--bd)',
    textTransform: 'uppercase',
  };
}
function subtotalLabelStyle(): React.CSSProperties {
  return {
    fontWeight: 700,
    fontSize: 11,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    padding: '6px 10px',
    borderTop: '1.5px solid var(--bd2)',
  };
}
function subtotalCellStyle(color: string): React.CSSProperties {
  return {
    textAlign: 'right',
    fontWeight: 700,
    fontSize: 11,
    color,
    borderTop: '1.5px solid var(--bd2)',
    padding: '6px 8px',
  };
}
