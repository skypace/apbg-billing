import { useEffect, useMemo, useState } from 'react';
import { ClipboardCopy, PackageCheck, TriangleAlert } from 'lucide-react';
import {
  BomMaterialRequirement, fetchBomMaterialRequirements,
} from '../../lib/production';
import { useToast } from '../../lib/toast';
import { btnSecondary } from '../../lib/styles';
import { fm } from '../../lib/formatters';
import { fmtQty } from '../../lib/uom';

type Status = BomMaterialRequirement['status'];

const STATUS_META: Record<Status, { label: string; color: string }> = {
  ok: { label: 'OK', color: 'var(--gn)' },
  on_order: { label: 'On order', color: 'var(--am)' },
  short: { label: 'Short', color: 'var(--am)' },
  no_stock: { label: 'No stock', color: 'var(--rd)' },
};

interface Props {
  bomId: string | null | undefined;
  targetQty: number | null | undefined;
  targetUom: string | null | undefined;
  locationId?: string | null;
  locationLabel?: string | null;
  title?: string;
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function MaterialRequirementsPanel({
  bomId, targetQty, targetUom, locationId = null, locationLabel = null,
  title = 'Raw material requirements',
}: Props) {
  const toast = useToast();
  const [rows, setRows] = useState<BomMaterialRequirement[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const qty = Number(targetQty ?? 0);
  const canLoad = !!bomId && qty > 0;

  useEffect(() => {
    let alive = true;
    if (!canLoad || !bomId) {
      setRows(null);
      setError(null);
      return () => { alive = false; };
    }
    setRows(null);
    setError(null);
    fetchBomMaterialRequirements({
      bom_id: bomId,
      target_qty: qty,
      target_uom: targetUom || null,
      location_id: locationId || null,
    })
      .then((r) => { if (alive) setRows(r); })
      .catch((e) => { if (alive) { setRows([]); setError(errMsg(e)); } });
    return () => { alive = false; };
  }, [bomId, canLoad, qty, targetUom, locationId]);

  const summary = useMemo(() => {
    const list = rows ?? [];
    const shortageRows = list.filter((r) => Number(r.shortage_qty) > 0);
    const onOrderRows = list.filter((r) => r.status === 'on_order');
    return {
      total: list.length,
      short: shortageRows.length,
      onOrder: onOrderRows.length,
      shortageCost: shortageRows.reduce((sum, r) => sum + Number(r.shortage_cost ?? 0), 0),
    };
  }, [rows]);

  async function copyBuyList() {
    const shortageRows = (rows ?? []).filter((r) => Number(r.shortage_qty) > 0);
    if (shortageRows.length === 0) return;
    const body = shortageRows.map((r) => {
      const source = locationId ? Number(r.location_on_hand_qty ?? 0) : Number(r.on_hand_qty ?? 0);
      return [
        r.item_name ?? r.component_qbo_item_id,
        `buy ${fmtQty(Number(r.shortage_qty), r.required_uom || 'each')}`,
        `need ${fmtQty(Number(r.required_qty), r.required_uom || 'each')}`,
        `stock ${fmtQty(source, r.required_uom || 'each')}`,
        `on order ${fmtQty(Number(r.on_order_qty ?? 0), r.required_uom || 'each')}`,
      ].join(' | ');
    }).join('\n');
    try {
      await navigator.clipboard.writeText(body);
      toast.success('Buy list copied');
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  const loading = canLoad && rows === null && !error;
  const hasLocation = !!locationId;

  return (
    <section style={{
      marginTop: 12,
      marginBottom: 14,
      padding: 12,
      border: '1px solid var(--bd)',
      borderRadius: 4,
      background: 'rgba(255,255,255,0.025)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {summary.short > 0 ? <TriangleAlert size={15} color="var(--am)" /> : <PackageCheck size={15} color="var(--gn)" />}
          <div>
            <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>
              {title}
            </div>
            <div style={{ fontSize: 11, color: 'var(--mt)', marginTop: 2 }}>
              {locationLabel ? `Source: ${locationLabel}` : 'Source: all stocked locations'} · on order includes BRIX POs and imported open QBO POs
            </div>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <MiniStat label="Items" value={loading ? '…' : String(summary.total)} />
        <MiniStat label="Short" value={loading ? '…' : String(summary.short)} tone={summary.short > 0 ? 'warn' : 'ok'} />
        <MiniStat label="Short $" value={loading ? '…' : fm(summary.shortageCost)} tone={summary.shortageCost > 0 ? 'warn' : 'ok'} />
        <button onClick={copyBuyList} style={btnSecondary()} disabled={!rows || summary.short === 0}>
          <ClipboardCopy size={12} style={{ marginRight: 4, verticalAlign: -1 }} /> Copy Buy List
        </button>
      </div>

      {!canLoad && (
        <div style={{ fontSize: 11, color: 'var(--mt)' }}>
          Pick a BOM and quantity to see raw material requirements.
        </div>
      )}
      {loading && (
        <div style={{ fontSize: 11, color: 'var(--mt)' }}>Checking materials…</div>
      )}
      {error && (
        <div style={{ fontSize: 11, color: 'var(--rd)' }}>{error}</div>
      )}
      {rows && rows.length === 0 && !error && (
        <div style={{ fontSize: 11, color: 'var(--mt)' }}>
          This BOM has no component lines to check.
        </div>
      )}
      {rows && rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, minWidth: hasLocation ? 760 : 660 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--bd)' }}>
                <th style={th}>Component</th>
                <th style={{ ...th, textAlign: 'right' }}>Required</th>
                <th style={{ ...th, textAlign: 'right' }}>{hasLocation ? 'Source stock' : 'Stock'}</th>
                {hasLocation && <th style={{ ...th, textAlign: 'right' }}>All stock</th>}
                <th style={{ ...th, textAlign: 'right' }}>On order</th>
                <th style={{ ...th, textAlign: 'right' }}>Short</th>
                <th style={{ ...th, textAlign: 'right' }}>Short $</th>
                <th style={{ ...th, textAlign: 'center' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const uom = r.required_uom || 'each';
                const sourceStock = hasLocation ? Number(r.location_on_hand_qty ?? 0) : Number(r.on_hand_qty ?? 0);
                const meta = STATUS_META[r.status] ?? STATUS_META.short;
                return (
                  <tr key={`${r.component_qbo_item_id}-${uom}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td style={td}>
                      <strong>{r.item_name ?? r.component_qbo_item_id}</strong>
                      {r.source_line_count > 1 && (
                        <span style={{ marginLeft: 6, color: 'var(--mt)', fontSize: 9 }}>
                          {r.source_line_count} lines
                        </span>
                      )}
                    </td>
                    <td style={numTd}>{fmtQty(Number(r.required_qty), uom)}</td>
                    <td style={numTd}>{fmtQty(sourceStock, uom)}</td>
                    {hasLocation && <td style={numTd}>{fmtQty(Number(r.on_hand_qty ?? 0), uom)}</td>}
                    <td style={numTd}>{fmtQty(Number(r.on_order_qty ?? 0), uom)}</td>
                    <td style={{ ...numTd, color: Number(r.shortage_qty) > 0 ? 'var(--am)' : 'var(--gn)' }}>
                      {fmtQty(Number(r.shortage_qty), uom)}
                    </td>
                    <td style={{ ...numTd, color: Number(r.shortage_cost) > 0 ? 'var(--am)' : 'var(--mt)' }}>
                      {fm(Number(r.shortage_cost ?? 0))}
                    </td>
                    <td style={{ ...td, textAlign: 'center' }}>
                      <span style={{
                        color: meta.color,
                        border: `1px solid ${meta.color}`,
                        borderRadius: 12,
                        padding: '1px 7px',
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: 0.4,
                      }}>
                        {meta.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  return (
    <div style={{ minWidth: 58 }}>
      <div style={{ fontSize: 9, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase' }}>{label}</div>
      <div style={{
        fontSize: 12,
        fontWeight: 700,
        color: tone === 'warn' ? 'var(--am)' : tone === 'ok' ? 'var(--gn)' : 'var(--tx)',
        fontFamily: 'var(--ff-mono)',
      }}>{value}</div>
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '7px 9px',
  fontSize: 9,
  fontWeight: 600,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  color: 'var(--mt)',
};
const td: React.CSSProperties = { padding: '6px 9px', verticalAlign: 'middle' };
const numTd: React.CSSProperties = {
  ...td,
  textAlign: 'right',
  fontFamily: 'var(--ff-mono)',
  whiteSpace: 'nowrap',
};
