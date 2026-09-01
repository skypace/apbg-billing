// mnda-v1.mjs — the MUTUAL variant, v1.0.
//
// Same structure and the same protections as the one-way agreement, made
// reciprocal: each Party is both Discloser and Recipient, and every obligation
// runs both ways.
//
// ⚠ This is an ADAPTATION of the approved one-way text, not separately drafted
// counsel-reviewed paper. Where the one-way agreement protects only our
// formulations, this one binds us on the same terms to whatever the other side
// shows us — which is the point of a mutual NDA, but it is a real obligation we
// are taking on. Have counsel read it before it goes to a counterparty who
// matters.
//
// What changed from the one-way text, and why each one had to change rather
// than being a find-and-replace:
//   · §1 Purpose — evaluating a potential relationship in BOTH directions, not
//     services performed for us.
//   · §2 Confidential Information — belongs to whichever Party disclosed it, so
//     the definition is keyed to the Discloser, not to Company.
//   · §6 No reverse engineering, §7 no competing use, §8 ownership — each Party
//     owes these to the other over the other's material.
//   · §7 is deliberately NARROWER than the one-way version. Its blanket "shall
//     not develop any similar product" cannot be reciprocal between two
//     beverage companies without stopping both of us trading; it is scoped to
//     use OF the other side's Confidential Information.
//   · §8 Work Product assignment is REMOVED. In a one-way co-packing agreement
//     the co-packer assigning us its work is correct. Mutual, it would mean
//     assigning our work to them, which nobody intends. Each Party keeps its
//     own; anything joint is left to a definitive agreement.
//   · §9 Non-circumvention and §12 regulatory records are reciprocal.
//   · §16 no-warranty runs from each Discloser.
//   · §21 Electronic Signature is kept in full — it is what makes signing on
//     screen hold up, and it is drafted mutually already.

