// ─────────────────────────────────────────────────────────────────────────────
// Request context — AsyncLocalStorage carrying a correlation ID through the
// lifecycle of every request. Every API route sets this at the edge; every
// tool handler, repository call, and log event inherits it without threading
// it through function signatures.
//
// K9 Part C — observability: correlation id threads voice → agent → tool →
// backend → database → response.
// ─────────────────────────────────────────────────────────────────────────────

import { AsyncLocalStorage } from 'node:async_hooks';
import { correlationIdSchema } from '../domain/schemas';

// ── Context shape ───────────────────────────────────────────────────────────

export interface RequestContext {
  correlationId: string;
}

// ── Storage ─────────────────────────────────────────────────────────────────

const storage = new AsyncLocalStorage<RequestContext>();

// ── Public API ──────────────────────────────────────────────────────────────

/** Run a callback inside a fresh request context with the given correlationId. */
export function runWithContext<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

/** Return the current request's correlationId, or fallback if none is active. */
export function getCorrelationId(fallback = 'no-correlation-id'): string {
  return storage.getStore()?.correlationId ?? fallback;
}

/** True when a request context is active (e.g. inside an API route). */
export function hasRequestContext(): boolean {
  return storage.getStore() !== undefined;
}

// ── ID generator ────────────────────────────────────────────────────────────

export function generateCorrelationId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 12; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  return `req_${id}_${Date.now().toString(36)}`;
}

// ── API-boundary validation ─────────────────────────────────────────────────

/** Message surfaced on a 400 INVALID_BODY when the client sends a malformed id. */
export const INVALID_CORRELATION_ID_MESSAGE =
  'correlationId must be 1–128 characters using only letters, digits, dot, underscore and hyphen';

/**
 * Validate a client-supplied correlationId at the API boundary.
 *
 * Absent (undefined/null) → { valid: true, id: undefined } and the caller
 * generates one. Present but malformed → { valid: false }, which the caller
 * MUST reject with a 400 — never silently fall back to a generated id, or a
 * client retry carrying a malformed id would lose its idempotency semantics
 * and, more importantly, a malformed id could reach the marker namespace.
 */
export function validateClientCorrelationId(
  raw: unknown,
): { valid: true; id?: string } | { valid: false } {
  if (raw === undefined || raw === null) return { valid: true, id: undefined };
  const check = correlationIdSchema.safeParse(raw);
  if (!check.success) return { valid: false };
  return { valid: true, id: check.data };
}
