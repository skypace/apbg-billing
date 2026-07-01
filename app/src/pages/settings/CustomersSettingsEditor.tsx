import { useEffect, useMemo, useState } from 'react';
import { DataGridPro, type GridColDef, type GridGroupNode } from '@mui/x-data-grid-pro';
import { AlertTriangle, Search, X } from 'lucide-react';
import { KPICard } from '../../components/KPICard';
import { fm, fmtNum } from '../../lib/formatters';
import { inp } from '../../lib/styles';
import { useToast } from '../../lib/toast';
import {
  Channel,
  CustomersMasterRow,
  EntityOption,
  fetchChannels,
  fetchCustomersMaster,
  fetchEntityOptions,
  setCustomerChannels,
  setCustomerEntity,
  setCustomerNotes,
} from '../../lib/settings';
import {
  SalesRep,
  assignCustomerToRep,
  fetchSalesReps,
  unassignCustomer,
} from '../../lib/salesReps';

const UNASSIGNED = '— Unassigned —';
const ANONYMOUS_LABEL = '(no customer name)';

const ENTITY_COLOR: Record<string, string> = {
  brix:     '#5BB5F0',  // accent blue
  AS:       '#E04F5F',  // red (Alameda Soda)
  freeflow: '#2EB872',  // green
  FF:       '#2EB872',
  shared:   '#94A8BD',
};

import { GRID_SX as BASE_GRID_SX, GRID_DEFAULTS } from '../../lib/gridStyles';

// Shared grid skin, with a taller default height + grouping-toggle accent.
const GRID_SX = {
  ...BASE_GRID_SX,
  height: '66vh',
  '& .MuiDataGrid-groupingCriteriaCellToggle': { color: 'var(--ac)' },
};

function ytdRange() {
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date().getFullYear() + '-01-01';
  return { start, end: today };
}

function displayLabel(r: CustomersMasterRow): string {
  return (r.display_name && r.display_name.trim()) || ANONYMOUS_LABEL;
}

function getTreeDataPath(row: Record<string, unknown>): string[] {
  const channel = String(row.primary_channel ?? UNASSIGNED);
  const parentName = (row.parent_name as string | null) ?? null;
  const ownName = (row.display_name as string | null) ?? ANONYMOUS_LABEL;
  const id = String(row.qbo_customer_id ?? '');
  if (row.is_sub_customer && parentName) {
    return [channel, parentName, ownName + ' /// ' + id];
  }
  return [channel, ownName + ' /// ' + id];
}

