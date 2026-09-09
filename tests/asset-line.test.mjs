/**
 * The asset line exists three times and must never exist three ways.
 *
 * `ops.v_equipment_line.asset_line` composes it in SQL; `app/src/lib/assetLine.ts`
 * (Refractor, here) and `app/assets/asset.js` (BrixSD, skypace/apbg-dispatch)
 * rebuild it from the same parts so the pieces can be styled separately. Three
 * surfaces across two repos with no shared bundle — that is why the string is
 * written three times, and this test is what stops it meaning three things.
 *
 * ⚠ THE FIXTURE IS REAL ROWS, and each carries the `asset_line` POSTGRES
 * produced. So the assertion is not "does this function agree with itself"
 * but "does it reproduce what the database said" — which is the only version
 * of the check worth having. The identical file lives at
 * `app/__tests__/asset.fixture.json` in apbg-dispatch, read by its own
 * `asset.check.mjs`; if you edit one, edit both.
 *
 * ⚠ Bundled with esbuild and run in node — the `appMenus.ts` precedent — which
 * is why `assetLine.ts` deliberately imports nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assetLine, assetIdentity, assetNote, assetSerial, assetContract }
  from '../.test-build/assetLine.mjs';

const rows = JSON.parse(readFileSync(new URL('./asset-line.fixture.json', import.meta.url)));

test('the fixture is the real thing, not a hand-written echo of it', () => {
  assert.ok(rows.length >= 4, 'need the live shapes');
  for (const r of rows) {
    assert.ok(r.asset_line, `${r.id} carries no asset_line — it did not come from the view`);
    assert.match(r.id, /^[0-9a-f-]{36}$/, 'a real asset uuid');
  }
  // The four shapes the fallbacks were designed against.
  assert.ok(rows.some((r) => r.serial_number), 'a row with a serial');
  assert.ok(rows.some((r) => !r.serial_number), 'a row with none');
  assert.ok(rows.some((r) => r.contract_number), 'a row on a contract');
  assert.ok(rows.some((r) => !r.contract_number), 'a row on none');
  assert.ok(rows.some((r) => !r.make), 'a row with no make (RENTH100 — property rent)');
});

test('the TypeScript line reproduces the SQL line, character for character', () => {
  for (const r of rows) {
    assert.equal(assetLine(r), r.asset_line,
      `${r.id}\n  SQL: ${r.asset_line}\n   TS: ${assetLine(r)}`);
  }
});

test('a blank is named in words, never left as a dash', () => {
  const noSerial = rows.find((r) => !r.serial_number);
  assert.match(assetLine(noSerial), /no serial on file/);
  const noContract = rows.find((r) => !r.contract_number);
  assert.match(assetLine(noContract), /not on a contract/);
  // ⚠ A dash would be the tidy version and the useless one: which of the three
  // facts is missing decides what somebody does about it.
  for (const r of rows) assert.ok(!/·\s+—/.test(assetLine(r)), 'no bare em-dash blanks');
});

test('make_model wins over rebuilding from make + model', () => {
  // The view's own composed identity. Preferring the parts looks equivalent
  // and is not — a BrixSD job-equipment row is a SNAPSHOT carrying a
  // description and a model number and no make, so make-first would print the
  // bare model number where the recorded name belongs.
  assert.equal(assetIdentity({ make_model: 'AVANTCO 178UBB48HC', make: 'X', model_number: 'Y' }),
    'AVANTCO 178UBB48HC');
  assert.equal(assetIdentity({ make: 'MANITOWOC', model_number: 'IT1200C' }), 'MANITOWOC IT1200C');
  assert.equal(assetIdentity({ description: 'Ice machine', model: 'IT1200C' }), 'IT1200C');
  assert.equal(assetIdentity({ description: 'Ice machine' }), 'Ice machine');
});

test('the identity never falls through to nothing, and never leads with the tag', () => {
  // asset_tag is set on TWO of 154 live assets, so leading with it would leave
  // 152 rows identified by a blank.
  assert.equal(assetIdentity({ asset_tag: 'A-10002' }), 'Equipment A-10002');
  assert.equal(assetIdentity({}), 'Equipment');
  assert.equal(assetIdentity({ make_model: '   ', catalog_name: 'OSION OBM-350' }), 'OSION OBM-350');
  // A tag must not outrank a real name.
  assert.equal(assetIdentity({ asset_tag: 'A-1', make: 'OSION', model_number: 'OBM-350' }),
    'OSION OBM-350');
});

test('the snapshot spellings a job-equipment row uses are read', () => {
  // BrixSD's dispatch.job_equipment keeps its own copy of the plate, under
  // `serial` and `model` rather than the view's `serial_number` /
  // `model_number`. One composer serves both shapes or the job record prints a
  // different line from the customer page.
  assert.equal(assetSerial({ serial: '6997390370797' }), '6997390370797');
  assert.equal(assetSerial({}), null);
  assert.equal(assetContract({}), null);
  assert.equal(assetLine({ description: 'Ice machine', model: 'IT1200C', serial: '99' }),
    'IT1200C · #99 · not on a contract');
});

test('the note tells identical lines apart, and never repeats the identity', () => {
  // ⚠ REAL DESCRIPTIONS off ops.v_equipment_line. EL PHAROS holds three
  // OSION OCM-500s whose asset_line is character-for-character identical —
  // no serial, one shared contract — so the SITE in the description is the
  // only thing that says which box a row is. That is what the note is for,
  // and it is shown ONLY on a row whose line is not unique.
  const site = (d) => assetNote({ make_model: 'OSION OCM-500', description: d });
  assert.equal(site('OSION OCM-500 -- 3137 MISSION ST SF'), '3137 MISSION ST SF');
  assert.equal(site('OSION OCM-500 -- EL FARO GRANT STREET CONCORD'),
    'EL FARO GRANT STREET CONCORD');

  // ⚠ The leading repeat is trimmed CASE-INSENSITIVELY: ERLS writes the plate
  // in title case and the view upper-cases the identity, so a case-sensitive
  // test would leave the whole description and bury the distinguishing words.
  assert.equal(assetNote({ make_model: 'WUNDERBAR 10-BUTTON',
    description: 'Wunderbar 10-Button Bar Gun' }), 'Bar Gun');

  // A description that does NOT lead with the identity is kept whole — the
  // words before it (what KIND of rental this is) are the informative half.
  const rental = 'REFRIGERATED EQUIPMENT RENTAL BEVERAGE AIR BB48HC-1-B SERIAL #14404572';
  assert.equal(assetNote({ make_model: 'BEVERAGE AIR BB48HC-1-B', description: rental }), rental);

  // A partial identity still trims only what it matched.
  assert.equal(assetNote({ make_model: 'OSION',
    description: 'OSION 500LB ICE MACHINE WITH 500LB ICE BIN ASSET 1402' }),
    '500LB ICE MACHINE WITH 500LB ICE BIN ASSET 1402');

  // Nothing to add is null, never an empty string a renderer would print as a
  // stray separator — including a description that is ONLY the identity.
  assert.equal(assetNote({ make_model: 'OSION OCM-500' }), null);
  assert.equal(assetNote({ make_model: 'OSION OCM-500', description: '   ' }), null);
  assert.equal(assetNote({ make_model: 'OSION OCM-500', description: 'OSION OCM-500' }), null);
  assert.equal(assetNote({ make_model: 'OSION OCM-500', description: 'osion ocm-500 --' }), null);
});
