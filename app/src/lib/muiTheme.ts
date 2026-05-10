import { createTheme } from '@mui/material/styles';

// Brix Margin Control — MUI theme.
// Mirrors the CSS variable tokens declared in src/styles/theme.css so that
// MUI components (DataGrid Pro, DatePickers, Buttons) inherit the same
// dark-glass aesthetic as the rest of the hand-rolled UI.
//
// Source-of-truth values (do NOT drift from theme.css):
//   --bg   #0A1218   page background
//   --sf   #0F1A22   surface (cards, headers)
//   --bd   rgba(255,255,255,0.06)
//   --ink  #E6EEF1   primary text
//   --mt   #9DB1BC   muted text
//   --ac   #2DCAD6   accent / cyan (primary)
//   --am   #F4B400   amber (secondary)
//   --gn   #2EB872   success / positive
//   --rd   #FF5A5F   error / negative
//   --brix #003A49   brand teal (status bar, chrome)

export const brixTheme = createTheme({
  palette: {
    mode: 'dark',
    primary:   { main: '#2DCAD6', dark: '#26B5C0', contrastText: '#0A1218' },
    secondary: { main: '#F4B400', contrastText: '#0A1218' },
    success:   { main: '#2EB872' },
    error:     { main: '#FF5A5F' },
    warning:   { main: '#F4B400' },
    info:      { main: '#2DCAD6' },
    background: {
      default: '#0A1218',
      paper:   '#0F1A22',
    },
    text: {
      primary:   '#E6EEF1',
      secondary: '#9DB1BC',
      disabled:  '#6B7E89',
    },
    divider: 'rgba(255,255,255,0.08)',
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily:
      '"Inter Tight", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
    fontSize: 12,
    htmlFontSize: 14,
    button: { textTransform: 'none', fontWeight: 600, letterSpacing: 0 },
    h1: { fontFamily: '"Bricolage Grotesque", "Inter Tight", sans-serif', fontWeight: 600 },
    h2: { fontFamily: '"Bricolage Grotesque", "Inter Tight", sans-serif', fontWeight: 600 },
    h3: { fontFamily: '"Bricolage Grotesque", "Inter Tight", sans-serif', fontWeight: 600 },
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          backgroundColor: '#0F1A22',
          border: '1px solid rgba(255,255,255,0.06)',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: { borderRadius: 10, fontWeight: 600 },
        containedPrimary: {
          background: 'linear-gradient(180deg, #2DCAD6 0%, #26B5C0 100%)',
          color: '#0A1218',
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: '#0F1A22',
          '& fieldset': { borderColor: 'rgba(255,255,255,0.10)' },
          '&:hover fieldset': { borderColor: 'rgba(45,202,214,0.40)' },
        },
      },
    },
    MuiCheckbox: {
      styleOverrides: { root: { color: '#9DB1BC', '&.Mui-checked': { color: '#2DCAD6' } } },
    },
    MuiSwitch: {
      styleOverrides: {
        root: {
          '& .MuiSwitch-track': { backgroundColor: '#1A2730' },
          '& .Mui-checked + .MuiSwitch-track': { backgroundColor: '#2DCAD6 !important' },
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: '#1A2730',
          color: '#E6EEF1',
          border: '1px solid rgba(255,255,255,0.08)',
          fontSize: 11,
        },
      },
    },
  },
});
