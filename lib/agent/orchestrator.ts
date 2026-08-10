// ─────────────────────────────────────────────────────────────────────────────
// Conversation orchestrator
//
// The agent brain. For each utterance it:
//   1. routes deterministic commands to backend tools (short-circuit)
//   2. extracts structured ingredients from brain-dumps and persists them
//   3. falls back to the conversation provider for free-form turns
//   4. always answers with concise spoken responses and never claims success
//      unless the backend tool confirmed it
// ─────────────────────────────────────────────────────────────────────────────

import { matchCommand, HELP_TEXT, type CommandMatch } from './commands';
import { extractIngredients } from './extract';
import type { AgentTurn, ExecutedToolCall } from './types';
import { ToolRegistry, executeTool } from '../server/tools/registry';
import type { ToolContext } from '../server/tools/types';
import type { ConversationAgent } from '../ai/provider';
import type { Ingredient } from '../domain/types';

export interface OrchestratorOptions {
  registry: ToolRegistry;
  context: ToolContext;
  /** Optional free-form conversation provider (Gemini function calling). */
  provider?: ConversationAgent;
}

export class ConversationOrchestrator {
  constructor(private readonly opts: OrchestratorOptions) {}

  async process(utterance: string, sessionId?: string): Promise<AgentTurn> {
    const turn: AgentTurn = {
      utterance,
      response: '',
      toolCalls: [],
      status: 'THINKING',
    };

    // 1. Deterministic command routing.
    const command = matchCommand(utterance);
    if (command) {
      turn.response = await this.handleCommand(command, sessionId, turn);
      turn.status = 'SPEAKING';
      return turn;
    }

    // 2. Ingredient brain-dump.
    const ingredients = extractIngredients(utterance);
    if (ingredients.length > 0) {
      turn.response = await this.handleIngredients(ingredients, sessionId, turn);
      turn.status = 'SPEAKING';
      return turn;
    }

    // 3. Free-form conversation via the provider (tool calls executed here).
    if (this.opts.provider) {
      turn.response = await this.handleProvider(utterance, sessionId, turn);
      turn.status = 'SPEAKING';
      return turn;
    }

    // 4. No provider — honest fallback.
    turn.response = HELP_TEXT;
    turn.status = 'SPEAKING';
    return turn;
  }

  // ── Command handling ────────────────────────────────────────────────────────

  private async handleCommand(
    command: CommandMatch,
    sessionId: string | undefined,
    turn: AgentTurn,
  ): Promise<string> {
    // Follow-up-only intents (substitution) ask before acting.
    if (command.needsFollowUp) {
      return command.needsFollowUp;
    }
    if (command.intent === 'PANTRY_ADD') {
      // Multiple items per turn — one add_pantry_item call each.
      return this.handlePantryAdd(command.arguments?.names, sessionId, turn);
    }
    if (!command.tool) {
      // HELP
      return HELP_TEXT;
    }

    let result = await this.runTool(command.tool, command.arguments ?? {}, sessionId, turn);

    // CONFIRM walks a fallback chain in priority order: pantry items just
    // offered → collected ingredients → (nothing pending) advance the step.
    if (!result.result.success && command.intent === 'CONFIRM') {
      const chain = command.fallbackTool
        ? [command.fallbackTool, ...(command.fallbackTools ?? [])]
        : (command.fallbackTools ?? []);
      for (const fallback of chain) {
        if (result.result.success) break;
        result = await this.runTool(fallback, {}, sessionId, turn);
      }
    }

    return this.responseForIntent(command.intent, result.result);
  }

  private async runTool(
    tool: string,
    args: Record<string, unknown>,
    sessionId: string | undefined,
    turn: AgentTurn,
  ): Promise<ExecutedToolCall> {
    const call: ExecutedToolCall = {
      tool,
      arguments: args,
      result: await executeTool(this.opts.registry, this.opts.context, tool, args),
    };
    turn.toolCalls.push(call);
    return call;
  }

  // ── Pantry handling (K8) ────────────────────────────────────────────────────

