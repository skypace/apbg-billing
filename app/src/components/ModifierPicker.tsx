import { useMemo } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Chip from '@mui/material/Chip';
import { CHAIN_MODIFIERS, type ChainModifier } from '../lib/chainModifiers';

interface Props {
  active: string[];
  onChange: (next: string[]) => void;
}

// Compact rollup picker — same prop API and visual treatment as MultiPicker
// so it sits inline with the Category / Customer / Item / Channel / Segment
// filters. Options grouped by sales type (Equipment & Service / Soda Sales).
// Each option renders as: [CODE] — Full name
export function ModifierPicker({ active, onChange }: Props) {
  const byCode = useMemo(() => {
    const m = new Map<string, ChainModifier>();
    for (const c of CHAIN_MODIFIERS) m.set(c.code, c);
    return m;
  }, []);

  const codes = useMemo(() => CHAIN_MODIFIERS.map((m) => m.code), []);

  return (
    <Autocomplete
      multiple
      size="small"
      disablePortal={false}
      sx={{
        minWidth: 220,
        maxWidth: 380,
        '& .MuiInputBase-root': {
          background: 'var(--ctl-bg)',
          fontFamily: 'inherit',
          fontSize: 12,
          color: 'var(--tx)',
          paddingTop: '2px !important',
          paddingBottom: '2px !important',
          paddingLeft: '8px !important',
        },
        '& .MuiOutlinedInput-notchedOutline': {
          borderColor: 'var(--ctl-bd)',
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
      options={codes}
      value={active}
      onChange={(_, next) => onChange(next as string[])}
      isOptionEqualToValue={(opt, val) => opt === val}
      groupBy={(opt) => {
        const m = byCode.get(opt);
        return m?.group === 'soda' ? 'Soda Sales' : 'Equipment & Service';
      }}
      getOptionLabel={(opt) => byCode.get(opt)?.label ?? opt}
      renderInput={(params) => (
        <TextField
          {...params}
          label="Rollup"
          placeholder={active.length === 0 ? 'Any' : ''}
          variant="outlined"
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
                fontFamily: 'var(--ff-display)',
                fontWeight: 700,
                letterSpacing: 0.5,
                background: 'rgba(91, 181, 240, 0.12)',
                border: '1px solid rgba(91, 181, 240, 0.40)',
                color: 'var(--ac)',
                '& .MuiChip-label': { paddingLeft: '8px', paddingRight: '4px' },
                '& .MuiChip-deleteIcon': { color: 'var(--ac)', fontSize: 14, marginRight: '3px' },
                '& .MuiChip-deleteIcon:hover': { color: 'var(--rd)' },
              }}
            />
          );
        })
      }
      renderOption={(props, option) => {
        const m = byCode.get(option);
        const selected = active.includes(option);
        const { key, ...optProps } = props as React.HTMLAttributes<HTMLLIElement> & { key?: string };
        return (
          <li
            {...optProps}
            key={option}
            style={{
              ...optProps.style,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '6px 10px',
              fontSize: 12,
              color: selected ? 'var(--ac)' : 'var(--tx)',
              fontWeight: selected ? 600 : 400,
            }}
          >
            <input
              type="checkbox"
              checked={selected}
              readOnly
              style={{ accentColor: 'var(--ac)', margin: 0 }}
            />
            <span
              style={{
                fontFamily: 'var(--ff-display)',
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: 0.5,
                color: 'var(--ac)',
                minWidth: 32,
              }}
            >
              {option}
            </span>
            <span style={{ flex: 1, color: selected ? 'var(--ac)' : 'var(--tx)' }}>
              {m?.label ?? option}
            </span>
            {!m?.parent && (
              <span
                style={{
                  fontSize: 9,
                  color: 'var(--mt)',
                  fontFamily: 'var(--ff-mono)',
                  letterSpacing: 0.3,
                  textTransform: 'uppercase',
                }}
              >
                rollup
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
              background: 'rgba(20, 57, 102, 0.40)',
              color: 'var(--mt)',
              fontFamily: 'var(--ff-body)',
              fontSize: 9,
              letterSpacing: 1.2,
              textTransform: 'uppercase',
              fontWeight: 700,
              padding: '6px 10px',
              lineHeight: 1.4,
            },
            '& .MuiAutocomplete-option:hover, & .MuiAutocomplete-option.Mui-focused': {
              background: 'rgba(91, 181, 240, 0.08) !important',
            },
            '& .MuiAutocomplete-option[aria-selected="true"]': {
              background: 'rgba(91, 181, 240, 0.16) !important',
            },
          },
        },
        popper: { sx: { zIndex: 1300 } },
      }}
    />
  );
}
