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

export const MODEL_ROLES: readonly ModelRoleConfig[] = [
  { role: 'generation', rcParam: 'recipe_generation_model', envVar: 'RECIPE_GENERATION_MODEL', defaultModel: 'gemini-2.5-flash' },
  { role: 'validation', rcParam: 'recipe_validation_model', envVar: 'RECIPE_VALIDATION_MODEL', defaultModel: 'gemini-2.5-flash' },
  { role: 'conversation', rcParam: 'conversation_model', envVar: 'CONVERSATION_MODEL', defaultModel: 'gemini-2.5-flash' },
  { role: 'vision', rcParam: 'vision_model', envVar: 'VISION_MODEL', defaultModel: 'gemini-2.5-flash' },
  { role: 'live-voice', rcParam: 'live_voice_model', envVar: 'LIVE_MODEL', defaultModel: 'gemini-3.1-flash-live-preview' },
];

export const MODEL_ROLE_CONFIG: Record<GeminiModelRole, ModelRoleConfig> = Object.fromEntries(
  MODEL_ROLES.map((c) => [c.role, c]),
) as Record<GeminiModelRole, ModelRoleConfig>;
