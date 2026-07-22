# APBG Gateway — Operations Hub, Login, Roles & App Manager

> Part I · User Guide · Owner: Sky Pace · Last reviewed: 2026-07-22

The APBG Gateway at **https://alamedapointbg.com** is the single front door for every internal APBG application — one login, one app grid, one place to manage users and app tiles. This chapter covers signing in, what each role can see, the waffle app switcher and theme toggle embedded in every app, the profile editor, and the two admin surfaces: User Management and the App Manager. It is written for all APBG staff; the admin sections apply to admins and superadmins only.

## What the hub is

The gateway is a static Netlify site (repo `skypace/apbg-gateway`) on the custom domain `alamedapointbg.com`. It does three jobs:

1. **Landing page ("Operations Hub")** — a grid of app tiles, grouped by section (Company Apps, Admin, Finance, Equipment & Service, Customer Portals, Resources & Links, Roadmap). The tile list is DB-driven from the Supabase registry table `public.gateway_apps` and filtered by your role.
2. **Reverse proxy / branded URLs** — the gateway proxies the sub-apps under one origin: `/billing/` (AP tool), `/margin/` (Refractor), `/expense/` (Brixpense), `/melt/`, `/operations/`, `/freshpet/`, `/control` (Master Control), and more. The authoritative routing table is `netlify.toml` in the gateway repo. Since 2026-06-12, `alamedapointbg.com` is the only public door — the raw `apbg-gateway.netlify.app` host 301s to the branded domain, and sub-sites can reject traffic that didn't come through the gateway (the `X-APBG-Proxy` header / `APBG_PROXY_SECRET` mechanism).
3. **Shared SSO** — because every app is served under one origin, they all share the same session in `localStorage` (key `apbg_session`). Sign in once at the hub and every proxied app recognizes you.

