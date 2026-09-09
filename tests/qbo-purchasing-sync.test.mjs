// The pure rules behind the QuickBooks ⇄ Refractor purchasing sync
// (netlify/functions/lib/qbo-purchasing-sync.mjs). Each of these can be wrong
// silently: a bill line keyed differently from sync-qbo-expenses splits one
// line into two rows; a PO update that drops QuickBooks' memo reads as "we
// blanked the memo"; a bill line without its LinkedTxn leaves the PO open in
// QuickBooks forever.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cdcWindow, billLineRows, itemRow, vendorRow, itemIdsOnPo, buildPoPayload, buildBillFromReceipt, poWindowStart,
} from '../netlify/functions/lib/qbo-purchasing-sync.mjs';

const NOW = new Date('2026-09-04T18:00:00Z');

test('cdcWindow: first run is a full pull; a recent success becomes a CDC window with overlap', () => {
  assert.deepEqual(cdcWindow(null, NOW), { mode: 'full' });
  assert.deepEqual(cdcWindow('not a date', NOW), { mode: 'full' });
  const w = cdcWindow('2026-09-04T17:45:00Z', NOW);
  assert.equal(w.mode, 'cdc');
  // five minutes before the last success, so a write that landed while the
  // last run was in flight is not missed
  assert.equal(w.since, '2026-09-04T17:40:00.000Z');
});

test('cdcWindow: a success older than QuickBooks CDC can reach falls back to a full pull', () => {
  assert.deepEqual(cdcWindow('2026-08-01T00:00:00Z', NOW), { mode: 'full' });
  assert.equal(cdcWindow('2026-08-10T00:00:00Z', NOW).mode, 'cdc');
});

const BILL = {
  Id: '173600', TxnDate: '2026-09-04', DocNumber: 'INV-88',
  VendorRef: { value: '1744', name: 'Quantum Canning' },
  Line: [
    { Id: '1', LineNum: 1, DetailType: 'ItemBasedExpenseLineDetail', Amount: 3936, Description: 'cans',
      ItemBasedExpenseLineDetail: { ItemRef: { value: '687', name: 'CAN OLD FOUNTAIN 12OZ SLEEK EMPTY' }, Qty: 12000, UnitPrice: 0.328 },
      LinkedTxn: [{ TxnId: '9001', TxnType: 'PurchaseOrder', TxnLineId: '2' }] },
    { Id: '2', LineNum: 2, DetailType: 'AccountBasedExpenseLineDetail', Amount: 50,
      AccountBasedExpenseLineDetail: { AccountRef: { value: '294', name: 'Can Raw Materials' } } },
    { DetailType: 'ItemBasedExpenseLineDetail', Amount: 10,
      ItemBasedExpenseLineDetail: { ItemRef: { value: '565', name: 'DUNNAGE' }, Qty: 1, UnitPrice: 10 } },
  ],
};

test('billLineRows: same row shape and line_key rule as sync-qbo-expenses, plus the PO link', () => {
  const rows = billLineRows(BILL, 'Bill', '2026-09-04T18:00:00.000Z');
  assert.equal(rows.length, 3);
  const [item, acct, noId] = rows;
  assert.equal(item.qbo_txn_id, '173600');
  assert.equal(item.qbo_txn_type, 'Bill');
  assert.equal(item.line_key, '1');                       // Id wins
  assert.equal(item.item_ref_id, '687');
  assert.equal(item.quantity, 12000);
  assert.equal(item.unit_cost, 0.328);
  assert.equal(item.vendor_name, 'Quantum Canning');
  assert.equal(item.linked_po_qbo_id, '9001');
  assert.equal(item.linked_po_line_id, '2');
  assert.equal(acct.account_ref_id, '294');
  assert.equal(acct.item_ref_id, null);
  assert.equal(acct.linked_po_qbo_id, null);
  // no Id and no LineNum → the content key sync-qbo-expenses v10 uses, so a
  // re-sync from either writer updates the same row
  assert.match(noId.line_key, /^k2:ItemBasedExpenseLineDetail\|565\|DUNNAGE\|\|\|\|10\|1\|10$/);
  // the same bill re-read produces the same keys
  assert.deepEqual(rows.map((r) => r.line_key), billLineRows(BILL, 'Bill').map((r) => r.line_key));
});

test('billLineRows: a VendorCredit keeps its type so the feed can turn it into stock leaving', () => {
  const rows = billLineRows({ ...BILL, Id: '5' }, 'VendorCredit');
  assert.ok(rows.every((r) => r.qbo_txn_type === 'VendorCredit' && r.qbo_txn_id === '5'));
});

