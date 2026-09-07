import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Printer } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// A print button under every table (Sky, 2026-09-04: "i need a print button on
// every table please… so i can essentially make a report of any table"), and
// then: "make the report selectable what you are going to print so it doesnt
// print everything, maybe we should make a report builder later."
//
// So Print opens a small chooser rather than printing immediately: tick the
// columns you want, optionally narrow the rows to a word, name the report, and
// print. It prints THE TABLE, not the page — the table is cloned into a clean
// white document with the title above it and the date under it.
//
// The choice is REMEMBERED per table (localStorage, keyed on the table's title),
// because a report somebody prints weekly is the same report every week and
// re-ticking eight boxes each time is how a feature stops being used.
//
// Three things the clone has to do that a plain window.print() cannot:
//   • an <input>/<select> in a cell prints as an EMPTY BOX on paper — the value
//     lives in the DOM property, not the markup — so every control is replaced
//     by its current value as text before printing;
//   • buttons, icons and the print row itself are dropped;
//   • unticked columns are removed from every row INCLUDING the header, by
//     index, so the header and the body cannot fall out of step.
// ─────────────────────────────────────────────────────────────────────────────

export interface PrintPick {
  /** Column indexes to KEEP. Undefined keeps every column. */
  columns?: number[];
  /** Keep only rows whose text contains this (case-insensitive). */
  match?: string;
}

/** The header text of each column, for the chooser. */
function columnLabels(node: HTMLElement): string[] {
  const table = node.tagName === 'TABLE' ? node : node.querySelector('table');
  const head = table?.querySelector('thead tr');
  if (!head) return [];
  return Array.from(head.children).map((th, i) => (th.textContent || '').trim() || `Column ${i + 1}`);
}

function cleanForPrint(node: HTMLElement, pick?: PrintPick): HTMLElement {
  const clone = node.cloneNode(true) as HTMLElement;

  // Controls → their values. Walk the ORIGINAL in step with the clone so the
  // live values (which a clone does not carry) land in the right cells.
  const liveControls = node.querySelectorAll('input, select, textarea');
  const cloneControls = clone.querySelectorAll('input, select, textarea');
  cloneControls.forEach((el, i) => {
    const live = liveControls[i] as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | undefined;
    let text = '';
    if (live) {
      if (live instanceof HTMLSelectElement) text = live.options[live.selectedIndex]?.text ?? '';
      else if (live instanceof HTMLInputElement && (live.type === 'checkbox' || live.type === 'radio')) text = live.checked ? '✓' : '';
      else text = live.value ?? '';
    }
    const span = document.createElement('span');
    span.textContent = text;
    el.replaceWith(span);
  });
  clone.querySelectorAll('button, svg, .tbl-print-row').forEach((el) => el.remove());

  // Rows first, then columns — dropping a column cannot change which rows match.
  const needle = (pick?.match || '').trim().toLowerCase();
  if (needle) {
    clone.querySelectorAll('tbody tr').forEach((tr) => {
      if (!(tr.textContent || '').toLowerCase().includes(needle)) tr.remove();
    });
  }
  if (pick?.columns) {
    const keep = new Set(pick.columns);
    clone.querySelectorAll('tr').forEach((tr) => {
      Array.from(tr.children).forEach((cell, i) => { if (!keep.has(i)) cell.remove(); });
    });
  }
  return clone;
}

