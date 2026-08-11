'use client';

// ─────────────────────────────────────────────────────────────────────────────
// FormInput / FormTextarea — controlled form fields with optional field-UI
// annotations for voice append behaviour.
//
// These are thin wrappers over native <input> and <textarea>, matching the
// app's controlled-component pattern (useState + onChange). The fieldUI +
// field props attach a data-voice-separator attribute so a future
// VoiceInputButton can append to the correct separator for that schema field.
// ─────────────────────────────────────────────────────────────────────────────

import type { CSSProperties, ChangeEvent } from 'react';

import type { FieldUIAnnotations } from '@/lib/domain/fieldUI';

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
}

// ── FormInput ────────────────────────────────────────────────────────────────

export interface FormInputProps extends BaseProps {
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
}: FormInputProps) {
  const sep = fieldUI && field ? fieldUI.resolve(field) : undefined;

  return (
    <input
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
  );
}

// ── FormTextarea ─────────────────────────────────────────────────────────────

export interface FormTextareaProps extends BaseProps {
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
}: FormTextareaProps) {
  const sep = fieldUI && field ? fieldUI.resolve(field) : undefined;

  return (
    <textarea
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
  );
}
