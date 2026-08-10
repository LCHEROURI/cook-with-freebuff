import { describe, it, expect } from 'vitest';
import { matchCommand } from './commands';

describe('matchCommand', () => {
  it('maps "done" and "next" to complete_current_step', () => {
    expect(matchCommand('done')?.tool).toBe('complete_current_step');
    expect(matchCommand('next')?.tool).toBe('complete_current_step');
    expect(matchCommand('I am done with this step')?.tool).toBe('complete_current_step');
    expect(matchCommand('continue')?.tool).toBe('complete_current_step');
  });

  it('maps "repeat that" to repeat_current_step', () => {
    expect(matchCommand('repeat that')?.tool).toBe('repeat_current_step');
    expect(matchCommand('say that again')?.tool).toBe('repeat_current_step');
  });

  it('maps "go back" to previous_step', () => {
    expect(matchCommand('go back')?.tool).toBe('previous_step');
    expect(matchCommand('previous step')?.tool).toBe('previous_step');
  });

  it('maps pause and resume', () => {
    expect(matchCommand('pause')?.tool).toBe('pause_cooking_session');
    expect(matchCommand('take a break')?.tool).toBe('pause_cooking_session');
    expect(matchCommand('resume')?.tool).toBe('resume_cooking_session');
    expect(matchCommand('keep cooking')?.tool).toBe('resume_cooking_session');
  });

  it('maps "stop" to end_cooking_session with completed false', () => {
    const m = matchCommand('stop');
    expect(m?.tool).toBe('end_cooking_session');
    expect(m?.arguments).toEqual({ completed: false });
  });

  it('maps timer questions to get_active_timers', () => {
    expect(matchCommand('how much time is left?')?.tool).toBe('get_active_timers');
    expect(matchCommand('how long on the timer')?.tool).toBe('get_active_timers');
  });

  it('maps step questions to get_current_step', () => {
    expect(matchCommand('what do I do now?')?.tool).toBe('get_current_step');
    expect(matchCommand('what temperature?')?.tool).toBe('get_current_step');
  });

  it('maps "I don\'t have garlic" to request_substitution with the ingredient', () => {
    const m = matchCommand("I don't have garlic, what can I use instead?");
    expect(m?.intent).toBe('SUBSTITUTE');
    expect(m?.tool).toBe('request_substitution');
    expect(m?.arguments).toEqual({ unavailableIngredient: 'garlic' });
  });

  it('maps "I am out of milk" to request_substitution', () => {
    const m = matchCommand("I'm out of milk");
    expect(m?.intent).toBe('SUBSTITUTE');
    expect(m?.arguments).toEqual({ unavailableIngredient: 'milk' });
  });

  it('asks a follow-up when no ingredient is named', () => {
    const m = matchCommand('can I use something else?');
    expect(m?.intent).toBe('SUBSTITUTE');
    expect(m?.tool).toBeUndefined();
    expect(m?.needsFollowUp).toContain('What are you out of?');
  });

  it('maps "use X" to apply_substitution', () => {
    const m = matchCommand('use garlic powder instead');
    expect(m?.intent).toBe('USE_SUBSTITUTE');
    expect(m?.tool).toBe('apply_substitution');
    expect(m?.arguments).toEqual({ replacement: 'garlic powder' });
  });

  it('maps corrections with a quantity to correct_ingredient', () => {
    const m = matchCommand('No, I said two tomatoes');
    expect(m?.intent).toBe('CORRECT');
    expect(m?.tool).toBe('correct_ingredient');
    expect(m?.arguments).toEqual({ name: 'tomatoes', quantity: 2 });
  });

  it('maps "I meant chicken thighs" to correct_ingredient without a quantity', () => {
    const m = matchCommand('I meant chicken thighs, not chicken breast');
    expect(m?.intent).toBe('CORRECT');
    expect(m?.tool).toBe('correct_ingredient');
    expect(m?.arguments).toEqual({ name: 'chicken thighs' });
  });

  it('maps a short confirmation to the pending-pantry chain with step fallback', () => {
    const m = matchCommand('yes');
    expect(m?.intent).toBe('CONFIRM');
    expect(m?.tool).toBe('confirm_pending_pantry_items');
    expect(m?.fallbackTools).toEqual(['confirm_available_ingredients', 'complete_current_step']);
  });

  it('maps "I always have …" to PANTRY_ADD with the extracted names', () => {
    const m = matchCommand('I always have olive oil, salt and black pepper');
    expect(m?.intent).toBe('PANTRY_ADD');
    expect(m?.arguments).toEqual({ names: ['olive oil', 'salt', 'black pepper'] });
  });

  it('maps "add X to my pantry" to PANTRY_ADD', () => {
    const m = matchCommand('add flour to my pantry');
    expect(m?.intent).toBe('PANTRY_ADD');
    expect(m?.arguments).toEqual({ names: ['flour'] });
  });

  it('leaves a plain "I have …" brain-dump alone (ingredient extraction)', () => {
    expect(matchCommand('I have some chicken thighs, three tomatoes and rice')).toBeNull();
  });

  it('maps a pantry listing question to PANTRY_GET without a filter', () => {
    const m = matchCommand("what's in my pantry?");
    expect(m?.intent).toBe('PANTRY_GET');
    expect(m?.tool).toBe('get_pantry');
    expect(m?.arguments?.name).toBeUndefined();
  });

  it('maps "do I have X" to PANTRY_GET with a name filter', () => {
    const m = matchCommand('do I have garlic?');
    expect(m?.intent).toBe('PANTRY_GET');
    expect(m?.arguments).toEqual({ name: 'garlic' });
  });

  it('maps "remove X from my pantry" to PANTRY_REMOVE', () => {
    const m = matchCommand('remove olive oil from my pantry');
    expect(m?.intent).toBe('PANTRY_REMOVE');
    expect(m?.tool).toBe('remove_pantry_item');
    expect(m?.arguments).toEqual({ name: 'olive oil' });
  });

  it('does not treat a long sentence as a confirmation', () => {
    expect(matchCommand('yes I also have some eggs in the fridge')).toBeNull();
  });

  it('maps help to a help intent', () => {
    expect(matchCommand('what can you do?')?.intent).toBe('HELP');
  });

  it('returns null for empty input', () => {
    expect(matchCommand('   ')).toBeNull();
  });

  // ── K10 — leftovers + grocery list ────────────────────────────────────────

  it('maps a fridge question to LEFTOVERS_GET → get_leftovers', () => {
    expect(matchCommand("what's in my fridge?")?.tool).toBe('get_leftovers');
    expect(matchCommand('what do I have leftover?')?.tool).toBe('get_leftovers');
    expect(matchCommand('any leftovers?')?.tool).toBe('get_leftovers');
  });

  it('maps "add X to my grocery list" to GROCERY_ADD with the parsed names', () => {
    const m = matchCommand('add milk and eggs to my grocery list');
    expect(m?.intent).toBe('GROCERY_ADD');
    expect(m?.arguments).toEqual({ names: ['milk', 'eggs'] });
  });

  it('maps "I need eggs" and "buy some bread" to GROCERY_ADD', () => {
    expect(matchCommand('I need eggs')?.intent).toBe('GROCERY_ADD');
    expect(matchCommand('I need to buy bread')?.intent).toBe('GROCERY_ADD');
    expect(matchCommand('buy some butter')?.intent).toBe('GROCERY_ADD');
    expect(matchCommand('I need to get milk')?.arguments).toEqual({ names: ['milk'] });
  });

  it('maps a grocery list question to GROCERY_GET → get_grocery_list', () => {
    expect(matchCommand("what's on my grocery list?")?.tool).toBe('get_grocery_list');
    expect(matchCommand('shopping list?')?.tool).toBe('get_grocery_list');
  });

  it('maps "remove X from my grocery list" to GROCERY_REMOVE by name', () => {
    const m = matchCommand('remove milk from my grocery list');
    expect(m?.intent).toBe('GROCERY_REMOVE');
    expect(m?.tool).toBe('remove_grocery_item');
    expect(m?.arguments).toEqual({ name: 'milk' });
  });

  it('maps a bought confirmation to GROCERY_BOUGHT by name', () => {
    const m = matchCommand('I bought eggs off my grocery list');
    expect(m?.intent).toBe('GROCERY_BOUGHT');
    expect(m?.tool).toBe('mark_grocery_bought');
    expect(m?.arguments).toEqual({ name: 'eggs' });
  });

  it('does not confuse a pantry question with a grocery one', () => {
    expect(matchCommand("what's in my pantry?")?.intent).toBe('PANTRY_GET');
    expect(matchCommand("what's in my fridge?")?.intent).toBe('LEFTOVERS_GET');
  });
});