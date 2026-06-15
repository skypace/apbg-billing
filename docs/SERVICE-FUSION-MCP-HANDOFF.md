# Service Fusion MCP — Build Handoff

**Status:** Ready to build. This doc is the source material for a *separate
coding session*.
**Target:** Add Service Fusion (SF) tools to the existing **`skypace/pacerfinance`**
MCP server (the one that already exposes QuickBooks + Zoho), so QBO + SF live
behind one MCP. Hosted at `pacerfinance.netlify.app`.
**Scope decision (locked):** Read tools + a small set of **guarded writes**
(create-customer, create-job, update-job-status).
**Author context:** Compiled 2026-06-13 from the three SF integrations that
already exist in this org. No new SF calls were made to produce this — it is a
distillation of *shipped, working* code plus the discrepancies between the
implementations.

---

## 0. How to start the build session

1. **Add `skypace/pacerfinance` to the session's repo scope.** It is *not* in
   the default brix-order/apbg-* scope. (In the current session the
   `add_repo`/`list_repos` tooling wasn't available, which is why this is a
   handoff and not a PR.) You'll likely also want `apbg-billing` and
   `APBG-Leasing-Rental` in scope so you can read the reference implementations
   cited below.
2. **Read pacerfinance first.** Mirror however it registers QBO/Zoho tools
   (tool schema style, transport, auth/secret handling, Netlify function entry
   point). The SF tools should look identical in shape to the QBO ones — do not
   invent a new pattern.
3. **Plan in the architecture repo** per org convention: create
   `activespacescience/Skilliosis_Mytosis_Architecture/projects/service-fusion-mcp/`
   with `PRD.md` / `scoping.md` / `decisions.md`, and add a placeholder row to
   `ARCHITECTURE.md` (new MCP connector) before writing code. Use the
   `asm-mcp-tools.netlify.app/github` MCP for that repo.
4. **Build behind a feature branch, open a draft PR.** SF writes hit a
   **production** ops system — keep them clearly labeled and default-safe.

---

## 1. Why this MCP

We have now hand-rolled SF request shapes **three separate times** (leasing
equipment sync, ResQ↔SF job sync, brix-order order/onboarding) and each time
re-discovered the field names and quirks by trial and error against the live
API. Worse, the three implementations **disagree** with each other (see §4).

An SF MCP makes Claude a first-class SF client: it can *query the real schema*
and *create records directly* instead of shipping best-effort payloads and
waiting for a 422 to teach us the truth. Co-locating it with QBO in pacerfinance
also makes SF↔QBO reconciliation (the thing this whole org keeps doing) a
single-server operation.

---

## 2. The three reference implementations

| Repo | Lang | File(s) | What it does | Trust level |
|---|---|---|---|---|
| **apbg-billing** | mjs (Netlify) | `netlify/functions/sf-helpers.mjs`, `resq-sf-sync-background.mjs`, `resq-sf-sync.mjs`, `lib/sf-assets.mjs`, `sync-customers.mjs`, `sf-oauth-callback.mjs` | ResQ↔SF job sync, customer create/lookup, photo relay | **Highest** — runs in prod daily; quirks are battle-tested |
| **APBG-Leasing-Rental** | Python | `apps/api/src/services/integrations/service_fusion/client.py`, `oauth.py`, `connection.py`, `mappers.py`, `sync.py` | Inbound customer/location/job sync, equipment push | **High for client.py** (real prod-discovered quirks in comments); **LOW for `docs/service-fusion-field-map.md`** — that doc is explicitly a placeholder of *guesses* |
| **brix-order** | TS (Netlify) | `netlify/functions/_lib/sf.ts`, `submit-order.ts`, `admin-decide-onboarding.ts` | Order→SF job; new-customer onboarding→SF customer | **Medium** — job-create path proven; customer-create is best-effort/unverified |

> When two sources conflict, **apbg-billing wins** unless leasing's `client.py`
> comment explicitly documents a prod finding (e.g. the equipment 404/405 split).

---

## 3. Confirmed SF API surface

**Base URL:** `https://api.servicefusion.com/v1`
**Token endpoint:** `https://api.servicefusion.com/oauth/access_token` (note:
one level *above* `/v1` — strip the `/v1` when building it).

