# SOP-10 · CUPA & Health Inspection Readiness — Hazmat Records, SDS, Inspections

> Part II · SOP Manual · Owner: Sky Pace (EH&S) · Last reviewed: 2026-08-17

APBG maintains hazardous-materials and safety records **electronically**. This SOP defines where each record lives, who can produce it on demand, and how to run an unannounced inspection from the moment an inspector reaches the gate.

**Scope note — read this first.** This SOP is scoped to what each facility actually does and what its CERS filing declares. Claims about programs a facility has formally declared it does not run (on its CERS Business Activities page) do not belong in this document — an inspector reads an SOP as a list of records to ask for. Per-facility scope is stated in each section.

## Facilities & registrations

| Facility | CUPA | Registration | Programs |
|---|---|---|---|
| **1951 Monarch St, Hangar 200, Alameda** (Brix Beverage) | Alameda County Dept. of Environmental Health | CERS ID **10666381** — HMBP accepted 2026-08-12; next annual submittal **2026-08-10 (2027)** | Hazardous materials (CO₂) **+ used-oil generation from cooler dismantling on site** (hazardous waste in CA). ⚠ The 2026-08-10 Business Activities page answered **No** to hazardous waste generator — **correction required** (see "Dismantling & recycling operations"). Still No: UST, on-site treatment, APSA ≥1,320 gal, CalARP, HHW. |

## The digital-records rule

Electronic recordkeeping is permitted, but every required record must be **viewable on site, during the inspection, without delay**. "It's in the cloud, let me find someone with the password" is a documentation violation. The failure mode is access, not content. Controls:

1. **Compliance vault** — Refractor → Production → **Compliance & Safety** (staff login) holds documents, the SDS library, and the training log. Files live in the private `compliance-docs` bucket.
2. **CERS PDFs mirrored locally.** The five current CERS documents (Business Activities, Business Owner/Operator, Hazmat Inventory, ERCP, site map) are filed in the vault as PDFs — never CERS-only. Re-export after every submittal.
3. **Two credentialed people** on site during business hours hold CERS login + vault access. One is the designated escort.
4. **Quarterly access drill:** pick three records at random, time how long each takes to display. Target under three minutes. A failed drill is a corrective action, not a note.

## Record index — Hangar 200

