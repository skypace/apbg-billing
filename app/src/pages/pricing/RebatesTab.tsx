import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Checkbox, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, FormControl, FormControlLabel, IconButton, InputLabel,
  MenuItem, Paper, Select, Stack, Table, TableBody, TableCell, TableHead, TableRow,
  TextField, Tooltip, Typography,
} from '@mui/material';
import { Plus, Pencil, Trash2, Calculator, Banknote } from 'lucide-react';
import type { CustomerOpt, Contract } from '../../lib/pricing';
import {
  type RebateProgram, type RebateRule, type RebateRuleType, type RebateSettlement,
  type RebateCalc, type VendorOpt, RULE_TYPE_LABELS,
  listRebatePrograms, listRebateRules, listRebateSettlements,
  createRebateProgram, updateRebateProgram,
  createRebateRule, updateRebateRule, deleteRebateRule,
  calculateRebate, createRebateSettlement, voidRebateSettlement,
  searchVendors, vendorName,
} from '../../lib/rebates';

const usd = (n: number | null | undefined) =>
  n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('en-US');

// ── Rule editor dialog ────────────────────────────────────────────────────────

interface RuleDraft {
  id?: string;
  rule_type: RebateRuleType;
  label: string;
  amount: string;
  item_patterns: string;
  item_ids: string;
  config: Record<string, unknown>;
  sort: number;
  active: boolean;
}

const emptyRule = (sort: number): RuleDraft => ({
  rule_type: 'volume_growth', label: '', amount: '0', item_patterns: '3G%', item_ids: '',
  config: { growth_pct_min: 5, basis: 'all' }, sort, active: true,
});

const defaultConfigFor = (t: RebateRuleType): Record<string, unknown> => (
  t === 'volume_growth' ? { growth_pct_min: 5, basis: 'all' }
  : t === 'ordering_cadence' ? { period_months: 2, min_orders: 1, grace_windows: 0, orders_scope: 'any' }
  : t === 'tiered_volume' ? { tiers: [{ min_units: 0, amount_per_unit: 0.5 }], retroactive: true }
  : t === 'fixed_per_store' ? { min_units: 1 }
  : {});

