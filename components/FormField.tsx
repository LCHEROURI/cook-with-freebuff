'use client';

// ─────────────────────────────────────────────────────────────────────────────
// FormInput / FormTextarea — controlled form fields with optional field-UI
// annotations for voice append behaviour.
//
// These are thin wrappers over native <input> and <textarea>, matching the
// app's controlled-component pattern (useState + onChange). The fieldUI +
// field props attach a data-voice-separator attribute so a future
// VoiceInputButton can append to the correct separator for that schema field.
//
// `voice` renders a VoiceInputButton beside the field. Voice transcripts never
// ride the typed `onChange` callback when `onVoice` is supplied — the parent
// owns appending plus provenance (see the voice-everywhere plan Task 5). When
// `onVoice` is absent, the transcript appends into the field through
// `onChange` for surfaces that do not track provenance.
// ─────────────────────────────────────────────────────────────────────────────

import type { CSSProperties, ChangeEvent } from 'react';

import { appendTranscript, type FieldUIAnnotations } from '@/lib/domain/fieldUI';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { VoiceInputButton } from './VoiceInputButton';

// ── Shared props ─────────────────────────────────────────────────────────────

interface BaseProps {
  /** The annotation surface for this form (from makeFieldUIAnnotations). */
  fieldUI?: FieldUIAnnotations;
  /** The schema field name — used to resolve the voice separator. */
  field?: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
  /** Render a transcription mic beside this field. */
  voice?: boolean;
  /** Distinct voice callback; when set, transcripts bypass typed onChange. */
  onVoice?: (text: string) => void;
}

// ── FormInput ────────────────────────────────────────────────────────────────

interface FormInputProps extends BaseProps {
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  type?: 'text' | 'number';
}

export function FormInput({
  fieldUI,
  field,
  value,
  placeholder,
  disabled,
  className,
  style,
  'aria-label': ariaLabel,
  onChange,
  type = 'text',
  voice,
  onVoice,
}: FormInputProps) {
  const sep = fieldUI && field ? fieldUI.resolve(field) : undefined;

  return (
    <>
      <Input
        className={className}
        style={style}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        data-voice-separator={sep}
        onChange={onChange}
      />
      {voice && (
        <VoiceInputButton
          aria-label={ariaLabel ? `Speak ${ariaLabel}` : undefined}
          onTranscript={(text) => {
            if (onVoice) {
              onVoice(text);
              return;
            }
            onChange({
              target: { value: appendTranscript(value, text, sep) },
            } as ChangeEvent<HTMLInputElement>);
          }}
        />
      )}
    </>
  );
}

// ── FormTextarea ─────────────────────────────────────────────────────────────

interface FormTextareaProps extends BaseProps {
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  rows?: number;
}

export function FormTextarea({
  fieldUI,
  field,
  value,
  placeholder,
  disabled,
  className,
  style,
  'aria-label': ariaLabel,
  onChange,
  rows,
  voice,
  onVoice,
}: FormTextareaProps) {
  const sep = fieldUI && field ? fieldUI.resolve(field) : undefined;

  return (
    <>
      <Textarea
        className={className}
        style={style}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        data-voice-separator={sep}
        rows={rows}
        onChange={onChange}
      />
      {voice && (
        <VoiceInputButton
          aria-label={ariaLabel ? `Speak ${ariaLabel}` : undefined}
          onTranscript={(text) => {
            if (onVoice) {
              onVoice(text);
              return;
            }
            onChange({
              target: { value: appendTranscript(value, text, sep) },
            } as ChangeEvent<HTMLTextAreaElement>);
          }}
        />
      )}
    </>
  );
}
