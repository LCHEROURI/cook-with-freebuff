// ─────────────────────────────────────────────────────────────────────────────
// Gemini conversation agent (function calling)
//
// The conversational model proposes tool calls; the backend (orchestrator +
// tool registry) executes them. The model never manipulates state directly.
// Spoken responses stay brief — no full recipe dumps.
// ─────────────────────────────────────────────────────────────────────────────

import type { FunctionDeclaration } from '@google/generative-ai';
import { getGeminiModel, type GeminiOptions } from './gemini';
import type { ConversationAgent, ConversationContext, ToolCall } from './provider';

export function createGeminiConversationAgent(opts: GeminiOptions = {}): ConversationAgent {
  return {
    async process(params: {
      userId: string;
      sessionId?: string;
      utterance: string;
      context: ConversationContext;
    }): Promise<{ message: string; toolCalls?: ToolCall[]; shouldSpeak: boolean }> {
      const model = getGeminiModel(opts, opts.generationModel ?? process.env.CONVERSATION_MODEL);
      if (!model) {
        throw new Error('GOOGLE_AI_API_KEY is not configured for conversation');
      }

      // Gemini's SchemaType is a nominal string enum, so the literal `as const`
      // declaration is asserted once here, at the SDK boundary.
      const chat = model.startChat({
        history: [],
        tools: [{ functionDeclarations: TOOL_DECLARATIONS as unknown as FunctionDeclaration[] }],
      });

      const prompt = buildConversationPrompt(params);
      const result = await chat.sendMessage(prompt);
      const response = result.response;

      const text = response.text().trim();
      const functionCalls = response.functionCalls() ?? [];

      return {
        message: text || defaultMessage(functionCalls),
        toolCalls: functionCalls.map((fc) => ({
          tool: fc.name,
          arguments: (fc.args as Record<string, unknown>) ?? {},
        })),
        shouldSpeak: true,
      };
    },
  };
}

function defaultMessage(calls: { name: string }[]): string {
  return calls.length > 0 ? 'On it — just a moment.' : 'Go on.';
}

function buildConversationPrompt(params: {
  userId: string;
  sessionId?: string;
  utterance: string;
  context: ConversationContext;
}): string {
  const { sessionId, utterance, context } = params;
  return [
    'You are the Kitchen Agent — a concise, hands-free cooking companion.',
    '',
    'Rules:',
    '- The backend is the source of truth. Never claim an action succeeded unless a tool result confirmed it.',
    '- Choose tools for actions. Never describe state changes you did not perform.',
    '- Respond briefly and conversationally. Never read out full ingredient lists or whole recipes.',
    '- For ingredient brain-dumps use update_available_ingredients, then summarize what you heard and ask for confirmation.',
    '- During cooking, guide ONE action at a time. On "done"/"next" call complete_current_step.',
    '',
    `Session: ${sessionId ?? 'none'}`,
    context.currentPhase ? `Current phase: ${context.currentPhase}` : '',
    context.currentStep ? `Current step: ${context.currentStep}` : '',
    context.activeTimerIds?.length ? `Active timers: ${context.activeTimerIds.join(', ')}` : '',
    '',
    `User: ${utterance}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ── Tool declarations (Gemini function calling schemas) ──────────────────────

const stringArray = { type: 'array', items: { type: 'string' } } as const;

const INGREDIENT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    quantity: { type: ['number', 'null'], description: 'null when unknown — never invent' },
    unit: { type: ['string', 'null'] },
    preparation: { type: 'string' },
    condition: { type: 'string' },
    optional: { type: 'boolean' },
  },
  required: ['name', 'quantity', 'unit'],
} as const;

const TOOL_DECLARATIONS = [
  {
    name: 'start_cooking_session',
    description: 'Start a new cooking session.',
    parameters: { type: 'object', properties: { recipeId: { type: 'string' } } },
  },
  {
    name: 'save_available_ingredients',
    description: 'Replace the session ingredient list.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        ingredients: { type: 'array', items: INGREDIENT_SCHEMA },
      },
    },
  },
  {
    name: 'update_available_ingredients',
    description: 'Merge ingredients into the session list.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        ingredients: { type: 'array', items: INGREDIENT_SCHEMA },
      },
    },
  },
  {
    name: 'confirm_available_ingredients',
    description: 'Confirm the collected ingredient list.',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } } },
  },
  {
    name: 'generate_recipe',
    description: 'Generate a structured recipe from a request.',
    parameters: {
      type: 'object',
      properties: {
        request: {
          type: 'object',
          properties: {
            ingredientsAvailable: { type: 'array', items: INGREDIENT_SCHEMA },
            servings: { type: 'number' },
            maxTimeMinutes: { type: 'number' },
            dietaryRestrictions: stringArray,
            allergies: stringArray,
            cuisinePreferences: stringArray,
            dislikedIngredients: stringArray,
            availableEquipment: stringArray,
          },
        },
      },
    },
  },
  {
    name: 'validate_recipe',
    description: 'Validate a recipe against the full check list.',
    parameters: { type: 'object', properties: { recipe: { type: 'object' } } },
  },
  {
    name: 'get_cooking_session',
    description: 'Get the current cooking session.',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } } },
  },
  {
    name: 'get_current_step',
    description: 'Get the current prep or cooking step.',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } } },
  },
  {
    name: 'complete_current_step',
    description: 'Advance to the next step after the user says done.',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } } },
  },
  {
    name: 'repeat_current_step',
    description: 'Repeat the current step.',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } } },
  },
  {
    name: 'previous_step',
    description: 'Go back one step.',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } } },
  },
  {
    name: 'pause_cooking_session',
    description: 'Pause the session.',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } } },
  },
  {
    name: 'resume_cooking_session',
    description: 'Resume the session.',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } } },
  },
  {
    name: 'end_cooking_session',
    description: 'End the session.',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' }, completed: { type: 'boolean' } } },
  },
  {
    name: 'start_timer',
    description: 'Start a backend-tracked timer.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        label: { type: 'string' },
        durationSeconds: { type: 'number' },
        stepId: { type: 'string' },
      },
      required: ['label', 'durationSeconds'],
    },
  },
  {
    name: 'get_active_timers',
    description: 'List running timers.',
    parameters: { type: 'object', properties: { sessionId: { type: 'string' } } },
  },
  {
    name: 'cancel_timer',
    description: 'Cancel a timer.',
    parameters: { type: 'object', properties: { timerId: { type: 'string' } }, required: ['timerId'] },
  },
  {
    name: 'find_substitution',
    description: 'Find substitutes for an unavailable ingredient.',
    parameters: {
      type: 'object',
      properties: {
        unavailableIngredient: { type: 'string' },
        recipe: { type: 'object' },
        availablePantry: stringArray,
      },
    },
  },
  {
    name: 'replace_ingredient',
    description: 'Replace an ingredient throughout the recipe.',
    parameters: {
      type: 'object',
      properties: { recipe: { type: 'object' }, from: { type: 'string' }, to: { type: 'string' } },
    },
  },
  {
    name: 'resize_recipe',
    description: 'Scale a recipe to new servings.',
    parameters: {
      type: 'object',
      properties: { recipe: { type: 'object' }, servings: { type: 'number' } },
    },
  },
] as const;