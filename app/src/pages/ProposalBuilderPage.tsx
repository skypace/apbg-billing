import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Alert, Autocomplete, Box, Button, Checkbox, Chip, CircularProgress, Divider, FormControl,
  FormControlLabel, IconButton, InputLabel, MenuItem, Paper, Select, Snackbar, Stack, Table, TableBody,
  TableCell, TableHead, TableRow, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import {
  Calculator, Check, Clipboard, Copy, ExternalLink, FileText, FolderOpen, LayoutTemplate, Mail,
  Images, PackagePlus, Paperclip, Plus, Presentation, RefreshCw, Save, Send, Sparkles, Share2, Trash2, Upload,
} from 'lucide-react';
import {
  type BrandAsset,
  type BrandAssetType,
  type DamBrandOption,
  type DamCollectionOption,
  BRAND_ASSET_TYPES,
  type EndOfLeaseOption,
  type EquipmentCatalogItem,
  type EquipmentQuoteResponse,
  type PricingCalculateResponse,
  type ProposalCustomer,
  type ProposalEquipment,
  type ProposalProduct,
  type ProposalTemplate,
  type ProposalTerms,
  type SavedProposalSummary,
  PROPOSAL_TEMPLATES,
  calculateEquipmentPricing,
  catalogItemToProposalEquipment,
  createEquipmentQuote,
  currency,
  defaultProposalTerms,
  deleteBrandAsset,
  equipmentToPricingLines,
  fileToBase64,
  selectTemplateProducts,
  uploadBrandAsset,
  generateAiProposal,
  generateGammaProposal,
  getSavedProposal,
  getBrandAssets,
  getBrandLibrary,
  getBrixProducts,
  getEndOfLeaseOptions,
  getEquipmentCatalog,
  getServicePlans,
  listSavedProposals,
  saveProposal,
  type ServicePlan,
} from '../lib/proposalBuilder';

type LoadState = 'idle' | 'loading' | 'ready';
type BusyState = 'none' | 'pricing' | 'quote' | 'email' | 'gamma' | 'save' | 'share' | 'load';

// What the operator chose to include for a selected product: which image, and
// whether the spec sheet + price ride along into the proposal.
interface ProductChoice {
  imageUrl?: string;
  includeSpec?: boolean;
  includePrice?: boolean;
}

function applyProductChoice(product: ProposalProduct, choice?: ProductChoice): ProposalProduct {
  const includeSpec = choice?.includeSpec !== false;
  const includePrice = choice?.includePrice !== false;
  const chosenImage = choice?.imageUrl
    || product.imageUrl
    || (product.imageUrls && product.imageUrls[0])
    || undefined;
  return {
    ...product,
    imageUrl: chosenImage,
    imageUrls: chosenImage ? [chosenImage] : product.imageUrls,
    specSheetUrl: includeSpec ? product.specSheetUrl : undefined,
    price: includePrice ? product.price : undefined,
  };
}

const businessTypes = [
  'Restaurant',
  'Cafe',
  'Bar',
  'Hotel',
  'Campus',
  'Catering',
  'Retail',
  'Other',
];

