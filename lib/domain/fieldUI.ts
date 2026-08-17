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
  dietaryProfileSchema,
} from './schemas';

// ── Separator constants ──────────────────────────────────────────────────────

/** Append voice utterances as new paragraphs (natural for notes / free text). */
const PARAGRAPH = '\n' as const;
/** Append voice utterances as comma separated items (natural for list fields). */
const COMMA = ', ' as const;

type Separator = typeof PARAGRAPH | typeof COMMA;

// ── Type ─────────────────────────────────────────────────────────────────────

/** The annotation surface returned by makeFieldUIAnnotations. */
export interface FieldUIAnnotations {
  /**
   * Resolve the voice separator for a schema field.
   * Returns the separator string for annotated fields, `undefined` otherwise.
   */
  resolve(field: string): Separator | undefined;
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
  schema: T,
  commaListFields: readonly (keyof T['shape'] & string)[],
  paragraphFields: readonly (keyof T['shape'] & string)[],
): FieldUIAnnotations {
  const map = new Map<string, Separator>();
  for (const f of commaListFields) map.set(f, COMMA);
  for (const f of paragraphFields) map.set(f, PARAGRAPH);

  return {
    resolve(field: string) {
      return map.get(field);
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

/** Dietary profile: allergy/restriction lists are comma-separated. */
export const profileFieldUI = makeFieldUIAnnotations(
  dietaryProfileSchema,
  ['allergies', 'dietaryRestrictions', 'dislikedIngredients', 'preferredCuisines'],
  [],
);

// ── Transcript appending ─────────────────────────────────────────────────────

/**
 * Append a voice transcript to an existing field value.
 *
 * `separator == null` means the field is single-value: the transcript replaces
 * the current value (a repeated utterance corrects the previous one). With a
 * separator, the transcript is appended after it, so list fields accumulate
 * comma-separated items and paragraph fields start a new line. Blank incoming
 * text is a no-op so a recognizer's empty final flush never wipes the field.
 */
export function appendTranscript(
  current: string,
  incoming: string,
  separator?: string,
): string {
  if (!incoming.trim()) return current;
  if (separator == null) return incoming;
  return current.trim() === '' ? incoming : current + separator + incoming;
}
