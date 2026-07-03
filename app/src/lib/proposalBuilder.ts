import { _sbToken } from './supabase';

const trimSlash = (value: string) => value.replace(/\/+$/, '');

const LEASING_API_URL = trimSlash(import.meta.env.VITE_BRIX_LEASING_API_URL || '');
const DIRECT_LEASING_API_ENABLED = import.meta.env.VITE_PROPOSAL_BUILDER_DIRECT_LEASING === '1';
const LEASING_PROXY_URL = import.meta.env.VITE_BRIX_LEASING_PROXY_URL || '/margin/.netlify/functions/proposal-leasing';
const GAMMA_PROXY_URL = import.meta.env.VITE_GAMMA_PROXY_URL || '/margin/.netlify/functions/proposal-gamma';
const BRANDOX_PROXY_URL = import.meta.env.VITE_BRANDOX_PROXY_URL || '/margin/.netlify/functions/proposal-brandox';
const PRODUCTS_PROXY_URL = '/margin/.netlify/functions/proposal-products';
const PROPOSAL_STORE_URL = import.meta.env.VITE_PROPOSAL_STORE_URL || '/margin/.netlify/functions/proposal-store';
const ACCOUNT_APPLICATION_URL = 'https://alamedapointbg.com/account-application';

export type ProposalProductCategory =
  | 'bib'
  | 'can'
  | 'tea'
  | 'lemonade'
  | 'juice'
  | 'mixer'
  | 'co2'
  | 'other';

export interface ProposalProduct {
  id: string;
  name: string;
  category: ProposalProductCategory;
  price?: number;
  packageSize?: string;
  description?: string;
  imageUrl?: string;
  active: boolean;
}

export interface EquipmentCatalogItem {
  id: string;
  sku: string;
  name: string;
  category: string;
  vendor?: string | null;
  acquisition_cost?: number | string | null;
  install_cost_default?: number | string | null;
  removal_cost_default?: number | string | null;
  refurb_reserve_default?: number | string | null;
  monthly_service_cost_default?: number | string | null;
  monthly_admin_fee_default?: number | string | null;
  going_monthly_rent?: number | string | null;
  useful_life_months?: number | null;
  description?: string | null;
  image_url?: string | null;
  spec_sheet_url?: string | null;
  active: boolean;
}

export interface ProposalEquipment {
  catalogItemId: string;
  name: string;
  category: string;
  quantity: number;
  equipmentCost: number;
  installCost: number;
  removalCost: number;
  refurbReserve: number;
  monthlyServiceCost: number;
  monthlyAdminFee: number;
  goingMonthlyRent?: number;
  usefulLifeMonths?: number | null;
  imageUrl?: string;
  specSheetUrl?: string;
}

export interface PricingLineInput {
  catalog_item_id?: string | null;
  description: string;
  quantity: number;
  equipment_cost: number;
  install_cost: number;
  removal_cost: number;
  refurb_reserve: number;
  monthly_service_cost: number;
  monthly_admin_fee: number;
  monitoring_fee?: number | null;
  lease_factor?: number | null;
}

export interface PricingCalculatePayload {
  pricing_model: 'month_to_month' | 'lease_support';
  term_months?: number | null;
  target_margin_pct: number;
  lines: PricingLineInput[];
}

export interface PricingLineResult {
  description: string;
  quantity: number;
  equipment_cost: number;
  total_capital: number;
  monthly_cost: number;
  monthly_price: number;
  monthly_margin: number;
  margin_pct: number;
  payback_months?: number | null;
  breakdown: Record<string, unknown>;
}

export interface PricingCalculateResponse {
  pricing_model: string;
  term_months?: number | null;
  target_margin_pct: number;
  lines: PricingLineResult[];
  total_monthly_price: number;
  total_monthly_cost: number;
  total_capital: number;
  snapshot: Record<string, unknown>;
}

export interface EquipmentQuotePayload {
  customer_id: string;
  customer_location_id?: string | null;
  pricing_model: 'month_to_month' | 'lease_support';
  term_months?: number | null;
  target_margin_pct: number;
  notes?: string | null;
  lines: PricingLineInput[];
}

export interface EquipmentQuoteResponse {
  id: string;
  quote_number: string;
  status: string;
  calculation_snapshot?: Record<string, unknown> | null;
}

export interface ServicePlan {
  key: string;
  label: string;
  category: string;
  upcharge_monthly: number;
  body: string;
}

export interface EndOfLeaseOption {
  key: string;
  label: string;
  description: string;
  needs_amount: boolean;
  needs_service_rate: boolean;
}

export interface BrandAsset {
  id: string;
  name: string;
  type: 'logo' | 'can' | 'equipment' | 'hero' | 'testimonial' | 'sell-sheet' | 'other';
  url: string;
  thumbnailUrl?: string;
  tags?: string[];
}

