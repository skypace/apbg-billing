import { sbAuth } from './supabase';

const trimSlash = (value: string) => value.replace(/\/+$/, '');
const netlifyFunction = (name: string) => ['/', 'margin', '/.netlify', '/functions', '/', name].join('');
const normalizeFunctionOverride = (value: string | undefined, fallback: string) => {
  const raw = value?.trim();
  if (!raw) return fallback;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/margin/.netlify/functions/')) return raw;
  if (/^\/?\.?netlify\/functions\//i.test(raw)) return fallback;
  if (raw.startsWith('/.netlify/functions/')) return `/margin${raw}`;
  if (raw.startsWith('/')) return raw;
  return `/${raw}`;
};

const LEASING_API_URL = trimSlash(import.meta.env.VITE_BRIX_LEASING_API_URL || '');
const DIRECT_LEASING_API_ENABLED = import.meta.env.VITE_PROPOSAL_BUILDER_DIRECT_LEASING === '1';
const LEASING_PROXY_URL = normalizeFunctionOverride(import.meta.env.VITE_BRIX_LEASING_PROXY_URL, netlifyFunction('proposal-leasing'));
const GAMMA_PROXY_URL = normalizeFunctionOverride(import.meta.env.VITE_GAMMA_PROXY_URL, netlifyFunction('proposal-gamma'));
const BRAND_ASSETS_URL = normalizeFunctionOverride(import.meta.env.VITE_BRAND_ASSETS_URL, netlifyFunction('proposal-brand-assets'));
const PRODUCTS_PROXY_URL = netlifyFunction('proposal-products');
const PROPOSAL_STORE_URL = normalizeFunctionOverride(import.meta.env.VITE_PROPOSAL_STORE_URL, netlifyFunction('proposal-store'));
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

export type BeverageClass = 'fountain' | 'packaged';

export interface ProposalProduct {
  id: string;
  name: string;
  category: ProposalProductCategory;
  beverageClass?: BeverageClass;
  price?: number;
  packageSize?: string;
  description?: string;
  imageUrl?: string;
  imageUrls?: string[];
  specSheetUrl?: string;
  sku?: string;
  manufacturer?: string;
  model?: string;
  weightLbs?: number;
  source?: 'qbo' | 'brix-order';
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

export type BrandAssetType = 'logo' | 'can' | 'equipment' | 'hero' | 'testimonial' | 'sell-sheet' | 'other';

export const BRAND_ASSET_TYPES: BrandAssetType[] = ['logo', 'can', 'equipment', 'hero', 'testimonial', 'sell-sheet', 'other'];

export interface BrandAsset {
  id: string;
  name: string;
  type: BrandAssetType;
  url: string;
  thumbnailUrl?: string;
  tags?: string[];
  /** DAM brand slug (alameda / brix / shared / sister brand). */
  brand?: string;
  /** Storage path within the brand-assets bucket (present for uploaded assets). */
  path?: string;
  /** 'supabase' = in the brand library bucket, 'local' = built-in fallback art. */
  source?: 'supabase' | 'local';
}

export interface DamBrandOption { slug: string; label: string }
export interface DamCollectionOption { id: string; name: string; parent_id?: string | null }
export interface BrandLibraryResponse { assets: BrandAsset[]; brands: DamBrandOption[]; collections: DamCollectionOption[] }

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
  const { data } = await sbAuth.auth.getSession();
  const token = data.session?.access_token;
  if (!token || token.split('.').length !== 3) {
    throw new Error('Please sign in again to load proposal integrations.');
  }
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

function brandAssetsUrl(opts: { brand?: string; collection?: string } = {}): string {
  const qs = new URLSearchParams();
  if (opts.brand) qs.set('brand', opts.brand);
  if (opts.collection) qs.set('collection', opts.collection);
  const query = qs.toString();
  if (!query) return BRAND_ASSETS_URL;
  return `${BRAND_ASSETS_URL}${BRAND_ASSETS_URL.includes('?') ? '&' : '?'}${query}`;
}

export async function getBrandAssets(opts: { brand?: string; collection?: string } = {}): Promise<BrandAsset[]> {
  const result = await apiFetch<{ assets: BrandAsset[] } | BrandAsset[]>(brandAssetsUrl(opts));
  return Array.isArray(result) ? result : result.assets;
}

// Full brand library payload including the brand + collection pickers.
export async function getBrandLibrary(opts: { brand?: string; collection?: string } = {}): Promise<BrandLibraryResponse> {
  const result = await apiFetch<BrandLibraryResponse>(brandAssetsUrl(opts));
  return { assets: result.assets || [], brands: result.brands || [], collections: result.collections || [] };
}

export interface BrandAssetUpload {
  filename: string;
  contentType: string;
  dataBase64: string;
  type?: BrandAssetType;
}

export async function uploadBrandAsset(upload: BrandAssetUpload): Promise<BrandAsset> {
  const result = await apiFetch<{ asset: BrandAsset }>(BRAND_ASSETS_URL, {
    method: 'POST',
    body: JSON.stringify(upload),
  });
  return result.asset;
}

export async function deleteBrandAsset(path: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`${BRAND_ASSETS_URL}?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  });
}

/** Read a File as a base64 payload for uploadBrandAsset. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
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

export interface ProposalTemplate {
  key: string;
  label: string;
  emoji: string;
  headline: string;
  description: string;
  businessType: string;
  /** Product categories this venue type typically wants, most relevant first. */
  productCategories: ProposalProductCategory[];
  /** Extra name/description keywords used to rank product suggestions. */
  productKeywords: string[];
  /** Equipment catalog keywords to pre-fill the equipment search box. */
  equipmentKeywords: string[];
  /** Service-plan category to preselect when a matching plan exists. */
  servicePlanCategory: string;
  terms: Pick<ProposalTerms, 'pricingModel' | 'termMonths' | 'targetMarginPct' | 'installationTimeline' | 'siteSurveyNextStep'>;
}

export const PROPOSAL_TEMPLATES: ProposalTemplate[] = [
  {
    key: 'restaurant',
    label: 'Restaurants',
    emoji: '🍽️',
    headline: 'Full-service restaurant beverage program',
    description: 'Fountain BIB lineup with mixers and CO₂ for a full dining room. Built around a leased dispense system and standard service.',
    businessType: 'Restaurant',
    productCategories: ['bib', 'mixer', 'co2', 'lemonade', 'tea', 'juice'],
    productKeywords: ['cola', 'root beer', 'ginger ale', 'lemon', 'tonic'],
    equipmentKeywords: ['fountain', 'dispenser', 'ice'],
    servicePlanCategory: 'fountain',
    terms: {
      pricingModel: 'lease_support',
      termMonths: 36,
      targetMarginPct: 35,
      installationTimeline: 'Typical installation is 2-4 weeks after site survey, credit approval, and equipment availability.',
      siteSurveyNextStep: 'Schedule a site survey to confirm utilities, drain access, CO₂ placement, and final install scope for the dining room.',
    },
  },
  {
    key: 'corporate_cafe',
    label: 'Corporate Cafes',
    emoji: '🏢',
    headline: 'Office & corporate cafe program',
    description: 'Grab-and-go cans plus a compact BIB station for an amenity-driven workplace. Flexible term for facilities budgets.',
    businessType: 'Cafe',
    productCategories: ['can', 'tea', 'juice', 'lemonade', 'co2'],
    productKeywords: ['sparkling', 'craft soda', 'cold brew', 'seltzer'],
    equipmentKeywords: ['cooler', 'dispenser', 'countertop'],
    servicePlanCategory: 'fountain',
    terms: {
      pricingModel: 'lease_support',
      termMonths: 24,
      targetMarginPct: 40,
      installationTimeline: 'Most workplace cafes are live within 2-3 weeks after a quick site survey and building access confirmation.',
      siteSurveyNextStep: 'Confirm pantry/cafe footprint, power, water line access, and delivery/loading logistics with facilities.',
    },
  },
  {
    key: 'bar',
    label: 'Bars',
    emoji: '🍸',
    headline: 'Bar & cocktail mixer program',
    description: 'Premium mixers — tonic, ginger beer, club soda — plus CO₂ and juices for a high-volume cocktail bar.',
    businessType: 'Bar',
    productCategories: ['mixer', 'co2', 'juice', 'lemonade'],
    productKeywords: ['tonic', 'ginger beer', 'club soda', 'soda water', 'bitters', 'cranberry'],
    equipmentKeywords: ['gun', 'dispenser', 'soda', 'rail'],
    servicePlanCategory: 'fountain',
    terms: {
      pricingModel: 'lease_support',
      termMonths: 36,
      targetMarginPct: 38,
      installationTimeline: 'Bar installs are scheduled for 2-4 weeks out, typically during off-hours to avoid service disruption.',
      siteSurveyNextStep: 'Walk the bar rail and back-of-house to confirm gun placement, CO₂ storage, and drain/water access.',
    },
  },
  {
    key: 'fast_casual',
    label: 'Fast Casual',
    emoji: '🥤',
    headline: 'Fast casual high-volume program',
    description: 'High-throughput fountain BIB plus self-serve cans for a quick-service counter. Priced for volume.',
    businessType: 'Restaurant',
    productCategories: ['bib', 'can', 'co2', 'lemonade', 'tea'],
    productKeywords: ['cola', 'lemonade', 'fruit punch', 'energy', 'orange'],
    equipmentKeywords: ['fountain', 'self serve', 'ice', 'dispenser'],
    servicePlanCategory: 'fountain',
    terms: {
      pricingModel: 'lease_support',
      termMonths: 36,
      targetMarginPct: 33,
      installationTimeline: 'Counter-service installs run 2-3 weeks after site survey; we stage equipment to minimize downtime.',
      siteSurveyNextStep: 'Confirm self-serve vs. crew-serve dispense, ice needs, CO₂ placement, and peak-volume throughput.',
    },
  },
  {
    key: 'grocery',
    label: 'Grocery',
    emoji: '🛒',
    headline: 'Grocery & retail case program',
    description: 'Retail cans and cases delivered direct-store. Month-to-month with no long-term equipment commitment.',
    businessType: 'Retail',
    productCategories: ['can', 'tea', 'juice', 'lemonade'],
    productKeywords: ['24 pack', 'case', 'craft soda', 'sparkling', 'sugar free'],
    equipmentKeywords: ['cooler', 'rack', 'display', 'shelf'],
    servicePlanCategory: 'retail',
    terms: {
      pricingModel: 'month_to_month',
      termMonths: 12,
      targetMarginPct: 25,
      installationTimeline: 'Retail case programs start on the next delivery cycle once the account and ordering cadence are set.',
      siteSurveyNextStep: 'Confirm shelf/cooler placement, delivery windows, and receiving requirements with the store.',
    },
  },
];

const TEMPLATE_STOPWORDS = new Set(['the', 'and', 'with', 'for', 'pack', 'gal', 'bib']);

function templateTokens(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !TEMPLATE_STOPWORDS.has(word));
}

/**
 * Rank the loaded product catalog against a template and return the ids of the
 * best matches, so picking a template can pre-select a sensible starting lineup.
 */
export function selectTemplateProducts(
  template: ProposalTemplate,
  products: ProposalProduct[],
  limit = 8,
): string[] {
  const categoryRank = new Map(template.productCategories.map((category, index) => [category, template.productCategories.length - index]));
  const keywords = template.productKeywords.map((word) => word.toLowerCase());
  const scored = products
    .filter((product) => product.active !== false)
    .map((product) => {
      let score = 0;
      const categoryScore = categoryRank.get(product.category);
      if (categoryScore) score += categoryScore * 4;
      const haystack = `${product.name} ${product.description || ''} ${product.category}`.toLowerCase();
      for (const keyword of keywords) {
        if (haystack.includes(keyword)) score += 3;
      }
      const productWords = new Set(templateTokens(haystack));
      for (const keyword of keywords) {
        for (const word of templateTokens(keyword)) {
          if (productWords.has(word)) score += 1;
        }
      }
      // Nudge products that actually carry imagery so the deck looks complete.
      if (product.imageUrl || (product.imageUrls && product.imageUrls.length)) score += 1;
      return { product, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name));
  return scored.slice(0, limit).map((entry) => entry.product.id);
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
