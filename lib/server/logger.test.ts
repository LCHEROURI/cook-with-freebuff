import { describe, it, expect, vi, afterEach } from 'vitest';
import { logEvent, logInfo, logWarn, logError } from './logger';
import { ConversationOrchestrator } from '../agent/orchestrator';
import { createDefaultToolRegistry } from './tools';
import { SessionService, InMemorySessionStore } from './session-service';
import { InMemoryTimerStore, InMemoryLogStore, InMemoryRecipeStore } from './tools/registry';
import type { ToolContext } from './tools/types';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('structured logger (K9 Part C)', () => {
  it('emits one JSON line per event with ts, level and event', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logInfo('test.event', { userId: 'u1', count: 2 });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe('test.event');
    expect(parsed.level).toBe('info');
    expect(parsed.userId).toBe('u1');
    expect(parsed.count).toBe(2);
    expect(typeof parsed.ts).toBe('string');
    expect(new Date(parsed.ts).getTime()).not.toBeNaN();
  });

  it('routes warn/error to stderr and info to stdout', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logError('a.failure', { code: 'X' });
    logWarn('a.warn', { code: 'Y' });
    logInfo('a.info');
    expect(errSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('carries the correlationId through every field payload', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logEvent('trace', { correlationId: 'corr-123' });
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.correlationId).toBe('corr-123');
  });
});

describe('correlation + failure observability (K9 Part C)', () => {
  function makeContext(userId = 'user-1'): ToolContext {
    return {
      userId,
      correlationId: 'corr-e2e-42',
      sessionService: new SessionService(new InMemorySessionStore()),
      timerStore: new InMemoryTimerStore(),
      logStore: new InMemoryLogStore(),
      recipeStore: new InMemoryRecipeStore(),
    };
  }

  it('logs the provider failure with the correlation id (never the raw error to the user)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = makeContext();
    const provider = {
      async process() {
        throw new Error('model exploded');
      },
    };
    const orch = new ConversationOrchestrator({ registry: createDefaultToolRegistry(), context: ctx, provider });
    const turn = await orch.process('hello');
    // User sees the calm message; the failure lands in the structured log.
    expect(turn.response).toBe('I had trouble with that. Please try again.');
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = errSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe('agent.provider.error');
    expect(parsed.correlationId).toBe('corr-e2e-42');
    expect(parsed.message).toContain('model exploded');
    // No secrets, no full stacks.
    expect(parsed.message.length).toBeLessThanOrEqual(300);
  });

  it('tool failures land in agent_tool_logs with the correlation id (the durable trail)', async () => {
    const logStore = new InMemoryLogStore();
    const ctx = { ...makeContext(), logStore };
    const orch = new ConversationOrchestrator({ registry: createDefaultToolRegistry(), context: ctx });
    await orch.process('done'); // no session → complete_current_step fails honestly
    const entries = logStore.listLogs();
    const failed = entries.find((l) => l.tool === 'complete_current_step');
    expect(failed).toBeDefined();
    expect(failed!.result.success).toBe(false);
    expect(failed!.result.errorCode).toBeTruthy();
    expect(failed!.correlationId).toBe('corr-e2e-42');
    expect(failed!.userId).toBe('user-1');
  });
});
