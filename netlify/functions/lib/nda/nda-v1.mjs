// nda-v1.mjs — the canonical v1.0 agreement text, shipped with the code.
//
// Legal text belongs in version control: this is the wording that was approved,
// and a diff on this file is the record of any change to it. The database
// carries editable templates on top (staff can publish 1.1 without a deploy),
// but if no active template exists this is what gets seeded, so a fresh
// environment can never end up with an empty or improvised NDA.
//
// The markup is parsed by lib/nda-doc.mjs — see that file for the grammar.
// [PARTIES], [SIGNATURES] and [EXHIBIT_A] are where the filled-in blocks go.

export const NDA_V1 = {
  code: 'copack-nda',
  version: '1.0',
  title: 'CONFIDENTIALITY AND NON-DISCLOSURE AGREEMENT',
  subtitle: 'Beverage Formulation, Co-Packing, and Laboratory Services',
  notes: 'Seeded from the approved Brix / Alameda Point Beverage Group co-packing NDA. '
    + 'Section 21 (Electronic Signature and Records) was added to the supplied text so that '
    + 'signing on screen satisfies ESIGN / UETA consent and the retainable-copy requirement.',
  body_source: `## RECITALS

[PARTIES]

Company develops, owns, and commercializes proprietary beverage formulations, syrup concentrates, flavor systems, and related processes. Recipient provides co-packing, contract manufacturing, blending, filling, laboratory testing, analytical, and/or product development services. In order to evaluate and potentially perform such services for Company, Recipient will require access to Company's confidential and trade secret information. The Parties enter into this Agreement to protect that information.

NOW, THEREFORE, in consideration of the mutual promises below and other good and valuable consideration, the receipt and sufficiency of which are acknowledged, the Parties agree as follows:

1. **Purpose.** Recipient may receive Confidential Information (defined below) solely for the purpose of evaluating, quoting, developing, testing, analyzing, manufacturing, packaging, and/or supplying beverage products for and on behalf of Company (the "Purpose"). Recipient shall not use Confidential Information for any other purpose whatsoever.

2. **Confidential Information.** "Confidential Information" means any and all non-public information disclosed by or on behalf of Company to Recipient, whether before or after the Effective Date, in any form — written, oral, visual, electronic, or in the form of samples or physical materials — and whether or not marked "confidential." Confidential Information expressly includes, without limitation:

(a) formulas, recipes, formulations, ingredient decks, ingredient statements, Brix and acid targets, ratios, dilution rates, yield calculations, and flavor profiles;

(b) ingredient specifications, raw material identities and grades, supplier and vendor identities, pricing, and sourcing arrangements;

(c) processing parameters, batching sequences, blending, pasteurization, carbonation, filling, and packaging methods and settings;

(d) samples, prototypes, concentrates, bases, compounds, finished goods, and any other physical material furnished by Company (collectively, "Samples");

(e) analytical data, test results, laboratory reports, shelf-life and stability data, sensory panel results, and micro and chemistry results relating to Company products;

(f) nutritional and label data, artwork, packaging specifications, and regulatory filings and correspondence;

(g) business information including customers, distributors, forecasts, volumes, costs, margins, pricing, and business plans; and

(h) all notes, analyses, compilations, summaries, reports, and derivative materials prepared by Recipient that contain, reflect, or are derived from any of the foregoing.

3. **Exclusions.** Confidential Information does not include information that Recipient can demonstrate by contemporaneous written records: (a) was lawfully in Recipient's possession, without restriction, before disclosure by Company; (b) is or becomes generally available to the public through no act or omission of Recipient or its Representatives; (c) is lawfully received by Recipient from a third party having the right to disclose it without restriction; or (d) is independently developed by Recipient's personnel who have had no access to and have made no use of Confidential Information. A combination of features shall not be deemed excluded merely because individual features are within an exclusion; and information shall not be deemed excluded merely because it falls within the scope of more general information that is excluded.

4. **Obligations.** Recipient shall: (a) hold all Confidential Information in strict confidence and protect it using at least the degree of care it uses for its own most sensitive information, and in no event less than a reasonable degree of care; (b) not disclose Confidential Information to any third party except as expressly permitted in Section 5; (c) use Confidential Information solely for the Purpose; (d) restrict access to those of its employees, officers, and contractors who have a strict need to know for the Purpose (collectively, "Representatives"); (e) store Confidential Information securely, including access-controlled electronic storage and locked physical storage for Samples and formula documents; and (f) promptly notify Company in writing upon discovering any unauthorized use, disclosure, loss, or compromise of Confidential Information, and cooperate fully with Company in mitigating it.

5. **Representatives and Subcontractors.** Recipient may disclose Confidential Information only to Representatives who have been informed of its confidential nature and who are bound by written obligations of confidentiality and non-use at least as protective as this Agreement. Recipient shall not disclose Confidential Information to, or engage, any subcontractor, outside laboratory, broker, flavor house, or other third party without Company's prior written consent. Recipient is fully responsible and liable for any act or omission of its Representatives or permitted subcontractors that would breach this Agreement if committed by Recipient.

6. **No Reverse Engineering or Analysis.** Except strictly as necessary to perform the Purpose and only as expressly authorized in writing by Company, Recipient shall not, and shall not permit any third party to, analyze, assay, chromatograph, spectrographically examine, deformulate, decompile, reverse engineer, or otherwise attempt to determine the composition, structure, ingredient identity, or method of manufacture of any Sample or product of Company. Any results, data, or know-how obtained from any such analysis, whether authorized or not, shall constitute Confidential Information owned exclusively by Company.

7. **No Competing Use; No Independent Development.** Recipient acknowledges that Company's formulations constitute trade secrets of substantial economic value. Recipient shall not, directly or indirectly, use any Confidential Information to develop, formulate, manufacture, produce, sell, or offer any product for itself, for any private-label program, or for any third party. Recipient shall not manufacture or supply to any third party any product that is derived from, based upon, or substantially similar to a Company formulation. Recipient shall not file any patent application or seek any other intellectual property protection covering, incorporating, or disclosing any Confidential Information.

8. **Ownership; No License; Work Product.** All Confidential Information, and all intellectual property rights therein, remain the exclusive property of Company. No license, right, title, or interest, express or implied, is granted to Recipient by this Agreement or by any disclosure hereunder, other than the limited right to use Confidential Information for the Purpose. All test results, analytical data, reports, formulation improvements, modifications, adaptations, and derivative works created by Recipient in the course of performing the Purpose, to the extent they relate to or are derived from Confidential Information (collectively, "Work Product"), shall be the sole and exclusive property of Company. Recipient hereby assigns to Company all right, title, and interest in and to such Work Product, and shall execute any documents reasonably requested to perfect that assignment.

9. **Non-Circumvention.** During the term of this Agreement and for two (2) years following its termination or expiration, Recipient shall not use Confidential Information to solicit, contact, or transact business with any supplier, vendor, customer, distributor, or account of Company that was identified to Recipient through Confidential Information, for the purpose of circumventing Company or competing with Company. This Section does not restrict Recipient from continuing pre-existing relationships that Recipient can document existed independently of this Agreement.

10. **No Residuals.** The Parties expressly agree that this Agreement contains no "residuals" clause. Recipient shall not use or disclose Confidential Information retained in the unaided memory of its Representatives, and no such use or disclosure is or shall be permitted under any theory. Any residuals provision in any other document, purchase order, quotation, or terms and conditions of Recipient shall have no force or effect with respect to Confidential Information.

11. **Compelled Disclosure.** If Recipient is required by law, regulation, subpoena, or order of a court or governmental authority to disclose any Confidential Information, Recipient shall, to the extent legally permitted, give Company prompt written notice before disclosure so that Company may seek a protective order or other remedy, shall reasonably cooperate with Company at Company's expense in doing so, and shall disclose only that portion of Confidential Information that is legally required. Confidential Information so disclosed retains its confidential status for all other purposes.

12. **Regulatory Records.** Nothing in this Agreement prevents Recipient from maintaining batch, production, and quality records to the extent required by applicable food safety law or regulation, including the U.S. Food and Drug Administration, U.S. Department of Agriculture, and applicable state authorities. Recipient shall maintain such records confidentially and in accordance with this Agreement, shall retain them only for the minimum period required by law, and shall not use them for any purpose other than legal compliance.

13. **Return or Destruction.** Upon Company's written request at any time, or upon expiration or termination of the Parties' business relationship, Recipient shall promptly, and in any event within ten (10) business days: (a) return to Company or destroy, at Company's election, all Confidential Information and all copies, notes, and derivative materials; (b) destroy or return all Samples and all remaining Company-supplied raw materials, concentrates, and bases, and shall not sell, transfer, donate, or otherwise dispose of any of them; (c) permanently delete Confidential Information from its systems, subject only to routine, non-targeted backup archives and records retained under Section 12; and (d) certify compliance with this Section in writing signed by an officer of Recipient. Any Confidential Information retained in backup archives or under Section 12 remains subject to this Agreement for so long as it is retained.

14. **Term and Survival.** This Agreement commences on the Effective Date and continues until terminated by either Party upon thirty (30) days' written notice. Recipient's obligations with respect to Confidential Information disclosed before termination shall survive for five (5) years following termination; provided, however, that with respect to any Confidential Information that constitutes a trade secret under the California Uniform Trade Secrets Act or other applicable law — including without limitation all formulas, recipes, formulation parameters, and processing methods — Recipient's obligations shall continue in perpetuity for so long as such information remains a trade secret. Termination of this Agreement does not relieve either Party of obligations accrued before termination.

15. **No Publicity.** Recipient shall not use Company's name, brands, trademarks, logos, or the existence or terms of this Agreement or of the Parties' discussions in any advertising, marketing, customer list, case study, press release, website, or social media, without Company's prior written consent in each instance.

16. **No Obligation; No Warranty; No Partnership.** Nothing in this Agreement obligates either Party to proceed with any transaction, to disclose any particular information, or to purchase or supply any product or service. Confidential Information is provided "AS IS" and Company makes no representation or warranty as to its accuracy or completeness, except as may be set forth in a separate definitive agreement. This Agreement does not create any partnership, joint venture, agency, or employment relationship, and neither Party may bind the other.

17. **Equitable Relief.** Recipient acknowledges that any breach or threatened breach of this Agreement would cause Company irreparable harm for which monetary damages would be an inadequate remedy. Accordingly, Company is entitled to seek injunctive relief and specific performance in addition to all other remedies available at law or in equity, without the necessity of posting a bond or proving actual damages.

18. **Governing Law; Venue; Attorneys' Fees.** This Agreement is governed by the laws of the State of California, without regard to its conflict of laws principles. The Parties consent to the exclusive jurisdiction and venue of the state and federal courts located in Alameda County, California. In any action to enforce or interpret this Agreement, the prevailing Party is entitled to recover its reasonable attorneys' fees and costs.

19. **Assignment.** Recipient may not assign or transfer this Agreement or any rights or obligations hereunder, by operation of law, change of control, merger, sale of assets, or otherwise, without Company's prior written consent. Any attempted assignment in violation of this Section is void. This Agreement binds and benefits the Parties and their permitted successors and assigns.

20. **Miscellaneous.** This Agreement constitutes the entire agreement between the Parties concerning the subject matter and supersedes all prior or contemporaneous understandings, whether written or oral. It may be amended only by a writing signed by both Parties. No preprinted terms on any purchase order, quotation, invoice, sample request, or other form of Recipient shall modify this Agreement, and any such terms are hereby rejected. No waiver of any provision is effective unless in writing, and no waiver constitutes a waiver of any other provision or of any subsequent breach. If any provision is held unenforceable, it shall be modified to the minimum extent necessary to make it enforceable, and the remaining provisions shall remain in full force. This Agreement may be executed in counterparts and by electronic signature, each of which is deemed an original.

21. **Electronic Signature and Records.** The Parties consent to conduct this transaction by electronic means and agree that this Agreement may be signed electronically. Recipient agrees that its typed name, together with the signature it draws or enters on Company's signing page, constitutes its signature and carries the same legal effect as a handwritten signature under the federal ESIGN Act and the California Uniform Electronic Transactions Act. Company will deliver a complete PDF copy of the fully executed Agreement to the email address Recipient provides, and Recipient may download and retain that copy at the time of signing. Recipient may request a paper copy at any time by writing to Company at the address above.

IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date.

[SIGNATURES]

[EXHIBIT_A]
`,
};
