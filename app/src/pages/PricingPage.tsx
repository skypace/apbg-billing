import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Checkbox, Chip, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, FormControl, FormControlLabel, IconButton,
  InputLabel, MenuItem, Paper, Select, Snackbar, Stack, Switch, Tab, Table, TableBody,
  TableCell, TableHead, TableRow, Tabs, TextField, Typography,
} from '@mui/material';
import { Plus, Trash2, Download, Upload, Pencil, ListPlus } from 'lucide-react';
import {
  type BookItem, type BulkItemInput, type Contract, type ContractKind, type CustomerOpt,
  type ItemOpt, type PriceBook, type PricingData,
  getPricing, setBookItemPrice, removeBookItem, bulkIncrease, bulkAddBookItems, updatePriceBook,
  setCustomerPriceBook, addContractItem, bulkAddContractItems, removeContractItem,
  addContractCustomer, removeContractCustomer, setContractMeta, createPriceBook,
  createContract, uploadContractFile, contractFileUrl, exportStandardCsv,
} from '../lib/pricing';
import { fetchInventoryHealth } from '../lib/inventory';

type BookSort = 'name_asc' | 'name_desc' | 'price_asc' | 'price_desc';
type GroupField = 'family' | 'type';
type ItemMeta = Map<string, { family: string | null; type: string | null; unit_price: number | null }>;

// This page inherits the app's MUI theme (makeBrixTheme) so it follows the
// light/dark switch and the shared branding — no local ThemeProvider.

