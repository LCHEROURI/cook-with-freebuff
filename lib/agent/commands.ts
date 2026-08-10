// ─────────────────────────────────────────────────────────────────────────────
// Conversational command router (deterministic)
//
// Maps naturally phrased commands to backend tools so the agent never answers
// from conversational memory. High-confidence commands short-circuit the LLM.
// Any phrase not matched here falls through to ingredient extraction or the
// conversation provider.
// ─────────────────────────────────────────────────────────────────────────────

export type AgentIntent =
  | 'NEXT'
  | 'REPEAT'
  | 'PREVIOUS'
  | 'PAUSE'
  | 'RESUME'
  | 'STOP'
  | 'TIMER_STATUS'
  | 'CURRENT_STEP'
  | 'SUBSTITUTE'
  | 'CONFIRM'
  | 'HELP';

export interface CommandMatch {
  intent: AgentIntent;
  /** The tool the orchestrator should call (undefined → follow-up only). */
  tool?: string;
  arguments?: Record<string, unknown>;
  /** Fallback tool when the primary fails with a recoverable error. */
  fallbackTool?: string;
  /** When set, the agent asks this question instead of calling a tool. */
  needsFollowUp?: string;
}

const NORMALIZE = /[.!?]+$/;

export function normalizeUtterance(text: string): string {
  return text.toLowerCase().replace(NORMALIZE, '').replace(/\s+/g, ' ').trim();
}

interface Rule {
  intent: AgentIntent;
  test: (text: string) => boolean;
  match: CommandMatch;
}

const CONFIRM_RE = /^(yes|yeah|yep|yup|correct|that'?s right|sounds good|looks good|confirmed|i confirm|go ahead|okay)$/i;

const RULES: Rule[] = [
  {
    intent: 'TIMER_STATUS',
    test: (t) => /\b(how much time|how long|time left|timer left|timers left|is the timer|when.*timer.*done)\b/.test(t),
    match: { intent: 'TIMER_STATUS', tool: 'get_active_timers' },
  },
  {
    intent: 'CURRENT_STEP',
    test: (t) => /\b(what(?:'s| is) the (?:current )?step|where am i|what step|what do i do now|what now|what temperature|what's next|what is next|how much)\b/.test(t),
    match: { intent: 'CURRENT_STEP', tool: 'get_current_step' },
  },
  {
    intent: 'PAUSE',
    test: (t) => /\b(pause|take a break|hold on|wait a (sec|second|minute)|break time)\b/.test(t),
    match: { intent: 'PAUSE', tool: 'pause_cooking_session' },
  },
  {
    intent: 'RESUME',
    test: (t) => /\b(resume|unpause|keep cooking|let'?s continue|lets continue|carry on|continue cooking|pick (back )?up where)\b/.test(t),
    match: { intent: 'RESUME', tool: 'resume_cooking_session' },
  },
  {
    intent: 'SUBSTITUTE',
    test: (t) => /\b(don'?t have|do not have|out of |what can i use instead|substitute|replacement|instead of|ran out|all out)\b/.test(t),
    match: { intent: 'SUBSTITUTE', needsFollowUp: 'What are you out of? I can find you a substitute.' },
  },
  {
    intent: 'NEXT',
    test: (t) => /\b(i'?m done|done|next|continue|move on|keep going|ok(ay)? next|all done|finished that)\b/.test(t),
    match: { intent: 'NEXT', tool: 'complete_current_step' },
  },
  {
    intent: 'REPEAT',
    test: (t) => /\b(repeat|say that again|say again|what was that|come again|one more time)\b/.test(t),
    match: { intent: 'REPEAT', tool: 'repeat_current_step' },
  },
  {
    intent: 'PREVIOUS',
    test: (t) => /\b(go back|previous|back up|step back|backstep|one step back)\b/.test(t),
    match: { intent: 'PREVIOUS', tool: 'previous_step' },
  },
  {
    intent: 'STOP',
    test: (t) => /\b(stop|end session|end cooking|quit|i'?m done cooking|finished cooking|that'?s all)\b/.test(t),
    match: { intent: 'STOP', tool: 'end_cooking_session', arguments: { completed: false } },
  },
  {
    intent: 'CONFIRM',
    test: (t) => {
      const words = t.split(/\s+/).filter(Boolean);
      return words.length <= 5 && CONFIRM_RE.test(t);
    },
    match: { intent: 'CONFIRM', tool: 'confirm_available_ingredients', fallbackTool: 'complete_current_step' },
  },
  {
    intent: 'HELP',
    test: (t) => /\b(help|what can i say|what can you do|commands|how do i use this)\b/.test(t),
    match: { intent: 'HELP' },
  },
];

/**
 * Match a natural utterance against the command table.
 * Returns null when no command applies (→ ingredient extraction / provider).
 */
export function matchCommand(utterance: string): CommandMatch | null {
  const text = normalizeUtterance(utterance);
  if (!text) return null;
  for (const rule of RULES) {
    if (rule.test(text)) return { ...rule.match };
  }
  return null;
}

export const HELP_TEXT = [
  'Here is what I can do:',
  '- say "done" or "next" to move on',
  '- "repeat that" to hear a step again',
  '- "go back" for the previous step',
  '- "pause" / "resume" anytime',
  '- "how much time is left?" for timers',
  '- "I don\'t have X, what can I use instead?" for substitutions',
  '- "stop" to end the session',
].join('\n');