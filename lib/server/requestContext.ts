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
