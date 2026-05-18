// Plan Lines view, grouped by P&L section + revenue/COGS line, with subtotals
// and a Gross Margin row. Each cell is still editable in place; the grouping
// only changes how rows are laid out so you can see Revenue and COGS together
// while you adjust them.

import { Fragment, useMemo, useState } from 'react';
import { MONTHS_SHORT, PlanLineSection, SalesPlanLine } from '../../lib/plans';
import { fm } from '../../lib/formatters';
import { btnDanger, btnSecondary, inp } from '../../lib/styles';

export type ViewMode = 'revenue' | 'qty' | 'price' | 'cost';

const ZEROS = (): number[] => [0,0,0,0,0,0,0,0,0,0,0,0];

const SECTION_LABEL: Record<string, string> = {
  revenue: 'REVENUE',
  cogs:    'COST OF GOODS SOLD',
  opex:    'OPERATING EXPENSES',
  other:   'OTHER',
};
const SECTION_ORDER: Record<string, number> = { revenue: 1, cogs: 2, opex: 3, other: 4 };

interface Props {
  lines: SalesPlanLine[];
  linesSections: PlanLineSection[] | null;
  viewMode: ViewMode;
  onSetCell: (line: SalesPlanLine, monthIdx: number, value: string) => void;
  onFillFlat: (line: SalesPlanLine, total: string) => void;
  onDelete: (id: string) => void;
}

