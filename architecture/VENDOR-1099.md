# 1099 / W-9 tracking

`ops.vendors` has carried `w9_status` and `ein_last4` since the vendor registry
shipped, and nothing read either. This makes them worth filling in.

## What it is for

The value is **timing**, not filing. Chasing a W-9 in January, from a contractor
who finished in March and stopped answering, is the worst version of this job.
Knowing in August which vendors have crossed $600 with no W-9 on file makes it a
two-minute email.

> ⚠ **This is a worklist, not a filing.** `ops.fn_1099_candidates(year, threshold)`
> reads the QuickBooks expense mirror (`ops.qbo_expense_lines`: Bills +
> Purchases, less VendorCredits), which is **accrual**. 1099 reporting is
> **cash** — what you actually paid in the calendar year — so a bill entered in
> December and paid in January lands in the wrong year here. QuickBooks' own
> 1099 module files the forms and is right to. The page says so on screen; do
> not quietly turn this into the filing source.

It reads the mirror rather than `ops.expense_requests` on purpose: the mirror is
**everything we spent**, including bills keyed straight into QuickBooks that
never touched Brixpense.

## The fields

On `ops.vendors`:

| Column | Meaning |
|---|---|
| `tax_classification` | W-9 line 3 — `individual` · `sole_prop` · `partnership` · `c_corp` · `s_corp` · `llc_c` · `llc_s` · `llc_p` · `trust` · `other` |
| `is_1099` | Explicit override. **NULL means "derive from the classification"** |
| `tin_type` | `ein` or `ssn` (the full number never leaves the W-9 PDF) |
| `w9_received_at` | When it arrived |
| `backup_withholding` | Certification 2 struck, or an IRS B-notice — 24% withheld |
| `tax_address` | jsonb, for the address the form needs |

`ops.fn_vendor_is_1099(is_1099, tax_classification)` decides when nobody has:
corporations (`c_corp`, `s_corp`, `llc_c`, `llc_s`) are exempt, everyone else is
reportable, and an explicit `is_1099` always wins. **The override exists because
the corporate exemption has carve-outs** — attorneys and medical providers get a
1099 regardless — and that is a fact about what the vendor *does*, which no
checkbox on a W-9 can tell you.

## Reading the list

`needs_w9` is the actionable column: over the threshold, **not known to be
exempt**, and no W-9 on file. An *unclassified* vendor counts as needing one —
somebody we know nothing about is exactly who you want to ask.

The list starts long and shrinks as vendors get classified. On first run every
over-threshold vendor appears, because the registry is largely empty and most of
that spend is utilities, card processors and a lender that need no 1099 at all.
Marking one exempt on its vendor record takes it off the list for good.

The UI floats **likely individuals** to the top (`looksLikePerson` in
`app-expense/src/lib/vendors.ts`) — an individual contractor is the likeliest
1099 and the hardest to chase later. It is a **sort hint only and must stay
one**: it is a guess about a name, and dropping a real obligation because a sole
proprietorship trades under a company name is the failure that costs money.

## Where it lives

- Report: Brixpense → Vendors → **1099s** (`/expense/tax-1099`), with CSV export.
- Per-vendor fields: the vendor's own record, next to the W-9 status.
- Both are staff-gated (`ops.fn_assert_staff_or_service()` inline in the RPC —
  it is a new function, **not** generator-wrapped, so keep the guard on any edit).

## Filing the paperwork

Three doors, one mapper. `lib/vendor-doc-apply.mjs` is what turns an OCR'd form
into vendor columns, and **every** path goes through it so the same document
produces the same record whichever way it arrives:

| Door | Who | Where |
|---|---|---|
| The onboarding link | the **vendor**, from an emailed one-time link | `vendor-onboard.mjs` |
| Drop it on the vendor | **staff**, with a document they already have | `vendor-doc-upload.mjs` |
| Drop it on the Vendors list | **staff**, for a vendor we do not have yet | `vendor-doc-upload.mjs`, no `vendor_id` |