export interface ProposalCustomer {
  name: string;
  contactName: string;
  email: string;
  phone: string;
  businessType: string;
  location: string;
  leasingCustomerId?: string;
  leasingCustomerLocationId?: string;
}

export interface ProposalTerms {
  pricingModel: 'month_to_month' | 'lease_support';
  termMonths: number;
  targetMarginPct: number;
  installationTimeline: string;
  siteSurveyNextStep: string;
  servicePlanKeys: string[];
  endOfLeaseOptionKeys: string[];
  accountApplicationUrl: string;
}

export interface ProposalBuilderData {
  customer: ProposalCustomer;
  products: ProposalProduct[];
  equipment: ProposalEquipment[];
  pricing?: PricingCalculateResponse | null;
  servicePlans: ServicePlan[];
  endOfLeaseOptions: EndOfLeaseOption[];
  assets: BrandAsset[];
  terms: ProposalTerms;
  quote?: EquipmentQuoteResponse | null;
}

export interface SavedProposalSummary {
  id: string;
  title: string;
  customerName: string | null;
  customerEmail: string | null;
  businessType: string | null;
  status: 'draft' | 'shared' | 'archived';
  shareEnabled: boolean;
  shareSlug?: string | null;
  shareUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SavedProposal extends SavedProposalSummary {
  proposal: ProposalBuilderData;
  generatedEmail?: string;
  gammaUrl?: string | null;
  pdfUrl?: string | null;
}

export interface SaveProposalPayload {
  id?: string | null;
  title: string;
  proposal: ProposalBuilderData;
  generatedEmail?: string;
  gammaUrl?: string | null;
  pdfUrl?: string | null;
  shareEnabled?: boolean;
}

export interface GammaProposalResult {
  gammaUrl?: string;
  pdfUrl?: string;
  status: 'created' | 'pending' | 'error';
  message?: string;
  generationId?: string;
}

async function bearer(): Promise<string> {
  const token = await _sbToken();
  if (!token) throw new Error('Not signed in');
  return `Bearer ${token}`;
}

async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', await bearer());
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const message = typeof parsed === 'object' && parsed && 'error' in parsed
      ? String((parsed as { error?: unknown }).error)
      : typeof parsed === 'object' && parsed && 'detail' in parsed
        ? String((parsed as { detail?: unknown }).detail)
        : text || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return parsed as T;
}