### Customers
- **`GET /customers`** — list/search.
  - Params: `page`, `per-page` (**hyphenated**), `filters[customer_name]=<name>`.
  - Search example (brix-order, proven): `customers?filters[name]=<n>&per-page=10&fields=id,customer_name,qbo_id`.
  - Response envelope: `{ items: [...] }` (also seen `data` / `results` — read defensively). Items carry `id`, `customer_name`, `qbo_id`.
  - `filters[...]` is **not reliable on every tenant** — billing falls back to client-side matching across pages.
- **`POST /customers`** — create. Body shape from apbg-billing `sf-helpers.mjs` (the *tested* one):
  ```jsonc
  {
    "customer_name": "Acme Co",                 // REQUIRED, the only hard-required field
    "contacts": [{ "fname": "", "lname": "", "phone": "", "email": "" }],
    "locations": [{ "street": "", "city": "", "state": "", "zip": "" }]
  }
  ```
- **`GET /customers/{id}`** — leasing notes the by-id GET is **unreliable**;
  prefer list-search. (brix-order's `resolveSfCustomerName` resolves a linked id
  by matching it inside a list-search.)

### Locations
- **`GET /locations`** — params `page`, `per-page`, optional `customer_id`.

### Jobs
- **`GET /jobs`** — list. Params (leasing `client.py`, prod-confirmed):
  - `per-page` **hyphenated, max 50**.
  - `filters[status]=<full status string>` (not `status=`).
  - `filters[updated_date][gte]=<RFC3339>` (not `updated_since=`).
  - `expand=equipment,products_services` (comma list). Without `products_services`, line-item arrays are absent and every job looks like a delivery.
  - billing also uses `sort=-created_at`, `page`, `filters[po_number]=<code>`.
- **`GET /jobs/{id}`** — single job. `expand=` accepts a rich comma list seen in billing:
  `pictures,documents,signatures,visits,visits.techs_assigned,notes` and
  `invoices,products,services,labor_charges,expenses,other_charges`.
  Nested billing arrays: `products[]`, `services[]`, `labor_charges[]`,
  `expenses[]`, `other_charges[]`, `invoices[]`, `visits[]`, `pictures[]`.
- **`POST /jobs`** — create. ⚠ See §4.1 — the two impls disagree on the customer key.
  - billing (ResQ, proven): `{ customer_name, description, status:'Unscheduled', priority, po_number }`.
  - leasing: `{ customer_id:<int>, description, equipment:[...], category?, customer_location_id?, scheduled_date? }`.
  - Job address fields (brix-order, on the job not the customer): `street_1`, `street_2`, `city`, `state_prov`, `postal_code`, `customer_name`, `note_to_customer`.
- **`PUT /jobs/{id}`** — update. billing uses `{ status: 'Cancelled' | 'Invoiced' | ... }`.

### Job types
- **`GET /job-types`** — params `page`, `per-page`. Rows: `{ id, code, name, is_custom, category }`. `category` discriminates Delivery vs Service.

### Equipment (leasing `client.py`, prod-discovered asymmetry — important)
- **Create:** `POST /customers/{customer_id}/equipment` (nested). Do **not** also put `customer_id` in the body → 422.
- **Update:** `PUT /equipment/{equipment_id}` (top-level). The nested `/customers/{id}/equipment/{id}` is **405 (read-only)**.
- **List:** `GET /customers/{customer_id}/equipment` (params `page`, `per_page` — note this one used a non-hyphen `per_page`; verify).
- There is **no** writeable top-level `/equipment` collection (`POST /equipment` → 404). To push *new* equipment you can also bundle an `equipment:[...]` array onto `POST /jobs` (SF creates the rows as a side effect).

### Health
- **`GET /me`** — billing uses it as an auth smoke test.

### Asset bytes (advanced — recommend OUT of MCP v1)
SF's REST API returns picture/document **metadata** (`file_location`, etc.) but
not the bytes. billing fetches bytes from public S3
(`servicefusion.s3.amazonaws.com/images/{estimates,sign}/...`, region varies
`us-east-1`/`ap-northeast-1`) or via an **admin-portal session cookie** stored
in Supabase `orders.sf_portal_session` (host-aware: `api.*`→Bearer first,
`admin.*`→Cookie first). This is fiddly and not needed for the core MCP — defer.