const todayStr = () => new Date().toISOString().slice(0, 10);
const usd = (n: number) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function PriceCell({ value, onSave }: { value: number; onSave: (v: number) => Promise<void> }) {
  const [v, setV] = useState(String(value));
  const [busy, setBusy] = useState(false);
  const dirty = Number(v) !== Number(value) && v.trim() !== '' && Number.isFinite(Number(v));
  return (
    <Stack direction="row" spacing={1} alignItems="center" justifyContent="flex-end">
      <TextField size="small" value={v} onChange={(e) => setV(e.target.value)}
        sx={{ width: 110, '& input': { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }} />
      <Button size="small" variant={dirty ? 'contained' : 'outlined'} disabled={!dirty || busy}
        onClick={async () => { setBusy(true); try { await onSave(Number(v)); } finally { setBusy(false); } }}>
        {busy ? '…' : 'Save'}
      </Button>
    </Stack>
  );
}

export function PricingPage({ routeParams }: { routeParams?: Record<string, string> } = {}) {
  // Deep links (used by brix-order's /admin Company → Pricing panel):
  //   #pricing?tab=contracts&contract=<id>  → open that contract's editor
  //   #pricing?tab=contracts&new=1          → open the New Contract dialog
  const wantsContracts = routeParams?.tab === 'contracts' || !!routeParams?.contract || routeParams?.new === '1';
  const [data, setData] = useState<PricingData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState(wantsContracts ? 1 : 0);
  const [toast, setToast] = useState<string | null>(null);
  const [pct, setPct] = useState('5');
  const [eff, setEff] = useState(todayStr());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [contractId, setContractId] = useState<string>(routeParams?.contract ?? '');
  const [newContractOpen, setNewContractOpen] = useState(routeParams?.new === '1');
  const [newBookOpen, setNewBookOpen] = useState(false);
  const [itemMeta, setItemMeta] = useState<ItemMeta>(new Map());

  async function reload() {
    setErr(null);
    try {
      // Pull the item master alongside pricing so books can be sectioned by
      // the same product Family / Type the Margin screen groups by.
      const [d, health] = await Promise.all([
        getPricing(),
        fetchInventoryHealth({}).catch(() => []),
      ]);
      setData(d);
      const m: ItemMeta = new Map();
      for (const h of health) m.set(h.qbo_item_id, { family: h.product_family_label, type: h.product_type_label, unit_price: h.unit_price });
      setItemMeta(m);
      // Keep a valid selection: honor a deep-linked contract id when it exists,
      // otherwise (empty or stale id) fall back to the first contract.
      if (d.contracts.length && (!contractId || !d.contracts.some((c) => c.id === contractId))) {
        setContractId(d.contracts[0]!.id);
      }
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load pricing'); }
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, []);

  const contract = useMemo<Contract | undefined>(() => data?.contracts.find((c) => c.id === contractId), [data, contractId]);
  const custName = useMemo(() => {
    const m = new Map<string, string>();
    data?.customers.forEach((c) => m.set(c.qbo_customer_id, c.display_name));
    return m;
  }, [data]);

  if (err) return <Box sx={{ p: 3 }}><Alert severity="error">{err}</Alert></Box>;
  if (!data) return <Box sx={{ p: 6, textAlign: 'center' }}><CircularProgress /></Box>;
  const ok = (msg: string) => { setToast(msg); void reload(); };

  return (
      <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1040, mx: 'auto', color: 'text.primary' }}>
        <Typography variant="h5" sx={{ mb: 0.5 }}>Pricing</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Standard price books + customer contracts. Changes flow to the order portal
          (contract → standard → list) and the Service Fusion export. Increases are effective-dated.
        </Typography>

        <Tabs value={tab} onChange={(_, t) => setTab(t)} sx={{ mb: 2 }}>
          <Tab label="Price books" />
          <Tab label={`Contracts (${data.contracts.length})`} />
          <Tab label={`Customer price levels (${data.customerBooks.length})`} />
        </Tabs>

        {tab === 0 && <BooksTab data={data} itemMeta={itemMeta} pct={pct} setPct={setPct} eff={eff} setEff={setEff}
          bulkBusy={bulkBusy} setBulkBusy={setBulkBusy} onOk={ok} onErr={setErr} onNewBook={() => setNewBookOpen(true)} />}

        {tab === 1 && (
          <Stack spacing={2}>
            <Stack direction="row" spacing={2} alignItems="center">
              <FormControl size="small" sx={{ minWidth: 280 }}>
                <InputLabel>Contract</InputLabel>
                <Select label="Contract" value={contractId} onChange={(e) => setContractId(e.target.value)}>
                  {data.contracts.map((c) => (
                    <MenuItem key={c.id} value={c.id}>{c.name} · {c.locations.length} loc{c.kind === 'exclusivity' ? ' · exclusivity' : ''}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Button variant="contained" startIcon={<Plus size={16} />} onClick={() => setNewContractOpen(true)}>New contract</Button>
            </Stack>
            {contract && <ContractEditor key={contract.id} contract={contract} data={data} itemMeta={itemMeta} custName={custName} onOk={ok} onErr={setErr} />}
          </Stack>
        )}

        {tab === 2 && <CustomerBooksTab data={data} custName={custName} onOk={ok} onErr={setErr} />}

        {newContractOpen && <NewContractDialog data={data} onClose={() => setNewContractOpen(false)}
          onCreated={(id) => { setNewContractOpen(false); setContractId(id); ok('Contract created'); setTab(1); }} onErr={setErr} />}
        {newBookOpen && <NewBookDialog onClose={() => setNewBookOpen(false)} onCreated={() => { setNewBookOpen(false); ok('Price book created'); }} onErr={setErr} />}

        <Snackbar open={!!toast} autoHideDuration={3000} onClose={() => setToast(null)} message={toast ?? ''} />
      </Box>
  );
}

function BooksTab({ data, itemMeta, pct, setPct, eff, setEff, bulkBusy, setBulkBusy, onOk, onErr, onNewBook }: {
  data: PricingData; itemMeta: ItemMeta; pct: string; setPct: (s: string) => void; eff: string; setEff: (s: string) => void;
  bulkBusy: boolean; setBulkBusy: (b: boolean) => void; onOk: (m: string) => void; onErr: (e: string) => void; onNewBook: () => void;
}) {
  const [bookCode, setBookCode] = useState(data.books[0]?.code ?? 'BX-1');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<BookSort>('name_asc');
  const [groupBy, setGroupBy] = useState<GroupField>('family');
  const [addItem, setAddItem] = useState<ItemOpt | null>(null);
  const [addPrice, setAddPrice] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  const book = data.books.find((b) => b.code === bookCode);
  const label = (it: BookItem) => it.item_name ?? it.qbo_item_id;

  // Filter → sort → group into sections by the item's product Family / Type
  // (the same categorization the Margin screen uses; sourced from fn_items_master).
  // Also compute add-item options (every catalog item not already in the book).
  const { sections, groups, total, addOptions } = useMemo(() => {
    const bookItems = data.standard.filter((s) => s.price_book_id === book?.id);
    const inBook = new Set(bookItems.map((b) => b.qbo_item_id));
    const opts = data.items.filter((o) => !inBook.has(o.qbo_item_id));

    const q = search.trim().toLowerCase();
    const filtered = q
      ? bookItems.filter((it) => (it.item_name ?? '').toLowerCase().includes(q) || it.qbo_item_id.toLowerCase().includes(q))
      : bookItems;

    const cmp = (a: BookItem, b: BookItem) => {
      const an = a.item_name ?? a.qbo_item_id;
      const bn = b.item_name ?? b.qbo_item_id;
      switch (sort) {
        case 'price_asc':  return a.unit_price - b.unit_price;
        case 'price_desc': return b.unit_price - a.unit_price;
        case 'name_desc':  return bn.localeCompare(an);
        default:           return an.localeCompare(bn);
      }
    };

    const UNASSIGNED = 'Unassigned';
    const g = new Map<string, BookItem[]>();
    for (const it of filtered) {
      const meta = itemMeta.get(it.qbo_item_id);
      const key = (groupBy === 'type' ? meta?.type : meta?.family) || UNASSIGNED;
      const arr = g.get(key);
      if (arr) arr.push(it); else g.set(key, [it]);
    }
    for (const arr of g.values()) arr.sort(cmp);
    // Alphabetical sections, "Unassigned" always last.
    const secs = [...g.keys()].sort((a, b) =>
      (a === UNASSIGNED ? 1 : 0) - (b === UNASSIGNED ? 1 : 0) || a.localeCompare(b),
    );
    return { sections: secs, groups: g, total: filtered.length, addOptions: opts };
  }, [data, itemMeta, book?.id, search, sort, groupBy]);

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
          <FormControl size="small" sx={{ minWidth: 200 }}>
            <InputLabel>Price book</InputLabel>
            <Select label="Price book" value={bookCode} onChange={(e) => setBookCode(e.target.value)}>
              {data.books.map((b) => <MenuItem key={b.id} value={b.code}>{b.name}</MenuItem>)}
            </Select>
          </FormControl>
          <Button variant="outlined" startIcon={<Plus size={16} />} onClick={onNewBook}>New price level</Button>
          <Button variant="text" startIcon={<Pencil size={16} />} disabled={!book} onClick={() => setEditOpen(true)}>Edit name</Button>
          <Box sx={{ flex: 1 }} />
          <TextField label="% raise" size="small" value={pct} onChange={(e) => setPct(e.target.value)} sx={{ width: 100 }} />
          <TextField label="Effective" type="date" size="small" value={eff} onChange={(e) => setEff(e.target.value)} sx={{ width: 160 }} slotProps={{ inputLabel: { shrink: true } }} />
          <Button variant="contained" disabled={bulkBusy || !Number.isFinite(Number(pct))}
            onClick={async () => {
              if (!window.confirm(`Raise every ${bookCode} price by ${pct}% effective ${eff}?`)) return;
              setBulkBusy(true);
              try { const r = await bulkIncrease(Number(pct), eff, bookCode) as { updated: number }; onOk(`Raised ${r.updated} item(s)`); }
              catch (e) { onErr(e instanceof Error ? e.message : 'Bulk increase failed'); } finally { setBulkBusy(false); }
            }}>{bulkBusy ? 'Applying…' : 'Apply'}</Button>
          <Button variant="text" startIcon={<Download size={16} />} onClick={() => exportStandardCsv(data.standard)}>Export CSV</Button>
        </Stack>
      </Paper>

      {/* Add an item to this book + search / sort */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
          <Autocomplete size="small" sx={{ minWidth: 300, flex: 1 }} options={addOptions} value={addItem}
            getOptionLabel={(o) => o.name} isOptionEqualToValue={(a, b) => a.qbo_item_id === b.qbo_item_id}
            onChange={(_, v) => setAddItem(v)}
            renderInput={(p) => <TextField {...p} label={`Add item to ${bookCode}`} />} />
          <TextField label="Price" size="small" value={addPrice} onChange={(e) => setAddPrice(e.target.value)} sx={{ width: 120 }} />
          <Button variant="contained" startIcon={<Plus size={16} />}
            disabled={addBusy || !addItem || addPrice.trim() === '' || !Number.isFinite(Number(addPrice))}
            onClick={async () => {
              if (!addItem) return;
              setAddBusy(true);
              try {
                await setBookItemPrice(addItem.qbo_item_id, addItem.name, Number(addPrice), todayStr(), bookCode);
                setAddItem(null); setAddPrice(''); onOk(`Added ${addItem.name} to ${bookCode}`);
              } catch (e) { onErr(e instanceof Error ? e.message : 'Add failed'); } finally { setAddBusy(false); }
            }}>{addBusy ? 'Adding…' : 'Add'}</Button>
          <Button variant="outlined" startIcon={<ListPlus size={16} />} onClick={() => setBulkOpen(true)}>Add by family/type…</Button>
        </Stack>
        <Divider sx={{ my: 1.5 }} />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
          <TextField size="small" placeholder="Search items…" value={search} onChange={(e) => setSearch(e.target.value)} sx={{ minWidth: 240 }} />
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel>Sort</InputLabel>
            <Select label="Sort" value={sort} onChange={(e) => setSort(e.target.value as BookSort)}>
              <MenuItem value="name_asc">Name A–Z</MenuItem>
              <MenuItem value="name_desc">Name Z–A</MenuItem>
              <MenuItem value="price_asc">Price low → high</MenuItem>
              <MenuItem value="price_desc">Price high → low</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 150 }}>
            <InputLabel>Group by</InputLabel>
            <Select label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupField)}>
              <MenuItem value="family">Family</MenuItem>
              <MenuItem value="type">Type</MenuItem>
            </Select>
          </FormControl>
          <Box sx={{ flex: 1 }} />
          <Typography variant="body2" color="text.secondary">{total} item{total === 1 ? '' : 's'}</Typography>
        </Stack>
      </Paper>

      <Paper variant="outlined">
        <Table size="small" stickyHeader>
          <TableHead><TableRow><TableCell>Item</TableCell><TableCell>QBO ID</TableCell><TableCell align="right">Price</TableCell><TableCell width={48} /></TableRow></TableHead>
          <TableBody>
            {sections.map((sec) => (
              <Fragment key={sec}>
                <TableRow>
                  <TableCell colSpan={4} sx={{ bgcolor: 'action.hover', fontWeight: 700, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.8, color: 'text.secondary', py: 0.75 }}>
                    {sec} · {groups.get(sec)!.length}
                  </TableCell>
                </TableRow>
                {groups.get(sec)!.map((it) => (
                  <TableRow key={it.id} hover>
                    <TableCell>{label(it)}</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>{it.qbo_item_id}</TableCell>
                    <TableCell align="right">
                      <PriceCell value={it.unit_price} onSave={async (v) => { await setBookItemPrice(it.qbo_item_id, it.item_name, v, todayStr(), bookCode); onOk(`${label(it)} → ${usd(v)}`); }} />
                    </TableCell>
                    <TableCell align="right">
                      <IconButton size="small" title={`Remove ${label(it)} from ${bookCode}`}
                        onClick={async () => {
                          if (!window.confirm(`Remove "${label(it)}" from ${bookCode}? This drops it from the book (history included).`)) return;
                          try { await removeBookItem(it.qbo_item_id, bookCode); onOk(`Removed ${label(it)} from ${bookCode}`); }
                          catch (e) { onErr(e instanceof Error ? e.message : 'Remove failed'); }
                        }}><Trash2 size={16} /></IconButton>
                    </TableCell>
                  </TableRow>
                ))}
              </Fragment>
            ))}
            {total === 0 && (
              <TableRow><TableCell colSpan={4} sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
                {search ? 'No items match your search.' : 'No items in this book yet — add one above.'}
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>

      {editOpen && book && (
        <EditBookDialog book={book} onClose={() => setEditOpen(false)}
          onSaved={(m) => { setEditOpen(false); onOk(m); }} onErr={onErr} />
      )}
      {bulkOpen && (
        <BulkAddItemsDialog title={`Add items to ${bookCode} by family/type`} options={addOptions} itemMeta={itemMeta}
          onClose={() => setBulkOpen(false)}
          onAdd={async (items) => {
            await bulkAddBookItems(items, bookCode, todayStr());
            setBulkOpen(false); onOk(`Added ${items.length} item${items.length === 1 ? '' : 's'} to ${bookCode}`);
          }} onErr={onErr} />
      )}
    </Stack>
  );
}

function EditBookDialog({ book, onClose, onSaved, onErr }: {
  book: PriceBook; onClose: () => void; onSaved: (m: string) => void; onErr: (e: string) => void;
}) {
  const [name, setName] = useState(book.name);
  const [active, setActive] = useState(book.active);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Edit price level</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Code" size="small" value={book.code} disabled helperText="Code can't be changed once created." />
          <TextField label="Name" size="small" value={name} onChange={(e) => setName(e.target.value)} />
          <FormControlLabel control={<Switch checked={active} onChange={(e) => setActive(e.target.checked)} />} label="Active" />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true);
            try { await updatePriceBook(book.id, { name: name.trim(), active }); onSaved('Price level updated'); }
            catch (e) { onErr(e instanceof Error ? e.message : 'Update failed'); } finally { setBusy(false); }
          }}>{busy ? 'Saving…' : 'Save'}</Button>
      </DialogActions>
    </Dialog>
  );
}