export const MNDA_V1 = {
  code: 'mutual-nda',
  version: '1.0',
  mutual: true,
  title: 'MUTUAL CONFIDENTIALITY AND NON-DISCLOSURE AGREEMENT',
  subtitle: 'Beverage Formulation, Co-Packing, and Laboratory Services',
  notes: 'Mutual adaptation of the approved one-way co-packing NDA. Obligations run both ways. '
    + 'Section 7 is scoped to use of the other Party’s Confidential Information (a blanket '
    + 'no-similar-products covenant cannot be reciprocal between two beverage companies), and the '
    + 'one-way Work Product assignment is removed — each Party keeps its own. Section 21 '
    + '(Electronic Signature and Records) is retained.',
  body_source: `## RECITALS

[PARTIES]

Each Party develops, owns, or controls proprietary beverage formulations, syrup concentrates, flavor systems, processes, analytical methods, and related business information. The Parties wish to explore, evaluate, and potentially enter into a business relationship with one another, which may include co-packing, contract manufacturing, blending, filling, laboratory testing, analytical, product development, or supply arrangements (the "Relationship"). In the course of doing so, each Party may disclose to the other information that it regards as confidential and as a trade secret. The Parties enter into this Agreement to protect that information in both directions.

NOW, THEREFORE, in consideration of the mutual promises below and other good and valuable consideration, the receipt and sufficiency of which are acknowledged, the Parties agree as follows:

1. **Purpose.** Each Party may receive Confidential Information (defined below) from the other solely for the purpose of evaluating, quoting, developing, testing, analyzing, manufacturing, packaging, and/or supplying beverage products in connection with the Relationship (the "Purpose"). Neither Party shall use the other's Confidential Information for any other purpose whatsoever. In this Agreement, the Party disclosing information is the "Discloser" and the Party receiving it is the "Recipient"; each Party acts in both capacities.

2. **Confidential Information.** "Confidential Information" means any and all non-public information disclosed by or on behalf of a Discloser to a Recipient, whether before or after the Effective Date, in any form — written, oral, visual, electronic, or in the form of samples or physical materials — and whether or not marked "confidential." Confidential Information expressly includes, without limitation:

(a) formulas, recipes, formulations, ingredient decks, ingredient statements, Brix and acid targets, ratios, dilution rates, yield calculations, and flavor profiles;

(b) ingredient specifications, raw material identities and grades, supplier and vendor identities, pricing, and sourcing arrangements;

(c) processing parameters, batching sequences, blending, pasteurization, carbonation, filling, and packaging methods and settings;

(d) samples, prototypes, concentrates, bases, compounds, finished goods, and any other physical material furnished by the Discloser (collectively, "Samples");

(e) analytical data, test results, laboratory reports, shelf-life and stability data, sensory panel results, and micro and chemistry results relating to the Discloser's products;

(f) nutritional and label data, artwork, packaging specifications, and regulatory filings and correspondence;

(g) business information including customers, distributors, forecasts, volumes, costs, margins, pricing, and business plans; and

(h) all notes, analyses, compilations, summaries, reports, and derivative materials prepared by the Recipient that contain, reflect, or are derived from any of the foregoing.

3. **Exclusions.** Confidential Information does not include information that the Recipient can demonstrate by contemporaneous written records: (a) was lawfully in the Recipient's possession, without restriction, before disclosure by the Discloser; (b) is or becomes generally available to the public through no act or omission of the Recipient or its Representatives; (c) is lawfully received by the Recipient from a third party having the right to disclose it without restriction; or (d) is independently developed by the Recipient's personnel who have had no access to and have made no use of the Discloser's Confidential Information. A combination of features shall not be deemed excluded merely because individual features are within an exclusion; and information shall not be deemed excluded merely because it falls within the scope of more general information that is excluded.

4. **Obligations.** Each Recipient shall: (a) hold the Discloser's Confidential Information in strict confidence and protect it using at least the degree of care it uses for its own most sensitive information, and in no event less than a reasonable degree of care; (b) not disclose Confidential Information to any third party except as expressly permitted in Section 5; (c) use Confidential Information solely for the Purpose; (d) restrict access to those of its employees, officers, and contractors who have a strict need to know for the Purpose (collectively, "Representatives"); (e) store Confidential Information securely, including access-controlled electronic storage and locked physical storage for Samples and formula documents; and (f) promptly notify the Discloser in writing upon discovering any unauthorized use, disclosure, loss, or compromise of its Confidential Information, and cooperate fully with the Discloser in mitigating it.

5. **Representatives and Subcontractors.** A Recipient may disclose Confidential Information only to Representatives who have been informed of its confidential nature and who are bound by written obligations of confidentiality and non-use at least as protective as this Agreement. A Recipient shall not disclose the Discloser's Confidential Information to, or engage with respect to it, any subcontractor, outside laboratory, broker, flavor house, or other third party without the Discloser's prior written consent. Each Recipient is fully responsible and liable for any act or omission of its Representatives or permitted subcontractors that would breach this Agreement if committed by the Recipient.

6. **No Reverse Engineering or Analysis.** Except strictly as necessary to perform the Purpose and only as expressly authorized in writing by the Discloser, a Recipient shall not, and shall not permit any third party to, analyze, assay, chromatograph, spectrographically examine, deformulate, decompile, reverse engineer, or otherwise attempt to determine the composition, structure, ingredient identity, or method of manufacture of any Sample or product of the Discloser. Any results, data, or know-how obtained from any such analysis, whether authorized or not, shall constitute Confidential Information owned exclusively by the Discloser.

7. **No Competing Use.** Each Party acknowledges that the other's formulations constitute trade secrets of substantial economic value. A Recipient shall not, directly or indirectly, use the Discloser's Confidential Information to develop, formulate, manufacture, produce, sell, or offer any product for itself, for any private-label program, or for any third party. A Recipient shall not manufacture or supply to any third party any product that is derived from or based upon the Discloser's Confidential Information. A Recipient shall not file any patent application or seek any other intellectual property protection covering, incorporating, or disclosing the Discloser's Confidential Information. For the avoidance of doubt, nothing in this Section restricts either Party from independently developing, making, or selling products developed without use of the other Party's Confidential Information.

8. **Ownership; No License.** All Confidential Information, and all intellectual property rights therein, remain the exclusive property of the Discloser. No license, right, title, or interest, express or implied, is granted to a Recipient by this Agreement or by any disclosure hereunder, other than the limited right to use the Discloser's Confidential Information for the Purpose. Each Party retains ownership of all data, reports, improvements, modifications, and derivative works it creates, except that any such material that contains, reflects, or is derived from the other Party's Confidential Information remains subject to this Agreement and may be used only for the Purpose. Ownership of anything the Parties create jointly, and of any work performed for hire, shall be addressed in a separate definitive agreement and is not granted or assigned by this Agreement.

9. **Non-Circumvention.** During the term of this Agreement and for two (2) years following its termination or expiration, neither Party shall use the other's Confidential Information to solicit, contact, or transact business with any supplier, vendor, customer, distributor, or account of the other that was identified to it through Confidential Information, for the purpose of circumventing the other Party or competing with it. This Section does not restrict either Party from continuing pre-existing relationships that it can document existed independently of this Agreement.

10. **No Residuals.** The Parties expressly agree that this Agreement contains no "residuals" clause. Neither Party shall use or disclose the other's Confidential Information retained in the unaided memory of its Representatives, and no such use or disclosure is or shall be permitted under any theory. Any residuals provision in any other document, purchase order, quotation, or terms and conditions of either Party shall have no force or effect with respect to Confidential Information.

11. **Compelled Disclosure.** If a Recipient is required by law, regulation, subpoena, or order of a court or governmental authority to disclose any Confidential Information, it shall, to the extent legally permitted, give the Discloser prompt written notice before disclosure so that the Discloser may seek a protective order or other remedy, shall reasonably cooperate with the Discloser at the Discloser's expense in doing so, and shall disclose only that portion of Confidential Information that is legally required. Confidential Information so disclosed retains its confidential status for all other purposes.

12. **Regulatory Records.** Nothing in this Agreement prevents either Party from maintaining batch, production, and quality records to the extent required by applicable food safety law or regulation, including the U.S. Food and Drug Administration, U.S. Department of Agriculture, and applicable state authorities. Each Party shall maintain such records confidentially and in accordance with this Agreement, shall retain them only for the minimum period required by law, and shall not use them for any purpose other than legal compliance.

13. **Return or Destruction.** Upon a Discloser's written request at any time, or upon expiration or termination of the Parties' business relationship, the Recipient shall promptly, and in any event within ten (10) business days: (a) return to the Discloser or destroy, at the Discloser's election, all of its Confidential Information and all copies, notes, and derivative materials; (b) destroy or return all Samples and all remaining raw materials, concentrates, and bases supplied by the Discloser, and shall not sell, transfer, donate, or otherwise dispose of any of them; (c) permanently delete the Discloser's Confidential Information from its systems, subject only to routine, non-targeted backup archives and records retained under Section 12; and (d) certify compliance with this Section in writing signed by an officer. Any Confidential Information retained in backup archives or under Section 12 remains subject to this Agreement for so long as it is retained.

14. **Term and Survival.** This Agreement commences on the Effective Date and continues until terminated by either Party upon thirty (30) days' written notice. Each Party's obligations with respect to Confidential Information disclosed before termination shall survive for five (5) years following termination; provided, however, that with respect to any Confidential Information that constitutes a trade secret under the California Uniform Trade Secrets Act or other applicable law — including without limitation all formulas, recipes, formulation parameters, and processing methods — those obligations shall continue in perpetuity for so long as such information remains a trade secret. Termination of this Agreement does not relieve either Party of obligations accrued before termination.

15. **No Publicity.** Neither Party shall use the other's name, brands, trademarks, logos, or the existence or terms of this Agreement or of the Parties' discussions in any advertising, marketing, customer list, case study, press release, website, or social media, without the other's prior written consent in each instance.

16. **No Obligation; No Warranty; No Partnership.** Nothing in this Agreement obligates either Party to proceed with any transaction, to disclose any particular information, or to purchase or supply any product or service. Confidential Information is provided "AS IS" and each Discloser makes no representation or warranty as to its accuracy or completeness, except as may be set forth in a separate definitive agreement. This Agreement does not create any partnership, joint venture, agency, or employment relationship, and neither Party may bind the other.

17. **Equitable Relief.** Each Party acknowledges that any breach or threatened breach of this Agreement would cause the other irreparable harm for which monetary damages would be an inadequate remedy. Accordingly, the non-breaching Party is entitled to seek injunctive relief and specific performance in addition to all other remedies available at law or in equity, without the necessity of posting a bond or proving actual damages.

18. **Governing Law; Venue; Attorneys' Fees.** This Agreement is governed by the laws of the State of California, without regard to its conflict of laws principles. The Parties consent to the exclusive jurisdiction and venue of the state and federal courts located in Alameda County, California. In any action to enforce or interpret this Agreement, the prevailing Party is entitled to recover its reasonable attorneys' fees and costs.

19. **Assignment.** Neither Party may assign or transfer this Agreement or any rights or obligations hereunder, by operation of law, change of control, merger, sale of assets, or otherwise, without the other's prior written consent. Any attempted assignment in violation of this Section is void. This Agreement binds and benefits the Parties and their permitted successors and assigns.

20. **Miscellaneous.** This Agreement constitutes the entire agreement between the Parties concerning the subject matter and supersedes all prior or contemporaneous understandings, whether written or oral. It may be amended only by a writing signed by both Parties. No preprinted terms on any purchase order, quotation, invoice, sample request, or other form of either Party shall modify this Agreement, and any such terms are hereby rejected. No waiver of any provision is effective unless in writing, and no waiver constitutes a waiver of any other provision or of any subsequent breach. If any provision is held unenforceable, it shall be modified to the minimum extent necessary to make it enforceable, and the remaining provisions shall remain in full force. This Agreement may be executed in counterparts and by electronic signature, each of which is deemed an original.

21. **Electronic Signature and Records.** The Parties consent to conduct this transaction by electronic means and agree that this Agreement may be signed electronically. Each Party agrees that its typed name, together with the signature it draws or enters on the signing page, constitutes its signature and carries the same legal effect as a handwritten signature under the federal ESIGN Act and the California Uniform Electronic Transactions Act. A complete PDF copy of the fully executed Agreement will be delivered to the email address each Party provides, and each Party may download and retain that copy at the time of signing. Either Party may request a paper copy at any time by writing to the other at the address above.

IN WITNESS WHEREOF, the Parties have executed this Agreement as of the Effective Date.

[SIGNATURES]

[EXHIBIT_A]
`,
};
