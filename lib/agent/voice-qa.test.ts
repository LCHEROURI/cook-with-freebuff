import { describe, it, expect } from 'vitest';
import { ConversationOrchestrator } from './orchestrator';
import { createDefaultToolRegistry } from '../server/tools';
import { SessionService, InMemorySessionStore } from '../server/session-service';
import { InMemoryTimerStore, InMemoryLogStore, InMemoryRecipeStore, InMemoryPantryStore, InMemoryDietaryProfileStore } from '../server/tools/registry';
import type { ToolContext } from '../server/tools/types';

// ── K9 Part E — voice QA ─────────────────────────────────────────────────────
// The agent is spoken by a cook mid-kitchen: responses must be short, direct,
// and hands-free friendly — no walls of text, no markdown, nothing to read.

function makeContext(userId = 'user-1'): ToolContext {
  return {
    userId,
    sessionService: new SessionService(new InMemorySessionStore()),
    timerStore: new InMemoryTimerStore(),
    logStore: new InMemoryLogStore(),
    recipeStore: new InMemoryRecipeStore(),
    pantryStore: new InMemoryPantryStore(),
    dietaryProfileStore: new InMemoryDietaryProfileStore(),
  };
}

const registry = createDefaultToolRegistry();

/** Spoken responses must fit in ~2 spoken sentences. */
const MAX_SPOKEN_CHARS = 220;

function assertSpokenQuality(utterance: string, response: string): void {
  expect(response.length).toBeGreaterThan(0);
  expect(response.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
  // No markdown, no code fences, no lists of more than ~5 lines — voice output.
  expect(response).not.toContain('```');
  expect(response).not.toMatch(/^#+\s/m);
}

describe('K9 voice QA — concise, actionable speech', () => {
  it('every deterministic command reply is short and unformatted', async () => {
    const ctx = makeContext();
    const orch = new ConversationOrchestrator({ registry, context: ctx });

    // Seed a session in a known phase so step commands have something to act on.
    await orch.process('I have two tomatoes and some rice');
    await orch.process('yes');

    const cases = [
      'what do I do now?',
      "I don't have garlic",
      'repeat that',
      'go back',
      'pause',
      'resume',
      'how much time is left?',
    ];
    for (const utterance of cases) {
      const turn = await orch.process(utterance);
      assertSpokenQuality(utterance, turn.response);
    }
  });

  it('help is the one intentionally long reference card (but still plain text)', async () => {
    const ctx = makeContext();
    const orch = new ConversationOrchestrator({ registry, context: ctx });
    const turn = await orch.process('what can you do?');
    // A reference card may be long — but it must still be plain text, and it
    // is rendered in the UI rather than spoken aloud.
    expect(turn.response.length).toBeGreaterThan(0);
    expect(turn.response).not.toContain('```');
  });

  it('pantry commands reply concisely even with multiple items', async () => {
    const ctx = makeContext();
    const orch = new ConversationOrchestrator({ registry, context: ctx });
    const turn = await orch.process('I always have olive oil, salt and black pepper');
    assertSpokenQuality('pantry add', turn.response);
  });

  it('error responses stay short and non-alarming', async () => {
    const ctx = makeContext();
    const orch = new ConversationOrchestrator({ registry, context: ctx });
    const turn = await orch.process('done'); // no session → honest failure
    expect(turn.response).toMatch(/^Sorry,/);
    expect(turn.response.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
  });
});
