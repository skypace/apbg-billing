// subdist-agreement-v1.mjs — the canonical v1.0 Sub-Distribution Agreement.
//
// Legal text belongs in version control: this is the wording that was drafted,
// and a diff on this file is the record of any change to it. The database
// carries editable templates on top (staff can publish 1.1 without a deploy),
// but if no active template exists this is what gets seeded, so a fresh
// environment can never end up with an improvised distribution agreement.
//
// ⚠ THIS IS OUR PAPER, NOT LEGAL ADVICE. It was drafted against how the
// business actually runs — consignment, Service Fusion dispatch, portal
// receiving, monthly settlement out of our own system — and counsel should
// read it before the first one goes out. The clauses that carry the most
// weight, and the reasoning behind them:
//
//   §2  Title stays with Company until Company invoices the end customer.
//       That is the whole consignment position and everything else leans on
//       it: their creditors cannot reach the stock, and product that moves
//       is a receivable of ours, not a sale of theirs.
//   §5  Receiving in the portal is not paperwork — it is the reconciliation.
//       Stock that is never received stays in transit and the ledger cannot
//       be trusted, so the obligation is stated as a condition of payment.
//   §16 Distributor MAY sell its own craft soda. What it may never do is
//       solicit a Company Customer. That is the line Sky drew, and it is
//       narrower and sharper than a blanket non-compete: the risk is not
//       that they have a brand, it is that they are standing in our account
//       with our product on their truck.
//   §31 Electronic Signature and Records. The NDA had to have this ADDED
//       after the fact; it is here from the start, because it is what makes
//       a signature collected on a screen hold up.
//
// The markup is parsed by lib/nda-doc.mjs — see that file for the grammar.
// [PARTIES], [FEE_SCHEDULE], [SERVICE_LEVELS] and [SIGNATURES] are where the
// filled-in blocks go.

