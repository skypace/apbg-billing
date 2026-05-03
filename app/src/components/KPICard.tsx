import type { ReactNode } from 'react';

interface Props {
  title: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: string;
}

// One stat tile used across every page. Equivalent of the legacy
// React.createElement(C, ...) helper.
export function KPICard({ title, value, sub, accent }: Props) {
  return (
    <div className="cd">
      <div className="ct">{title}</div>
      <div className="cv" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {sub != null && <div className="cs">{sub}</div>}
    </div>
  );
}
