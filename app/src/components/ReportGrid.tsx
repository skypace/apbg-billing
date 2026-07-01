import {
  DataGridPro,
  type GridColDef,
  type GridPinnedColumnFields,
  type GridSortModel,
  type GridValidRowModel,
} from '@mui/x-data-grid-pro';
import { GRID_SX, GRID_DEFAULTS } from '../lib/gridStyles';

interface Props {
  // Use GridValidRowModel (= Record<string, any>) so concrete row interfaces
  // can be passed in without requiring an explicit string index signature.
  rows: readonly GridValidRowModel[];
  columns: GridColDef[];
  pinnedLeft?: string[];
  defaultSort?: GridSortModel;
  defaultPageSize?: number;
  height?: string;
}

/** Shared DataGridPro skin for every report in the Reports tab.
 *  Matches the look used by Customers / Operations / Margin grids. */
export function ReportGrid({
  rows, columns, pinnedLeft, defaultSort, defaultPageSize = 20, height = '58vh',
}: Props) {
  const pinnedColumns: GridPinnedColumnFields = pinnedLeft ? { left: pinnedLeft } : {};
  return (
    <DataGridPro
      rows={rows}
      columns={columns}
      density="compact"
      pagination
      disableRowSelectionOnClick
      {...GRID_DEFAULTS}
      pageSizeOptions={[10, 20, 40, 60, 100, { value: -1, label: 'All' }]}
      initialState={{
        pagination: { paginationModel: { pageSize: defaultPageSize, page: 0 } },
        pinnedColumns,
        sorting: { sortModel: defaultSort ?? [] },
      }}
      sx={{ ...GRID_SX, height }}
    />
  );
}
