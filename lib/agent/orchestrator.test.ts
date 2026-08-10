import { describe, it, expect } from 'vitest';
import { ConversationOrchestrator } from './orchestrator';
import { createDefaultToolRegistry } from '../server/tools';
import { ToolRegistry, executeTool } from '../server/tools/registry';
import { SessionService, InMemorySessionStore } from '../server/session-service';
import { InMemoryTimerStore, InMemoryLogStore, InMemoryRecipeStore } from '../server/tools/registry';
import type { ToolContext } from '../server/tools/types';
import type { ConversationAgent } from '../ai/provider';

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
    const turn = await orch.process('go ahead and start cooking');

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

  it('answers substitution with a clarifying question instead of a tool call', async () => {
    const { ctx } = makeContext();
    const orch = new ConversationOrchestrator({ registry, context: ctx });
    const turn = await orch.process("I don't have garlic");
    expect(turn.toolCalls).toHaveLength(0);
    expect(turn.response).toContain('What are you out of?');
  });

  it('routes "what do I do now?" to get_current_step', async () => {
    const { ctx } = makeContext();
    const orch = new ConversationOrchestrator({ registry, context: ctx });
    const turn = await orch.process('what do I do now?');
    expect(turn.toolCalls[0]?.tool).toBe('get_current_step');
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