/** Shared "add by family/type" bulk picker — used by both the price book and contract editors. */
function BulkAddItemsDialog({ title, options, itemMeta, onClose, onAdd, onErr }: {
  title: string;
  options: ItemOpt[];
  itemMeta: ItemMeta;
  onClose: () => void;
  onAdd: (items: BulkItemInput[]) => Promise<void>;
  onErr: (e: string) => void;
}) {
  const [family, setFamily] = useState('');
  const [type, setType] = useState('');
  const [prices, setPrices] = useState<Map<string, string>>(new Map());
  const [flat, setFlat] = useState('');
  const [busy, setBusy] = useState(false);

  const families = useMemo(() => {
    const s = new Set<string>();
    options.forEach((o) => { const f = itemMeta.get(o.qbo_item_id)?.family; if (f) s.add(f); });
    return [...s].sort();
  }, [options, itemMeta]);

  const types = useMemo(() => {
    const s = new Set<string>();
    options.forEach((o) => {
      const meta = itemMeta.get(o.qbo_item_id);
      if (!meta?.type) return;
      if (family && meta.family !== family) return;
      s.add(meta.type);
    });
    return [...s].sort();
  }, [options, itemMeta, family]);

  const filtered = useMemo(() => options
    .filter((o) => {
      const meta = itemMeta.get(o.qbo_item_id);
      if (family && meta?.family !== family) return false;
      if (type && meta?.type !== type) return false;
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name)), [options, itemMeta, family, type]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((o) => prices.has(o.qbo_item_id));
  const someFilteredSelected = filtered.some((o) => prices.has(o.qbo_item_id));

  const toggle = (id: string) => setPrices((m) => {
    const n = new Map(m);
    if (n.has(id)) n.delete(id);
    else n.set(id, itemMeta.get(id)?.unit_price != null ? String(itemMeta.get(id)!.unit_price) : '');
    return n;
  });

  const toggleAllFiltered = () => setPrices((m) => {
    const n = new Map(m);
    if (allFilteredSelected) filtered.forEach((o) => n.delete(o.qbo_item_id));
    else filtered.forEach((o) => { if (!n.has(o.qbo_item_id)) n.set(o.qbo_item_id, itemMeta.get(o.qbo_item_id)?.unit_price != null ? String(itemMeta.get(o.qbo_item_id)!.unit_price) : ''); });
    return n;
  });

  const applyFlatToSelected = () => setPrices((m) => {
    const n = new Map(m);
    [...n.keys()].forEach((id) => n.set(id, flat));
    return n;
  });

  const count = prices.size;
  const allValid = count > 0 && [...prices.values()].every((v) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0);

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={1.5}>
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel>Family</InputLabel>
              <Select label="Family" value={family} onChange={(e) => { setFamily(e.target.value); setType(''); }}>
                <MenuItem value="">All families</MenuItem>
                {families.map((f) => <MenuItem key={f} value={f}>{f}</MenuItem>)}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel>Type</InputLabel>
              <Select label="Type" value={type} onChange={(e) => setType(e.target.value)}>
                <MenuItem value="">All types</MenuItem>
                {types.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
              </Select>
            </FormControl>
            <Box sx={{ flex: 1 }} />
            <Typography variant="body2" color="text.secondary" sx={{ alignSelf: 'center' }}>{filtered.length} item{filtered.length === 1 ? '' : 's'}</Typography>
          </Stack>

          <Stack direction="row" spacing={1} alignItems="center">
            <TextField size="small" label="Set price for selected" value={flat} onChange={(e) => setFlat(e.target.value)} sx={{ width: 180 }} />
            <Button size="small" disabled={count === 0 || flat.trim() === '' || !Number.isFinite(Number(flat))} onClick={applyFlatToSelected}>
              Apply to {count} selected
            </Button>
          </Stack>

          <Paper variant="outlined" sx={{ maxHeight: 360, overflow: 'auto' }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Checkbox size="small" checked={allFilteredSelected}
                      indeterminate={!allFilteredSelected && someFilteredSelected} onChange={toggleAllFiltered} />
                  </TableCell>
                  <TableCell>Item</TableCell>
                  <TableCell align="right" width={120}>Price</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filtered.map((o) => {
                  const checked = prices.has(o.qbo_item_id);
                  return (
                    <TableRow key={o.qbo_item_id} hover>
                      <TableCell padding="checkbox"><Checkbox size="small" checked={checked} onChange={() => toggle(o.qbo_item_id)} /></TableCell>
                      <TableCell>{o.name}</TableCell>
                      <TableCell align="right">
                        <TextField size="small" disabled={!checked} value={checked ? (prices.get(o.qbo_item_id) ?? '') : ''}
                          onChange={(e) => setPrices((m) => new Map(m).set(o.qbo_item_id, e.target.value))}
                          sx={{ width: 100, '& input': { textAlign: 'right' } }} />
                      </TableCell>
                    </TableRow>
                  );
                })}
                {filtered.length === 0 && (
                  <TableRow><TableCell colSpan={3} sx={{ color: 'text.secondary', fontStyle: 'italic' }}>No matching items.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Paper>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={busy || !allValid}
          onClick={async () => {
            setBusy(true);
            try {
              const items: BulkItemInput[] = [...prices.entries()].map(([qbo_item_id, price]) => ({
                qbo_item_id, item_name: options.find((o) => o.qbo_item_id === qbo_item_id)?.name ?? null, unit_price: Number(price),
              }));
              await onAdd(items);
            } catch (e) { onErr(e instanceof Error ? e.message : 'Bulk add failed'); } finally { setBusy(false); }
          }}>{busy ? 'Adding…' : `Add ${count} item${count === 1 ? '' : 's'}`}</Button>
      </DialogActions>
    </Dialog>
  );
}

function CustomerBooksTab({ data, custName, onOk, onErr }: {
  data: PricingData; custName: Map<string, string>; onOk: (m: string) => void; onErr: (e: string) => void;
}) {
  const [addCust, setAddCust] = useState<CustomerOpt | null>(null);
  const [addBook, setAddBook] = useState<string>(data.books[0]?.id ?? '');
  const [busy, setBusy] = useState(false);

  const bookName = (id: string) => data.books.find((b) => b.id === id)?.name ?? id;
  const assigned = [...data.customerBooks].sort((a, b) =>
    (custName.get(a.qbo_customer_id) ?? a.qbo_customer_id).localeCompare(custName.get(b.qbo_customer_id) ?? b.qbo_customer_id));

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>Assign a customer to a price level</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          A customer with no contract and no assignment here gets the default BX-1 Standard
          book automatically. Assign a customer to a different price level here to move them
          off standard pricing without writing a full contract.
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
          <Autocomplete size="small" sx={{ minWidth: 300, flex: 1 }} options={data.customers} value={addCust}
            getOptionLabel={(o) => o.display_name} isOptionEqualToValue={(a, b) => a.qbo_customer_id === b.qbo_customer_id}
            onChange={(_, v) => setAddCust(v)} renderInput={(p) => <TextField {...p} label="Customer" />} />
          <FormControl size="small" sx={{ minWidth: 220 }}>
            <InputLabel>Price level</InputLabel>
            <Select label="Price level" value={addBook} onChange={(e) => setAddBook(e.target.value)}>
              {data.books.map((b) => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
            </Select>
          </FormControl>
          <Button variant="contained" startIcon={<Plus size={16} />} disabled={busy || !addCust || !addBook}
            onClick={async () => {
              if (!addCust) return;
              setBusy(true);
              try { await setCustomerPriceBook(addCust.qbo_customer_id, addBook); setAddCust(null); onOk(`${addCust.display_name} assigned to ${bookName(addBook)}`); }
              catch (e) { onErr(e instanceof Error ? e.message : 'Assign failed'); } finally { setBusy(false); }
            }}>Assign</Button>
        </Stack>
      </Paper>

      <Paper variant="outlined">
        <Table size="small">
          <TableHead><TableRow><TableCell>Customer</TableCell><TableCell>Price level</TableCell><TableCell width={160} /></TableRow></TableHead>
          <TableBody>
            {assigned.map((a) => (
              <TableRow key={a.qbo_customer_id} hover>
                <TableCell>{custName.get(a.qbo_customer_id) ?? a.qbo_customer_id}</TableCell>
                <TableCell>{bookName(a.price_book_id)}</TableCell>
                <TableCell align="right">
                  <Button size="small" onClick={async () => {
                    if (!window.confirm('Revert this customer to the default BX-1 Standard price level?')) return;
                    try { await setCustomerPriceBook(a.qbo_customer_id, null); onOk('Reverted to default'); }
                    catch (e) { onErr(e instanceof Error ? e.message : 'Revert failed'); }
                  }}>Revert to default</Button>
                </TableCell>
              </TableRow>
            ))}
            {assigned.length === 0 && (
              <TableRow><TableCell colSpan={3} sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
                No customers assigned yet — everyone is on the default BX-1 Standard price level (or a contract).
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>
    </Stack>
  );
}

function ContractEditor({ contract, data, itemMeta, custName, onOk, onErr }: {
  contract: Contract; data: PricingData; itemMeta: ItemMeta; custName: Map<string, string>;
  onOk: (m: string) => void; onErr: (e: string) => void;
}) {
  const [name, setName] = useState(contract.name);
  const [kind, setKind] = useState<ContractKind>(contract.kind);
  const [start, setStart] = useState(contract.start_date);
  const [end, setEnd] = useState(contract.end_date ?? '');
  const [active, setActive] = useState(contract.active);
  const [busy, setBusy] = useState(false);
  const [addItem, setAddItem] = useState<ItemOpt | null>(null);
  const [addItemPrice, setAddItemPrice] = useState('');
  const [addCust, setAddCust] = useState<CustomerOpt | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const guard = async (fn: () => Promise<void>) => { try { await fn(); } catch (e) { onErr(e instanceof Error ? e.message : 'Failed'); } };

  const bulkAddOptions = useMemo(() => {
    const inContract = new Set(contract.items.map((it) => it.qbo_item_id));
    return data.items.filter((o) => !inContract.has(o.qbo_item_id));
  }, [data.items, contract.items]);

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }} flexWrap="wrap">
          <TextField label="Name" size="small" value={name} onChange={(e) => setName(e.target.value)} sx={{ minWidth: 220 }} />
          <FormControl size="small" sx={{ minWidth: 150 }}>
            <InputLabel>Type</InputLabel>
            <Select label="Type" value={kind} onChange={(e) => setKind(e.target.value as ContractKind)}>
              <MenuItem value="contract">Contract</MenuItem>
              <MenuItem value="exclusivity">Exclusivity</MenuItem>
            </Select>
          </FormControl>
          <TextField label="Start" type="date" size="small" value={start} onChange={(e) => setStart(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField label="End" type="date" size="small" value={end} onChange={(e) => setEnd(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          <FormControlLabel control={<Switch checked={active} onChange={(e) => setActive(e.target.checked)} />} label="Active" />
          <Button variant="contained" disabled={busy} onClick={() => guard(async () => {
            setBusy(true);
            try { await setContractMeta(contract.id, { name, kind, start_date: start, end_date: end || null, active }); onOk('Contract saved'); }
            finally { setBusy(false); }
          })}>Save</Button>
        </Stack>
        <Divider sx={{ my: 1.5 }} />
        <ContractFile contract={contract} onOk={onOk} onErr={onErr} />
      </Paper>

      {/* Customers */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>Customers / locations ({contract.locations.length})</Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1.5 }}>
          {contract.locations.map((q) => (
            <Chip key={q} label={custName.get(q) ?? q} onDelete={() => guard(async () => { await removeContractCustomer(contract.id, q); onOk('Removed'); })} />
          ))}
          {contract.locations.length === 0 && <Typography variant="body2" color="text.secondary">None yet.</Typography>}
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Autocomplete size="small" sx={{ minWidth: 320 }} options={data.customers} value={addCust}
            getOptionLabel={(o) => o.display_name} isOptionEqualToValue={(a, b) => a.qbo_customer_id === b.qbo_customer_id}
            onChange={(_, v) => setAddCust(v)} renderInput={(p) => <TextField {...p} label="Add customer" />} />
          <Button variant="outlined" startIcon={<Plus size={16} />} disabled={!addCust}
            onClick={() => guard(async () => { if (!addCust) return; await addContractCustomer(contract.id, addCust.qbo_customer_id); setAddCust(null); onOk('Customer added'); })}>Add</Button>
        </Stack>
      </Paper>

      {/* Items */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>Contract item prices ({contract.items.length})</Typography>
        <Table size="small">
          <TableHead><TableRow><TableCell>Item</TableCell><TableCell align="right">Price</TableCell><TableCell width={48} /></TableRow></TableHead>
          <TableBody>
            {contract.items.map((it) => (
              <TableRow key={it.qbo_item_id} hover>
                <TableCell>{it.item_name ?? it.qbo_item_id}</TableCell>
                <TableCell align="right">
                  <PriceCell value={it.unit_price} onSave={async (v) => { await addContractItem(contract.id, it.qbo_item_id, it.item_name, v); onOk(`${it.item_name ?? it.qbo_item_id} → ${usd(v)}`); }} />
                </TableCell>
                <TableCell><IconButton size="small" onClick={() => guard(async () => { await removeContractItem(contract.id, it.qbo_item_id); onOk('Removed'); })}><Trash2 size={16} /></IconButton></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5 }}>
          <Autocomplete size="small" sx={{ minWidth: 320 }} options={data.items} value={addItem}
            getOptionLabel={(o) => o.name} isOptionEqualToValue={(a, b) => a.qbo_item_id === b.qbo_item_id}
            onChange={(_, v) => setAddItem(v)} renderInput={(p) => <TextField {...p} label="Add item" />} />
          <TextField label="Price" size="small" value={addItemPrice} onChange={(e) => setAddItemPrice(e.target.value)} sx={{ width: 110 }} />
          <Button variant="outlined" startIcon={<Plus size={16} />} disabled={!addItem || !Number.isFinite(Number(addItemPrice)) || addItemPrice === ''}
            onClick={() => guard(async () => {
              if (!addItem) return;
              await addContractItem(contract.id, addItem.qbo_item_id, addItem.name, Number(addItemPrice));
              setAddItem(null); setAddItemPrice(''); onOk('Item added');
            })}>Add</Button>
          <Button variant="outlined" startIcon={<ListPlus size={16} />} onClick={() => setBulkOpen(true)}>Add by family/type…</Button>
        </Stack>
      </Paper>

      {bulkOpen && (
        <BulkAddItemsDialog title="Add items to contract by family/type" options={bulkAddOptions} itemMeta={itemMeta}
          onClose={() => setBulkOpen(false)}
          onAdd={async (items) => {
            await bulkAddContractItems(contract.id, items);
            setBulkOpen(false); onOk(`Added ${items.length} item${items.length === 1 ? '' : 's'} to contract`);
          }} onErr={onErr} />
      )}
    </Stack>
  );
}

function ContractFile({ contract, onOk, onErr }: { contract: Contract; onOk: (m: string) => void; onErr: (e: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Stack direction="row" spacing={1.5} alignItems="center">
      <Typography variant="body2" color="text.secondary">Contract file:</Typography>
      <Typography variant="body2">{contract.contract_file_name ?? 'none attached'}</Typography>
      {contract.contract_file_name && (
        <Button size="small" startIcon={<Download size={16} />} onClick={async () => {
          try { const url = await contractFileUrl(contract.id); window.open(url, '_blank'); }
          catch (e) { onErr(e instanceof Error ? e.message : 'Download failed'); }
        }}>Download</Button>
      )}
      <Button size="small" component="label" startIcon={<Upload size={16} />} disabled={busy}>
        {busy ? 'Uploading…' : (contract.contract_file_name ? 'Replace' : 'Attach file')}
        <input hidden type="file" onChange={async (e) => {
          const f = e.target.files?.[0]; if (!f) return;
          setBusy(true);
          try { await uploadContractFile(contract.id, f); onOk('File attached'); }
          catch (er) { onErr(er instanceof Error ? er.message : 'Upload failed'); } finally { setBusy(false); }
        }} />
      </Button>
    </Stack>
  );
}

function NewBookDialog({ onClose, onCreated, onErr }: { onClose: () => void; onCreated: () => void; onErr: (e: string) => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>New price level</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Code (e.g. BX-2)" value={code} onChange={(e) => setCode(e.target.value)} size="small" />
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} size="small" />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={busy || !code.trim() || !name.trim()}
          onClick={async () => { setBusy(true); try { await createPriceBook(code.trim(), name.trim()); onCreated(); } catch (e) { onErr(e instanceof Error ? e.message : 'Create failed'); } finally { setBusy(false); } }}>Create</Button>
      </DialogActions>
    </Dialog>
  );
}

function NewContractDialog({ data, onClose, onCreated, onErr }: {
  data: PricingData; onClose: () => void; onCreated: (id: string) => void; onErr: (e: string) => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ContractKind>('contract');
  const [start, setStart] = useState(todayStr());
  const [end, setEnd] = useState('');
  const [custs, setCusts] = useState<CustomerOpt[]>([]);
  const [rows, setRows] = useState<Array<{ item: ItemOpt | null; price: string }>>([{ item: null, price: '' }]);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const setRow = (i: number, patch: Partial<{ item: ItemOpt | null; price: string }>) =>
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>New contract</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} size="small" fullWidth />
            <FormControl size="small" sx={{ minWidth: 150 }}>
              <InputLabel>Type</InputLabel>
              <Select label="Type" value={kind} onChange={(e) => setKind(e.target.value as ContractKind)}>
                <MenuItem value="contract">Contract</MenuItem>
                <MenuItem value="exclusivity">Exclusivity</MenuItem>
              </Select>
            </FormControl>
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField label="Start" type="date" size="small" value={start} onChange={(e) => setStart(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
            <TextField label="End" type="date" size="small" value={end} onChange={(e) => setEnd(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          </Stack>

          <Autocomplete multiple size="small" options={data.customers} value={custs}
            getOptionLabel={(o) => o.display_name} isOptionEqualToValue={(a, b) => a.qbo_customer_id === b.qbo_customer_id}
            onChange={(_, v) => setCusts(v)} renderInput={(p) => <TextField {...p} label="Customers / locations" />} />

          <Divider />
          <Typography variant="subtitle2">Item prices</Typography>
          {rows.map((row, i) => (
            <Stack key={i} direction="row" spacing={1} alignItems="center">
              <Autocomplete size="small" sx={{ flex: 1 }} options={data.items} value={row.item}
                getOptionLabel={(o) => o.name} isOptionEqualToValue={(a, b) => a.qbo_item_id === b.qbo_item_id}
                onChange={(_, v) => setRow(i, { item: v })} renderInput={(p) => <TextField {...p} label="Item" />} />
              <TextField label="Price" size="small" value={row.price} onChange={(e) => setRow(i, { price: e.target.value })} sx={{ width: 110 }} />
              <IconButton size="small" onClick={() => setRows((r) => r.filter((_, idx) => idx !== i))}><Trash2 size={16} /></IconButton>
            </Stack>
          ))}
          <Button size="small" startIcon={<Plus size={16} />} onClick={() => setRows((r) => [...r, { item: null, price: '' }])}>Add item</Button>

          <Divider />
          <Button component="label" startIcon={<Upload size={16} />} variant="outlined" sx={{ alignSelf: 'flex-start' }}>
            {file ? file.name : 'Attach contract file (optional)'}
            <input hidden type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Button>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={busy || !name.trim() || !start}
          onClick={async () => {
            setBusy(true);
            try {
              const items = rows.filter((r) => r.item && r.price.trim() !== '' && Number.isFinite(Number(r.price)))
                .map((r) => ({ qbo_item_id: r.item!.qbo_item_id, item_name: r.item!.name, unit_price: Number(r.price) }));
              const { id } = await createContract({
                name: name.trim(), kind, start_date: start, end_date: end || null,
                customers: custs.map((c) => c.qbo_customer_id), items,
              });
              if (file) await uploadContractFile(id, file);
              onCreated(id);
            } catch (e) { onErr(e instanceof Error ? e.message : 'Create failed'); } finally { setBusy(false); }
          }}>Create contract</Button>
      </DialogActions>
    </Dialog>
  );
}
