import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Chip, CircularProgress, FormControl, FormControlLabel,
  InputLabel, MenuItem, Paper, Select, Snackbar, Stack, Switch, Tab, Table,
  TableBody, TableCell, TableHead, TableRow, Tabs, TextField, Typography,
} from '@mui/material';
import {
  type BookItem, type Contract, type PricingData,
  getPricing, setBookItemPrice, bulkIncrease, setContractItemPrice,
  setContractDates, exportStandardCsv,
} from '../lib/pricing';

const today = () => new Date().toISOString().slice(0, 10);
const usd = (n: number) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Inline price editor: shows the value, lets you change + save one item. */
function PriceCell({ value, onSave }: { value: number; onSave: (v: number) => Promise<void> }) {
  const [v, setV] = useState(String(value));
  const [busy, setBusy] = useState(false);
  const dirty = Number(v) !== Number(value) && v.trim() !== '' && Number.isFinite(Number(v));
  return (
    <Stack direction="row" spacing={1} alignItems="center" justifyContent="flex-end">
      <TextField
        size="small" value={v} onChange={(e) => setV(e.target.value)}
        slotProps={{ input: { inputMode: 'decimal' } }}
        sx={{ width: 110, '& input': { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }}
      />
      <Button
        size="small" variant={dirty ? 'contained' : 'outlined'} disabled={!dirty || busy}
        onClick={async () => { setBusy(true); try { await onSave(Number(v)); } finally { setBusy(false); } }}
      >
        {busy ? '…' : 'Save'}
      </Button>
    </Stack>
  );
}

export function PricingPage() {
  const [data, setData] = useState<PricingData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  // Bulk increase controls.
  const [pct, setPct] = useState('5');
  const [eff, setEff] = useState(today());
  const [bulkBusy, setBulkBusy] = useState(false);

  // Selected contract.
  const [contractId, setContractId] = useState<string>('');

  async function reload() {
    setErr(null);
    try {
      const d = await getPricing();
      setData(d);
      if (!contractId && d.contracts.length) setContractId(d.contracts[0]!.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load pricing');
    }
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, []);

  const contract = useMemo<Contract | undefined>(
    () => data?.contracts.find((c) => c.id === contractId),
    [data, contractId],
  );

  if (err) return <Box sx={{ p: 3 }}><Alert severity="error">{err}</Alert></Box>;
  if (!data) return <Box sx={{ p: 6, textAlign: 'center' }}><CircularProgress /></Box>;

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1000, mx: 'auto' }}>
      <Typography variant="h5" sx={{ fontWeight: 700, mb: 0.5 }}>Pricing</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        BX-1 standard price list + customer contracts. Changes flow to the order portal
        (contract → BX-1 → list) and the Service Fusion export. Increases are effective-dated.
      </Typography>

      <Tabs value={tab} onChange={(_, t) => setTab(t)} sx={{ mb: 2 }}>
        <Tab label={`BX-1 Standard (${data.standard.length})`} />
        <Tab label={`Contracts (${data.contracts.length})`} />
      </Tabs>

      {tab === 0 && (
        <Stack spacing={2}>
          {/* Bulk increase toolbar */}
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
              <Typography variant="subtitle2" sx={{ minWidth: 120 }}>Raise all BX-1</Typography>
              <TextField label="% increase" size="small" value={pct} onChange={(e) => setPct(e.target.value)} sx={{ width: 120 }} />
              <TextField label="Effective" type="date" size="small" value={eff} onChange={(e) => setEff(e.target.value)} sx={{ width: 170 }} slotProps={{ inputLabel: { shrink: true } }} />
              <Button
                variant="contained" disabled={bulkBusy || !Number.isFinite(Number(pct))}
                onClick={async () => {
                  if (!window.confirm(`Raise every BX-1 price by ${pct}% effective ${eff}? This inserts new effective-dated prices.`)) return;
                  setBulkBusy(true);
                  try { const r = await bulkIncrease(Number(pct), eff) as { updated: number }; setToast(`Raised ${r.updated} item(s) by ${pct}%`); await reload(); }
                  catch (e) { setErr(e instanceof Error ? e.message : 'Bulk increase failed'); }
                  finally { setBulkBusy(false); }
                }}
              >
                {bulkBusy ? 'Applying…' : 'Apply increase'}
              </Button>
              <Box sx={{ flex: 1 }} />
              <Button variant="outlined" onClick={() => exportStandardCsv(data.standard)}>Export to Service Fusion (CSV)</Button>
            </Stack>
          </Paper>

          <Paper variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Item</TableCell>
                  <TableCell>QBO ID</TableCell>
                  <TableCell align="right">BX-1 price</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.standard.map((it: BookItem) => (
                  <TableRow key={it.id} hover>
                    <TableCell>{it.item_name ?? it.qbo_item_id}</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>{it.qbo_item_id}</TableCell>
                    <TableCell align="right">
                      <PriceCell value={it.unit_price} onSave={async (v) => {
                        await setBookItemPrice(it.qbo_item_id, it.item_name, v, today());
                        setToast(`${it.item_name ?? it.qbo_item_id} → ${usd(v)}`); await reload();
                      }} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        </Stack>
      )}

      {tab === 1 && (
        <Stack spacing={2}>
          <Stack direction="row" spacing={2} alignItems="center">
            <FormControl size="small" sx={{ minWidth: 260 }}>
              <InputLabel>Contract</InputLabel>
              <Select label="Contract" value={contractId} onChange={(e) => setContractId(e.target.value)}>
                {data.contracts.map((c) => (
                  <MenuItem key={c.id} value={c.id}>{c.name} · {c.locations.length} loc</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>

          {contract && (
            <>
              <Paper variant="outlined" sx={{ p: 2 }}>
                <ContractDatesEditor key={contract.id} contract={contract} onSaved={(msg) => { setToast(msg); void reload(); }} onError={setErr} />
                <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                  <Chip size="small" label={`${contract.locations.length} locations`} />
                  <Chip size="small" label={`${contract.items.length} priced items`} />
                  <Chip size="small" color={contract.active ? 'success' : 'default'} label={contract.active ? 'Active' : 'Inactive'} />
                </Stack>
              </Paper>

              <Paper variant="outlined">
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Item</TableCell>
                      <TableCell>QBO ID</TableCell>
                      <TableCell align="right">Contract price</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {contract.items.map((it) => (
                      <TableRow key={it.qbo_item_id} hover>
                        <TableCell>{it.item_name ?? it.qbo_item_id}</TableCell>
                        <TableCell sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>{it.qbo_item_id}</TableCell>
                        <TableCell align="right">
                          <PriceCell value={it.unit_price} onSave={async (v) => {
                            await setContractItemPrice(contract.id, it.qbo_item_id, v);
                            setToast(`${contract.name}: ${it.item_name ?? it.qbo_item_id} → ${usd(v)}`); await reload();
                          }} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Paper>
            </>
          )}
        </Stack>
      )}

      <Snackbar open={!!toast} autoHideDuration={3000} onClose={() => setToast(null)} message={toast ?? ''} />
    </Box>
  );
}

function ContractDatesEditor({
  contract, onSaved, onError,
}: { contract: Contract; onSaved: (msg: string) => void; onError: (e: string) => void }) {
  const [start, setStart] = useState(contract.start_date);
  const [end, setEnd] = useState(contract.end_date ?? '');
  const [active, setActive] = useState(contract.active);
  const [busy, setBusy] = useState(false);
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 700, minWidth: 200 }}>{contract.name}</Typography>
      <TextField label="Start" type="date" size="small" value={start} onChange={(e) => setStart(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
      <TextField label="End" type="date" size="small" value={end} onChange={(e) => setEnd(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
      <FormControlLabel control={<Switch checked={active} onChange={(e) => setActive(e.target.checked)} />} label="Active" />
      <Button
        variant="contained" disabled={busy}
        onClick={async () => {
          setBusy(true);
          try { await setContractDates(contract.id, start, end || null, active); onSaved(`Saved ${contract.name}`); }
          catch (e) { onError(e instanceof Error ? e.message : 'Save failed'); }
          finally { setBusy(false); }
        }}
      >
        {busy ? 'Saving…' : 'Save contract'}
      </Button>
    </Stack>
  );
}
