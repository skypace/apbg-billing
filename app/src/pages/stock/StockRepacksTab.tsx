import { useMemo, useState } from 'react';
import { PackageOpen, ExternalLink } from 'lucide-react';
import { btnPrimary } from '../../lib/styles';

// The repack sheet is a standalone staff page (public/repack.html) so the warehouse
// can open it from the hub tile at alamedapointbg.com/repack on a tablet. This tab
// FRAMES that page rather than re-implementing it — one sheet, one write path
// (/api/repack → ops.fn_repack_create + the QuickBooks InventoryAdjustment), or the
// two surfaces disagree the first time one of them changes.
//
// Path differs by how Refractor was reached: behind the gateway the page is at
// /repack (proxied); on the bare Netlify host it is /repack.html. Same derivation
// RunGuideTab uses for the handbook.
function repackUrl(embed: boolean, packs: string | null = null): string {
  const origin = typeof location === 'undefined' ? '' : location.origin;
  const path = typeof location === 'undefined' ? '' : location.pathname;
  const base = path.includes('/margin/') ? '/repack' : '/repack.html';
  const q: string[] = [];
  if (embed) q.push('embed=1');
  if (packs) q.push(`packs=${encodeURIComponent(packs)}`);
  return `${origin}${base}${q.length ? `?${q.join('&')}` : ''}`;
}

// Inventory Planning's suggested 8-packs, if the Reorder tab sent us here:
// "<packItemId>:<packs>,…" — the sheet converts packs to whole cases itself
// (3 packs a case), because that rule lives in ops.repack_settings, not here.
function readRepackPrefill(): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  const raw = sessionStorage.getItem('brix.repack.prefill');
  if (!raw) return null;
  sessionStorage.removeItem('brix.repack.prefill');
  try {
    const parsed = JSON.parse(raw) as { packs?: { qbo_item_id: string; qty: number }[] };
    const parts = (parsed.packs ?? []).filter((p) => p.qbo_item_id && Number(p.qty) > 0)
      .map((p) => `${p.qbo_item_id}:${Math.ceil(Number(p.qty))}`);
    return parts.length ? parts.join(',') : null;
  } catch { return null; }
}

export function StockRepacksTab() {
  const [prefill] = useState<string | null>(() => readRepackPrefill());
  const url = useMemo(() => repackUrl(false), []);
  const framed = useMemo(() => repackUrl(true, prefill), [prefill]);
  const [frameFailed, setFrameFailed] = useState(false);

  return (
    <div>
      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <PackageOpen size={18} style={{ color: 'var(--ac)', marginTop: 2, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>Repack sheet — cases into 8-packs</div>
            {prefill && (
              <div style={{ fontSize: 11.5, color: 'var(--ac)', marginTop: 4, fontWeight: 600 }}>
                Prefilled from Inventory Planning — the cases to repack are the suggested 8-packs ÷ 3, rounded up. Check them before you sign.
              </div>
            )}
            <div style={{ fontSize: 11.5, color: 'var(--mt)', marginTop: 3, lineHeight: 1.5 }}>
              Enter the 24-pack cases used and the 8-packs made, sign, save. The cases leave the Brix Warehouse
              count, the 8-packs arrive, and the same adjustment posts to QuickBooks as one InventoryAdjustment.
              The same page is on the hub as a tile, for the warehouse tablet.
            </div>
          </div>
          <a href={url} target="_blank" rel="noopener noreferrer"
             style={{ ...btnPrimary(), textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ExternalLink size={13} /> Open in a new tab
          </a>
        </div>
      </div>

      {frameFailed ? (
        <div className="card" style={{ padding: 16, fontSize: 12, color: 'var(--mt)' }}>
          The repack sheet could not be shown inside this page. Use{' '}
          <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ac)' }}>Open in a new tab</a>.
        </div>
      ) : (
        <iframe
          title="Repack sheet"
          src={framed}
          onError={() => setFrameFailed(true)}
          style={{
            width: '100%', height: 'calc(100vh - 320px)', minHeight: 620,
            border: '1px solid var(--bd)', borderRadius: 10, background: '#0B1B26',
          }}
        />
      )}
    </div>
  );
}
