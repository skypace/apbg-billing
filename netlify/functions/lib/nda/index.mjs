// The agreements we ship, in version control.
//
// The database carries editable templates on top of these (staff can publish
// 1.1 without a deploy), but a fresh environment must never be able to send an
// empty or improvised NDA — so whatever is asked for here gets seeded from the
// approved wording the first time somebody reaches for it.

import { NDA_V1 } from './nda-v1.mjs';
import { MNDA_V1 } from './mnda-v1.mjs';

export { NDA_V1, MNDA_V1 };

/** Every shipped agreement, keyed by code. */
export const SHIPPED = { [NDA_V1.code]: NDA_V1, [MNDA_V1.code]: MNDA_V1 };

/** What a sender picks between. `mutual` decides how the document reads. */
export const FLAVOURS = [
  { code: NDA_V1.code,  label: 'One-way — they receive our information',
    hint: 'Co-packers, labs, vendors we hand formulations to.', mutual: false },
  { code: MNDA_V1.code, label: 'Mutual — both sides share',
    hint: 'Both of us disclose. It binds us on the same terms.', mutual: true },
];

export const DEFAULT_CODE = NDA_V1.code;
