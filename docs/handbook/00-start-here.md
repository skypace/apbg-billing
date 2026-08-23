# Start Here — System Map & How to Use This Handbook

> Part 0 · Introduction · Owner: Sky Pace · Last reviewed: 2026-07-22

This is the **APBG Master Handbook** — one place for everything: how to use every app we own (Part I, the Master User Guide) and how we run the business on top of them (Part II, the Operations SOP Manual). It's built from the same knowledge base Mr. Bubbles and Chloe use, plus the per-app user guides and the cross-repo architecture handbook. It is an **internal** document — customer-facing help lives in the [portal Resources library](https://orders.brixbev.com/resources).

## How to navigate

- The **sidebar** lists every chapter, grouped into the User Guide, Architecture & Data, the SOP Manual, and the Change Log. Click a chapter to load it; the section list underneath tracks where you are.
- **[Architecture & Data](#/12-architecture-overview)** diagrams how the programs and data connect; the **[Live Architecture Mirror](#/13-architecture-live)** renders the master `ARCHITECTURE.md` straight from GitHub (sign in first). The **[Change Log](#/90-change-log)** is an automatic feed of every commit across every APBG repo.
- **Search** (press `/`) filters chapters and sections.
- Every chapter cross-links its neighbors and ends with a **Related** section pointing at the deeper source documents.
- **Print** renders the current chapter clean for paper.

## The one-login rule

Everything hangs off one Supabase login. Sign in once at [alamedapointbg.com](https://alamedapointbg.com) and the **waffle switcher** (top-right in every app) takes you anywhere your role allows. The Brix Order portal at [orders.brixbev.com](https://orders.brixbev.com) shares the same account — staff land in `/admin`, customers land in `/home`.

## System map — every app we own

| App | URL | Who uses it | Chapter |
|---|---|---|---|
| **APBG Gateway (Operations Hub)** | [alamedapointbg.com](https://alamedapointbg.com) | All staff — the front door, login, app launcher, user management | [Gateway](#/01-gateway-hub) |
| **Brix Order Portal** | [orders.brixbev.com](https://orders.brixbev.com) | Customers (ordering, invoices, payments) + staff acting for them | [Portal](#/02-brix-order-portal) |
| **Brix Order /admin** | [orders.brixbev.com/admin](https://orders.brixbev.com/admin) | Superadmins — customers, onboarding, payments, audits, knowledge | [Admin console](#/03-brix-order-admin) |
| **CO₂ Cylinder Audit PWA** | [alamedapointbg.com/audit](https://alamedapointbg.com/audit) | Drivers in the field | [Driver guide](#/04-driver-cylinder-audit) |
| **AI phone line (Chloe & Ziggy)** | (510) 800-6281 | Customers (Chloe) + owners/staff (Ziggy) | [AI assistants](#/05-voice-ai-assistants) |
| **Mr. Bubbles** | chat widget in the portal | Customers + staff — grounded on the knowledge base | [AI assistants](#/05-voice-ai-assistants) |
| **BRIX Refractor (Margin Control)** | [alamedapointbg.com/margin/](https://alamedapointbg.com/margin/) | Sales/ops — margin, customers, items, P&L alignment, proposals | [Refractor](#/06-refractor-margin-control) |
| **Brixpense** | [alamedapointbg.com/expense/](https://alamedapointbg.com/expense/) | All staff — expenses + purchase requests | [Brixpense](#/07-brixpense) |
| **3rd-Party Billing (AP tool)** | [alamedapointbg.com/billing/](https://alamedapointbg.com/billing/) | AP/accounting — vendor bill processing, OAuth setup | [AP tool](#/08-ap-billing-tool) |
| **Master Control** | [alamedapointbg.com/control](https://alamedapointbg.com/control) | Superadmins — health, ResQ sync, maintenance, sweeps | [Master Control](#/09-master-control) |
| **Production** | Refractor → Production tabs | Ops — formulas, BOMs, work orders, POs | [Production](#/10-production) |
| **Fountain DAM** | fountain-dam.netlify.app | Marketing/sales — brand asset library | [Companion apps](#/11-companion-apps) |
| **Melt Dashboard** | [alamedapointbg.com/melt/](https://alamedapointbg.com/melt/) | Melt program — equipment portal | [Companion apps](#/11-companion-apps) |
| **APBG Ops** | [alamedapointbg.com/operations/](https://alamedapointbg.com/operations/) | Leadership — company KPIs | [Companion apps](#/11-companion-apps) |
| **Brix ERLS (Leasing/Rental)** | Railway-backed stack | Equipment leasing | [Companion apps](#/11-companion-apps) |
| **ResQ ↔ SF sync** | headless (Supabase) — managed from Master Control | Ops oversight only | [Master Control](#/09-master-control) |
| **MCP servers (pacerfinance, Pacer-outlook)** | headless — wired into Claude + Ziggy HQ mode | Owners/AI | [Companion apps](#/11-companion-apps) |

## The SOP manual at a glance

| SOP | Covers | Chapter |
|---|---|---|
| SOP-0 | How policies and this handbook are governed | [Governance](#/20-sop-governance) |
| SOP-1 | Security, accounts, roles, credentials, PCI posture | [Security & access](#/21-sop-security-access) |
| SOP-2 | Customer lifecycle — apply → approve → enable → close | [Customer lifecycle](#/22-sop-customer-lifecycle) |
| SOP-3 | Orders & fulfillment — web/phone/admin, tank returns, service calls | [Orders](#/23-sop-orders-fulfillment) |
| SOP-4 | Billing & payments — invoices, rails, returned payments | [Billing & payments](#/24-sop-billing-payments) |
| SOP-5 | CO₂ cylinders — rentals, audits, shortage approvals | [Cylinders](#/25-sop-cylinders-audits) |
| SOP-6 | Service, maintenance windows, incident response | [Service & incidents](#/26-sop-service-maintenance) |
| SOP-7 | Expenses & purchasing — Brixpense policy, COGS coding | [Expenses](#/27-sop-expenses-purchasing) |
| SOP-8 | Production — formula → BOM → work order → PO | [Production SOP](#/28-sop-production) |
| SOP-9 | Data & engineering — schemas, migrations, secrets, AI grounding | [Data & engineering](#/29-sop-data-engineering) |

## Where this content comes from (and stays fresh)

Each chapter registers its **source documents** — the per-repo `CLAUDE.md` logs, the app user guides, the knowledge-base articles the bots use, and the cross-repo [architecture handbook](https://github.com/activespacescience/Skilliosis_Mytosis_Architecture/blob/main/ARCHITECTURE.md) — in `docs/handbook/manifest.json`. The **Handbook Sweep** button in [Master Control](#/09-master-control) compares every chapter's last-reviewed date against the latest commits touching its sources and flags what's gone stale. The sweep finds drift; a Claude session (or a human) then updates the chapter and bumps its `last_reviewed` date. Full procedure in [SOP-0 · Governance](#/20-sop-governance).

## Related

- [SOP-0 · Policy Governance](#/20-sop-governance) — how chapters and policies are created, approved, and kept current
- [Skilliosis_Mytosis_Architecture / ARCHITECTURE.md](https://github.com/activespacescience/Skilliosis_Mytosis_Architecture/blob/main/ARCHITECTURE.md) — the engineering-level system map
- [Portal Resources library](https://orders.brixbev.com/resources) — the customer-facing help layer
