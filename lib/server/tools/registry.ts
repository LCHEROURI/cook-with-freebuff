// ─────────────────────────────────────────────────────────────────────────────
// Tool registry + executor
//
// executeTool is the single entry point for every agent tool call. It:
//   1. resolves the tool definition
//   2. validates parameters against the tool's zod schema
//   3. executes the handler (which performs backend logic + persistence)
//   4. sanitizes arguments for the audit log (never logs secrets)
//   5. records an agent_tool_log with result + latency
//   6. returns the structured result envelope
// ─────────────────────────────────────────────────────────────────────────────

import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  TimerStore,
  LogStore,
  RecipeStore,
  PantryStore,
  DietaryProfileStore,
  LeftoverStore,
  GroceryStore,
} from './types';
import { fail } from './types';
import type {
  AgentToolLog,
  CookingTimer,
  Recipe,
  PantryItem,
  DietaryProfile,
  Leftover,
  GroceryItem,
} from '../../domain/types';

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}

// ── Secret-aware default sanitizer ───────────────────────────────────────────

const SECRET_KEY_RE = /(token|secret|key|password|credential|api[_-]?key)/i;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/**
 * Deep-clone args for logging, dropping any key that looks like a secret.
 * Also truncates very long strings so logs stay bounded.
 */
export function defaultSanitize(args: unknown): Record<string, unknown> {
  const MAX_STRING = 500;

  function scrub(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (isSecretKey(k)) continue;
        out[k] = scrub(v);
      }
      return out;
    }
    if (typeof value === 'string' && value.length > MAX_STRING) {
      return value.slice(0, MAX_STRING) + '…';
    }
    return value;
  }

  return scrub(args) as Record<string, unknown>;
}

function newId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 20; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  return id;
}

/**
 * Execute a tool: validate → run → log → envelope.
 * Never throws — all failures are returned as structured results.
 */
export async function executeTool(
  registry: ToolRegistry,
  ctx: ToolContext,
  name: string,
  rawArgs: unknown,
): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) {
    return fail('UNKNOWN_TOOL', `Unknown tool: ${name}`, false);
  }

  const parsed = tool.inputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return fail('INVALID_ARGUMENTS', `Invalid arguments: ${issues}`, false);
  }

  const startedAt = Date.now();
  let result: ToolResult;

  try {
    result = await tool.handler(ctx, parsed.data);
  } catch (err) {
    result = fail(
      'INTERNAL_ERROR',
      err instanceof Error ? err.message : String(err),
      true,
    );
  }

  const sanitized = tool.sanitizeArgs
    ? tool.sanitizeArgs(parsed.data)
    : defaultSanitize(parsed.data);

  const log: AgentToolLog = {
    id: newId(),
    userId: ctx.userId,
    tool: name,
    sanitizedArguments: sanitized,
    result: {
      success: result.success,
      errorCode: result.error?.code,
      errorMessage: result.error?.message,
    },
    latencyMs: Date.now() - startedAt,
    at: Date.now(),
    correlationId: ctx.correlationId,
  };

  // A logging failure must never turn a successful tool result into a failure.
  await ctx.logStore.createLog(log).catch(() => undefined);

  return result;
}

// ── In-memory stores (tests + demo) ──────────────────────────────────────────

export class InMemoryTimerStore implements TimerStore {
  private timers = new Map<string, CookingTimer>();

  async createTimer(timer: CookingTimer): Promise<void> {
    this.timers.set(timer.id, { ...timer });
  }

  async getTimer(id: string): Promise<CookingTimer | null> {
    return this.timers.get(id) ?? null;
  }

  async updateTimer(id: string, partial: Partial<CookingTimer>): Promise<void> {
    const current = this.timers.get(id);
    if (!current) throw new Error(`Timer ${id} not found`);
    this.timers.set(id, { ...current, ...partial });
  }

  async listActiveTimers(sessionId: string): Promise<CookingTimer[]> {
    return Array.from(this.timers.values()).filter(
      (t) => t.sessionId === sessionId && t.status === 'RUNNING',
    );
  }
}

export class InMemoryLogStore implements LogStore {
  private logs: AgentToolLog[] = [];

  async createLog(log: AgentToolLog): Promise<void> {
    this.logs.push({ ...log });
  }

  listLogs(): AgentToolLog[] {
    return [...this.logs];
  }
}

export class InMemoryRecipeStore implements RecipeStore {
  private recipes = new Map<string, Recipe>();

  async createRecipe(recipe: Recipe): Promise<void> {
    this.recipes.set(recipe.id, recipe);
  }

  async getRecipe(id: string): Promise<Recipe | null> {
    return this.recipes.get(id) ?? null;
  }

  async updateRecipe(recipe: Recipe): Promise<void> {
    this.recipes.set(recipe.id, recipe);
  }

  async listRecipes(userId: string): Promise<Recipe[]> {
    return [...this.recipes.values()].filter((r) => r.userId === userId);
  }
}

export class InMemoryPantryStore implements PantryStore {
  private items = new Map<string, PantryItem>();

  async listItems(userId: string): Promise<PantryItem[]> {
    return [...this.items.values()].filter((i) => i.userId === userId);
  }

  async getItem(id: string): Promise<PantryItem | null> {
    return this.items.get(id) ?? null;
  }

  async upsertItem(item: PantryItem): Promise<void> {
    this.items.set(item.id, item);
  }

  async deleteItem(id: string): Promise<void> {
    this.items.delete(id);
  }
}

export class InMemoryLeftoverStore implements LeftoverStore {
  private leftovers = new Map<string, Leftover>();

  async createLeftover(leftover: Leftover): Promise<void> {
    this.leftovers.set(leftover.id, { ...leftover });
  }

  async getLeftover(id: string): Promise<Leftover | null> {
    return this.leftovers.get(id) ?? null;
  }

  async listLeftovers(userId: string): Promise<Leftover[]> {
    return [...this.leftovers.values()].filter((l) => l.userId === userId);
  }

  async updateLeftover(id: string, partial: Partial<Leftover>): Promise<void> {
    const current = this.leftovers.get(id);
    if (!current) throw new Error(`Leftover ${id} not found`);
    this.leftovers.set(id, { ...current, ...partial });
  }
}

export class InMemoryGroceryStore implements GroceryStore {
  private items = new Map<string, GroceryItem>();

  async createGroceryItem(item: GroceryItem): Promise<void> {
    this.items.set(item.id, { ...item });
  }

  async getGroceryItem(id: string): Promise<GroceryItem | null> {
    return this.items.get(id) ?? null;
  }

  async listGroceryItems(userId: string): Promise<GroceryItem[]> {
    return [...this.items.values()].filter((i) => i.userId === userId);
  }

  async updateGroceryItem(id: string, partial: Partial<GroceryItem>): Promise<void> {
    const current = this.items.get(id);
    if (!current) throw new Error(`Grocery item ${id} not found`);
    this.items.set(id, { ...current, ...partial });
  }

  async deleteGroceryItem(id: string): Promise<void> {
    this.items.delete(id);
  }
}

export class InMemoryDietaryProfileStore implements DietaryProfileStore {
  private profiles = new Map<string, DietaryProfile>();

  async getProfile(userId: string): Promise<DietaryProfile | null> {
    return this.profiles.get(userId) ?? null;
  }

  async upsertProfile(profile: DietaryProfile): Promise<void> {
    this.profiles.set(profile.userId, profile);
  }
}