import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Alert, Autocomplete, Box, Button, Chip, CircularProgress, Divider, FormControl,
  IconButton, InputLabel, MenuItem, Paper, Select, Snackbar, Stack, Table, TableBody,
  TableCell, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import {
  Calculator, Check, Clipboard, Copy, ExternalLink, FileText, FolderOpen, Mail,
  PackagePlus, Presentation, RefreshCw, Save, Send, Share2, Sparkles, Trash2,
} from 'lucide-react';
import {
  type BrandAsset,
  type EndOfLeaseOption,
  type EquipmentCatalogItem,
  type EquipmentQuoteResponse,
  type PricingCalculateResponse,
  type ProposalCustomer,
  type ProposalEquipment,
  type ProposalProduct,
  type ProposalTerms,
  type SavedProposalSummary,
  calculateEquipmentPricing,
  catalogItemToProposalEquipment,
  createEquipmentQuote,
  currency,
  defaultProposalTerms,
  equipmentToPricingLines,
  generateGammaProposal,
  generateProposalEmail,
  getSavedProposal,
  getBrandAssets,
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

  const [products, setProducts] = useState<ProposalProduct[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<EquipmentCatalogItem[]>([]);
  const [equipmentSearch, setEquipmentSearch] = useState('');
  const [selectedEquipment, setSelectedEquipment] = useState<ProposalEquipment[]>([]);
  const [servicePlans, setServicePlans] = useState<ServicePlan[]>([]);
  const [endOfLeaseOptions, setEndOfLeaseOptions] = useState<EndOfLeaseOption[]>([]);
  const [brandAssets, setBrandAssets] = useState<BrandAsset[]>([]);

  const [pricing, setPricing] = useState<PricingCalculateResponse | null>(null);
  const [quote, setQuote] = useState<EquipmentQuoteResponse | null>(null);
  const [generatedEmail, setGeneratedEmail] = useState('');
  const [gammaUrl, setGammaUrl] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [proposalTitle, setProposalTitle] = useState('Custom Beverage Program Proposal');
  const [savedProposals, setSavedProposals] = useState<SavedProposalSummary[]>([]);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  async function loadData() {
    setLoadState('loading');
    setErrors([]);
    const nextErrors: string[] = [];
    const [productResult, catalogResult, serviceResult, leaseResult, assetResult, savedResult] = await Promise.allSettled([
      getBrixProducts(),
      getEquipmentCatalog(),
      getServicePlans(),
      getEndOfLeaseOptions(),
      getBrandAssets(),
      listSavedProposals(),
    ]);

    if (catalogResult.status === 'fulfilled') setCatalog(catalogResult.value.filter((item) => item.active !== false));
    else nextErrors.push(`Equipment: ${messageFrom(catalogResult.reason)}`);

    const loadedAssets = assetResult.status === 'fulfilled' ? assetResult.value : [];
    if (assetResult.status === 'fulfilled') setBrandAssets(loadedAssets);
    else nextErrors.push(`Brandox: ${messageFrom(assetResult.reason)}`);

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

  const proposalAssets = useMemo(
    () => selectProposalAssets(brandAssets, selectedProducts, selectedEquipment),
    [brandAssets, selectedEquipment, selectedProducts],
  );

  const proposalData = useMemo(() => ({
    customer,
    products: selectedProducts,
    equipment: selectedEquipment,
    pricing,
    servicePlans,
    endOfLeaseOptions,
    assets: proposalAssets,
    terms,
    quote,
  }), [customer, endOfLeaseOptions, pricing, proposalAssets, quote, selectedEquipment, selectedProducts, servicePlans, terms]);

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
      const text = await generateProposalEmail(proposalData);
      setGeneratedEmail(text);
      setToast('Email generated.');
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
      setPricing(data.pricing || null);
      setQuote(data.quote || null);
      setGeneratedEmail(saved.generatedEmail || '');
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
                    <Thumb src={option.imageUrl} alt={option.name} />
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" fontWeight={700}>{option.name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {option.category.toUpperCase()}{option.price != null ? ` · ${currency(option.price)}` : ''}
                      </Typography>
                    </Box>
                  </Box>
                )}
                renderInput={(params) => <TextField {...params} label="Products and flavors" />}
              />
              <ProductSummary products={selectedProducts} />
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
                products={selectedProducts}
                equipment={selectedEquipment}
                pricing={pricing}
                servicePlans={selectedServicePlans}
                endOfLeaseOptions={selectedEndOptions}
                terms={terms}
                quote={quote}
                assets={proposalAssets}
              />
            </Section>

            <Section title="Generated Email" icon={<Mail size={18} />}>
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1}>
                  <Button
                    variant="contained"
                    startIcon={busy === 'email' ? <CircularProgress size={16} /> : <Send size={16} />}
                    disabled={busy !== 'none'}
                    onClick={createEmail}
                  >
                    Generate Email
                  </Button>
                  <Tooltip title="Copy email">
                    <span>
                      <IconButton disabled={!generatedEmail} onClick={copyEmail}>
                        <Copy size={18} />
                      </IconButton>
                    </span>
                  </Tooltip>
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
                <BrandAssets assets={brandAssets} />
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

function Thumb({ src, alt }: { src?: string | null; alt: string }) {
  return (
    <Box
      sx={{
        width: 44,
        height: 44,
        flex: '0 0 44px',
        borderRadius: 1,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'action.hover',
        display: 'grid',
        placeItems: 'center',
        overflow: 'hidden',
      }}
    >
      {src
        ? <Box component="img" src={src} alt={alt} sx={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        : <PackagePlus size={18} color="currentColor" />}
    </Box>
  );
}

function ProductSummary({ products }: { products: ProposalProduct[] }) {
  if (!products.length) return <Typography variant="body2" color="text.secondary">No products selected.</Typography>;
  const grouped = products.reduce<Record<string, number>>((acc, product) => {
    acc[product.category] = (acc[product.category] || 0) + 1;
    return acc;
  }, {});
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        {Object.entries(grouped).map(([category, count]) => (
          <Chip key={category} size="small" variant="outlined" label={`${category.toUpperCase()} · ${count}`} />
        ))}
      </Stack>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 1 }}>
        {products.slice(0, 8).map((product) => (
          <Paper key={product.id} variant="outlined" sx={{ p: 1, borderRadius: 1 }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Thumb src={product.imageUrl} alt={product.name} />
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" fontWeight={700} noWrap>{product.name}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {product.price != null ? currency(product.price) : product.category.toUpperCase()}
                </Typography>
              </Box>
            </Stack>
          </Paper>
        ))}
      </Box>
    </Stack>
  );
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
        value={assets.length ? `${assets.length} asset${assets.length === 1 ? '' : 's'} available` : 'No Brandox assets loaded'}
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

function BrandAssets({ assets }: { assets: BrandAsset[] }) {
  if (!assets.length) return <Typography variant="body2" color="text.secondary">No Brandox assets loaded.</Typography>;
  return (
    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
      {assets.slice(0, 8).map((asset) => (
        <Chip
          key={asset.id}
          size="small"
          label={`${asset.type} · ${asset.name}`}
          component="a"
          href={asset.url}
          target="_blank"
          clickable
          variant="outlined"
        />
      ))}
      {assets.length > 8 && <Chip size="small" label={`+${assets.length - 8} more`} />}
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
  return value instanceof Error ? value.message : String(value || 'Unknown error');
}