  /** "I always have X, Y and Z" → add each, then ask for confirmation. */
  private async handlePantryAdd(
    names: unknown,
    sessionId: string | undefined,
    turn: AgentTurn,
  ): Promise<string> {
    const items = Array.isArray(names) ? (names as string[]) : [];
    if (items.length === 0) {
      return 'What would you like me to remember in your pantry?';
    }
    let sid = sessionId;
    if (!sid) {
      const started = await this.runTool('start_cooking_session', {}, sid, turn);
      if (started.result.success) {
        sid = (started.result.data as { sessionId: string }).sessionId;
      }
      // No session is fine — pantry adds still persist (no pending list).
    }
    for (const name of items) {
      await this.runTool('add_pantry_item', { name, sessionId: sid }, sid, turn);
    }
    const last = turn.toolCalls[turn.toolCalls.length - 1];
    if (!last.result.success) {
      return `Sorry, I could not add those to your pantry: ${this.errorMessage(last.result)}`;
    }
    const list = items.join(', ');
    return `Got it — I have added ${list} to your pantry. Say "yes" to confirm, or tell me what to fix.`;
  }

  // ── Ingredient handling ─────────────────────────────────────────────────────

  private async handleIngredients(
    ingredients: Ingredient[],
    sessionId: string | undefined,
    turn: AgentTurn,
  ): Promise<string> {
    let sid = sessionId;
    if (!sid) {
      const started = await this.runTool('start_cooking_session', {}, sid, turn);
      if (started.result.success) {
        sid = (started.result.data as { sessionId: string }).sessionId;
      } else {
        return `I could not start a cooking session: ${this.errorMessage(started.result)}`;
      }
    }

    const saved = await this.runTool('update_available_ingredients', { sessionId: sid, ingredients }, sid, turn);
    if (!saved.result.success) {
      return `Sorry, I could not save those ingredients: ${this.errorMessage(saved.result)}`;
    }

    return `${this.summarizeIngredients(ingredients)} Is that right? Say "yes" to confirm, or tell me what to fix.`;
  }

  private summarizeIngredients(ingredients: Ingredient[]): string {
    const parts = ingredients.map((ing) => {
      const qty = ing.quantity === null ? '' : ing.quantity;
      const unit = ing.unit ?? '';
      const head = [qty, unit].filter(Boolean).join(' ');
      return head ? `${head} ${ing.name}` : ing.name;
    });
    if (parts.length === 1) return `I heard: ${parts[0]}.`;
    return `I heard: ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`;
  }

  // ── Provider handling ───────────────────────────────────────────────────────

  private async handleProvider(
    utterance: string,
    sessionId: string | undefined,
    turn: AgentTurn,
  ): Promise<string> {
    const provider = this.opts.provider!;
    const context = await this.buildContext(sessionId);

    let agentResponse;
    try {
      agentResponse = await provider.process({
        userId: this.opts.context.userId,
        sessionId,
        utterance,
        context,
      });
    } catch {
      return 'I had trouble with that. Please try again.';
    }

    const calls = agentResponse.toolCalls ?? [];
    for (const call of calls) {
      await this.runTool(call.tool, call.arguments, sessionId, turn);
    }

    // No false success: if the provider claimed an action, confirm it happened.
    if (calls.length > 0 && !agentResponse.message) {
      const allOk = turn.toolCalls.every((c) => c.result.success);
      return allOk
        ? 'Done — that is confirmed.'
        : `Sorry, that did not work: ${this.errorMessage(turn.toolCalls[turn.toolCalls.length - 1].result)}`;
    }

    return agentResponse.message || HELP_TEXT;
  }

  private async buildContext(sessionId: string | undefined) {
    if (!sessionId) return {};
    const session = await this.opts.context.sessionService.getSession(sessionId);
    if (!session) return {};
    return {
      currentPhase: session.currentPhase,
      currentStep:
        session.currentPhase === 'PREP_GUIDANCE'
          ? `prep step ${session.currentPrepStepIndex + 1}`
          : session.currentPhase === 'COOKING_GUIDANCE'
            ? `cooking step ${session.currentCookingStepIndex + 1}`
            : undefined,
      activeTimerIds: session.activeTimerIds,
    };
  }

  // ── Response composition ────────────────────────────────────────────────────

