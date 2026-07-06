import type { CSSProperties } from 'react';
import { Calculator, PackageCheck, TriangleAlert } from 'lucide-react';
import type {
  BomLineInput,
  BomMaterialRequirement,
  CopackMaterialSourceMode,
  ProductBom,
} from '../../lib/production';
import { fm, fmtNum } from '../../lib/formatters';
import { convertQty, fmtQty, inferItemVolumeFlOz, scaleBom, uomGroup } from '../../lib/uom';
import type { ProductionItemLookup } from './ProductionPage';

interface Props {
  bom: ProductBom;
  lines: BomLineInput[] | null;
  itemLookup: ProductionItemLookup;
  targetQty: number;
  targetUom: string;
  materialSourceMode: CopackMaterialSourceMode;
  syrupRate?: number | null;
  coPackFee?: number | null;
  freightCost?: number | null;
  otherLandedCost?: number | null;
  materialRows?: BomMaterialRequirement[] | null;
  title?: string;
}

interface OutputEstimate {
  finishedUnits: number | null;
  gallons: number | null;
  cans: number | null;
  pack8: number | null;
  pack24: number | null;
}

const SOURCE_MODE_LABEL: Record<CopackMaterialSourceMode, string> = {
  raw_materials: 'Raw Materials Co-Pack',
  syrup_by_gallon: 'Syrup Co-Pack',
};

