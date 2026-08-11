# Review, main, 2026-08-11

**Reviewed by**: deepseek-v4-pro (same model as author — no cross-model benefit)
**Scope**: 5 committed + 3 uncommitted files
**Verdict**: Approve with nits

## Summary
Adds a generic `makeFieldUIAnnotations<T>()` factory that maps Zod schema fields to voice append separators. Three annotation calls (pantry, leftover, profile) feed into `FormInput`/`FormTextarea` components that attach `data-voice-separator` DOM attributes. The kitchen page gains notes textareas for pantry and leftover forms, plus comma separated annotations on profile fields. The overhaul (uncommitted) removed unused exports and reverted unannotated wrappers back to raw inputs. Clean and minimal.

## Minor
### 🟡 Misleading underscore on used parameter, `lib/domain/fieldUI.ts:61`
**Problem**: `_schema: T` uses the underscore prefix that conventionally marks a parameter as intentionally unused. But this parameter IS used: it constrains the generic `T` so that `commaListFields` and `paragraphFields` are type checked against the schema's shape keys. The underscore lies about its purpose.
**Why it matters**: A future reader may delete it thinking it is dead code, breaking the compile time field name validation.
**Suggested fix**: Rename `_schema` to `schema`.

### 🟡 `FormField.tsx` still exports after diff, `components/FormField.tsx`
**Problem**: The uncommitted diff unexports `FormInputProps` and `FormTextareaProps`, which is correct (no callers). But the `FormInput` and `FormTextarea` functions themselves are still exported — all four profile fields and two notes fields import them. This is intentional and correct. No change needed.

## Strengths
- The factory is tight: one function, two separator constants, a Map, two methods. Zero ceremony.
- Annotation discipline is visible: every annotated field in the kitchen page carries a visible `fieldUI={...}` + `field="..."` pair. Unannotated fields use plain `<input>`. No false signals.
- The `PantryItemInput.notes` change is backwards compatible and follows the existing pattern from leftover notes (same trim, same slice, same length limit).

## Test coverage
28 new tests (17 factory unit + 11 component render). The factory tests cover resolution, voice append detection, empty maps, overlapping fields, and per schema verification. The component tests cover render, attribute attachment, prop forwarding, and user interaction. The kitchen page itself is tested indirectly by the existing `pages-auth-wiring.test.ts` which reads the page source.
