# AI Assistants — Chloe & Ziggy Phone Line, Mr. Bubbles, Knowledge Base

> Part I · User Guide · Owner: Sky Pace · Last reviewed: 2026-07-22

This chapter covers the three AI assistants that front Brix Beverage: the phone line at **(510) 800-6281** (Chloe for customers, Ziggy for staff), **Mr. Bubbles** (the portal chat assistant), and the shared **knowledge base** that grounds all of them. It is written for staff who need to know what the bots can do, how to teach them new material, and how the plumbing hangs together.

## The AI phone line — (510) 800-6281

One brain, two faces. Calls flow **Retell** (telephony / speech-to-text / text-to-speech) → a **Railway** websocket gateway (holds only `BRAIN_URL` + `BRAIN_TOKEN`) → **`voice-brain.ts`** (a brix-order Netlify function holding all secrets and running the Claude tool loop). The agent answers as **Chloe** for customers and switches to **Ziggy** when the caller ID matches a superadmin's phone (`orders.customer_users.phone`).

### Chloe — the customer face

**Identity & verification.** Chloe auto-attaches known callers by caller ID via `orders.v_customer_phone_directory` (customer phones ∪ portal users ∪ the QBO mirror). Unknown callers verify by a 6-digit code emailed to their account address. All account data is hard-scoped server-side — the model can only see the attached customer.

**Account lookups.** Balance, invoices, orders, and cylinder counts for the attached account.

**Phone orders.** Chloe takes orders through the **same `submit-order` pipeline as the web portal** (an internal-token path that skips only the membership gate — pricing, SF job creation, emails, everything else is identical). Differences worth knowing:

- The SF job is categorized **"Brix Phone Order"** (env `SF_PHONE_ORDER_JOB_CATEGORY`); portal and admin quick-orders get "Brix Web Order". Both categories must exist in SF Settings → Job Categories; the submit retries without the category rather than losing an order.
- Chloe **always asks about empty tank pickups** on gas orders, reads the order back, and requires an explicit yes before submitting.
- The cart persists per call (`orders.voice_call_sessions`), so a dropped call doesn't lose the order in progress.

**Service calls.** Chloe can file a service ticket (`file_service_call`) — only on a call attached to an account. The ticket inserts `orders.service_requests` (source `voice_bot`), pushes straight into Service Fusion, and emails service@brixbev.com. She confirms before filing, reads the ticket number back, and never files twice. Mr. Bubbles has the same tool (below).

**Troubleshooting help.** Chloe answers equipment questions from the knowledge base with conversation-aware retrieval — the RAG query blends the last several turns, so a mid-troubleshoot "okay, then what?" still retrieves from the right guide.

### Ziggy — the staff face

Ziggy greets recognized superadmins by name (caller-ID match) and can do everything Chloe can, plus:

