import {
  DataGridPro,
  type GridColDef,
  type GridPinnedColumnFields,
  type GridSortModel,
  type GridValidRowModel,
} from '@mui/x-data-grid-pro';

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
      pageSizeOptions={[10, 20, 40, 60, 100, { value: -1, label: 'All' }]}
      initialState={{
        pagination: { paginationModel: { pageSize: defaultPageSize, page: 0 } },
        pinnedColumns,
        sorting: { sortModel: defaultSort ?? [] },
      }}
      sx={{
        height,
        border: 'none', background: 'transparent', color: 'var(--ink)',
        fontFamily: 'inherit', fontSize: 12,
        '--DataGrid-rowBorderColor': 'rgba(255,255,255,0.04)',
        '--DataGrid-containerBackground': 'var(--sf)',
        '& .MuiDataGrid-columnHeaders': { background: 'var(--sf)', borderBottom: '1px solid var(--bd)' },
        '& .MuiDataGrid-columnHeader': {
          fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase',
          fontSize: 10.5, color: 'var(--mt)',
        },
        '& .MuiDataGrid-columnHeader:focus, & .MuiDataGrid-columnHeader:focus-within': { outline: 'none' },
        '& .MuiDataGrid-cell': { borderBottom: '1px solid rgba(255,255,255,0.04)', py: 0.5 },
        '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': { outline: 'none' },
        '& .MuiDataGrid-row:hover': { background: 'rgba(91, 181, 240, 0.05)' },
        '& .MuiDataGrid-pinnedColumns': { background: 'var(--sf)', boxShadow: '4px 0 12px rgba(0,0,0,0.35)' },
        '& .MuiDataGrid-pinnedColumnHeaders': { background: 'var(--sf)' },
        '& .MuiDataGrid-footerContainer': { borderTop: '1px solid var(--bd)', background: 'var(--sf)', minHeight: 40 },
        '& .MuiTablePagination-root': { color: 'var(--tx)', fontFamily: 'inherit', fontSize: 12 },
        '& .MuiTablePagination-selectLabel, & .MuiTablePagination-displayedRows': {
          color: 'var(--mt)', fontSize: 11, fontFamily: 'inherit', letterSpacing: 0.3,
        },
        '& .MuiTablePagination-select': { color: 'var(--ac)', fontWeight: 700, fontFamily: 'var(--ff-mono)', fontSize: 12 },
        '& .MuiTablePagination-actions .MuiIconButton-root': {
          color: 'var(--tx2)',
          '&:hover': { background: 'rgba(91, 181, 240, 0.08)', color: 'var(--ac)' },
          '&.Mui-disabled': { color: 'var(--mt)', opacity: 0.4 },
        },
        '& .MuiDataGrid-overlay': { background: 'var(--sf)', color: 'var(--mt)' },
        '& .mn': { fontFeatureSettings: '"tnum" on, "lnum" on' },
        '& .MuiDataGrid-menuIconButton, & .MuiDataGrid-sortIcon': { color: 'var(--mt)' },
        '& .MuiDataGrid-columnSeparator': { color: 'rgba(255,255,255,0.06)' },
        '& .MuiDataGrid-scrollbar': { background: 'transparent' },
        '& .MuiDataGrid-scrollbar::-webkit-scrollbar': { width: 10, height: 10 },
        '& .MuiDataGrid-scrollbar::-webkit-scrollbar-thumb': { background: 'rgba(91, 181, 240, 0.20)', borderRadius: 6 },
      }}
    />
  );
}
