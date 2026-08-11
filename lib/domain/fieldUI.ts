// ─────────────────────────────────────────────────────────────────────────────
// Field-UI annotations — generic factory for annotating form fields with
// voice append behaviour (paragraph vs comma separation).
//
// Each form surface in the app gets one factory call with its own
// "notes or equivalent" free-text schema field. Annotation discipline
// propagates into every form surface rather than living next to a single
// wizard schema.
// ─────────────────────────────────────────────────────────────────────────────

import type { ZodObject, ZodRawShape } from 'zod';
import {
  pantryItemSchema,
  leftoverSchema,
  recipeSchema,
  dietaryProfileSchema,
} from './schemas';

// ── Separator constants ──────────────────────────────────────────────────────

/** Append voice utterances as new paragraphs (natural for notes / free text). */
const PARAGRAPH = '\n' as const;
/** Append voice utterances as comma separated items (natural for list fields). */
const COMMA = ', ' as const;

// ── Types ────────────────────────────────────────────────────────────────────

export type Separator = typeof PARAGRAPH | typeof COMMA;

/** The annotation surface returned by makeFieldUIAnnotations. */
export interface FieldUIAnnotations {
  resolve(field: string): Separator | undefined;
  isVoiceAppend(field: string): boolean;
  readonly fieldUI: ReadonlyMap<string, Separator>;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a field-UI annotation surface for a Zod object schema.
 *
 * `commaListFields` are the schema field names where each successive voice
 * utterance should be comma separated (e.g. allergy lists).
 *
 * `paragraphFields` are the schema field names where each successive voice
 * utterance should start a new paragraph (e.g. recipe descriptions, leftover
 * notes).
 */
export function makeFieldUIAnnotations<
  T extends ZodObject<ZodRawShape>,
>(
  _schema: T,
  commaListFields: readonly (keyof T['shape'] & string)[],
  paragraphFields: readonly (keyof T['shape'] & string)[],
): FieldUIAnnotations {
  const entries: [string, Separator][] = [];
  for (const f of commaListFields) {
    entries.push([f, COMMA]);
  }
  for (const f of paragraphFields) {
    entries.push([f, PARAGRAPH]);
  }
  const map = new Map<string, Separator>(entries);

  return {
    fieldUI: map,
    resolve(field: string) {
      return map.get(field);
    },
    isVoiceAppend(field: string) {
      return map.has(field);
    },
  };
}

// ── Per-schema annotation calls ──────────────────────────────────────────────

/** Pantry item: `notes` is free-text (paragraphs). */
export const pantryFieldUI = makeFieldUIAnnotations(
  pantryItemSchema,
  [],
  ['notes'],
);

/** Leftovers: `notes` is free-text (paragraphs). */
export const leftoverFieldUI = makeFieldUIAnnotations(
  leftoverSchema,
  [],
  ['notes'],
);

/** Recipe: `description` is free-text (paragraphs), `safetyNotes` are
 *  comma-separated items. */
export const recipeFieldUI = makeFieldUIAnnotations(
  recipeSchema,
  ['safetyNotes'],
  ['description'],
);

/** Dietary profile: allergy/restriction lists are comma-separated. */
export const profileFieldUI = makeFieldUIAnnotations(
  dietaryProfileSchema,
  ['allergies', 'dietaryRestrictions', 'dislikedIngredients', 'preferredCuisines'],
  [],
);
