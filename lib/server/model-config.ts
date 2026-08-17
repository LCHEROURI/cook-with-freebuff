// ─────────────────────────────────────────────────────────────────────────────
// Model config (server) — resolve Gemini model names from Firebase Remote
// Config so a model version can change without a deploy.
//
// Each Gemini role maps to a Remote Config parameter whose DEFAULT value names
// the model (e.g. `recipe_generation_model` → "gemini-3.7-flash"). This module
// reads the published template via the Admin SDK, caches it briefly, and hands
// the value back. It only supplies the Remote Config layer: when a parameter
// is unset, unreachable, or running under the emulator, it returns undefined
// and the caller's existing env-var → hardcoded-default chain applies exactly
// as before — so turning Remote Config on can never break a running deploy.
//
// The role → (parameter, env var, default) mapping lives in
// lib/ai/model-roles.ts, the single source of truth shared by the providers,
// the voice client, and the startup self-check below, so the three can never
// drift apart.
//
// Parameters (create/publish these in Firebase → Remote Config):
//   recipe_generation_model, recipe_validation_model, conversation_model,
//   vision_model, live_voice_model
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';

import { getRemoteConfig } from 'firebase-admin/remote-config';
import { getAdminApp } from './admin';
import { logInfo } from './logger';
import { MODEL_ROLES, MODEL_ROLE_CONFIG, type GeminiModelRole } from '../ai/model-roles';

// Keep the role type importable from this module for existing callers
// (stores.ts). The type itself now lives in the shared role table.
export type { GeminiModelRole };

/** How long the published template is cached before a re-fetch. */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedParams: Record<string, string> | null = null;
let cachedAt = 0;

/**
 * Fetch the published Remote Config template's parameter defaults, cached for
 * CACHE_TTL_MS. Returns null when Remote Config can't be read (emulator, no
 * admin app, or a first fetch that failed), and the last-good cache on a
 * transient re-fetch failure. A failed refresh records its time so the next
 * attempt is deferred a full TTL, instead of retrying on every call during an
 * outage. Never throws.
 */
async function readRemoteConfigParams(): Promise<Record<string, string> | null> {
  // Emulators have no real Remote Config — fall through to env/default.
  if (process.env.FIRESTORE_EMULATOR_HOST) return null;

  const now = Date.now();
  if (now - cachedAt < CACHE_TTL_MS) return cachedParams;

  try {
    // getAdminApp() lives INSIDE the try: a malformed service account (or any
    // init failure) must degrade to the cached value, not throw — the startup
    // self-check below is the first thing to eagerly call this at boot.
    const app = getAdminApp();
    if (!app) return cachedParams; // no credentials → keep last good, else null

    const template = await getRemoteConfig(app).getTemplate();
    const params: Record<string, string> = {};
    for (const [key, parameter] of Object.entries(template.parameters ?? {})) {
      const value = (parameter?.defaultValue as { value?: string } | undefined)?.value;
      if (typeof value === 'string' && value) params[key] = value;
    }
    cachedParams = params;
    cachedAt = now;
    return params;
  } catch {
    // Back off after a failed refresh: keep the last-good value (or null) but
    // record the failure time, so the next fetch attempt waits out the TTL
    // instead of retrying getTemplate() on every model operation and storming
    // Remote Config during an outage.
    cachedAt = now;
    return cachedParams;
  }
}

/**
 * The Remote Config value for a role, or undefined when unset/unreachable.
 * Callers keep their own env → default fallback after this.
 */
export async function resolveGeminiModel(role: GeminiModelRole): Promise<string | undefined> {
  const params = await readRemoteConfigParams();
  if (!params) return undefined;
  return params[MODEL_ROLE_CONFIG[role].rcParam];
}

/**
 * Resolve every role once at startup and emit one `model_source` log line
 * naming which source supplied the model — `remote-config`, `env`, or
 * `default`. A `default` line doubles as the silent-fallback warning: neither
 * Remote Config nor the env var is set, so the hardcoded name is in use.
 * Never throws: a broken Remote Config read must never take down a boot.
 */
export async function logModelResolutionSources(): Promise<void> {
  for (const { role, envVar, defaultModel } of MODEL_ROLES) {
    const remote = await resolveGeminiModel(role);
    const fromEnv = process.env[envVar];
    const model = remote ?? fromEnv ?? defaultModel;
    const source = remote ? 'remote-config' : fromEnv ? 'env' : 'default';
    logInfo('model_source', { role, model, source });
  }
}
