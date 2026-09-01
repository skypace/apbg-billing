# Electronic NDAs

**What it is:** a link you send a co-packer, lab or vendor. They fill in their own
company details, read the agreement, and sign on screen. The executed PDF is
emailed to both sides and filed in the compliance vault against that party.

**Where staff work:** Compliance & Safety → **NDAs** (`alamedapointbg.com/compliance`).
**Where they sign:** `alamedapointbg.com/nda?t=<token>` — public, no login.

---

## Why it is shaped this way

An NDA is only worth having if, years later, you can show a court three things:
what they agreed to, that it was them, and what you actually gave them. Every
design decision below serves one of those.

### 1. The signed text is snapshotted, never referenced

`nda_templates` holds editable versions of the agreement. When staff send one,
the entire text is **copied onto the agreement row** (`nda_agreements.body_source`).
From that moment the agreement renders — on screen, in the PDF, in a download
three years later — from its own copy.

Editing a template therefore cannot change what somebody already signed. A
signature that points at mutable text is not evidence of anything.

`nda-admin`'s `template_save` refuses to overwrite a version in place for the
same reason, one step earlier: agreements already sent point at that row, and a
pending signer could be reading it mid-sentence. Publish 1.1 instead.

### 2. A signed row is frozen by the database, not by convention

`ops.tg_nda_freeze_signed` raises on any update that touches the executed terms,
the signature, the signer, the dates or the status once `status = 'signed'`.
Filing columns (`pdf_path`, `document_id`, `insured_party_id`) are still allowed
to land after signature — that is the same execution event finishing.

### 3. One parse, two renderers

`lib/nda-doc.mjs` parses the template markup into blocks. The signing page's HTML
and `lib/nda-pdf.mjs`'s PDF both consume those blocks. If the screen and the PDF
were rendered from two copies of the text, the thing somebody signed and the
thing in the vault could quietly disagree.

### 4. The audit page is part of the document

A drawn squiggle proves very little. The executed PDF's last page records the
typed name (intent to sign), the timestamp, the signer's IP and browser, when the
link was sent and first opened, the consent flag, and the template version. That
page is generated, not typed.

### 5. The Purpose is captured, and the disclosures are logged

`purpose_scope` + `services` say why they are getting our formulations at all —
the clause a dispute actually turns on. `nda_disclosure_log` is Exhibit A as a
running record rather than a blank table in a PDF: every batching sheet, spec and
sample, with date, format and quantity. The agreement says a missing entry does
not remove protection; the log is what makes "they had our formula" provable.

---

## The flow

```
Staff: Compliance & Safety → NDAs → "+ Send an NDA"
  │   company, email, purpose, services, who signs for us, expiry
  ▼
nda-admin  create
  │   · resolves the active template (seeds the shipped v1.0 on first use)
  │   · allocates NDA-YYYY-### via ops.fn_next_nda_number()
  │   · SNAPSHOTS the text onto the row
  │   · mints a 32-byte token, stores only its sha256
  │   · countersigns for the Company (see "Who signs for us" below)
  │   · emails the link — and always returns it, so a Resend outage
  │     means "paste it into a message", not "no way to reach them"
  ▼
Recipient opens /nda?t=…  →  nda-sign  view   (stamps viewed_at)
  │   fills in legal name / entity / address / signer / email
  │   reads to the end, types their name, draws a signature, ticks consent
  ▼
nda-sign  sign
  │   · validates, stamps signed_at + effective_date (Pacific), IP, user agent
  │   · PATCH guarded on status ≠ signed, so two tabs cannot double-sign
  │   · renders the PDF  →  compliance-docs/nda/NDA-YYYY-###.pdf
  │   · ensures the insured_parties row (matches by name before creating)
  │   · files ops.compliance_documents (category 'legal', doc_type 'NDA')
  │   · emails the PDF to the signer and to COMPLIANCE_ALERT_TO
  ▼
Executed. The recipient can re-open the link any time to re-read or
re-download; staff see it in the NDAs tab and in the vault.
```

**Filing never un-signs anything.** Once the signature is recorded, the PDF,
vault and email steps are each best-effort and record their own failure into
`notes`. A storage hiccup is an operations problem to fix later, not a reason to
tell somebody their signature did not take. The page says so plainly and pushes
them to download the PDF there and then.

---

## Who signs for us

The Company block is **pre-executed at send time**: the officer's name, title
and **their actual signature** are stamped onto the agreement before it goes
out. This is our paper on our terms; the assent being collected is the
recipient's.

Signatures live in `ops.nda_signatories` — draw or upload one once, under
**Compliance & Safety → NDAs → Signatures**, and it prints in the Company block
of every NDA sent from then on. Three rules make that safe:

- **It is snapshotted onto the agreement** (`company_signature_data`), exactly
  like `body_source`. Re-drawing your signature cannot change a document
  somebody has already signed, and the freeze trigger covers the column.
- **Only a `data:` image is accepted**, capped in size. This ends up embedded in
  a legal record; a remote URL would be a live dependency inside it, and
  arbitrary text would be an injection.