/** Print one element (a table or a card) as its own document. */
export function printElement(node: HTMLElement | null, title: string, subtitle?: string, pick?: PrintPick): void {
  if (!node) return;
  const tables = node.tagName === 'TABLE' ? [node] : Array.from(node.querySelectorAll('table'));
  // A column pick describes ONE table's columns, so it is applied only when
  // there is exactly one — on a card holding several, it would cut the wrong
  // columns out of the others.
  const single = tables.length === 1;
  const body = (tables.length ? tables : [node])
    .map((t) => cleanForPrint(t as HTMLElement, single ? pick : { match: pick?.match }).outerHTML)
    .join('<div style="height:18px"></div>');
  const w = window.open('', '_blank', 'width=1100,height=800');
  if (!w) return;   // pop-up blocked — nothing to fall back to that isn't worse
  const stamp = new Date().toLocaleString('en-US');
  const narrowed = pick?.match ? ` · rows matching “${pick.match}”` : '';
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page { size: letter landscape; margin: 0.45in }
    body { font-family: 'DM Sans', system-ui, -apple-system, sans-serif; color: #0a0e17; margin: 0; padding: 18px 22px }
    h1 { font-size: 17px; margin: 0 0 2px 0; letter-spacing: 0.2px }
    .sub { font-size: 10.5px; color: #64748b; margin-bottom: 12px; border-bottom: 2px solid #1F4E79; padding-bottom: 8px }
    table { width: 100%; border-collapse: collapse; font-size: 10.5px; margin-bottom: 10px }
    thead { display: table-header-group }
    tr { page-break-inside: avoid }
    th { background: #f1f5f9; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.8px; color: #475569;
         text-align: left; padding: 5px 7px; border-bottom: 1px solid #cbd5e1 }
    td { padding: 4px 7px; border-bottom: 1px solid #e2e8f0; vertical-align: top }
    tfoot td { font-weight: 700; border-top: 2px solid #1F4E79 }
    a { color: inherit; text-decoration: none }
    .foot { margin-top: 14px; font-size: 9px; color: #94a3b8 }
  </style></head><body>
    <h1>${esc(title)}</h1>
    <div class="sub">${esc(subtitle ?? '')}${subtitle ? ' · ' : ''}Printed ${esc(stamp)}${esc(narrowed)} · BRIX Refractor</div>
    ${body}
    <div class="foot">Alameda Beverage Group · Brix Beverage</div>
    <script>setTimeout(function(){ window.print(); }, 250);<\/script>
  </body></html>`);
  w.document.close();
}

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Wrap a table to get a "Print" chooser under it. The title defaults to the
 * nearest heading above the table (a card title, then the page's hero title),
 * so a printed report says which table it is without every call site naming it.
 */
export function PrintableTable({ title, subtitle, children }: {
  title?: string; subtitle?: string; children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [cols, setCols] = useState<string[]>([]);
  const [keep, setKeep] = useState<boolean[]>([]);
  const [match, setMatch] = useState('');
  const [name, setName] = useState('');

  function derivedTitle(): string {
    if (title) return title;
    const el = box.current;
    const card = el?.closest('.cd') as HTMLElement | null;
    const cardTitle = card?.querySelector('.ct')?.textContent?.trim();
    const hero = document.querySelector('.hero-title')?.textContent?.trim();
    return [hero, cardTitle].filter(Boolean).join(' — ') || 'Report';
  }

  const storeKey = `brix.print.cols.${derivedTitle()}`;

  // Read the headers when the chooser opens — a table's columns can change with
  // a view toggle or a lane filter, so they are read fresh rather than once.
  function openChooser() {
    const labels = columnLabels(box.current!);
    setCols(labels);
    let remembered: boolean[] | null = null;
    try {
      const raw = localStorage.getItem(storeKey);
      const parsed = raw ? JSON.parse(raw) : null;
      // Only honour a remembered pick that still fits the table's shape.
      if (Array.isArray(parsed) && parsed.length === labels.length) remembered = parsed.map(Boolean);
    } catch { /* a private window throws on localStorage — print everything */ }
    setKeep(remembered ?? labels.map(() => true));
    setName(derivedTitle());
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function doPrint() {
    try { localStorage.setItem(storeKey, JSON.stringify(keep)); } catch { /* not worth failing a print over */ }
    const columns = cols.length ? keep.map((k, i) => (k ? i : -1)).filter((i) => i >= 0) : undefined;
    printElement(box.current, name.trim() || derivedTitle(), subtitle, { columns, match });
    setOpen(false);
  }

  const kept = keep.filter(Boolean).length;

  return (
    <div ref={box} style={{ position: 'relative' }}>
      {children}
      <div className="tbl-print-row" style={{ display: 'flex', justifyContent: 'flex-end', padding: '4px 8px 8px' }}>
        <button
          type="button"
          onClick={openChooser}
          title="Choose what to print, then print this table as its own report"
          style={btn}
        >
          <Printer size={11} strokeWidth={2.2} aria-hidden="true" /> Print
        </button>
      </div>

      {open && (
        <>
          {/* Click anywhere else to close. */}
          <div onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(2,6,16,0.35)' }} />
          <div style={{
            position: 'absolute', right: 8, bottom: 34, zIndex: 41, width: 320, maxHeight: '70vh',
            overflowY: 'auto', background: 'var(--cd, #0f172a)', border: '1px solid var(--bd, #1e293b)',
            borderRadius: 6, padding: 12, boxShadow: '0 12px 34px rgba(0,0,0,0.45)',
          }}>
            <div style={{ fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--mt)', marginBottom: 8 }}>
              What to print
            </div>

            <label style={lbl}>Report title</label>
            <input value={name} onChange={(e) => setName(e.target.value)} style={field} />

            <label style={{ ...lbl, marginTop: 10 }}>Only rows containing (optional)</label>
            <input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="e.g. a flavour, a code"
              style={field} />

            {cols.length > 0 && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '12px 0 5px' }}>
                  <label style={{ ...lbl, margin: 0 }}>Columns ({kept} of {cols.length})</label>
                  <button type="button" onClick={() => setKeep(cols.map(() => kept !== cols.length))} style={linkBtn}>
                    {kept === cols.length ? 'None' : 'All'}
                  </button>
                </div>
                <div style={{ display: 'grid', gap: 2 }}>
                  {cols.map((c, i) => (
                    <label key={i} style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 11.5, cursor: 'pointer' }}>
                      <input type="checkbox" checked={!!keep[i]}
                        onChange={(e) => setKeep(keep.map((k, j) => (j === i ? e.target.checked : k)))} />
                      <span style={{ color: keep[i] ? 'var(--tx)' : 'var(--mt)' }}>{c}</span>
                    </label>
                  ))}
                </div>
              </>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              <button type="button" onClick={() => setOpen(false)} style={btn}>Cancel</button>
              <button type="button" onClick={doPrint} disabled={cols.length > 0 && kept === 0}
                style={{ ...btn, borderColor: 'var(--ac, #3B82F6)', color: 'var(--ac, #3B82F6)',
                         opacity: cols.length > 0 && kept === 0 ? 0.4 : 1 }}>
                <Printer size={11} strokeWidth={2.2} aria-hidden="true" /> Print
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const btn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, background: 'transparent',
  border: '1px solid var(--ctl-bd)', color: 'var(--mt)', borderRadius: 4,
  padding: '3px 8px', fontSize: 9.5, letterSpacing: 0.5, textTransform: 'uppercase',
  fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
};
const lbl: React.CSSProperties = {
  display: 'block', fontSize: 9, letterSpacing: 0.6, textTransform: 'uppercase',
  color: 'var(--mt)', marginBottom: 4,
};
const field: React.CSSProperties = {
  width: '100%', background: 'var(--ctl-bg, #0b1220)', border: '1px solid var(--ctl-bd, #1e293b)',
  color: 'var(--tx)', borderRadius: 4, padding: '5px 7px', fontSize: 12, fontFamily: 'inherit',
};
const linkBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: 'var(--ac, #3B82F6)', cursor: 'pointer',
  fontSize: 9.5, letterSpacing: 0.5, textTransform: 'uppercase', fontWeight: 600, padding: 0, fontFamily: 'inherit',
};