---

## 4. Discrepancies the MCP must resolve (do this empirically, first)

These are real conflicts between shipped implementations. The MCP should settle
each one by *reading the live API* (a `sf_test_connection`/`sf_get_*` call) before
trusting either side.

### 4.1 Job create — `customer_name` vs `customer_id`
- **billing (ResQ sync):** passing `customer_id` on `POST /jobs` is **rejected
  with 422 "Customer Name can not be found"** — they use exact `customer_name`.
- **leasing (`client.py`):** passes `customer_id` (int) on `POST /jobs` and
  comments treat it as working (for the create-job-with-equipment path).
- **Likely truth:** SF wants `customer_name` for the plain job-create path; the
  leasing path may differ because it's a different endpoint behavior or was
  never exercised in prod. **MCP `sf_create_job` should accept a customer
  *name* (and resolve/verify it via search), and surface SF's 422 body verbatim
  if it fails.**

### 4.2 Customer-location field names
- **billing `POST /customers` → `locations[]`:** `{ street, city, state, zip }`.
- **brix-order job address:** `{ street_1, street_2, city, state_prov, postal_code }`.
- **leasing field-map.md (GUESS):** `address1`, `postal_code`.
- **Likely truth:** the *customer location* sub-object uses `street/city/state/zip`
  (billing is tested); the *job* address uses `street_1/state_prov/postal_code`.
  They are different objects. **Note:** brix-order's `admin-decide-onboarding.ts`
  currently builds `locations[{ street_1, ... }]` for customer create — that is
  probably the wrong sub-key and should be `street`. (Low-risk: `customer_name`
  is the only required field and the error surfaces; flagged for follow-up.)

### 4.3 OAuth grant type — THREE variants in the wild
| Repo | Grant | Creds passed how | Token URL |
|---|---|---|---|
| **brix-order** (`sf.ts`) | `client_credentials` | **JSON body** `{grant_type,client_id,client_secret}` | `…/oauth/access_token` |
| **apbg-billing** (`sf-helpers.mjs`) | `refresh_token` | **form-urlencoded body** `grant_type&client_id&client_secret&refresh_token` | `…/oauth/access_token` |
| **leasing** (`oauth.py`) | `authorization_code` → `refresh_token` | **HTTP Basic** header (`client_id:client_secret` b64) + form body | configurable `SERVICE_FUSION_TOKEN_URL` |

- **Recommendation for the MCP:** use whatever the **pacerfinance SF OAuth app**
  is registered as. If it can issue `client_credentials` (server-to-server),
  prefer that — it's stateless and simplest (brix-order's path, JSON body). If
  not, use the stored-`refresh_token` path (billing's), and persist the refresh
  token + access-token cache the way pacerfinance already persists QBO tokens.
- **Bearer on every API call:** `Authorization: Bearer <access_token>`, `Accept: application/json`.

---

## 5. Proposed v1 tool surface

Name/namespace to match pacerfinance's existing convention (e.g. `sf_*` or
`servicefusion_*`). Mark every write tool clearly in its description as hitting
production SF.

**Reads**
- `sf_test_connection` → `GET /customers?page=1&per-page=1`; return top-level
  keys + first-item field names. (Doubles as live schema discovery — use it to
  settle §4.)
- `sf_search_customers({ name?, per_page? })` → `GET /customers` with
  `filters[customer_name]` + client-side fallback match. Returns `id, customer_name, qbo_id`.
- `sf_get_customer({ id })` → search-by-id-then-match (by-id GET unreliable).
- `sf_list_locations({ customer_id?, page?, per_page? })` → `GET /locations`.
- `sf_list_jobs({ status?, updated_since?, po_number?, page?, per_page? })` →
  `GET /jobs` (honor hyphen `per-page≤50`, `filters[...]`, `expand`).
- `sf_get_job({ id, expand? })` → `GET /jobs/{id}` (default a sensible expand set).
- `sf_list_job_types()` → `GET /job-types`.
- `sf_list_customer_equipment({ customer_id })` → `GET /customers/{id}/equipment`.

