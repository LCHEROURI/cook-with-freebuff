// ============================================================================
// scripts/refresh-mic-trend.mjs — regenerate docs/mic-regression-trend.md from
// GitHub Actions history, so the trend table never needs hand-maintenance.
//
// The pure rendering half lives in scripts/mic-trend-render.mjs (unit-tested
// with fixtures); this CLI is the thin data-gathering half:
//
//   1. mic-regression.yml runs since the fix window → per-run verdicts by
//      parsing each workflow log's six `--- run N/6 ---` segments (RESULT:
//      PASS vs the driver's hard-failure signatures vs a pre-mic flake like
//      the launch 503 — which has NO two-burst verdict).
//   2. ci.yml push runs on main since the fix window → each run's
//      "Verify deployed app after deploy (verify:live)" job conclusion
//      (clean / voice-red / red-other / skipped / cancelled). Runs that
//      predate the voice stage (no such job) are excluded.
//   3. Aggregate + render, then rewrite the markdown AND its machine-readable
//      JSON twin (docs/mic-regression-trend.json) in place. Exit 0 on success
//      even when the files changed — the weekly workflow (mic-trend-weekly.yml)
//      decides on the git diff whether to open a PR. A failed or incomplete
//      gather exits 1 WITHOUT touching either file, so a stale report can
//      never masquerade as fresh.
//
// Uses the `gh` CLI (authenticated locally, GH_TOKEN in CI). Every number in
// the report is read from Actions history — nothing is estimated.
// ============================================================================

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { aggregateMicTrend, buildTrendJson, renderReport, FIX_WINDOW_START } from './mic-trend-render.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(ROOT, 'docs', 'mic-regression-trend.md');
// The machine-readable twin: same aggregate, as JSON, so charts/alerts can
// read the trend without re-querying the GitHub API. Regenerated atomically
// with the markdown (both derive from the same rows/totals + date).
const REPORT_JSON = join(ROOT, 'docs', 'mic-regression-trend.json');

// In Actions GITHUB_REPOSITORY is set; locally derive it from the remote so
// the script works in any checkout of the repo.
const REPO =
  process.env.GITHUB_REPOSITORY ||
  execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  }).trim();

