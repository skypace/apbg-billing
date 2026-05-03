interface Props { title: string; legacyHash: string }

// Phase-1 placeholder: each top-level page renders this until it's
// migrated. Until migration is complete, the legacy single-file SPA
// remains the source of truth at /sales/.
export function PlaceholderPage({ title, legacyHash }: Props) {
  const legacyUrl = '/sales/#' + legacyHash;
  return (
    <div>
      <div className="pt">{title} <span className="bg bg-l">PHASE 1</span></div>
      <div className="cd" style={{ padding: 18 }}>
        <div style={{ fontSize: 12, color: 'var(--mt)', marginBottom: 10 }}>
          This page is being migrated from the legacy single-file SPA to the new
          Vite + React + TypeScript app. Until migration completes, use the
          legacy view linked below.
        </div>
        <a
          href={legacyUrl}
          style={{ fontSize: 12, fontWeight: 600 }}
        >
          → Open legacy {title} ({legacyUrl})
        </a>
      </div>
    </div>
  );
}
