# Sub-distribution agreements — build, send, sign, file

> Refractor → **Sub-Distributors → Agreements**. The partner signs on a link
> with no login; the executed PDF is emailed to both sides and filed in the
> `distributor-docs` bucket.

Two paths exist on that tab and they are deliberately distinct:

| Path | What it is |
|---|---|
| **Upload a signed PDF** | Paper that already exists, filed against the partner. The pre-2026-09 flow; untouched. |
| **Build an agreement** | Our template, filled in per partner, previewed, and emailed for signature. Everything below. |

A row is one or the other: a built agreement carries `body_source`, an
uploaded one carries `file_path`. `isBuiltAgreement()` is the test, and the
table offers the right actions for each.

---

## The agreement

`netlify/functions/lib/distributor/subdist-agreement-v1.mjs` — 34 clauses in
six parts, drafted 2026-09-04 against how the business actually runs:
consignment, Service Fusion dispatch, portal receiving, monthly settlement out
of our own system.

⚠ **This is our paper, not legal advice.** Counsel should read it before the
first one goes out.

The clauses that carry the weight, and why they are worded as they are:

| | |
|---|---|
| **§2** | Title stays with Company until Company invoices the end customer. That is the whole consignment position and everything else leans on it: their creditors cannot reach the stock, and product that moves is a receivable of ours, not a sale of theirs. |
| **§3** | Everything sold to their customers is due to us. Their compensation is a delivery fee, never a margin on resale — stated that way so it cannot be re-characterised later. |
| **§6** | Every delivery and service call is dispatched, performed and closed in Service Fusion. **Work not recorded there is not compensable**, and the clause says so rather than leaving it to a settlement argument. |
| **§7** | Receiving each shipment in the portal, line by line, within two business days. This is not paperwork — it IS the reconciliation, so it is written as a condition of payment. |
| **§9** | Missing consigned stock is charged at list price and set off against fees. |
| **§12** | Company's records are the record. 15 days to dispute a settlement, then it is final. |
| **§13** | Response times. **Level 1 is the emergency at 24 hours**, 2 at 48, 3 at 72. "Response" means a qualified technician on site and working — not a returned call. |
| **§16** | They MAY sell their own branded craft soda. They may never **solicit a Company Customer**, for the term and 12 months after. Narrower and sharper than a blanket non-compete: the risk is not that they have a brand, it is that they are standing in our account with our product on their truck. |
| **§18** | 24 hours to say where a lot code went. |
| **§23** | Insurance, additional insured, and *"a certificate is not the endorsement"*. The LIMITS live on the Schedule — see below. |
| **§25** | One year, auto-renewing, either side out on 30 days; immediate for cause. |
| **§31** | Electronic Signature and Records. The NDA had to have this ADDED after the fact; it is here from the start, because it is what makes a signature collected on a screen hold up. |

The appointment is **non-exclusive** (§1) in every respect.

---

## The Schedule is where the numbers live

The body is fixed wording. Territory, accounts, fees, the settlement day, the
payment term, the notice addresses **and the insurance limits** all sit on the
**Fee and Territory Schedule**, stored as `deal_terms` jsonb and rendered from
the `[FEE_SCHEDULE]` marker.

⚠ **§23 obliges them to insure "in the minimum limits Company specifies in
writing", and the Schedule IS that writing.** Drop the insurance block and the
obligation has no number attached to it.

Two rules about defaults, both tested:

* **A missing key takes the shipped default.** `dealTerms()` fills territory
  and the per-case fee from the partner record, and the response times and
  insurance limits from `DEFAULT_SERVICE_LEVELS` / `DEFAULT_INSURANCE`.
* **An explicitly EMPTY array means none.** A partner who does no service work
  has no response times, and quietly restoring the three defaults there would
  commit them to hours nobody agreed to. The form has a *They do no service
  work* button, and the document then says §14 and the service-performance
  grounds in §25 are inoperative.

A Schedule row with nothing in it renders **"not specified"** rather than being
omitted — §1 and §30 define themselves by reference to the Schedule, so a
silently absent row is indistinguishable from a term that was never meant to
exist. The FEE table is the exception: it is a list of lines, and a line that
does not exist should not be invented, so an empty one reads *"No fees have
been entered on this Schedule."*

---

## One parse, three renderers

```
subdist-agreement-v1.mjs   the wording, in version control
        │
        ▼
parseNdaSource()           ← SHARED with the NDA (lib/nda-doc.mjs)
        │
        ├── renderSubdistHtml()  → the signing page, the staff preview
        └── renderSubdistPdf()   → the executed PDF (lib/legal-pdf.mjs engine)
```

Two copies of the text could quietly disagree about what somebody signed, so
the parser is shared and only the MARKER blocks differ. `[PARTIES]`,
`[FEE_SCHEDULE]`, `[SERVICE_LEVELS]` and `[SIGNATURES]` read differently here
than on an NDA, so `subdist-doc.mjs` owns them.

`lib/legal-pdf.mjs` is the page engine, extracted from `nda-pdf.mjs` when this
document needed the same treatment: geometry, wrapping with bold runs, the
WinAnsi fallback, the letterhead, the signature embed, the fill-in line, the
footers. Which BLOCKS a document draws stays the document's own business.