| Record | System of record | Refresh |
|---|---|---|
| Business Activities / Owner-Operator ID | CERS `cers.calepa.ca.gov` + PDF in the vault | Annual certification (next: 2027-08-10) |
| Hazardous Materials Business Plan (HMBP) | CERS submittal + PDF mirror | Annual; **within 30 days of any material change** |
| Chemical inventory (CO₂: bulk tank + cylinders) | CERS Hazmat Inventory | Reconcile quarterly against physical count and the bulk tank nameplate |
| Facility site map ("Map A1", tank #4461) | CERS attachment + PDF in the vault | Reissue on any layout change |
| Emergency Response / Contingency Plan | CERS consolidated form + PDF in the vault | On any change of contacts, equipment, or layout |
| Annual HMBP training records | **Vault → Safety & Training** (roster, date, topics, trainer, signed sheet) | Annual per employee; within 6 months of hire |
| SDS library | **Vault → SDS Library** | On any new chemical received; verify revision on reorder |
| Health permit (food/beverage) | Posted physical copy + PDF in the vault | Annual renewal |

## SDS policy

- **Every hazardous chemical on site gets an SDS row — regardless of quantity.** Small paints, cleaners, sanitizers, aerosols, lubricants, glycol, compressed gases. The 55 gal / 500 lb / 200 cu ft numbers are CERS *reporting* thresholds, not SDS thresholds; the SDS library is deliberately a longer list than the CERS inventory.
- The sheet filed must come from the **manufacturer of the product actually purchased** — not a generic sheet for a similar product.
- Each row records: product name as labeled, manufacturer, storage location, container type, max quantity on site, SDS revision date, and whether the product is also on the CERS inventory (`CERS reported` flag).
- **Threshold watch:** if any product's max-on-site crosses a CERS threshold (55 gal liquid / 500 lb solid / 200 cu ft compressed gas), it must be added to the CERS Hazmat Inventory **within 30 days**. Flag it when checking the box in the vault.
- New chemical arrives on site → SDS filed in the vault **before** the product goes into service. Receiving is not complete until the row exists.

## Inspection day — runbook

**At the gate**

1. Ask for credentials. Record name, agency, badge number, arrival time in the inspection log.
2. Page the designated escort. No one else guides the inspection. If the escort is unavailable, the named backup takes it — not whoever is nearest the door.
3. Notify the EH&S lead and CEO by text immediately, regardless of hour.
4. Seat the inspector at a screen with the vault + CERS PDFs open **before** the walk. Volunteering the digital setup reframes it as a strength.
5. If we know of a filing discrepancy, **say it before they find it**, with the correction already in motion.

**During the walk**

- Answer what is asked. Do not narrate, speculate, or offer history. "I'll confirm that and get back to you" is a complete answer.
- Never guess a quantity out loud — pull the number from the inventory or the nameplate.
- Photograph everything they photograph. Parallel documentation, timestamped, into the inspection log.
- Write down each flagged item in the inspector's own words, in the moment.
- Correct on the spot where trivially possible — an unsecured cylinder gets chained while they watch. Same-day correction can move an item from violation to observation.

**Before they leave — ask these four**

1. Which findings are **violations** versus **observations**?
2. Is any finding classified **Class I**, and on what basis?
3. What is the **correction deadline**, and what proof of correction is wanted?
4. Will a **reinspection** be scheduled, or is documentary proof sufficient?

**After**

| When | Action | Owner |
|---|---|---|
| Same day | File notes, photos, and the inspector's written report to the vault. Verbal debrief to EH&S lead. | Escort |
| Within 48 hrs | Every finding entered as a tracked corrective action with an owner and a due date ahead of the agency deadline. | EH&S lead |
| Before deadline | Submit proof of correction in the format the inspector requested. | EH&S lead |
| Within 30 days | Root-cause review. A finding that traces to a gap in this SOP amends this SOP. | EH&S lead + CEO |
| Annually | Recertify CERS, refresh HMBP training, re-mirror the CERS PDFs, reconcile the inventory. | EH&S lead |

## Monthly self-audit walk — Hangar 200

Run monthly and again the day before any scheduled inspection.

**Compressed gas & CO₂**

- [ ] Bulk tank nameplate capacity matches the CERS inventory line (container type, largest container, max daily amount)
- [ ] Tank #4461 emergency shutoff accessible and matching Map A1
- [ ] CO₂ monitoring/alarm on the tank powered and in a normal state
- [ ] All cylinders upright and secured — chained or racked, caps on when not in service
- [ ] Full and empty cylinders segregated and labeled

**Chemicals & hazard communication**

- [ ] Every chemical container on site has a row in the SDS library with a sheet attached
- [ ] Nothing on a shelf in a quantity that crosses a CERS threshold without being on the inventory
- [ ] Every container labeled with its contents — no unmarked jugs or decanted spray bottles
- [ ] Secondary containment under liquid storage

**Emergency equipment the ERCP promises**

- [ ] Tool room closet: protective suits/aprons, gloves, safety glasses present
- [ ] First aid kit stocked (inner hallway); plumbed eyewash (main bathroom) unobstructed, flushed, logged
- [ ] Fire extinguishers every 100 ft, tagged current, mounted, unobstructed; deluge system and main-office alarm station clear
- [ ] Evacuation route maps posted; assembly areas usable (north & south lots, south lot by the fire hydrant)
- [ ] Emergency contacts posted and current — including a 24-hour number for BOTH named contacts

## Dismantling & recycling operations (Red Bull refrigeration units — at Hangar 200)

> Draft policy — pending owner approval. This operation runs **at Hangar 200**, so it is inside the scope of any inspection of this facility, and it makes the facility a **used-oil generator** — the 2026-08-10 CERS Business Activities answer of "No" to hazardous waste generator must be corrected.

**Why quantity does not exempt this:** the 55-gallon threshold only decides whether used oil goes on the **HMBP chemical inventory**. Used oil is hazardous waste in California by statute (HSC 25250) at ANY quantity, even when destined for recycling — draining the first compressor made this facility a generator.

**Required, and what an inspector is shown:**

1. **CERS correction** — Business Activities → hazardous waste generator: **Yes**; add the dismantling operation to the ERCP's Incidental Operations. File within 30 days of the operation starting.
2. **EPA/state ID number** for the site (DTSC form 1358). Required to manifest shipments. The only manifest-free path is self-transporting ≤55 gal to a registered collection center — a recycler picking up does NOT qualify.
3. **Manifests for every pickup**, kept 3 years, filed in the vault. Verify the hauler is a **DTSC-registered used-oil transporter** and record their registration number. **A recycler's COD is a supporting record, not a manifest — keep both.**
4. **Refrigerant before anything is cut.** Check the nameplate on every unit. CO₂ (R744) circuits are exempt from the EPA §608 venting prohibition; **R290 / R600a / R134a circuits are not** — those must be recovered by a certified technician with recovery equipment before dismantling, with records. Never assume the fleet is uniform.
5. **Container standards on the floor:** labeled **"Used Oil"** (that exact phrase) + accumulation start date, closed except when adding, good condition, secondary containment. Oil filters drained 24 hours before disposal/scrap.
6. **Drained non-ferrous metals** in segregated bins ride the scrap-metal recycling exclusion — keep them drained and segregated; an oily bin of "scrap" is a waste pile.
7. **Threshold watch:** if used oil on site ever reaches **55 gallons aggregate**, it also joins the HMBP chemical inventory (30-day rule).
8. **Records per unit batch, filed in the vault:** count/serials of units processed, refrigerant type verified, oil volume drained, hauler manifests, recycler CODs.

## Hard rules

- **Never estimate a quantity out loud.** Pull the number.
- **Never sign anything acknowledging fault.** Signing receipt of a report is fine; signing an admission is not.
- **Never let an inspection proceed unescorted**, anywhere on the property.
- **Never move or conceal a container during an inspection.** Correcting in the open is fine; hiding is a separate and far worse problem.
- **Never dispose of anything into a floor drain, storm drain, or sanitary sewer** without a written determination on file.
- **Never let a CERS-affecting change go past 30 days.** New tank, new address, new contact, new chemical over threshold — file it.
- **Never vent a non-exempt refrigerant.** Verify the circuit; recover when required.

---

*This SOP is an internal operating standard, not legal advice. Where it conflicts with a current regulation, CUPA directive, or written instruction from the local Unified Program Agency, the agency governs — and this document gets amended.*
