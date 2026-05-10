import { createTheme } from '@mui/material/styles';

// Brix Margin Control — MUI theme. Mirrors the CSS variable tokens in
// theme.css against the actual Brix Beverage brand:
//   --brix      #143966   navy (logo circle, primary chrome)
//   --ac        #5BB5F0   bubble blue (accents, the "bubble" dots above brix wordmark)
//   --amber     #F4B400   warm secondary
//   --alameda   #C8102E   Alameda Soda Co cross-brand red
//   --bg        #06121F   page background (navy-tinted dark)
//   --sf        #0E2240   surface
//   --tx        #E6EEF7   primary text
//   --mt        #6B8499   muted text

export const brixTheme = createTheme({
  palette: {
    mode: 'dark',
    primary:   { main: '#5BB5F0', dark: '#3A8FCC', light: '#7ACBF5', contrastText: '#06121F' },
    secondary: { main: '#F4B400', contrastText: '#06121F' },
    success:   { main: '#2EB872' },
    error:     { main: '#FF5A5F' },
    warning:   { main: '#F4B400' },
    info:      { main: '#5BB5F0' },
    background: {
      default: '#06121F',
      paper:   '#0E2240',
    },
    text: {
      primary:   '#E6EEF7',
      secondary: '#94A8BD',
      disabled:  '#5A6F84',
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
          backgroundColor: '#0E2240',
          border: '1px solid rgba(255,255,255,0.06)',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: { borderRadius: 10, fontWeight: 600 },
        containedPrimary: {
          background: 'linear-gradient(135deg, #5BB5F0 0%, #3A8FCC 100%)',
          color: '#06121F',
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: '#0E2240',
          '& fieldset': { borderColor: 'rgba(255,255,255,0.10)' },
          '&:hover fieldset': { borderColor: 'rgba(91,181,240,0.40)' },
        },
      },
    },
    MuiCheckbox: {
      styleOverrides: { root: { color: '#94A8BD', '&.Mui-checked': { color: '#5BB5F0' } } },
    },
    MuiSwitch: {
      styleOverrides: {
        root: {
          '& .MuiSwitch-track': { backgroundColor: '#1B3A5E' },
          '& .Mui-checked + .MuiSwitch-track': { backgroundColor: '#5BB5F0 !important' },
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: '#163052',
          color: '#E6EEF7',
          border: '1px solid rgba(255,255,255,0.08)',
          fontSize: 11,
        },
      },
    },
  },
});