  private responseForIntent(
    intent: string,
    result: { success: boolean; data?: unknown; error?: { message?: string } },
  ): string {
    if (!result.success) {
      return `Sorry, that did not work: ${result.error?.message ?? 'unknown error'}`;
    }
    const d = result.data as
      | {
          instruction?: string;
          timerStarted?: { label: string };
          timers?: unknown[];
          unavailableIngredient?: string;
          candidates?: { ingredient: string; ratio: string }[];
          regenerating?: boolean;
          from?: string;
          to?: string;
          safetyGate?: { note: string };
          items?: { id: string; name: string; stale: boolean }[];
          stale?: string[];
          query?: string | null;
          removed?: { name: string };
          confirmed?: { name: string }[];
        }
      | undefined;
    switch (intent) {
      case 'COOK':
        return d?.instruction ? `Let's cook! ${d.instruction}` : "Let's cook!";
      case 'NEXT':
        // A safety note gates the step — ask for explicit confirmation before
        // the step is completed (a second "done" acknowledges the gate).
        if (d?.safetyGate) {
          return `Before you continue: ${d.safetyGate.note}. Say "done" to confirm you understand.`;
        }
        if (d?.timerStarted) return `Done. I've started a ${d.timerStarted.label}.`;
        if (d?.instruction) return `Done — next: ${d.instruction}`;
        return 'Done — moving to the next step.';
      case 'REPEAT':
        return d?.instruction ? `Here it is again: ${d.instruction}` : 'Repeating that step for you.';
      case 'PREVIOUS':
        return d?.instruction ? `Going back: ${d.instruction}` : 'Going back one step.';
      case 'PAUSE':
        return 'Paused. Say "resume" when you are ready.';
      case 'RESUME':
        return d?.instruction ? `Resumed — ${d.instruction}` : 'Resumed — back to it.';
      case 'STOP':
        return 'Stopping the session. Great cooking!';
      case 'SUBSTITUTE': {
        const ingredient = d?.unavailableIngredient;
        const candidates = d?.candidates ?? [];
        if (candidates.length === 0) {
          return ingredient
            ? `I could not find a substitute for ${ingredient}. Tell me what else you have.`
            : 'What are you out of? I can find you a substitute.';
        }
        const list = candidates.map((c) => `${c.ingredient} (${c.ratio})`).join(', ');
        return `You are out of ${ingredient}. Try ${list}. Say "use X" to confirm.`;
      }
      case 'USE_SUBSTITUTE':
        return d?.from && d?.to
          ? `Done — using ${d.to} instead of ${d.from}.`
          : 'Done — substitution applied.';
      case 'CORRECT':
        return d?.regenerating
          ? 'Got it — that changes the recipe, so I will rework it. Tell me what you have and I will start over.'
          : 'Got it — I have updated that.';
      case 'CONFIRM': {
        const confirmed = d?.confirmed;
        if (confirmed && confirmed.length > 0) {
          const list = confirmed.map((c) => c.name).join(', ');
          return `Confirmed — I have saved ${list} to your pantry.`;
        }
        return 'Confirmed — moving on.';
      }
      case 'PANTRY_GET': {
        const items = d?.items ?? [];
        const stale = d?.stale ?? [];
        if (items.length === 0) {
          return d?.query
            ? `You do not have ${d.query} in your pantry.`
            : 'Your pantry is empty. Tell me what you have and I will remember it.';
        }
        const names = items.map((i) => i.name);
        let out =
          names.length === 1
            ? `You have ${names[0]}.`
            : `You have ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}.`;
        if (stale.length > 0) {
          out += ` Some of those are older than 30 days — say "yes" if you still have them.`;
        }
        return out;
      }
      case 'PANTRY_REMOVE':
        return d?.removed
          ? `Done — removed ${d.removed.name} from your pantry.`
          : 'Done — removed from your pantry.';
      case 'TIMER_STATUS': {
        const timers = d?.timers ?? [];
        return timers.length === 0
          ? 'You have no running timers.'
          : timers.length === 1
            ? 'You have one timer running.'
            : `You have ${timers.length} timers running.`;
      }
      case 'CURRENT_STEP':
        return d?.instruction ?? 'Here is your current step.';
      default:
        return 'Done.';
    }
  }

  private errorMessage(result: { error?: { message?: string } }): string {
    return result.error?.message ?? 'unknown error';
  }
}