test('itemRow / vendorRow: the mirror columns the nightly syncs write', () => {
  const r = itemRow({ Id: '572', Name: '24P6121 HANGAR 25 COLA CASE', FullyQualifiedName: 'Cans:24P6121 HANGAR 25 COLA CASE',
    Type: 'Inventory', Active: true, QtyOnHand: 249, PurchaseCost: 21.36, UnitPrice: 32,
    IncomeAccountRef: { value: '1', name: 'Sales' }, AssetAccountRef: { value: '2', name: 'Inventory Asset' },
    MetaData: { LastUpdatedTime: '2026-09-04T10:00:00-07:00' } }, '2026-09-04T18:00:00.000Z');
  assert.equal(r.qbo_item_id, '572');
  assert.equal(r.qty_on_hand, 249);
  assert.equal(r.category_path, 'Cans');
  assert.equal(r.asset_account_ref_id, '2');
  assert.equal(r.qbo_updated_at, '2026-09-04T17:00:00.000Z');
  assert.equal(r.synced_at, '2026-09-04T18:00:00.000Z');
  const v = vendorRow({ Id: '1099', DisplayName: 'AC CALDERONI', Active: true, BillAddr: { City: 'Oakland', CountrySubDivisionCode: 'CA' }, TermRef: { name: 'Net 30' } });
  assert.equal(v.qbo_vendor_id, '1099');
  assert.equal(v.state, 'CA');
  assert.equal(v.default_terms, 'Net 30');
});

const PO = {
  id: 'po-uuid', po_number: 'PO-2026-00021', qbo_vendor_id: '1744', expected_date: '2026-09-20', notes: 'ship to dock 2',
};
const LINES = [
  { id: 'l1', qbo_item_id: '687', description: null, qty_ordered: 12000, unit_cost: 0.328, qbo_line_id: null },
  { id: 'l2', qbo_item_id: '565', description: 'pallets', qty_ordered: 6, unit_cost: 50, qbo_line_id: '4' },
];
const NAMES = { 687: 'CAN OLD FOUNTAIN 12OZ SLEEK EMPTY', 565: 'DUNNAGE FEE PER PALLET' };

test('buildPoPayload (create): DocNumber = our PO number, ItemBased lines, Open, no Id/SyncToken', () => {
  const p = buildPoPayload({ po: PO, lines: LINES, vendorName: 'Quantum Canning', itemNames: NAMES });
  assert.equal(p.DocNumber, 'PO-2026-00021');
  assert.equal(p.POStatus, 'Open');
  assert.equal(p.VendorRef.value, '1744');
  assert.equal(p.DueDate, '2026-09-20');
  assert.equal(p.PrivateNote, 'ship to dock 2');
  assert.equal(p.Id, undefined);
  assert.equal(p.SyncToken, undefined);
  assert.equal(p.Line.length, 2);
  assert.equal(p.Line[0].Id, undefined);                  // never pushed before
  assert.equal(p.Line[1].Id, '4');                        // keeps its QuickBooks line id
  assert.equal(p.Line[0].Amount, 3936);
  assert.equal(p.Line[0].ItemBasedExpenseLineDetail.ItemRef.name, NAMES[687]);
  assert.equal(p.Line[1].Description, 'pallets');
});