Some apps deliberately live on their own domains and are linked (not proxied) from the hub: the customer order portal (`orders.brixbev.com`), Fountain DAM (`fountain-dam.netlify.app`), and the driver audit PWA (`alamedapointbg.com/audit` 301s to it). See [Companion Apps — Fountain DAM, Melt, APBG Ops, ERLS, MCP Servers](#/11-companion-apps).

| Key URL | What it is |
|---|---|
| https://alamedapointbg.com | Operations Hub (login + app grid) |
| https://alamedapointbg.com/admin.html | User Management (admin/superadmin) |
| https://alamedapointbg.com/apps-admin.html | App & Link Manager (admin/superadmin) |
| https://alamedapointbg.com/control | Master Control (superadmin) — see [Master Control](#/09-master-control) |

## Signing in

Auth is **Supabase email/password** (shared project `gfsdpwiqzshhexkofiif` — the same auth used by Melt Dashboard, Brixpense, Refractor, and Master Control). Your role lives in Supabase `user_metadata.role`.

1. Open https://alamedapointbg.com.
2. Enter your work email and password. Password fields have a show/hide eye toggle.
3. On success the session is stored in `localStorage.apbg_session` and shared with every proxied app. Tokens refresh automatically in the background (a near-expiry session refreshes silently; a dead refresh token signs you out).

### Forgot password

- **Self-serve:** click **Forgot password?** on the hub login card (`forgotBtn`). Supabase emails a recovery link; the callback lands back on the portal and opens the change-password modal.
- **Admin-initiated:** an admin can click **Send reset** next to your row in User Management (`admin.html`). Note GoTrue rate-limits repeat recovers — a second reset within about a minute returns a friendly "try again in a minute" message.
- **From a terminal** (documented for operators):

```bash
curl -X POST "https://gfsdpwiqzshhexkofiif.supabase.co/auth/v1/recover" \
  -H "apikey: <anon_key>" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@brixbev.com"}'
```

### Password policy

The shared Supabase project enforces **8+ characters with at least one of each: lowercase, uppercase, digit, symbol**. Anything weaker is rejected server-side (`weak_password`); the hub pre-validates with friendly copy. Admin-generated temp passwords are crypto-random and already satisfy the policy.

## Roles and what they can see

Roles are defined in `public/auth.js` (`ROLES`) and mirrored server-side in the apps registry API. Each role carries a set of **access buckets**; an app tile is visible when your role includes the tile's access bucket.

| Role | Label | Access buckets | Practical meaning |
|---|---|---|---|
| `superadmin` | Super Administrator | shared, melt, billing, finance, control, equipment, freshpet, resq, operations | Everything, including Master Control and health probes |
| `admin` | Administrator (legacy) | same as superadmin | Legacy alias — treated as superadmin-equivalent for access |
| `melt-super` | Melt Super User | shared, melt | Full Melt access except settings |
| `melt-project` | Melt Project Manager | shared, melt | Melt except payments (schedule-focused) |
| `melt-billing` | Melt Billing | shared, melt | Melt payments/statements/invoices only |
| `melt-general` | Melt Equipment | shared, melt | Melt equipment section only (field techs, installers) |
| `finance` | Finance & Payments (legacy) | shared, melt, billing, finance | Billing + finance tools |
| `operations` | Operations & Jobs (legacy) | shared, melt, equipment, operations | Ops dashboards + equipment; includes the APBG Ops app |
| `viewer` | View Only (legacy) | shared, melt | Read-only Melt overview |
| `ops-super` | Ops Super User | shared, operations, melt | APBG Ops full |
| `ops-delivery` / `ops-service` / `ops-reman` / `ops-viewer` | Ops — Delivery / Service / Reman / Viewer | shared, operations | APBG Ops (driver/tech roles); these also see the CO₂ Audit tile (access `operations`) |

Notes:

- The melt-* roles additionally have fine-grained `meltTabs` / `meltSections` grants inside the Melt Dashboard (e.g. `melt-billing` sees statement/invoices/applied tabs and the payments section only).
- The `resq` access bucket is inert today (its portal card was removed when the legacy sync was decommissioned; the sync is managed from Master Control).
- ⚠ Engineering note: the role→access map is **duplicated** in `netlify/functions/apps.mjs` — any change to `auth.js` ROLES must be mirrored there.

## The waffle app switcher (every app)

Every APBG app embeds one script tag — `<script src="https://alamedapointbg.com/appswitcher.js" defer></script>` — and gets a floating **waffle pill**:

- Click it to open the app grid: the same role-filtered tiles as the hub, grouped by section. The list comes from `/api/apps` and is cached ~10 minutes (`localStorage.apbg_apps_cache_v2`).
- The pill is **draggable** — grab it and drop it anywhere; the position persists (`localStorage.apbg_waffle_pos`) and is shared across every app under alamedapointbg.com.
- SSO rides along automatically: the switcher reads the same `apbg_session` from localStorage.

### Light/dark theme toggle

Next to the waffle is a **sun/moon toggle**. It persists your choice in `localStorage.apbg_theme` (one key shared across all APBG apps), sets `data-apbg-theme` on the page, and fires an `apbg:theme` event. Apps that support theming re-render; apps that don't ignore it harmlessly. The toggle also syncs across open tabs.

### Service banners and lockouts (what users see)

The switcher polls the gateway's public `/api/maintenance` endpoint. When an operator puts an app (or all apps) into maintenance from Master Control:

- **Banner** — a dismissible amber notice at the top of the app with the operator's service note. You can dismiss it and keep working.
- **Lockout** — a full-screen service overlay that blocks the app entirely until maintenance ends. Superadmins get a "Dismiss (admin) — continue to app" bypass so they can verify the fix behind the wall.

A lockout for the specific app wins over a global one; lockout wins over banner. State changes take effect within about 30 seconds (apps poll on load + interval). How to set these is covered in [Master Control](#/09-master-control).

## Profile editor

Click your avatar in the hub header to open the profile menu → profile editor. From here you can (all client-side via your own session, no admin needed):

- **Edit your display name.**
- **Upload an avatar** — stored in the public `avatars` Supabase Storage bucket.
- **Change your password** — new password twice (eye toggles to verify they match), validated against the 8+ char / 4-class policy before submission.

## Hub extras

- **⌘K / Ctrl+K search** — a modal that filters all cards by name/tag/section/entity.
- **"Jump back in"** — the last 4 tools you used, per user (localStorage `apbg_recents_v3`).
- **Health status dots** — per-card live status driven by the `health-watchdog` and `pacer-health` functions in apbg-billing. These probes are **superadmin-gated**: the hub sends your session token, and if you're not a superadmin the dots are hidden with a gentle "Health checks — superadmin only" pill instead of a false red "Down". A 401/403 is *not* an outage. The full health grid lives in [Master Control](#/09-master-control).

## User Management (admin.html)

**Who:** admin or superadmin only (anyone else sees "Admin access required").
**Where:** https://alamedapointbg.com/admin.html — backed by `/api/admin-users` (Supabase Admin API, requires an admin/superadmin JWT).

### Invite a user

1. Open User Management and fill **Name**, **Email**, and pick a **Role** (see the role table above).
2. Click **Invite**. The function creates the Supabase auth user and returns a **temp password**, displayed once on screen — copy it and hand it to the user securely.
3. Tell the user to sign in at https://alamedapointbg.com and change their password from the profile editor (the temp password already meets the policy, but it's shared knowledge until changed).

### Manage existing users

The **Current Users** table lists everyone with name, email, role, and last sign-in. Per row:

- **Change role** — pick a new role from the inline dropdown (takes effect on the user's next token refresh/login). You cannot change your own role from here.
- **Send reset** — emails a Supabase password-reset link (rate-limited; see above).
- **Remove** — deletes the auth user entirely. Confirm-gated and **cannot be undone**; you cannot remove yourself.

## App Manager (apps-admin.html)

**Who:** admin or superadmin only.
**Where:** https://alamedapointbg.com/apps-admin.html — "App & Link Manager", the CRUD UI over the `public.gateway_apps` registry (RLS: any authenticated user can read; writes go through the admin-gated `/api/apps` function with the service role).

Everything on the hub and in every app's waffle is driven by this registry — add a row here and the tile appears everywhere within the ~10-minute switcher cache (the manager busts the cache on save).

### Fields on an app/link

| Field | Meaning |
|---|---|
| Key | Stable `app_key` (e.g. `fountain`, `co2audit`) — also drives icon mapping and maintenance targeting |
| Name / Description | Card title + one-sentence blurb |
| URL | Gateway-relative (`/margin/`) or absolute (`https://fountain-dam.netlify.app`) |
| Section | equip / portals / finance / company / admin / links / roadmap (roadmap cards may have no URL) |
| Tag | Short label shown as a pill on the card |
| Access role group | The access bucket that gates visibility (shared = all signed-in users; control = admins only; melt/billing/finance/operations/equipment/freshpet/resq) |
| Icon / Logo URL | Pick from the shared tile set, or point at a custom logo |
| Opens in new tab | For external apps/links |
| Active | Toggle visibility without deleting |

### Common tasks

1. **Add an app or link** — fill the form, watch the live icon preview, click **Add App or Link**. The **OneDrive Link** quick button pre-fills a shared-folder link template.
2. **Edit** — click Edit on a row; the form scrolls up pre-filled; Save Changes.
3. **Reorder** — ▲/▼ arrows within a section swap sort order.
4. **Role-gate** — change the Access role group; users without that bucket stop seeing the tile.
5. **Hide vs delete** — prefer toggling **Active** off (reversible) over Delete (confirm-gated, permanent).

## Related

- [Master Control — Health, ResQ Sync, Linked Customers, Maintenance & Sweeps](#/09-master-control) — the superadmin panel reached via `/control`
- [Companion Apps — Fountain DAM, Melt, APBG Ops, ERLS, MCP Servers](#/11-companion-apps) — what the tiles point at
- [SOP-1 · Security & Access](#/21-sop-security-access) — account/role/credential policy
- [SOP-6 · Service, Maintenance Windows & Incident Response](#/26-sop-service-maintenance) — when to use banners vs lockouts
- Source docs: `skypace/apbg-gateway` `CLAUDE.md`, `public/auth.js`, `public/admin.html`, `public/apps-admin.html`, `public/appswitcher.js`; cross-repo map in `activespacescience/Skilliosis_Mytosis_Architecture/ARCHITECTURE.md`
