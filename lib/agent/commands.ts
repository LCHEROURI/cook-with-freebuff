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
  | 'USE_SUBSTITUTE'
  | 'CORRECT'
  | 'CONFIRM'
  | 'COOK'
  | 'PANTRY_ADD'
  | 'PANTRY_GET'
  | 'PANTRY_REMOVE'
  | 'HELP';

export interface CommandMatch {
  intent: AgentIntent;
  /** The tool the orchestrator should call (undefined → follow-up only). */
  tool?: string;
  arguments?: Record<string, unknown>;
  /** Fallback tool when the primary fails with a recoverable error. */
  fallbackTool?: string;
  /**
   * Fallback chain walked in order when the primary (and prior fallbacks)
   * fail with a recoverable error. Used by CONFIRM: pending pantry items →
   * available ingredients → complete current step.
   */
  fallbackTools?: string[];
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
    test: (t) => /\b(don'?t have|do not have|out of |ran out|all out|no more|substitute|replacement|instead of|what can i use|can i use)\b/.test(t),
    match: { intent: 'SUBSTITUTE' },
  },
  {
    intent: 'CORRECT',
    test: (t) =>
      /\b(i said|i meant)\b/.test(t) ||
      /^(no|nope|actually|wait)[,.!\s]+(?:i said|i meant|it'?s|it is|make that|change)/i.test(t),
    match: { intent: 'CORRECT' },
  },
  {
    intent: 'USE_SUBSTITUTE',
    test: (t) => /^(?:use|go with|i'?ll use|swap in|substitute with|let'?s use|ok(?:ay)? use)\s+/.test(t),
    match: { intent: 'USE_SUBSTITUTE' },
  },
  {
    intent: 'COOK',
    test: (t) => /\b(cook with me|let'?s cook|lets cook|start cooking|begin cooking|start the recipe|i want to cook|start cooking now)\b/.test(t),
    match: { intent: 'COOK', tool: 'cook_with_me' },
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
    // "yes" acknowledges whatever is pending, in priority order: pantry items
    // the user just offered → collected ingredients → nothing (advance step).
    match: {
      intent: 'CONFIRM',
      tool: 'confirm_pending_pantry_items',
      fallbackTools: ['confirm_available_ingredients', 'complete_current_step'],
    },
  },
  {
    intent: 'PANTRY_ADD',
    test: (t) =>
      /\b(?:i always have|we always have|i always keep|add .* to (?:my )?pantry|put .* in (?:my )?pantry)\b/.test(t) ||
      /^\s*add\b.*\b(?:to (?:my )?pantry|to the pantry)$/.test(t),
    match: { intent: 'PANTRY_ADD' },
  },
  {
    intent: 'PANTRY_GET',
    test: (t) => /\b(what(?:'s| is) in (?:my |the )?pantry|what do i have|what(?:'s| is) in stock|do i (?:still )?have|do you have any)\b/.test(t),
    match: { intent: 'PANTRY_GET' },
  },
  {
    intent: 'PANTRY_REMOVE',
    test: (t) => /\b(remove .* from (?:my |the )?pantry|take .* out of (?:my |the )?pantry|delete .* from (?:my |the )?pantry)\b/.test(t),
    match: { intent: 'PANTRY_REMOVE' },
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
/** Quantity words for correction parsing ("No, I said two tomatoes"). */
const QUANTITY_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5, couple: 2,
};

/**
 * "I always have olive oil, salt and black pepper" → ['olive oil', 'salt',
 * 'black pepper']. "add flour to my pantry" → ['flour']. Returns null when
 * nothing listable follows the trigger phrase.
 */
export function parsePantryAdd(text: string): string[] | null {
  const m = text.match(/\b(?:always )?(?:have|keep|stock)\b\s+(.+)$/) ?? text.match(/^\s*(?:add|put)\s+(.+?)\s+(?:to|in)\s+(?:my |the )?pantry$/);
  if (!m) return null;
  let clause = m[1].replace(/[.!?]+$/, '').trim();
  if (!clause) return null;
  const items = clause
    .split(/\s*(?:,|and)\s+/)
    .map((s) => s.replace(/^(?:some|any|a|an|the|a bit of|plenty of|lots of|a few|fresh|dried)\s+/, '').trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

/** "do I have garlic" → 'garlic'; "what's in my pantry" → null (list all). */
export function parsePantryQuery(text: string): string | null {
  const m = text.match(/\bdo i (?:still )?have\s+(.+)$/);
  if (!m) return null;
  const name = m[1].replace(/[.!?]+$/, '').trim();
  return name.length > 0 ? name : null;
}

/** "remove olive oil from my pantry" → 'olive oil'. */
export function parsePantryRemove(text: string): string | null {
  const m = text.match(/\b(?:remove|take|delete)\s+(.+?)\s+(?:from|out of)\s+(?:my |the )?pantry$/);
  if (!m) return null;
  const name = m[1].replace(/[.!?]+$/, '').trim();
  return name.length > 0 ? name : null;
}

/** "I don't have garlic" / "I'm out of milk" → "garlic" / "milk". */
export function parseSubstituteIngredient(text: string): string | null {
  // Stop at secondary clauses so "I don't have garlic, what can I use?"
  // parses to "garlic", not the whole sentence.
  const clause = text.split(/\b(?:what can i use|do you have any|is there|give me an idea)\b/)[0];
  const m = clause.match(/(?:don'?t have|do not have|out of|ran out|all out of|no more|instead of)\s+(.+)$/);
  if (!m) return null;
  let ingredient = m[1].trim().replace(/[,.!?]+$/, '').trim();
  ingredient = ingredient.replace(/^(?:the|a|an|some|any|my|fresh|dried|a bit of)\s+/, '').trim();
  return ingredient.length > 0 ? ingredient : null;
}

/**
 * "No, I said two tomatoes" → { name: 'tomatoes', quantity: 2 }.
 * "I meant chicken thighs" → { name: 'chicken thighs' }.
 */
export function parseCorrection(text: string): { name: string; quantity?: number } | null {
  const m = text.match(/\b(i said|i meant)\s+(.+)$/);
  if (!m) return null;
  let clause = m[2].replace(/[.!?]+$/, '').trim();
  clause = clause.replace(/^(?:it|it'?s|that|that'?s)\s+/, '');
  // Drop "not X" clauses: "chicken thighs, not chicken breast" → "chicken thighs".
  clause = clause.split(/\s*,\s*(?:not|nor)\b|\s+(?:not|nor)\s+/)[0].trim();

  let quantity: number | undefined;
  const num = clause.match(/^(\d+(?:\.\d+)?)\b/);
  const word = clause.match(/^([a-z]+(?:\s+and\s+a\s+half)?)\b/);
  if (num) {
    quantity = Number(num[1]);
    clause = clause.slice(num[0].length);
  } else if (word) {
    const direct = QUANTITY_WORDS[word[1]];
    if (direct !== undefined) {
      quantity = direct;
      clause = clause.slice(word[0].length);
    } else if (word[1].includes('and a half')) {
      const base = QUANTITY_WORDS[word[1].split(' and ')[0]];
      if (base !== undefined) {
        quantity = base + 0.5;
        clause = clause.slice(word[0].length);
      }
    }
  }

  clause = clause.replace(/^(?:of|the|a|an)\s+/, '').trim();
  if (!clause) return null;
  const result: { name: string; quantity?: number } = { name: clause };
  if (quantity !== undefined) result.quantity = quantity;
  return result;
}

export function matchCommand(utterance: string): CommandMatch | null {
  const text = normalizeUtterance(utterance);
  if (!text) return null;
  for (const rule of RULES) {
    if (!rule.test(text)) continue;

    // Dynamic argument extraction for substitution / correction.
    if (rule.intent === 'SUBSTITUTE') {
      const ingredient = parseSubstituteIngredient(text);
      if (ingredient) {
        return { intent: 'SUBSTITUTE', tool: 'request_substitution', arguments: { unavailableIngredient: ingredient } };
      }
      return { intent: 'SUBSTITUTE', needsFollowUp: 'What are you out of? I can find you a substitute.' };
    }
    if (rule.intent === 'CORRECT') {
      const correction = parseCorrection(text);
      if (correction) {
        return { intent: 'CORRECT', tool: 'correct_ingredient', arguments: correction };
      }
      return { intent: 'CORRECT', needsFollowUp: 'What should I change?' };
    }
    if (rule.intent === 'USE_SUBSTITUTE') {
      const m = text.match(/^(?:use|go with|i'?ll use|swap in|substitute with|let'?s use|ok(?:ay)? use)\s+(.+)$/);
      const replacement = m ? m[1].replace(/\s+instead$/, '').replace(/[.!?]+$/, '').trim() : null;
      if (replacement) {
        return { intent: 'USE_SUBSTITUTE', tool: 'apply_substitution', arguments: { replacement } };
      }
      return { intent: 'USE_SUBSTITUTE', needsFollowUp: 'Which substitute should I use?' };
    }
    if (rule.intent === 'PANTRY_ADD') {
      const names = parsePantryAdd(text);
      if (names) {
        return { intent: 'PANTRY_ADD', arguments: { names } };
      }
      return { intent: 'PANTRY_ADD', needsFollowUp: 'What would you like me to remember in your pantry?' };
    }
    if (rule.intent === 'PANTRY_GET') {
      return { intent: 'PANTRY_GET', tool: 'get_pantry', arguments: { name: parsePantryQuery(text) ?? undefined } };
    }
    if (rule.intent === 'PANTRY_REMOVE') {
      const name = parsePantryRemove(text);
      if (name) {
        return { intent: 'PANTRY_REMOVE', tool: 'remove_pantry_item', arguments: { name } };
      }
      return { intent: 'PANTRY_REMOVE', needsFollowUp: 'Which item should I remove from your pantry?' };
    }

    return { ...rule.match };
  }
  return null;
}

export const HELP_TEXT = [
  'Here is what I can do:',
  '- say "done" or "next" to move on',
  '- "repeat that" to hear a step again',
  '- "go back" for the previous step',
  '- "cook with me" to start guided cooking',
  '- "pause" / "resume" anytime',
  '- "how much time is left?" for timers',
  '- "I don\'t have X, what can I use instead?" for substitutions',
  '- "I always have olive oil, salt and pepper" to remember your pantry',
  '- "what\'s in my pantry?" / "remove X from my pantry"',
  '- "stop" to end the session',
].join('\n');