test('buildPoPayload (update): carries Id + SyncToken and keeps what QuickBooks holds that we do not manage', () => {
  const remote = {
    Id: '9001', SyncToken: '3', DocNumber: 'QB-771', POStatus: 'Open', TxnDate: '2026-09-01',
    ShipAddr: { Line1: '1951 Monarch St' }, Memo: 'vendor memo', TotalAmt: 999, domain: 'QBO', sparse: false,
    MetaData: { LastUpdatedTime: 'x' }, LinkedTxn: [{ TxnId: '1', TxnType: 'Bill' }],
    Line: [
      { Id: '4', DetailType: 'ItemBasedExpenseLineDetail', Amount: 1, ItemBasedExpenseLineDetail: { ItemRef: { value: '565' }, Qty: 1, UnitPrice: 1 } },
      { Id: '7', DetailType: 'AccountBasedExpenseLineDetail', Amount: 25, AccountBasedExpenseLineDetail: { AccountRef: { value: '294' } } },
    ],
  };
  const p = buildPoPayload({ po: PO, lines: LINES, vendorName: 'Quantum Canning', itemNames: NAMES, remote });
  assert.equal(p.Id, '9001');
  assert.equal(p.SyncToken, '3');
  assert.equal(p.DocNumber, 'QB-771');                    // QuickBooks' number stays theirs
  assert.equal(p.TxnDate, '2026-09-01');
  assert.deepEqual(p.ShipAddr, { Line1: '1951 Monarch St' });
  assert.equal(p.Memo, 'vendor memo');
  assert.equal(p.TotalAmt, undefined);                    // computed, never sent back
  assert.equal(p.MetaData, undefined);
  assert.equal(p.LinkedTxn, undefined);
  // our two item lines, then the account line QuickBooks had, untouched
  assert.equal(p.Line.length, 3);
  assert.equal(p.Line[2].Id, '7');
  assert.equal(p.Line[2].DetailType, 'AccountBasedExpenseLineDetail');
  // our notes win over the remote memo when set; the remote memo is kept when ours is blank
  const p2 = buildPoPayload({ po: { ...PO, notes: null }, lines: LINES, vendorName: null, itemNames: NAMES, remote: { ...remote, PrivateNote: 'theirs' } });
  assert.equal(p2.PrivateNote, 'theirs');
});

test('buildBillFromReceipt: every line linked to the PO (and its line when known); DocNumber falls back to PO + receipt', () => {
  const receipt = {
    id: 'a1b2c3d4-0000-0000-0000-000000000000', received_at: '2026-09-04T17:00:00Z', invoice_date: null, vendor_invoice_number: null,
    lines: [
      { po_line_id: 'l1', qbo_line_id: '1', qbo_item_id: '687', item_name: NAMES[687], qty: 6000, unit_cost: 0.328, amount: 1968 },
      { po_line_id: 'l2', qbo_line_id: null, qbo_item_id: '565', item_name: NAMES[565], qty: 6, unit_cost: 50, amount: 300 },
    ],
  };
  const po = { ...PO, qbo_purchase_order_id: '9001' };
  const b = buildBillFromReceipt({ receipt, po, vendorName: 'Quantum Canning', itemNames: NAMES });
  assert.equal(b.VendorRef.value, '1744');
  assert.equal(b.TxnDate, '2026-09-04');
  assert.equal(b.DocNumber, 'PO-2026-00021-RA1B2C3');
  assert.ok(b.DocNumber.length <= 21);
  assert.deepEqual(b.Line[0].LinkedTxn, [{ TxnId: '9001', TxnType: 'PurchaseOrder', TxnLineId: '1' }]);
  assert.deepEqual(b.Line[1].LinkedTxn, [{ TxnId: '9001', TxnType: 'PurchaseOrder' }]);
  assert.equal(b.Line[0].Amount, 1968);
  assert.match(b.PrivateNote, /vendor invoice not yet in hand/);
  // with the vendor's invoice number in hand, that is the DocNumber
  const b2 = buildBillFromReceipt({ receipt: { ...receipt, vendor_invoice_number: '  INV-4471 ', invoice_date: '2026-09-02' }, po, vendorName: null, itemNames: NAMES });
  assert.equal(b2.DocNumber, 'INV-4471');
  assert.equal(b2.TxnDate, '2026-09-02');
  assert.doesNotMatch(b2.PrivateNote, /not yet in hand/);
});

test('itemIdsOnPo: only ItemBased lines, de-duplicated', () => {
  const ids = itemIdsOnPo({ Line: [
    { DetailType: 'ItemBasedExpenseLineDetail', ItemBasedExpenseLineDetail: { ItemRef: { value: '687' } } },
    { DetailType: 'ItemBasedExpenseLineDetail', ItemBasedExpenseLineDetail: { ItemRef: { value: '687' } } },
    { DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '294' } } },
  ] });
  assert.deepEqual(ids, ['687']);
  assert.deepEqual(itemIdsOnPo({}), []);
});

test('poWindowStart: the full PO pull reaches a year behind apply_from, and never filters on POStatus', async () => {
  // POStatus is not queryable on PurchaseOrder (QBO 400 QueryValidationError) —
  // the first full pull failed on it every 15 minutes for a day.
  assert.equal(poWindowStart('2026-09-03'), '2025-09-03');
  assert.equal(poWindowStart('garbage'), '2025-09-01');
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../netlify/functions/lib/qbo-purchasing-sync.mjs', import.meta.url), 'utf8'));
  assert.ok(!/from PurchaseOrder where POStatus/.test(src), 'the PO query must not filter on POStatus');
});
