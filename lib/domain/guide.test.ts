import { describe, expect, it } from 'vitest';
import { formatPausedAgo } from './guide';

describe('formatPausedAgo', () => {
  it('says "just now" through the whole first minute (never "paused 0m ago")', () => {
    // Codex P2 — a 5–59s pause used to render "paused 0m ago".
    expect(formatPausedAgo(1_000_000_000_000, 1_000_000_000_004)).toBe('just now');
    expect(formatPausedAgo(1_000_000_000_000, 1_000_000_000_030)).toBe('just now');
    expect(formatPausedAgo(1_000_000_000_000, 1_000_000_000_059)).toBe('just now');
  });

  it('formats minutes as "paused Xm ago"', () => {
    expect(formatPausedAgo(1_000_000_000_000, 1_000_000_120_000)).toBe('paused 2m ago');
  });

  it('formats hours as "paused Xh Ym ago"', () => {
    expect(formatPausedAgo(1_000_000_000_000, 1_000_003_600_000 + 120_000)).toBe('paused 1h 2m ago');
  });

  it('never goes negative (pausedAt in the future clamps to just now)', () => {
    expect(formatPausedAgo(1_000_000_000_000, 999_999_000_000)).toBe('just now');
  });
});