- **A missing signature is not an error.** The agreement goes out with a typed
  name over a rule, which is what we sent for months and is still valid. Losing
  an agreement over a PNG would be absurd.

Delegated sender links carry a `company_signatory_id` and read the signature
**fresh at send time**, so re-drawing it takes effect on their next send rather
than leaving a stale image on every future agreement.

If you ever need a genuine two-step countersignature — a negotiated NDA on their
paper, say — that is a different flow and should be built as one, not bolted on
by leaving the Company block blank.

---

## One-way or mutual

Two agreements ship, and the sender picks:

| | |
|---|---|
| **One-way** (`copack-nda`) | They receive our information. Co-packers, labs, vendors we hand formulations to. |
| **Mutual** (`mutual-nda`) | Both sides disclose, and it binds **us** on the same terms. |

`mutual` is a flag **on the agreement**, snapshotted at send — never derived
from the template code, so a template that is later renamed or re-coded cannot
retroactively change how an executed agreement reads. It drives the preamble
("Brix" and "Counterparty" rather than "Company" and "Recipient", plus a line
saying each Party acts as both Discloser and Recipient) and the signature-block
headings, in the on-screen document and the PDF alike.

⚠ **The mutual text is an adaptation of the approved one-way agreement, not
separately drafted paper.** Two departures from it are deliberate and worth
knowing before you send one:

- **§7 is narrower.** The one-way "shall not develop any similar product"
  covenant cannot be reciprocal between two beverage companies without stopping
  both of us trading, so mutually it is scoped to use *of the other side's*
  Confidential Information, with an express carve-out for independent
  development.
- **The Work Product assignment is removed.** In a one-way co-packing agreement
  a co-packer assigning its work to us is correct; mutual, the same clause would
  assign our work to them. Each Party keeps its own, and anything joint is left
  to a definitive agreement.

Have counsel read it before it goes to a counterparty who matters.

---

## Security posture

| | |
|---|---|
| Signing page | Public. The counterparty has no login and never will. |
| Gate | The token. 32 random bytes, base64url; only its **sha256** is stored, so a database read cannot mint a signing link. |
| Expiry | 30 days by default (1–120). A signed agreement stays readable at its link forever — re-reading what you signed is legitimate. |
| Resend | Mints a **new** token and kills the old one. A resend usually means the first link went astray. |
| Revoke | Kills the link. Refused once signed — an executed agreement is terminated in writing under §14, not by a button. |
| Staff API | `requireAuth(req, ['superadmin','admin'])`, matching `ops.fn_is_staff()` and the RLS on all three tables. |
| RLS | Staff only, both directions. An NDA names a counterparty and the scope of work we are discussing with them — not for every login on this shared Supabase project. |
| Anon | Nothing. The public page reaches the row only through the service-role function, keyed by a hash it cannot read. |
| Sender links | Same token model (sha256 only). Per-person, expiring, revocable, rate-limited on a rolling 24 hours, send-only, and every send copied to compliance. See below. |

---

## ESIGN / UETA

Section 21 was **added to the supplied text** so that signing on screen actually
satisfies the federal ESIGN Act and California's UETA. It carries the three
things those require and the original draft did not have:

- consent to transact electronically and to sign electronically;
- that the typed name plus the drawn signature constitute the signature;
- delivery of a **retainable** copy (emailed PDF + download at signing) and the
  right to request paper.

The page collects that consent as an explicit tick, records it as
`consent_esign`, and prints it on the audit page.

> Not legal advice. The flow is built to the mechanics ESIGN/UETA describe;
> whether these particular terms suit a particular counterparty is a question
> for counsel.

---

## Sending without a login (delegated sender links)

Sometimes the person who needs to hand out an NDA has no hub account — a rep at
a trade show, an assistant covering the office. They get a **sender link**:
a personal page at `/nda-send` where they fill in the counterparty and press
send, and the recipient gets the same signing link staff would have sent.

**A sender link is a credential.** Whoever holds it can send Brix-branded email
to any address they like — that is a phishing tool with our domain on it. Every
constraint below exists for that reason, and none of them is decorative:

| | |
|---|---|
| Named, never shared | `person_name` + `person_email` are required. A link nobody owns is a shared secret, and a shared secret gets pasted into a group chat. |
| Send-only | It can create and email ONE agreement. It cannot list, open, revoke, download or edit anything. |
| Sees only its own | `recent` returns company, status and dates for agreements **this link** created — no addresses, no signer details, no PDF. |
| Rate limited | Rolling 24 hours (default 5, max 50), computed by `ops.fn_nda_link_sends_24h` from the agreements themselves — not from a counter a failed write could corrupt. |
| Expires | 90 days by default, 1–365. There is no unlimited option. |
| Revocable | Instantly, from the NDAs tab. The next request is refused. |
| Audited out of band | **Every send emails compliance AND the link's owner** — so the evidence lands in a mailbox the abuser does not control. |
| Fixed signatory | The company signer is chosen by the **issuer**. The delegate dispatches a document an officer already executed; they never sign for us. |

