// ─────────────────────────────────────────────────────────────────────────────
// Structured logging (K9 Part C — observability)
//
// Emits one JSON object per line. Vercel / Google Cloud Logging ingest
// stdout+stderr JSON lines natively, so every request, model failure, tool
// failure, and validation failure can be correlated and queried without any
// external agent. Every event carries the correlationId when one is present —
// the same id threads a conversation through voice request → agent → tool →
// backend → database → response.
//
// Rules:
//   - one event per line, always JSON
//   - never log secrets or full user PII (tool args are already sanitized by
//     the tool layer before agent_tool_logs)
//   - info → stdout, warn/error → stderr (so dashboards can split severities)
// ─────────────────────────────────────────────────────────────────────────────

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

/** Emit one structured JSON log line. */
export function logEvent(
  event: string,
  fields: LogFields = {},
  level: LogLevel = 'info',
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  // level severity splits stdout (info) from stderr (warn/error).
  if (level === 'info') {
    // eslint-disable-next-line no-console
    console.log(line);
  } else {
    // eslint-disable-next-line no-console
    console.error(line);
  }
}

/** Convenience wrappers — one per severity, matching the LogLevel union. */
export const logInfo = (event: string, fields?: LogFields) => logEvent(event, fields, 'info');
export const logWarn = (event: string, fields?: LogFields) => logEvent(event, fields, 'warn');
export const logError = (event: string, fields?: LogFields) => logEvent(event, fields, 'error');
