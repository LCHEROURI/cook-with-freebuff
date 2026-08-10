// ─────────────────────────────────────────────────────────────────────────────
// Secure agent tool layer — types
//
// Tools are the only way the conversational model interacts with application
// state. Each tool validates parameters, executes backend logic, persists, and
// returns a structured result envelope. The model never touches the database.
// ─────────────────────────────────────────────────────────────────────────────

import type { z } from 'zod';
import type {
  CookingTimer,
  Recipe,
  AgentToolLog,
} from '../../domain/types';
import type { SessionService } from '../session-service';

// ── Result envelope ──────────────────────────────────────────────────────────

export interface ToolError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: ToolError;
}

export function ok<T>(data: T): ToolResult<T> {
  return { success: true, data };
}

export function fail(code: string, message: string, recoverable: boolean): ToolResult {
  return { success: false, error: { code, message, recoverable } };
}

/**
 * Convert an unknown thrown value into a structured ToolResult.
 * Recognizes SessionError-style errors ({ code, message, recoverable });
 * everything else becomes a recoverable INTERNAL_ERROR.
 */
export function toToolError(e: unknown): ToolResult {
  if (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    typeof (e as { code: unknown }).code === 'string' &&
    'message' in e &&
    typeof (e as { message: unknown }).message === 'string' &&
    'recoverable' in e
  ) {
    const err = e as { code: string; message: string; recoverable: boolean };
    return fail(err.code, err.message, err.recoverable);
  }
  return fail('INTERNAL_ERROR', e instanceof Error ? e.message : String(e), true);
}

// ── Stores (abstracted for testability) ──────────────────────────────────────

export interface TimerStore {
  createTimer(timer: CookingTimer): Promise<void>;
  getTimer(id: string): Promise<CookingTimer | null>;
  updateTimer(id: string, partial: Partial<CookingTimer>): Promise<void>;
  listActiveTimers(sessionId: string): Promise<CookingTimer[]>;
}

export interface LogStore {
  createLog(log: AgentToolLog): Promise<void>;
}

export interface RecipeStore {
  createRecipe(recipe: Recipe): Promise<void>;
  getRecipe(id: string): Promise<Recipe | null>;
  /** Persist an updated recipe (e.g. after an ingredient substitution). */
  updateRecipe(recipe: Recipe): Promise<void>;
}

// ── Tool context ─────────────────────────────────────────────────────────────

export interface ToolContext {
  /** Authenticated Firebase uid — resolved by the API layer, never client-supplied. */
  userId: string;
  correlationId?: string;
  sessionService: SessionService;
  timerStore: TimerStore;
  logStore: LogStore;
  recipeStore?: RecipeStore;
}

// ── Tool definition ──────────────────────────────────────────────────────────

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> {
  name: string;
  description: string;
  inputSchema: S;
  handler: (ctx: ToolContext, args: z.infer<S>) => Promise<ToolResult<O>>;
  /** Optional: project args to the safe fields written to agent_tool_logs. */
  sanitizeArgs?: (args: z.infer<S>) => Record<string, unknown>;
}