**The separation is structural, not a role check.** `nda-send.mjs` is a
different function from `nda-admin.mjs` and simply contains no code for listing,
opening or downloading an agreement — so no mistake in a gate there can expose
one. If a delegate ever genuinely needs those, that is the moment to give them a
login, not to widen this. It also cannot publish a template: a link on a fresh
environment with no seeded agreement is told to ask the office, rather than
improvising the terms it sends.

Issue one at **Compliance & Safety → NDAs → Sender links**: type their **name
and email**, press Issue, and we email them the link. Everything else has a
default — label, expiry, rate, and the countersigning officer, which comes from
the issuing staff member's **profile name**. It is never derived from an email
address: that name is printed on executed agreements as the officer who signed
them, and "Skypace" is not a signature. With no name on file, the issuer is
asked for one rather than being given a guess.

**Send again** on a live link mints a NEW token and kills the old one in the
same write. That is not a limitation to work around — the raw token is stored
only as a sha256, so re-sending the old one is impossible by construction, and
a link that needs re-sending has usually gone astray anyway. The person, the
signer and the limits all carry over.

---

## Files

| | |
|---|---|
| `supabase/migrations/20260826a_nda_agreements.sql` | Tables, freeze trigger, GRANTs + RLS, numbering, the vault's new `legal` category. |
| `netlify/functions/lib/nda/nda-v1.mjs` | The approved one-way v1.0 text, in version control. Seeds the database on first use. |
| `netlify/functions/lib/nda/mnda-v1.mjs` | The mutual variant, v1.0. Same structure, reciprocal obligations — see the header for every deliberate departure. |
| `netlify/functions/lib/nda/index.mjs` | The shipped-agreement registry and the flavour list the pickers render. |
| `netlify/functions/lib/nda/nda-logos.mjs` | Both brand marks, base64, bundled with the function for the PDF letterhead. |
| `supabase/migrations/20260828a_nda_signatures_mutual.sql` | `ops.nda_signatories`, the snapshot columns, the mutual flag, and the widened freeze trigger. |
| `netlify/functions/lib/nda-doc.mjs` | Markup parser + HTML renderer. The one source both renderers read. |
| `netlify/functions/lib/nda-pdf.mjs` | The executed PDF (pdf-lib): letterhead, wrapping, signature blocks, Exhibit A, audit page. |
| `netlify/functions/lib/nda-image.mjs` | Structural PNG/JPEG validation. **Load-bearing** — see the header: pdf-lib's decoder hangs forever on some malformed files, synchronously, so neither a catch nor a timeout helps. |
| `netlify/functions/lib/nda-lib.mjs` | Tokens, PostgREST, party + vault filing, the emails. |
| `netlify/functions/nda-sign.mjs` | `/api/nda-sign` — public: view / sign / pdf / decline. |
| `netlify/functions/nda-admin.mjs` | `/api/nda-admin` — staff: list / get / create / resend / revoke / log / templates / sender links (`link_create` / `link_list` / `link_resend` / `link_revoke`). |
| `netlify/functions/nda-send.mjs` | `/api/nda-send` — the delegated sender link: info / send / recent, and deliberately nothing else. |
| `supabase/migrations/20260827a_nda_sender_links.sql` | `ops.nda_sender_links`, `nda_agreements.sender_link_id`, the rolling-24h count function. |
| `public/nda.html` | The signing page. |
| `public/nda-send.html` | The delegated sending page. |
| `public/compliance.html` | Staff tab (NDAs). |
| `tests/nda.test.mjs` | 34 tests over the document core, the sender-link guard rails, the mutual variant, the stored signature and malformed images. |

**Env:** `SUPABASE_SERVICE_ROLE_KEY` (already set), `RESEND_API_KEY` /
`SENDGRID_API_KEY`, optional `COMPLIANCE_ALERT_TO` (default
`service@brixbev.com`), optional `NDA_EMAIL_FROM` (default
`Alameda Point Beverage Group <legal@alamedapointbg.com>`).

⚠ **`legal@alamedapointbg.com` must be a real, monitored mailbox.** It is the
reply-to on every NDA we send, so "can we change clause 9" lands there. And note
that `sendEmail()` falls back to the alerts address when Resend rejects a
sender — a misconfigured or unverified address degrades quietly rather than
bouncing, so check what actually went out before assuming it came from legal@.

**No cron, no background pipeline** — staff resend by hand — so there is nothing
new for `ops.sync_health()` to watch. If a chase cron is ever added, it needs a
check in `ops.fn_sync_health_extra()` in the same change, per the repo rule.

---

## Editing the agreement

1. Compliance & Safety → NDAs, or call `nda-admin` `template_save`.
2. Give it a **new version number**. Versions are immutable once published.
3. Publishing deactivates the previous version for that code. Agreements already
   sent keep their snapshot; new ones pick up the new text.

If the change is material, consider whether counterparties on the old version
should be asked to re-sign. Nothing forces that — the old agreements remain valid
on their own terms.
