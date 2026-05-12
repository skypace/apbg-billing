import { ArrowRight, ExternalLink, Truck } from 'lucide-react';

interface Props { title: string; legacyHash: string }

// Two flavors:
//   1. Fleet — moved to apbg-ops.netlify.app; render a clear "moved" card
//   2. Anything else — phase-1 placeholder pointing at the legacy SPA
export function PlaceholderPage({ title, legacyHash }: Props) {
  if (title === 'Fleet') return <FleetMoved />;

  const legacyUrl = '/sales/#' + legacyHash;
  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">In progress · Phase 1</div>
          <h1 className="hero-title">{title}</h1>
          <div className="hero-meta">
            Migration from the legacy single-file SPA. Use the legacy view below
            until this page is fully ported.
          </div>
        </div>
      </div>

      <a
        href={legacyUrl}
        className="cd"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '18px 22px',
          textDecoration: 'none',
          color: 'var(--tx)',
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(45, 202, 214, 0.12)',
            color: 'var(--ac)',
          }}
        >
          <ExternalLink size={18} strokeWidth={2.2} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
            Open legacy {title}
          </div>
          <div style={{ fontSize: 11, color: 'var(--mt)', fontFamily: 'var(--ff-mono)' }}>
            {legacyUrl}
          </div>
        </div>
        <ArrowRight size={16} color="var(--ac)" strokeWidth={2.4} />
      </a>
    </div>
  );
}

function FleetMoved() {
  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Moved · 2026</div>
          <h1 className="hero-title">Fleet has a new home</h1>
          <div className="hero-meta">
            Driver, vehicle, and route operations now live on the dedicated
            <strong style={{ color: 'var(--tx)', margin: '0 4px' }}>APBG Ops</strong>
            site so this app can stay focused on margin and customer health.
          </div>
        </div>
      </div>

      <a
        href="https://apbg-ops.netlify.app"
        target="_blank"
        rel="noopener noreferrer"
        className="cd"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '20px 24px',
          textDecoration: 'none',
          color: 'var(--tx)',
          marginBottom: 14,
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            display: 'grid',
            placeItems: 'center',
            background: 'var(--grad-acc)',
            color: 'var(--bg)',
            flex: 'none',
          }}
        >
          <Truck size={22} strokeWidth={2.2} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 3 }}>
            Open APBG Ops
          </div>
          <div style={{ fontSize: 11, color: 'var(--mt)', fontFamily: 'var(--ff-mono)' }}>
            apbg-ops.netlify.app
          </div>
        </div>
        <ArrowRight size={18} color="var(--ac)" strokeWidth={2.4} />
      </a>

      <div
        className="cd"
        style={{
          padding: '14px 18px',
          fontSize: 12,
          color: 'var(--mt)',
          lineHeight: 1.5,
        }}
      >
        <strong style={{ color: 'var(--tx)' }}>What moved:</strong>{' '}
        Driver KPIs, route assignments, vehicle service intervals, fuel logs.
        <br />
        <strong style={{ color: 'var(--tx)' }}>What stayed:</strong>{' '}
        Operations rollup KPIs (delivery / service / reman) — those still live
        under <a href="#operations">Operations</a> here in BRIX.
      </div>
    </div>
  );
}
