// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceInputButton } from './VoiceInputButton';

// The real useVoiceInput hook probes navigator.mediaDevices on error paths
// only, but stub it so a failure in the happy-path test can never leak a real
// self-check.
vi.mock('@/lib/voice/self-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/voice/self-check')>();
  return {
    ...actual,
    runWebSpeechSelfCheck: vi.fn().mockResolvedValue({ api: true, mic: 'granted' }),
  };
});

// A deterministic recognition fake that emits a final result before onend,
// so the real hook's buffer flush has a transcript to deliver on stop.
class FakeRecognition {
  lang = '';
  interimResults = false;
  maxAlternatives = 1;
  continuous = false;
  onresult: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  start = vi.fn();
  abort = vi.fn();
  stop = vi.fn(() => {
    this.onresult?.({
      resultIndex: 0,
      results: [{ 0: { transcript: 'eggs' }, isFinal: true, length: 1 }],
    });
    this.onend?.();
  });
}

function installFake() {
  (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
}

function clearApi() {
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  delete w.SpeechRecognition;
  delete w.webkitSpeechRecognition;
}

beforeEach(installFake);
afterEach(clearApi);

describe('VoiceInputButton', () => {
  it('starts listening, then delivers the transcript on stop', async () => {
    const onTranscript = vi.fn();
    const user = userEvent.setup();
    render(<VoiceInputButton onTranscript={onTranscript} aria-label="Speak item name" />);

    const startButton = screen.getByRole('button', { name: 'Speak item name' });
    expect(startButton).not.toHaveAttribute('aria-pressed', 'true');

    await user.click(startButton);

    const listeningButton = screen.getByRole('button', { name: 'Stop listening for item name' });
    expect(listeningButton).toHaveAttribute('aria-pressed', 'true');

    await user.click(listeningButton);

    expect(onTranscript).toHaveBeenCalledWith('eggs');
    expect(screen.getByRole('button', { name: 'Speak item name' })).toBeInTheDocument();
  });

  it('falls back to a generic label when none is supplied', () => {
    render(<VoiceInputButton onTranscript={() => {}} />);
    expect(screen.getByRole('button', { name: 'Speak' })).toBeInTheDocument();
  });

  it('disables the mic when speech recognition is unsupported', () => {
    clearApi();
    render(<VoiceInputButton onTranscript={() => {}} aria-label="Speak item name" />);
    expect(screen.getByRole('button', { name: 'Speak item name' })).toBeDisabled();
  });
});
