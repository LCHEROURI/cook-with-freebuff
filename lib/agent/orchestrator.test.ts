import { describe, it, expect } from 'vitest';
import { ConversationOrchestrator } from './orchestrator';
import { createDefaultToolRegistry } from '../server/tools';
import { ToolRegistry, executeTool } from '../server/tools/registry';
import { SessionService, InMemorySessionStore } from '../server/session-service';
import { InMemoryTimerStore, InMemoryLogStore, InMemoryRecipeStore } from '../server/tools/registry';
import { GuidedCookingService } from '../server/guide-service';
import type { ToolContext } from '../server/tools/types';
import type { ConversationAgent } from '../ai/provider';
import type { Recipe } from '../domain/types';

function makeRecipe(): Recipe {
  const t = Date.now();
  return {
    id: 'recipe-1',
    userId: 'user-1',
    title: 'Chicken Rice',
    description: 'Simple one-pan dinner',
    servings: 2,
    estimatedPrepMinutes: 10,
    estimatedCookMinutes: 25,
    totalMinutes: 35,
    ingredients: [{ id: 'i1', name: 'chicken thighs', quantity: 4, unit: 'pieces', optional: false }],
    equipment: ['pan', 'knife'],
    prepSteps: [
      { id: 'p1', stepNumber: 1, instruction: 'Heat the oil on high', spokenInstruction: 'Heat the oil on high', estimatedSeconds: 60, ingredientsUsed: [], equipmentUsed: ['pan'], safetyNote: 'Hot oil — keep children away' },
      { id: 'p2', stepNumber: 2, instruction: 'Dice the onion', spokenInstruction: 'Dice the onion', estimatedSeconds: 120, ingredientsUsed: ['onion'], equipmentUsed: ['knife'] },
    ],
    cookingSteps: [
      { id: 'c1', stepNumber: 1, instruction: 'Sear the chicken 4 minutes', spokenInstruction: 'Sear the chicken four minutes', estimatedSeconds: 240, timerSeconds: 240, ingredientsUsed: ['chicken thighs'], equipmentUsed: ['pan'] },
    ],
    dietaryTags: [],
    allergens: [],
    safetyNotes: ['Hot oil — keep children away'],
    generatedAt: t,
    updatedAt: t,
  };
}

function makeContext(userId = 'user-1'): { ctx: ToolContext; store: InMemorySessionStore } {
  const store = new InMemorySessionStore();
  return {
    ctx: {
      userId,
      sessionService: new SessionService(store),
      timerStore: new InMemoryTimerStore(),
      logStore: new InMemoryLogStore(),
      recipeStore: new InMemoryRecipeStore(),
    },
    store,
  };
}

const registry = createDefaultToolRegistry();



