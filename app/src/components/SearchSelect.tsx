import { useMemo } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import type { CSSProperties } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// SearchSelect — the one picker for a long list.
//
// Sky (2026-09-04): "when i make a transfer order, i need to be able to have
// the box prepop a search from what im typing rather than just pulling down an
// item. can it be both. a little smartness in it. I need this on every form im
// typing." So: a text box you can TYPE into that narrows the list as you go
// (contains-match, case-insensitive, across the whole label — "root" finds
// "24P126574 OAKTOWN ROOT BEER CASE"), AND a dropdown arrow that shows the
// whole list. Same value/onChange contract as the <select>s it replaces (an id
// string, '' for nothing), so a form swaps one tag and nothing else moves.
//
// Deliberately NOT free-solo: a picker that accepts text the list does not
// contain writes an id that does not exist. What you type is a filter; what
// you pick is the value.
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchOption {
  id: string;
  label: string;
  /** Optional second line / hint shown greyed after the label. */
  hint?: string;
  /** Optional group header (options are sorted so groups stay together). */
  group?: string;
  disabled?: boolean;
}

interface Props {
  value: string;
  options: SearchOption[];
  onChange: (id: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Extra styles on the wrapper (width etc.). */
  style?: CSSProperties;
  /** Shown when the current value is not in `options` (a retired item on an old row). */
  unknownLabel?: (id: string) => string;
  autoFocus?: boolean;
  /** Text shown while nothing is picked and the box is empty. Default: "Type to search…". */
  title?: string;
  'aria-label'?: string;
}

export function SearchSelect({
  value, options, onChange, placeholder, disabled, style, unknownLabel, autoFocus, title, ...rest
}: Props) {
  // The current value must be an option or MUI warns and shows nothing; a
  // value the list no longer offers (an inactive item on an old line) becomes a
  // synthetic option so the row still says what it holds.
  const all = useMemo<SearchOption[]>(() => {
    if (!value || options.some((o) => o.id === value)) return options;
    return [{ id: value, label: unknownLabel ? unknownLabel(value) : value, hint: 'not in the current list' }, ...options];
  }, [options, value, unknownLabel]);
  const grouped = useMemo(() => all.some((o) => o.group), [all]);
  const selected = useMemo(() => all.find((o) => o.id === value) ?? null, [all, value]);

  return (
    <Autocomplete<SearchOption, false, false, false>
      size="small"
      disabled={disabled}
      options={all}
      value={selected}
      onChange={(_e, opt) => onChange(opt ? opt.id : '')}
      getOptionLabel={(o) => o.label}
      getOptionDisabled={(o) => !!o.disabled}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      groupBy={grouped ? (o) => o.group ?? '' : undefined}
      // MUI's default filter is a case-insensitive "contains" on the label,
      // which is the smartness asked for; we widen it to the hint as well so
      // a vendor's city or an item's SKU also finds it.
      filterOptions={(opts, state) => {
        const q = state.inputValue.trim().toLowerCase();
        if (!q) return opts;
        const words = q.split(/\s+/);
        return opts.filter((o) => {
          const hay = (o.label + ' ' + (o.hint ?? '')).toLowerCase();
          return words.every((w) => hay.includes(w));
        });
      }}
      autoHighlight
      openOnFocus
      clearOnBlur
      handleHomeEndKeys
      noOptionsText="Nothing matches"
      title={title}
      renderOption={(props, o) => (
        <li {...props} key={o.id} style={{ fontSize: 12, fontFamily: 'inherit', display: 'block', lineHeight: 1.3 }}>
          <span>{o.label}</span>
          {o.hint && <span style={{ color: 'var(--mt)', fontSize: 10.5, marginLeft: 8 }}>{o.hint}</span>}
        </li>
      )}
      renderInput={(params) => (
        <TextField
          {...params}
          placeholder={placeholder ?? 'Type to search…'}
          autoFocus={autoFocus}
          inputProps={{ ...params.inputProps, 'aria-label': rest['aria-label'] }}
        />
      )}
      style={{ minWidth: 0, maxWidth: '100%', ...style }}
      sx={{
        '& .MuiInputBase-root': {
          background: 'var(--ctl-bg)',
          color: 'var(--tx)',
          fontFamily: 'inherit',
          fontSize: 11,
          minHeight: 28,
          paddingTop: '0 !important',
          paddingBottom: '0 !important',
          paddingLeft: '6px !important',
          borderRadius: '4px',
        },
        '& .MuiInputBase-input': { padding: '3px 4px !important', fontSize: 11 },
        '& .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--ctl-bd)' },
        '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--ac)' },
        '& .Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--ac)', borderWidth: 1 },
        '& .MuiAutocomplete-popupIndicator, & .MuiAutocomplete-clearIndicator': { color: 'var(--mt)', padding: '2px' },
        '& .MuiAutocomplete-endAdornment': { right: '4px !important' },
      }}
      slotProps={{
        paper: {
          sx: {
            background: 'var(--sf)', color: 'var(--tx)', border: '1px solid var(--bd)',
            fontFamily: 'inherit', fontSize: 12,
            '& .MuiAutocomplete-option': { minHeight: 28, padding: '4px 10px' },
            '& .MuiAutocomplete-option.Mui-focused': { background: 'rgba(91,181,240,0.14)' },
            '& .MuiAutocomplete-option[aria-selected="true"]': { background: 'rgba(91,181,240,0.22)' },
            '& .MuiAutocomplete-groupLabel': { background: 'var(--sf)', color: 'var(--mt)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, lineHeight: '24px' },
            '& .MuiAutocomplete-noOptions': { color: 'var(--mt)', fontSize: 12 },
          },
        },
      }}
    />
  );
}

/** Convenience: map any {id,label} list (the ItemLookup.options shape) to SearchOptions. */
export function toOptions<T extends { id: string; label: string }>(list: T[]): SearchOption[] {
  return list.map((o) => ({ id: o.id, label: o.label }));
}
