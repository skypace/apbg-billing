import { useEffect, useMemo, useState } from 'react';
import { SearchSelect } from '../../components/SearchSelect';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import { Plus } from 'lucide-react';
import {
  InventoryLocation,
  createLocation,
  fetchLocations,
} from '../../lib/inventoryControl';
import {
  NewSubDistributor,
  QboItemLite,
  SubDistributor,
  SubDistributorModel,
  SubDistributorStatus,
  createSubDistributor,
  fetchQboItems,
  fetchSubDistributors,
} from '../../lib/subDistributors';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { TABS_SX } from '../stock/stockStyles';
import { errMsg, LField, Modal, ModelChip, QboCustomerSearch, StatusChip } from './common';
import { DistributorOverviewTab } from './OverviewTab';
import { DistributorAgreementsTab } from './AgreementsTab';
import { DistributorUsersTab } from './UsersTab';
import { DistributorAccountsTab } from './AccountsTab';
import { DistributorOrdersTab } from './OrdersTab';
import { DistributorInventoryTab } from './InventoryTab';
import { DistributorDepletionsTab } from './DepletionsTab';

type TabId = 'overview' | 'agreements' | 'users' | 'accounts' | 'orders' | 'inventory' | 'depletions';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview',   label: 'Overview'   },
  { id: 'agreements', label: 'Agreements' },
  { id: 'users',      label: 'Users'      },
  { id: 'accounts',   label: 'Accounts'   },
  { id: 'orders',     label: 'Orders'     },
  { id: 'inventory',  label: 'Inventory'  },
  { id: 'depletions', label: 'Depletions' },
];

export function DistributorsPage() {
  const toast = useToast();
  const [dists, setDists] = useState<SubDistributor[] | null>(null);
  const [locations, setLocations] = useState<InventoryLocation[] | null>(null);
  const [items, setItems] = useState<QboItemLite[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<TabId>('overview');

  function reload() {
    fetchSubDistributors().then((rows) => {
      setDists(rows);
      setSelectedId((cur) => cur && rows.some((r) => r.id === cur) ? cur : (rows[0]?.id ?? null));
    }).catch((e) => { setDists([]); toast.error(errMsg(e)); });
    fetchLocations().then(setLocations).catch(() => setLocations([]));
  }

  useEffect(() => {
    reload();
    fetchQboItems().then(setItems).catch(() => setItems([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const itemNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items ?? []) m.set(it.qbo_item_id, it.name || it.fully_qualified_name || it.qbo_item_id);
    return m;
  }, [items]);

  const locationById = useMemo(() => {
    const m = new Map<string, InventoryLocation>();
    for (const l of locations ?? []) m.set(l.id, l);
    return m;
  }, [locations]);

  const selected = (dists ?? []).find((d) => d.id === selectedId) ?? null;

  return (
    <div>
      <div className="hero">
        <div>
          <div className="hero-eyebrow">Partners · Agreements · Orders · Consignment Inventory · Depletions</div>
          <h1 className="hero-title">Sub-Distributors</h1>
          <div className="hero-meta">
            {dists === null ? 'Loading…'
              : `${dists.length} partner${dists.length === 1 ? '' : 's'} · ${dists.filter((d) => d.status === 'active').length} active`}
          </div>
        </div>
        <div className="hero-stamp">
          <span className="status-dot" aria-hidden="true" />
          Distribution
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(230px, 270px) 1fr', gap: 16, alignItems: 'start' }}>
        {/* Roster */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.8, textTransform: 'uppercase' }}>Roster</span>
            <button onClick={() => setCreating(true)} style={btnPrimary()}>
              <Plus size={11} style={{ marginRight: 3, verticalAlign: -1 }} /> New
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {dists === null && <div style={{ color: 'var(--mt)', fontSize: 11, padding: 8 }}>Loading…</div>}
            {dists !== null && dists.length === 0 && (
              <div className="cd" style={{ padding: 12, fontSize: 11, color: 'var(--mt)' }}>
                No sub-distributors yet.
              </div>
            )}
            {(dists ?? []).map((d) => {
              const on = d.id === selectedId;
              return (
                <button
                  key={d.id}
                  onClick={() => setSelectedId(d.id)}
                  className="cd"
                  style={{
                    textAlign: 'left', cursor: 'pointer', padding: '10px 12px',
                    border: '1px solid ' + (on ? 'var(--ac)' : 'var(--bd)'),
                    background: on ? 'rgba(91,181,240,0.06)' : 'var(--sf)',
                    borderRadius: 6, color: 'var(--tx)', fontFamily: 'inherit',
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 3 }}>{d.name}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <code style={{ color: 'var(--ac)', fontFamily: 'var(--ff-mono)', fontSize: 10 }}>{d.code}</code>
                    <StatusChip status={d.status} />
                    <ModelChip model={d.model} />
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Detail */}
        <div style={{ minWidth: 0 }}>
          {!selected && dists !== null && (
            <div className="cd" style={{ padding: 24, color: 'var(--mt)', fontSize: 12 }}>
              Select a sub-distributor, or create one to get started.
            </div>
          )}
          {selected && (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: 19 }}>{selected.name}</h2>
                <code style={{ color: 'var(--ac)', fontFamily: 'var(--ff-mono)', fontSize: 11 }}>{selected.code}</code>
                <StatusChip status={selected.status} />
                <ModelChip model={selected.model} />
                {selected.territory && (
                  <span style={{ fontSize: 10.5, color: 'var(--mt)' }}>{selected.territory}</span>
                )}
              </div>
              <Tabs value={tab} onChange={(_, v) => setTab(v as TabId)} sx={TABS_SX}
                variant="scrollable" scrollButtons="auto">
                {TABS.map((t) => <Tab key={t.id} value={t.id} label={t.label} />)}
              </Tabs>

              {tab === 'overview' && (
                <DistributorOverviewTab
                  dist={selected}
                  location={selected.inventory_location_id ? locationById.get(selected.inventory_location_id) ?? null : null}
                  locations={locations ?? []}
                  onChanged={reload}
                />
              )}
              {tab === 'agreements' && <DistributorAgreementsTab dist={selected} />}
              {tab === 'users' && <DistributorUsersTab dist={selected} />}
              {tab === 'accounts' && <DistributorAccountsTab dist={selected} />}
              {tab === 'orders' && (
                <DistributorOrdersTab
                  dist={selected}
                  locations={locations ?? []}
                  itemNameById={itemNameById}
                />
              )}
              {tab === 'inventory' && (
                <DistributorInventoryTab
                  dist={selected}
                  locationById={locationById}
                  itemNameById={itemNameById}
                />
              )}
              {tab === 'depletions' && (
                <DistributorDepletionsTab dist={selected} itemNameById={itemNameById} />
              )}
            </>
          )}
        </div>
      </div>

      {creating && (
        <NewDistributorDialog
          locations={locations ?? []}
          existing={dists ?? []}
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); setSelectedId(id); reload(); }}
        />
      )}
    </div>
  );
}

