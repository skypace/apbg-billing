/**
 * Print whatever is on screen. styles/print.css hides the sidebar, toolbars and
 * grid chrome and lets the cards run down the page. ⚠ A DataGrid prints only
 * the rows it has rendered (it virtualises); for EVERY row of a grid use the
 * grid's own toolbar → Export → Print, which renders the whole table first.
 * Plain tables (weekly forecast, customers due, fill plan, plans, the repack
 * sheet) print complete from here.
 */
export function printPage(): void {
  try { window.print(); } catch { /* a kiosk with no print handler */ }
}
