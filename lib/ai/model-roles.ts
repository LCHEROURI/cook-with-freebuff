// ─────────────────────────────────────────────────────────────────────────────
// Gemini model roles — the single source of truth for which model each role
// resolves to, and from where.
//
// Precedence everywhere is: explicit option → Remote Config → env var →
// hardcoded default. The providers, the server resolver, and the startup
// self-check all read this table so the three can never drift apart. Keep it
// free of server-only imports: the voice client also links against it.
// ─────────────────────────────────────────────────────────────────────────────

export type GeminiModelRole =
  | 'generation'
  | 'validation'
  | 'conversation'
  | 'vision'
  | 'live-voice';

export interface ModelRoleConfig {
  role: GeminiModelRole;
  /** Firebase Remote Config parameter name. */
  rcParam: string;
  /** Env-var fallback, e.g. RECIPE_GENERATION_MODEL. */
  envVar: string;
  /** Hardcoded default when neither Remote Config nor the env var is set. */
  defaultModel: string;
}

// Text roles default to gemini-3.7-flash (latest stable Flash, 2026-08-13):
// the Gemini 2.5 family shuts down in October 2026, so a 2.x default here is
// a latent outage. model-roles.test.ts pins these names and blocks any
// regression to the deprecated family.
export const MODEL_ROLES: readonly ModelRoleConfig[] = [
  { role: 'generation', rcParam: 'recipe_generation_model', envVar: 'RECIPE_GENERATION_MODEL', defaultModel: 'gemini-3.7-flash' },
  { role: 'validation', rcParam: 'recipe_validation_model', envVar: 'RECIPE_VALIDATION_MODEL', defaultModel: 'gemini-3.7-flash' },
  { role: 'conversation', rcParam: 'conversation_model', envVar: 'CONVERSATION_MODEL', defaultModel: 'gemini-3.7-flash' },
  { role: 'vision', rcParam: 'vision_model', envVar: 'VISION_MODEL', defaultModel: 'gemini-3.7-flash' },
  { role: 'live-voice', rcParam: 'live_voice_model', envVar: 'LIVE_MODEL', defaultModel: 'gemini-3.1-flash-live-preview' },
];

export const MODEL_ROLE_CONFIG: Record<GeminiModelRole, ModelRoleConfig> = Object.fromEntries(
  MODEL_ROLES.map((c) => [c.role, c]),
) as Record<GeminiModelRole, ModelRoleConfig>;