function leasingUrl(path: string): string {
  if (DIRECT_LEASING_API_ENABLED && LEASING_API_URL) return `${LEASING_API_URL}${path}`;
  const resource = path.replace(/^\/api\//, '');
  return `${LEASING_PROXY_URL}?resource=${encodeURIComponent(resource)}`;
}

export async function getEquipmentCatalog(): Promise<EquipmentCatalogItem[]> {
  return apiFetch<EquipmentCatalogItem[]>(leasingUrl('/api/catalog'));
}

export async function calculateEquipmentPricing(payload: PricingCalculatePayload): Promise<PricingCalculateResponse> {
  return apiFetch<PricingCalculateResponse>(leasingUrl('/api/pricing/calculate'), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function createEquipmentQuote(payload: EquipmentQuotePayload): Promise<EquipmentQuoteResponse> {
  return apiFetch<EquipmentQuoteResponse>(leasingUrl('/api/quotes'), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function getServicePlans(): Promise<ServicePlan[]> {
  return apiFetch<ServicePlan[]>(leasingUrl('/api/quotes/service-plans'));
}

export async function getEndOfLeaseOptions(): Promise<EndOfLeaseOption[]> {
  return apiFetch<EndOfLeaseOption[]>(leasingUrl('/api/quotes/end-of-lease-options'));
}

export async function getBrixProducts(): Promise<ProposalProduct[]> {
  const result = await apiFetch<{ products: ProposalProduct[] } | ProposalProduct[]>(PRODUCTS_PROXY_URL);
  return Array.isArray(result) ? result : result.products;
}

export async function getBrandAssets(): Promise<BrandAsset[]> {
  const result = await apiFetch<{ assets: BrandAsset[] } | BrandAsset[]>(BRANDOX_PROXY_URL);
  return Array.isArray(result) ? result : result.assets;
}

export async function listSavedProposals(): Promise<SavedProposalSummary[]> {
  const result = await apiFetch<{ proposals: SavedProposalSummary[] } | SavedProposalSummary[]>(PROPOSAL_STORE_URL);
  return Array.isArray(result) ? result : result.proposals;
}

export async function getSavedProposal(id: string): Promise<SavedProposal> {
  const result = await apiFetch<{ proposal: SavedProposal }>(`${PROPOSAL_STORE_URL}?id=${encodeURIComponent(id)}`);
  return result.proposal;
}

export async function saveProposal(payload: SaveProposalPayload): Promise<SavedProposal> {
  const result = await apiFetch<{ proposal: SavedProposal }>(PROPOSAL_STORE_URL, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return result.proposal;
}

export async function generateProposalEmail(data: ProposalBuilderData): Promise<string> {
  const productNames = data.products.map((p) => p.name).join(', ') || 'a curated BRIX beverage lineup';
  const equipmentNames = data.equipment.map((e) => `${e.quantity}x ${e.name}`).join(', ') || 'the right dispense package';
  const monthly = data.pricing?.total_monthly_price != null
    ? currency(data.pricing.total_monthly_price)
    : 'to be confirmed after the site survey';
  const service = data.servicePlans
    .filter((plan) => data.terms.servicePlanKeys.includes(plan.key))
    .map((plan) => plan.label)
    .join(', ') || 'standard BRIX service and support';
  const contact = data.customer.contactName || data.customer.name || 'there';

  return [
    `Hi ${contact},`,
    '',
    `Thanks again for talking with us about a beverage program for ${data.customer.name || 'your location'}. Based on your ${data.customer.businessType || 'restaurant'} setup, I put together a starting recommendation with ${productNames}.`,
    '',
    `The equipment package currently includes ${equipmentNames}. The working monthly lease/rental estimate is ${monthly}, including ${service}.`,
    '',
    `Next step: ${data.terms.siteSurveyNextStep || 'we schedule a quick site survey to confirm utilities, space, and installation details.'}`,
    `Install timing: ${data.terms.installationTimeline || 'most projects are scheduled after product lineup, credit, and site details are confirmed.'}`,
    '',
    `When you are ready, the account application is here: ${data.terms.accountApplicationUrl || ACCOUNT_APPLICATION_URL}`,
    '',
    'I can also send over a polished proposal deck with the product lineup, equipment package, service plan, and next steps.',
    '',
    'Best,',
    'Brix Beverage',
  ].join('\n');
}

export async function generateGammaProposal(data: ProposalBuilderData): Promise<GammaProposalResult> {
  return apiFetch<GammaProposalResult>(GAMMA_PROXY_URL, {
    method: 'POST',
    body: JSON.stringify({
      title: 'Custom Beverage Program Proposal',
      customer: data.customer,
      products: data.products,
      equipment: data.equipment,
      pricing: data.pricing,
      quote: data.quote,
      servicePlans: data.servicePlans.filter((plan) => data.terms.servicePlanKeys.includes(plan.key)),
      endOfLeaseOptions: data.endOfLeaseOptions.filter((option) => data.terms.endOfLeaseOptionKeys.includes(option.key)),
      assets: data.assets,
      terms: data.terms,
      style: 'Alameda Craft Soda / Brix Beverage premium local beverage partner',
    }),
  });
}

export function catalogItemToProposalEquipment(item: EquipmentCatalogItem, quantity = 1): ProposalEquipment {
  return {
    catalogItemId: item.id,
    name: item.name,
    category: item.category,
    quantity,
    equipmentCost: money(item.acquisition_cost),
    installCost: money(item.install_cost_default),
    removalCost: money(item.removal_cost_default),
    refurbReserve: money(item.refurb_reserve_default),
    monthlyServiceCost: money(item.monthly_service_cost_default),
    monthlyAdminFee: money(item.monthly_admin_fee_default),
    goingMonthlyRent: money(item.going_monthly_rent) || undefined,
    usefulLifeMonths: item.useful_life_months ?? null,
    imageUrl: item.image_url || undefined,
    specSheetUrl: item.spec_sheet_url || undefined,
  };
}

export function equipmentToPricingLines(equipment: ProposalEquipment[]): PricingLineInput[] {
  return equipment.map((item) => ({
    catalog_item_id: item.catalogItemId || null,
    description: item.name,
    quantity: item.quantity,
    equipment_cost: item.equipmentCost,
    install_cost: item.installCost,
    removal_cost: item.removalCost,
    refurb_reserve: item.refurbReserve,
    monthly_service_cost: item.monthlyServiceCost,
    monthly_admin_fee: item.monthlyAdminFee,
    monitoring_fee: null,
  }));
}

export function defaultProposalTerms(): ProposalTerms {
  return {
    pricingModel: 'lease_support',
    termMonths: 36,
    targetMarginPct: 35,
    installationTimeline: 'Typical installation is 2-4 weeks after site survey, credit approval, and equipment availability.',
    siteSurveyNextStep: 'Schedule a site survey to confirm utilities, space, CO2 placement, and final install scope.',
    servicePlanKeys: [],
    endOfLeaseOptionKeys: [],
    accountApplicationUrl: ACCOUNT_APPLICATION_URL,
  };
}

export function currency(value: number | string | null | undefined): string {
  const n = Number(value || 0);
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function money(value: number | string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
