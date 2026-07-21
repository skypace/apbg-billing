import { sbq, sbrpc } from './rpc';
import { SB_KEY, SB_URL, _sbToken } from './supabase';

// ── Types ────────────────────────────────────────────────────────────────

export type FormulaStatus = 'draft' | 'active' | 'archived';

export interface ProductFormula {
  id: string;
  name: string;
  code: string | null;
  title: string | null;
  doc_rev: string;
  effective_date: string | null;
  status: FormulaStatus;
  default_batch_size_gal: number | null;
  can_size_oz: number | null;
  density_lbs_per_gal: number | null;
  water_lbs_per_gal: number | null;
  /** {"pH":"2.50-2.60","Brix":"11.8+/-0.2",...} */
  qc_specs: Record<string, string>;
  /** Ordered batching steps. */
  batching_instructions: string[];
  comments: string | null;
  attachment_path: string | null;
  source_file_name: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FormulaIngredient {
  id: string;
  formula_id: string;
  ingredient_name: string;
  /** Fraction of total batch weight (0–1). Weights are derived where used. */
  pct_by_weight: number;
  uom: string;
  component_qbo_item_id: string | null;
  sort_order: number;
  notes: string | null;
  created_at: string;
}

export interface FormulaRevision {
  id: string;
  formula_id: string;
  rev: string;
  note: string | null;
  rev_date: string | null;
  created_at: string;
}

export interface FormulaHeaderInput {
  name: string;
  code?: string | null;
  title?: string | null;
  doc_rev?: string;
  effective_date?: string | null;
  status?: FormulaStatus;
  default_batch_size_gal?: number | null;
  can_size_oz?: number | null;
  density_lbs_per_gal?: number | null;
  water_lbs_per_gal?: number | null;
  qc_specs?: Record<string, string>;
  batching_instructions?: string[];
  comments?: string | null;
  attachment_path?: string | null;
  source_file_name?: string | null;
}

export interface FormulaIngredientInput {
  ingredient_name: string;
  pct_by_weight: number;
  uom?: string;
  component_qbo_item_id?: string | null;
  notes?: string | null;
}

// ── Derived batch math (the sheet's calc, now computed where displayed) ──

export interface BatchLine {
  ingredient_name: string;
  pct_by_weight: number;
  target_weight_lbs: number;
  uom: string;
}

/** Scale a formula to a batch size: weight = gal × density(lbs/gal) × pct. */
export function scaleFormulaBatch(
  formula: Pick<ProductFormula, 'density_lbs_per_gal'>,
  ingredients: Pick<FormulaIngredient, 'ingredient_name' | 'pct_by_weight' | 'uom'>[],
  batchGal: number,
): BatchLine[] {
  const density = Number(formula.density_lbs_per_gal ?? 0);
  const totalLbs = batchGal * density;
  return ingredients.map((i) => ({
    ingredient_name: i.ingredient_name,
    pct_by_weight: Number(i.pct_by_weight),
    target_weight_lbs: totalLbs * Number(i.pct_by_weight),
    uom: i.uom || 'lbs',
  }));
}

/** Cans a batch should fill: gal × 128 / can oz. */
export function batchTargetUnits(batchGal: number, canSizeOz: number | null): number | null {
  if (!canSizeOz || canSizeOz <= 0) return null;
  return (batchGal * 128) / canSizeOz;
}

// ── Reads ────────────────────────────────────────────────────────────────

export async function fetchFormulas(): Promise<ProductFormula[]> {
  return sbq<ProductFormula>('product_formulas', 'select=*&order=name.asc');
}

export async function fetchFormulaIngredients(formulaId: string): Promise<FormulaIngredient[]> {
  return sbq<FormulaIngredient>('product_formula_ingredients',
    `select=*&formula_id=eq.${formulaId}&order=sort_order.asc`);
}

export async function fetchFormulaRevisions(formulaId: string): Promise<FormulaRevision[]> {
  return sbq<FormulaRevision>('product_formula_revisions',
    `select=*&formula_id=eq.${formulaId}&order=created_at.asc`);
}

// ── Mutations ────────────────────────────────────────────────────────────

export async function saveFormula(args: {
  id?: string | null;
  header: FormulaHeaderInput;
  ingredients: FormulaIngredientInput[];
  revisionNote?: string | null;
}): Promise<string> {
  return sbrpc<string>('fn_formula_save', {
    p_id: args.id ?? null,
    p_header: args.header,
    p_ingredients: args.ingredients,
    p_revision_note: args.revisionNote ?? null,
  });
}

// ── Attachments (private bucket product-formulas) ────────────────────────

export async function uploadFormulaAttachment(formulaId: string, file: File): Promise<string> {
  const token = await _sbToken();
  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
  const path = `${formulaId}/${Date.now()}-${safeName}`;
  const res = await fetch(`${SB_URL}/storage/v1/object/product-formulas/${path}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + token,
      'Content-Type': file.type || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: file,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('attachment upload failed: ' + res.status + ' ' + text);
  }
  return path;
}

/** Open a private-bucket attachment in a new tab via an object URL. */
export async function openFormulaAttachment(path: string): Promise<void> {
  const token = await _sbToken();
  const res = await fetch(`${SB_URL}/storage/v1/object/authenticated/product-formulas/${path}`, {
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error('attachment download failed: ' + res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = path.split('/').pop() ?? 'attachment';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
