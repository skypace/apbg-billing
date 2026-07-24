// qbo-vendor-match.mjs — robust SF "purchased_from" → QBO Vendor matching.
//
// The old per-word LIKE matcher missed real vendors over trivia (verified live
// 2026-07-24): 'MULLHOLLAND CONSTRUCTION' (typo) vs MULHOLLAND CONSTRUCTION,
// 'Done Right Mechanical LLC' (trailing LLC) vs Done Right Mechanical,
// 'PRO MECHANICAL SERVICES' (plural) vs PRO MECHANICAL SERVICE. This matcher
// loads the (active) vendor list once per invocation and matches in memory:
// normalize (uppercase, strip punctuation, drop entity suffixes) → exact →
// token-set → typo distance → containment. Ambiguity (two distinct vendors at
// the same top score) returns null — a "needs attention" email beats a bill
// posted to the WRONG vendor.

import { qboQuery } from '../qbo-helpers.mjs';

// Entity/legal suffixes + service-word plural trap. Only stripped when at least
// one token remains, so a vendor literally named "LLC Services" can't vanish.
const SUFFIX_TOKENS = new Set([
  'LLC', 'INC', 'CO', 'CORP', 'CORPORATION', 'COMPANY', 'LTD', 'LP', 'LLP',
  'PC', 'PLLC', 'SERVICE', 'SERVICES',
]);

export function normalizeVendorName(name) {
  const tokens = String(name || '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const kept = tokens.filter((t) => !SUFFIX_TOKENS.has(t));
  return (kept.length > 0 ? kept : tokens).join(' ');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function tokenSet(s) { return new Set(s.split(' ').filter(Boolean)); }
function isSubset(a, b) { for (const t of a) if (!b.has(t)) return false; return a.size > 0; }

function scoreMatch(normTarget, normCandidate) {
  if (!normTarget || !normCandidate) return 0;
  if (normTarget === normCandidate) return 100;
  const ta = tokenSet(normTarget); const tb = tokenSet(normCandidate);
  if (ta.size === tb.size && isSubset(ta, tb)) return 95;
  if (isSubset(ta, tb) || isSubset(tb, ta)) return 85;
  const maxDist = Math.min(normTarget.length, normCandidate.length) >= 8 ? 2 : 1;
  if (levenshtein(normTarget, normCandidate) <= maxDist) return 80;
  if (normTarget.length >= 6 && normCandidate.length >= 6
      && (normTarget.includes(normCandidate) || normCandidate.includes(normTarget))) return 75;
  return 0;
}

// One vendor-list load per lambda invocation (paged; QBO queries return only
// Active vendors by default, which is what we want — bills can't post to an
// inactive vendor anyway).
let vendorListCache = null;
export async function loadQBOVendors() {
  if (vendorListCache) return vendorListCache;
  const out = [];
  for (let start = 1; start <= 9001; start += 1000) {
    const res = await qboQuery(`SELECT Id, DisplayName FROM Vendor STARTPOSITION ${start} MAXRESULTS 1000`);
    const batch = res.QueryResponse?.Vendor || [];
    out.push(...batch);
    if (batch.length < 1000) break;
  }
  vendorListCache = out;
  return out;
}

// Returns the matched QBO vendor object ({ Id, DisplayName, ... }) or null.
export async function findQBOVendor(name) {
  if (!name || !String(name).trim()) return null;
  const target = normalizeVendorName(name);
  if (!target) return null;
  const vendors = await loadQBOVendors();
  let best = null; let bestScore = 0; let tie = false;
  for (const v of vendors) {
    const s = scoreMatch(target, normalizeVendorName(v.DisplayName));
    if (s > bestScore) { best = v; bestScore = s; tie = false; }
    else if (s === bestScore && s > 0 && best && v.Id !== best.Id) tie = true;
  }
  if (bestScore >= 75 && !tie) return best;
  return null; // no match, or ambiguous — caller emails "needs attention"
}
