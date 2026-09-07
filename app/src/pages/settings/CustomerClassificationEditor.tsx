import { useEffect, useMemo, useState } from 'react';
import { PrintableTable } from '../../components/PrintableTable';
import {
  Channel,
  CustomerClassificationRow,
  fetchChannels,
  fetchCustomerClassificationList,
  setCustomerChannels,
} from '../../lib/settings';
import { fm, fmtNum } from '../../lib/formatters';
import { inp } from '../../lib/styles';

// Per-customer channel assignment editor. Search box drives a server-side
// filter via fn_customer_classification_list. Each row has multi-select
// channel chips and a primary-channel <select>; saving calls
// fn_set_customer_channels and updates the row in place.

export function CustomerClassificationEditor() {
  const today = new Date().toISOString().slice(0, 10);
  const ytdStart = new Date().getFullYear() + '-01-01';

  const [search, setSearch] = useState<string>('');
  const [channelFilter, setChannelFilter] = useState<string>('');
  const [rows, setRows] = useState<CustomerClassificationRow[] | null>(null);
  const [channelOpts, setChannelOpts] = useState<Channel[]>([]);
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  function load(searchVal: string, chFilter: string) {
    setRows(null);
    fetchCustomerClassificationList({
      search: searchVal.trim() || undefined,
      channel: chFilter || undefined,
      start: ytdStart,
      end: today,
      limit: 300,
    }).then((rs) => setRows(rs ?? []));
  }

  useEffect(() => {
    fetchChannels().then((rs) => setChannelOpts(rs.filter((c) => c.is_active)));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(search, channelFilter), 250);
    return () => clearTimeout(t);
  }, [search, channelFilter]);

  function saveChannels(custId: string, labels: string[], primaryLabel: string | null) {
    setSaving((cur) => ({ ...cur, [custId]: true }));
    setCustomerChannels(custId, labels, primaryLabel)
      .then(() => {
        setRows((cur) =>
          (cur ?? []).map((r) =>
            r.qbo_customer_id === custId
              ? { ...r, channels: labels, primary_channel: primaryLabel }
              : r,
          ),
        );
      })
      .finally(() => {
        setSaving((cur) => {
          const next = { ...cur };
          delete next[custId];
          return next;
        });
      });
  }

  const stats = useMemo(() => {
    const list = rows ?? [];
    const total = list.length;
    const classified = list.filter((r) => (r.channels ?? []).length > 0).length;
    const revClassified = list
      .filter((r) => (r.channels ?? []).length > 0)
      .reduce((s, r) => s + Number(r.ytd_revenue || 0), 0);
    const revUnclassified = list
      .filter((r) => (r.channels ?? []).length === 0)
      .reduce((s, r) => s + Number(r.ytd_revenue || 0), 0);
    return { total, classified, revClassified, revUnclassified };
  }, [rows]);

  const FILTER_PILLS: { label: string; value: string }[] = [
    { label: 'All', value: '' },
    { label: 'Unassigned', value: 'unassigned' },
    ...channelOpts.map((c) => ({ label: c.label, value: c.label })),
  ];

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 12 }}>
        <div className="cd" style={{ padding: '8px 10px' }}>
          <div className="ct" style={{ margin: 0 }}>CUSTOMERS SHOWN</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>{fmtNum(stats.total)}</div>
        </div>
        <div className="cd" style={{ padding: '8px 10px' }}>
          <div className="ct" style={{ margin: 0 }}>CLASSIFIED</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3, color: stats.classified > 0 ? 'var(--gn)' : undefined }}>
            {fmtNum(stats.classified)}
          </div>
          <div style={{ fontSize: 10, color: 'var(--mt)' }}>
            {stats.total ? Math.round(100 * stats.classified / stats.total) + '% of shown' : '0%'}
          </div>
        </div>
        <div className="cd" style={{ padding: '8px 10px' }}>
          <div className="ct" style={{ margin: 0 }}>REVENUE CLASSIFIED</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>{fm(stats.revClassified)}</div>
          <div style={{ fontSize: 10, color: 'var(--mt)' }}>YTD</div>
        </div>
        <div className="cd" style={{ padding: '8px 10px' }}>
          <div className="ct" style={{ margin: 0 }}>REVENUE UNCLASSIFIED</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3, color: 'var(--am)' }}>
            {fm(stats.revUnclassified)}
          </div>
          <div style={{ fontSize: 10, color: 'var(--mt)' }}>click rows below to fix</div>
        </div>
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
        }}
      >
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customer name…"
          style={{ flex: '1 1 240px', minWidth: 200, ...inp() }}
        />
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {FILTER_PILLS.map((p) => {
            const on = channelFilter === p.value;
            return (
              <button
                key={p.value || 'all'}
                onClick={() => setChannelFilter(p.value)}
                style={{
                  background: on ? 'var(--ac)' : 'var(--ctl-bg)',
                  color: on ? '#fff' : 'var(--tx)',
                  border: '1px solid var(--ctl-bd)',
                  padding: '4px 9px',
                  borderRadius: 4,
                  fontSize: 11,
                  cursor: 'pointer',
                  fontWeight: on ? 700 : 400,
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {!rows ? (
        <div className="ld">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="cd" style={{ padding: 14, color: 'var(--mt)' }}>No customers match.</div>
      ) : (
        <div className="cd" style={{ padding: 0 }}>
          <div style={{ maxHeight: '64vh', overflow: 'auto' }}>
            <PrintableTable>
              <table>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--sf)', zIndex: 1 }}>
                  <tr>
                    <th>Customer</th>
                    <th style={{ textAlign: 'right' }}>YTD Rev</th>
                    <th style={{ textAlign: 'right' }}>Inv</th>
                    <th>Channels</th>
                    <th>Primary</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <CustomerRow
                      key={r.qbo_customer_id}
                      row={r}
                      channelOpts={channelOpts}
                      isSaving={!!saving[r.qbo_customer_id]}
                      onSave={saveChannels}
                    />
                  ))}
                </tbody>
              </table>
            </PrintableTable>
          </div>
        </div>
      )}
    </div>
  );
}