const gh = async (args) => {
  const { stdout } = await execFileAsync('gh', [...args, '--repo', REPO], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return stdout;
};

/** Map over items with at most `n` in flight, preserving order. */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// The driver's hard-failure signatures — the monitored contract the weekly
// batch never budgets. A run whose log carries one produced a RED two-burst
// verdict (a drop / stuck queue / latency violation / undrained reply).
// Kept in sync with the batch step's classifier in mic-regression.yml.
// Exported so mic-flake-escalate.mjs classifies the SAME way (a hard failure
// is never a flake).
export const HARD_SIGNATURES = [
  'reports a stuck queue',
  'transcription(s) after 90s',
  'latency bounds exceeded',
  'latency cannot be bounded',
  'second reply never drained',
  'diagnostics blob was not capturable',
];

// gh log lines carry a timestamp + step prefix ("… [phase-c-batch/Run the
// phase-C batch (6 runs)] --- run 1/6 ---"), so the marker is mid-line.
export const RUN_MARKER = /--- run \d+\/6 ---/;

// A force_stuck_blob drill run INJECTS the stuck signature on purpose to
// rehearse the red-week evidence chain — its synthetic drops must never
// count as a real regression in the trend (or a drill would corrupt the
// confidence bound it exists to rehearse). The driver prints this exactly
// once per run when the seam is armed.
export const DRILL_MARKER = 'stuck signature injected into the judged blob';

// A force_flake_streak drill run INJECTS a synthetic flake (`drill-flake →
// 503`) on purpose to rehearse the escalation path — its synthetic flake must
// never count as a real infra flake in the trend (or a drill would pollute the
// Infra flakes column). The driver prints this exactly once when armed.
export const FLAKE_DRILL_MARKER = 'drill: flake signature injected into the judged log';

// The driver prints every failure as `  ✗ FAIL: <message>` (fail() in
// verify-live.mjs / drive-live-voice.mjs).
const FAIL_LINE = /✗ FAIL:[^\r\n]*/;

/**
 * One-line per-run evidence extractor: the FIRST ✗ FAIL: line in a
 * verify:live log is the root cause — the cascade (UI starter, voice driver,
 * timers) follows it. Archived with each red voice stage so a future red
 * carries its cause instead of requiring a re-query of its workflow log.
 *
 * @param {string} log a verify:live job log (scoped — see classifyVoiceStage)
 * @returns {string|null} the trimmed root failure line, or null when the log
 *   carries no failure.
 */
export function extractRootFailure(log) {
  const m = log.match(FAIL_LINE);
  return m ? m[0].trim() : null;
}

/**
 * Parse one mic-regression workflow run into {passes, checks, drops} by
 * reading its log's six per-run segments. Returns null when the run has no
 * batch verdict (cancelled/skipped, or the batch step never ran) — such runs
 * are excluded from the table, exactly like the 503 flake's missing verdict.
 */
async function parseBatchRun(run) {
  const { databaseId, conclusion } = run;
  if (conclusion !== 'success' && conclusion !== 'failure') return null;
  const log = await gh(['run', 'view', String(databaseId), '--log']);
  // Drill runs are rehearsals, not measurements — exclude them entirely so
  // their injected stuck blobs can't pollute the drop count, and their
  // injected flakes can't pollute the Infra flakes column.
  if (log.includes(DRILL_MARKER) || log.includes(FLAKE_DRILL_MARKER)) return null;
  const segments = log.split(RUN_MARKER).slice(1);
  if (segments.length !== 6) {
    console.error(`!! run ${databaseId}: expected 6 "--- run N/6 ---" segments, found ${segments.length} — excluding from the table`);
    return null;
  }
  let passes = 0;
  let drops = 0;
  for (const seg of segments) {
    if (/RESULT: PASS/.test(seg)) {
      passes += 1;
    } else if (HARD_SIGNATURES.some((s) => seg.includes(s))) {
      drops += 1;
    }
    // else: a pre-mic / infra flake (launch 503 etc.) — no two-burst verdict.
  }
  return { passes, checks: 6, drops };
}

/**
 * Classify one ci.yml push run's voice stage from its verify-live job:
 *   clean      — job success (voice stage passed)
 *   skipped    — job skipped (e.g. emulator-compare gated the deploy)
 *   cancelled  — job cancelled
 *   voice-red  — job failed AND the log shows the voice driver itself red
 *                (`✗ FAIL: live voice driver …`)
 *   red-other  — job failed but the voice stage passed (the run red elsewhere)
 * Returns null for runs with no verify-live job (they predate the voice
 * stage, which debuted Aug 13 14:37).
 */
async function classifyVoiceStage(run) {
  const { databaseId } = run;
  const { jobs } = JSON.parse(await gh(['run', 'view', String(databaseId), '--json', 'jobs']));
  const job = jobs.find((j) => j.name.includes('verify:live'));
  if (!job) return null;
  if (job.conclusion === 'success') return { kind: 'clean' };
  if (job.conclusion === 'skipped') return { kind: 'skipped' };
  if (job.conclusion === 'cancelled') return { kind: 'cancelled' };
  // failure (or anything unexpected): the log distinguishes a voice-stage red
  // from a run that red elsewhere while the voice stage passed. Scoped to the
  // verify:live job (`--job`), so the first ✗ FAIL: line is THIS stage's root
  // cause — not a sibling job's failure.
  const log = await gh(['run', 'view', String(databaseId), '--job', String(job.databaseId), '--log']);
  if (log.includes('✗ FAIL: live voice driver')) {
    return { kind: 'voice-red', rootFailure: extractRootFailure(log) };
  }
  return { kind: 'red-other' };
}

// ── Paged ci.yml gather ──────────────────────────────────────────────────────
// `gh run list` caps how many runs one call fetches, so a report that merely
// raised --limit would silently drop the OLDEST in-window runs once the
// workflow's history outgrew the ceiling. Page the workflow-specific runs
// endpoint instead (newest → oldest), stop as soon as a page's oldest run
// predates the fix window, and fail loudly when the fetch runs out of history
// before reaching FIX_WINDOW_START — the report must never masquerade as
// complete when it cannot prove it covered the whole window.
//
// The fix window starts at the voice stage's debut (Aug 13), NOT the
// workflow's birth, so a complete fetch must include runs strictly OLDER than
// it — the oldest fetched run sitting at/after the start means history was
// purged or a ceiling cut the fetch short.

const CI_PAGE_SIZE = 100;
// Safety cap: 200 pages × 100 runs = 20,000 — far beyond any plausible ci.yml
// history. The loop always ends on an empty page or the window boundary first;
// the cap only turns a non-terminating loop into a loud abort.
const CI_MAX_PAGES = 200;

// `gh api` has no --repo flag (unlike `gh run list`), so the repo is embedded
// in the endpoint path instead of appended as a flag.
const ghApi = async (args) => {
  const { stdout } = await execFileAsync('gh', ['api', ...args], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return stdout;
};

async function resolveCiWorkflowId() {
  const out = String(await ghApi([`repos/${REPO}/actions/workflows/ci.yml`, '--jq', '.id'])).trim();
  if (!out) throw new Error('could not resolve the ci.yml workflow id');
  return out;
}

/**
 * Coverage verdict for a newest-first ci.yml fetch: the window is
 * FIX_WINDOW_START → today, so a complete fetch must reach at least one run
 * OLDER than the window start.
 *
 * @param {Array<{created_at: string}>} runs newest-first (API shape)
 * @returns {{ covered: boolean, oldestCreatedAt: string|null }}
 */
export function ciWindowCoverage(runs) {
  if (runs.length === 0) return { covered: false, oldestCreatedAt: null };
  const oldestCreatedAt = runs[runs.length - 1].created_at;
  return { covered: oldestCreatedAt < FIX_WINDOW_START, oldestCreatedAt };
}

async function listCiPushRunsPaged() {
  const workflowId = await resolveCiWorkflowId();
  const runs = [];
  for (let page = 1; page <= CI_MAX_PAGES; page++) {
    const body = JSON.parse(
      await ghApi([
        `repos/${REPO}/actions/workflows/${workflowId}/runs?per_page=${CI_PAGE_SIZE}&page=${page}&event=push&branch=main`,
      ]),
    );
    const pageRuns = body.workflow_runs ?? [];
    if (pageRuns.length === 0) break; // end of history
    runs.push(...pageRuns);
    // Newest-first: once a page's oldest run predates the window, every later
    // page is even older and the window is fully covered.
    if (pageRuns[pageRuns.length - 1].created_at < FIX_WINDOW_START) break;
  }
  const { covered, oldestCreatedAt } = ciWindowCoverage(runs);
  if (!covered) {
    throw new Error(
      `ci.yml push/main history does not reach the fix-window start ${FIX_WINDOW_START} (oldest run ${oldestCreatedAt ?? 'none'}) — aborting without touching the report`,
    );
  }
  // Map the API's snake_case shape to the gh-run-list shape the pipeline
  // consumes, dropping runs older than the window.
  return runs
    .filter((r) => r.created_at.slice(0, 10) >= FIX_WINDOW_START)
    .map((r) => ({
      databaseId: r.id,
      conclusion: r.conclusion,
      createdAt: r.created_at,
      event: r.event,
      headBranch: r.head_branch,
    }));
}

async function main() {
  const started = Date.now();
  console.log(`mic trend refresh: ${REPO}`);

  const batchRunsRaw = JSON.parse(
    await gh(['run', 'list', '--workflow', 'mic-regression.yml', '--limit', '200', '--json', 'databaseId,conclusion,createdAt']),
  ).filter((r) => r.createdAt.slice(0, 10) >= FIX_WINDOW_START);

  const ciRunsRaw = await listCiPushRunsPaged();

  if (batchRunsRaw.length === 0 && ciRunsRaw.length === 0) {
    console.error('!! no runs found since the fix window — aborting without touching the report');
    process.exit(1);
  }

  const batchRuns = (
    await mapLimit(batchRunsRaw, 4, async (r) => ({
      id: String(r.databaseId),
      createdAt: r.createdAt,
      conclusion: r.conclusion,
      batch: await parseBatchRun(r),
    }))
  ).filter((r) => r.batch !== null);

  const voiceStages = (
    await mapLimit(ciRunsRaw, 8, async (r) => {
      const v = await classifyVoiceStage(r);
      return v ? { id: String(r.databaseId), createdAt: r.createdAt, ...v } : null;
    })
  ).filter(Boolean);

  const { rows, totals } = aggregateMicTrend(batchRuns, voiceStages);
  // Per-run evidence: each red voice stage carries its root failure line, so
  // the JSON archives the CAUSE of every red — not just the red count.
  const redVoiceStages = voiceStages
    .filter((v) => v.kind === 'voice-red')
    .map((v) => ({
      id: v.id,
      date: v.createdAt.slice(0, 10),
      createdAt: v.createdAt,
      rootFailure: v.rootFailure ?? null,
    }));
  const generatedAt = new Date().toISOString();
  const markdown = renderReport({ generatedAt, rows, totals });
  // The JSON is the same aggregate as the markdown, keyed by the same date,
  // so a re-run with no new data changes NEITHER file (idempotent for the
  // weekly workflow's diff-based PR gating).
  const json = `${JSON.stringify({ ...buildTrendJson({ generatedAt, rows, totals, redVoiceStages }), repo: REPO, source: 'GitHub Actions history via gh CLI' }, null, 2)}\n`;

  const before = readFileSync(REPORT, 'utf8');
  const beforeJson = existsSync(REPORT_JSON) ? readFileSync(REPORT_JSON, 'utf8') : '';
  const changed = before !== markdown;
  const changedJson = beforeJson !== json;
  writeFileSync(REPORT, markdown);
  writeFileSync(REPORT_JSON, json);

  const checks = totals.batchPasses + totals.voiceClean;
  console.log(`  batch runs: ${batchRuns.length} (of ${batchRunsRaw.length} in window; ${batchRunsRaw.length - batchRuns.length} excluded — cancelled, drill, or no verdict)`);
  console.log(`  voice stages: ${voiceStages.length} (of ${ciRunsRaw.length} push runs; ${ciRunsRaw.length - voiceStages.length} predate the voice stage)`);
  console.log(`  totals: ${totals.batchPasses}/${totals.batchChecks} batch · ${totals.voiceClean} clean / ${totals.voiceClean + totals.voiceRed} voice · ${totals.drops} drops · ${checks} clean checks`);
  console.log(`  wrote ${REPORT.replace(ROOT + '/', '')} (${changed ? 'CHANGED' : 'unchanged'}), ${REPORT_JSON.replace(ROOT + '/', '')} (${changedJson ? 'CHANGED' : 'unchanged'}) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

// Only run the CLI when executed directly, so the fixture tests can import
// extractRootFailure without triggering the gh queries.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`✗ refresh-mic-trend failed: ${err.message}`);
    process.exit(1);
  });
}
