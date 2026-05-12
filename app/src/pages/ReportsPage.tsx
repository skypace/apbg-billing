import { useState } from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import { InactiveCustomersReport } from './reports/InactiveCustomersReport';
import { TopMoversReport } from './reports/TopMoversReport';
import { HealthMoversReport } from './reports/HealthMoversReport';
import { AnomaliesReport } from './reports/AnomaliesReport';
import { VoidsReport } from './reports/VoidsReport';

type TabId = 'inactive' | 'movers' | 'health_movers' | 'anomalies' | 'voids';

const TABS: { id: TabId; label: string }[] = [
  { id: 'inactive',      label: 'Lost / Inactive' },
  { id: 'movers',        label: 'Top Movers' },
  { id: 'health_movers', label: 'Health Movers (RFM)' },
  { id: 'anomalies',     label: 'Revenue Anomalies' },
  { id: 'voids',         label: 'Voids / Cross-Sell' },
];

export function ReportsPage() {
  const [tab, setTab] = useState<TabId>('inactive');
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

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v as TabId)}
        sx={{
          minHeight: 36, mb: 1.5, borderBottom: '1px solid var(--bd)',
          '& .MuiTabs-indicator': { background: 'var(--ac)', height: 2 },
          '& .MuiTab-root': {
            minHeight: 36, padding: '6px 18px', textTransform: 'uppercase',
            color: 'var(--mt)', fontSize: 11, fontWeight: 600, letterSpacing: 0.6, fontFamily: 'inherit',
          },
          '& .Mui-selected': { color: 'var(--ac) !important' },
        }}
      >
        {TABS.map((t) => <Tab key={t.id} value={t.id} label={t.label} />)}
      </Tabs>

      {tab === 'inactive'      && <InactiveCustomersReport />}
      {tab === 'movers'        && <TopMoversReport />}
      {tab === 'health_movers' && <HealthMoversReport />}
      {tab === 'anomalies'     && <AnomaliesReport />}
      {tab === 'voids'         && <VoidsReport />}
    </div>
  );
}