The PDF is 8 pages for a typical agreement: the clauses, the signature blocks,
**the Fee and Territory Schedule on its own page**, and — once signed — the
**electronic signature record** (typed name, timestamp, IP, browser, consent
flag, when the link was sent and first opened). A drawn squiggle proves very
little; that page is what makes it defensible. Every page is stamped either
*Executed electronically* or **DRAFT — not yet executed**.

---

## The flow

```
Build      staff fill the Schedule            → status draft, SDA-YYYY-NNNNN
Preview    the document, or the PDF             (writes nothing)
Send       token minted, our side executed    → status sent, email out
  ↓
Open       partner reads it                   → viewed_at stamped
Sign       their details + typed name + pad   → status signed, frozen
  ↓        PDF rendered, filed, emailed both sides
Done
```

Anything unsigned can be **switched off** (`revoke`) or re-issued (**Send
again**, which mints a new token and kills the old one in the same write).

### What is snapshotted, and why

`body_source`, `deal_terms`, the counterparty block and the company signature
image are all COPIED onto the agreement row at build/send time. Templates stay
editable — publish 1.1 without a deploy — but **editing one must never change
what somebody already signed**. A signature pointing at mutable text is not
evidence of anything.

`tg_subdist_agreement_freeze` enforces it at the database: once
`status='signed'`, any change to the text, the terms, the signature or the
status is refused by name. Filing columns (`executed_pdf_path`, `notes`) still
land, because that is the same execution event finishing.

### The token

32 random bytes, base64url; **only the sha256 is stored**. The raw token exists
in the emailed link and in the one API response that mints it, so a database
read can never yield a working signing link and a lost link is RE-ISSUED, never
recovered. 30-day default, 1–365, **no unlimited option**.

An unknown token and a malformed one answer identically — the difference would
tell a prober which tokens exist.

### Filing never un-signs anything

The signature is recorded FIRST. The PDF, the bucket upload and the two emails
are each best-effort afterwards and record their own failure into `notes`. The
signing page **says so** and pushes the signer to download the PDF then and
there, rather than implying everything landed.

⚠ A malformed signature image is refused **on the page**, while the signer can
still draw it again — `describeImageProblem()` walks the PNG/JPEG container
structurally before pdf-lib ever sees it, because pdf-lib's decoder **spins
forever** on some malformed files, synchronously, where neither a catch nor a
timeout can help.

---

## Where things live

| | |
|---|---|
| Wording | `netlify/functions/lib/distributor/subdist-agreement-v1.mjs` |
| Registry | `.../lib/distributor/index.mjs` — seeds the DB template on first use |
| Shared plumbing | `.../lib/distributor/subdist-agreement-lib.mjs` — token, `linkUnusable`, upload, `companySignatory` |
| HTML | `.../lib/distributor/subdist-doc.mjs` |
| PDF | `.../lib/distributor/subdist-pdf.mjs` on `lib/legal-pdf.mjs` |
| Staff API | `netlify/functions/subdist-agreement.mjs` (superadmin \| admin) |
| Public API | `netlify/functions/subdist-sign.mjs` (token only) |
| Signing page | `public/distributor-agreement.html` → `/distributor-agreement` |
| Staff UI | `app/src/pages/distributors/AgreementBuilder.tsx` + `AgreementsTab.tsx` |
| Tables | `ops.subdist_agreement_templates`, `ops.sub_distributor_agreements` |
| Bucket | `distributor-docs` (private), `agreements/<partner>/<SDA>.pdf` |
| Migration | `supabase/migrations/20260904a_subdist_agreement_builder.sql` |

Env: `NDA_EMAIL_FROM` (shared with the NDA, defaults `legal@alamedapointbg.com`),
`DISTRIBUTOR_ALERT_TO` (defaults `service@brixbev.com`),
`SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`.

⚠ `NDA_EMAIL_FROM` must be a REAL monitored mailbox — it is where a partner
replies with *"can we change clause 16"* — and `sendEmail()` falls back to the
alerts address when Resend rejects a sender, so a misconfiguration degrades
quietly rather than bouncing.

---

## Known gaps

* **Counsel has not read it.** Highest-value next step.
* **No chase.** Nothing reminds a partner who has opened the link and not
  signed. There is no cron here at all, so there is nothing for
  `ops.sync_health()` to watch — a chase would need a watcher in the same
  change, per this repo's rule.
* **The template editor is API-only.** `template_save` publishes a new version
  (it refuses to overwrite one in place, because somebody may be reading it
  mid-sentence on a live link), but there is no screen for it — edit the
  shipped file and deploy, or POST the action.
* **No countersignature step.** The company block is pre-executed at send time
  by the staff member sending it. This is our paper on our terms and the assent
  being collected is theirs; a genuine two-step countersignature would be a
  different flow.
* **The Schedule is free text where it could be structured.** "the 10th day of
  the following month" is a sentence, not a date rule, so nothing computes the
  settlement run from it. The settlement engine
  (`fn_distributor_settlement_create`) is driven separately.
