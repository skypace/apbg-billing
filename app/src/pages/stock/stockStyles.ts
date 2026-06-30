import type { SxProps } from '@mui/material/styles';

// Shared grid skin lives in lib/gridStyles — re-exported so the existing
// `import { GRID_SX } from './stockStyles'` call sites keep working.
export { GRID_SX, GRID_DEFAULTS } from '../../lib/gridStyles';

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

export const STATUS_COLOR: Record<string, string> = {
  draft:       'var(--mt)',
  in_transit:  'var(--am)',
  received:    'var(--gn)',
  void:        '#64748b',
};