export function PlanLinesGrouped({
  lines, linesSections, viewMode, onSetCell, onFillFlat, onDelete,
}: Props) {
  const isMoney = viewMode !== 'qty';

  // Collapsed state. Section keys: 'section:revenue', pl_line keys:
  // 'pl:revenue|BIB - 3 Gallon'. Collapsing a section hides every pl_line
  // and item row; the section subtotal stays visible.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  function toggle(key: string) {
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  const isCollapsed = (key: string) => collapsed.has(key);

  // Build section→pl_line→[lines] grouping. When the section RPC hasn't
  // returned yet, fall back to "other" so the editor never blanks out.
  const grouped = useMemo(() => {
    const byLine = new Map<string, PlanLineSection>();
    if (linesSections) for (const s of linesSections) byLine.set(s.line_id, s);
    const sections = new Map<string, { order: number; plGroups: Map<string, SalesPlanLine[]> }>();
    for (const line of lines) {
      const cls = byLine.get(line.id);
      const section = cls?.section ?? 'other';
      const order   = cls?.section_order ?? SECTION_ORDER[section] ?? 4;
      const plLine  = cls?.pl_line ?? line.account_name ?? '(unmapped)';
      if (!sections.has(section)) sections.set(section, { order, plGroups: new Map() });
      const sec = sections.get(section)!;
      if (!sec.plGroups.has(plLine)) sec.plGroups.set(plLine, []);
      sec.plGroups.get(plLine)!.push(line);
    }
    return Array.from(sections.entries())
      .sort((a, b) => a[1].order - b[1].order)
      .map(([name, data]) => ({
        name,
        order: data.order,
        plGroups: Array.from(data.plGroups.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([plLine, ls]) => ({ plLine, lines: ls.sort((a, b) => (a.item_name ?? '').localeCompare(b.item_name ?? '')) })),
      }));
  }, [lines, linesSections]);

  function arrayFor(line: SalesPlanLine): number[] {
    switch (viewMode) {
      case 'revenue': return line.amounts    ?? ZEROS();
      case 'qty':     return line.qty        ?? ZEROS();
      case 'price':   return line.unit_price ?? ZEROS();
      case 'cost':    return line.unit_cost  ?? ZEROS();
    }
  }

  function totalFor(line: SalesPlanLine): number {
    if (viewMode === 'revenue') return (line.amounts ?? []).reduce((s, v) => s + Number(v || 0), 0);
    if (viewMode === 'qty')     return (line.qty     ?? []).reduce((s, v) => s + Number(v || 0), 0);
    if (viewMode === 'price') {
      const qSum = (line.qty     ?? []).reduce((s, v) => s + Number(v || 0), 0);
      const aSum = (line.amounts ?? []).reduce((s, v) => s + Number(v || 0), 0);
      return qSum > 0 ? aSum / qSum : 0;
    }
    const q = line.qty       ?? ZEROS();
    const c = line.unit_cost ?? ZEROS();
    let t = 0;
    for (let i = 0; i < 12; i++) t += Number(q[i] || 0) * Number(c[i] || 0);
    return t;
  }

  // Monthly subtotal for a group of lines (sum of arrayFor per month).
  function groupMonthly(group: SalesPlanLine[]): { m: number[]; total: number } {
    const m = Array(12).fill(0) as number[];
    for (const line of group) {
      const arr = arrayFor(line);
      for (let i = 0; i < 12; i++) m[i] += Number(arr[i] || 0);
    }
    let total = 0;
    if (viewMode === 'revenue' || viewMode === 'qty') {
      total = m.reduce((s, v) => s + v, 0);
    } else if (viewMode === 'cost') {
      for (const line of group) total += totalFor(line);
    } else {
      // price: blended avg
      let qSum = 0, aSum = 0;
      for (const line of group) {
        qSum += (line.qty     ?? []).reduce((s, v) => s + Number(v || 0), 0);
        aSum += (line.amounts ?? []).reduce((s, v) => s + Number(v || 0), 0);
      }
      total = qSum > 0 ? aSum / qSum : 0;
    }
    return { m, total };
  }

  // Section subtotals for GM/Net math (only meaningful in revenue view).
  const sectionTotals: Record<string, { m: number[]; total: number }> = {};
  for (const sec of grouped) {
    const flat = sec.plGroups.flatMap((g) => g.lines);
    sectionTotals[sec.name] = groupMonthly(flat);
  }
  const showGmNet = viewMode === 'revenue';
  const rev   = sectionTotals.revenue ?? { m: Array(12).fill(0), total: 0 };
  const cogs  = sectionTotals.cogs    ?? { m: Array(12).fill(0), total: 0 };
  const opex  = sectionTotals.opex    ?? { m: Array(12).fill(0), total: 0 };
  const gm    = { m: rev.m.map((v, i) => v - cogs.m[i]), total: rev.total - cogs.total };
  const net   = { m: gm.m.map((v, i) => v - opex.m[i]),   total: gm.total - opex.total };

  function fmt(v: number): string {
    if (!isMoney) return Math.round(v).toLocaleString();
    return fm(v);
  }

  if (lines.length === 0) {
    return <div className="ld">No lines yet. Click + ADD ITEM or use BUILD…</div>;
  }

  return (
    <table style={{ width: '100%' }}>
      <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
        <tr>
          <th style={{ minWidth: 220 }}>Item / Line</th>
          <th style={{ fontSize: 9, color: 'var(--mt)' }}>Account</th>
          {MONTHS_SHORT.map((m) => (
            <th key={m} style={{ textAlign: 'right', fontSize: 9 }}>{m}</th>
          ))}
          <th style={{ textAlign: 'right' }}>
            {viewMode === 'revenue' ? 'Annual Rev'
             : viewMode === 'qty'    ? 'Annual Qty'
             : viewMode === 'price'  ? 'Avg Price'
             :                          'Annual Cost'}
          </th>
          <th />
        </tr>
      </thead>
      <tbody>
        {grouped.map((sec, secIdx) => {
          const sectionKey = 'section:' + sec.name;
          const sectionCollapsed = isCollapsed(sectionKey);
          return (
          <Fragment key={sec.name}>
            <tr onClick={() => toggle(sectionKey)} style={{ cursor: 'pointer' }} title={sectionCollapsed ? 'Click to expand' : 'Click to collapse'}>
              <td colSpan={15} style={sectionHeaderStyle()}>
                <span style={{ display: 'inline-block', width: 14, color: 'var(--mt)' }}>
                  {sectionCollapsed ? '▶' : '▼'}
                </span>
                {SECTION_LABEL[sec.name] ?? sec.name.toUpperCase()}
              </td>
            </tr>
            {!sectionCollapsed && sec.plGroups.map((g) => {
              const groupKey = 'pl:' + sec.name + '|' + g.plLine;
              const groupCollapsed = isCollapsed(groupKey);
              const groupSum = groupMonthly(g.lines);
              return (
                <Fragment key={sec.name + '|' + g.plLine}>
                  <tr onClick={() => toggle(groupKey)} style={{ cursor: 'pointer' }} title={groupCollapsed ? 'Click to expand' : 'Click to collapse'}>
                    <td colSpan={15} style={plLineHeaderStyle()}>
                      <span style={{ display: 'inline-block', width: 14, color: 'var(--mt)' }}>
                        {groupCollapsed ? '▶' : '▼'}
                      </span>
                      {g.plLine} <span style={{ color: 'var(--mt)', fontSize: 9 }}>· {g.lines.length} line{g.lines.length === 1 ? '' : 's'}</span>
                    </td>
                  </tr>
                  {!groupCollapsed && g.lines.map((l) => {
                    const arr = arrayFor(l);
                    const total = totalFor(l);
                    return (
                      <tr key={l.id}>
                        <td style={itemCellStyle()} title={l.item_name ?? ''}>
                          {l.item_name ?? '—'}
                        </td>
                        <td style={{ fontSize: 10, color: 'var(--mt)' }}>{l.account_name ?? '—'}</td>
                        {arr.map((v, idx) => (
                          <td key={idx} style={{ textAlign: 'right', padding: '2px 4px' }}>
                            <input
                              type="number"
                              step={viewMode === 'qty' ? 1 : 0.01}
                              defaultValue={v ?? 0}
                              onBlur={(e) => {
                                if (Number(e.target.value) !== Number(v)) onSetCell(l, idx, e.target.value);
                              }}
                              style={{ ...inp(), width: 76, textAlign: 'right', fontSize: 11, padding: '4px 5px' }}
                            />
                          </td>
                        ))}
                        <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(total)}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button
                            onClick={() => {
                              const annualRev = (l.amounts ?? []).reduce((s, v) => s + Number(v || 0), 0);
                              const v = prompt('Annual revenue total to spread across 12 months:', String(Math.round(annualRev)));
                              if (v != null) onFillFlat(l, v);
                            }}
                            style={{ ...btnSecondary(), fontSize: 9, padding: '2px 6px' }}
                            title="Spread an annual revenue total flat across 12 months"
                          >÷12</button>
                          <button
                            onClick={() => onDelete(l.id)}
                            style={{ ...btnDanger(), marginLeft: 4 }}
                          >×</button>
                        </td>
                      </tr>
                    );
                  })}
                  <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                    <td colSpan={2} style={subtotalLabelStyle()}>Subtotal · {g.plLine}</td>
                    {groupSum.m.map((v, i) => (
                      <td key={i} className="mn" style={subtotalCellStyle('var(--tx)')}>{fmt(v)}</td>
                    ))}
                    <td className="mn" style={{ ...subtotalCellStyle('var(--tx)'), fontWeight: 700 }}>{fmt(groupSum.total)}</td>
                    <td />
                  </tr>
                </Fragment>
              );
            })}
            <tr style={{ background: 'rgba(91,181,240,0.06)' }}>
              <td colSpan={2} style={{ ...subtotalLabelStyle(), fontSize: 12, color: 'var(--ac)' }}>
                TOTAL {SECTION_LABEL[sec.name] ?? sec.name.toUpperCase()}
              </td>
              {sectionTotals[sec.name].m.map((v, i) => (
                <td key={i} className="mn" style={subtotalCellStyle('var(--ac)')}>{fmt(v)}</td>
              ))}
              <td className="mn" style={{ ...subtotalCellStyle('var(--ac)'), fontWeight: 800 }}>{fmt(sectionTotals[sec.name].total)}</td>
              <td />
            </tr>
            {showGmNet && sec.name === 'cogs' && (
              <tr style={{ background: 'rgba(58,167,113,0.10)' }}>
                <td colSpan={2} style={{ ...subtotalLabelStyle(), color: 'var(--gn)', fontSize: 12 }}>
                  GROSS MARGIN {rev.total > 0 ? `· ${((gm.total / rev.total) * 100).toFixed(1)}%` : ''}
                </td>
                {gm.m.map((v, i) => (
                  <td key={i} className="mn" style={subtotalCellStyle('var(--gn)')}>{fmt(v)}</td>
                ))}
                <td className="mn" style={{ ...subtotalCellStyle('var(--gn)'), fontWeight: 800 }}>{fmt(gm.total)}</td>
                <td />
              </tr>
            )}
            {showGmNet && sec.name === 'opex' && secIdx === grouped.length - 1 && (
              <tr style={{ background: 'rgba(58,167,113,0.16)' }}>
                <td colSpan={2} style={{ ...subtotalLabelStyle(), color: 'var(--gn)', fontSize: 13 }}>
                  NET INCOME {rev.total > 0 ? `· ${((net.total / rev.total) * 100).toFixed(1)}%` : ''}
                </td>
                {net.m.map((v, i) => (
                  <td key={i} className="mn" style={subtotalCellStyle('var(--gn)')}>{fmt(v)}</td>
                ))}
                <td className="mn" style={{ ...subtotalCellStyle('var(--gn)'), fontWeight: 800 }}>{fmt(net.total)}</td>
                <td />
              </tr>
            )}
          </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function sectionHeaderStyle(): React.CSSProperties {
  return {
    background: 'var(--sf2)', fontSize: 10, fontWeight: 700, letterSpacing: 1,
    color: 'var(--mt)', padding: '10px 12px',
    borderTop: '1px solid var(--bd)', borderBottom: '1px solid var(--bd)',
    textTransform: 'uppercase',
  };
}
function plLineHeaderStyle(): React.CSSProperties {
  return {
    background: 'rgba(255,255,255,0.02)', fontSize: 10, fontWeight: 600,
    color: 'var(--tx2)', padding: '6px 12px 4px',
    borderTop: '1px solid rgba(255,255,255,0.04)',
    textTransform: 'uppercase', letterSpacing: 0.5,
  };
}
function itemCellStyle(): React.CSSProperties {
  return {
    maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap', fontSize: 12, padding: '4px 8px',
  };
}
function subtotalLabelStyle(): React.CSSProperties {
  return {
    fontWeight: 700, fontSize: 11, letterSpacing: 0.5,
    textTransform: 'uppercase', padding: '6px 10px',
    borderTop: '1.5px solid var(--bd2)',
  };
}
function subtotalCellStyle(color: string): React.CSSProperties {
  return {
    textAlign: 'right', fontWeight: 700, fontSize: 11, color,
    borderTop: '1.5px solid var(--bd2)', padding: '6px 8px',
  };
}
