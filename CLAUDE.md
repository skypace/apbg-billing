# CLAUDE.md

Project context for Claude (any client) working in this repo.

## START HERE

**If you are building the PACER Ops Dashboard**, read `CLAUDE-CODE-HANDOFF.md` first. It has everything: schema, keys, what's working, what's broken, what to build.

**If you are modifying the billing portal** (Whitney's approval system), the existing code is in `netlify/functions/` and `public/`. Do not break the existing billing workflows.

## Architecture handbook

This repo is part of a multi-repo system documented in [`activespacescience/Skilliosis_Mytosis_Architecture`](https://github.com/activespacescience/Skilliosis_Mytosis_Architecture/blob/main/ARCHITECTURE.md). That handbook is the source of truth for:

- Which repos exist and what each one does
- How they connect (cross-repo API calls, shared databases, shared services)
- Where data lives (Supabase projects, QuickBooks realm, Service Fusion, ResQ, Outlook)
- Where things are hosted (Netlify, Railway)
- Which MCP servers are wired into Claude
- Decision guide for "where should new software live?"

### When to update it

If your work in this repo changes any of the following, update `ARCHITECTURE.md` in `activespacescience/Skilliosis_Mytosis_Architecture` in the same change:

- A new external service is added
- A new cross-repo dependency is created
- A deploy target changes
- A new MCP tool / connector is added or removed
- A new repo is created in the `skypace` or `activespacescience` orgs
- A repo is renamed, archived, or deleted
- An environment variable / secret category is added

## Key files in this repo

| File | Purpose |
|---|---|
| `CLAUDE-CODE-HANDOFF.md` | **THE handoff doc** — full schema, keys, build spec, gaps |
| `PACER-KPI-SPEC.md` | 108 KPI definitions across 5 departments |
| `PACER-OPS-README.md` | Quick reference — what's running, table counts |
| `public/ops/index.html` | Placeholder dashboard (replace with proper app) |
| `public/` | Billing portal pages (do not modify) |
| `netlify/functions/` | Billing portal functions (do not modify) |
| `netlify.toml` | Netlify config (publish: public, functions: netlify/functions) |

## Project-specific conventions

- All ops dashboard tables live in the `ops` schema in Supabase
- The `public` schema has equipment portal tables — do not modify
- Edge functions for data sync live in Supabase, not Netlify
- QBO realm ID: 9130352144155116
- SF API uses OAuth2 with token rotation cached in ops.sf_token_cache
- Email alerts sent via Resend from alerts@alamedapointbg.com
