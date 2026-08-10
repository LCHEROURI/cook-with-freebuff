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

  it('maps substitution phrases to a follow-up (no tool call)', () => {
    const m = matchCommand("I don't have garlic, what can I use instead?");
    expect(m?.intent).toBe('SUBSTITUTE');
    expect(m?.tool).toBeUndefined();
    expect(m?.needsFollowUp).toContain('What are you out of?');
  });

  it('maps a short confirmation to confirm_available_ingredients with a step fallback', () => {
    const m = matchCommand('yes');
    expect(m?.intent).toBe('CONFIRM');
    expect(m?.tool).toBe('confirm_available_ingredients');
    expect(m?.fallbackTool).toBe('complete_current_step');
  });

  it('does not treat a long sentence as a confirmation', () => {
    expect(matchCommand('yes I also have some eggs in the fridge')).toBeNull();
  });

  it('maps help to a help intent', () => {
    expect(matchCommand('what can you do?')?.intent).toBe('HELP');
  });

  it('returns null for a brain-dump', () => {
    expect(matchCommand('I have some chicken thighs, three tomatoes and rice')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(matchCommand('   ')).toBeNull();
  });
});