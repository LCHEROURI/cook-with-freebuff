// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { z } from 'zod';
import { FormInput, FormTextarea } from './FormField';
import { makeFieldUIAnnotations } from '@/lib/domain/fieldUI';

// The voice paths only need to prove that the transcript lands on the right
// callback; swap the real mic for a button that emits a fixed transcript.
vi.mock('./VoiceInputButton', () => ({
  VoiceInputButton: ({
    onTranscript,
    'aria-label': ariaLabel,
  }: {
    onTranscript: (text: string) => void;
    'aria-label'?: string;
  }) => (
    <button type="button" aria-label={ariaLabel} onClick={() => onTranscript('spoken')}>
      mic
    </button>
  ),
}));

// ── Test annotation surface ──────────────────────────────────────────────────

const testSchema = z.object({
  notes: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

const ui = makeFieldUIAnnotations(testSchema, ['tags'], ['notes']);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Wrap a FormInput with React state so the controlled component re-renders. */
function StatefulInput(props: { fieldUI?: typeof ui; field?: string; placeholder?: string }) {
  const [value, setValue] = useState('');
  return (
    <FormInput
      {...props}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      aria-label="stateful input"
    />
  );
}

function StatefulTextarea(props: { fieldUI?: typeof ui; field?: string; placeholder?: string }) {
  const [value, setValue] = useState('');
  return (
    <FormTextarea
      {...props}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      aria-label="stateful textarea"
    />
  );
}

// ── FormInput ────────────────────────────────────────────────────────────────

describe('FormInput', () => {
  it('renders an input with the given value', () => {
    render(
      <FormInput
        value="hello"
        onChange={() => {}}
        aria-label="test input"
      />,
    );
    const input = screen.getByLabelText('test input');
    expect(input).toHaveValue('hello');
  });

  it('sets data-voice-separator when fieldUI and field are provided', () => {
    render(
      <FormInput
        fieldUI={ui}
        field="tags"
        value="a, b"
        onChange={() => {}}
        aria-label="tags input"
      />,
    );
    const input = screen.getByLabelText('tags input');
    expect(input).toHaveAttribute('data-voice-separator', ', ');
  });

  it('omits data-voice-separator when no fieldUI is given', () => {
    render(
      <FormInput
        value="hello"
        onChange={() => {}}
        aria-label="plain input"
      />,
    );
    const input = screen.getByLabelText('plain input');
    expect(input).not.toHaveAttribute('data-voice-separator');
  });

  it('omits data-voice-separator when field is un-annotated', () => {
    render(
      <FormInput
        fieldUI={ui}
        field="nonexistent"
        value="x"
        onChange={() => {}}
        aria-label="unannotated input"
      />,
    );
    const input = screen.getByLabelText('unannotated input');
    expect(input).not.toHaveAttribute('data-voice-separator');
  });

  it('forwards disabled and placeholder props', () => {
    render(
      <FormInput
        value=""
        onChange={() => {}}
        disabled
        placeholder="type here"
        aria-label="disabled input"
      />,
    );
    const input = screen.getByLabelText('disabled input');
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('placeholder', 'type here');
  });

  it('calls onChange with the new value on user input', async () => {
    const user = userEvent.setup();
    render(<StatefulInput />);
    const input = screen.getByLabelText('stateful input');
    await user.type(input, 'abc');
    expect(input).toHaveValue('abc');
  });
});

// ── FormTextarea ─────────────────────────────────────────────────────────────

describe('FormTextarea', () => {
  it('renders a textarea with the given value', () => {
    render(
      <FormTextarea
        value="hello world"
        onChange={() => {}}
        aria-label="test textarea"
      />,
    );
    const textarea = screen.getByLabelText('test textarea');
    expect(textarea).toHaveValue('hello world');
  });

  it('sets data-voice-separator when fieldUI and field are provided', () => {
    render(
      <FormTextarea
        fieldUI={ui}
        field="notes"
        value="some notes"
        onChange={() => {}}
        aria-label="notes textarea"
      />,
    );
    const textarea = screen.getByLabelText('notes textarea');
    expect(textarea).toHaveAttribute('data-voice-separator', '\n');
  });

  it('omits data-voice-separator when no fieldUI is given', () => {
    render(
      <FormTextarea
        value="bare"
        onChange={() => {}}
        aria-label="bare textarea"
      />,
    );
    const textarea = screen.getByLabelText('bare textarea');
    expect(textarea).not.toHaveAttribute('data-voice-separator');
  });

  it('forwards rows, disabled, and placeholder props', () => {
    render(
      <FormTextarea
        value=""
        onChange={() => {}}
        rows={4}
        disabled
        placeholder="write something"
        aria-label="styled textarea"
      />,
    );
    const textarea = screen.getByLabelText('styled textarea');
    expect(textarea).toBeDisabled();
    expect(textarea).toHaveAttribute('placeholder', 'write something');
    expect(textarea).toHaveAttribute('rows', '4');
  });

  it('calls onChange with the new value on user input', async () => {
    const user = userEvent.setup();
    render(<StatefulTextarea />);
    const textarea = screen.getByLabelText('stateful textarea');
    await user.type(textarea, 'xyz');
    expect(textarea).toHaveValue('xyz');
  });
});

// ── Voice mic wiring ────────────────────────────────────────────────────────

describe('FormInput voice wiring', () => {
  it('routes transcripts to onVoice and never touches typed onChange', async () => {
    const onVoice = vi.fn();
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(
      <FormInput
        value=""
        onChange={onChange}
        onVoice={onVoice}
        voice
        aria-label="pantry name"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Speak pantry name' }));

    expect(onVoice).toHaveBeenCalledWith('spoken');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('appends the transcript through onChange when no onVoice is given', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(
      <FormInput
        value="peanuts"
        fieldUI={ui}
        field="tags"
        onChange={onChange}
        voice
        aria-label="allergies"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Speak allergies' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const event = onChange.mock.calls[0][0] as { target: { value: string } };
    expect(event.target.value).toBe('peanuts, spoken');
  });
});