// ── New Sub-Distributor dialog ────────────────────────────────────────────

function NewDistributorDialog({ locations, existing, onClose, onCreated }: {
  locations: InventoryLocation[];
  existing: SubDistributor[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [status, setStatus] = useState<SubDistributorStatus>('pending');
  const [model, setModel] = useState<SubDistributorModel>('consignment');
  const [fee, setFee] = useState('');
  const [territory, setTerritory] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [qboCustomerId, setQboCustomerId] = useState<string | null>(null);
  const [qboCustomerLabel, setQboCustomerLabel] = useState<string | null>(null);
  const [sfCustomerId, setSfCustomerId] = useState('');
  const [notes, setNotes] = useState('');

  // Inventory location: link an existing kind='distributor' location or create one.
  const usedLocationIds = useMemo(
    () => new Set(existing.map((d) => d.inventory_location_id).filter(Boolean) as string[]),
    [existing],
  );
  const distributorLocs = locations.filter((l) => l.kind === 'distributor');
  const [locMode, setLocMode] = useState<'existing' | 'create'>(
    distributorLocs.some((l) => !usedLocationIds.has(l.id)) ? 'existing' : 'create',
  );
  const [locId, setLocId] = useState('');
  const [locCode, setLocCode] = useState('');
  const [locName, setLocName] = useState('');
  const [locAddr, setLocAddr] = useState('');
  const [locCity, setLocCity] = useState('');
  const [locState, setLocState] = useState('');
  const [locZip, setLocZip] = useState('');

  const canSave =
    !!code.trim() && !!name.trim() &&
    (locMode === 'existing' ? !!locId : (!!locCode.trim() && !!locName.trim())) &&
    !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      let inventoryLocationId = locId;
      if (locMode === 'create') {
        const loc = await createLocation({
          code: locCode.trim().toUpperCase(),
          name: locName.trim(),
          kind: 'distributor',
          entity: 'shared',
          is_active: true,
          address_line1: locAddr.trim() || null,
          city: locCity.trim() || null,
          state: locState.trim() || null,
          postal_code: locZip.trim() || null,
        });
        inventoryLocationId = loc.id;
      }
      const row: NewSubDistributor = {
        code: code.trim().toUpperCase(),
        name: name.trim(),
        status,
        model,
        per_case_delivery_fee: fee === '' ? null : Number(fee),
        territory: territory.trim() || null,
        contact_name: contactName.trim() || null,
        contact_email: contactEmail.trim() || null,
        contact_phone: contactPhone.trim() || null,
        qbo_customer_id: qboCustomerId,
        sf_customer_id: sfCustomerId === '' ? null : Number(sfCustomerId),
        inventory_location_id: inventoryLocationId,
        notes: notes.trim() || null,
      };
      const created = await createSubDistributor(row);
      toast.success(`Created ${created.name}`);
      onCreated(created.id);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="New Sub-Distributor" onClose={onClose} maxWidth={720}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        <LField label="Code">
          <input style={{ ...inp(), width: '100%' }} value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ORIGINS" />
        </LField>
        <LField label="Name">
          <input style={{ ...inp(), width: '100%' }} value={name}
            onChange={(e) => setName(e.target.value)} placeholder="Origins Soda Co." />
        </LField>
        <LField label="Status">
          <select style={{ ...inp(), width: '100%' }} value={status}
            onChange={(e) => setStatus(e.target.value as SubDistributorStatus)}>
            <option value="pending">Pending</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </LField>
        <LField label="Model">
          <select style={{ ...inp(), width: '100%' }} value={model}
            onChange={(e) => setModel(e.target.value as SubDistributorModel)}>
            <option value="consignment">Consignment</option>
            <option value="sell_in">Sell-In</option>
          </select>
        </LField>
        <LField label="Per-case delivery fee ($)">
          <input type="number" min={0} step="any" style={{ ...inp(), width: '100%' }} value={fee}
            onChange={(e) => setFee(e.target.value)} placeholder="—" />
        </LField>
        <LField label="Territory">
          <input style={{ ...inp(), width: '100%' }} value={territory}
            onChange={(e) => setTerritory(e.target.value)} placeholder="SoCal / Arizona" />
        </LField>
        <LField label="Contact name">
          <input style={{ ...inp(), width: '100%' }} value={contactName}
            onChange={(e) => setContactName(e.target.value)} />
        </LField>
        <LField label="Contact email">
          <input style={{ ...inp(), width: '100%' }} value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)} />
        </LField>
        <LField label="Contact phone">
          <input style={{ ...inp(), width: '100%' }} value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)} />
        </LField>
        <LField label="SF customer id">
          <input type="number" style={{ ...inp(), width: '100%' }} value={sfCustomerId}
            onChange={(e) => setSfCustomerId(e.target.value)} placeholder="—" />
        </LField>
      </div>

      <div style={{ marginTop: 12 }}>
        <LField label="QBO customer (sell-in invoicing / billing view)">
          <QboCustomerSearch
            value={qboCustomerId}
            valueLabel={qboCustomerLabel}
            onPick={(c) => { setQboCustomerId(c?.qbo_customer_id ?? null); setQboCustomerLabel(c?.display_name ?? null); }}
          />
        </LField>
      </div>

      {/* Inventory location */}
      <div style={{
        marginTop: 14, padding: 10, border: '1px solid var(--bd)', borderRadius: 4,
        background: 'rgba(91,181,240,0.04)',
      }}>
        <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 }}>
          Inventory location (their warehouse)
        </div>
        <div style={{ display: 'flex', gap: 14, marginBottom: 10, fontSize: 11 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <input type="radio" checked={locMode === 'existing'} onChange={() => setLocMode('existing')}
              style={{ accentColor: 'var(--ac)' }} />
            Link an existing distributor location
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <input type="radio" checked={locMode === 'create'} onChange={() => setLocMode('create')}
              style={{ accentColor: 'var(--ac)' }} />
            Create a new one
          </label>
        </div>
        {locMode === 'existing' ? (
          <SearchSelect style={{ width: '100%' }} value={locId} onChange={setLocId} placeholder="Type a location…"
            options={distributorLocs.map((l) => ({
              id: l.id, label: `${l.code} — ${l.name}`, disabled: usedLocationIds.has(l.id),
              hint: usedLocationIds.has(l.id) ? 'already linked' : undefined,
            }))} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
            <LField label="Code">
              <input style={{ ...inp(), width: '100%' }} value={locCode}
                onChange={(e) => setLocCode(e.target.value.toUpperCase())} placeholder="ORIGINS" />
            </LField>
            <LField label="Name">
              <input style={{ ...inp(), width: '100%' }} value={locName}
                onChange={(e) => setLocName(e.target.value)} placeholder="Origins warehouse" />
            </LField>
            <LField label="Address">
              <input style={{ ...inp(), width: '100%' }} value={locAddr}
                onChange={(e) => setLocAddr(e.target.value)} />
            </LField>
            <LField label="City">
              <input style={{ ...inp(), width: '100%' }} value={locCity}
                onChange={(e) => setLocCity(e.target.value)} />
            </LField>
            <LField label="State">
              <input style={{ ...inp(), width: '100%' }} value={locState} maxLength={2}
                onChange={(e) => setLocState(e.target.value.toUpperCase())} />
            </LField>
            <LField label="ZIP">
              <input style={{ ...inp(), width: '100%' }} value={locZip}
                onChange={(e) => setLocZip(e.target.value)} />
            </LField>
          </div>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <LField label="Notes">
          <textarea rows={2} style={{ ...inp(), width: '100%', resize: 'vertical', minHeight: 40 }}
            value={notes} onChange={(e) => setNotes(e.target.value)} />
        </LField>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button onClick={onClose} style={btnSecondary()}>Cancel</button>
        <button onClick={save} disabled={!canSave} style={btnPrimary()}>
          {saving ? 'Creating…' : 'Create'}
        </button>
      </div>
    </Modal>
  );
}
