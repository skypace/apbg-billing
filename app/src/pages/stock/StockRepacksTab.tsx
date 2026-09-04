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
function repackUrl(embed: boolean): string {
  const origin = typeof location === 'undefined' ? '' : location.origin;
  const path = typeof location === 'undefined' ? '' : location.pathname;
  const base = path.includes('/margin/') ? '/repack' : '/repack.html';
  return `${origin}${base}${embed ? '?embed=1' : ''}`;
}

export function StockRepacksTab() {
  const url = useMemo(() => repackUrl(false), []);
  const framed = useMemo(() => repackUrl(true), []);
  const [frameFailed, setFrameFailed] = useState(false);

  return (
    <div>
      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <PackageOpen size={18} style={{ color: 'var(--ac)', marginTop: 2, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>Repack sheet — cases into 8-packs</div>
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
