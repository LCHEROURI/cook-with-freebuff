// ─────────────────────────────────────────────────────────────────────────────
// Conversational agent — types
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../server/tools/types';

/** Persistent UI indicator states (K5 spec). */
export type VoiceStatus =
  | 'LISTENING'
  | 'THINKING'
  | 'SPEAKING'
  | 'OFFLINE'
  | 'ERROR';

/** Pure status-machine events. */
export type VoiceEvent =
  | 'USER_SPEAKING'
  | 'UTTERANCE_SENT'
  | 'AGENT_RESPONSE'
  | 'AGENT_FINISHED'
  | 'ERROR'
  | 'DISCONNECTED'
  | 'RECONNECTED';

export interface ExecutedToolCall {
  tool: string;
  arguments: Record<string, unknown>;
  result: ToolResult;
}

/** One complete user→agent exchange. */
export interface AgentTurn {
  utterance: string;
  response: string;
  toolCalls: ExecutedToolCall[];
  status: VoiceStatus;
}

/** Structured context passed to the conversation provider. */
export interface AgentConversationContext {
  currentPhase?: string;
  currentStep?: string;
  activeTimerIds?: string[];
  recipeSummary?: string;
  recentEvents?: string[];
}