**Guarded writes**
- `sf_create_customer({ customer_name, contact?, location? })` →
  `POST /customers` with the billing-proven body (`contacts[]`, `locations[]`
  with `street/city/state/zip`).
- `sf_create_job({ customer_name, description, status?, priority?, po_number?, location?, scheduled_date? })`
  → resolve/verify `customer_name`, then `POST /jobs`. Never send `customer_id`
  on this path (§4.1).
- `sf_update_job_status({ id, status })` → `PUT /jobs/{id}`.

**Out of v1:** photo/document byte relay (S3 + portal cookie), equipment
create/update (nested-vs-top-level asymmetry — add once core is solid), any
DELETE (SF has none; soft-delete via status).

---

## 6. Implementation notes (carry these over — they're paid-for in prod debugging)

- **Timeouts:** SF `/jobs` paginates **slowly** — 20–60s per page on our tenant.
  Use a long *read* timeout (leasing uses connect 15s / **read 180s**). A single
  30s timeout trips mid-paginate.
- **Retry transient only:** retry on connect/read/write timeouts + protocol
  errors with exponential backoff (leasing: 3 attempts, 2→20s). **Do not** retry
  `4xx/5xx` HTTPStatusError — the caller needs to read 401/403/422 semantics.
- **Surface SF error bodies:** SF puts the useful validation detail (which field
  was rejected and why) in the response body; default HTTP clients drop it.
  Always include `resp.text[:1000]` in the thrown error. (Both leasing and
  brix-order learned this.)
- **Empty-body 2xx:** SF returns 200/204 with empty bodies; treat empty text as `{}`.
- **404s return HTML:** truncate before logging.
- **Response envelope is inconsistent:** read `items ?? data ?? results ?? []`.
- **Exact customer-name matching is brittle:** punctuation/case matters; billing
  keeps hardcoded overrides (`THE MELT RESQ`, `STARBIRD CHICKEN: RESQ`). For the
  MCP, prefer resolving via `sf_search_customers` and returning candidates rather
  than guessing.
- **Token caching:** mirror pacerfinance's QBO token persistence (don't re-auth
  per call). billing's pattern: in-memory + persistent store + a short refresh
  lock to avoid races.

## 7. Env vars the MCP will need

`SF_API_BASE_URL` (`https://api.servicefusion.com/v1`), `SF_CLIENT_ID`,
`SF_CLIENT_SECRET`, and **either** nothing extra (if `client_credentials`) **or**
`SF_REFRESH_TOKEN` (if refresh-token grant). Match the secret-naming pattern
pacerfinance already uses for QBO/Zoho.

## 8. Explicitly NOT Service Fusion

**ResQ is a separate GraphQL API** (`resq-helpers.mjs`, mutations like
`startVisit`, `addAfterImagesToVisit`). It is *not* part of this MCP. The
ResQ↔SF *sync* lives in apbg-billing and stays there; the MCP only talks to SF
(REST) and QBO. Keep them strictly separate.

---

## 9. Source pointers (read these in the build session)

- `apbg-billing/netlify/functions/sf-helpers.mjs` — token mgmt + customer/job calls (most trusted).
- `apbg-billing/netlify/functions/resq-sf-sync-background.mjs` — job create/dedup/status, invoice rollup.
- `apbg-billing/netlify/functions/lib/sf-assets.mjs` — photo bytes (S3 + portal cookie) if you ever do v2.
- `APBG-Leasing-Rental/apps/api/src/services/integrations/service_fusion/client.py` — the cleanest endpoint+quirk reference (per-page hyphen, filters shape, expand, equipment 404/405, timeouts, retry).
- `APBG-Leasing-Rental/apps/api/src/services/integrations/service_fusion/oauth.py` — authorization_code + refresh flow.
- `brix-order/netlify/functions/_lib/sf.ts` — `client_credentials` JSON-body auth + `sfGet/sfPost/sfPut` + `safeJson`.
- `brix-order/netlify/functions/submit-order.ts` (job create + customer name resolution) and `admin-decide-onboarding.ts` (customer create).
- `APBG-Leasing-Rental/docs/service-fusion-field-map.md` — ⚠ placeholder GUESSES, do not trust; superseded by this doc.
