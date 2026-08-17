'use client';

import { useVoiceInput } from '@/lib/hooks/useVoiceInput';
import styles from './VoiceInputButton.module.css';

interface Props {
  onTranscript: (text: string) => void;
  'aria-label'?: string;
}

function listeningLabel(label?: string): string {
  if (!label) return 'Stop listening';
  const subject = label.replace(/^speak\s*/i, '').trim();
  return subject ? `Stop listening for ${subject}` : 'Stop listening';
}

export function VoiceInputButton({ onTranscript, 'aria-label': ariaLabel }: Props) {
  const { supported, listening, interim, error, toggle } = useVoiceInput({ onFinal: onTranscript });
  const label = listening ? listeningLabel(ariaLabel) : (ariaLabel ?? 'Speak');

  return (
    <span className={styles.wrap}>
      <button
        type="button"
        onClick={toggle}
        disabled={!supported}
        aria-label={label}
        aria-pressed={listening}
        title={!supported ? 'Voice input is not supported in this browser' : undefined}
        className={styles.mic}
      >
        {listening ? '⏹' : '🎤'}
      </button>
      {listening && <span className={styles.interim}>{interim || 'Listening…'}</span>}
      {error && <span className={styles.error} role="alert">{error}</span>}
    </span>
  );
}
