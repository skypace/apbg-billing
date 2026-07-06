import type { BomLineInput, ProductBom } from '../../lib/production';
import { inferItemVolumeFlOz, uomGroup } from '../../lib/uom';
import type { CopackMaterialSourceMode } from '../../lib/production';
import type { ProductionItemLookup } from './ProductionPage';

export type FormulaReadinessStatus = 'pending' | 'ready' | 'watch' | 'blocked';
export type FormulaReadinessIssueLevel = 'block' | 'watch' | 'ok';

export interface FormulaReadinessIssue {
  level: FormulaReadinessIssueLevel;
  label: string;
  detail: string;
}

export interface FormulaReadiness {
  status: FormulaReadinessStatus;
  label: string;
  summary: string;
  checks: FormulaReadinessIssue[];
  blockers: FormulaReadinessIssue[];
  warnings: FormulaReadinessIssue[];
  componentCount: number;
  serviceCount: number;
  missingCostCount: number;
  parseableVolumeCount: number;
  serviceLikeComponentCount: number;
}

export interface FormulaReadinessOptions {
  bom: ProductBom;
  lines: BomLineInput[] | null;
  itemLookup: ProductionItemLookup;
  materialSourceMode?: CopackMaterialSourceMode;
  syrupUnitCostPerGal?: number | null;
  requireSyrupRate?: boolean;
  overrides?: {
    finishedVolPerYieldGal?: number | null;
    dilutionRatio?: number | null;
    cansPerCase?: number | null;
    ozPerCan?: number | null;
  };
}

const SERVICE_LIKE_RE = /\b(LABOU?R|PACK\s*OFF|FEE|CHARGE|SHIPPING|FREIGHT|DELIVERY|SERVICE)\b/i;