export function CopackOrderWorksheetPanel({
  bom,
  lines,
  itemLookup,
  targetQty,
  targetUom,
  materialSourceMode,
  syrupRate = 0,
  coPackFee = 0,
  freightCost = 0,
  otherLandedCost = 0,
  materialRows = null,
  title = 'Order worksheet',
}: Props) {
  const qty = finiteNumber(targetQty);
  const output = estimateOutput(qty, targetUom, bom);
  const scaled = lines && qty > 0 ? scaleBom(
    { qty, uom: targetUom || 'gal' },
    {
      qty: Number(bom.yield_qty),
      uom: bom.yield_uom || 'gal',
      finishedVolPerYieldGal: bom.finished_vol_per_yield_gal == null ? undefined : Number(bom.finished_vol_per_yield_gal),
      dilutionRatio: Number(bom.dilution_ratio ?? 0),
    },
    lines.map((line, idx) => {
      const item = line.component_qbo_item_id ? itemLookup.byId.get(line.component_qbo_item_id) : null;
      return {
        qty_per: Number(line.qty_per),
        qty_uom: line.qty_uom || 'each',
        scrap_pct: Number(line.scrap_pct ?? 0),
        ref: { idx },
        itemName: item?.item_name ?? line.service_label ?? null,
        itemType: line.line_type === 'service' ? 'Service' : null,
      };
    }),
  ) : null;
  const scaledByIdx = new Map<number, { qty: number; uom: string }>();
  if (scaled) for (const line of scaled.scaledLines) scaledByIdx.set(line.ref.idx, { qty: line.qty, uom: line.uom });

  const rawComponentCost = materialRows
    ? materialRows.reduce((sum, row) => sum + Number(row.required_qty || 0) * Number(row.unit_cost ?? 0), 0)
    : (lines ?? []).reduce((sum, line, idx) => {
      if (line.line_type !== 'component') return sum;
      const scaledLine = scaledByIdx.get(idx);
      const unitCost = componentUnitCost(line, itemLookup);
      return sum + Number(scaledLine?.qty ?? 0) * Number(unitCost ?? 0);
    }, 0);
  const syrupGallons = materialSourceMode === 'syrup_by_gallon'
    ? estimateSyrupGallons(lines ?? [], scaledByIdx, itemLookup, output.gallons)
    : null;
  const syrupCost = syrupGallons == null ? null : syrupGallons * finiteNumber(syrupRate);
  const materialCost = materialSourceMode === 'syrup_by_gallon'
    ? Number(syrupCost ?? 0)
    : rawComponentCost;
  const serviceCost = (lines ?? []).reduce((sum, line, idx) => {
    if (line.line_type !== 'service') return sum;
    const scaledLine = scaledByIdx.get(idx);
    return sum + Number(scaledLine?.qty ?? 0) * Number(line.default_cost ?? 0);
  }, 0);
  const landedCost = finiteNumber(coPackFee) + finiteNumber(freightCost) + finiteNumber(otherLandedCost);
  const totalCost = materialCost + serviceCost + landedCost;

  const perFinishedUnit = output.finishedUnits && output.finishedUnits > 0 ? totalCost / output.finishedUnits : null;
  const perCan = output.cans && output.cans > 0 ? totalCost / output.cans : null;
  const perGal = output.gallons && output.gallons > 0 ? totalCost / output.gallons : null;
  const perOz = output.gallons && output.gallons > 0 ? totalCost / (output.gallons * 128) : null;
  const shortages = materialRows?.filter((row) => Number(row.shortage_qty) > 0) ?? [];
  const missingRawCosts = (lines ?? []).filter((line) => {
    if (line.line_type !== 'component') return false;
    const cost = componentUnitCost(line, itemLookup);
    return !(Number(cost ?? 0) > 0);
  }).length;
  const missingServiceCosts = (lines ?? []).filter((line) => line.line_type === 'service' && !(Number(line.default_cost ?? 0) > 0)).length;

  const warnings: string[] = [];
  if (lines === null) warnings.push('Loading formula lines.');
  if (lines !== null && lines.length === 0) warnings.push('Formula has no lines.');
  if (lines !== null && !scaled) warnings.push('Formula cannot scale to this order unit.');
  if (output.finishedUnits == null) warnings.push('Finished-unit conversion is missing.');
  if (materialSourceMode === 'raw_materials' && missingRawCosts > 0) warnings.push(`${missingRawCosts} ingredient cost${missingRawCosts === 1 ? '' : 's'} missing.`);
  if (materialSourceMode === 'syrup_by_gallon' && !(Number(syrupGallons ?? 0) > 0)) warnings.push('Syrup gallons could not be estimated.');
  if (materialSourceMode === 'syrup_by_gallon' && !(Number(syrupRate ?? 0) > 0)) warnings.push('Syrup rate is missing.');
  if (missingServiceCosts > 0) warnings.push(`${missingServiceCosts} service cost${missingServiceCosts === 1 ? '' : 's'} missing.`);
  if (shortages.length > 0) warnings.push(`${shortages.length} raw material shortage${shortages.length === 1 ? '' : 's'}.`);

  const healthy = warnings.length === 0;
  const Icon = healthy ? PackageCheck : TriangleAlert;
  const tone = healthy
    ? { color: 'var(--gn)', border: 'rgba(125,238,164,0.24)', bg: 'rgba(125,238,164,0.05)' }
    : { color: 'var(--am)', border: 'rgba(239,191,65,0.28)', bg: 'rgba(239,191,65,0.06)' };

  return (
    <section style={{
      marginTop: 12,
      marginBottom: 14,
      padding: 12,
      border: `1px solid ${tone.border}`,
      borderRadius: 4,
      background: tone.bg,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', marginBottom: 10 }}>
        <Calculator size={15} color="var(--ac)" />
        <div>
          <div style={eyebrow}>{title}</div>
          <div style={{ fontSize: 11, color: 'var(--mt)', marginTop: 2 }}>
            {SOURCE_MODE_LABEL[materialSourceMode]} - {fmtQty(qty, targetUom || 'gal')}
            {scaled ? ` - ${scaled.mode === 'ingredient' ? 'ingredient-scaled' : 'yield-scaled'}` : ''}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          color: tone.color,
          border: `1px solid ${tone.border}`,
          background: 'rgba(255,255,255,0.04)',
          padding: '2px 8px',
          borderRadius: 10,
          fontSize: 10,
          fontWeight: 700,
        }}>
          <Icon size={12} />
          {healthy ? 'Ready estimate' : `${warnings.length} review`}
        </span>
      </div>

      <div style={grid}>
        <Mini label="Finished gal" value={fmtMaybeQty(output.gallons, 'gal')} />
        <Mini label="Finished units" value={fmtMaybeNum(output.finishedUnits)} />
        <Mini label="Cans" value={fmtMaybeNum(output.cans)} />
        <Mini label="24-packs" value={fmtMaybeNum(output.pack24)} />
      </div>

      {materialSourceMode === 'syrup_by_gallon' && (
        <div style={{ ...grid, marginTop: 10 }}>
          <Mini label="Syrup gal" value={fmtMaybeQty(syrupGallons, 'gal')} />
          <Mini label="$ / syrup gal" value={`$${finiteNumber(syrupRate).toFixed(4)}`} />
          <Mini label="Syrup cost" value={syrupCost == null ? '-' : fm(syrupCost)} />
          <Mini label="8-packs" value={fmtMaybeNum(output.pack8)} />
        </div>
      )}

      <div style={{ ...grid, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--bd)' }}>
        <Mini label={materialSourceMode === 'syrup_by_gallon' ? 'Syrup' : 'Raw materials'} value={fm(materialCost)} />
        <Mini label="Services" value={fm(serviceCost)} />
        <Mini label="Co-pack fee" value={fm(finiteNumber(coPackFee))} />
        <Mini label="Freight" value={fm(finiteNumber(freightCost))} />
        <Mini label="Other" value={fm(finiteNumber(otherLandedCost))} />
        <Mini label="Total COGS" value={fm(totalCost)} accent />
      </div>

      <div style={{ ...grid, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--bd)' }}>
        <Mini label="$ / finished unit" value={perFinishedUnit == null ? '-' : `$${perFinishedUnit.toFixed(4)}`} accent />
        <Mini label="$ / can" value={perCan == null ? '-' : `$${perCan.toFixed(4)}`} />
        <Mini label="$ / gal" value={perGal == null ? '-' : `$${perGal.toFixed(4)}`} />
        <Mini label="$ / oz" value={perOz == null ? '-' : `$${perOz.toFixed(5)}`} />
      </div>

      {warnings.length > 0 && (
        <div style={{ display: 'grid', gap: 4, marginTop: 10 }}>
          {warnings.slice(0, 4).map((warning) => (
            <div key={warning} style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--am)', fontSize: 11 }}>
              <TriangleAlert size={12} />
              {warning}
            </div>
          ))}
          {warnings.length > 4 && (
            <div style={{ color: 'var(--mt)', fontSize: 11 }}>+{warnings.length - 4} more</div>
          )}
        </div>
      )}
    </section>
  );
}

function estimateOutput(qty: number, uom: string, bom: ProductBom): OutputEstimate {
  if (!(qty > 0)) return { finishedUnits: null, gallons: null, cans: null, pack8: null, pack24: null };
  const cansPerFinishedUnit = Number(bom.cans_per_case || 0);
  const ozPerCan = Number(bom.oz_per_can || 0);
  let gallons: number | null = null;
  let finishedUnits: number | null = null;
  if (uomGroup(uom) === 'volume') {
    gallons = convertQty(qty, uom, 'gal');
    if (gallons != null && cansPerFinishedUnit > 0 && ozPerCan > 0) {
      finishedUnits = (gallons * 128) / (cansPerFinishedUnit * ozPerCan);
    }
  } else if (uom === 'each' || uom === 'case') {
    finishedUnits = qty;
    if (cansPerFinishedUnit > 0 && ozPerCan > 0) {
      gallons = (finishedUnits * cansPerFinishedUnit * ozPerCan) / 128;
    }
  }
  const cans = finishedUnits == null || !(cansPerFinishedUnit > 0) ? null : finishedUnits * cansPerFinishedUnit;
  return {
    finishedUnits,
    gallons,
    cans,
    pack8: cans == null ? null : cans / 8,
    pack24: cans == null ? null : cans / 24,
  };
}

function estimateSyrupGallons(
  lines: BomLineInput[],
  scaledByIdx: Map<number, { qty: number; uom: string }>,
  itemLookup: ProductionItemLookup,
  fallbackFinishedGallons: number | null,
): number | null {
  let gallons = 0;
  for (const [idx, line] of lines.entries()) {
    if (line.line_type !== 'component') continue;
    const scaled = scaledByIdx.get(idx);
    if (!scaled) continue;
    if (uomGroup(scaled.uom) === 'volume') {
      gallons += convertQty(Number(scaled.qty), scaled.uom, 'gal') ?? 0;
      continue;
    }
    const item = line.component_qbo_item_id ? itemLookup.byId.get(line.component_qbo_item_id) : null;
    const flOz = inferItemVolumeFlOz(item?.item_name, null);
    if (flOz != null && flOz > 0) gallons += Number(scaled.qty) * flOz / 128;
  }
  if (gallons > 0) return gallons;
  return fallbackFinishedGallons;
}

function componentUnitCost(line: BomLineInput, itemLookup: ProductionItemLookup): number | null {
  if (line.default_cost != null && Number(line.default_cost) > 0) return Number(line.default_cost);
  const itemCost = line.component_qbo_item_id
    ? itemLookup.byId.get(line.component_qbo_item_id)?.purchase_cost
    : null;
  return itemCost == null ? null : Number(itemCost);
}

function finiteNumber(value: number | string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function fmtMaybeQty(value: number | null, uom: string): string {
  return value == null || !Number.isFinite(value) ? '-' : fmtQty(value, uom);
}

function fmtMaybeNum(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  return fmtNum(value, digits);
}

function Mini({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div style={eyebrow}>{label}</div>
      <div style={{
        marginTop: 3,
        color: accent ? 'var(--ac)' : 'var(--tx)',
        fontFamily: 'var(--ff-mono)',
        fontWeight: accent ? 800 : 700,
        fontSize: 12,
      }}>
        {value}
      </div>
    </div>
  );
}

const eyebrow: CSSProperties = {
  fontSize: 9,
  color: 'var(--mt)',
  letterSpacing: 0.6,
  textTransform: 'uppercase',
};

const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))',
  gap: 8,
};
