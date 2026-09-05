// The transfer document payload, in ONE place.
//
// A transfer produces three pieces of paper that must agree with each other —
// the pull ticket the warehouse works from, the bill of lading that travels
// with the load, and the emails that announce both. They are built from this
// one function so they cannot drift: a pull ticket that disagrees with its own
// BOL is worse than not having one.
//
// production-doc.mjs renders and emails them; transfer-workflow.mjs drives the
// process and needs the same lines to write the Service Fusion ticket and the
// notification emails. Both read this.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gfsdpwiqzshhexkofiif.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

const svc = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` });

export async function sbGet(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: { ...svc(), 'Accept-Profile': 'ops' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`read ${pathAndQuery.split('?')[0]} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}

export async function sbPatch(table, filter, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { ...svc(), 'Content-Type': 'application/json', 'Content-Profile': 'ops', 'Accept-Profile': 'ops', Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`update ${table} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}

export async function sbInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...svc(), 'Content-Type': 'application/json', 'Content-Profile': 'ops', 'Accept-Profile': 'ops', Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`insert ${table} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text)[0] : null;
}

/**
 * @param jwt  The CALLER's token, when the RPC stamps a person. fn_ship_transfer
 *   and fn_receive_transfer read auth.uid() for shipped_by / received_by, so
 *   running them on the service key would record the movement as nobody. Pass
 *   the staff member's own token and the ledger names them, exactly as it does
 *   when they press the button on the Transfers screen.
 */
export async function sbRpc(name, args, jwt) {
  const authHeaders = jwt
    ? { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` }
    : svc();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json', 'Content-Profile': 'ops', 'Accept-Profile': 'ops' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`rpc ${name} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

export const inList = (ids) => `in.(${[...new Set(ids.filter(Boolean))].map((s) => `"${String(s).replace(/"/g, '')}"`).join(',')})`;
export const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

export async function company() {
  const rows = await sbGet('production_settings?select=*&id=eq.true&limit=1');
  const s = rows[0] || {};
  return {
    accent: s.doc_accent || '#dc2626',
    from: s.doc_from || 'Brix Beverage Purchasing <alerts@alamedapointbg.com>',
    company: {
      name: s.company_name || 'Brix Beverage Dba Alameda Point Beverage Group',
      addr1: s.company_addr1 || '1951 Monarch St',
      addr2: s.company_addr2 ?? 'Suite 200',
      city_state_zip: s.company_city_state_zip || 'Alameda, CA 94501',
      phone: s.company_phone || null,
      email: s.company_email || 'service@brixbev.com',
      web: s.company_web || 'alamedapointbg.com',
    },
  };
}

export async function itemsById(ids) {
  if (!ids.length) return new Map();
  const rows = await sbGet(`qbo_items?select=qbo_item_id,name,sku&qbo_item_id=${inList(ids)}`);
  return new Map(rows.map((r) => [String(r.qbo_item_id), r]));
}

export function itemNo(item, id) {
  if (item?.sku) return item.sku;
  const first = String(item?.name || '').split(/\s+/)[0] || '';
  return /^[A-Z0-9][A-Z0-9-]{3,}$/.test(first) ? first : (id || '');
}

export function locationBlock(l) {
  if (!l) return null;
  return {
    name: l.name, addr1: l.address_line1, addr2: l.address_line2,
    city_state_zip: [l.city, l.state].filter(Boolean).join(', ') + (l.postal_code ? ' ' + l.postal_code : ''),
    contact: l.contact_name, phone: l.contact_phone,
  };
}

/**
 * Everything the three documents and the workflow need about one transfer.
 * Returns the render payload plus the raw rows, so a caller that wants the
 * lines for an email or a Service Fusion description does not fetch twice.
 */
export async function buildTransferDoc(id) {
  const [t] = await sbGet(`inventory_transfers?select=*&id=eq.${id}&limit=1`);
  if (!t) throw Object.assign(new Error('transfer not found'), { status: 404 });
  const lines = await sbGet(`inventory_transfer_lines?select=*&transfer_id=eq.${id}&order=created_at`);
  const locs = await sbGet(`inventory_locations?select=*&id=${inList([t.from_location_id, t.to_location_id])}`);
  const from = locs.find((l) => l.id === t.from_location_id), to = locs.find((l) => l.id === t.to_location_id);
  const items = await itemsById(lines.map((l) => l.qbo_item_id));
  const [wo] = await sbGet(`work_orders?select=batch_code&transfer_id=eq.${id}&limit=1`);
  const meta = await company();

  const docLines = lines.map((l) => {
    const it = items.get(String(l.qbo_item_id));
    return {
      itemNo: itemNo(it, l.qbo_item_id), description: it?.name || l.qbo_item_id,
      qty: Number(l.qty), uom: '', weight: l.line_weight_lbs, pallets: l.line_pallets,
      lot: l.lot_code, bornOn: l.born_on_date, bestBy: l.best_by_date,
    };
  });

  return {
    transfer: t, rows: lines, fromLoc: from, toLoc: to,
    payload: {
      ...meta, bolNumber: t.bol_number, status: t.status,
      issued: t.transfer_date || t.created_at, shipDate: t.ship_date,
      sfJobNumber: t.sf_job_number,
      shipper: locationBlock(from), consignee: locationBlock(to),
      carrier: t.carrier, pro: t.pro_number, tracking: t.tracking_number, freightTerms: t.freight_terms,
      weight: t.total_weight_lbs, pallets: t.total_pallets, declaredValue: t.declared_value_usd,
      specialInstructions: t.special_instructions, notes: t.notes,
      workOrder: wo ? { batch: wo.batch_code } : null,
      signatures: { shipperName: t.shipper_signature_name, shipperAt: t.shipper_signature_at,
                    receiverName: t.receiver_signature_name, receiverAt: t.receiver_signature_at },
      lines: docLines,
    },
    label: t.bol_number, filename: `${t.bol_number}.pdf`,
    recipientHint: [],
    summary: { from: from?.name || '', to: to?.name || '', lineCount: lines.length },
  };
}

/**
 * The line list a human reads — "20 cases of OAKTOWN ROOT BEER".
 * This is what goes in the Service Fusion ticket's description so the tech
 * knows what to build, and in every notification email.
 */
export function whatToBuild(docLines, unit = 'cases') {
  return docLines.map((l) => `${Math.round(l.qty)} ${unit} of ${l.description}`);
}