export function evaluateFormulaReadiness({
  bom,
  lines,
  itemLookup,
  materialSourceMode = 'raw_materials',
  syrupUnitCostPerGal = null,
  requireSyrupRate = false,
  overrides,
}: FormulaReadinessOptions): FormulaReadiness {
  if (lines === null) {
    const pending: FormulaReadinessIssue = {
      level: 'watch',
      label: 'Loading recipe lines',
      detail: 'BOM line details are still loading.',
    };
    return finishReadiness([pending], 0, 0, 0, 0, 0, 'pending');
  }

  const checks: FormulaReadinessIssue[] = [];
  const yieldQty = Number(bom.yield_qty);
  const yieldUom = bom.yield_uom || 'each';
  const finishedVolPerYieldGal = overrides?.finishedVolPerYieldGal == null
    ? (bom.finished_vol_per_yield_gal == null ? null : Number(bom.finished_vol_per_yield_gal))
    : Number(overrides.finishedVolPerYieldGal);
  const dilutionRatio = overrides?.dilutionRatio == null
    ? Number(bom.dilution_ratio ?? 0)
    : Number(overrides.dilutionRatio);
  const cansPerCase = overrides?.cansPerCase == null
    ? Number(bom.cans_per_case ?? 24)
    : Number(overrides.cansPerCase);
  const ozPerCan = overrides?.ozPerCan == null
    ? Number(bom.oz_per_can ?? 12)
    : Number(overrides.ozPerCan);

  const finished = itemLookup.byId.get(bom.finished_qbo_item_id);
  const components = lines.filter((l) => l.line_type === 'component');
  const services = lines.filter((l) => l.line_type === 'service');

  if (!bom.is_active) {
    checks.push({
      level: 'block',
      label: 'Inactive BOM',
      detail: 'Activate this BOM before creating production or co-pack orders.',
    });
  }
  if (finished?.active === false) {
    checks.push({
      level: 'block',
      label: 'Finished item inactive',
      detail: 'The finished QBO item is inactive.',
    });
  }
  if (!(yieldQty > 0)) {
    checks.push({ level: 'block', label: 'Missing yield', detail: 'Recipe basis must have a positive yield quantity.' });
  }
  if (!(cansPerCase > 0) || !(ozPerCan > 0)) {
    checks.push({
      level: 'block',
      label: 'Missing pack/can assumptions',
      detail: 'Set cans per case and ounces per can so COGS can roll to case, can, ounce, and gallon.',
    });
  }
  if (lines.length === 0 || components.length === 0) {
    checks.push({
      level: 'block',
      label: 'Missing ingredients',
      detail: 'Add at least one component line for the formula.',
    });
  }

  let missingCostCount = 0;
  let parseableVolumeCount = 0;
  let serviceLikeComponentCount = 0;
  for (const line of components) {
    const item = line.component_qbo_item_id ? itemLookup.byId.get(line.component_qbo_item_id) : null;
    const itemName = item?.item_name ?? null;
    const lineCost = line.default_cost == null ? null : Number(line.default_cost);
    const itemCost = item?.purchase_cost == null ? null : Number(item.purchase_cost);
    const hasCost = materialSourceMode === 'syrup_by_gallon'
      ? true
      : ((lineCost != null && lineCost > 0) || (itemCost != null && itemCost > 0));
    if (!hasCost) missingCostCount += 1;

    if (uomGroup(line.qty_uom || 'each') === 'volume' || inferItemVolumeFlOz(itemName, null) != null) {
      parseableVolumeCount += 1;
    }
    if (SERVICE_LIKE_RE.test(itemName ?? '')) {
      serviceLikeComponentCount += 1;
    }
  }

  if (missingCostCount > 0) {
    checks.push({
      level: 'block',
      label: 'Missing ingredient costs',
      detail: `${missingCostCount} component line${missingCostCount === 1 ? '' : 's'} need a BOM unit cost or QBO purchase cost.`,
    });
  }

  const missingServiceCosts = services.filter((line) => !(Number(line.default_cost ?? 0) > 0)).length;
  if (missingServiceCosts > 0) {
    checks.push({
      level: 'watch',
      label: 'Service costs incomplete',
      detail: `${missingServiceCosts} service line${missingServiceCosts === 1 ? '' : 's'} have no default cost.`,
    });
  }
  if (serviceLikeComponentCount > 0) {
    checks.push({
      level: 'watch',
      label: 'Service-looking component',
      detail: `${serviceLikeComponentCount} component line${serviceLikeComponentCount === 1 ? '' : 's'} look like labor, freight, or fees.`,
    });
  }

  const yieldIsVolume = uomGroup(yieldUom) === 'volume';
  const hasBridge = finishedVolPerYieldGal != null && Number.isFinite(finishedVolPerYieldGal) && finishedVolPerYieldGal > 0;
  const hasDilution = Number.isFinite(dilutionRatio) && dilutionRatio > 0;
  if (!yieldIsVolume && !hasBridge && !hasDilution) {
    checks.push({
      level: 'block',
      label: 'Missing conversion data',
      detail: `Yield is in ${yieldUom}. Set gallons per yield or use a gallon recipe basis so orders can scale by tank gallons.`,
    });
  }
  if (hasDilution && parseableVolumeCount === 0) {
    checks.push({
      level: 'block',
      label: 'Dilution cannot scale',
      detail: 'Dilution is set, but no component line has a parseable liquid volume or volume UOM.',
    });
  }
  if (!yieldIsVolume && hasBridge) {
    checks.push({
      level: 'watch',
      label: 'Legacy gallon bridge',
      detail: 'This can scale by gallons, but gallon-first recipe yield is cleaner for tank production.',
    });
  }

  if (requireSyrupRate && materialSourceMode === 'syrup_by_gallon' && !(Number(syrupUnitCostPerGal) > 0)) {
    checks.push({
      level: 'block',
      label: 'Missing syrup rate',
      detail: 'Enter syrup $ / gal before creating a Syrup Co-Pack order.',
    });
  }

  if (checks.length === 0) {
    checks.push({
      level: 'ok',
      label: 'Ready for co-pack',
      detail: materialSourceMode === 'syrup_by_gallon'
        ? 'Formula, pack sizing, conversion math, and syrup rate are ready.'
        : 'Formula, pack sizing, conversion math, and ingredient costs are ready.',
    });
  }

  return finishReadiness(checks, components.length, services.length, missingCostCount, parseableVolumeCount, serviceLikeComponentCount);
}

function finishReadiness(
  checks: FormulaReadinessIssue[],
  componentCount: number,
  serviceCount: number,
  missingCostCount: number,
  parseableVolumeCount: number,
  serviceLikeComponentCount: number,
  forcedStatus?: FormulaReadinessStatus,
): FormulaReadiness {
  const blockers = checks.filter((c) => c.level === 'block');
  const warnings = checks.filter((c) => c.level === 'watch');
  const status: FormulaReadinessStatus = forcedStatus
    ?? (blockers.length > 0 ? 'blocked' : warnings.length > 0 ? 'watch' : 'ready');
  const label = status === 'ready'
    ? 'Ready'
    : status === 'watch'
    ? 'Needs review'
    : status === 'blocked'
    ? 'Not ready'
    : 'Loading';
  const summary = status === 'ready'
    ? 'Ready to create a co-pack order.'
    : status === 'watch'
    ? `${warnings.length} review item${warnings.length === 1 ? '' : 's'}.`
    : status === 'blocked'
    ? `${blockers.length} blocker${blockers.length === 1 ? '' : 's'} to fix.`
    : 'Checking formula lines.';
  return {
    status,
    label,
    summary,
    checks,
    blockers,
    warnings,
    componentCount,
    serviceCount,
    missingCostCount,
    parseableVolumeCount,
    serviceLikeComponentCount,
  };
}
