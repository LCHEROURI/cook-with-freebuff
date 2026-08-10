// ─────────────────────────────────────────────────────────────────────────────
// Leftover service (K10 — leftovers tracking)
//
// Turns finished meals into remembered leftovers: every guided completion logs
// a `leftovers` entry (recipe title + servings), and the user can list what's
// still in the fridge, add manual entries (e.g. takeout), and mark an entry
// consumed. Entries never disappear silently — they stay ACTIVE until the
// user says so, and the tool layer surfaces how long they've been stored.
// ─────────────────────────────────────────────────────────────────────────────

import type { SessionService } from './session-service';
import type { LeftoverStore } from './tools/types';
import type { Leftover, SessionEventType } from '../domain/types';

export interface LeftoverInput {
  recipeId?: string;
  title: string;
  servings: number;
  notes?: string;
}

export class LeftoverError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
    this.name = 'LeftoverError';
  }
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'leftover';
}

function rand4(): string {
  return Math.random().toString(36).slice(2, 6);
}

export class LeftoverService {
  constructor(
    private readonly leftoverStore: LeftoverStore,
    private readonly sessionService?: SessionService,
  ) {}

  /** Log a finished meal as a leftover (ACTIVE). */
  async createLeftover(
    userId: string,
    input: LeftoverInput,
    options?: { sessionId?: string },
  ): Promise<Leftover> {
    const now = Date.now();
    const leftover: Leftover = {
      id: `leftover-${slug(input.title)}-${rand4()}`,
      userId,
      recipeId: input.recipeId,
      title: input.title.trim(),
      servings: input.servings,
      completedAt: now,
      storedAt: now,
      status: 'ACTIVE',
      notes: input.notes,
    };
    await this.leftoverStore.createLeftover(leftover);
    await this.logEvent(options?.sessionId, 'LEFTOVER_LOGGED', {
      leftoverId: leftover.id,
      title: leftover.title,
      servings: leftover.servings,
    });
    return leftover;
  }

  /** ACTIVE leftovers, newest first (what's actually in the fridge). */
  async listActiveLeftovers(userId: string): Promise<Leftover[]> {
    const all = await this.leftoverStore.listLeftovers(userId);
    return all
      .filter((l) => l.status === 'ACTIVE')
      .sort((a, b) => b.storedAt - a.storedAt);
  }

  /** Mark a leftover as eaten/used up — removes it from the active list. */
  async consumeLeftover(userId: string, leftoverId: string): Promise<Leftover> {
    const leftover = await this.requireOwned(userId, leftoverId);
    const updated: Leftover = { ...leftover, status: 'CONSUMED' };
    await this.leftoverStore.updateLeftover(leftover.id, { status: 'CONSUMED' });
    return updated;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async requireOwned(userId: string, leftoverId: string): Promise<Leftover> {
    const leftover = await this.leftoverStore.getLeftover(leftoverId);
    if (!leftover) {
      throw new LeftoverError(`Leftover ${leftoverId} not found`, 'LEFTOVER_NOT_FOUND', true);
    }
    if (leftover.userId !== userId) {
      throw new LeftoverError('Leftover belongs to another user', 'FORBIDDEN', false);
    }
    return leftover;
  }

  private async logEvent(
    sessionId: string | undefined,
    type: SessionEventType,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!sessionId || !this.sessionService) return;
    const session = await this.sessionService.getSession(sessionId);
    if (!session) return;
    await this.sessionService.logSessionEvent(sessionId, type, data);
  }
}