interface RowProps {
  row: CustomerClassificationRow;
  channelOpts: Channel[];
  isSaving: boolean;
  onSave: (custId: string, labels: string[], primary: string | null) => void;
}

function CustomerRow({ row, channelOpts, isSaving, onSave }: RowProps) {
  const chs = row.channels ?? [];
  const primary = row.primary_channel ?? (chs[0] ?? null);

  function setChs(nextLabels: string[], nextPrimary: string | null) {
    let p = nextPrimary;
    if (p && nextLabels.indexOf(p) < 0) p = nextLabels[0] ?? null;
    onSave(row.qbo_customer_id, nextLabels, p);
  }

  const optsRemaining = channelOpts.filter((c) => !chs.includes(c.label));

  return (
    <tr style={{ opacity: isSaving ? 0.6 : 1 }}>
      <td style={{ fontWeight: 600, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.display_name}>
        {row.display_name}
        {row.state || row.is_sub_customer || row.customer_type_name ? (
          <div style={{ fontSize: 10, color: 'var(--mt)' }}>
            {[row.state, row.is_sub_customer ? 'sub' : null, row.customer_type_name].filter(Boolean).join(' · ')}
          </div>
        ) : null}
      </td>
      <td className="mn" style={{ textAlign: 'right', fontWeight: 600 }}>{fm(row.ytd_revenue)}</td>
      <td className="mn" style={{ textAlign: 'right' }}>{fmtNum(row.invoice_count)}</td>
      <td style={{ minWidth: 280 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
          {chs.map((label) => (
            <span
              key={label}
              onClick={() => setChs(chs.filter((x) => x !== label), primary === label ? null : primary)}
              title="click to remove"
              style={{
                background: 'rgba(34,211,238,.12)',
                color: 'var(--ac)',
                border: '1px solid var(--ac)',
                borderRadius: 12,
                padding: '1px 8px',
                fontSize: 10,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {label} ×
            </span>
          ))}
          {optsRemaining.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                const v = e.target.value;
                if (v) setChs([...chs, v], primary ?? v);
              }}
              style={{ ...inp(), fontSize: 10 }}
            >
              <option value="">+ add channel</option>
              {optsRemaining.map((c) => (
                <option key={c.channel_code} value={c.label}>{c.label}</option>
              ))}
            </select>
          )}
        </div>
      </td>
      <td style={{ minWidth: 140 }}>
        {chs.length === 0 ? (
          <span style={{ color: 'var(--mt)', fontSize: 11 }}>—</span>
        ) : (
          <select
            value={primary || ''}
            onChange={(e) => setChs(chs, e.target.value || null)}
            style={{ ...inp(), width: '100%' }}
          >
            {chs.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        )}
      </td>
    </tr>
  );
}

