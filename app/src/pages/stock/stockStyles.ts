import type { SxProps } from '@mui/material/styles';

export const TABS_SX: SxProps = {
  minHeight: 36,
  mb: 1.5,
  borderBottom: '1px solid var(--bd)',
  '& .MuiTabs-indicator': { background: 'var(--ac)', height: 2 },
  '& .MuiTab-root': {
    minHeight: 36,
    padding: '6px 18px',
    textTransform: 'uppercase',
    color: 'var(--mt)',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.6,
    fontFamily: 'inherit',
  },
  '& .Mui-selected': { color: 'var(--ac) !important' },
};

export const GRID_SX: SxProps = {
  height: '64vh',
  border: 'none',
  background: 'transparent',
  color: 'var(--ink)',
  fontFamily: 'inherit',
  fontSize: 12,
  '--DataGrid-rowBorderColor': 'rgba(255,255,255,0.04)',
  '--DataGrid-containerBackground': 'var(--sf)',
  '& .MuiDataGrid-columnHeaders': {
    background: 'var(--sf)',
    borderBottom: '1px solid var(--bd)',
  },
  '& .MuiDataGrid-columnHeader': {
    fontWeight: 600,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    fontSize: 10.5,
    color: 'var(--mt)',
  },
  '& .MuiDataGrid-columnHeader:focus, & .MuiDataGrid-columnHeader:focus-within': { outline: 'none' },
  '& .MuiDataGrid-cell': {
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    py: 0.5,
  },
  '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': { outline: 'none' },
  '& .MuiDataGrid-row:hover': { background: 'rgba(91, 181, 240, 0.05)' },
  '& .MuiDataGrid-footerContainer': {
    borderTop: '1px solid var(--bd)',
    background: 'var(--sf)',
    minHeight: 40,
  },
  '& .MuiTablePagination-root': {
    color: 'var(--tx)',
    fontFamily: 'inherit',
    fontSize: 12,
  },
  '& .MuiTablePagination-selectLabel, & .MuiTablePagination-displayedRows': {
    color: 'var(--mt)',
    fontSize: 11,
    fontFamily: 'inherit',
    letterSpacing: 0.3,
  },
  '& .MuiTablePagination-select': {
    color: 'var(--ac)',
    fontWeight: 700,
    fontFamily: 'var(--ff-mono)',
    fontSize: 12,
  },
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
  '& .MuiDataGrid-scrollbar::-webkit-scrollbar-thumb': {
    background: 'rgba(91, 181, 240, 0.20)',
    borderRadius: 6,
  },
};

export const STATUS_COLOR: Record<string, string> = {
  draft:       'var(--mt)',
  in_transit:  'var(--am)',
  received:    'var(--gn)',
  void:        '#64748b',
};
