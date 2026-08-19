import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

// Functional lock for the status route's flake_streak negative path: the
// escalation step writes deploy_status/flake_streak with active=false when no
// escalation issue is open (a healed / clean week), and the /status card must
// key on that flag — never on a lingering signature or count — so a stale
// streak can't render as active.
vi.mock('@/lib/server/admin', () => ({
  getAdminDb: vi.fn(),
  resolveUserId: vi.fn(),
}));

import { getAdminDb, resolveUserId } from '@/lib/server/admin';

const mockGetDb = getAdminDb as ReturnType<typeof vi.fn>;
const mockResolve = resolveUserId as ReturnType<typeof vi.fn>;

/** In-memory Firestore stand-in for the three deploy_status docs the route
 * reads. `null`/absent means "doc does not exist". */
function fakeDb(seed: Record<string, Record<string, unknown> | null>) {
  return {
    collection: (_name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = seed[id];
          if (data === null || data === undefined) {
            return { exists: false, data: () => ({}) };
          }
          return { exists: true, data: () => data };
        },
      }),
    }),
  };
}

function get(seed: Record<string, Record<string, unknown> | null>, token: string | null = 'Bearer good-token') {
  mockGetDb.mockReturnValue(fakeDb(seed));
  mockResolve.mockResolvedValue(token ? 'user-1' : null);
  return GET(
    new Request('http://localhost/api/status', {
      headers: token ? { authorization: token } : {},
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('app/api/status/route.ts · flake_streak negative path', () => {
  it('returns an inactive flake_streak doc as active=false so the card shows the empty state', async () => {
    // A healed streak still carries its old signature + count in the doc; the
    // route must report active=false and let the card key on that flag alone.
    const res = await get({
      verify_live: null,
      last_external: null,
      flake_streak: {
        active: false,
        recurringCount: 1,
        signature: 'launch → 503',
        weeks: ['2026-08-03', '2026-08-10', '2026-08-17'],
        ranAt: '2026-08-18T00:00:00Z',
        runUrl: 'https://github.com/LCHEROURI/cook-with-freebuff/actions/runs/1',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flakeStreak).not.toBeNull();
    expect(body.flakeStreak.active).toBe(false);
    // The lingering fields still round-trip — the card renders the empty state
    // from `active`, not by checking whether signature/count are absent.
    expect(body.flakeStreak.signature).toBe('launch → 503');
    expect(body.flakeStreak.recurringCount).toBe(1);
  });

  it('maps a non-boolean active flag to false, never a phantom streak', () => {
    // `active: d.active === true` is strict: a truthy string like "false"
    // (or any legacy/malformed value) must not be able to fake an active
    // streak. Guarded here so a naive `!!d.active` change can't slip in.
    return get({
      verify_live: null,
      last_external: null,
      flake_streak: { active: 'false', recurringCount: 2, signature: 'x', weeks: [], ranAt: '', runUrl: '' },
    }).then(async (res) => {
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.flakeStreak.active).toBe(false);
    });
  });

  it('returns flakeStreak null when the doc does not exist (no phantom empty-vs-absent confusion)', async () => {
    const res = await get({ verify_live: null, last_external: null, flake_streak: null });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flakeStreak).toBeNull();
  });
});
