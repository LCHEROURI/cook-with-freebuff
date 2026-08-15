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
import { TOOL_DECLARATIONS, LIVE_SYSTEM_INSTRUCTION } from './tool-declarations';
import { MODEL_ROLE_CONFIG } from './model-roles';

// Single source of truth for the model-visible tool surface (SDK-free module,
// shared with the Gemini Live client).
export { TOOL_DECLARATIONS };

export function createGeminiConversationAgent(opts: GeminiOptions = {}): ConversationAgent {
  return {
    async process(params: {
      userId: string;
      sessionId?: string;
      utterance: string;
      context: ConversationContext;
    }): Promise<{ message: string; toolCalls?: ToolCall[]; shouldSpeak: boolean }> {
      const cfg = MODEL_ROLE_CONFIG.conversation;
      const model = getGeminiModel(
        opts,
        opts.generationModel ?? (await opts.resolveModel?.('conversation')) ?? process.env[cfg.envVar] ?? cfg.defaultModel,
      );
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
    LIVE_SYSTEM_INSTRUCTION,
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