Drop a **W-9**, a **certificate of insurance** or a **bill** onto the vendor
record — several at once is fine — and it works out which is which rather than
making you pick from a dropdown first. That friction is why documents sit in
an inbox instead of getting filed. Classification is a cheap pass over page one
and it always reports what it decided, so a wrong guess is visible and one
click to correct; when it genuinely cannot tell, it asks.

### A W-9 for a vendor we do not have

Drop it on the **Vendors list** and it creates the vendor. The form carries
everything the record needs — legal name, business name, entity type, TIN,
address — so making someone key that in first and upload second is work the
document can already do.

Before creating anything it looks for a vendor we already have, by normalised
display name, then legal name, then TIN, and **files against them instead** if
it finds one. A duplicate vendor is worse than no record at all: it splits the
bill history across two rows and hides the vendor from `fn_1099_candidates`,
which is the precise failure this whole page exists to prevent. The result says
which of the two happened and why.

A **COI** or a **bill** still needs a vendor to be filed against. Neither
identifies a payee well enough to create one — a certificate names the
*insured*, who is not necessarily who we pay, and an invoice letterhead is
often a trade name rather than the legal entity on the check.

> ⚠ **A dropped bill does not become a payable.** It is read for what it says
> about the *vendor* — remit-to, terms, legal name — and the read is handed to
> the expense form for a human to file. A money row must not be a side effect of
> a drag gesture; that is the 2026-08-14 QuickBooks gate, one step earlier.

### What a W-9 fills in

`w9_status`, `w9_received_at`, `ein_last4`, `tin_type`, `tax_classification`,
`tax_address`, and `legal_name` **only if the record has none** — a name someone
curated is never overwritten by OCR.

This is the fix for the gap that made the 1099 worklist read wrong: `runW9Ocr`
had always extracted `entity_type` and `tin_type`, and the write path put them
in a free-text notes sentence and dropped them. The columns stayed empty, so a
vendor with their W-9 sitting in the vault still showed as needing one.

`is_1099` is deliberately **not** set from the form. It stays NULL so it derives
from the classification — and an exempt payee code on a W-9 is about *backup
withholding*, not 1099 reporting, so reading it as an exemption would silently
drop a real obligation.

A classification the mapper cannot pin down (a bare "LLC" — a single-member LLC
checks the *individual* box, so the form genuinely does not say) is **left blank
and reported**, never guessed.

### What a certificate fills in

A `compliance_documents` row under the vendor's insured party, created on the
fly if they have none, with limits and policy numbers in the notes and — the
load-bearing field — an **expiration date, taken from the earliest-expiring
line**, not the general-liability one. A certificate is only as current as the
first coverage to lapse. That date is what the weekly expiry digest chases.

Shortfalls against the vendor's own `requirements` are recorded on the row, and
so is the additional-insured caveat from SOP-11: the box being ticked is not the
endorsement.


## Pushing a vendor into QuickBooks

The **Push to QuickBooks** button on a vendor record does the two things people
otherwise do by hand: creates the QuickBooks Vendor, and attaches that vendor's
paperwork to it so whoever is looking at a bill can see the vendor is actually
documented.

It **never creates a second QuickBooks vendor**. An existing `qbo_vendor_id` is
verified first, then an exact `DisplayName` match is linked to, and only then is
one created. QBO rejects duplicate display names anyway, so a blind create just
400s — but linking is also the right answer, for the same reason the W-9 drop
matches before it creates: a split vendor history is worse than a slow one.

> ⚠ **The full tax ID is never sent.** `ops.vendors` holds `ein_last4` only —
> deliberately — and a partial `TaxIdentifier` would be worse than an empty one
> because it *looks* filled in. The whole number is on the W-9 itself, which is
> precisely why attaching the document is the half that matters.

`Vendor1099` is set only from an **explicit** `is_1099` override. Null means
nobody has decided, and inferring it from a W-9 checkbox is the mistake this
whole page exists to prevent.

Attachments go through QuickBooks' Attachable API (`POST
/v3/company/{realm}/upload`, multipart `file_metadata_01` + `file_content_01`;
`Vendor` is a supported `AttachableRef` entity). They are **best effort and
reported per file** — one unreadable document cannot lose the vendor push or
the other attachments, and the response says exactly which did what.