- **Order on behalf of any account** (`act_as_customer`) — the phone equivalent of the admin console's act-as.
- **Training mode**, opened by a spoken code. Teachings persist: factual knowledge lands in the **`phone-teachings`** KB document (managed on /admin → Knowledge) and style/behavior rules land in **`orders.voice_teachings`** (reviewable in the same tab's Voice teachings panel); both are injected into every future call. Training mode also has web tools — `import_web_page` (fetch → distill → KB doc) and `research_web` (live web search) — and nothing from the web is saved without the owner's explicit say-so.
- **HQ mode**, opened by a second spoken code — a generic MCP bridge (`enter_hq_mode` / `hq_list_tools` / `hq_run`) to the servers listed in the `HQ_MCP_SERVERS` env JSON: QuickBooks + Zoho via pacerfinance, Outlook via pacer-outlook. Adding a server is env-only, no code change.
- **ASM gate** — the ASM servers (asm-github, asm-specialist, hyperleda) carry `"gate":"asm"` in `HQ_MCP_SERVERS` and sit behind their own spoken **word phrase**. Regular HQ mode neither lists nor reaches them, and Ziggy never mentions ASM unless the owner asks for it.

### The spoken codes

> **Never write the codes down anywhere — including this handbook.** They live only in the brix-order Netlify env vars: `VOICE_TRAINING_CODE`, `VOICE_HQ_CODE`, `VOICE_ASM_CODE`.

Routing is by shape: a **short digit** code opens training mode, a **long digit** code opens HQ mode, and a **word/phrase** opens ASM access. Codes are compared digit-by-digit, disambiguated by length, and the agent never reveals them.

## Mr. Bubbles — the portal chat assistant

Mr. Bubbles is the chat widget inside the signed-in portal at https://orders.brixbev.com (backend: `kb-chat`). Key facts:

- **Big window:** the widget can expand to a near-fullscreen panel (maximize button on desktop) — the `/resources` page's "Ask Mr. Bubbles" opens it expanded so customers can read guides and watch videos alongside the chat.
- **Grounded on the KB:** answers come from the knowledge base via RAG with the same conversation-aware retrieval as the phone line. Grounding rule: the bots never invent prices, policies, or phone numbers.
- **Files service calls:** same `file_service_call` pipeline as Chloe (source `mr_bubbles`), with the customer resolved server-side from the signed-in user — the model never picks the account. Confirms before filing and reads the ticket number back.
- Hidden KB docs (`customer_visible = false`) still inform chat answers; they just don't appear in the `/resources` library.

## The knowledge base

All three assistants ground on **`orders.kb_documents`**, which has two kinds of content:

1. **Repo-sourced docs** — markdown files in `activespacescience/brix-order/content/knowledge-base/`, shipped with the functions and loaded by the ingestion endpoint.
2. **Admin-managed docs** — created or edited in **/admin → Knowledge** (including `phone-teachings`). These live in the database, take effect immediately with no deploy, and are managed in-app — they are not overwritten by re-running ingestion of the repo files.

Each doc has a **`customer_visible`** flag: visible docs appear in the customer **`/resources`** library (searchable, grouped, with embedded how-to videos and printable article pages at `/resources/:slug`); hidden docs (e.g. `phone-teachings`) remain chat-only.

### Refreshing after repo KB changes

Whenever KB markdown files change in the repo, run ingestion after the deploy (idempotent; slug = filename; replaces that document's RAG chunks; new files ingest automatically):

1. Merge and deploy the brix-order change.
2. Run:
   ```
   curl -X POST https://orders.brixbev.com/.netlify/functions/kb-ingest \
     -H "x-admin-token: $ADMIN_SYNC_TOKEN"
   ```
   (`ADMIN_SYNC_TOKEN` is a brix-order Netlify env var.)
3. Until this runs, the bots answer from the previously ingested content.

### KB catalog (current)

| Topic | Documents |
|---|---|
| Fountain & soda machine troubleshooting | `soda-machine-troubleshooting`, `soda-machine-dispensing-failures` (official symptom flows: carbonator reset, stuck valves, runaway BIB pump), `fountain-dispenser-troubleshooting` (foaming deep dive, ice-bridge, off-taste) |
| Bar guns | `bar-gun-troubleshooting` (per-button failures, ratio problems, seal map, cleaning) |
| CO₂ & gas safety | `co2-troubleshooting-and-safety` (system anatomy, leak detection, swap steps, beverage-grade-only rule), `tank-co2-rentals` (rental program, yield reference) |
| Syrup & supplies | `bib-syrup-handling` (storage, box changes, connector care, video links) |
| Startup, quality & maintenance | `fountain-startup-shutdown` (incl. boil-water advisory rule), `beverage-quality-standard` (5 Steps to Quality, 32–40°F, 95–105 psi), `preventive-maintenance-cleaning` (daily/weekly/monthly, technician-only items) |
| Ice machines | `ice-machine-troubleshooting` |
| Specialty dispensers | `frozen-drink-machine-guide` (slush + FCB), `tea-coffee-brewer-guide`, `juice-dispenser-guide` |
| Portal, ordering & billing | `portal-user-guide` (the full customer manual), `account-billing-faqs`, `ordering-delivery-faqs` |
| Index | `alameda-soda-resource-library` (links to the printable originals + BIB videos; skipped on `/resources`, which is itself the index) |
| Staff-only (hidden) | `phone-teachings` (Ziggy training-mode knowledge; `customer_visible = false` — must never be flipped visible) |

All equipment content is deliberately **brand-free** (no equipment-manufacturer or source-portal names) and customer-safe: no invented prices or policies, gas safety escalates to stop/ventilate/contact support, and the grounded support contacts are **800-372-5098** / **service@brixbev.com**.

## Teaching the bots something new

Three paths, by durability:

1. **Quick, staff-editable** — /admin → Knowledge: create or edit a doc in the editor, set `customer_visible` as appropriate. Live immediately for chat, phone, and `/resources`. Best for policies, FAQs, and corrections.
2. **Durable, versioned** — add or edit a markdown file in `brix-order/content/knowledge-base/`, deploy, then run the `kb-ingest` curl above. Best for substantial guides you want in git history.
3. **By phone (owner only)** — call the line, open Ziggy's training mode with the spoken code, and dictate. Knowledge persists to `phone-teachings`; style/rules persist to `orders.voice_teachings`. Review afterward in /admin → Knowledge.

## Ops notes

| Item | Detail |
|---|---|
| Phone number | (510) 800-6281 |
| Retell agent | `agent_204ced441f87f6a9a17673554c` |
| Railway gateway | `gateway-production-5284.up.railway.app` (holds only `BRAIN_URL` + `BRAIN_TOKEN`) |
| Brain | `netlify/functions/voice-brain.ts` in brix-order (all secrets, Claude tool loop) |
| Per-call state | `orders.voice_call_sessions` (cart, verification, mode flags) |
| Phone lookup | `find_customers_by_phone()` is SECURITY DEFINER, service-role only |
| Env vars | `VOICE_BRAIN_TOKEN`, `VOICE_TRAINING_CODE`, `VOICE_HQ_CODE`, `VOICE_ASM_CODE`, `HQ_MCP_SERVERS`, `RETELL_API_KEY`, `SF_PHONE_ORDER_JOB_CATEGORY`, `BOT_SERVICE_SECRET` (server-to-server service-request endpoint), `ADMIN_SYNC_TOKEN` (kb-ingest) |
| SMS | Portal SMS-consent shipped; texting is gated on A2P 10DLC approval (filed 2026-07-14) |
| Known issues | pacer-outlook's M365 token expires and needs re-auth at pacer-outlook.netlify.app/outlook/auth; its MCP endpoint has no API-key gate (fix belongs in `skypace/Pacer-outlook`). The ASM Astro MCP (Cloudflare, bearer-token) is not wired into HQ mode — needs its token added to `HQ_MCP_SERVERS`. |

## Related

- [Brix Order /admin — Staff Console](#/03-brix-order-admin) — the Knowledge tab and Quick order (the human equivalents of Ziggy's tools)
- [Brix Order Portal — Customer Ordering, Billing & Resources](#/02-brix-order-portal) — where Mr. Bubbles and `/resources` live
- [SOP-3 · Orders & Fulfillment](#/23-sop-orders-fulfillment) — phone-order and service-call procedure
- [SOP-9 · Data & Engineering](#/29-sop-data-engineering) — AI grounding rules and secrets handling
- Source docs: `activespacescience/brix-order` `CLAUDE.md` (sessions 1.70–1.79), `content/knowledge-base/` (catalog), `ARCHITECTURE.md` ("Voice agent — HQ MCP bridge")
