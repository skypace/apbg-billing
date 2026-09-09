/**
 * The equipment asset line — make/model · serial · contract number.
 *
 * Ask (Sky, 2026-09-09): "anywhere outside of the order module, I would like to
 * have the equipment show up as The asset line, which is the model make and
 * serial and then the contract ID and when you click on them, they go into that
 * actual piece of equipment that should be mirrored and SD and in refractor
 * under the customer".
 *
 * ⚠ THE COMPOSITION OF RECORD IS SQL. `ops.v_equipment_line.asset_line` builds
 * this string and its parts together in the database, and this file rebuilds it
 * from the same parts ONLY so the pieces can be styled separately (the serial
 * tabular, the contract emphasised). Three surfaces show equipment across two
 * repos with no shared bundle — Refractor's customer page here, BrixSD's
 * customer page and its job record — so the string exists three times by
 * necessity and must never exist three ways.
 *
 * `tests/asset-line.test.mjs` asserts `assetLine(row) === row.asset_line`
 * character for character against real rows, so a change made to one and not
 * the others fails the build rather than showing a dispatcher one string and a
 * printed document another. The BrixSD copy is `app/assets/asset.js` in
 * `skypace/apbg-dispatch`, pinned by its own `asset.check.mjs` against the
 * SAME fixture.
 *
 * ⚠ NO IMPORTS IN THIS FILE, deliberately. The test bundles it with esbuild and
 * runs it in node (the `appMenus.ts` precedent); reaching for `./rpc` would
 * drag in `import.meta.env` and the pin would become untestable.
 */

/** Everything the line and the panel read. A superset of `ops.v_equipment_line`
 *  plus the two SNAPSHOT spellings a BrixSD job-equipment row uses (`serial`,
 *  `model`), because the same composer serves both shapes. */
export type EquipmentAsset = {
  id?: string;
  qbo_customer_id?: string | null;
  make_model?: string | null;
  make?: string | null;
  model_number?: string | null;
  model?: string | null;
  serial_number?: string | null;
  serial?: string | null;
  asset_tag?: string | null;
  contract_id?: string | null;
  contract_number?: string | null;
  contract_type?: string | null;
  contract_status?: string | null;
  contract_start?: string | null;
  contract_end?: string | null;
  contract_document_url?: string | null;
  asset_line?: string | null;
  category?: string | null;
  qbo_item_name?: string | null;
  catalog_name?: string | null;
  description?: string | null;
  name?: string | null;
  vendor?: string | null;
  qty?: number | null;
  monthly_rent?: number | string | null;
  ownership_type?: string | null;
  status?: string | null;
  is_loaner?: boolean | null;
  installed_at?: string | null;
  removed_at?: string | null;
  on_site?: boolean | null;
  useful_life_months?: number | null;
  image_url?: string | null;
  spec_sheet_url?: string | null;
  service_fusion_equipment_id?: string | null;
  synced_at?: string | null;
};

/** ⚠ `make_model` WINS WHEN IT IS THERE, and the order matters. It is the
 *  view's own composed identity, so preferring it means this file and the SQL
 *  cannot give different answers. Rebuilding from make + model first looks
 *  equivalent and is not: a job-record snapshot carries a description and a
 *  model number and no make, so make-first prints a bare model number where the
 *  recorded name belongs.
 *
 *  ⚠ And it does NOT lead with `asset_tag`, however natural that sounds —
 *  measured on the 154 live assets, the tag is set on TWO. */
export function assetIdentity(a: EquipmentAsset): string {
  const fromParts = [a.make, a.model_number || a.model].filter(Boolean).join(' ').trim();
  return (a.make_model || '').trim()
    || fromParts
    || a.name || a.catalog_name || a.qbo_item_name || a.description
    || (a.asset_tag ? `Equipment ${a.asset_tag}` : 'Equipment');
}

export const assetSerial = (a: EquipmentAsset): string | null => a.serial_number || a.serial || null;
export const assetContract = (a: EquipmentAsset): string | null => a.contract_number || null;

/**
 * ⚠ EVERY BLANK IS NAMED IN WORDS rather than left as a dash. "Manitowoc
 * IT1200C · — · —" tells nobody which of the three facts is missing, and the
 * answer differs: chase ERLS for a serial, whereas "not on a contract" is a
 * real and common state (17 of 154 assets — company-owned kit that is not
 * rented), not an omission.
 */
/**
 * ERLS's own note, with a leading repeat of the identity trimmed off.
 *
 * ⚠ THIS IS FOR A LIST ROW, NOT FOR THE RECORD. A panel shows what ERLS
 * actually said, verbatim; a row shows it to tell two otherwise identical rows
 * apart, and "OSION OCM-500 -- 3137 MISSION ST SF" buries the only
 * distinguishing words behind eighteen characters the line above already said.
 * The trim fires ONLY when the note literally begins with the identity, so a
 * note that merely mentions the model keeps every word.
 */
export function assetNote(a: EquipmentAsset): string | null {
  const raw = (a.description || '').trim();
  if (!raw) return null;
  const id = assetIdentity(a);
  if (id && raw.toLowerCase().startsWith(id.toLowerCase())) {
    const rest = raw.slice(id.length).replace(/^[\s\-–—:,.]+/, '').trim();
    return rest || null;
  }
  return raw;
}

export function assetLine(a: EquipmentAsset): string {
  return [
    assetIdentity(a),
    assetSerial(a) ? `#${assetSerial(a)}` : 'no serial on file',
    assetContract(a) || 'not on a contract',
  ].join(' · ');
}