function RuleDialog({ draft, onClose, onSave }: {
  draft: RuleDraft; onClose: () => void; onSave: (d: RuleDraft) => Promise<void>;
}) {
  const [d, setD] = useState<RuleDraft>(draft);
  const [busy, setBusy] = useState(false);
  const cfg = d.config;
  const setCfg = (k: string, v: unknown) => setD({ ...d, config: { ...cfg, [k]: v } });
  const tiers = (cfg.tiers as Array<{ min_units: number; amount_per_unit: number }> | undefined) ?? [];
  const scopeEmpty = !d.item_patterns.trim() && !d.item_ids.trim();
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{d.id ? 'Edit rebate rule' : 'New rebate rule'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <FormControl size="small" fullWidth>
            <InputLabel>Rule type</InputLabel>
            <Select label="Rule type" value={d.rule_type}
              onChange={(e) => {
                const t = e.target.value as RebateRuleType;
                setD({ ...d, rule_type: t, config: defaultConfigFor(t) });
              }}>
              {(Object.keys(RULE_TYPE_LABELS) as RebateRuleType[]).map((t) => (
                <MenuItem key={t} value={t}>{RULE_TYPE_LABELS[t]}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField size="small" label="Label (shown on the settlement bill)" value={d.label}
            onChange={(e) => setD({ ...d, label: e.target.value })} fullWidth />
          {d.rule_type !== 'tiered_volume' && (
            <TextField size="small" value={d.amount} onChange={(e) => setD({ ...d, amount: e.target.value })}
              label={d.rule_type === 'fixed_per_store' ? '$ per store per year' : '$ per unit'} sx={{ width: 200 }} />
          )}

          {d.rule_type === 'volume_growth' && (
            <Stack direction="row" spacing={2}>
              <TextField size="small" label="Min YoY growth %" value={String(cfg.growth_pct_min ?? 5)}
                onChange={(e) => setCfg('growth_pct_min', Number(e.target.value) || 0)} sx={{ width: 160 }} />
              <FormControl size="small" sx={{ minWidth: 220 }}>
                <InputLabel>Pays on</InputLabel>
                <Select label="Pays on" value={String(cfg.basis ?? 'all')} onChange={(e) => setCfg('basis', e.target.value)}>
                  <MenuItem value="all">All units (once qualified)</MenuItem>
                  <MenuItem value="incremental">Incremental units only</MenuItem>
                </Select>
              </FormControl>
            </Stack>
          )}
          {d.rule_type === 'ordering_cadence' && (
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
              <TextField size="small" label="Window (months)" value={String(cfg.period_months ?? 2)}
                onChange={(e) => setCfg('period_months', Number(e.target.value) || 1)} sx={{ width: 140 }} />
              <TextField size="small" label="Min orders / window" value={String(cfg.min_orders ?? 1)}
                onChange={(e) => setCfg('min_orders', Number(e.target.value) || 1)} sx={{ width: 160 }} />
              <TextField size="small" label="Max orders / window (blank = no cap)"
                value={cfg.max_orders == null ? '' : String(cfg.max_orders)}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  setCfg('max_orders', v === '' ? null : Number(v) || null);
                }} sx={{ width: 230 }} />
              <TextField size="small" label="Missed windows allowed" value={String(cfg.grace_windows ?? 0)}
                onChange={(e) => setCfg('grace_windows', Number(e.target.value) || 0)} sx={{ width: 190 }} />
              <FormControl size="small" sx={{ minWidth: 200 }}>
                <InputLabel>Orders counted</InputLabel>
                <Select label="Orders counted" value={String(cfg.orders_scope ?? 'any')}
                  onChange={(e) => setCfg('orders_scope', e.target.value)}>
                  <MenuItem value="any">Any invoice</MenuItem>
                  <MenuItem value="in_scope">Invoices with in-scope items</MenuItem>
                </Select>
              </FormControl>
            </Stack>
          )}
          {d.rule_type === 'fixed_per_store' && (
            <TextField size="small" label="Min units for a store to count" value={String(cfg.min_units ?? 1)}
              onChange={(e) => setCfg('min_units', Number(e.target.value) || 1)} sx={{ width: 240 }} />
          )}
          {d.rule_type === 'tiered_volume' && (
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>Chain-level tiers</Typography>
              {tiers.map((t, i) => (
                <Stack key={i} direction="row" spacing={1} sx={{ mb: 1 }} alignItems="center">
                  <TextField size="small" label="From units" value={String(t.min_units)}
                    onChange={(e) => {
                      const next = tiers.slice(); next[i] = { ...t, min_units: Number(e.target.value) || 0 };
                      setCfg('tiers', next);
                    }} sx={{ width: 130 }} />
                  <TextField size="small" label="$/unit" value={String(t.amount_per_unit)}
                    onChange={(e) => {
                      const next = tiers.slice(); next[i] = { ...t, amount_per_unit: Number(e.target.value) || 0 };
                      setCfg('tiers', next);
                    }} sx={{ width: 120 }} />
                  <IconButton size="small" onClick={() => setCfg('tiers', tiers.filter((_, j) => j !== i))}>
                    <Trash2 size={16} />
                  </IconButton>
                </Stack>
              ))}
              <Stack direction="row" spacing={2} alignItems="center">
                <Button size="small" startIcon={<Plus size={14} />}
                  onClick={() => setCfg('tiers', [...tiers, { min_units: 0, amount_per_unit: 0 }])}>Add tier</Button>
                <FormControlLabel control={
                  <Checkbox size="small" checked={Boolean(cfg.retroactive ?? true)}
                    onChange={(e) => setCfg('retroactive', e.target.checked)} />}
                  label="Retroactive (reached tier's rate pays on ALL units)" />
              </Stack>
            </Box>
          )}

          <Divider />
          <TextField size="small" label="Item name patterns (comma-separated ILIKE, e.g. 3G%)"
            value={d.item_patterns} onChange={(e) => setD({ ...d, item_patterns: e.target.value })} fullWidth />
          <TextField size="small" label="Exact QBO item ids (comma-separated, optional)"
            value={d.item_ids} onChange={(e) => setD({ ...d, item_ids: e.target.value })} fullWidth />
          {scopeEmpty && <Alert severity="warning">No item scope — this rule will match ZERO volume until a pattern or item id is set.</Alert>}
          <Stack direction="row" spacing={2} alignItems="center">
            <TextField size="small" label="Sort" value={String(d.sort)}
              onChange={(e) => setD({ ...d, sort: Number(e.target.value) || 0 })} sx={{ width: 100 }} />
            <FormControlLabel control={
              <Checkbox size="small" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} />}
              label="Active" />
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={busy || !d.label.trim()}
          onClick={async () => { setBusy(true); try { await onSave(d); } finally { setBusy(false); } }}>
          {busy ? 'Saving…' : 'Save rule'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Calc result table ─────────────────────────────────────────────────────────

function CalcResult({ calc, inYear }: { calc: RebateCalc; inYear: boolean }) {
  return (
    <Stack spacing={2}>
      <Alert severity={inYear ? 'info' : 'success'}>
        {inYear
          ? `Year-to-date accrual through ${calc.period_end} — compared against the same window of ${calc.year - 1}. Qualification is final only at year-end.`
          : `Full calendar year ${calc.year} (${calc.period_start} → ${calc.period_end}).`}
        {' '}Grand total: <b>{usd(calc.grand_total)}</b> · {calc.stores_in_family} stores in the chain.
      </Alert>
      {calc.rules.map((r) => (
        <Paper key={r.rule_id} variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="subtitle2">{r.label}</Typography>
            <Chip size="small" color={r.total > 0 ? 'success' : 'default'} label={usd(r.total)} />
          </Stack>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Store</TableCell>
                  <TableCell align="right">Units</TableCell>
                  {r.rule_type === 'volume_growth' && <Fragment>
                    <TableCell align="right">Prior yr</TableCell>
                    <TableCell align="right">Growth</TableCell>
                  </Fragment>}
                  {r.rule_type === 'ordering_cadence' && <TableCell align="right">Windows</TableCell>}
                  <TableCell>Qualified</TableCell>
                  <TableCell align="right">Payable units</TableCell>
                  <TableCell align="right">Rebate</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {r.stores.map((s, i) => (
                  <TableRow key={i} sx={{ opacity: s.qualified ? 1 : 0.65 }}>
                    <TableCell>{s.store}</TableCell>
                    <TableCell align="right">{num(s.cur_units)}</TableCell>
                    {r.rule_type === 'volume_growth' && <Fragment>
                      <TableCell align="right">{num(s.prior_units)}</TableCell>
                      <TableCell align="right">{s.growth_pct == null ? '—' : `${s.growth_pct}%`}</TableCell>
                    </Fragment>}
                    {r.rule_type === 'ordering_cadence' && (
                      <TableCell align="right">{s.windows_met}/{s.windows_total}</TableCell>
                    )}
                    <TableCell>
                      {s.qualified ? <Chip size="small" color="success" label="✓" />
                        : <Tooltip title={s.reason ?? ''}><Chip size="small" label={s.reason ?? 'no'} /></Tooltip>}
                    </TableCell>
                    <TableCell align="right">{num(s.payable_units)}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{usd(s.amount)}</TableCell>
                  </TableRow>
                ))}
                {r.stores.length === 0 && (
                  <TableRow><TableCell colSpan={8}><em>No in-scope volume found.</em></TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Box>
        </Paper>
      ))}
    </Stack>
  );
}

// ── The tab ───────────────────────────────────────────────────────────────────

export function RebatesTab({ customers, contracts, onOk, onErr }: {
  customers: CustomerOpt[];
  contracts: Contract[];
  onOk: (msg: string) => void;
  onErr: (msg: string) => void;
}) {
  const thisYear = new Date().getFullYear();
  const [programs, setPrograms] = useState<RebateProgram[] | null>(null);
  const [programId, setProgramId] = useState('');
  const [rules, setRules] = useState<RebateRule[]>([]);
  const [settlements, setSettlements] = useState<RebateSettlement[]>([]);
  const [vendorLabel, setVendorLabel] = useState<string | null>(null);
  const [calc, setCalc] = useState<RebateCalc | null>(null);
  const [calcYear, setCalcYear] = useState(thisYear);
  const [calcBusy, setCalcBusy] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [settleBusy, setSettleBusy] = useState(false);

  const program = useMemo(() => programs?.find((p) => p.id === programId), [programs, programId]);

  async function reloadPrograms(keep?: string) {
    try {
      const rows = await listRebatePrograms();
      setPrograms(rows);
      const want = keep ?? programId;
      if (rows.length && (!want || !rows.some((p) => p.id === want))) setProgramId(rows[0]!.id);
      else if (keep) setProgramId(keep);
    } catch (e) { onErr(e instanceof Error ? e.message : 'Failed to load rebate programs'); }
  }
  useEffect(() => { void reloadPrograms(); /* eslint-disable-next-line */ }, []);

  useEffect(() => {
    setCalc(null);
    if (!programId) { setRules([]); setSettlements([]); setVendorLabel(null); return; }
    void (async () => {
      try {
        const [r, s] = await Promise.all([listRebateRules(programId), listRebateSettlements(programId)]);
        setRules(r); setSettlements(s);
        setVendorLabel(await vendorName(programs?.find((p) => p.id === programId)?.qbo_vendor_id ?? null));
      } catch (e) { onErr(e instanceof Error ? e.message : 'Failed to load program'); }
    })();
    // eslint-disable-next-line
  }, [programId, programs]);

  const custName = (id: string) => customers.find((c) => c.qbo_customer_id === id)?.display_name ?? `QBO #${id}`;

  async function saveRule(d: RuleDraft) {
    const row = {
      rule_type: d.rule_type, label: d.label.trim(), amount: Number(d.amount) || 0,
      item_patterns: d.item_patterns.split(',').map((s) => s.trim()).filter(Boolean),
      item_ids: d.item_ids.split(',').map((s) => s.trim()).filter(Boolean),
      config: d.config, sort: d.sort, active: d.active,
    };
    try {
      if (d.id) await updateRebateRule(d.id, row);
      else await createRebateRule({ ...row, program_id: programId });
      setRuleDraft(null);
      setRules(await listRebateRules(programId));
      onOk('Rule saved');
    } catch (e) { onErr(e instanceof Error ? e.message : 'Rule save failed'); }
  }

  async function runCalc() {
    setCalcBusy(true); setCalc(null);
    try { setCalc(await calculateRebate(programId, calcYear)); }
    catch (e) { onErr(e instanceof Error ? e.message : 'Calculation failed'); }
    finally { setCalcBusy(false); }
  }

  async function runSettlement() {
    const yr = calcYear;
    if (!window.confirm(
      `Run the ${yr} annual settlement for ${program?.name}?\n\nThis snapshots the calculation and creates the Brixpense bill (${'RB-' + (program?.code ?? '') + '-' + yr}). Nothing posts to QuickBooks until a human clicks "Post to QuickBooks" in Brixpense.`,
    )) return;
    setSettleBusy(true);
    try {
      const res = await createRebateSettlement(programId, yr);
      onOk(`Settlement ${res.reference} created — ${usd(res.total_amount)} payable to ${res.vendor}. Post it from Brixpense when the customer approves the data.`);
      setSettlements(await listRebateSettlements(programId));
    } catch (e) { onErr(e instanceof Error ? e.message : 'Settlement failed'); }
    finally { setSettleBusy(false); }
  }

  if (!programs) return <Box sx={{ p: 4, textAlign: 'center' }}><CircularProgress /></Box>;

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} alignItems="center">
        <FormControl size="small" sx={{ minWidth: 320 }}>
          <InputLabel>Rebate program</InputLabel>
          <Select label="Rebate program" value={programId} onChange={(e) => setProgramId(e.target.value)}>
            {programs.map((p) => (
              <MenuItem key={p.id} value={p.id}>
                {p.name} · {custName(p.qbo_customer_id)}{p.status === 'ended' ? ' · ENDED' : ''}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Button startIcon={<Plus size={16} />} onClick={() => setNewOpen(true)}>New program</Button>
      </Stack>

      {programs.length === 0 && (
        <Alert severity="info">No rebate programs yet — create one and load the contract's rebate terms as rules.</Alert>
      )}

      {program && (
        <Fragment>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" useFlexGap spacing={1}>
              <Box>
                <Typography variant="subtitle1">{program.name}
                  <Chip size="small" sx={{ ml: 1 }} label={program.code} />
                  <Chip size="small" sx={{ ml: 0.5 }} label={program.entity} />
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Chain: <b>{custName(program.qbo_customer_id)}</b> (parent + sub-stores) ·
                  Check payee: <b>{vendorLabel ?? (program.qbo_vendor_id ? `QBO vendor #${program.qbo_vendor_id}` : '⚠ no vendor linked — required to settle')}</b>
                </Typography>
                {program.notes && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, maxWidth: 720 }}>
                    {program.notes}
                  </Typography>
                )}
              </Box>
              <Button size="small" startIcon={<Pencil size={14} />} onClick={() => setEditOpen(true)}>Edit program</Button>
            </Stack>
          </Paper>

          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="subtitle2">Rebate rules</Typography>
              <Button size="small" startIcon={<Plus size={14} />}
                onClick={() => setRuleDraft(emptyRule((rules[rules.length - 1]?.sort ?? 0) + 1))}>Add rule</Button>
            </Stack>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Rule</TableCell><TableCell>Type</TableCell>
                  <TableCell align="right">Rate</TableCell><TableCell>Item scope</TableCell>
                  <TableCell /><TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {rules.map((r) => (
                  <TableRow key={r.id} sx={{ opacity: r.active ? 1 : 0.5 }}>
                    <TableCell>{r.label}{!r.active && <Chip size="small" label="inactive" sx={{ ml: 1 }} />}</TableCell>
                    <TableCell><Chip size="small" label={r.rule_type.replace(/_/g, ' ')} /></TableCell>
                    <TableCell align="right">
                      {r.rule_type === 'tiered_volume' ? 'tiers' :
                        r.rule_type === 'fixed_per_store' ? `${usd(r.amount)}/store` : `${usd(r.amount)}/unit`}
                    </TableCell>
                    <TableCell>
                      {[...r.item_patterns, ...r.item_ids.map((i) => `#${i}`)].join(', ') ||
                        <Chip size="small" color="warning" label="no scope" />}
                    </TableCell>
                    <TableCell align="right">
                      <IconButton size="small" onClick={() => setRuleDraft({
                        id: r.id, rule_type: r.rule_type, label: r.label, amount: String(r.amount),
                        item_patterns: r.item_patterns.join(', '), item_ids: r.item_ids.join(', '),
                        config: r.config, sort: r.sort, active: r.active,
                      })}><Pencil size={14} /></IconButton>
                    </TableCell>
                    <TableCell align="right">
                      <IconButton size="small" onClick={async () => {
                        if (!window.confirm(`Delete rule "${r.label}"? Past settlements keep their snapshots.`)) return;
                        try { await deleteRebateRule(r.id); setRules(await listRebateRules(programId)); onOk('Rule deleted'); }
                        catch (e) { onErr(e instanceof Error ? e.message : 'Delete failed'); }
                      }}><Trash2 size={14} /></IconButton>
                    </TableCell>
                  </TableRow>
                ))}
                {rules.length === 0 && (
                  <TableRow><TableCell colSpan={6}><em>No rules — load the contract's rebate terms.</em></TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Paper>

          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
              <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>Accrual & annual run</Typography>
              <TextField size="small" label="Year" value={String(calcYear)} sx={{ width: 110 }}
                onChange={(e) => setCalcYear(Number(e.target.value) || thisYear)} />
              <Button variant="outlined" size="small" startIcon={<Calculator size={14} />}
                disabled={calcBusy} onClick={() => void runCalc()}>
                {calcBusy ? 'Calculating…' : 'Calculate'}
              </Button>
              <Tooltip title={calcYear >= thisYear
                ? 'The annual settlement runs on a COMPLETED year — per the contract, the data report goes to the customer by Jan 31.'
                : 'Snapshots the calculation and creates the Brixpense bill (human "Post to QuickBooks" gate).'}>
                <span>
                  <Button variant="contained" size="small" color="success" startIcon={<Banknote size={14} />}
                    disabled={settleBusy || calcYear >= thisYear} onClick={() => void runSettlement()}>
                    {settleBusy ? 'Running…' : `Run ${calcYear} settlement`}
                  </Button>
                </span>
              </Tooltip>
            </Stack>
            {calc ? <CalcResult calc={calc} inYear={calc.year === thisYear} />
              : <Typography variant="body2" color="text.secondary">
                  Calculate to see the live accrual (current year = YTD vs the same window last year) or a completed year's final numbers.
                </Typography>}
          </Paper>

          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>Settlements</Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Reference</TableCell><TableCell>Year</TableCell>
                  <TableCell align="right">Amount</TableCell><TableCell>Status</TableCell>
                  <TableCell>Created</TableCell><TableCell>Brixpense</TableCell><TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {settlements.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>{s.reference}</TableCell>
                    <TableCell>{s.period_year}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{usd(s.total_amount)}</TableCell>
                    <TableCell>
                      {s.status === 'void'
                        ? <Tooltip title={s.void_reason ?? ''}><Chip size="small" label="void" /></Tooltip>
                        : <Chip size="small" color="success" label="open" />}
                    </TableCell>
                    <TableCell>{s.created_at.slice(0, 10)}</TableCell>
                    <TableCell>
                      {s.expense_request_id && s.status !== 'void'
                        ? <Button size="small" href="/expense/pending" target="_blank">Post from Brixpense →</Button>
                        : '—'}
                    </TableCell>
                    <TableCell align="right">
                      {s.status !== 'void' && (
                        <Button size="small" color="error" onClick={async () => {
                          const reason = window.prompt(`Void ${s.reference}? This releases the year for a re-run and archives the unposted Brixpense bill.\n\nReason:`);
                          if (reason == null) return;
                          try { await voidRebateSettlement(s.id, reason || undefined); setSettlements(await listRebateSettlements(programId)); onOk('Settlement voided'); }
                          catch (e) { onErr(e instanceof Error ? e.message : 'Void failed'); }
                        }}>Void</Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {settlements.length === 0 && (
                  <TableRow><TableCell colSpan={7}><em>No settlements yet — the first annual run lands here with its Brixpense bill.</em></TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Paper>
        </Fragment>
      )}

      {ruleDraft && <RuleDialog draft={ruleDraft} onClose={() => setRuleDraft(null)} onSave={saveRule} />}
      {(newOpen || (editOpen && program)) && (
        <ProgramDialog
          program={newOpen ? null : program!}
          customers={customers} contracts={contracts}
          onClose={() => { setNewOpen(false); setEditOpen(false); }}
          onSaved={async (keepId) => {
            setNewOpen(false); setEditOpen(false);
            await reloadPrograms(keepId);
            onOk('Program saved');
          }}
          onErr={onErr}
        />
      )}
    </Stack>
  );
}

// ── Program create/edit dialog ────────────────────────────────────────────────

function ProgramDialog({ program, customers, contracts, onClose, onSaved, onErr }: {
  program: RebateProgram | null;
  customers: CustomerOpt[];
  contracts: Contract[];
  onClose: () => void;
  onSaved: (keepId?: string) => Promise<void>;
  onErr: (msg: string) => void;
}) {
  const [name, setName] = useState(program?.name ?? '');
  const [code, setCode] = useState(program?.code ?? '');
  const [cust, setCust] = useState<CustomerOpt | null>(
    program ? customers.find((c) => c.qbo_customer_id === program.qbo_customer_id) ??
      { qbo_customer_id: program.qbo_customer_id, display_name: `QBO #${program.qbo_customer_id}` } : null);
  const [vendor, setVendor] = useState<VendorOpt | null>(null);
  const [vendorOpts, setVendorOpts] = useState<VendorOpt[]>([]);
  const [vendorTerm, setVendorTerm] = useState('');
  const [entity, setEntity] = useState(program?.entity ?? 'brix');
  const [contractId, setContractId] = useState(program?.pricing_contract_id ?? '');
  const [notes, setNotes] = useState(program?.notes ?? '');
  const [status, setStatus] = useState(program?.status ?? 'active');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!program?.qbo_vendor_id) return;
    void vendorName(program.qbo_vendor_id).then((n) => {
      if (n) setVendor({ qbo_vendor_id: program.qbo_vendor_id!, display_name: n });
    });
  }, [program]);

  useEffect(() => {
    const t = setTimeout(() => {
      void searchVendors(vendorTerm).then(setVendorOpts).catch(() => setVendorOpts([]));
    }, 300);
    return () => clearTimeout(t);
  }, [vendorTerm]);

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{program ? 'Edit rebate program' : 'New rebate program'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField size="small" label="Program name" value={name} onChange={(e) => setName(e.target.value)} fullWidth />
          <TextField size="small" label="Code (settlement refs: RB-<CODE>-<year>)" value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))} sx={{ width: 280 }} />
          <Autocomplete size="small" options={customers} value={cust}
            getOptionLabel={(o) => o.display_name}
            isOptionEqualToValue={(a, b) => a.qbo_customer_id === b.qbo_customer_id}
            onChange={(_, v) => setCust(v)}
            renderInput={(p) => <TextField {...p} label="Chain customer (QBO parent — volume rolls up its sub-stores)" />} />
          <Autocomplete size="small" options={vendorOpts} value={vendor}
            getOptionLabel={(o) => o.display_name}
            isOptionEqualToValue={(a, b) => a.qbo_vendor_id === b.qbo_vendor_id}
            filterOptions={(x) => x}
            onChange={(_, v) => setVendor(v)}
            onInputChange={(_, v) => setVendorTerm(v)}
            renderInput={(p) => <TextField {...p} label="Check payee (QBO vendor — type to search)" />} />
          <Stack direction="row" spacing={2}>
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel>Entity</InputLabel>
              <Select label="Entity" value={entity} onChange={(e) => setEntity(e.target.value as typeof entity)}>
                <MenuItem value="brix">brix (Alameda Soda)</MenuItem>
                <MenuItem value="freeflow">freeflow</MenuItem>
                <MenuItem value="shared">shared</MenuItem>
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 220 }}>
              <InputLabel>Pricing contract (optional)</InputLabel>
              <Select label="Pricing contract (optional)" value={contractId}
                onChange={(e) => setContractId(e.target.value)}>
                <MenuItem value="">— none —</MenuItem>
                {contracts.map((c) => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
              </Select>
            </FormControl>
            {program && (
              <FormControl size="small" sx={{ minWidth: 130 }}>
                <InputLabel>Status</InputLabel>
                <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                  <MenuItem value="active">active</MenuItem>
                  <MenuItem value="ended">ended</MenuItem>
                </Select>
              </FormControl>
            )}
          </Stack>
          <TextField size="small" label="Notes (contract reference, ambiguity decisions, franchise handling)"
            value={notes} onChange={(e) => setNotes(e.target.value)} multiline minRows={3} fullWidth />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={busy || !name.trim() || !code.trim() || !cust}
          onClick={async () => {
            setBusy(true);
            try {
              if (program) {
                await updateRebateProgram(program.id, {
                  name: name.trim(), code: code.trim(), qbo_customer_id: cust!.qbo_customer_id,
                  qbo_vendor_id: vendor?.qbo_vendor_id ?? null,
                  pricing_contract_id: contractId || null,
                  entity: entity as RebateProgram['entity'], notes: notes || null,
                  status: status as RebateProgram['status'],
                });
                await onSaved(program.id);
              } else {
                await createRebateProgram({
                  code: code.trim(), name: name.trim(), qbo_customer_id: cust!.qbo_customer_id,
                  qbo_vendor_id: vendor?.qbo_vendor_id ?? null,
                  pricing_contract_id: contractId || null, entity, notes: notes || null,
                });
                await onSaved();
              }
            } catch (e) { onErr(e instanceof Error ? e.message : 'Save failed'); }
            finally { setBusy(false); }
          }}>
          {busy ? 'Saving…' : 'Save program'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
