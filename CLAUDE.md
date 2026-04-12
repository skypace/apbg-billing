# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Project Overview

APBG Billing is a Netlify-hosted operations platform for Alameda Point Business Group. It includes:
- **Billing Loader** — PDF scan and bill approval workflow (index.html, approve.html)
- **Customer Approval** — New customer creation in QBO + Service Fusion (customer-approve.html)
- **Master Control** — Health monitoring dashboard for all APBG systems (control.html)
- **Sync Dashboard** — ResQ <> Service Fusion work order sync (sync.html)
- **Setup** — OAuth connection management (setup.html)

Tech stack: Vanilla HTML/CSS/JS frontend, Netlify Functions (Node.js ESM), Netlify Blobs for storage.

## UI/UX Skill (UIpro)

When working on any UI, styling, or design tasks, use the UI/UX Pro Max design system generator.

### Setup (run once per session if .claude/skills/ui-ux-pro-max/ is missing)
The skill data is gitignored. If the scripts/data aren't present, download them:
```bash
mkdir -p .claude/skills/ui-ux-pro-max/scripts .claude/skills/ui-ux-pro-max/data/stacks
BASE="https://raw.githubusercontent.com/nextlevelbuilder/ui-ux-pro-max-skill/main/src/ui-ux-pro-max"
for f in search.py core.py design_system.py; do curl -sL "$BASE/scripts/$f" -o ".claude/skills/ui-ux-pro-max/scripts/$f"; done
for f in styles.csv colors.csv products.csv typography.csv ux-guidelines.csv charts.csv landing.csv ui-reasoning.csv google-fonts.csv react-performance.csv app-interface.csv icons.csv design.csv; do curl -sL "$BASE/data/$f" -o ".claude/skills/ui-ux-pro-max/data/$f"; done
curl -sL "$BASE/data/stacks/html-tailwind.csv" -o ".claude/skills/ui-ux-pro-max/data/stacks/html-tailwind.csv"
```

### Generate a full design system
```bash
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<product_type> <industry> <keywords>" --design-system -p "Alameda Point BG"
```

### Search specific domains
```bash
# Styles (glassmorphism, dark mode, dashboard, etc.)
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain style

# Color palettes by industry
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain color

# Typography pairings
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain typography

# UX best practices
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain ux

# Chart/data visualization
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain chart

# Landing page patterns
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain landing
```

### Available domains
`style`, `color`, `typography`, `ux`, `chart`, `landing`, `product`, `google-fonts`, `icons`, `react`, `web`

### Stack-specific guidelines
```bash
python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --stack html-tailwind
```
