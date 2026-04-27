# CLAUDE.md

Project context for Claude (any client) working in this repo.

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

- A new external service is added (new Supabase project, new email sender, new third-party API)
- A new cross-repo dependency is created (this repo now calls another repo's API, or another repo now calls this one)
- A deploy target changes (Netlify → Railway, new domain, new function endpoint)
- A new MCP tool / connector is added or removed
- A new repo is created in the `skypace` or `activespacescience` orgs
- A repo is renamed, archived, or deleted
- An environment variable / secret category is added (new credential class, not just a rotation)

### How to update it

Use the GitHub MCP (`asm-mcp-tools.netlify.app/github`, tool `github_create_or_update_file`) against `activespacescience/Skilliosis_Mytosis_Architecture`, file `ARCHITECTURE.md`, branch `main`. Append a row to the change log at the bottom. Keep the Mermaid diagram in sync with the inventory.

If you don't have access to that MCP from the current session, surface the change in your response so it can be applied manually.

### Planning new projects

For brand-new projects (not changes to this repo), plan first in `activespacescience/Skilliosis_Mytosis_Architecture/projects/<project-name>/`. Drop a `PRD.md`, `scoping.md`, and `decisions.md`. Update `ARCHITECTURE.md` with a placeholder row before any code is written. When the project graduates to its own repo, add a `CLAUDE.md` there.

---

## Project-specific context

*(Add project-specific Claude guidance here as the repo evolves — architecture, conventions, gotchas, key files.)*
