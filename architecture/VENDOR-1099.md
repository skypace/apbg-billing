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