describe('ConversationOrchestrator', () => {
  it('routes "done" to complete_current_step and reports failure honestly', async () => {
    const { ctx } = makeContext();
    const orch = new ConversationOrchestrator({ registry, context: ctx });
    const turn = await orch.process('done');
    expect(turn.toolCalls.length).toBe(1);
    expect(turn.toolCalls[0].tool).toBe('complete_current_step');
    expect(turn.toolCalls[0].result.success).toBe(false);
    // No false success.
    expect(turn.response).toContain('did not work');
  });

  it('persists a brain-dump and asks for confirmation', async () => {
    const { ctx, store } = makeContext();
    const orch = new ConversationOrchestrator({ registry, context: ctx });
    const turn = await orch.process('I have two tomatoes and some rice');

    // Session started + ingredients saved.
    const tools = turn.toolCalls.map((c) => c.tool);
    expect(tools).toContain('start_cooking_session');
    expect(tools).toContain('update_available_ingredients');

    const session = await store.getActiveSession('user-1');
    expect(session).not.toBeNull();
    expect(session!.availableIngredients.map((i) => i.name)).toEqual(['tomatoes', 'rice']);

    expect(turn.response).toContain('I heard:');
    expect(turn.response).toContain('Is that right?');
  });

  it('confirms ingredients then falls back to step advance on invalid phase', async () => {
    const { ctx } = makeContext();
    const orch = new ConversationOrchestrator({ registry, context: ctx });

    // Collect ingredients first.
    await orch.process('I have two tomatoes');

    // "yes" confirms → confirm_available_ingredients succeeds (phase → CONFIRMING).
    const confirm = await orch.process('yes');
    expect(confirm.toolCalls.at(-1)?.tool).toBe('confirm_available_ingredients');
    expect(confirm.toolCalls.at(-1)?.result.success).toBe(true);

    // A second "yes" has nothing to confirm → falls back to step advance, which fails honestly.
    const second = await orch.process('yes');
    const last = second.toolCalls.at(-1)!;
    expect(last.tool).toBe('complete_current_step');
    expect(last.result.success).toBe(false);
    expect(second.response).toContain('did not work');
  });

  it('executes tool calls proposed by the conversation provider', async () => {
    const { ctx, store } = makeContext();
    const provider: ConversationAgent = {
      async process() {
        return {
          message: '',
          shouldSpeak: true,
          toolCalls: [{ tool: 'start_cooking_session', arguments: {} }],
        };
      },
    };
    const orch = new ConversationOrchestrator({ registry, context: ctx, provider });
    // "start cooking" is now a deterministic COOK command — use a free-form
    // phrase so this exercises the provider fallback path.
    const turn = await orch.process('go ahead and begin');

    expect(turn.toolCalls.some((c) => c.tool === 'start_cooking_session' && c.result.success)).toBe(true);
    // No false success — the provider claimed nothing; response reflects the executed tool.
    expect(turn.response).toContain('confirmed');
    expect(await store.getActiveSession('user-1')).not.toBeNull();
  });

  it('uses the provider message when present', async () => {
    const { ctx } = makeContext();
    const provider: ConversationAgent = {
      async process() {
        return { message: 'Sounds good — anything else?', shouldSpeak: true, toolCalls: [] };
      },
    };
    const orch = new ConversationOrchestrator({ registry, context: ctx, provider });
    const turn = await orch.process('hello');
    expect(turn.response).toBe('Sounds good — anything else?');
  });

  it('returns help text when nothing matches and no provider is set', async () => {
    const { ctx } = makeContext();
    const orch = new ConversationOrchestrator({ registry, context: ctx });
    const turn = await orch.process('tell me about the weather');
    expect(turn.response).toContain('Here is what I can do');
  });

  it('routes "I don\'t have garlic" to request_substitution and reports failure honestly', async () => {
    const { ctx } = makeContext();
    const orch = new ConversationOrchestrator({ registry, context: ctx });
    const turn = await orch.process("I don't have garlic");
    expect(turn.toolCalls[0]?.tool).toBe('request_substitution');
    expect(turn.toolCalls[0]?.arguments).toEqual({ unavailableIngredient: 'garlic' });
    // No session in this test — the failure must be reported honestly.
    expect(turn.toolCalls[0]?.result.success).toBe(false);
    expect(turn.response).toContain('did not work');
  });

  it('asks a clarifying question when substitution has no ingredient named', async () => {
    const { ctx } = makeContext();
    const orch = new ConversationOrchestrator({ registry, context: ctx });
    const turn = await orch.process('can I use something else?');
    expect(turn.toolCalls).toHaveLength(0);
    expect(turn.response).toContain('What are you out of?');
  });

  it('routes "what do I do now?" to get_current_step', async () => {
    const { ctx } = makeContext();
    const orch = new ConversationOrchestrator({ registry, context: ctx });
    const turn = await orch.process('what do I do now?');
    expect(turn.toolCalls[0]?.tool).toBe('get_current_step');
  });

  it('asks for explicit confirmation when "done" hits a safety gate, then completes', async () => {
    const { ctx } = makeContext();
    const recipes = ctx.recipeStore as InMemoryRecipeStore;
    await recipes.createRecipe(makeRecipe());

    // Land the session at the safety-note prep step.
    const guide = new GuidedCookingService(ctx.sessionService, ctx.timerStore, ctx.recipeStore);
    await guide.launchCookWithMe('user-1', 'recipe-1');

    const orch = new ConversationOrchestrator({ registry, context: ctx });
    const turn = await orch.process('done');
    expect(turn.toolCalls[0]?.tool).toBe('complete_current_step');
    expect(turn.toolCalls[0]?.result.success).toBe(true); // the gate IS a success
    expect(turn.response).toContain('Before you continue');
    expect(turn.response).toContain('Hot oil');
    expect(turn.response).toContain('confirm');

    // Acknowledging with a second "done" completes the step.
    const ack = await orch.process('done');
    expect(ack.toolCalls[0]?.result.success).toBe(true);
    expect(ack.response).toContain('Done — next');
    expect(ack.response).toContain('Dice the onion');
  });
});

describe('executeTool remains the single execution path', () => {
  it('can be called directly and logs the call', async () => {
    const { ctx } = makeContext();
    const result = await executeTool(registry, ctx, 'start_cooking_session', {});
    expect(result.success).toBe(true);
    // Unknown tool still rejected.
    const bad = await executeTool(registry, ctx, 'nope', {});
    expect(bad.success).toBe(false);
  });

  it('registry exposes the full tool surface for the agent', () => {
    const names = new ToolRegistry().list().map((t) => t.name);
    expect(names).toHaveLength(0); // empty registry has no tools
    expect(registry.list().length).toBeGreaterThan(15);
  });
});