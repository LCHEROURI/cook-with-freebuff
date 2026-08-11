import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TOOL_DECLARATIONS, LIVE_SYSTEM_INSTRUCTION, buildLiveSystemInstruction } from './tool-declarations';
import { TOOL_DECLARATIONS as CONVERSATION_TOOL_DECLARATIONS } from './conversation';

// ============================================================================
// lib/ai/tool-declarations.test.ts — the model-visible tool surface is ONE
// source of truth shared by /api/agent and the Gemini Live client. These
// contracts lock: the shared export, the pure-JSON shape (so the browser
// bundle never pulls the Google SDK), and the Live system instruction's
// parity with the orchestrator prompt.
// ============================================================================

describe('shared tool declarations', () => {
  it('is the SAME array /api/agent uses (one source of truth)', () => {
    expect(TOOL_DECLARATIONS).toBe(CONVERSATION_TOOL_DECLARATIONS);
    expect(TOOL_DECLARATIONS.length).toBeGreaterThan(30);
  });

  it('covers the pantry, leftovers, grocery and session tools', () => {
    const names = TOOL_DECLARATIONS.map((t) => t.name);
    for (const tool of [
      'get_pantry',
      'add_pantry_item',
      'get_leftovers',
      'get_grocery_list',
      'cook_with_me',
      'complete_current_step',
      'update_available_ingredients',
    ]) {
      expect(names).toContain(tool);
    }
  });

  it('is pure JSON — no functions, no undefined, stringify-safe (SDK-free)', () => {
    const json = JSON.parse(JSON.stringify(TOOL_DECLARATIONS)) as unknown[];
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBe(TOOL_DECLARATIONS.length);
    for (const decl of json as { name?: unknown; description?: unknown; parameters?: unknown }[]) {
      expect(typeof decl.name).toBe('string');
      expect(typeof decl.description).toBe('string');
      expect(decl.parameters).toBeDefined();
    }
  });

  it('never uses union-type arrays in schemas (Gemini rejects them)', () => {
    const walk = (v: unknown): string[] => {
      if (Array.isArray(v)) {
        return v.some((item) => typeof item === 'string' && item === 'null')
          ? ['union']
          : v.flatMap((item) => walk(item));
      }
      if (v && typeof v === 'object') {
        return Object.values(v as Record<string, unknown>).flatMap((item) => walk(item));
      }
      return [];
    };
    expect(walk(TOOL_DECLARATIONS)).toEqual([]);
  });

  it('embeds LIVE_SYSTEM_INSTRUCTION in the Live session instruction', () => {
    const instruction = buildLiveSystemInstruction({
      currentPhase: 'COOKING_GUIDANCE',
      currentStep: 'cooking step 2',
      activeTimerIds: ['t1'],
    });
    expect(instruction).toContain(LIVE_SYSTEM_INSTRUCTION);
    expect(instruction).toContain('COOKING_GUIDANCE');
    expect(instruction).toContain('cooking step 2');
    expect(instruction).toContain('t1');
  });
});

describe('SDK-free extraction contract', () => {
  it('conversation.ts imports the shared declarations instead of defining its own', () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/ai/conversation.ts'), 'utf8');
    expect(src).toContain("from './tool-declarations'");
    // The big inline array is gone — no 300-line duplicated declarations block.
    expect(src).not.toContain('const INGREDIENT_SCHEMA =');
  });

  it('the tool-declarations module itself imports nothing (pure JSON)', () => {
    const src = readFileSync(resolve(process.cwd(), 'lib/ai/tool-declarations.ts'), 'utf8');
    expect(src).not.toMatch(/^import /m);
  });
});
