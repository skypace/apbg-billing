import { useState } from 'react';
import { TaxonomyEditor } from './settings/TaxonomyEditor';
import { ItemSetsEditor } from './settings/ItemSetsEditor';
import { DigestEditor } from './settings/DigestEditor';
import { ExpenseBucketsEditor } from './settings/ExpenseBucketsEditor';
import { UsersEditor } from './settings/UsersEditor';
import { CustomerClassificationEditor } from './settings/CustomerClassificationEditor';
import { FleetDriversEditor } from './settings/FleetDriversEditor';
import { SalesRepsEditor } from './settings/SalesRepsEditor';
import {
  deleteChannel,
  deleteSegment,
  fetchChannels,
  fetchSegments,
  insertChannel,
  insertSegment,
  updateChannel,
  updateSegment,
} from '../lib/settings';

type Tab =
  | 'channels'
  | 'segments'
  | 'sales_reps'
  | 'item_sets'
  | 'digest'
  | 'classification'
  | 'expense_buckets'
  | 'users'
  | 'fleet_drivers';

const TABS: { id: Tab; label: string }[] = [
  { id: 'channels',        label: 'Channels' },
  { id: 'segments',        label: 'Segments' },
  { id: 'sales_reps',      label: 'Sales Reps' },
  { id: 'item_sets',       label: 'Item Sets' },
  { id: 'digest',          label: 'Email Digest' },
  { id: 'classification',  label: 'Customer Classification' },
  { id: 'expense_buckets', label: 'Expense Buckets' },
  { id: 'fleet_drivers',   label: 'Fleet Drivers' },
  { id: 'users',           label: 'Users' },
];

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('channels');
  const activeLabel = TABS.find((t) => t.id === tab)?.label ?? 'Settings';

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Taxonomy · classification · users</div>
          <h1 className="hero-title">Settings</h1>
          <div className="hero-meta">{activeLabel} · Brix Beverage · Alameda Soda Co</div>
        </div>
        <div className="hero-stamp">
          <span className="status-dot" aria-hidden="true" />
          {TABS.length} sections
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

      {tab === 'channels' && (
        <TaxonomyEditor
          title="CHANNELS"
          description="Customer-facing channel buckets (e.g. Regional Chain QSR, Independent Cafe). Customers can be in multiple."
          fetchAll={fetchChannels}
          insert={(row) => insertChannel({ channel_code: row.code, label: row.label, sort_order: row.sort_order, is_active: row.is_active })}
          update={(code, patch) => updateChannel(code, patch as Parameters<typeof updateChannel>[1])}
          remove={deleteChannel}
          codeKey="channel_code"
          codeLabel="Channel Code"
        />
      )}

      {tab === 'segments' && (
        <TaxonomyEditor
          title="SEGMENTS"
          description="Top-level product segment (Service Business, Fountain Products, Packaged Beverage, Foodservice Gas, etc.)"
          fetchAll={fetchSegments}
          insert={(row) => insertSegment({ segment_code: row.code, label: row.label, sort_order: row.sort_order, is_active: row.is_active })}
          update={(code, patch) => updateSegment(code, patch as Parameters<typeof updateSegment>[1])}
          remove={deleteSegment}
          codeKey="segment_code"
          codeLabel="Segment Code"
        />
      )}

      {tab === 'sales_reps'      && <SalesRepsEditor />}
      {tab === 'item_sets'       && <ItemSetsEditor />}
      {tab === 'digest'          && <DigestEditor />}
      {tab === 'classification'  && <CustomerClassificationEditor />}
      {tab === 'expense_buckets' && <ExpenseBucketsEditor />}
      {tab === 'fleet_drivers'   && <FleetDriversEditor />}
      {tab === 'users'           && <UsersEditor />}
    </div>
  );
}
