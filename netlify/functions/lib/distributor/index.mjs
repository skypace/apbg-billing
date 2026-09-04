// The distribution agreements we ship, in version control.
//
// The database carries editable templates on top of these (staff can publish
// 1.1 without a deploy), but a fresh environment must never be able to send an
// empty or improvised distribution agreement — so whatever is asked for here
// gets seeded from the drafted wording the first time somebody reaches for it.
// Same rule, and the same reason, as lib/nda/index.mjs.

import { SUBDIST_AGREEMENT_V1 } from './subdist-agreement-v1.mjs';

export { SUBDIST_AGREEMENT_V1 };

/** Every shipped agreement, keyed by code. */
export const SHIPPED = { [SUBDIST_AGREEMENT_V1.code]: SUBDIST_AGREEMENT_V1 };

export const DEFAULT_CODE = SUBDIST_AGREEMENT_V1.code;
