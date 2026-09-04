import {
  GridToolbarContainer, GridToolbarColumnsButton, GridToolbarFilterButton,
  GridToolbarDensitySelector, GridToolbarExport, useGridApiContext,
  gridFilteredSortedRowIdsSelector,
} from '@mui/x-data-grid-pro';
import { Printer } from 'lucide-react';

/**
 * The standard grid toolbar plus an explicit PRINT button (Sky, 2026-09-04:
 * "i need a print button on every table"). Print lives inside the Export menu
 * by default, which nobody finds.
 *
 * ⚠ It calls the grid's OWN print export, not window.print(): a DataGrid
 * virtualises its rows, so printing the page prints only what is on screen.
 * exportDataAsPrint renders every row first — which is what makes this a
 * report of the table rather than a picture of the viewport.
 *
 * Selectable, per Sky's follow-up ("make the report selectable what you are
 * going to print so it doesnt print everything"): the grid already has the two
 * controls, so this uses them rather than adding a third.
 *   • ROWS — ticked rows if any are ticked, otherwise everything the current
 *     filter leaves (never the raw table behind a filter, which is the
 *     surprising answer).
 *   • COLUMNS — `allColumns: false` prints the columns that are switched on in
 *     the Columns menu, so hiding a column hides it on paper too.
 * The button says which of those it is about to do.
 */
export function GridToolbarWithPrint() {
  const apiRef = useGridApiContext();

  function print() {
    // getSelectedRows is the stable public API — the selection SELECTOR has
    // changed shape between MUI X versions, and this one only needs the ids.
    const picked = Array.from(apiRef.current.getSelectedRows().keys());
    apiRef.current.exportDataAsPrint({
      hideFooter: true,
      hideToolbar: true,
      allColumns: false,
      // Undefined means "the grid's default", which is every filtered row.
      getRowsToExport: picked.length
        ? () => picked
        : ({ apiRef: ref }) => gridFilteredSortedRowIdsSelector(ref),
    });
  }

  const selectedCount = (() => {
    try { return apiRef.current.getSelectedRows().size; } catch { return 0; }
  })();

  return (
    <GridToolbarContainer>
      <GridToolbarColumnsButton />
      <GridToolbarFilterButton />
      <GridToolbarDensitySelector />
      <GridToolbarExport />
      <button
        type="button"
        onClick={print}
        title={selectedCount
          ? `Print the ${selectedCount} selected row${selectedCount === 1 ? '' : 's'}, with the columns you have switched on`
          : 'Print every row the current filter shows, with the columns you have switched on. Tick rows to print only those.'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, background: 'transparent',
          border: 'none', color: 'var(--tx2)', cursor: 'pointer', fontFamily: 'inherit',
          fontSize: 11, fontWeight: 600, letterSpacing: 0.2, padding: '4px 8px', borderRadius: 4,
        }}
      >
        <Printer size={13} strokeWidth={2.2} aria-hidden="true" />
        {selectedCount ? `PRINT ${selectedCount}` : 'PRINT'}
      </button>
    </GridToolbarContainer>
  );
}
