import type { SxProps } from '@mui/material/styles';
import { GridToolbar } from '@mui/x-data-grid-pro';

// ─────────────────────────────────────────────────────────────────────────────
// Shared DataGridPro skin + default props for EVERY table in Refractor.
//
// Goal: every grid behaves the same — column sort (MUI default), column
// drag-reorder (MUI default), column resize (MUI default), a column selector +
// density/export via the toolbar, and subtle column separator lines that show
// in BOTH themes.
//
// Lines are token-driven (`--col-line`): a near-invisible light-grey hairline on
// light, a faint white hairline on dark — present but quiet. Previously these
// were hardcoded `rgba(255,255,255,…)`, so they vanished on the light canvas.
// ─────────────────────────────────────────────────────────────────────────────

export const GRID_SX: SxProps = {
  height: '64vh',
  border: 'none',
  background: 'transparent',
  color: 'var(--tx)',
  fontFamily: 'inherit',
  fontSize: 12,
  '--DataGrid-rowBorderColor': 'var(--col-line)',
  '--DataGrid-containerBackground': 'var(--sf)',

  // Toolbar (column selector / filters / density / export)
  '& .MuiDataGrid-toolbarContainer': {
    padding: '6px 8px',
    gap: '2px',
    borderBottom: '1px solid var(--bd)',
    '& .MuiButton-root': {
      color: 'var(--tx2)',
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: 0.2,
    },
    '& .MuiButton-root:hover': { color: 'var(--ac)', background: 'rgba(91,181,240,0.08)' },
  },

  // Header row
  '& .MuiDataGrid-columnHeaders': { background: 'var(--sf)', borderBottom: '1px solid var(--bd)' },
  '& .MuiDataGrid-columnHeader': {
    fontWeight: 600,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    fontSize: 10.5,
    color: 'var(--mt)',
    borderRight: '1px solid var(--col-line)',
  },
  '& .MuiDataGrid-columnHeader:focus, & .MuiDataGrid-columnHeader:focus-within': { outline: 'none' },

  // Cells — subtle horizontal + vertical separators
  '& .MuiDataGrid-cell': {
    borderBottom: '1px solid var(--col-line)',
    borderRight: '1px solid var(--col-line)',
    py: 0.5,
  },
  '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': { outline: 'none' },
  '& .MuiDataGrid-row:hover': { background: 'rgba(91, 181, 240, 0.06)' },

  // Pinned columns
  '& .MuiDataGrid-pinnedColumns': { background: 'var(--sf)', boxShadow: '4px 0 12px rgba(0,0,0,0.18)' },
  '& .MuiDataGrid-pinnedColumnHeaders': { background: 'var(--sf)' },

  // Footer + pagination
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

  // Column separators (drag-resize handles) — quiet, accent on hover
  '& .MuiDataGrid-columnSeparator': { color: 'var(--col-line)' },
  '& .MuiDataGrid-columnSeparator:hover': { color: 'var(--ac)' },

  '& .MuiDataGrid-scrollbar': { background: 'transparent' },
  '& .MuiDataGrid-scrollbar::-webkit-scrollbar': { width: 10, height: 10 },
  '& .MuiDataGrid-scrollbar::-webkit-scrollbar-thumb': { background: 'rgba(91, 181, 240, 0.20)', borderRadius: 6 },
};

// Spread onto every <DataGridPro> so they all expose the same toolbar (column
// selector + density + export). Column sort / reorder / resize are on by default
// in DataGridPro, so no extra props are needed for those. Per-grid props placed
// AFTER this spread still win.
export const GRID_DEFAULTS = {
  slots: { toolbar: GridToolbar },
  slotProps: { toolbar: { showQuickFilter: false } },
};
