// Planning Studio table: P&L grouping, editable monthly assumptions, and
// revenue actual/forecast context on the same working surface.

import { Fragment, useMemo, useState } from 'react';
import { MONTHS_SHORT, PlanLineSection, SalesPlanLine } from '../../lib/plans';
import { fm, fp } from '../../lib/formatters';
import { btnDanger, btnSecondary, inp } from '../../lib/styles';

export type ViewMode = 'revenue' | 'qty' | 'price' | 'cost';

type ActualsByItem = Record<string, { item_name?: string; amounts: number[]; total: number }>;
type CompareByItem = Record<string, { item_name?: string | null; total: number }>;

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
  actualsByItem?: ActualsByItem | null;
  compareByItem?: CompareByItem | null;
  compareLabel?: string | null;
  planFiscalYear?: number;
  onSetCell: (line: SalesPlanLine, monthIdx: number, value: string) => void;
  onFillFlat: (line: SalesPlanLine, total: string) => void;
  onDelete: (id: string) => void;
}

interface ItemGroup {
  key: string;
  line: SalesPlanLine;
  lines: SalesPlanLine[];
}

export function PlanLinesGrouped({
  lines, linesSections, viewMode, actualsByItem, compareByItem, compareLabel, planFiscalYear, onSetCell, onFillFlat, onDelete,
}: Props) {
  const isMoney = viewMode !== 'qty';
  const showPace = viewMode === 'revenue';
  const showCompare = viewMode === 'revenue' && compareByItem != null;
  const totalCols = 15 + (showPace ? 3 : 0) + (showCompare ? 2 : 0);
  const elapsedMonths = completedMonths(planFiscalYear);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  function toggle(key: string) {
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  const isCollapsed = (key: string) => collapsed.has(key);
  function toggleItem(key: string) {
    setExpandedItems((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  const isItemExpanded = (key: string) => expandedItems.has(key);

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
    if (viewMode === 'revenue') return sum(line.amounts);
    if (viewMode === 'qty')     return sum(line.qty);
    if (viewMode === 'price') {
      const qSum = sum(line.qty);
      const aSum = sum(line.amounts);
      return qSum > 0 ? aSum / qSum : 0;
    }
    const q = line.qty       ?? ZEROS();
    const c = line.unit_cost ?? ZEROS();
    let t = 0;
    for (let i = 0; i < 12; i++) t += Number(q[i] || 0) * Number(c[i] || 0);
    return t;
  }

  function groupMonthly(group: SalesPlanLine[]): { m: number[]; total: number } {
    if (viewMode === 'price') return blendedPrice(group);
    if (viewMode === 'cost') return extendedCost(group);

    const m = Array(12).fill(0) as number[];
    for (const line of group) {
      const arr = arrayFor(line);
      for (let i = 0; i < 12; i++) m[i] += Number(arr[i] || 0);
    }
    return { m, total: m.reduce((s, v) => s + v, 0) };
  }

  function revenueMonthly(group: SalesPlanLine[]): { m: number[]; total: number } {
    const m = Array(12).fill(0) as number[];
    for (const line of group) {
      const arr = line.amounts ?? ZEROS();
      for (let i = 0; i < 12; i++) m[i] += Number(arr[i] || 0);
    }
    return { m, total: m.reduce((s, v) => s + v, 0) };
  }

  function itemGroupsFor(group: SalesPlanLine[]): ItemGroup[] {
    const byItem = new Map<string, SalesPlanLine[]>();
    for (const line of group) {
      const key = line.qbo_item_id ?? line.item_name ?? line.id;
      if (!byItem.has(key)) byItem.set(key, []);
      byItem.get(key)!.push(line);
    }
    return Array.from(byItem.entries())
      .map(([key, ls]) => ({ key, line: ls[0], lines: ls }))
      .sort((a, b) => (a.line.item_name ?? '').localeCompare(b.line.item_name ?? ''));
  }

  function actualsForLines(group: SalesPlanLine[]): { m: number[]; total: number } | null {
    if (actualsByItem == null) return null;
    const m = Array(12).fill(0) as number[];
    const seen = new Set<string>();
    for (const line of group) {
      if (!line.qbo_item_id || seen.has(line.qbo_item_id)) continue;
      seen.add(line.qbo_item_id);
      const actual = actualsByItem[line.qbo_item_id]?.amounts ?? ZEROS();
      for (let i = 0; i < 12; i++) m[i] += Number(actual[i] || 0);
    }
    return { m, total: m.reduce((s, v) => s + v, 0) };
  }

  function paceForLines(group: SalesPlanLine[]) {
    const plan = revenueMonthly(group);
    const actual = actualsForLines(group);
    if (!actual) return null;
    const ytdActual = actual.m.slice(0, elapsedMonths).reduce((s, v) => s + v, 0);
    const remainingPlan = plan.m.slice(elapsedMonths).reduce((s, v) => s + v, 0);
    const forecast = ytdActual + remainingPlan;
    return {
      ytdActual,
      forecast,
      deltaPct: plan.total > 0 ? (forecast - plan.total) / plan.total : null,
    };
  }

  function paceCells(group: SalesPlanLine[], active: boolean, strong = false) {
    if (!showPace) return null;
    if (!active) return <><td /><td /><td /></>;
    const pace = paceForLines(group);
    if (!pace) return <><td className="mn" style={paceCellStyle(strong)}>...</td><td /><td /></>;
    const color = pace.deltaPct == null ? 'var(--mt)' : pace.deltaPct >= 0 ? 'var(--gn)' : pace.deltaPct <= -0.1 ? 'var(--rd)' : 'var(--am)';
    return (
      <>
        <td className="mn" style={paceCellStyle(strong)}>{fm(pace.ytdActual)}</td>
        <td className="mn" style={paceCellStyle(strong)}>{fm(pace.forecast)}</td>
        <td className="mn" style={{ ...paceCellStyle(strong), color }}>{fp(pace.deltaPct)}</td>
      </>
    );
  }

  function compareForLines(group: SalesPlanLine[]): number | null {
    if (!compareByItem) return null;
    const seen = new Set<string>();
    let total = 0;
    for (const line of group) {
      const key = line.qbo_item_id ?? line.item_name ?? line.id;
      if (seen.has(key)) continue;
      seen.add(key);
      total += Number(compareByItem[key]?.total ?? 0);
    }
    return total;
  }

  function compareCells(group: SalesPlanLine[], strong = false) {
    if (!showCompare) return null;
    const current = revenueMonthly(group).total;
    const compareTotal = compareForLines(group);
    const delta = compareTotal == null ? null : current - compareTotal;
    const color = delta == null ? 'var(--mt)' : delta >= 0 ? 'var(--gn)' : 'var(--rd)';
    return (
      <>
        <td className="mn" style={paceCellStyle(strong)}>{compareTotal == null ? '—' : fm(compareTotal)}</td>
        <td className="mn" style={{ ...paceCellStyle(strong), color }}>{delta == null ? '—' : fm(delta)}</td>
      </>
    );
  }

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
          {showPace && (
            <>
              <th style={{ textAlign: 'right', color: 'var(--mt)' }}>YTD Act</th>
              <th style={{ textAlign: 'right', color: 'var(--mt)' }}>FY Pace</th>
              <th style={{ textAlign: 'right', color: 'var(--mt)' }}>Δ</th>
            </>
          )}
          {showCompare && (
            <>
              <th style={{ textAlign: 'right', color: 'var(--mt)' }} title={compareLabel ?? undefined}>Compare</th>
              <th style={{ textAlign: 'right', color: 'var(--mt)' }}>Plan Δ</th>
            </>
          )}
          <th />
        </tr>
      </thead>
      <tbody>
        {grouped.map((sec, secIdx) => {
          const sectionKey = 'section:' + sec.name;
          const sectionCollapsed = isCollapsed(sectionKey);
          const sectionActualsActive = sec.name === 'revenue';
          return (
          <Fragment key={sec.name}>
            <tr onClick={() => toggle(sectionKey)} style={{ cursor: 'pointer' }} title={sectionCollapsed ? 'Click to expand' : 'Click to collapse'}>
              <td colSpan={totalCols} style={sectionHeaderStyle()}>
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
              const itemGroups = itemGroupsFor(g.lines);
              return (
                <Fragment key={sec.name + '|' + g.plLine}>
                  <tr onClick={() => toggle(groupKey)} style={{ cursor: 'pointer' }} title={groupCollapsed ? 'Click to expand' : 'Click to collapse'}>
                    <td colSpan={totalCols} style={plLineHeaderStyle()}>
                      <span style={{ display: 'inline-block', width: 14, color: 'var(--mt)' }}>
                        {groupCollapsed ? '▶' : '▼'}
                      </span>
                      {g.plLine} <span style={{ color: 'var(--mt)', fontSize: 9 }}>· {itemGroups.length} item{itemGroups.length === 1 ? '' : 's'} · {g.lines.length} plan line{g.lines.length === 1 ? '' : 's'}</span>
                    </td>
                  </tr>
                  {!groupCollapsed && itemGroups.map((ig) => {
                    const editable = ig.lines.length === 1;
                    const l = ig.line;
                    const summary = groupMonthly(ig.lines);
                    const monthly = editable ? arrayFor(l) : summary.m;
                    const total = editable ? totalFor(l) : summary.total;
                    const expanded = isItemExpanded(ig.key);
                    return (
                      <Fragment key={ig.key}>
                        <tr>
                          <td style={itemCellStyle()} title={l.item_name ?? ''}>
                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.item_name ?? '—'}</div>
                            <div style={{ fontSize: 9, color: 'var(--mt)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {editable ? (l.customer_name ?? '') : `${ig.lines.length} customer lines`}
                            </div>
                          </td>
                          <td style={{ fontSize: 10, color: 'var(--mt)' }}>{l.account_name ?? '—'}</td>
                          {monthly.map((v, idx) => (
                            <td key={idx} style={{ textAlign: 'right', padding: '2px 4px' }}>
                              {editable ? (
                                <input
                                  type="number"
                                  step={viewMode === 'qty' ? 1 : 0.01}
                                  defaultValue={v ?? 0}
                                  onBlur={(e) => {
                                    if (Number(e.target.value) !== Number(v)) onSetCell(l, idx, e.target.value);
                                  }}
                                  style={{ ...inp(), width: 76, textAlign: 'right', fontSize: 11, padding: '4px 5px' }}
                                />
                              ) : (
                                <span className="mn" style={{ fontSize: 11, color: 'var(--tx2)' }}>{fmt(v)}</span>
                              )}
                            </td>
                          ))}
                          <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(total)}</td>
                          {paceCells(ig.lines, sectionActualsActive)}
                          {compareCells(ig.lines)}
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {editable ? (
                              <>
                                <button
                                  onClick={() => {
                                    const annualRev = sum(l.amounts);
                                    const v = prompt('Annual revenue total to spread across 12 months:', String(Math.round(annualRev)));
                                    if (v != null) onFillFlat(l, v);
                                  }}
                                  style={{ ...btnSecondary(), fontSize: 9, padding: '2px 6px' }}
                                  title="Spread annual revenue across 12 months"
                                >÷12</button>
                                <button
                                  onClick={() => onDelete(l.id)}
                                  style={{ ...btnDanger(), marginLeft: 4 }}
                                >×</button>
                              </>
                            ) : (
                              <button
                                onClick={() => toggleItem(ig.key)}
                                style={{ ...btnSecondary(), fontSize: 9, padding: '2px 6px' }}
                              >
                                {expanded ? 'hide' : 'details'}
                              </button>
                            )}
                          </td>
                        </tr>
                        {!editable && expanded && ig.lines.map((child) => {
                          const childArr = arrayFor(child);
                          return (
                            <tr key={child.id} style={{ background: 'rgba(255,255,255,0.015)' }}>
                              <td style={{ ...itemCellStyle(), paddingLeft: 24 }} title={child.customer_name ?? ''}>
                                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--tx2)' }}>{child.customer_name ?? '(customer)'}</div>
                                <div style={{ fontSize: 9, color: 'var(--mt)', marginTop: 1 }}>{child.item_name ?? ''}</div>
                              </td>
                              <td style={{ fontSize: 10, color: 'var(--mt)' }}>{child.account_name ?? '—'}</td>
                              {childArr.map((v, idx) => (
                                <td key={idx} style={{ textAlign: 'right', padding: '2px 4px' }}>
                                  <input
                                    type="number"
                                    step={viewMode === 'qty' ? 1 : 0.01}
                                    defaultValue={v ?? 0}
                                    onBlur={(e) => {
                                      if (Number(e.target.value) !== Number(v)) onSetCell(child, idx, e.target.value);
                                    }}
                                    style={{ ...inp(), width: 76, textAlign: 'right', fontSize: 11, padding: '4px 5px' }}
                                  />
                                </td>
                              ))}
                              <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(totalFor(child))}</td>
                              {paceCells([child], false)}
                              {showCompare && <><td /><td /></>}
                              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                                <button
                                  onClick={() => {
                                    const annualRev = sum(child.amounts);
                                    const v = prompt('Annual revenue total to spread across 12 months:', String(Math.round(annualRev)));
                                    if (v != null) onFillFlat(child, v);
                                  }}
                                  style={{ ...btnSecondary(), fontSize: 9, padding: '2px 6px' }}
                                  title="Spread annual revenue across 12 months"
                                >÷12</button>
                                <button
                                  onClick={() => onDelete(child.id)}
                                  style={{ ...btnDanger(), marginLeft: 4 }}
                                >×</button>
                              </td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                  <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                    <td colSpan={2} style={subtotalLabelStyle()}>Subtotal · {g.plLine}</td>
                    {groupSum.m.map((v, i) => (
                      <td key={i} className="mn" style={subtotalCellStyle('var(--tx)')}>{fmt(v)}</td>
                    ))}
                    <td className="mn" style={{ ...subtotalCellStyle('var(--tx)'), fontWeight: 700 }}>{fmt(groupSum.total)}</td>
                    {paceCells(g.lines, sectionActualsActive, true)}
                    {compareCells(g.lines, true)}
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
              {paceCells(sec.plGroups.flatMap((g) => g.lines), sectionActualsActive, true)}
              {compareCells(sec.plGroups.flatMap((g) => g.lines), true)}
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
                {showPace && <><td /><td /><td /></>}
                {showCompare && <><td /><td /></>}
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
                {showPace && <><td /><td /><td /></>}
                {showCompare && <><td /><td /></>}
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

function completedMonths(planFiscalYear?: number): number {
  if (!planFiscalYear) return 0;
  const today = new Date();
  if (today.getFullYear() < planFiscalYear) return 0;
  if (today.getFullYear() > planFiscalYear) return 12;
  return today.getMonth();
}

function sum(values: number[] | null | undefined): number {
  return (values ?? []).reduce((s, v) => s + Number(v || 0), 0);
}

function blendedPrice(group: SalesPlanLine[]): { m: number[]; total: number } {
  const m = Array(12).fill(0) as number[];
  let qTotal = 0;
  let aTotal = 0;
  for (let i = 0; i < 12; i++) {
    let q = 0;
    let a = 0;
    for (const line of group) {
      q += Number((line.qty ?? [])[i] || 0);
      a += Number((line.amounts ?? [])[i] || 0);
    }
    m[i] = q > 0 ? a / q : 0;
    qTotal += q;
    aTotal += a;
  }
  return { m, total: qTotal > 0 ? aTotal / qTotal : 0 };
}

function extendedCost(group: SalesPlanLine[]): { m: number[]; total: number } {
  const m = Array(12).fill(0) as number[];
  for (const line of group) {
    const q = line.qty       ?? ZEROS();
    const c = line.unit_cost ?? ZEROS();
    for (let i = 0; i < 12; i++) m[i] += Number(q[i] || 0) * Number(c[i] || 0);
  }
  return { m, total: m.reduce((s, v) => s + v, 0) };
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
function paceCellStyle(strong: boolean): React.CSSProperties {
  return {
    textAlign: 'right',
    fontWeight: strong ? 700 : 600,
    fontSize: 11,
    padding: '6px 8px',
    borderTop: strong ? '1.5px solid var(--bd2)' : undefined,
    color: 'var(--tx)',
  };
}
