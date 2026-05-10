import { useState } from 'react';
import { InactiveCustomersReport } from './reports/InactiveCustomersReport';
import { TopMoversReport } from './reports/TopMoversReport';
import { HealthMoversReport } from './reports/HealthMoversReport';
import { AnomaliesReport } from './reports/AnomaliesReport';
import { VoidsReport } from './reports/VoidsReport';

type Tab = 'inactive' | 'movers' | 'health_movers' | 'anomalies' | 'voids';

const TABS: { id: Tab; label: string }[] = [
  { id: 'inactive',      label: 'Lost / Inactive Customers' },
  { id: 'movers',        label: 'Top Movers' },
  { id: 'health_movers', label: 'Health Movers (RFM)' },
  { id: 'anomalies',     label: 'Revenue Anomalies' },
  { id: 'voids',         label: 'Product Voids / Cross-Sell' },
];

export function ReportsPage() {
  const [tab, setTab] = useState<Tab>('inactive');
  const activeLabel = TABS.find((t) => t.id === tab)?.label ?? 'Reports';

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Lost · Movers · Anomalies · Voids</div>
          <h1 className="hero-title">Reports</h1>
          <div className="hero-meta">{activeLabel}</div>
        </div>
        <div className="hero-stamp">
          <span className="status-dot" aria-hidden="true" />
          {TABS.length} preset reports
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {TABS.map((t) => {
          const on = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={'tb-btn' + (on ? ' tb-btn--primary' : '')}
              style={on ? { fontWeight: 700 } : undefined}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'inactive'      && <InactiveCustomersReport />}
      {tab === 'movers'        && <TopMoversReport />}
      {tab === 'health_movers' && <HealthMoversReport />}
      {tab === 'anomalies'     && <AnomaliesReport />}
      {tab === 'voids'         && <VoidsReport />}
    </div>
  );
}
