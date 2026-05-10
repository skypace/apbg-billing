import { useEffect, useMemo, useState } from 'react';
import { CustomerHealth, CustomerListRow, fetchCustomerHealth, fetchCustomerList } from '../lib/customers';
import { fm, fmtNum } from '../lib/formatters';
import { btnSecondary, inp } from '../lib/styles';
import { downloadCsv, toCsv } from '../lib/csv';
import { SegmentChip } from '../components/SegmentChip';
import { TableSkeleton } from '../components/Skeletons';

type SortKey = 'display_name' | 'ytd_revenue' | 'invoice_count' | 'rfm_total' | 'state';

export function CustomersPage() {
  const today = new Date().toISOString().slice(0, 10);
  const ytdStart = new Date().getFullYear() + '-01-01';

  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [rows, setRows] = useState<CustomerListRow[] | null>(null);
  const [healthByCust, setHealthByCust] = useState<Record<string, CustomerHealth>>({});
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'ytd_revenue',
    dir: 'desc',
  });
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setErr('');
    const t = setTimeout(() => {
      fetchCustomerList({
        search: search.trim() || undefined,
        channel: channel || undefined,
        start: ytdStart,
        end: today,
        limit: 500,
      })
        .then((rs) => { if (!cancelled) setRows(rs); })
        .catch((e) => { if (!cancelled) setErr(e.message); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search, channel, ytdStart, today]);

  useEffect(() => {
    fetchCustomerHealth(365)
      .then((rs) => {
        const map: Record<string, CustomerHealth> = {};
        for (const h of rs) map[h.qbo_customer_id] = h;
        setHealthByCust(map);
      })
      .catch(() => setHealthByCust({}));
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return null;
    return showInactive ? rows : rows.filter((r) => r.active);
  }, [rows, showInactive]);

  const sorted = useMemo(() => {
    if (!filtered) return null;
    const out = [...filtered];
    out.sort((a, b) => {
      let av: string | number | null;
      let bv: string | number | null;
      if (sort.key === 'rfm_total') {
        av = healthByCust[a.qbo_customer_id]?.rfm_total ?? null;
        bv = healthByCust[b.qbo_customer_id]?.rfm_total ?? null;
      } else {
        av = (a as unknown as Record<string, unknown>)[sort.key] as string | number | null;
        bv = (b as unknown as Record<string, unknown>)[sort.key] as string | number | null;
      }
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string' && typeof bv === 'string') {
        return sort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sort.dir === 'asc' ? Number(av) - Number(bv) : Number(bv) - Number(av);
    });
    return out;
  }, [filtered, sort, healthByCust]);

  const channelOptions = useMemo(() => {
    if (!rows) return [];
    const set = new Set<string>();
    for (const r of rows) if (r.primary_channel) set.add(r.primary_channel);
    return Array.from(set).sort();
  }, [rows]);

  function header(key: SortKey, label: string, align: 'left' | 'right' = 'left') {
    const on = sort.key === key;
    const arrow = on ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return (
      <th
        onClick={() =>
          setSort((s) =>
            s.key === key
              ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
              : { key, dir: 'desc' },
          )
        }
        style={{
          textAlign: align,
          cursor: 'pointer',
          userSelect: 'none',
          color: on ? 'var(--ac)' : undefined,
        }}
      >
        {label}
        {arrow}
      </th>
    );
  }

  function exportCsv() {
    if (!sorted || sorted.length === 0) return;
    const head = ['Customer', 'Active', 'State', 'Channel', 'YTD Revenue', 'Invoices', 'RFM Segment', 'RFM Total'];
    const data = sorted.map((r) => {
      const h = healthByCust[r.qbo_customer_id];
      return [
        r.display_name,
        r.active ? 'Y' : 'N',
        r.state ?? '',
        r.primary_channel ?? '',
        Number(r.ytd_revenue ?? 0).toFixed(2),
        r.invoice_count,
        h?.rfm_segment ?? '',
        h?.rfm_total ?? '',
      ];
    });
    downloadCsv(`customers_${ytdStart}_${today}.csv`, toCsv([head, ...data]));
  }

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Customer health · RFM · YTD</div>
          <h1 className="hero-title">Customers</h1>
          <div className="hero-meta">
            {sorted ? `${fmtNum(sorted.length)} customers` : 'loading…'}
            {channel ? ` · ${channel}` : ''}{showInactive ? ' · including inactive' : ''}
          </div>
        </div>
        <div className="hero-stamp">
          <span className="status-dot" aria-hidden="true" />
          YTD {ytdStart} → {today}
        </div>
      </div>

      <div
        className="cd"
        style={{
          padding: '10px 12px',
          marginBottom: 14,
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
          fontSize: 11,
        }}
      >
        <input
          type="text"
          placeholder="search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ ...inp(), width: 240 }}
        />

        <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>Channel</span>
        <select value={channel} onChange={(e) => setChannel(e.target.value)} style={inp()}>
          <option value="">All</option>
          {channelOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          <span style={{ color: 'var(--mt)', textTransform: 'uppercase', letterSpacing: 1 }}>show inactive</span>
        </label>

        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', fontSize: 10, color: 'var(--mt)' }}>
          <button
            onClick={exportCsv}
            disabled={!sorted?.length}
            style={btnSecondary()}
          >
            EXPORT CSV
          </button>
        </span>
      </div>

      {err ? (
        <div className="cd" style={{ padding: 14, color: 'var(--rd)' }}>Error: {err}</div>
      ) : !sorted ? (
        <div className="cd" style={{ padding: 0 }}>
          <TableSkeleton rows={10} cols={7} />
        </div>
      ) : sorted.length === 0 ? (
        <div className="cd" style={{ padding: 14, color: 'var(--mt)' }}>No customers match.</div>
      ) : (
        <div className="cd" style={{ padding: 0 }}>
          <div style={{ maxHeight: '64vh', overflow: 'auto' }}>
            <table>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                <tr>
                  {header('display_name', 'Customer')}
                  {header('state', 'State')}
                  <th>Channel</th>
                  {header('ytd_revenue', 'YTD Revenue', 'right')}
                  {header('invoice_count', 'Invoices', 'right')}
                  <th>Segment</th>
                  {header('rfm_total', 'RFM', 'right')}
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const h = healthByCust[r.qbo_customer_id];
                  return (
                    <tr
                      key={r.qbo_customer_id}
                      onClick={() => { window.location.hash = '#customer-' + r.qbo_customer_id; }}
                      style={{ cursor: 'pointer' }}
                    >
                      <td
                        style={{
                          fontWeight: 600,
                          maxWidth: 320,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={r.display_name}
                      >
                        {r.display_name}
                        {r.is_sub_customer && (
                          <span className="bg bg-p" style={{ marginLeft: 6 }}>SUB</span>
                        )}
                        {!r.active && (
                          <span className="bg bg-p" style={{ marginLeft: 6 }}>INACTIVE</span>
                        )}
                      </td>
                      <td className="mn" style={{ fontSize: 11, color: 'var(--mt)' }}>{r.state ?? '—'}</td>
                      <td style={{ fontSize: 11, color: 'var(--mt)' }}>{r.primary_channel ?? '—'}</td>
                      <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>{fm(r.ytd_revenue)}</td>
                      <td className="mn" style={{ textAlign: 'right' }}>{fmtNum(r.invoice_count)}</td>
                      <td><SegmentChip segment={h?.rfm_segment ?? null} /></td>
                      <td className="mn" style={{ textAlign: 'right', color: 'var(--mt)' }}>
                        {h ? h.rfm_total + '/15' : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