export function CustomersSettingsEditor() {
  const toast = useToast();
  const { start, end } = ytdRange();

  const [rows, setRows] = useState<CustomersMasterRow[] | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [reps, setReps] = useState<SalesRep[]>([]);
  const [entityOpts, setEntityOpts] = useState<EntityOption[]>([]);
  const [repByCode, setRepByCode] = useState<Map<string, SalesRep>>(new Map());
  const [assignByCustomer, setAssignByCustomer] = useState<Map<string, string>>(new Map());
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  function load() {
    setRows(null);
    Promise.all([
      fetchCustomersMaster({ start, end, only_active: !showInactive, limit: 1500 }),
      fetchChannels(),
      fetchSalesReps(),
      fetchEntityOptions(),
    ])
      .then(([rs, cs, sr, ents]) => {
        setRows(rs);
        setChannels(cs.filter((c) => c.is_active));
        setReps(sr);
        setEntityOpts(ents);
        const map = new Map<string, SalesRep>();
        for (const r of sr) map.set(r.rep_code, r);
        setRepByCode(map);
        const byName = new Map<string, string>();
        for (const r of sr) byName.set(r.name, r.rep_code);
        const ac = new Map<string, string>();
        for (const row of rs) {
          if (row.primary_sales_rep && byName.has(row.primary_sales_rep)) {
            ac.set(row.qbo_customer_id, byName.get(row.primary_sales_rep)!);
          }
        }
        setAssignByCustomer(ac);
      })
      .catch((e) => { toast.error('Load failed: ' + (e as Error).message); setRows([]); });
  }
  useEffect(load, [showInactive]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      displayLabel(r).toLowerCase().includes(q)
      || (r.parent_name?.toLowerCase().includes(q) ?? false)
      || (r.fully_qualified_name?.toLowerCase().includes(q) ?? false)
      || (r.customer_type_name?.toLowerCase().includes(q) ?? false)
      || (r.primary_channel?.toLowerCase().includes(q) ?? false)
      || (r.entity_resolved?.toLowerCase().includes(q) ?? false)
      || (r.city?.toLowerCase().includes(q) ?? false)
      || (r.address?.toLowerCase().includes(q) ?? false)
      || (r.notes?.toLowerCase().includes(q) ?? false),
    );
  }, [rows, search]);

  const gridRows = useMemo(
    () => filtered.map((r) => ({ ...r, id: r.qbo_customer_id })),
    [filtered],
  );

  const entityChoices = useMemo(() => {
    // Always offer the standard 4 plus any extras seen in data.
    const set = new Set<string>(['brix', 'AS', 'freeflow', 'shared']);
    for (const e of entityOpts) set.add(e.entity);
    for (const r of rows ?? []) if (r.entity) set.add(r.entity);
    return Array.from(set);
  }, [entityOpts, rows]);

  async function patchChannel(qbo_customer_id: string, primary: string | null) {
    try {
      const existing = (rows ?? []).find((r) => r.qbo_customer_id === qbo_customer_id);
      const labels = primary
        ? Array.from(new Set([...(existing?.channels ?? []), primary]))
        : (existing?.channels ?? []);
      await setCustomerChannels(qbo_customer_id, labels, primary);
      setRows((cur) => cur?.map((r) =>
        r.qbo_customer_id === qbo_customer_id
          ? { ...r, primary_channel: primary, channels: primary ? labels : r.channels }
          : r,
      ) ?? cur);
    } catch (e) {
      toast.error('Save failed: ' + (e as Error).message);
      load();
    }
  }

  async function patchEntity(qbo_customer_id: string, entity: string | null) {
    try {
      await setCustomerEntity(qbo_customer_id, entity);
      setRows((cur) => cur?.map((r) =>
        r.qbo_customer_id === qbo_customer_id
          ? { ...r, entity, entity_resolved: entity ?? r.entity_resolved }
          : r,
      ) ?? cur);
      fetchEntityOptions().then(setEntityOpts).catch(() => undefined);
    } catch (e) {
      toast.error('Save failed: ' + (e as Error).message);
      load();
    }
  }

  async function patchRep(qbo_customer_id: string, rep_code: string) {
    try {
      if (!rep_code) {
        await unassignCustomer(qbo_customer_id);
        setAssignByCustomer((cur) => {
          const next = new Map(cur);
          next.delete(qbo_customer_id);
          return next;
        });
        setRows((cur) => cur?.map((r) =>
          r.qbo_customer_id === qbo_customer_id ? { ...r, primary_sales_rep: null, sales_reps: [] } : r,
        ) ?? cur);
        return;
      }
      await assignCustomerToRep(qbo_customer_id, rep_code);
      const rep = repByCode.get(rep_code);
      setAssignByCustomer((cur) => {
        const next = new Map(cur);
        next.set(qbo_customer_id, rep_code);
        return next;
      });
      setRows((cur) => cur?.map((r) =>
        r.qbo_customer_id === qbo_customer_id
          ? { ...r, primary_sales_rep: rep?.name ?? null, sales_reps: rep ? [rep.name] : [] }
          : r,
      ) ?? cur);
    } catch (e) {
      toast.error('Save failed: ' + (e as Error).message);
      load();
    }
  }

  async function patchNotes(qbo_customer_id: string, notes: string | null) {
    try {
      await setCustomerNotes(qbo_customer_id, notes);
      setRows((cur) => cur?.map((r) =>
        r.qbo_customer_id === qbo_customer_id ? { ...r, notes } : r,
      ) ?? cur);
    } catch (e) {
      toast.error('Save failed: ' + (e as Error).message);
      load();
    }
  }

  const columns: GridColDef[] = useMemo(() => [
    {
      field: 'is_sub_customer', headerName: 'Type', width: 70, sortable: true,
      renderCell: (p) => (
        <span style={{
          fontSize: 9, padding: '1px 7px', borderRadius: 10, fontWeight: 700, letterSpacing: 0.4,
          background: p.value ? 'rgba(91,181,240,0.12)' : 'rgba(255,255,255,0.05)',
          color: p.value ? 'var(--ac)' : 'var(--mt)',
          border: '1px solid ' + (p.value ? 'rgba(91,181,240,0.30)' : 'var(--bd)'),
        }}>{p.value ? 'SUB' : 'PARENT'}</span>
      ),
    },
    {
      field: 'active', headerName: 'Active', width: 70,
      renderCell: (p) => (
        <span style={{ fontSize: 10, color: p.value ? 'var(--gn)' : 'var(--mt)', fontWeight: 600 }}>
          {p.value ? 'YES' : 'NO'}
        </span>
      ),
    },
    {
      field: 'entity_resolved', headerName: 'Entity', width: 110, sortable: true,
      renderCell: (p) => {
        const override = p.row.entity as string | null;
        const value = override ?? p.row.entity_resolved ?? '';
        const color = ENTITY_COLOR[value] ?? 'var(--mt)';
        const derived = !override;
        return (
          <select
            value={value}
            onChange={(e) => patchEntity(p.row.qbo_customer_id, e.target.value || null)}
            style={{
              ...inp(), width: '100%', fontSize: 11,
              color, fontWeight: 700, letterSpacing: 0.5,
              borderStyle: derived ? 'dashed' : 'solid',
              borderColor: derived ? 'var(--bd)' : color,
            }}
            title={derived ? 'Derived from name; pick a value to lock the override' : 'Manual override; clear to revert to derivation'}
          >
            <option value="">— derive —</option>
            {entityChoices.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        );
      },
    },
    {
      field: 'primary_channel', headerName: 'Primary Channel', width: 200,
      renderCell: (p) => (
        <select
          value={p.value ?? ''}
          onChange={(e) => patchChannel(p.row.qbo_customer_id, e.target.value || null)}
          style={{ ...inp(), width: '100%', fontSize: 11,
            color: p.value ? 'var(--ac)' : 'var(--mt)',
            fontWeight: p.value ? 600 : 400 }}
        >
          <option value="">— unassigned —</option>
          {channels.map((c) => (
            <option key={c.channel_code} value={c.label}>{c.label}</option>
          ))}
        </select>
      ),
    },
    {
      field: 'primary_sales_rep', headerName: 'Sales Rep', width: 180,
      renderCell: (p) => {
        const code = assignByCustomer.get(p.row.qbo_customer_id) ?? '';
        return (
          <select
            value={code}
            onChange={(e) => patchRep(p.row.qbo_customer_id, e.target.value)}
            style={{ ...inp(), width: '100%', fontSize: 11,
              color: code ? 'var(--ac)' : 'var(--mt)',
              fontWeight: code ? 600 : 400 }}
          >
            <option value="">— unassigned —</option>
            {reps.filter((r) => r.is_active || r.rep_code === code).map((r) => (
              <option key={r.rep_code} value={r.rep_code}>{r.rep_code} · {r.name}</option>
            ))}
          </select>
        );
      },
    },
    {
      field: 'city', headerName: 'City', width: 120,
      renderCell: (p) => (
        <span style={{ color: p.value ? 'var(--tx)' : 'var(--mt)', fontSize: 11 }}>{p.value || '—'}</span>
      ),
    },
    {
      field: 'address', headerName: 'Address', width: 200,
      renderCell: (p) => (
        <span style={{
          color: p.value ? 'var(--tx2)' : 'var(--mt)', fontSize: 10.5,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block',
        }}>{p.value || '—'}</span>
      ),
    },
    {
      field: 'state', headerName: 'State', width: 65,
      renderCell: (p) => (
        <span style={{ color: 'var(--tx2)', fontSize: 11 }}>{p.value || '—'}</span>
      ),
    },
    {
      field: 'ytd_revenue', headerName: 'YTD Rev', type: 'number', width: 110, cellClassName: 'mn',
      valueFormatter: (v) => fm(Number(v ?? 0)),
    },
    {
      field: 'invoice_count', headerName: 'Invoices', type: 'number', width: 80, cellClassName: 'mn',
      valueFormatter: (v) => fmtNum(Number(v ?? 0)),
    },
    {
      field: 'last_invoice_date', headerName: 'Last Inv', width: 100,
      valueFormatter: (v) => v ? String(v).slice(0, 10) : '—',
    },
    {
      field: 'ar_total', headerName: 'AR Total', type: 'number', width: 100, cellClassName: 'mn',
      renderCell: (p) => {
        const v = Number(p.value ?? 0);
        return <span style={{ color: v > 0 ? 'var(--tx)' : 'var(--mt)', fontWeight: v > 0 ? 600 : 400 }}>{fm(v)}</span>;
      },
    },
    {
      field: 'ar_31_60', headerName: '31-60', type: 'number', width: 80, cellClassName: 'mn',
      renderCell: (p) => {
        const v = Number(p.value ?? 0);
        return v > 0 ? <span style={{ color: 'var(--am)' }}>{fm(v)}</span> : <span style={{ color: 'var(--mt)' }}>—</span>;
      },
    },
    {
      field: 'ar_61_90', headerName: '61-90', type: 'number', width: 80, cellClassName: 'mn',
      renderCell: (p) => {
        const v = Number(p.value ?? 0);
        return v > 0 ? <span style={{ color: 'var(--am)' }}>{fm(v)}</span> : <span style={{ color: 'var(--mt)' }}>—</span>;
      },
    },
    {
      field: 'ar_90_plus', headerName: '90+', type: 'number', width: 90, cellClassName: 'mn',
      renderCell: (p) => {
        const v = Number(p.value ?? 0);
        return v > 0 ? <span style={{ color: 'var(--rd)', fontWeight: 700 }}>{fm(v)}</span> : <span style={{ color: 'var(--mt)' }}>—</span>;
      },
    },
    {
      field: 'notes', headerName: 'Notes', flex: 1, minWidth: 180,
      renderCell: (p) => (
        <input type="text" defaultValue={p.value ?? ''}
          placeholder="—"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (p.value ?? '')) patchNotes(p.row.qbo_customer_id, v || null);
          }}
          style={{ ...inp(), width: '100%', fontSize: 11 }} />
      ),
    },
  ], [channels, reps, assignByCustomer, repByCode, entityChoices]); // eslint-disable-line react-hooks/exhaustive-deps

  const groupingColDef = useMemo(() => ({
    headerName: 'Channel / Customer', width: 320, hideDescendantCount: false,
    // Group rows are channel/parent headers — they have no qbo_customer_id and
    // shouldn't render the per-row dropdowns. Spanning the whole grid keeps
    // them visually distinct and stops e.g. the "Primary Channel" select from
    // showing "— unassigned —" on every section header.
    colSpan: (_value: unknown, row: Record<string, unknown>) => {
      const isGroup = row?.qbo_customer_id == null;
      return isGroup ? columns.length + 1 : 1;
    },
    renderCell: (params: {
      rowNode: { type: string; groupingKey?: string | number | null; depth?: number };
      row: { display_name?: string; is_sub_customer?: boolean; ar_total?: number };
    }) => {
      if (params.rowNode.type === 'group') {
        const key = params.rowNode.groupingKey;
        const depth = params.rowNode.depth ?? 0;
        if (depth === 0) {
          return <strong style={{ color: 'var(--ac)' }}>{key == null ? UNASSIGNED : String(key)}</strong>;
        }
        return <strong style={{ color: 'var(--tx)', fontWeight: 600 }}>{String(key ?? '')}</strong>;
      }
      const name = params.row.display_name?.trim();
      const isBlank = !name;
      if (isBlank) {
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--am)', fontStyle: 'italic' }}>
            <AlertTriangle size={11} strokeWidth={2.4} aria-hidden="true" />
            {ANONYMOUS_LABEL}
            {(params.row.ar_total ?? 0) > 0 && (
              <span style={{ fontSize: 9, color: 'var(--rd)' }}>· has AR</span>
            )}
          </span>
        );
      }
      return (
        <span style={{ fontWeight: 600, paddingLeft: params.row.is_sub_customer ? 4 : 0 }}>
          {params.row.is_sub_customer ? '↳ ' : ''}{name}
        </span>
      );
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any, [columns.length]);

  if (!rows) return <div className="ld">Loading customers…</div>;

  const totalRev = rows.reduce((s, r) => s + Number(r.ytd_revenue || 0), 0);
  const totalAr = rows.reduce((s, r) => s + Number(r.ar_total || 0), 0);
  const past90 = rows.reduce((s, r) => s + Number(r.ar_90_plus || 0), 0);
  const unassignedCount = rows.filter((r) => !r.primary_channel).length;
  const blankNameWithAr = rows.filter((r) => (!r.display_name || !r.display_name.trim()) && r.ar_total > 0).length;
  const entityCounts = rows.reduce<Record<string, number>>((acc, r) => {
    const e = r.entity_resolved || 'unknown';
    acc[e] = (acc[e] ?? 0) + 1;
    return acc;
  }, {});
  const entitySummary = Object.entries(entityCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([e, n]) => `${n} ${e}`)
    .join(' · ');

  return (
    <div>
      <div className="gr g4" style={{ marginBottom: 12 }}>
        <KPICard title="CUSTOMERS" value={rows.length} sub={entitySummary || 'all customers shown'} />
        <KPICard title="YTD REVENUE" value={fm(totalRev)} accent="var(--ac)" sub="all customers shown" />
        <KPICard title="AR OUTSTANDING" value={fm(totalAr)} sub="open invoices" />
        <KPICard
          title="UNASSIGNED CHANNEL"
          value={unassignedCount}
          accent={unassignedCount > 0 ? 'var(--am)' : undefined}
          sub={past90 > 0 ? fm(past90) + ' past 90' : 'all classified'}
        />
      </div>

      {blankNameWithAr > 0 && (
        <div className="cd" style={{
          padding: '8px 12px', marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center',
          fontSize: 11, borderColor: 'var(--am)', background: 'rgba(244,180,0,0.06)',
        }}>
          <AlertTriangle size={14} strokeWidth={2.2} color="var(--am)" aria-hidden="true" />
          <span style={{ color: 'var(--tx)' }}>
            <strong>{blankNameWithAr}</strong> blank-name customer{blankNameWithAr === 1 ? '' : 's'} carry open AR.
            These are invoices booked against deleted or merged QBO customers — investigate or void in QBO.
          </span>
        </div>
      )}

      <div className="cd" style={{
        padding: '10px 12px', marginBottom: 14, display: 'flex',
        gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11,
      }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', height: 30, borderRadius: 4,
          background: 'var(--bg)', border: '1px solid var(--bd)', minWidth: 280,
        }}>
          <Search size={13} strokeWidth={2.2} color="var(--mt)" aria-hidden="true" />
          <input type="text" value={search} placeholder="Search name, parent, entity, channel, city, address, notes…"
            onChange={(e) => setSearch(e.target.value)}
            style={{
              background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--tx)', fontFamily: 'var(--ff-mono)', fontSize: 12,
              flex: 1, padding: 0,
            }} />
          {search && (
            <button onClick={() => setSearch('')} aria-label="Clear"
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, display: 'inline-flex' }}>
              <X size={12} strokeWidth={2.4} color="var(--mt)" />
            </button>
          )}
        </div>
        <span style={{ color: 'var(--mt)', marginLeft: 6 }}>
          {filtered.length} of {rows.length} customers
        </span>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 10, cursor: 'pointer', color: 'var(--mt)' }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)}
            style={{ accentColor: 'var(--ac)' }} />
          show inactive
        </label>
        <button onClick={load} className="tb-btn" style={{ marginLeft: 'auto' }}>Refresh</button>
      </div>

      <div className="cd" style={{ padding: 0, overflow: 'hidden' }}>
        {filtered.length === 0 ? (
          <div className="ld">No customers match.</div>
        ) : (
          <DataGridPro
            rows={gridRows} columns={columns}
            treeData getTreeDataPath={getTreeDataPath}
            groupingColDef={groupingColDef}
            density="compact" pagination disableRowSelectionOnClick
            isRowSelectable={(p) => (p.row as { qbo_customer_id?: string }).qbo_customer_id != null}
            pageSizeOptions={[20, 40, 60, 100, 250, { value: -1, label: 'All' }]}
            defaultGroupingExpansionDepth={1}
            initialState={{
              pagination: { paginationModel: { pageSize: 60, page: 0 } },
              sorting: { sortModel: [{ field: 'ytd_revenue', sort: 'desc' }] },
            }}
            isGroupExpandedByDefault={(node: GridGroupNode) =>
              node.groupingKey !== UNASSIGNED}
            {...GRID_DEFAULTS}
            sx={GRID_SX}
          />
        )}
      </div>

      <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 8, lineHeight: 1.4 }}>
        <strong style={{ color: 'var(--tx)' }}>Entity</strong> is the brand/business the customer
        belongs to (brix · AS · freeflow · shared). Dashed border = auto-derived from name; solid
        border = manual override. Pick a value to lock it. The Margin Control entity filter now sources
        from these values, not the old hardcoded list.
      </div>
    </div>
  );
}
