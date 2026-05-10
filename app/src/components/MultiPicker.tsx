import { useMemo } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';

interface Props {
  label: string;
  values: string[];
  options: { label: string; revenue?: number | null }[] | null;
  loading?: boolean;
  onChange: (next: string[]) => void;
  placeholder?: string;
  showRevenue?: boolean;
  /** Optional taxonomy classifier — when provided, options are grouped by
   *  the returned string in the dropdown. */
  groupBy?: (label: string) => string;
  /** Optional rank map controlling group display order (lower = earlier). */
  groupOrder?: Record<string, number>;
}

function fmtCompact(v: number): string {
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'k';
  return '$' + Math.round(v).toString();
}

export function MultiPicker({
  label,
  values,
  options,
  loading,
  onChange,
  placeholder,
  showRevenue = true,
  groupBy,
  groupOrder,
}: Props) {
  const labels = useMemo(() => options?.map((o) => o.label) ?? [], [options]);
  const revenueByLabel = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of options ?? []) {
      if (o.revenue != null) m.set(o.label, Number(o.revenue));
    }
    return m;
  }, [options]);

  const allOptions = useMemo(() => {
    const set = new Set(labels);
    for (const v of values) set.add(v);
    return Array.from(set);
  }, [labels, values]);

  function groupRank(label: string): number {
    if (!groupBy) return 0;
    const g = groupBy(label);
    return groupOrder?.[g] ?? 999;
  }

  return (
    <Autocomplete
      multiple
      size="small"
      disablePortal={false}
      sx={{
        minWidth: 220,
        maxWidth: 380,
        '& .MuiInputBase-root': {
          background: 'var(--bg)',
          fontFamily: 'inherit',
          fontSize: 12,
          color: 'var(--tx)',
          paddingTop: '2px !important',
          paddingBottom: '2px !important',
          paddingLeft: '8px !important',
        },
        '& .MuiOutlinedInput-notchedOutline': {
          borderColor: 'var(--bd)',
          transition: 'border-color 120ms ease',
        },
        '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--bd2)' },
        '& .Mui-focused .MuiOutlinedInput-notchedOutline': {
          borderColor: 'var(--ac) !important',
          borderWidth: 1,
        },
        '& .MuiInputLabel-root': {
          fontFamily: 'inherit',
          fontSize: 11,
          color: 'var(--mt)',
          textTransform: 'uppercase',
          letterSpacing: 0.8,
          fontWeight: 600,
        },
        '& .MuiInputLabel-root.Mui-focused': { color: 'var(--ac)' },
        '& .MuiInputBase-input': {
          fontFamily: 'inherit',
          color: 'var(--tx)',
          padding: '4px 4px !important',
          '&::placeholder': { color: 'var(--mt)', opacity: 0.55 },
        },
        '& .MuiSvgIcon-root': { color: 'var(--mt)' },
      }}
      options={allOptions}
      value={values}
      loading={loading}
      onChange={(_, next) => onChange(next as string[])}
      isOptionEqualToValue={(opt, val) => opt === val}
      groupBy={groupBy}
      filterOptions={(opts, state) => {
        const q = state.inputValue.trim().toLowerCase();
        const list = q ? opts.filter((o) => o.toLowerCase().includes(q)) : opts;
        return list.slice().sort((a, b) => {
          // 1. Selected first
          const aSel = values.includes(a) ? 1 : 0;
          const bSel = values.includes(b) ? 1 : 0;
          if (aSel !== bSel) return bSel - aSel;
          // 2. Group rank (taxonomy order) so related rows cluster together
          if (groupBy) {
            const aR = groupRank(a);
            const bR = groupRank(b);
            if (aR !== bR) return aR - bR;
          }
          // 3. Revenue descending within group
          const aRev = revenueByLabel.get(a) ?? 0;
          const bRev = revenueByLabel.get(b) ?? 0;
          if (aRev !== bRev) return bRev - aRev;
          // 4. Alpha fallback
          return a.localeCompare(b);
        }).slice(0, 300);
      }}
      noOptionsText={loading ? 'Loading…' : 'No matches.'}
      loadingText="Loading…"
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          placeholder={values.length === 0 ? (placeholder ?? 'Any') : ''}
          variant="outlined"
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <>
                {loading ? <CircularProgress size={13} sx={{ color: 'var(--ac)', mr: 0.5 }} /> : null}
                {params.InputProps.endAdornment}
              </>
            ),
          }}
        />
      )}
      renderTags={(value, getTagProps) =>
        value.map((option, index) => {
          const tagProps = getTagProps({ index });
          return (
            <Chip
              {...tagProps}
              key={option}
              label={option}
              size="small"
              sx={{
                height: 20,
                fontSize: 11,
                fontFamily: 'inherit',
                background: 'rgba(91, 181, 240, 0.12)',
                border: '1px solid rgba(91, 181, 240, 0.40)',
                color: 'var(--ac)',
                maxWidth: 200,
                '& .MuiChip-label': {
                  paddingLeft: '8px', paddingRight: '4px',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                },
                '& .MuiChip-deleteIcon': { color: 'var(--ac)', fontSize: 14, marginRight: '3px' },
                '& .MuiChip-deleteIcon:hover': { color: 'var(--rd)' },
              }}
            />
          );
        })
      }
      renderOption={(props, option) => {
        const rev = revenueByLabel.get(option);
        const selected = values.includes(option);
        const { key, ...optProps } = props as React.HTMLAttributes<HTMLLIElement> & { key?: string };
        return (
          <li
            {...optProps}
            key={option}
            style={{
              ...optProps.style,
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', fontSize: 12,
              color: selected ? 'var(--ac)' : 'var(--tx)',
              fontWeight: selected ? 600 : 400,
            }}
          >
            <input type="checkbox" checked={selected} readOnly style={{ accentColor: 'var(--ac)', margin: 0 }} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option}</span>
            {showRevenue && rev != null && rev > 0 && (
              <span className="mn" style={{ fontSize: 10, color: 'var(--mt)', fontFamily: 'var(--ff-mono)', marginLeft: 8 }}>
                {fmtCompact(rev)}
              </span>
            )}
          </li>
        );
      }}
      slotProps={{
        paper: {
          sx: {
            background: 'var(--sf)',
            border: '1px solid var(--bd)',
            borderRadius: 2,
            color: 'var(--tx)',
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.5)',
            '& .MuiAutocomplete-groupLabel': {
              background: 'rgba(20, 57, 102, 0.65)',
              backdropFilter: 'blur(10px)',
              color: 'var(--ac)',
              fontFamily: 'var(--ff-body)',
              fontSize: 9,
              letterSpacing: 1.4,
              textTransform: 'uppercase',
              fontWeight: 700,
              padding: '6px 12px',
              lineHeight: 1.4,
              borderBottom: '1px solid rgba(91, 181, 240, 0.15)',
              position: 'sticky',
              top: 0,
              zIndex: 1,
            },
            '& .MuiAutocomplete-option': { borderBottom: '1px solid rgba(255, 255, 255, 0.04)' },
            '& .MuiAutocomplete-option:hover, & .MuiAutocomplete-option.Mui-focused': {
              background: 'rgba(91, 181, 240, 0.08) !important',
            },
            '& .MuiAutocomplete-option[aria-selected="true"]': {
              background: 'rgba(91, 181, 240, 0.16) !important',
            },
            '& .MuiAutocomplete-option[aria-selected="true"].Mui-focused': {
              background: 'rgba(91, 181, 240, 0.22) !important',
            },
            '& .MuiAutocomplete-noOptions, & .MuiAutocomplete-loading': {
              color: 'var(--mt)', fontSize: 11, fontFamily: 'inherit',
            },
          },
        },
        popper: { sx: { zIndex: 1300 } },
      }}
    />
  );
}
