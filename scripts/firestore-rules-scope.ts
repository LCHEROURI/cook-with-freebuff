import { createHash } from 'node:crypto';

const COOK_SECTION_MARKER =
  '    // ── Kitchen Agent (cook-with-freebuff) ──────────────────────────────────';
const CATCH_ALL_MARKER =
  '    // --- Catch-all (deny everything else) — keep last. ---';

const EXPECTED_NON_COOK_PREFIX_SHA256 =
  'bfc05f9fa86e40b0b2d615ba81618601984c702855869b7c4fef84128c15e0ce';
const EXPECTED_CATCH_ALL_SUFFIX_SHA256 =
  '1329ee3925ba9c4ead8dc8ed7d0751dc0e95950dba59118e7a8f412d8a0309e4';

export interface UnionRulesSections {
  prefix: string;
  cook: string;
  suffix: string;
}

function uniqueMarkerIndex(source: string, marker: string, label: string): number {
  const first = source.indexOf(marker);
  if (first < 0) throw new Error(`${label} is missing`);
  if (source.lastIndexOf(marker) !== first) throw new Error(`${label} is duplicated`);
  return first;
}

export function splitUnionRules(source: string): UnionRulesSections {
  const cookStart = uniqueMarkerIndex(source, COOK_SECTION_MARKER, 'Cook section marker');
  const suffixStart = uniqueMarkerIndex(source, CATCH_ALL_MARKER, 'Catch-all marker');
  if (suffixStart <= cookStart) {
    throw new Error('Catch-all marker must follow the Cook section marker');
  }
  return {
    prefix: source.slice(0, cookStart),
    cook: source.slice(cookStart, suffixStart),
    suffix: source.slice(suffixStart),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function assertNonCookRulesUnchanged(source: string): void {
  const sections = splitUnionRules(source);
  if (sha256(sections.prefix) !== EXPECTED_NON_COOK_PREFIX_SHA256) {
    throw new Error('Shared Firestore non-Cook prefix changed outside the approved scope');
  }
  if (sha256(sections.suffix) !== EXPECTED_CATCH_ALL_SUFFIX_SHA256) {
    throw new Error('Shared Firestore catch-all suffix changed outside the approved scope');
  }
}
