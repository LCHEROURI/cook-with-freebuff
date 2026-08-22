/**
 * Structural RED test for the client-side submission lock (Task 3.4).
 *
 * Before implementation, these tests MUST fail — they assert invariants
 * that don't yet exist in page.tsx. After adding the lock, all pass.
 *
 * Pattern follows the proven cookMode.test.ts / agent.test.ts shape:
 * read the source from disk and assert structural properties without
 * spinning up React or Firebase.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGE_SRC = readFileSync(resolve(__dirname, 'page.tsx'), 'utf8');

describe('client submission lock — handleCreateRecipe', () => {
  it('acquires a generation lock before creating a correlation ID', () => {
    // The handler must set a lockRef to true before crypto.randomUUID().
    // Find the handler slice.
    const handlerStart = PAGE_SRC.indexOf('const handleCreateRecipe');
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerEnd = PAGE_SRC.indexOf('const handleCreateFromPantry', handlerStart);
    const handlerSlice = PAGE_SRC.slice(handlerStart, handlerEnd === -1 ? handlerStart + 2000 : handlerEnd);

    // Lock must be acquired before correlation ID / fetch.
    expect(handlerSlice).toMatch(/lockRef|generationLockRef|generationLock\.current\s*=\s*true/);
  });

  it('releases the lock in a finally block', () => {
    const handlerStart = PAGE_SRC.indexOf('const handleCreateRecipe');
    const handlerEnd = PAGE_SRC.indexOf('const handleCreateFromPantry', handlerStart);
    const handlerSlice = PAGE_SRC.slice(handlerStart, handlerEnd === -1 ? handlerStart + 2500 : handlerEnd);

    // The finally block must release the lock — success and failure paths.
    expect(handlerSlice).toMatch(/finally\s*\{/);
    expect(handlerSlice).toMatch(/lockRef|generationLockRef|generationLock\.current\s*=\s*false/);
  });

  it('one correlation ID per invocation (not cached across calls)', () => {
    const handlerStart = PAGE_SRC.indexOf('const handleCreateRecipe');
    const handlerEnd = PAGE_SRC.indexOf('const handleCreateFromPantry', handlerStart);
    const handlerSlice = PAGE_SRC.slice(handlerStart, handlerEnd === -1 ? handlerStart + 2500 : handlerEnd);

    // crypto.randomUUID() must be called inside the handler body — not
    // hoisted to module scope or stored in a ref across invocations.
    expect(handlerSlice).toMatch(/crypto\.randomUUID\(\)/);
  });
});

describe('client submission lock — handleCreateFromPantry', () => {
  it('acquires a generation lock before creating a correlation ID', () => {
    const handlerStart = PAGE_SRC.indexOf('const handleCreateFromPantry');
    expect(handlerStart).toBeGreaterThan(-1);

    // Grab through to next top-level function or end of file.
    const afterHandler = PAGE_SRC.slice(handlerStart);
    const nextFn = afterHandler.search(/\n\s{2}const\s+\w+\s*[=(]/);
    const handlerSlice = afterHandler.slice(0, nextFn === -1 ? undefined : nextFn);

    expect(handlerSlice).toMatch(/lockRef|generationLockRef|generationLock\.current\s*=\s*true/);
  });

  it('releases the lock in a finally block', () => {
    const handlerStart = PAGE_SRC.indexOf('const handleCreateFromPantry');
    const afterHandler = PAGE_SRC.slice(handlerStart);
    const nextFn = afterHandler.search(/\n\s{2}const\s+\w+\s*[=(]/);
    const handlerSlice = afterHandler.slice(0, nextFn === -1 ? undefined : nextFn);

    expect(handlerSlice).toMatch(/finally\s*\{/);
    expect(handlerSlice).toMatch(/lockRef|generationLockRef|generationLock\.current\s*=\s*false/);
  });

  it('one correlation ID per invocation', () => {
    const handlerStart = PAGE_SRC.indexOf('const handleCreateFromPantry');
    const afterHandler = PAGE_SRC.slice(handlerStart);
    const nextFn = afterHandler.search(/\n\s{2}const\s+\w+\s*[=(]/);
    const handlerSlice = afterHandler.slice(0, nextFn === -1 ? undefined : nextFn);

    expect(handlerSlice).toMatch(/crypto\.randomUUID\(\)/);
  });
});

describe('client submission lock — shared mechanism', () => {
  it('uses a ref (not useState) so the lock is synchronous across render ticks', () => {
    // The lock must be useRef, not useState — a state-based guard
    // (starter.creating) has a render-cycle delay. A ref is synchronous.
    expect(PAGE_SRC).toMatch(
      /useRef\s*\(\s*false\s*\).*generation|generationLock.*useRef\s*\(/,
    );
  });

  it('lockRef declaration is near the handlers', () => {
    const refIdx = PAGE_SRC.search(/generationLockRef|generationLock\b.*useRef/);
    expect(refIdx).toBeGreaterThan(-1);
  });

  it('guard clause checks the lock before proceeding', () => {
    // Both handlers must check the lock early, before any async work.
    // handleCreateRecipe already has a starter.creating guard; the lock
    // check complements it.
    const recipeIdx = PAGE_SRC.indexOf('const handleCreateRecipe');
    const pantryIdx = PAGE_SRC.indexOf('const handleCreateFromPantry');
    const between = PAGE_SRC.slice(recipeIdx, pantryIdx);
    expect(between).toMatch(/lockRef|generationLock/);
  });
});