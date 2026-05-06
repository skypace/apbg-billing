import { useState } from 'react';
import { TaxonomyEditor } from './settings/TaxonomyEditor';
import { ItemSetsEditor } from './settings/ItemSetsEditor';
import { DigestEditor } from './settings/DigestEditor';
import { ExpenseBucketsEditor } from './settings/ExpenseBucketsEditor';
import { UsersEditor } from './settings/UsersEditor';
import { CustomerClassificationEditor } from './settings/CustomerClassificationEditor';
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
  | 'item_sets'
  | 'digest'
  | 'classification'
  | 'expense_buckets'
  | 'users';

const TABS: { id: Tab; label: string }[] = [
  { id: 'channels',        label: 'Channels' },
  { id: 'segments',        label: 'Segments' },
  { id: 'item_sets',       label: 'Item Sets' },
  { id: 'digest',          label: 'Email Digest' },
  { id: 'classification',  label: 'Customer Classification' },
  { id: 'expense_buckets', label: 'Expense Buckets' },
  { id: 'users',           label: 'Users' },
];

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('channels');

  return (
    <div>
      <div className="pt">Settings <span className="bg bg-l">CONTROL</span></div>

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

      {tab === 'item_sets'       && <ItemSetsEditor />}
      {tab === 'digest'          && <DigestEditor />}
      {tab === 'classification'  && <CustomerClassificationEditor />}
      {tab === 'expense_buckets' && <ExpenseBucketsEditor />}
      {tab === 'users'           && <UsersEditor />}
    </div>
  );
}
