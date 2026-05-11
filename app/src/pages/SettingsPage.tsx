import { useState } from 'react';
import { TaxonomyEditor } from './settings/TaxonomyEditor';
import { ItemSetsEditor } from './settings/ItemSetsEditor';
import { DigestEditor } from './settings/DigestEditor';
import { ExpenseBucketsEditor } from './settings/ExpenseBucketsEditor';
import { UsersEditor } from './settings/UsersEditor';
import { CustomerClassificationEditor } from './settings/CustomerClassificationEditor';
import { FleetDriversEditor } from './settings/FleetDriversEditor';
import { SalesRepsEditor } from './settings/SalesRepsEditor';
import { ChainModifiersEditor } from './settings/ChainModifiersEditor';
import { EntityDefaultsEditor } from './settings/EntityDefaultsEditor';
import { TaxonomyRulesEditor } from './settings/TaxonomyRulesEditor';
import {
  deleteChannel, deleteSegment,
  fetchChannels, fetchSegments,
  insertChannel, insertSegment,
  updateChannel, updateSegment,
} from '../lib/settings';

type Tab =
  | 'channels' | 'segments' | 'sales_reps'
  | 'rollups' | 'entity_defaults' | 'taxonomy'
  | 'item_sets' | 'digest' | 'classification'
  | 'expense_buckets' | 'users' | 'fleet_drivers';

const TABS: { id: Tab; label: string; group: string }[] = [
  // Filter & taxonomy
  { id: 'rollups',         label: 'Chain Rollups',           group: 'Filters & Taxonomy' },
  { id: 'entity_defaults', label: 'Entity Defaults',         group: 'Filters & Taxonomy' },
  { id: 'taxonomy',        label: 'Item & Customer Groups',  group: 'Filters & Taxonomy' },
  // Customer & item
  { id: 'channels',        label: 'Channels',                group: 'Customer & Item' },
  { id: 'segments',        label: 'Segments',                group: 'Customer & Item' },
  { id: 'sales_reps',      label: 'Sales Reps',              group: 'Customer & Item' },
  { id: 'item_sets',       label: 'Item Sets',               group: 'Customer & Item' },
  { id: 'classification',  label: 'Customer Classification', group: 'Customer & Item' },
  // Operations — overhead now managed via Expense Buckets allocable flag
  { id: 'expense_buckets', label: 'Expense Buckets / Overhead', group: 'Operations' },
  { id: 'digest',          label: 'Email Digest',            group: 'Operations' },
  { id: 'fleet_drivers',   label: 'Fleet Drivers',           group: 'Operations' },
  { id: 'users',           label: 'Users',                   group: 'Operations' },
];

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('rollups');
  const active = TABS.find((t) => t.id === tab);
  const groups = Array.from(new Set(TABS.map((t) => t.group)));

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">{active?.group ?? 'Settings'}</div>
          <h1 className="hero-title">Settings</h1>
          <div className="hero-meta">{active?.label ?? '—'} · Brix Beverage · Alameda Soda Co</div>
        </div>
        <div className="hero-stamp">
          <span className="status-dot" aria-hidden="true" />
          {TABS.length} sections
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
        {groups.map((g) => (
          <div key={g} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{
              fontSize: 9, color: 'var(--mt)', letterSpacing: 1.2,
              textTransform: 'uppercase', fontWeight: 600, minWidth: 130,
            }}>{g}</span>
            {TABS.filter((t) => t.group === g).map((t) => {
              const on = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)}
                  className={'tb-btn' + (on ? ' tb-btn--primary' : '')}
                  style={on ? { fontWeight: 700 } : undefined}>
                  {t.label}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {tab === 'rollups'         && <ChainModifiersEditor />}
      {tab === 'entity_defaults' && <EntityDefaultsEditor />}
      {tab === 'taxonomy'        && <TaxonomyRulesEditor />}

      {tab === 'channels' && (
        <TaxonomyEditor
          title="CHANNELS"
          description="Customer-facing channel buckets (e.g. Regional Chain QSR, Independent Cafe)."
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
          description="Top-level product segment (Service Business, Fountain Products, Packaged Beverage, etc.)"
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
