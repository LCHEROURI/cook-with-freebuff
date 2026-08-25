import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QUOTA_ROUTE_CONTRACTS } from './app-check-route-contract';

describe('quota-bearing route App Check order contract', () => {
  it('covers the complete approved quota-route inventory', () => {
    expect(QUOTA_ROUTE_CONTRACTS.map((contract) => contract.route)).toEqual([
      'app/api/agent/route.ts',
      'app/api/cook/route.ts',
      'app/api/tools/route.ts',
      'app/api/vision/scan/route.ts',
      'app/api/voice/token/route.ts',
    ]);
  });

  it.each(QUOTA_ROUTE_CONTRACTS)(
    '$route gates App Check before $quotaBoundary',
    ({ route, gate, quotaBoundary }) => {
      const source = readFileSync(new URL(`../${route}`, import.meta.url), 'utf8');
      const gateIndex = source.indexOf(gate);
      const quotaIndex = source.indexOf(quotaBoundary, gateIndex + gate.length);
      expect(gateIndex, `${route} is missing its App Check gate`).toBeGreaterThan(-1);
      expect(quotaIndex, `${route} is missing quota boundary ${quotaBoundary}`).toBeGreaterThan(-1);
      expect(gateIndex, `${route} reaches quota before App Check`).toBeLessThan(quotaIndex);
    },
  );
});