const numberFieldSx = {
  width: 112,
  '& input': { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
};

const cardSx = {
  p: { xs: 2, md: 2.5 },
  borderRadius: 2,
};

const blankCustomer: ProposalCustomer = {
  name: '',
  contactName: '',
  email: '',
  phone: '',
  businessType: 'Restaurant',
  location: '',
  leasingCustomerId: '',
  leasingCustomerLocationId: '',
};

export function ProposalBuilderPage() {
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [busy, setBusy] = useState<BusyState>('none');
  const [errors, setErrors] = useState<string[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  const [customer, setCustomer] = useState<ProposalCustomer>(blankCustomer);
  const [terms, setTerms] = useState<ProposalTerms>(() => defaultProposalTerms());
  const [activeTemplate, setActiveTemplate] = useState<string | null>(null);

  const [products, setProducts] = useState<ProposalProduct[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [beverageFilter, setBeverageFilter] = useState<'all' | 'fountain' | 'packaged'>('all');
  const [catalog, setCatalog] = useState<EquipmentCatalogItem[]>([]);
  const [equipmentSearch, setEquipmentSearch] = useState('');
  const [selectedEquipment, setSelectedEquipment] = useState<ProposalEquipment[]>([]);
  const [servicePlans, setServicePlans] = useState<ServicePlan[]>([]);
  const [endOfLeaseOptions, setEndOfLeaseOptions] = useState<EndOfLeaseOption[]>([]);
  const [brandAssets, setBrandAssets] = useState<BrandAsset[]>([]);
  const [brandAssetError, setBrandAssetError] = useState<string | null>(null);
  const [assetBusy, setAssetBusy] = useState(false);
  const [brandOptions, setBrandOptions] = useState<DamBrandOption[]>([]);
  const [collectionOptions, setCollectionOptions] = useState<DamCollectionOption[]>([]);
  const [assetBrand, setAssetBrand] = useState('');
  const [assetCollection, setAssetCollection] = useState('');

  const [pricing, setPricing] = useState<PricingCalculateResponse | null>(null);
  const [quote, setQuote] = useState<EquipmentQuoteResponse | null>(null);
  const [generatedEmail, setGeneratedEmail] = useState('');
  const [gammaUrl, setGammaUrl] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [proposalTitle, setProposalTitle] = useState('Custom Beverage Program Proposal');
  const [savedProposals, setSavedProposals] = useState<SavedProposalSummary[]>([]);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [emailSource, setEmailSource] = useState<'ai' | 'template' | null>(null);

  // Per-product include choices (image / spec / price) + hand-picked brand assets.
  const [productChoices, setProductChoices] = useState<Record<string, ProductChoice>>({});
  const [chosenAssetIds, setChosenAssetIds] = useState<string[]>([]);
  const [assetRoles, setAssetRoles] = useState<Record<string, 'embed' | 'attach'>>({});

  async function loadData() {
    setLoadState('loading');
    setErrors([]);
    const nextErrors: string[] = [];
    const [productResult, catalogResult, serviceResult, leaseResult, assetResult, savedResult] = await Promise.allSettled([
      getBrixProducts(),
      getEquipmentCatalog(),
      getServicePlans(),
      getEndOfLeaseOptions(),
      getBrandLibrary(),
      listSavedProposals(),
    ]);

    if (catalogResult.status === 'fulfilled') setCatalog(catalogResult.value.filter((item) => item.active !== false));
    else nextErrors.push(`Equipment: ${messageFrom(catalogResult.reason)}`);

    const loadedAssets = assetResult.status === 'fulfilled' ? assetResult.value.assets : [];
    if (assetResult.status === 'fulfilled') {
      setBrandAssets(loadedAssets);
      setBrandOptions(assetResult.value.brands || []);
      setCollectionOptions(assetResult.value.collections || []);
      setBrandAssetError(null);
    } else {
      setBrandAssets([]);
      setBrandAssetError(messageFrom(assetResult.reason));
    }

    if (productResult.status === 'fulfilled') setProducts(withProductImages(productResult.value, loadedAssets));
    else nextErrors.push(`Products: ${messageFrom(productResult.reason)}`);

    if (serviceResult.status === 'fulfilled') {
      setServicePlans(serviceResult.value);
      setTerms((current) => ({
        ...current,
        servicePlanKeys: current.servicePlanKeys.length
          ? current.servicePlanKeys
          : serviceResult.value.filter((plan) => plan.category === 'fountain').slice(0, 1).map((plan) => plan.key),
      }));
    } else {
      nextErrors.push(`Service plans: ${messageFrom(serviceResult.reason)}`);
    }

    if (leaseResult.status === 'fulfilled') {
      setEndOfLeaseOptions(leaseResult.value);
      setTerms((current) => ({
        ...current,
        endOfLeaseOptionKeys: current.endOfLeaseOptionKeys.length
          ? current.endOfLeaseOptionKeys
          : leaseResult.value.filter((option) => option.key === 'month_to_month_with_service').map((option) => option.key),
      }));
    } else {
      nextErrors.push(`End-of-lease: ${messageFrom(leaseResult.reason)}`);
    }

    if (savedResult.status === 'fulfilled') setSavedProposals(savedResult.value);
    else nextErrors.push(`Saved proposals: ${messageFrom(savedResult.reason)}`);

    setErrors(nextErrors);
    setLoadState('ready');
  }

  useEffect(() => {
    void loadData();
  }, []);

  const selectedProducts = useMemo(
    () => products.filter((product) => selectedProductIds.includes(product.id)),
    [products, selectedProductIds],
  );

  // Selected products with the operator's include choices (image/spec/price) baked in.
  const proposalProducts = useMemo(
    () => selectedProducts.map((product) => applyProductChoice(product, productChoices[product.id])),
    [selectedProducts, productChoices],
  );

  const filteredProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    let rows = beverageFilter === 'all' ? products : products.filter((p) => p.beverageClass === beverageFilter);
    if (q) {
      rows = rows.filter((product) =>
        [
          product.name,
          product.category,
          product.description || '',
          product.sku || '',
          product.manufacturer || '',
          product.model || '',
          product.packageSize || '',
        ].join(' ').toLowerCase().includes(q),
      );
    }
    return rows.slice(0, 80);
  }, [productSearch, products, beverageFilter]);

  // Re-scope the brand library when the operator picks a brand/collection.
  useEffect(() => {
    if (loadState !== 'ready') return;
    let live = true;
    getBrandAssets({ brand: assetBrand || undefined, collection: assetCollection || undefined })
      .then((a) => { if (live) { setBrandAssets(a); setBrandAssetError(null); } })
      .catch((e) => { if (live) setBrandAssetError(messageFrom(e)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetBrand, assetCollection]);

  const filteredCatalog = useMemo(() => {
    const q = equipmentSearch.trim().toLowerCase();
    const rows = q
      ? catalog.filter((item) =>
          [item.name, item.sku, item.category, item.vendor || ''].join(' ').toLowerCase().includes(q),
        )
      : catalog;
    return rows.slice(0, 80);
  }, [catalog, equipmentSearch]);

  const selectedServicePlans = useMemo(
    () => servicePlans.filter((plan) => terms.servicePlanKeys.includes(plan.key)),
    [servicePlans, terms.servicePlanKeys],
  );

  const selectedEndOptions = useMemo(
    () => endOfLeaseOptions.filter((option) => terms.endOfLeaseOptionKeys.includes(option.key)),
    [endOfLeaseOptions, terms.endOfLeaseOptionKeys],
  );

  // Hand-picked brand assets win (carrying their embed/attach role); if the
  // operator hasn't chosen any, fall back to the automatic match as before.
  const proposalAssets = useMemo(() => {
    const chosen = brandAssets
      .filter((asset) => chosenAssetIds.includes(asset.id))
      .map((asset) => ({ ...asset, role: assetRoles[asset.id] || 'embed' as const }));
    if (chosen.length) return chosen;
    return selectProposalAssets(brandAssets, proposalProducts, selectedEquipment);
  }, [brandAssets, chosenAssetIds, assetRoles, proposalProducts, selectedEquipment]);

  const proposalData = useMemo(() => ({
    customer,
    products: proposalProducts,
    equipment: selectedEquipment,
    pricing,
    servicePlans,
    endOfLeaseOptions,
    assets: proposalAssets,
    terms,
    quote,
  }), [customer, endOfLeaseOptions, pricing, proposalAssets, quote, selectedEquipment, proposalProducts, servicePlans, terms]);

  const pricingPayload = useMemo(() => ({
    pricing_model: terms.pricingModel,
    term_months: terms.pricingModel === 'lease_support' ? terms.termMonths : null,
    target_margin_pct: terms.targetMarginPct / 100,
    lines: equipmentToPricingLines(selectedEquipment),
  }), [selectedEquipment, terms.pricingModel, terms.targetMarginPct, terms.termMonths]);

  function patchCustomer<K extends keyof ProposalCustomer>(field: K, value: ProposalCustomer[K]) {
    setCustomer((current) => ({ ...current, [field]: value }));
  }

  function patchTerms<K extends keyof ProposalTerms>(field: K, value: ProposalTerms[K]) {
    setTerms((current) => ({ ...current, [field]: value }));
  }

  function applyTemplate(template: ProposalTemplate) {
    setActiveTemplate(template.key);
    setCustomer((current) => ({ ...current, businessType: template.businessType }));
    setTerms((current) => ({
      ...current,
      pricingModel: template.terms.pricingModel,
      termMonths: template.terms.termMonths,
      targetMarginPct: template.terms.targetMarginPct,
      installationTimeline: template.terms.installationTimeline,
      siteSurveyNextStep: template.terms.siteSurveyNextStep,
      servicePlanKeys: (() => {
        const match = servicePlans.find((plan) => plan.category === template.servicePlanCategory)
          || servicePlans.find((plan) => plan.category === 'fountain');
        return match ? [match.key] : current.servicePlanKeys;
      })(),
    }));

    const suggestedIds = selectTemplateProducts(template, products);
    setSelectedProductIds((current) => [...new Set([...current, ...suggestedIds])]);
    setEquipmentSearch(template.equipmentKeywords[0] || '');
    setPricing(null);
    setQuote(null);

    const suggestionNote = suggestedIds.length
      ? ` — added ${suggestedIds.length} suggested product${suggestedIds.length === 1 ? '' : 's'}`
      : '';
    setToast(`${template.label} template applied${suggestionNote}.`);
  }

  async function reloadBrandAssets() {
    try {
      const assets = await getBrandAssets({ brand: assetBrand || undefined, collection: assetCollection || undefined });
      setBrandAssets(assets);
      setBrandAssetError(null);
    } catch (e) {
      setBrandAssetError(messageFrom(e));
    }
  }

  async function handleUploadAssets(files: FileList | null, type: BrandAssetType) {
    if (!files || !files.length) return;
    setAssetBusy(true);
    let uploaded = 0;
    try {
      for (const file of Array.from(files)) {
        const dataBase64 = await fileToBase64(file);
        await uploadBrandAsset({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          dataBase64,
          type,
        });
        uploaded += 1;
      }
      await reloadBrandAssets();
      setToast(`Uploaded ${uploaded} asset${uploaded === 1 ? '' : 's'} to the brand library.`);
    } catch (e) {
      setToast(messageFrom(e));
      if (uploaded > 0) await reloadBrandAssets();
    } finally {
      setAssetBusy(false);
    }
  }

  async function handleDeleteAsset(asset: BrandAsset) {
    if (!asset.path) return;
    setAssetBusy(true);
    try {
      await deleteBrandAsset(asset.path);
      setBrandAssets((current) => current.filter((item) => item.id !== asset.id));
      setToast('Asset removed from the brand library.');
    } catch (e) {
      setToast(messageFrom(e));
    } finally {
      setAssetBusy(false);
    }
  }

  function toggleProduct(product: ProposalProduct) {
    setSelectedProductIds((current) =>
      current.includes(product.id)
        ? current.filter((id) => id !== product.id)
        : [...current, product.id],
    );
  }

  function patchProductChoice(id: string, patch: Partial<ProductChoice>) {
    setProductChoices((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  }

  function toggleAssetChoice(asset: BrandAsset) {
    setChosenAssetIds((current) =>
      current.includes(asset.id) ? current.filter((id) => id !== asset.id) : [...current, asset.id],
    );
  }

  function setAssetRole(id: string, role: 'embed' | 'attach') {
    setAssetRoles((current) => ({ ...current, [id]: role }));
  }

  function addEquipment(item: EquipmentCatalogItem) {
    setSelectedEquipment((current) => {
      const existing = current.find((row) => row.catalogItemId === item.id);
      if (existing) {
        return current.map((row) => row.catalogItemId === item.id ? { ...row, quantity: row.quantity + 1 } : row);
      }
      return [...current, catalogItemToProposalEquipment(item)];
    });
    setPricing(null);
    setQuote(null);
  }

  function patchEquipment(index: number, patch: Partial<ProposalEquipment>) {
    setSelectedEquipment((current) => current.map((row, i) => i === index ? { ...row, ...patch } : row));
    setPricing(null);
    setQuote(null);
  }

  function removeEquipment(index: number) {
    setSelectedEquipment((current) => current.filter((_, i) => i !== index));
    setPricing(null);
    setQuote(null);
  }

  async function calculatePricing() {
    if (!selectedEquipment.length) {
      setToast('Add equipment before calculating.');
      return;
    }
    setBusy('pricing');
    try {
      const result = await calculateEquipmentPricing(pricingPayload);
      setPricing(result);
      setToast('Pricing calculated.');
    } catch (e) {
      setToast(messageFrom(e));
    } finally {
      setBusy('none');
    }
  }

  async function createQuote() {
    if (!customer.leasingCustomerId?.trim()) {
      setToast('Add the leasing customer ID before creating a quote.');
      return;
    }
    if (!selectedEquipment.length) {
      setToast('Add equipment before creating a quote.');
      return;
    }
    setBusy('quote');
    try {
      const result = await createEquipmentQuote({
        customer_id: customer.leasingCustomerId.trim(),
        customer_location_id: customer.leasingCustomerLocationId?.trim() || null,
        pricing_model: terms.pricingModel,
        term_months: terms.pricingModel === 'lease_support' ? terms.termMonths : null,
        target_margin_pct: terms.targetMarginPct / 100,
        notes: buildQuoteNotes(customer, selectedProducts, selectedServicePlans, selectedEndOptions),
        lines: equipmentToPricingLines(selectedEquipment),
      });
      setQuote(result);
      setToast(`Draft quote ${result.quote_number} created.`);
    } catch (e) {
      setToast(messageFrom(e));
    } finally {
      setBusy('none');
    }
  }

  async function createEmail() {
    setBusy('email');
    try {
      const { text, source } = await generateAiProposal(proposalData, 'email');
      setGeneratedEmail(text);
      setEmailSource(source);
      setToast(source === 'ai' ? 'AI drafted the proposal email.' : 'Draft generated from template (AI unavailable).');
    } catch (e) {
      setToast(messageFrom(e));
    } finally {
      setBusy('none');
    }
  }

  async function copyEmail() {
    if (!generatedEmail) return;
    await navigator.clipboard.writeText(generatedEmail);
    setToast('Email copied.');
  }

  async function exportGamma() {
    setBusy('gamma');
    try {
      const result = await generateGammaProposal(proposalData);
      setGammaUrl(result.gammaUrl || null);
      setPdfUrl(result.pdfUrl || null);
      setToast(result.message || (result.status === 'created' ? 'Gamma deck created.' : 'Gamma generation started.'));
    } catch (e) {
      setToast(messageFrom(e));
    } finally {
      setBusy('none');
    }
  }

  async function saveCurrentProposal(shareEnabled = false) {
    setBusy(shareEnabled ? 'share' : 'save');
    try {
      const saved = await saveProposal({
        id: proposalId,
        title: proposalTitle.trim() || customer.name || 'Custom Beverage Program Proposal',
        proposal: proposalData,
        generatedEmail,
        gammaUrl,
        pdfUrl,
        shareEnabled,
      });
      setProposalId(saved.id);
      setProposalTitle(saved.title);
      setShareUrl(saved.shareUrl || null);
      setSavedProposals((current) => upsertSavedSummary(current, saved));
      setToast(shareEnabled ? 'Proposal saved and share link created.' : 'Proposal saved.');
    } catch (e) {
      setToast(messageFrom(e));
    } finally {
      setBusy('none');
    }
  }

  async function loadSavedProposal(id: string) {
    if (!id) return;
    setBusy('load');
    try {
      const saved = await getSavedProposal(id);
      const data = saved.proposal;
      setProposalId(saved.id);
      setProposalTitle(saved.title);
      setShareUrl(saved.shareUrl || null);
      setCustomer(data.customer || blankCustomer);
      setTerms({ ...defaultProposalTerms(), ...(data.terms || {}) });
      setProducts((current) => mergeProducts(current, data.products || []));
      setSelectedProductIds((data.products || []).map((product) => product.id));
      setSelectedEquipment(data.equipment || []);
      setProductChoices(Object.fromEntries((data.products || []).map((product) => [
        product.id,
        {
          imageUrl: product.imageUrl,
          includeSpec: !!product.specSheetUrl,
          includePrice: product.price != null,
        } as ProductChoice,
      ])));
      setChosenAssetIds((data.assets || []).filter((asset) => asset.role).map((asset) => asset.id));
      setAssetRoles(Object.fromEntries((data.assets || []).filter((asset) => asset.role).map((asset) => [asset.id, asset.role!])));
      setPricing(data.pricing || null);
      setQuote(data.quote || null);
      setGeneratedEmail(saved.generatedEmail || '');
      setEmailSource(saved.generatedEmail ? 'ai' : null);
      setGammaUrl(saved.gammaUrl || null);
      setPdfUrl(saved.pdfUrl || null);
      setToast(`Loaded ${saved.title}.`);
    } catch (e) {
      setToast(messageFrom(e));
    } finally {
      setBusy('none');
    }
  }

  async function copyShareLink() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setToast('Share link copied.');
  }

  if (loadState === 'loading' && !products.length && !catalog.length) {
    return (
      <Box sx={{ p: 6, display: 'grid', placeItems: 'center' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1320, mx: 'auto', color: 'text.primary' }}>
      <Stack spacing={2.5}>
        <Header
          pricing={pricing}
          quote={quote}
          loading={loadState === 'loading'}
          onRefresh={loadData}
        />

        {errors.length > 0 && (
          <Alert severity="warning" action={<Button size="small" onClick={loadData}>Retry</Button>}>
            {errors.join(' · ')}
          </Alert>
        )}

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.05fr) minmax(420px, 0.95fr)' }, gap: 2.5 }}>
          <Stack spacing={2.5}>
            <Section title="Start from a Template" icon={<LayoutTemplate size={18} />}>
              <TemplateGallery
                templates={PROPOSAL_TEMPLATES}
                activeKey={activeTemplate}
                onSelect={applyTemplate}
              />
            </Section>

            <Section title="Customer Info" icon={<Clipboard size={18} />}>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
                <TextField label="Customer name" size="small" value={customer.name} onChange={(e) => patchCustomer('name', e.target.value)} />
                <TextField label="Contact" size="small" value={customer.contactName} onChange={(e) => patchCustomer('contactName', e.target.value)} />
                <TextField label="Email" size="small" value={customer.email} onChange={(e) => patchCustomer('email', e.target.value)} />
                <TextField label="Phone" size="small" value={customer.phone} onChange={(e) => patchCustomer('phone', e.target.value)} />
                <FormControl size="small">
                  <InputLabel>Business type</InputLabel>
                  <Select
                    label="Business type"
                    value={customer.businessType}
                    onChange={(e) => patchCustomer('businessType', e.target.value)}
                  >
                    {businessTypes.map((type) => <MenuItem key={type} value={type}>{type}</MenuItem>)}
                  </Select>
                </FormControl>
                <TextField label="Location" size="small" value={customer.location} onChange={(e) => patchCustomer('location', e.target.value)} />
                <TextField label="Leasing customer ID" size="small" value={customer.leasingCustomerId} onChange={(e) => patchCustomer('leasingCustomerId', e.target.value)} />
                <TextField label="Leasing location ID" size="small" value={customer.leasingCustomerLocationId} onChange={(e) => patchCustomer('leasingCustomerLocationId', e.target.value)} />
              </Box>
            </Section>

            <Section title="Product Selection" icon={<Sparkles size={18} />}>
              <Stack spacing={1.5}>
                <Autocomplete
                  multiple
                  size="small"
                  options={products}
                  value={selectedProducts}
                  getOptionLabel={(option) => option.name}
                  isOptionEqualToValue={(a, b) => a.id === b.id}
                  groupBy={(option) => option.category.toUpperCase()}
                  onChange={(_, value) => setSelectedProductIds(value.map((product) => product.id))}
                  renderTags={(value, getTagProps) => value.map((option, index) => (
                    <Chip
                      {...getTagProps({ index })}
                      key={option.id}
                      label={option.price != null ? `${option.name} · ${currency(option.price)}` : option.name}
                      size="small"
                    />
                  ))}
                  renderOption={(props, option) => (
                    <Box component="li" {...props} sx={{ display: 'flex', gap: 1.25, alignItems: 'center' }}>
                      <Thumb src={option.imageUrl} fallbackSrcs={option.imageUrls} alt={option.name} size={52} />
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="body2" fontWeight={700}>{option.name}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {productSubtitle(option)}
                        </Typography>
                        <ProductSpecChips product={option} compact />
                      </Box>
                    </Box>
                  )}
                  renderInput={(params) => <TextField {...params} label="Products and flavors" />}
                />
                <Stack direction="row" spacing={1} alignItems="center">
                  {([['all', 'All beverages'], ['fountain', 'Fountain'], ['packaged', 'Packaged']] as const).map(([key, label]) => (
                    <Chip
                      key={key}
                      label={label}
                      size="small"
                      clickable
                      color={beverageFilter === key ? 'primary' : 'default'}
                      variant={beverageFilter === key ? 'filled' : 'outlined'}
                      onClick={() => setBeverageFilter(key)}
                    />
                  ))}
                </Stack>
                <TextField
                  size="small"
                  label="Search product catalog"
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                />
                <ProductCatalogBrowser
                  products={filteredProducts}
                  selectedIds={selectedProductIds}
                  onToggle={toggleProduct}
                />
                <ProductSummary products={selectedProducts} choices={productChoices} onPatch={patchProductChoice} />
              </Stack>
            </Section>

            <Section title="Brand Library" icon={<Images size={18} />}>
              <Stack direction="row" spacing={1} sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
                <TextField select size="small" label="Brand" value={assetBrand} onChange={(e) => setAssetBrand(e.target.value)} sx={{ minWidth: 150 }}>
                  <MenuItem value="">All brands</MenuItem>
                  {brandOptions.map((b) => <MenuItem key={b.slug} value={b.slug}>{b.label}</MenuItem>)}
                </TextField>
                <TextField select size="small" label="Collection" value={assetCollection} onChange={(e) => setAssetCollection(e.target.value)} sx={{ minWidth: 190 }}>
                  <MenuItem value="">All collections</MenuItem>
                  {collectionOptions.map((c) => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
                </TextField>
                {(assetBrand || assetCollection) && (
                  <Chip label="Clear" size="small" onDelete={() => { setAssetBrand(''); setAssetCollection(''); }} onClick={() => { setAssetBrand(''); setAssetCollection(''); }} />
                )}
              </Stack>
              <BrandAssets
                assets={brandAssets}
                error={brandAssetError}
                loading={loadState === 'loading'}
                busy={assetBusy}
                chosenIds={chosenAssetIds}
                roles={assetRoles}
                onToggleChoose={toggleAssetChoice}
                onSetRole={setAssetRole}
                onRefresh={reloadBrandAssets}
                onUpload={handleUploadAssets}
                onDelete={handleDeleteAsset}
              />
            </Section>

            <Section title="Equipment Selection" icon={<PackagePlus size={18} />}>
              <Stack spacing={1.5}>
                <TextField
                  size="small"
                  label="Search catalog"
                  value={equipmentSearch}
                  onChange={(e) => setEquipmentSearch(e.target.value)}
                />
                <Paper variant="outlined" sx={{ maxHeight: 292, overflow: 'auto', borderRadius: 1 }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        <TableCell>Equipment</TableCell>
                        <TableCell>Category</TableCell>
                        <TableCell align="right">Capital</TableCell>
                        <TableCell align="right">Install</TableCell>
                        <TableCell align="right">Svc/admin</TableCell>
                        <TableCell width={64} />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {filteredCatalog.map((item) => (
                        <TableRow key={item.id} hover>
                          <TableCell>
                            <Stack direction="row" spacing={1.25} alignItems="center">
                              <Thumb src={item.image_url || undefined} alt={item.name} />
                              <Box sx={{ minWidth: 0 }}>
                                <Typography variant="body2" fontWeight={700}>{item.name}</Typography>
                                <Typography variant="caption" color="text.secondary">{item.sku}{item.vendor ? ` · ${item.vendor}` : ''}</Typography>
                              </Box>
                            </Stack>
                          </TableCell>
                          <TableCell>{item.category}</TableCell>
                          <TableCell align="right">{currency(item.acquisition_cost)}</TableCell>
                          <TableCell align="right">{currency(item.install_cost_default)}</TableCell>
                          <TableCell align="right">{currency(Number(item.monthly_service_cost_default || 0) + Number(item.monthly_admin_fee_default || 0))}</TableCell>
                          <TableCell align="right">
                            <Button size="small" variant="outlined" onClick={() => addEquipment(item)}>Add</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                      {filteredCatalog.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={6}>
                            <Typography color="text.secondary" align="center" sx={{ py: 2 }}>No catalog matches.</Typography>
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </Paper>

                <SelectedEquipmentTable
                  equipment={selectedEquipment}
                  onPatch={patchEquipment}
                  onRemove={removeEquipment}
                />
              </Stack>
            </Section>

            <Section title="Leasing / Pricing" icon={<Calculator size={18} />}>
              <Stack spacing={1.5}>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 1fr' }, gap: 1.5 }}>
                  <FormControl size="small">
                    <InputLabel>Pricing model</InputLabel>
                    <Select
                      label="Pricing model"
                      value={terms.pricingModel}
                      onChange={(e) => patchTerms('pricingModel', e.target.value as ProposalTerms['pricingModel'])}
                    >
                      <MenuItem value="lease_support">Lease support</MenuItem>
                      <MenuItem value="month_to_month">Month-to-month</MenuItem>
                    </Select>
                  </FormControl>
                  <TextField
                    label="Term months"
                    size="small"
                    type="number"
                    value={terms.termMonths}
                    onChange={(e) => patchTerms('termMonths', numeric(e.target.value, 1))}
                    disabled={terms.pricingModel !== 'lease_support'}
                  />
                  <TextField
                    label="Target margin %"
                    size="small"
                    type="number"
                    value={terms.targetMarginPct}
                    onChange={(e) => patchTerms('targetMarginPct', numeric(e.target.value, 0))}
                  />
                </Box>

                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.5 }}>
                  <Autocomplete
                    multiple
                    size="small"
                    options={servicePlans}
                    value={selectedServicePlans}
                    getOptionLabel={(option) => option.label}
                    isOptionEqualToValue={(a, b) => a.key === b.key}
                    onChange={(_, value) => patchTerms('servicePlanKeys', value.map((plan) => plan.key))}
                    renderInput={(params) => <TextField {...params} label="Service/support" />}
                  />
                  <Autocomplete
                    multiple
                    size="small"
                    options={endOfLeaseOptions}
                    value={selectedEndOptions}
                    getOptionLabel={(option) => option.label}
                    isOptionEqualToValue={(a, b) => a.key === b.key}
                    onChange={(_, value) => patchTerms('endOfLeaseOptionKeys', value.map((option) => option.key))}
                    renderInput={(params) => <TextField {...params} label="End-of-lease" />}
                  />
                </Box>

                <TextField
                  label="Installation timeline"
                  size="small"
                  multiline
                  minRows={2}
                  value={terms.installationTimeline}
                  onChange={(e) => patchTerms('installationTimeline', e.target.value)}
                />
                <TextField
                  label="Site survey next step"
                  size="small"
                  multiline
                  minRows={2}
                  value={terms.siteSurveyNextStep}
                  onChange={(e) => patchTerms('siteSurveyNextStep', e.target.value)}
                />
                <TextField
                  label="Account application link"
                  size="small"
                  value={terms.accountApplicationUrl}
                  onChange={(e) => patchTerms('accountApplicationUrl', e.target.value)}
                />

                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                  <Button
                    variant="contained"
                    startIcon={busy === 'pricing' ? <CircularProgress size={16} /> : <Calculator size={16} />}
                    disabled={busy !== 'none'}
                    onClick={calculatePricing}
                  >
                    Calculate
                  </Button>
                  <Button
                    variant="outlined"
                    startIcon={busy === 'quote' ? <CircularProgress size={16} /> : <FileText size={16} />}
                    disabled={busy !== 'none'}
                    onClick={createQuote}
                  >
                    Create Draft Quote
                  </Button>
                  <PricingSummary pricing={pricing} />
                </Stack>
              </Stack>
            </Section>
          </Stack>

          <Stack spacing={2.5}>
            <Section title="Save & Share" icon={<Save size={18} />}>
              <Stack spacing={1.5}>
                <TextField
                  label="Proposal title"
                  size="small"
                  value={proposalTitle}
                  onChange={(e) => setProposalTitle(e.target.value)}
                />
                <FormControl size="small">
                  <InputLabel>Recent proposals</InputLabel>
                  <Select
                    label="Recent proposals"
                    value={proposalId || ''}
                    onChange={(e) => void loadSavedProposal(e.target.value)}
                    disabled={busy !== 'none' || savedProposals.length === 0}
                  >
                    {savedProposals.map((proposal) => (
                      <MenuItem key={proposal.id} value={proposal.id}>
                        {proposal.title} · {proposal.customerName || 'No customer'}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  <Button
                    variant="contained"
                    startIcon={busy === 'save' ? <CircularProgress size={16} /> : <Save size={16} />}
                    disabled={busy !== 'none'}
                    onClick={() => void saveCurrentProposal(false)}
                  >
                    Save Draft
                  </Button>
                  <Button
                    variant="outlined"
                    startIcon={busy === 'share' ? <CircularProgress size={16} /> : <Share2 size={16} />}
                    disabled={busy !== 'none'}
                    onClick={() => void saveCurrentProposal(true)}
                  >
                    Save & Share
                  </Button>
                  <Tooltip title="Load selected proposal">
                    <span>
                      <IconButton disabled={busy !== 'none' || !proposalId} onClick={() => proposalId && void loadSavedProposal(proposalId)}>
                        <FolderOpen size={18} />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Stack>
                {shareUrl && (
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                    <TextField size="small" value={shareUrl} fullWidth slotProps={{ input: { readOnly: true } }} />
                    <Tooltip title="Copy share link">
                      <IconButton onClick={copyShareLink}>
                        <Copy size={18} />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Open shared proposal">
                      <IconButton component="a" href={shareUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink size={18} />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                )}
              </Stack>
            </Section>

            <Section title="Proposal Preview" icon={<Presentation size={18} />}>
              <ProposalPreview
                customer={customer}
                products={proposalProducts}
                equipment={selectedEquipment}
                pricing={pricing}
                servicePlans={selectedServicePlans}
                endOfLeaseOptions={selectedEndOptions}
                terms={terms}
                quote={quote}
                assets={proposalAssets}
              />
            </Section>

            <Section title="AI Proposal Email" icon={<Mail size={18} />}>
              <Stack spacing={1.5}>
                <Typography variant="body2" color="text.secondary">
                  Claude drafts the first-level proposal from your selected products, equipment, pricing, and attached brand assets. Edit it inline, or export a polished deck with Gamma below if you want more.
                </Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Button
                    variant="contained"
                    startIcon={busy === 'email' ? <CircularProgress size={16} /> : <Sparkles size={16} />}
                    disabled={busy !== 'none'}
                    onClick={createEmail}
                  >
                    {generatedEmail ? 'Regenerate with AI' : 'Generate with AI'}
                  </Button>
                  <Tooltip title="Copy email">
                    <span>
                      <IconButton disabled={!generatedEmail} onClick={copyEmail}>
                        <Copy size={18} />
                      </IconButton>
                    </span>
                  </Tooltip>
                  {emailSource === 'ai' && <Chip size="small" color="primary" variant="outlined" icon={<Sparkles size={13} />} label="AI draft" />}
                  {emailSource === 'template' && <Chip size="small" variant="outlined" icon={<Send size={13} />} label="Template draft" />}
                </Stack>
                <TextField
                  multiline
                  minRows={10}
                  value={generatedEmail}
                  onChange={(e) => setGeneratedEmail(e.target.value)}
                  placeholder="Generated follow-up email"
                />
              </Stack>
            </Section>

            <Section title="Export to Gamma" icon={<Sparkles size={18} />}>
              <Stack spacing={1.5}>
                <Typography variant="body2" color="text.secondary">
                  Gamma uses the selected products, equipment, pricing, and the brand-library assets matched in the proposal preview.
                </Typography>
                <Button
                  variant="contained"
                  startIcon={busy === 'gamma' ? <CircularProgress size={16} /> : <Presentation size={16} />}
                  disabled={busy !== 'none'}
                  onClick={exportGamma}
                >
                  Generate Gamma Deck
                </Button>
                {(gammaUrl || pdfUrl) && (
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    {gammaUrl && <Button size="small" href={gammaUrl} target="_blank" rel="noopener noreferrer">Open Gamma</Button>}
                    {pdfUrl && <Button size="small" href={pdfUrl} target="_blank" rel="noopener noreferrer">Open PDF</Button>}
                  </Stack>
                )}
              </Stack>
            </Section>
          </Stack>
        </Box>
      </Stack>
      <Snackbar open={!!toast} autoHideDuration={3600} onClose={() => setToast(null)} message={toast || ''} />
    </Box>
  );
}

function Header({ pricing, quote, loading, onRefresh }: {
  pricing: PricingCalculateResponse | null;
  quote: EquipmentQuoteResponse | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <Box className="hero" sx={{ mb: 0 }}>
      <Box>
        <div className="hero-eyebrow">Internal Sales</div>
        <Typography className="hero-title" component="h1">Proposal Builder</Typography>
        <div className="hero-meta">Alameda Craft Soda · BRIX Beverage</div>
      </Box>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" justifyContent="flex-end" useFlexGap>
        {pricing && <Chip icon={<Calculator size={14} />} label={`${currency(pricing.total_monthly_price)} / mo`} color="primary" variant="outlined" />}
        {quote && <Chip icon={<Check size={14} />} label={quote.quote_number} color="success" variant="outlined" />}
        <Tooltip title="Refresh source data">
          <span>
            <IconButton onClick={onRefresh} disabled={loading}>
              {loading ? <CircularProgress size={18} /> : <RefreshCw size={18} />}
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
    </Box>
  );
}

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Paper variant="outlined" sx={cardSx}>
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Box sx={{ color: 'primary.main', display: 'grid', placeItems: 'center' }}>{icon}</Box>
          <Typography variant="subtitle1" fontWeight={800}>{title}</Typography>
        </Stack>
        {children}
      </Stack>
    </Paper>
  );
}

function TemplateGallery({ templates, activeKey, onSelect }: {
  templates: ProposalTemplate[];
  activeKey: string | null;
  onSelect: (template: ProposalTemplate) => void;
}) {
  return (
    <Stack spacing={1.25}>
      <Typography variant="body2" color="text.secondary">
        Pick a venue type to pre-fill the business type, lease terms, service plan, and a suggested beverage lineup. You can adjust everything after.
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 1.25 }}>
        {templates.map((template) => {
          const selected = template.key === activeKey;
          return (
            <Paper
              key={template.key}
              variant="outlined"
              onClick={() => onSelect(template)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(template);
                }
              }}
              sx={{
                p: 1.5,
                borderRadius: 2,
                cursor: 'pointer',
                height: '100%',
                borderColor: selected ? 'primary.main' : 'divider',
                borderWidth: selected ? 2 : 1,
                bgcolor: selected ? 'action.selected' : 'background.paper',
                transition: 'border-color 120ms ease, background-color 120ms ease',
                '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
              }}
            >
              <Stack spacing={0.75}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Box component="span" sx={{ fontSize: 22, lineHeight: 1 }}>{template.emoji}</Box>
                  <Typography variant="subtitle2" fontWeight={800}>{template.label}</Typography>
                  {selected && <Check size={16} />}
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  {template.description}
                </Typography>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.25 }}>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={template.terms.pricingModel === 'lease_support' ? `${template.terms.termMonths}mo lease` : 'Month-to-month'}
                  />
                  <Chip size="small" variant="outlined" label={`${template.terms.targetMarginPct}% margin`} />
                </Stack>
              </Stack>
            </Paper>
          );
        })}
      </Box>
    </Stack>
  );
}

function Thumb({ src, fallbackSrcs = [], alt, size = 44 }: {
  src?: string | null;
  fallbackSrcs?: Array<string | null | undefined>;
  alt: string;
  size?: number;
}) {
  const sources = useMemo(
    () => [...new Set([src, ...fallbackSrcs].filter(Boolean) as string[])],
    [fallbackSrcs, src],
  );
  const [failedSrcs, setFailedSrcs] = useState<string[]>([]);
  useEffect(() => {
    setFailedSrcs([]);
  }, [sources.join('|')]);
  const activeSrc = sources.find((source) => !failedSrcs.includes(source)) || null;
  return (
    <Box
      sx={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        borderRadius: 1,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'action.hover',
        display: 'grid',
        placeItems: 'center',
        overflow: 'hidden',
      }}
    >
      {activeSrc
        ? (
          <Box
            component="img"
            src={activeSrc}
            alt={alt}
            onError={() => setFailedSrcs((current) => current.includes(activeSrc) ? current : [...current, activeSrc])}
            sx={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        )
        : <PackagePlus size={18} color="currentColor" />}
    </Box>
  );
}

function ProductCatalogBrowser({ products, selectedIds, onToggle }: {
  products: ProposalProduct[];
  selectedIds: string[];
  onToggle: (product: ProposalProduct) => void;
}) {
  if (!products.length) {
    return (
      <Typography color="text.secondary" align="center" sx={{ py: 2 }}>
        No product catalog matches.
      </Typography>
    );
  }
  return (
    <Paper variant="outlined" sx={{ maxHeight: 326, overflow: 'auto', borderRadius: 1 }}>
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            <TableCell>Product</TableCell>
            <TableCell>Specs</TableCell>
            <TableCell align="right">Price</TableCell>
            <TableCell width={88} />
          </TableRow>
        </TableHead>
        <TableBody>
          {products.map((product) => {
            const selected = selectedIds.includes(product.id);
            return (
              <TableRow key={product.id} hover selected={selected}>
                <TableCell sx={{ minWidth: 260 }}>
                  <Stack direction="row" spacing={1.25} alignItems="center">
                    <Thumb src={product.imageUrl} fallbackSrcs={product.imageUrls} alt={product.name} size={58} />
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" fontWeight={700}>{product.name}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {product.category.toUpperCase()}{product.source === 'brix-order' ? ' · Order catalog' : ''}
                      </Typography>
                      {product.description && product.description !== product.name && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            maxWidth: 360,
                          }}
                        >
                          {product.description}
                        </Typography>
                      )}
                    </Box>
                  </Stack>
                </TableCell>
                <TableCell sx={{ minWidth: 180 }}>
                  <ProductSpecChips product={product} />
                </TableCell>
                <TableCell align="right">{product.price != null ? currency(product.price) : '-'}</TableCell>
                <TableCell align="right">
                  <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                    {product.specSheetUrl && (
                      <Tooltip title="Open spec sheet">
                        <IconButton size="small" component="a" href={product.specSheetUrl} target="_blank" rel="noopener noreferrer">
                          <FileText size={15} />
                        </IconButton>
                      </Tooltip>
                    )}
                    <Button
                      size="small"
                      variant={selected ? 'contained' : 'outlined'}
                      startIcon={selected ? <Check size={14} /> : undefined}
                      onClick={() => onToggle(product)}
                    >
                      {selected ? 'Added' : 'Add'}
                    </Button>
                  </Stack>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Paper>
  );
}

function ProductSummary({ products, choices, onPatch }: {
  products: ProposalProduct[];
  choices: Record<string, ProductChoice>;
  onPatch: (id: string, patch: Partial<ProductChoice>) => void;
}) {
  if (!products.length) return <Typography variant="body2" color="text.secondary">No products selected.</Typography>;
  const grouped = products.reduce<Record<string, number>>((acc, product) => {
    acc[product.category] = (acc[product.category] || 0) + 1;
    return acc;
  }, {});
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
        {Object.entries(grouped).map(([category, count]) => (
          <Chip key={category} size="small" variant="outlined" label={`${category.toUpperCase()} · ${count}`} />
        ))}
        <Typography variant="caption" color="text.secondary">Pick the image, spec sheet, and price that go into the proposal.</Typography>
      </Stack>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 1 }}>
        {products.slice(0, 12).map((product) => {
          const choice = choices[product.id] || {};
          const images = [...new Set([product.imageUrl, ...(product.imageUrls || [])].filter(Boolean) as string[])];
          const chosenImage = choice.imageUrl || images[0];
          const includeSpec = choice.includeSpec !== false;
          const includePrice = choice.includePrice !== false;
          return (
            <Paper key={product.id} variant="outlined" sx={{ p: 1.25, borderRadius: 1 }}>
              <Stack direction="row" spacing={1.25} alignItems="flex-start">
                <Thumb src={chosenImage} fallbackSrcs={images} alt={product.name} size={68} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="body2" fontWeight={700} noWrap title={product.name}>{product.name}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {productSubtitle(product)}
                  </Typography>
                  <ProductSpecChips product={product} />
                </Box>
              </Stack>

              {images.length > 1 && (
                <Box sx={{ mt: 1 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>Image</Typography>
                  <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                    {images.map((src) => {
                      const active = src === chosenImage;
                      return (
                        <Box
                          key={src}
                          component="button"
                          type="button"
                          onClick={() => onPatch(product.id, { imageUrl: src })}
                          aria-label={active ? 'Selected image' : 'Use this image'}
                          sx={{
                            p: 0, cursor: 'pointer', borderRadius: 1, overflow: 'hidden', bgcolor: 'action.hover',
                            width: 40, height: 40, display: 'grid', placeItems: 'center',
                            border: '2px solid', borderColor: active ? 'primary.main' : 'divider',
                          }}
                        >
                          <Box component="img" src={src} alt="" sx={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                        </Box>
                      );
                    })}
                  </Stack>
                </Box>
              )}

              <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 0.75 }}>
                <FormControlLabel
                  control={<Checkbox size="small" checked={includeSpec} disabled={!product.specSheetUrl} onChange={(e) => onPatch(product.id, { includeSpec: e.target.checked })} />}
                  label={
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <Typography variant="caption">Spec sheet</Typography>
                      {product.specSheetUrl && (
                        <IconButton size="small" component="a" href={product.specSheetUrl} target="_blank" rel="noopener noreferrer" sx={{ p: 0.25 }}>
                          <FileText size={13} />
                        </IconButton>
                      )}
                    </Stack>
                  }
                  sx={{ mr: 0 }}
                />
                <FormControlLabel
                  control={<Checkbox size="small" checked={includePrice} disabled={product.price == null} onChange={(e) => onPatch(product.id, { includePrice: e.target.checked })} />}
                  label={<Typography variant="caption">Price {product.price != null ? `(${currency(product.price)})` : '(n/a)'}</Typography>}
                  sx={{ mr: 0 }}
                />
              </Stack>
            </Paper>
          );
        })}
      </Box>
    </Stack>
  );
}

function ProductSpecChips({ product, compact = false }: { product: ProposalProduct; compact?: boolean }) {
  const chips = [
    product.packageSize ? { key: 'package', label: product.packageSize } : null,
    product.sku ? { key: 'sku', label: product.sku } : null,
    product.model ? { key: 'model', label: product.model } : null,
    product.manufacturer ? { key: 'manufacturer', label: product.manufacturer } : null,
    product.weightLbs ? { key: 'weight', label: `${product.weightLbs.toLocaleString()} lb` } : null,
    product.source === 'brix-order' ? { key: 'source', label: 'Order catalog' } : null,
    product.specSheetUrl && compact ? { key: 'spec', label: 'Spec sheet' } : null,
  ].filter(Boolean) as Array<{ key: string; label: string }>;
  if (!chips.length) return null;
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.75 }}>
      {chips.slice(0, compact ? 3 : 5).map((chip) => (
        <Chip key={chip.key} size="small" variant="outlined" label={chip.label} />
      ))}
    </Stack>
  );
}

function productSubtitle(product: ProposalProduct): string {
  return [
    product.category.toUpperCase(),
    product.packageSize,
    product.sku,
    product.model,
    product.price != null ? currency(product.price) : null,
  ].filter(Boolean).join(' · ');
}

function SelectedEquipmentTable({ equipment, onPatch, onRemove }: {
  equipment: ProposalEquipment[];
  onPatch: (index: number, patch: Partial<ProposalEquipment>) => void;
  onRemove: (index: number) => void;
}) {
  if (!equipment.length) {
    return <Typography variant="body2" color="text.secondary">No equipment selected.</Typography>;
  }
  return (
    <Paper variant="outlined" sx={{ overflowX: 'auto', borderRadius: 1 }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Selected equipment</TableCell>
            <TableCell align="right">Qty</TableCell>
            <TableCell align="right">Equipment</TableCell>
            <TableCell align="right">Install</TableCell>
            <TableCell align="right">Removal</TableCell>
            <TableCell align="right">Refurb</TableCell>
            <TableCell align="right">Service</TableCell>
            <TableCell align="right">Admin</TableCell>
            <TableCell width={44} />
          </TableRow>
        </TableHead>
        <TableBody>
          {equipment.map((item, index) => (
            <TableRow key={item.catalogItemId}>
              <TableCell sx={{ minWidth: 220 }}>
                <Stack direction="row" spacing={1.25} alignItems="center">
                  <Thumb src={item.imageUrl} alt={item.name} />
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={700}>{item.name}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {item.category}{item.goingMonthlyRent ? ` · ${currency(item.goingMonthlyRent)} market rent` : ''}
                    </Typography>
                  </Box>
                </Stack>
              </TableCell>
              <TableCell align="right">
                <TextField
                  size="small"
                  type="number"
                  value={item.quantity}
                  sx={numberFieldSx}
                  onChange={(e) => onPatch(index, { quantity: numeric(e.target.value, 1) })}
                />
              </TableCell>
              <TableCell align="right">
                <TextField size="small" type="number" value={item.equipmentCost} sx={numberFieldSx} onChange={(e) => onPatch(index, { equipmentCost: numeric(e.target.value, 0) })} />
              </TableCell>
              <TableCell align="right">
                <TextField size="small" type="number" value={item.installCost} sx={numberFieldSx} onChange={(e) => onPatch(index, { installCost: numeric(e.target.value, 0) })} />
              </TableCell>
              <TableCell align="right">
                <TextField size="small" type="number" value={item.removalCost} sx={numberFieldSx} onChange={(e) => onPatch(index, { removalCost: numeric(e.target.value, 0) })} />
              </TableCell>
              <TableCell align="right">
                <TextField size="small" type="number" value={item.refurbReserve} sx={numberFieldSx} onChange={(e) => onPatch(index, { refurbReserve: numeric(e.target.value, 0) })} />
              </TableCell>
              <TableCell align="right">
                <TextField size="small" type="number" value={item.monthlyServiceCost} sx={numberFieldSx} onChange={(e) => onPatch(index, { monthlyServiceCost: numeric(e.target.value, 0) })} />
              </TableCell>
              <TableCell align="right">
                <TextField size="small" type="number" value={item.monthlyAdminFee} sx={numberFieldSx} onChange={(e) => onPatch(index, { monthlyAdminFee: numeric(e.target.value, 0) })} />
              </TableCell>
              <TableCell align="right">
                <IconButton size="small" onClick={() => onRemove(index)} aria-label={`Remove ${item.name}`}>
                  <Trash2 size={16} />
                </IconButton>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Paper>
  );
}

function PricingSummary({ pricing }: { pricing: PricingCalculateResponse | null }) {
  if (!pricing) return <Typography variant="body2" color="text.secondary">No calculation yet.</Typography>;
  return (
    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
      <Chip size="small" label={`Monthly ${currency(pricing.total_monthly_price)}`} />
      <Chip size="small" label={`Capital ${currency(pricing.total_capital)}`} variant="outlined" />
      <Chip size="small" label={`Cost ${currency(pricing.total_monthly_cost)}`} variant="outlined" />
    </Stack>
  );
}

function ProposalPreview({ customer, products, equipment, pricing, servicePlans, endOfLeaseOptions, terms, quote, assets }: {
  customer: ProposalCustomer;
  products: ProposalProduct[];
  equipment: ProposalEquipment[];
  pricing: PricingCalculateResponse | null;
  servicePlans: ServicePlan[];
  endOfLeaseOptions: EndOfLeaseOption[];
  terms: ProposalTerms;
  quote: EquipmentQuoteResponse | null;
  assets: BrandAsset[];
}) {
  return (
    <Stack spacing={1.5}>
      <PreviewBlock label="Customer" value={customer.name || 'Unnamed customer'} sub={[customer.businessType, customer.location].filter(Boolean).join(' · ')} />
      <Divider />
      <PreviewBlock
        label="Recommended beverage lineup"
        value={products.length ? products.map((product) => product.name).join(', ') : 'No products selected'}
      />
      <PreviewBlock
        label="Recommended equipment package"
        value={equipment.length ? equipment.map((item) => `${item.quantity}x ${item.name}`).join(', ') : 'No equipment selected'}
      />
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
        <PreviewBlock label="Monthly lease/rental estimate" value={pricing ? currency(pricing.total_monthly_price) : 'Pending calculation'} />
        <PreviewBlock label="Internal quote summary" value={quote ? quote.quote_number : 'Draft quote not created'} sub={quote?.status} />
      </Box>
      <PreviewBlock
        label="Service/support summary"
        value={servicePlans.length ? servicePlans.map((plan) => plan.label).join(', ') : 'Standard support'}
      />
      <PreviewBlock label="Installation timeline" value={terms.installationTimeline} />
      <PreviewBlock label="Site survey next step" value={terms.siteSurveyNextStep} />
      <PreviewBlock label="Account application link" value={terms.accountApplicationUrl} />
      <PreviewBlock
        label="End-of-lease options"
        value={endOfLeaseOptions.length ? endOfLeaseOptions.map((option) => option.label).join(', ') : 'Not selected'}
      />
      <PreviewBlock
        label="Brand visuals"
        value={assets.length ? `${assets.length} asset${assets.length === 1 ? '' : 's'} available` : 'No brand-library assets loaded'}
      />
    </Stack>
  );
}

function PreviewBlock({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.8 }}>{label}</Typography>
      <Typography variant="body2" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{value}</Typography>
      {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
    </Box>
  );
}

function BrandAssets({ assets, error, loading, busy, chosenIds, roles, onToggleChoose, onSetRole, onRefresh, onUpload, onDelete }: {
  assets: BrandAsset[];
  error: string | null;
  loading: boolean;
  busy: boolean;
  chosenIds: string[];
  roles: Record<string, 'embed' | 'attach'>;
  onToggleChoose: (asset: BrandAsset) => void;
  onSetRole: (id: string, role: 'embed' | 'attach') => void;
  onRefresh: () => void;
  onUpload: (files: FileList | null, type: BrandAssetType) => void;
  onDelete: (asset: BrandAsset) => void;
}) {
  const [uploadType, setUploadType] = useState<BrandAssetType>('logo');
  const grouped = assets.reduce<Record<string, number>>((acc, asset) => {
    acc[asset.type] = (acc[asset.type] || 0) + 1;
    return acc;
  }, {});
  const storedCount = assets.filter((asset) => asset.source === 'supabase').length;
  const chosenCount = assets.filter((asset) => chosenIds.includes(asset.id)).length;

  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        Your brand library lives in Supabase Storage — upload logos, can art, equipment photos, hero images, and sell sheets here and they flow into the proposal deck. Use <strong>+ Add to proposal</strong> to hand-pick the images that go into the email/deck (as an embedded visual or an attachment). If you pick none, we auto-match by product. The built-in Brix / Alameda logos always show as a fallback.
      </Typography>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
        <FormControl size="small" sx={{ minWidth: 150 }}>
          <InputLabel>Upload as</InputLabel>
          <Select
            label="Upload as"
            value={uploadType}
            onChange={(e) => setUploadType(e.target.value as BrandAssetType)}
          >
            {BRAND_ASSET_TYPES.map((type) => <MenuItem key={type} value={type}>{type}</MenuItem>)}
          </Select>
        </FormControl>
        <Button
          component="label"
          variant="contained"
          startIcon={busy ? <CircularProgress size={16} /> : <Upload size={16} />}
          disabled={busy}
        >
          Upload Assets
          <input
            type="file"
            hidden
            multiple
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml,application/pdf"
            onChange={(e) => { onUpload(e.target.files, uploadType); e.target.value = ''; }}
          />
        </Button>
        <Tooltip title="Refresh brand library">
          <span>
            <IconButton size="small" onClick={onRefresh} disabled={loading || busy}>
              {loading ? <CircularProgress size={16} /> : <RefreshCw size={16} />}
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {error && (
        <Alert severity="warning" action={<Button size="small" onClick={onRefresh} disabled={loading}>Retry</Button>}>
          Brand library: {error}
        </Alert>
      )}

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
        <Chip size="small" label={`${assets.length} asset${assets.length === 1 ? '' : 's'}`} color="primary" variant="outlined" />
        {storedCount > 0 && <Chip size="small" label={`${storedCount} in library`} color="success" variant="outlined" />}
        {chosenCount > 0 && <Chip size="small" color="primary" label={`${chosenCount} in proposal`} icon={<Check size={13} />} />}
        {Object.entries(grouped).map(([type, count]) => (
          <Chip key={type} size="small" label={`${type} · ${count}`} variant="outlined" />
        ))}
      </Stack>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 1 }}>
        {assets.slice(0, 18).map((asset) => {
          const chosen = chosenIds.includes(asset.id);
          const role = roles[asset.id] || 'embed';
          return (
          <Paper key={asset.id} variant="outlined" sx={{ p: 1, borderRadius: 1, borderColor: chosen ? 'primary.main' : 'divider', borderWidth: chosen ? 2 : 1 }}>
            <Stack spacing={1}>
              {asset.thumbnailUrl ? (
                <Box
                  component="img"
                  src={asset.thumbnailUrl}
                  alt={asset.name}
                  sx={{
                    width: '100%',
                    aspectRatio: '4 / 3',
                    borderRadius: 1,
                    bgcolor: 'action.hover',
                    border: '1px solid',
                    borderColor: 'divider',
                    objectFit: 'contain',
                    display: 'block',
                  }}
                />
              ) : (
                <Box
                  sx={{
                    width: '100%',
                    aspectRatio: '4 / 3',
                    borderRadius: 1,
                    bgcolor: 'action.hover',
                    border: '1px solid',
                    borderColor: 'divider',
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  {/\.pdf($|\?)/i.test(asset.url) ? <FileText size={24} color="currentColor" /> : <Images size={24} color="currentColor" />}
                </Box>
              )}
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" fontWeight={700} noWrap title={asset.name}>{asset.name}</Typography>
                <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.5 }}>
                  <Chip size="small" label={asset.type} variant="outlined" />
                  <Box sx={{ flex: 1 }} />
                  <Tooltip title="Open asset">
                    <IconButton size="small" component="a" href={asset.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink size={14} />
                    </IconButton>
                  </Tooltip>
                  {asset.source === 'supabase' && asset.path && (
                    <Tooltip title="Remove from library">
                      <span>
                        <IconButton size="small" disabled={busy} onClick={() => onDelete(asset)} aria-label={`Remove ${asset.name}`}>
                          <Trash2 size={14} />
                        </IconButton>
                      </span>
                    </Tooltip>
                  )}
                </Stack>
                <Button
                  fullWidth
                  size="small"
                  variant={chosen ? 'contained' : 'outlined'}
                  startIcon={chosen ? <Check size={14} /> : <Plus size={14} />}
                  onClick={() => onToggleChoose(asset)}
                  sx={{ mt: 1 }}
                >
                  {chosen ? 'In proposal' : 'Add to proposal'}
                </Button>
                {chosen && (
                  <ToggleButtonGroup
                    size="small"
                    exclusive
                    fullWidth
                    value={role}
                    onChange={(_, next) => next && onSetRole(asset.id, next)}
                    sx={{ mt: 0.75 }}
                  >
                    <ToggleButton value="embed"><Images size={13} style={{ marginRight: 4 }} />Embed</ToggleButton>
                    <ToggleButton value="attach"><Paperclip size={13} style={{ marginRight: 4 }} />Attach</ToggleButton>
                  </ToggleButtonGroup>
                )}
              </Box>
            </Stack>
          </Paper>
          );
        })}
      </Box>
      {assets.length > 18 && (
        <Typography variant="caption" color="text.secondary">
          {assets.length - 18} more asset{assets.length - 18 === 1 ? '' : 's'} in the brand library.
        </Typography>
      )}
    </Stack>
  );
}

function withProductImages(products: ProposalProduct[], assets: BrandAsset[]): ProposalProduct[] {
  return products.map((product) => {
    if (product.imageUrl) return product;
    const asset = findAssetForText(product.name, assets, product.category === 'can' ? 'can' : undefined);
    return asset?.thumbnailUrl || asset?.url ? { ...product, imageUrl: asset.thumbnailUrl || asset.url } : product;
  });
}

function selectProposalAssets(
  assets: BrandAsset[],
  products: ProposalProduct[],
  equipment: ProposalEquipment[],
): BrandAsset[] {
  const selected = new Map<string, BrandAsset>();
  const preferred = assets.filter((asset) => asset.type === 'logo' || asset.type === 'hero').slice(0, 3);
  for (const asset of preferred) selected.set(asset.id, asset);
  for (const product of products) {
    const asset = findAssetForText(product.name, assets, product.category === 'can' ? 'can' : undefined);
    if (asset) selected.set(asset.id, asset);
  }
  for (const item of equipment) {
    const asset = findAssetForText(item.name, assets, 'equipment');
    if (asset) selected.set(asset.id, asset);
  }
  return [...selected.values()].slice(0, 12);
}

function findAssetForText(text: string, assets: BrandAsset[], preferredType?: BrandAsset['type']): BrandAsset | undefined {
  const haystack = tokens(text);
  const candidates = preferredType ? assets.filter((asset) => asset.type === preferredType) : assets;
  let best: { asset: BrandAsset; score: number } | null = null;
  for (const asset of candidates) {
    const words = tokens([asset.name, asset.tags?.join(' '), asset.url].filter(Boolean).join(' '));
    const score = [...haystack].reduce((sum, word) => sum + (words.has(word) ? 1 : 0), 0);
    if (score > (best?.score || 0)) best = { asset, score };
  }
  if (best && best.score > 0) return best.asset;
  return preferredType ? candidates.find((asset) => asset.thumbnailUrl || asset.url) : undefined;
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !['the', 'and', 'with', 'for'].includes(word)),
  );
}

function upsertSavedSummary(current: SavedProposalSummary[], saved: SavedProposalSummary): SavedProposalSummary[] {
  const rest = current.filter((proposal) => proposal.id !== saved.id);
  return [saved, ...rest].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function mergeProducts(current: ProposalProduct[], saved: ProposalProduct[]): ProposalProduct[] {
  const byId = new Map(current.map((product) => [product.id, product]));
  for (const product of saved) {
    byId.set(product.id, { ...product, ...(byId.get(product.id) || {}) });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function buildQuoteNotes(
  customer: ProposalCustomer,
  products: ProposalProduct[],
  servicePlans: ServicePlan[],
  endOptions: EndOfLeaseOption[],
): string {
  const parts = [
    `Proposal Builder draft for ${customer.name || 'customer'}`,
    customer.businessType ? `Business type: ${customer.businessType}` : '',
    products.length ? `Products: ${products.map((p) => p.name).join(', ')}` : '',
    servicePlans.length ? `Service plans: ${servicePlans.map((p) => p.label).join(', ')}` : '',
    endOptions.length ? `End-of-lease: ${endOptions.map((o) => o.label).join(', ')}` : '',
  ].filter(Boolean);
  return parts.join('\n');
}

function numeric(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function messageFrom(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value || 'Unknown error');
  const normalized = raw
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/page not found/i.test(normalized)) return 'Function route returned page not found. Refresh the app and retry.';
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}
