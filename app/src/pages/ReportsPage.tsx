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

  return (
    <div>
      <div className="pt">
        Reports <span className="bg bg-l">PRESETS</span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {TABS.map((t) => {
          const on = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                background: on ? 'var(--ac)' : 'var(--sf2)',
                color: on ? 'var(--bg)' : 'var(--tx)',
                border: '1px solid var(--bd)',
                padding: '6px 12px',
                borderRadius: 4,
                fontSize: 11,
                cursor: 'pointer',
                fontWeight: on ? 700 : 500,
                letterSpacing: 0.5,
              }}
            >
              {t.label.toUpperCase()}
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
