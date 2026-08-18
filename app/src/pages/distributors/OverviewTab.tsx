import { useEffect, useState } from 'react';
import {
  InventoryLocation,
  updateLocation,
} from '../../lib/inventoryControl';
import {
  SubDistributor,
  SubDistributorModel,
  SubDistributorStatus,
  updateSubDistributor,
} from '../../lib/subDistributors';
import { useToast } from '../../lib/toast';
import { btnPrimary, inp } from '../../lib/styles';
import { errMsg, LField, QboCustomerSearch } from './common';

interface Props {
  dist: SubDistributor;
  location: InventoryLocation | null;
  locations: InventoryLocation[];
  onChanged: () => void;
}

export function DistributorOverviewTab({ dist, location, locations, onChanged }: Props) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  // Registry draft
  const [name, setName] = useState(dist.name);
  const [status, setStatus] = useState<SubDistributorStatus>(dist.status);
  const [model, setModel] = useState<SubDistributorModel>(dist.model);
  const [fee, setFee] = useState(dist.per_case_delivery_fee == null ? '' : String(dist.per_case_delivery_fee));
  const [territory, setTerritory] = useState(dist.territory ?? '');
  const [contactName, setContactName] = useState(dist.contact_name ?? '');
  const [contactEmail, setContactEmail] = useState(dist.contact_email ?? '');
  const [contactPhone, setContactPhone] = useState(dist.contact_phone ?? '');
  const [qboCustomerId, setQboCustomerId] = useState<string | null>(dist.qbo_customer_id);
  const [sfCustomerId, setSfCustomerId] = useState(dist.sf_customer_id == null ? '' : String(dist.sf_customer_id));
  const [inventoryLocationId, setInventoryLocationId] = useState(dist.inventory_location_id ?? '');
  const [notes, setNotes] = useState(dist.notes ?? '');

  // Location address draft
  const [locAddr, setLocAddr] = useState(location?.address_line1 ?? '');
  const [locAddr2, setLocAddr2] = useState(location?.address_line2 ?? '');
  const [locCity, setLocCity] = useState(location?.city ?? '');
  const [locState, setLocState] = useState(location?.state ?? '');
  const [locZip, setLocZip] = useState(location?.postal_code ?? '');

  // Re-seed drafts when the selected distributor changes.
  useEffect(() => {
    setName(dist.name);
    setStatus(dist.status);
    setModel(dist.model);
    setFee(dist.per_case_delivery_fee == null ? '' : String(dist.per_case_delivery_fee));
    setTerritory(dist.territory ?? '');
    setContactName(dist.contact_name ?? '');
    setContactEmail(dist.contact_email ?? '');
    setContactPhone(dist.contact_phone ?? '');
    setQboCustomerId(dist.qbo_customer_id);
    setSfCustomerId(dist.sf_customer_id == null ? '' : String(dist.sf_customer_id));
    setInventoryLocationId(dist.inventory_location_id ?? '');
    setNotes(dist.notes ?? '');
  }, [dist]);

  useEffect(() => {
    setLocAddr(location?.address_line1 ?? '');
    setLocAddr2(location?.address_line2 ?? '');
    setLocCity(location?.city ?? '');
    setLocState(location?.state ?? '');
    setLocZip(location?.postal_code ?? '');
  }, [location]);

  const distributorLocs = locations.filter((l) => l.kind === 'distributor');

  async function save() {
    setSaving(true);
    try {
      await updateSubDistributor(dist.id, {
        name: name.trim() || dist.name,
        status,
        model,
        per_case_delivery_fee: fee === '' ? null : Number(fee),
        territory: territory.trim() || null,
        contact_name: contactName.trim() || null,
        contact_email: contactEmail.trim() || null,
        contact_phone: contactPhone.trim() || null,
        qbo_customer_id: qboCustomerId,
        sf_customer_id: sfCustomerId === '' ? null : Number(sfCustomerId),
        inventory_location_id: inventoryLocationId || null,
        notes: notes.trim() || null,
      });
      if (location) {
        await updateLocation(location.id, {
          address_line1: locAddr.trim() || null,
          address_line2: locAddr2.trim() || null,
          city: locCity.trim() || null,
          state: locState.trim() || null,
          postal_code: locZip.trim() || null,
        });
      }
      toast.success('Saved');
      onChanged();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cd" style={{ padding: 16 }}>
      <div style={{ fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 10 }}>
        Registry
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        <LField label="Name">
          <input style={{ ...inp(), width: '100%' }} value={name} onChange={(e) => setName(e.target.value)} />
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
            onChange={(e) => setFee(e.target.value)} />
        </LField>
        <LField label="Territory">
          <input style={{ ...inp(), width: '100%' }} value={territory} onChange={(e) => setTerritory(e.target.value)} />
        </LField>
        <LField label="SF customer id">
          <input type="number" style={{ ...inp(), width: '100%' }} value={sfCustomerId}
            onChange={(e) => setSfCustomerId(e.target.value)} />
        </LField>
        <LField label="Contact name">
          <input style={{ ...inp(), width: '100%' }} value={contactName} onChange={(e) => setContactName(e.target.value)} />
        </LField>
        <LField label="Contact email">
          <input style={{ ...inp(), width: '100%' }} value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
        </LField>
        <LField label="Contact phone">
          <input style={{ ...inp(), width: '100%' }} value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
        </LField>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10, marginTop: 12 }}>
        <LField label="QBO customer">
          <QboCustomerSearch
            value={qboCustomerId}
            onPick={(c) => setQboCustomerId(c?.qbo_customer_id ?? null)}
          />
        </LField>
        <LField label="Inventory location">
          <select style={{ ...inp(), width: '100%' }} value={inventoryLocationId}
            onChange={(e) => setInventoryLocationId(e.target.value)}>
            <option value="">— None —</option>
            {distributorLocs.map((l) => (
              <option key={l.id} value={l.id}>{l.code} — {l.name}</option>
            ))}
          </select>
        </LField>
      </div>

      <div style={{ marginTop: 12 }}>
        <LField label="Notes">
          <textarea rows={2} style={{ ...inp(), width: '100%', resize: 'vertical', minHeight: 40 }}
            value={notes} onChange={(e) => setNotes(e.target.value)} />
        </LField>
      </div>

      {/* Location address */}
      <div style={{ marginTop: 16, fontSize: 10, color: 'var(--mt)', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 10 }}>
        Warehouse address {location ? `· ${location.code}` : ''}
      </div>
      {location ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <LField label="Address line 1">
            <input style={{ ...inp(), width: '100%' }} value={locAddr} onChange={(e) => setLocAddr(e.target.value)} />
          </LField>
          <LField label="Address line 2">
            <input style={{ ...inp(), width: '100%' }} value={locAddr2} onChange={(e) => setLocAddr2(e.target.value)} />
          </LField>
          <LField label="City">
            <input style={{ ...inp(), width: '100%' }} value={locCity} onChange={(e) => setLocCity(e.target.value)} />
          </LField>
          <LField label="State">
            <input style={{ ...inp(), width: '100%' }} value={locState} maxLength={2}
              onChange={(e) => setLocState(e.target.value.toUpperCase())} />
          </LField>
          <LField label="ZIP">
            <input style={{ ...inp(), width: '100%' }} value={locZip} onChange={(e) => setLocZip(e.target.value)} />
          </LField>
        </div>
      ) : (
        <div style={{ fontSize: 11, color: 'var(--mt)' }}>
          No inventory location linked yet — link one above so orders can be fulfilled with a BOL.
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={save} disabled={saving} style={btnPrimary()}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
