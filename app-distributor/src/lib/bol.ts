import { escapeHtml, fmtDate, fmtQty } from './format';
import type { InventoryLocation, InventoryTransfer, InventoryTransferLine } from './types';

// ⚠ GUARDRAIL: the printed BOL carries NO cost / price data of any kind.

function locBlock(title: string, loc: InventoryLocation | null): string {
  if (!loc) {
    return `<div class="loc"><div class="loc-title">${escapeHtml(title)}</div><div class="muted">—</div></div>`;
  }
  const lines = [
    loc.name,
    loc.address_line1,
    loc.address_line2,
    [loc.city, loc.state, loc.postal_code].filter(Boolean).join(', '),
    loc.contact_name ? `Attn: ${loc.contact_name}` : null,
    loc.contact_phone,
  ].filter((l): l is string => Boolean(l && String(l).trim()));
  return `<div class="loc">
    <div class="loc-title">${escapeHtml(title)}</div>
    ${lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}
  </div>`;
}

function meta(label: string, value: string | number | null | undefined): string {
  const v = value === null || value === undefined || value === '' ? '—' : String(value);
  return `<div class="meta"><div class="meta-l">${escapeHtml(label)}</div><div class="meta-v">${escapeHtml(v)}</div></div>`;
}

function statusLabel(s: string): string {
  switch (s) {
    case 'in_transit': return 'IN TRANSIT';
    case 'received': return 'RECEIVED';
    case 'draft': return 'DRAFT';
    case 'void': return 'VOID';
    default: return s.toUpperCase();
  }
}

/**
 * Open a clean Letter-size Bill of Lading in a new window and print it.
 * Ship-from / ship-to blocks come from ops.inventory_locations.
 */
export function printBol(opts: {
  transfer: InventoryTransfer;
  lines: InventoryTransferLine[];
  fromLoc: InventoryLocation | null;
  toLoc: InventoryLocation | null;
  itemName: (id: string) => string;
}): void {
  const { transfer: t, lines, fromLoc, toLoc, itemName } = opts;
  const totalQty = lines.reduce((s, l) => s + Number(l.qty || 0), 0);
  const anyReceived = lines.some((l) => l.qty_received !== null && l.qty_received !== undefined);

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>BOL ${escapeHtml(t.bol_number ?? t.id.slice(0, 8))}</title>
<style>
  @page { size: letter; margin: 0.6in; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #111; margin: 0; font-size: 12px; line-height: 1.45; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #1F4E79; padding-bottom: 10px; margin-bottom: 14px; }
  .head h1 { margin: 0; font-size: 22px; letter-spacing: 0.04em; color: #1F4E79; }
  .head .co { font-size: 12px; font-weight: 700; }
  .head .bol-no { text-align: right; }
  .head .bol-no .n { font-size: 18px; font-weight: 800; }
  .head .bol-no .s { font-size: 11px; font-weight: 700; color: #555; letter-spacing: 0.08em; }
  .locs { display: flex; gap: 16px; margin-bottom: 14px; }
  .loc { flex: 1; border: 1px solid #bbb; border-radius: 6px; padding: 10px 12px; }
  .loc-title { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #1F4E79; margin-bottom: 5px; }
  .metas { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 14px; border: 1px solid #bbb; border-radius: 6px; padding: 10px 12px; margin-bottom: 14px; }
  .meta-l { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.07em; color: #666; }
  .meta-v { font-size: 12px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
  th { text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; background: #eef2f7; color: #1F4E79; padding: 6px 8px; border: 1px solid #bbb; }
  td { padding: 6px 8px; border: 1px solid #ccc; }
  th.r, td.r { text-align: right; }
  tfoot td { font-weight: 800; background: #f6f7f9; }
  .muted { color: #777; }
  .notes { border: 1px solid #bbb; border-radius: 6px; padding: 8px 12px; margin-bottom: 14px; }
  .notes .t { font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.07em; color: #666; margin-bottom: 3px; }
  .sigs { display: flex; gap: 20px; margin-top: 22px; }
  .sig { flex: 1; }
  .sig .line { border-bottom: 1px solid #333; height: 34px; display: flex; align-items: flex-end; font-size: 13px; font-weight: 700; padding-bottom: 2px; }
  .sig .cap { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.07em; color: #666; margin-top: 3px; }
  .foot { margin-top: 18px; font-size: 9.5px; color: #888; text-align: center; }
</style>
</head>
<body>
  <div class="head">
    <div>
      <h1>BILL OF LADING</h1>
      <div class="co">Brix Beverage &middot; Alameda Point Beverage Group</div>
    </div>
    <div class="bol-no">
      <div class="s">BOL NUMBER</div>
      <div class="n">${escapeHtml(t.bol_number ?? '—')}</div>
      <div class="s" style="margin-top:4px;">${escapeHtml(statusLabel(t.status))}</div>
    </div>
  </div>

  <div class="locs">
    ${locBlock('Ship From', fromLoc)}
    ${locBlock('Ship To', toLoc)}
  </div>

  <div class="metas">
    ${meta('Ship date', t.ship_date ? fmtDate(t.ship_date) : null)}
    ${meta('Received date', t.received_date ? fmtDate(t.received_date) : null)}
    ${meta('Carrier', t.carrier)}
    ${meta('Freight terms', t.freight_terms)}
    ${meta('Tracking #', t.tracking_number)}
    ${meta('PRO #', t.pro_number)}
    ${meta('Total weight (lbs)', t.total_weight_lbs)}
    ${meta('Pallets', t.total_pallets)}
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:46%">Item</th>
        <th class="r">Qty shipped</th>
        <th class="r">Qty received</th>
        <th>Line notes</th>
      </tr>
    </thead>
    <tbody>
      ${lines.map((l) => `<tr>
        <td>${escapeHtml(itemName(l.qbo_item_id))}</td>
        <td class="r">${escapeHtml(fmtQty(l.qty))}</td>
        <td class="r">${l.qty_received === null || l.qty_received === undefined ? '<span class="muted">—</span>' : escapeHtml(fmtQty(l.qty_received))}</td>
        <td>${escapeHtml(l.notes ?? '')}</td>
      </tr>`).join('')}
    </tbody>
    <tfoot>
      <tr>
        <td>Total</td>
        <td class="r">${escapeHtml(fmtQty(totalQty))}</td>
        <td class="r">${anyReceived ? escapeHtml(fmtQty(lines.reduce((s, l) => s + Number(l.qty_received ?? 0), 0))) : '—'}</td>
        <td></td>
      </tr>
    </tfoot>
  </table>

  ${t.special_instructions ? `<div class="notes"><div class="t">Special instructions</div>${escapeHtml(t.special_instructions)}</div>` : ''}
  ${t.receiver_notes ? `<div class="notes"><div class="t">Receiver notes</div>${escapeHtml(t.receiver_notes)}</div>` : ''}

  <div class="sigs">
    <div class="sig">
      <div class="line">${escapeHtml(t.shipper_signature_name ?? '')}</div>
      <div class="cap">Shipper signature ${t.shipper_signature_name ? '(recorded)' : ''}</div>
    </div>
    <div class="sig">
      <div class="line">${escapeHtml(t.receiver_signature_name ?? '')}</div>
      <div class="cap">Receiver signature ${t.receiver_signature_name ? '(recorded)' : ''}</div>
    </div>
  </div>

  <div class="foot">Generated by the Brix Distributor Portal &middot; ${escapeHtml(new Date().toLocaleString())}</div>
  <script>window.addEventListener('load', function () { window.print(); });</script>
</body>
</html>`;

  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(html);
  w.document.close();
}
