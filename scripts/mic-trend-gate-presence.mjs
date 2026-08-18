// ============================================================================
// scripts/mic-trend-gate-presence.mjs — the zero-drop gate must keep RUNNING.
//
// The zero-drop gate (mic-trend-gate.mjs) protects the trend artifact from
// publishing a drop. But a gate that was DISABLED — its step removed from
// ci.yml's validate job, or the whole job restructured so the step never
// reaches — stops protecting the artifact without any red run: the report
// stays green because nothing is checking it. This weekly check closes that
// hole with two independent signals:
//
//   1. STATIC  — the gate step is still wired into .github/workflows/ci.yml
//      (its pinned step name + `node scripts/mic-trend-gate.mjs`).
//   2. DYNAMIC — some ci.yml push-on-main run in the last 14 days actually
//      EXECUTED the step (conclusion success OR failure — both mean the gate
//      ran; skipped/cancelled do not).
//
// Runs in mic-trend-weekly.yml (Tuesday) after the staleness check, before
// the PR step, so a disabled gate fails the weekly job instead of silently
// letting an unguarded artifact keep publishing. The pure judgement lives in
// gatePresenceVerdict (fixture-testable); main() is the thin gh+file shell.
// ============================================================================

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CI_YML = join(ROOT, '.github', 'workflows', 'ci.yml');

/** The pinned step name (contract-pinned in scripts/ci-workflows.test.ts). */
export const GATE_STEP_NAME = 'Verify the mic trend report shows zero drops (artifact gate)';
/** The gate step's run command — both must survive for the step to be live. */
export const GATE_RUN_CMD = 'node scripts/mic-trend-gate.mjs';
/** Two weeks: the window a gate may go unrun before this check alerts. */
export const GATE_PRESENCE_WINDOW_DAYS = 14;

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

/** True when the checked-out ci.yml still defines the gate step (static). */
export function isGateWired(ciYml) {
  return ciYml.includes(GATE_STEP_NAME) && ciYml.includes(GATE_RUN_CMD);
}

/**
 * @typedef {object} GateRun
 * @property {string} id
 * @property {string} createdAt
 * @property {'success'|'failure'|'skipped'|'cancelled'|null} gateStepConclusion
 */

/**
 * @typedef {object} GatePresenceVerdict
 * @property {boolean} ok
 * @property {boolean} gateWired
 * @property {GateRun|null} lastExecution
 * @property {string[]} errors
 */

/**
 * Judge gate presence: the step is wired into ci.yml AND some recent run
 * executed it (success or failure — both prove the gate ran).
 *
 * @param {{ ciYml: string, runs: GateRun[], windowDays?: number }} input
 * @returns {GatePresenceVerdict}
 */
export function gatePresenceVerdict({ ciYml, runs, windowDays = GATE_PRESENCE_WINDOW_DAYS }) {
  const errors = [];
  const gateWired = isGateWired(ciYml);
  if (!gateWired) {
    errors.push(
      `the gate step is missing from .github/workflows/ci.yml — the trend artifact is no longer guarded on every push`,
    );
  }
  const executed = runs.find(
    (r) => r.gateStepConclusion === 'success' || r.gateStepConclusion === 'failure',
  );
  if (!executed) {
    errors.push(
      `no ci.yml run has executed the gate step in the last ${windowDays} days — a disabled gate has silently stopped protecting the artifact`,
    );
  }
  return { ok: errors.length === 0, gateWired, lastExecution: executed ?? null, errors };
}

/**
 * Fetch push-on-main ci.yml runs in the window (newest first) and record each
 * run's gate-step conclusion, batching 8 runs at a time and stopping once a
 * batch contains an execution (the common case is the newest run).
 */
async function collectGateRuns() {
  const cutoff = new Date(Date.now() - GATE_PRESENCE_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const list = JSON.parse(
    await gh(['run', 'list', '--workflow', 'ci.yml', '--limit', '2000', '--json', 'databaseId,createdAt,event,headBranch']),
  ).filter((r) => r.event === 'push' && r.headBranch === 'main' && r.createdAt.slice(0, 10) >= cutoff);

  const runs = [];
  const BATCH = 8;
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (r) => {
        const { jobs } = JSON.parse(await gh(['run', 'view', String(r.databaseId), '--json', 'jobs']));
        const gate = (jobs ?? []).flatMap((j) => j.steps ?? []).find((s) => s.name === GATE_STEP_NAME);
        return {
          id: String(r.databaseId),
          createdAt: r.createdAt,
          gateStepConclusion: gate ? (gate.conclusion ?? null) : null,
        };
      }),
    );
    runs.push(...results);
    if (results.some((r) => r.gateStepConclusion === 'success' || r.gateStepConclusion === 'failure')) break;
  }
  return runs;
}

function main() {
  let ciYml;
  try {
    ciYml = readFileSync(CI_YML, 'utf8');
  } catch {
    console.error(`✗ mic-trend gate-presence: ${CI_YML.replace(ROOT + '/', '')} is missing — the gate must be wired into ci.yml to be green`);
    process.exit(1);
  }
  collectGateRuns()
    .then((runs) => {
      const v = gatePresenceVerdict({ ciYml, runs });
      if (!v.ok) {
        console.error('✗ mic-trend gate-presence: the zero-drop gate is not protecting the trend artifact.');
        for (const e of v.errors) console.error(`  - ${e}`);
        console.error(`  Last execution: ${v.lastExecution ? `run ${v.lastExecution.id} (${v.lastExecution.createdAt.slice(0, 10)})` : 'none in window'}.`);
        process.exit(1);
      }
      console.log(`mic-trend gate-presence: gate wired in ci.yml and executed by run ${v.lastExecution.id} (${v.lastExecution.createdAt.slice(0, 10)}) within ${GATE_PRESENCE_WINDOW_DAYS} days — artifact still guarded`);
    })
    .catch((err) => {
      console.error(`✗ mic-trend gate-presence failed: ${err.message}`);
      process.exit(1);
    });
}

// Import-safe: only run the shell when executed directly.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