export const SUBDIST_AGREEMENT_V1 = {
  code: 'subdist-agreement',
  version: '1.0',
  title: 'SUB-DISTRIBUTION AGREEMENT',
  subtitle: 'Consignment Distribution, Delivery, and Service',
  notes: 'Drafted 2026-09-04 against the live sub-distributor operating model '
    + '(consignment, Service Fusion dispatch, portal receiving, monthly settlement). '
    + 'Territory is non-exclusive; Distributor may sell its own branded craft soda but may not '
    + 'solicit a Company Customer (§16). Counsel should review before first use.',
  body_source: `## RECITALS

[PARTIES]

Company produces and sells craft soda, fountain syrup, bag-in-box concentrate, carbon dioxide, and related beverage products and services under the Alameda Soda and Brix Beverage brands. Distributor is engaged in the business of delivering and servicing beverage accounts within the Territory described below. Company wishes to place product on consignment with Distributor for delivery to Company's customers, and to engage Distributor to perform delivery and service work, on the terms set out in this Agreement.

NOW, THEREFORE, in consideration of the mutual promises below and other good and valuable consideration, the receipt and sufficiency of which are acknowledged, the Parties agree as follows:

## I. APPOINTMENT AND THE CONSIGNMENT

1. **Appointment; Non-Exclusive Territory.** Company appoints Distributor as a non-exclusive sub-distributor of Company products within the territory and for the accounts described in the Fee and Territory Schedule below (the "Territory" and the "Accounts"). The appointment is **non-exclusive in every respect**. Company may appoint other distributors in the Territory, may sell and deliver directly to any customer in the Territory including the Accounts, and may add, remove, or reassign Accounts at any time on written notice. Distributor is granted no right of first refusal, no minimum volume guarantee, and no protected territory.

2. **Consignment; Title, Risk, and Ownership.** All product delivered to Distributor is delivered **on consignment**. Title to and ownership of all product remains with Company, and does not pass to Distributor at any time. Title passes directly from Company to the end customer at the moment Company invoices that customer for the product. Until then:

(a) the product is Company's property, is held by Distributor as bailee for Company, and shall be identified in Distributor's records as consigned goods of Company;

(b) the product is not Distributor's inventory, is not an asset of Distributor, and is not subject to the claims, liens, security interests, or attachment of any creditor of Distributor;

(c) Distributor shall not pledge, encumber, sell, transfer, or grant any security interest in the product, and shall keep it free of all liens;

(d) Distributor bears the **risk of loss** for consigned product from the moment it is received into Distributor's possession until it is delivered to a Company customer or returned to Company; and

(e) Company may file such financing statements or consignment notices as it deems appropriate to perfect and give notice of its interest, and Distributor shall cooperate in doing so.

3. **Everything Sold Is Due to Company.** All product delivered by Distributor to any customer is sold **by Company, to that customer, on Company's invoice**. Distributor shall not invoice any customer for Company product, shall not collect payment for Company product except as Company expressly directs in writing, and shall not represent that it is the seller of Company product. Any amount Distributor does receive on account of Company product is received in trust for Company and shall be remitted to Company promptly and in full. Distributor's compensation is the delivery, service, and handling fees stated in the Fee and Territory Schedule — it is not, and shall never be characterized as, a margin, markup, or profit on the resale of Company product.

4. **Pricing Is Company's.** Company sets every price charged to every end customer, and may change any price at any time. Distributor shall not quote, discount, rebate, bundle, or otherwise alter the price of Company product, and shall refer all pricing questions to Company.

5. **Compensation; Fee and Territory Schedule.** Company shall pay Distributor the fees set out below for delivery, service, and handling performed and recorded in accordance with this Agreement. The Schedule may be amended only in writing signed by both Parties, or by a superseding version of this Agreement.

[FEE_SCHEDULE]

## II. RUNNING ON COMPANY'S SYSTEMS

6. **Service Fusion — Dispatch, Delivery, and Service Records.** Distributor shall dispatch, perform, record, and close **every delivery and every service call** for Company product in Company's Service Fusion system, using the credentials Company provides. Each job shall be closed with the work performed, the parts and product used, the time on site, and any customer signature or photograph Company requires. **Work that is not recorded in Service Fusion is not compensable**, because Company has no means of verifying that it occurred, and this Section states that condition plainly so it is not a surprise at settlement.

7. **Receiving Transfers in the Portal.** Company ships consigned product to Distributor under a bill of lading. Distributor shall **receive each shipment in Company's partner portal**, line by line, recording the quantity actually counted for each line, within two (2) business days of physical arrival. Distributor shall record any shortage, overage, or damage at the time of receipt. Product that is not received in the portal remains recorded as in transit, is not reconciled, and continues to be treated as Company property in Distributor's possession. Receiving in the portal is not administrative housekeeping — it is the mechanism by which consigned stock is reconciled, and a failure to do it accurately is a material breach.

8. **Depletion Reporting.** Distributor shall record in the portal every case, bag-in-box, cylinder, and unit delivered to each Account, on the day of delivery. That record is the basis on which Distributor's fees are calculated and paid, and on which Company invoices the end customer.

9. **Inventory, Counts, Shrinkage, and Loss.** Distributor shall store consigned product in a secure, clean, and suitable location, segregated and identifiable as Company property. Company may, on reasonable notice and during normal business hours, enter Distributor's premises to count, inspect, photograph, and reconcile consigned product against Company's records. Consigned product that is lost, stolen, damaged, expired, destroyed, or unaccounted for at any count shall be charged to Distributor at Company's then-current list price for that product, and may be set off against fees due under Section 12.

10. **Portal Access and Credentials.** Company will issue named user logins to the individuals Distributor designates. Credentials are personal to the individual, and shall not be shared, transferred, or used by any other person. Distributor shall notify Company immediately when any user leaves its employ or no longer requires access. Company may suspend or revoke any credential at any time, and shall revoke all of Distributor's credentials upon termination of this Agreement.

11. **Submitting Bills Through the Portal.** Distributor shall submit all invoices, expense claims, and reimbursement requests to Company **through the portal**, with the supporting documentation Company requires. Bills submitted by any other means are not in Company's payment queue and are not payable. Bills must be submitted within thirty (30) days of the work to which they relate.

12. **Monthly Settlement; Company's Records Govern; Set-Off.** Company shall settle Distributor's fees monthly, calculated from the deliveries, service calls, and depletions recorded in Company's systems for the preceding calendar month, and shall pay the settled amount within the payment term stated in the Fee and Territory Schedule. **Company's records are the record of what was delivered, received, serviced, and owed.** Distributor shall raise any dispute with a settlement in writing within fifteen (15) days of receiving it, failing which the settlement is final and binding. Company may set off against any amount due to Distributor any amount Distributor owes Company, including shrinkage under Section 9, chargebacks, damaged product, and amounts collected from customers and not remitted.

## III. SERVICE OBLIGATIONS

13. **Response Times.** Where Distributor performs service work, Distributor shall meet the response times below, measured from the moment the ticket is created in Service Fusion. **"Response" means a qualified technician on site and working** — it does not mean a returned telephone call, an acknowledged ticket, or a scheduled future visit.

[SERVICE_LEVELS]

14. **Service Performance.** Distributor shall arrive with the parts, tools, and product reasonably required, shall leave the account in working order or escalate to Company the same day where it cannot, and shall close the ticket with a complete record of the work. Company will report response-time performance to Distributor monthly. A persistent failure to meet response times is cause for termination under Section 25.

## IV. PROTECTING THE BRAND AND THE CUSTOMER

15. **Trademarks; Limited Licence.** Company grants Distributor a limited, revocable, non-exclusive, non-transferable licence to use Company's names, marks, and logos solely to perform this Agreement, in the Territory, during the term. Distributor shall not:

(a) register or attempt to register any Company mark, or any confusingly similar mark, name, domain name, social media handle, or business name, in any jurisdiction;

(b) use any Company mark on any signage, vehicle, uniform, menu, sell sheet, website, social media post, or other material without Company's prior written approval of that specific use;

(c) alter, abbreviate, combine, or restyle any Company mark or artwork; or

(d) use any Company mark in a way that suggests Distributor is Company, is an agent of Company, or has authority to bind Company.

All goodwill arising from Distributor's use of the marks inures solely to Company. On termination, Distributor shall immediately cease all use of the marks and remove them from every vehicle, premises, and publication under its control.

16. **Distributor's Own Products; No Solicitation of Company Customers.** Company acknowledges that Distributor may manufacture, distribute, and sell beverages of its own, including its own branded craft soda. **Distributor shall not, however, solicit, offer, promote, sample, quote, or sell any competing beverage product to a Company Customer.** For this purpose a "Company Customer" is any account that (a) is an Account under this Agreement, (b) is served with Company product by Distributor, (c) is identified to Distributor by Company or through Company's systems, or (d) Distributor learns of in the course of performing this Agreement. This restriction applies during the term and for **twelve (12) months** after termination or expiration. Distributor shall not use a delivery or service visit made under this Agreement as an occasion to promote its own or any third party's competing product. Distributor acknowledges that access to Company's accounts is given for the purpose of serving them on Company's behalf, and that using that access to convert them is the precise harm this Section exists to prevent.

17. **Product Integrity, Storage, and Food Safety.** Distributor shall handle Company product in accordance with all applicable food-safety law and Company's written handling instructions. Distributor shall not repack, relabel, dilute, decant, alter, or transfer product to any other container. Distributor shall rotate stock first-in-first-out, honour all date and lot codes, and shall not deliver product that is past code, damaged, swollen, leaking, or that has been stored outside the required temperature range. Distributor shall maintain clean, pest-controlled, temperature-appropriate storage and transport, and shall permit Company to inspect it.

18. **Recall and Traceability.** Distributor shall cooperate fully and immediately with any recall, withdrawal, or trace exercise initiated by Company or any authority. On request, Distributor shall provide within twenty-four (24) hours a complete record of where product bearing a given lot code was delivered, shall place and hold affected stock, and shall assist in its retrieval. Distributor shall notify Company immediately of any customer complaint, illness report, contamination concern, or regulatory contact relating to Company product, and shall not respond substantively to any such matter without Company's direction.

## V. CONFIDENTIALITY

19. **Confidential Information.** "Confidential Information" means all non-public information of Company disclosed to or accessed by Distributor, in any form, whether or not marked confidential, including: formulations, recipes, batching sheets, specifications, and ingredient decks; costs, pricing, margins, and terms; customer and account lists, contacts, volumes, and buying patterns; Company's systems, portal contents, data, and reports; supplier, vendor, and co-packer identities and arrangements; and all business, marketing, and forecasting information. Confidential Information does not include information Distributor can show by contemporaneous written record was already lawfully in its possession without restriction, is or becomes public through no act of Distributor, was lawfully received from a third party free to disclose it, or was independently developed without use of or access to Confidential Information.

20. **Obligations.** Distributor shall hold Confidential Information in strict confidence, use it solely to perform this Agreement, disclose it only to those of its personnel who need it for that purpose and who are bound by obligations at least as protective as these, and protect it with at least reasonable care. Distributor shall notify Company promptly of any unauthorized use, disclosure, or compromise, and shall cooperate in mitigating it. These obligations survive termination indefinitely as to trade secrets, and for **five (5) years** as to all other Confidential Information.

21. **Non-Circumvention.** During the term and for two (2) years afterwards, Distributor shall not use Confidential Information to solicit, contact, or transact business with any supplier, co-packer, formulator, vendor, or customer of Company identified to Distributor through Confidential Information, for the purpose of circumventing Company or competing with Company. This Section does not restrict a documented relationship that existed independently before the Effective Date.

22. **Return of Information.** On termination, and at any time on request, Distributor shall return or destroy all Confidential Information in its possession, including all copies, extracts, and derivative materials, and shall certify in writing that it has done so. Distributor may retain one copy solely as required by law or its ordinary backup routine, which remains subject to Sections 19 through 22.

## VI. GENERAL

23. **Insurance.** Distributor shall maintain, at its own expense and with insurers reasonably acceptable to Company, commercial general liability, automobile liability covering all vehicles used to deliver Company product, workers' compensation as required by law, and such other coverage as Company reasonably requires, in the minimum limits Company specifies in writing. Distributor shall name Company as an **additional insured** on the general liability and automobile policies, shall provide a certificate of insurance evidencing that status before the first delivery and on each renewal, and shall give Company thirty (30) days' notice of cancellation or material change. Distributor acknowledges that a certificate is evidence of coverage and is not itself the additional-insured endorsement, and shall provide the endorsement on request.

24. **Independent Contractor.** Distributor is an independent contractor. Nothing in this Agreement creates a partnership, joint venture, franchise, employment, or agency relationship. Distributor has no authority to bind Company, to make any representation or warranty on Company's behalf, or to incur any obligation in Company's name. Distributor is solely responsible for its own personnel, vehicles, licences, permits, and taxes.

25. **Term; Renewal; Termination.** This Agreement begins on the Effective Date and continues for **one (1) year**, and renews automatically for successive one-year terms unless terminated. Either Party may terminate this Agreement, with or without cause, on **thirty (30) days' written notice**. Company may terminate immediately on written notice for cause, including: a breach of Sections 2, 3, 7, 16, or 19 through 22; failure to remit amounts collected; repeated failure to meet response times; loss of insurance; loss of any licence required to perform; a food-safety or product-integrity failure; insolvency, assignment for the benefit of creditors, or the appointment of a receiver; or any act that in Company's reasonable judgment damages the Alameda Soda or Brix Beverage brands.

26. **Effect of Termination.** On termination or expiration:

(a) Distributor shall immediately cease taking orders, holding itself out as a distributor of Company product, and using Company's marks;

(b) all consigned product in Distributor's possession shall be counted jointly and returned to Company, or purchased by Distributor at Company's list price, at Company's election, within fifteen (15) days;

(c) Company shall settle all fees properly earned and recorded through the termination date, net of any set-off under Section 12;

(d) all portal and Service Fusion credentials are revoked, and Distributor shall return or destroy Confidential Information under Section 22; and

(e) Sections 3, 9, 12, 16, 19 through 22, 24, 26, 27, and 30 through 34 survive.

27. **Indemnification.** Distributor shall indemnify, defend, and hold harmless Company, its officers, employees, and affiliates from and against any claim, loss, liability, damage, fine, and expense (including reasonable attorneys' fees) arising out of Distributor's performance or non-performance of this Agreement, its negligence or wilful misconduct, its handling, storage, or transport of Company product, its vehicles and personnel, its own products, or its breach of this Agreement.

28. **Limitation of Liability.** Neither Party is liable to the other for indirect, incidental, consequential, special, or punitive damages, or for lost profits, arising out of this Agreement. Nothing in this Section limits Distributor's obligations under Sections 3, 9, 16, 19 through 22, 23, or 27, or either Party's liability for fraud, wilful misconduct, or personal injury.

29. **Compliance with Law.** Each Party shall comply with all laws applicable to its performance, including food-safety, labelling, transportation, vehicle, driver-licensing, employment, and tax law. Distributor shall maintain every licence, permit, and registration required to store, transport, and deliver Company product, and shall provide evidence on request.

30. **Notices.** Notices shall be in writing and given by email to the addresses stated in the Fee and Territory Schedule, with a copy by recognized courier or certified mail to the addresses in the Parties block. Notice by email is effective on transmission absent a bounce; notice by courier or mail is effective on delivery.

31. **Electronic Signature and Records.** The Parties consent to conduct this transaction by electronic means. Each Party agrees that typing its signatory's name and applying a signature on screen constitutes that Party's signature, and has the same legal effect as a handwritten signature under the federal ESIGN Act and applicable state law including the Uniform Electronic Transactions Act. Each Party consents to receive this Agreement and all related records electronically, and acknowledges that it is able to retain a copy: an executed copy in PDF form is delivered to each Party by email on signature and remains available on request. A Party may withdraw consent to electronic records prospectively by written notice, which does not affect the validity of this Agreement. The record of signature — including the typed name, the applied signature, the date and time, and the signer's network address and browser — is retained by Company as evidence of execution and is appended to the executed document.

32. **Assignment.** Distributor shall not assign this Agreement, or any right or obligation under it, by operation of law or otherwise, without Company's prior written consent. Any purported assignment without consent is void. Company may assign this Agreement to an affiliate or in connection with a sale of its business.

33. **Force Majeure.** Neither Party is liable for a failure to perform caused by an event beyond its reasonable control, provided it notifies the other promptly and resumes performance as soon as practicable. This Section does not excuse a payment obligation or an obligation to return or account for consigned product.

34. **Governing Law; Venue; Entire Agreement.** This Agreement is governed by the laws of the State of California, without regard to conflict-of-laws rules, and the Parties submit to the exclusive jurisdiction of the state and federal courts located in Alameda County, California. This Agreement, together with its Schedule, is the entire agreement between the Parties on this subject and supersedes all prior discussions and agreements. It may be amended only in writing signed by both Parties. If any provision is held unenforceable, the remainder continues in full force and the unenforceable provision is modified to the least extent necessary to make it enforceable. This Agreement may be executed in counterparts, including electronically, each of which is an original.

[SIGNATURES]`,
};

export default SUBDIST_AGREEMENT_V1;
