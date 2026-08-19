import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// scripts/verify-live-starter.test.ts — lock verify-live's STARTER-FLOW gate.
//
// The /cook starter is the missing start-from-scratch stage: type what you
// have → create_recipe (real Gemini generation through the deployed route) →
// validation must pass → the recipe persists → one-tap Start cooking launches
// it. verify-live proves that whole chain against the DEPLOYED app, so a
// regression in create → validate → start-cooking fails CI after every deploy.
//
// Same discipline as scripts/verify-live-cleanup.test.ts: read the REAL script
// from disk (never a fixture) and assert the load-bearing pieces survive
// future edits:
//
//   1. create_recipe is driven with a parseable prompt and must return a
//      VALIDATED recipe (validation.valid === true).
//   2. The created recipe must persist to Firestore owner-stamped (the route
//      persists via the recipe store — a persistence regression fails here).
//   3. The probe recipe is RENAMED to a `verify-live-starter-` id: the model
//      generates a human slug (e.g. "simple-chicken-and-rice") that the
//      pre-run sweep's `verify-live-` discriminator would MISS — a killed run
//      would leave a stale ACTIVE session that hijacks /cook. The rename
//      keeps every starter probe first-class to the sweep AND to cleanup.
//   4. Launching the created recipe must land in PREP_GUIDANCE step 1 — the
//      one-tap "Start cooking" path, not a dead end.
//   5. Cleanup tracks BOTH starter artifacts (recipe + session) so they are
//      removed on every exit path like the seeded probe.
// ============================================================================

const SRC = readFileSync('scripts/verify-live.mjs', 'utf8');
const DRIVER = readFileSync('scripts/drive-starter-prefs.mjs', 'utf8');
const COOK_PAGE = readFileSync('app/cook/page.tsx', 'utf8');

describe('scripts/verify-live.mjs · starter-flow gate (create → validate → start cooking)', () => {
  it('drives create_recipe on the deployed route with a parseable prompt', () => {
    // The gate must hit the REAL deployed create_recipe action (not seed a
    // recipe directly) — that is what proves the starter stage works after
    // every deploy.
    expect(SRC).toContain("cookLong('create_recipe', { prompt: 'I have chicken thighs and rice' })");
    // The create call gets a longer budget than the shared 30s helper: Gemini
    // generation on cold serverless can exceed 30s and a fetch abort would
    // fail the gate on a transient, not a regression.
    expect(SRC).toContain('timeoutMs: 120_000');
  });

  it('asserts the created recipe is VALIDATED (validation.valid === true)', () => {
    // The user never hears a recipe as approved until validation succeeds —
    // the gate must enforce the same contract: a created recipe that fails
    // the deterministic engine is a FAIL, not a silent pass.
    expect(SRC).toContain('validation?.valid === true');
    expect(SRC).toContain("ok('created recipe validated (deterministic engine, no errors)')");
    expect(SRC).toContain("fail(`created recipe NOT validated");
  });

  it('reads the created recipe back from Firestore and asserts the owner stamp', () => {
    // create_recipe persists via the recipe store (owner-scoped). The gate
    // must prove persistence: the recipe doc must exist and carry the owner's
    // userId — a persistence regression (e.g. the store write dropped) fails
    // here instead of passing on the API response alone.
    expect(SRC).toContain("db.collection('recipes').doc(createdRecipeId).get()");
    expect(SRC).toContain('createdSnap.data()?.userId !== OWNER_UID');
    expect(SRC).toContain('ok(`created recipe persisted to Firestore, owner-stamped');
  });

  it('renames the probe recipe to a sweep-compatible verify-live-starter- id', () => {
    // The model generates a human slug id ("simple-chicken-and-rice") that
    // would NOT match the pre-run sweep's `verify-live-` discriminator — a
    // killed run's starter session (recipeId = the slug) would be missed and
    // could hijack /cook. Renaming the probe under `verify-live-starter-`
    // (inner id updated, slug doc deleted) keeps every starter artifact
    // first-class to the sweep AND to this script's cleanup.
    expect(SRC).toContain('starterRecipeId = `${PROBE_PREFIX}starter-${t}`');
    expect(SRC).toContain("db.collection('recipes').doc(starterRecipeId).set(renamed)");
    expect(SRC).toContain("db.collection('recipes').doc(createdRecipeId).delete()");
    expect(SRC).toContain('ok(`probe recipe renamed to ${starterRecipeId} (sweep-compatible)`)');
  });

  it('launches the created recipe and asserts PREP_GUIDANCE step 1 (one-tap Start cooking)', () => {
    // The "Start cooking" path must land in the guided flow at prep step 1 —
    // not a dead end. This is the launch half of create → validate →
    // start-cooking.
    expect(SRC).toContain("cook('launch', { recipeId: starterRecipeId })");
    expect(SRC).toContain("launchData.phase === 'PREP_GUIDANCE' && launchData.stepNumber === 1");
    expect(SRC).toContain('ok(`created recipe launched → PREP_GUIDANCE step 1');
  });

  it('tracks BOTH starter artifacts in cleanup (recipe + session)', () => {
    // The starter probe must be removed on EVERY exit path like the seeded
    // one — a run that dies after create/launch must not leave the renamed
    // recipe or its ACTIVE session behind (the pre-run sweep is the backstop
    // for a run that cannot clean up at all).
    expect(SRC).toContain('let starterRecipeId = null;');
    expect(SRC).toContain('let starterSid = null;');
    expect(SRC).toContain("if (starterRecipeId) deletes.push(db.collection('recipes').doc(starterRecipeId).delete());");
    expect(SRC).toContain("if (starterSid) {");
    expect(SRC).toContain("db.collection('cooking_sessions').doc(starterSid).delete()");
    expect(SRC).toContain("db.collection('cooking_session_events').where('sessionId', '==', starterSid).get()");
  });

  it('spawns the UI starter driver (drive-starter-prefs) and requires RESULT: PASS', () => {
    // The [3d] stage drives the REAL /cook UI (headless Chrome): type the
    // preference-rich prompt → Create my recipe → ready card prefs → expand
    // the constraints view. It must spawn the committed driver against the
    // SAME deployed APP this script verifies, with a generous budget (Gemini
    // generation + Chrome launch on cold serverless), and a driver exit
    // WITHOUT `RESULT: PASS` must fail the gate — a UI regression in the
    // ready-card/constraints flow can never silently pass.
    expect(SRC).toContain("spawnSync('node', ['scripts/drive-starter-prefs.mjs', '--app', APP, '--probe-prefix', `${PROBE_PREFIX}starter-prefs-`, '--out', `${driverOut}-${attempt}`], {");
    expect(SRC).toContain('timeout: 300_000');
    expect(SRC).toContain('driver.status === 0 && /RESULT: PASS/.test(driverLog)');
    expect(SRC).toContain("ok('UI starter driver → RESULT: PASS (ready card prefs + constraints view)')");
    expect(SRC).toContain("fail(`UI starter driver → exit ${driver.status ?? 'crash'}");
    // The driver must be swept-account-safe: verify-live's pre-run sweep and
    // this script's own cleanup must NOT be the driver's only safety net.
    expect(SRC).toContain('sweeps its own probe recipe');
  });

  it('isolates the [3d] starter driver in its own namespace and deletes exactly its own recipe', () => {
    // A local run and the deployed CI run share the owner and Firestore. The
    // [3d] driver must NOT pick "the owner's newest updatedAt recipe" — a
    // concurrent CI seed created after the local recipe would be deleted out
    // from under it. It must read the created recipe id off the ready card
    // (data-recipe-id) and delete exactly that doc, renamed under its own
    // probe prefix so a killed run's leftover is swept by the matching sweep.
    expect(DRIVER).toContain("const PROBE_PREFIX = flag('--probe-prefix', 'verify-live-starter-prefs-');");
    expect(DRIVER).toContain("recipeId: btn.getAttribute('data-recipe-id') ?? ''");
    expect(DRIVER).toContain('const createdId = st.recipeId;');
    expect(DRIVER).toContain("db.collection('recipes').doc(createdId).delete()");
    // Never the updatedAt heuristic that could delete a concurrent run's seed.
    expect(DRIVER).not.toContain('.sort((a, b) => (b.data().updatedAt');
  });

  it('exposes the created recipe id on the ready-card Start-cooking button', () => {
    // The driver identifies its probe by data-recipe-id; the page must render
    // it or the driver cannot clean up deterministically.
    expect(COOK_PAGE).toContain('data-recipe-id={starter.ready.recipeId}');
  });

  it('retries the driver ONCE after a 30s backoff on a failed first attempt (transient stalls)', () => {
    // A second consecutive Gemini generation (right after [3b]) can stall on
    // cold serverless — the transient that failed the post-deploy gate once.
    // Mirroring the portfolio's live-gate pattern: a non-PASS first attempt
    // waits 30s and retries once before failing. A deterministic regression
    // fails both attempts; a transient passes on the retry. The final verdict
    // (ok/fail) must come from the LAST attempt's log only.
    expect(SRC).toContain('let driver = runDriver(1);');
    expect(SRC).toContain('retrying once (transient backoff)');
    expect(SRC).toContain('await sleep(30_000)');
    expect(SRC).toContain('driver = runDriver(2);');
    expect(SRC).toContain('timed out after 300s (both attempts)');
  });

  it('asserts the expanded constraints-view rows from the driver log (not a black box)', () => {
    // The transparency half of the gate: verify:live must see the driver
    // click the summary and render all three rows — a driver edit that drops
    // the row assertions while still exiting 0 with RESULT: PASS fails HERE.
    // The markers are deterministic (fixed prompt + extractRecipePreferences).
    expect(SRC).toContain('driverLog.includes(marker)');
    expect(SRC).toContain('ok(`constraints view: ${marker}`)');
    expect(SRC).toContain('fail(`constraints view: missing “${marker}” in the driver log`)');
    expect(SRC).toContain("'details expanded (clicked the summary)'");
    expect(SRC).toContain("'constraint list shows “Servings: 4”'");
    expect(SRC).toContain("'constraint list shows “Diet: vegetarian”'");
    expect(SRC).toContain("'constraint list shows “Allergens avoided: no peanuts”'");
  });

  it('settles the owner to the clean starter BEFORE the UI stage (deletes probe sessions)', () => {
    // Without this, the [3b] stage's freshly launched ACTIVE session would
    // make the driver's fresh /cook load show the CookScreen instead of the
    // starter — the UI gate would fail before it even started. The settle
    // step must delete BOTH probe sessions (the seeded [3] launch and the
    // [3b] starter launch) and their events, then the UI stage starts from
    // the true empty state.
    expect(SRC).toContain('Settling the owner to the clean starter (deleting probe sessions)');
    expect(SRC).toContain('for (const probeSid of [sid, starterSid].filter(Boolean))');
    expect(SRC).toContain("db.collection('cooking_session_events').where('sessionId', '==', probeSid).get()");
    expect(SRC).toContain("db.collection('cooking_sessions').doc(probeSid).delete()");
    expect(SRC).toContain('settled before the UI stage');
    // The [4] pantry flow rides on an ACTIVE session (every agent turn sends
    // sessionId: sid) — the settle deleted both probes, so the flow must
    // re-establish sid by relaunching the seeded recipe before the agent
    // turns, or the pantry confirm would fail with "No cooking session".
    expect(SRC).toContain("cook('launch', { recipeId: seededRecipeId })");
    expect(SRC).toContain('re-established for the agent turns');
  });

  it('also settles leftover sessions that can hijack the starter (slug probes the sweep cannot see)', () => {
    // The pre-run sweep only matches `verify-live-`-prefixed recipeIds — a
    // session launched from a UI-created MODEL-SLUG recipe carries the slug id
    // and escapes BOTH the sweep and the tracked-probe settle. An ACTIVE one
    // hijacks /cook (seen live: a stale `simple-chicken-and-rice-basic`
    // session created by an earlier CI run auto-resumed and failed [3d] for
    // two consecutive runs). The settle must therefore neutralize ANY
    // ACTIVE/PAUSED leftover:
    //   (a) recipe doc gone → delete (a real owner session always references a
    //       real recipe doc, so this can never touch a live cook);
    //   (b) stale (idle > 10 min) → archive as ABANDONED — a real cooking
    //       session is minutes long and actively touched between steps, so an
    //       idle one on the shared dev owner is a leftover probe; this also
    //       backstops a hard-killed run whose probe recipe was cleaned but
    //       whose session escaped.
    expect(SRC).toContain('Also neutralize ANY leftover session that can hijack the starter');
    expect(SRC).toContain("db.collection('cooking_sessions').where('userId', '==', OWNER_UID).get()");
    expect(SRC).toContain("s.status !== 'ACTIVE' && s.status !== 'PAUSED'");
    expect(SRC).toContain("db.collection('recipes').doc(s.recipeId).get()");
    expect(SRC).toContain('const idleCutoff = Date.now() - 10 * 60 * 1000;');
    expect(SRC).toContain('const stale = lastActivity > 0 && lastActivity < idleCutoff;');
    expect(SRC).not.toContain('if (recipeSnap.exists && !stale) continue;');
    // Every archive/delete is CONDITIONAL inside a transaction: the session is
    // re-read and must still be ACTIVE/PAUSED and still stale (the shared
    // owner could have resumed it between our first read and the write) — the
    // unconditional `d.ref.update` the old code used could mark a resumed
    // session ABANDONED. The version field is bumped like updateSession's
    // optimistic check so a racing legitimate update surfaces as a conflict.
    expect(SRC).toContain('db.runTransaction');
    expect(SRC).toContain("if (cur.status !== 'ACTIVE' && cur.status !== 'PAUSED') return;");
    expect(SRC).toContain('if (curLast < idleCutoff)');
    expect(SRC).toContain("status: 'ABANDONED'");
    expect(SRC).toContain('version: (typeof cur.version === \'number\' ? cur.version : 0) + 1');
    // The pre-run sweep (verify-live-* probe sessions only) may keep a plain
    // update — those are unambiguous probe artifacts — but the leftover settle
    // for NON-probe sessions must never use an unconditional write.
    const leftoverSettle = SRC.slice(SRC.indexOf('// Archive (ABANDONED)'), SRC.indexOf('leftover settle best-effort'));
    expect(leftoverSettle).not.toContain("await d.ref.update({ status: 'ABANDONED', lastActivityAt: Date.now() });");
    expect(SRC).toContain('archived before the UI stage');
    expect(SRC).toContain("ok(`orphan-recipe session ${d.id.slice(0, 8)}… (recipe “${s.recipeId.slice(0, 30)}” gone) settled (+ ${events.size} events)`)");
    // A TOOL-FREE conversation session (no recipeId — the orchestrator's
    // start_cooking_session fallback when a turn arrives without one) must
    // NOT escape the settle: it has no recipe doc to check, so the old code
    // skipped it outright and it stayed ACTIVE forever, auto-resuming /cook
    // and hiding the starter on consecutive runs. Stale bare sessions must be
    // archived like stale probes; the blanket `!s.recipeId` skip must not
    // return.
    expect(SRC).toContain('if (typeof s.recipeId !== \'string\' || !s.recipeId)');
    expect(SRC).toContain('stale bare session');
    expect(SRC).toContain('(no recipe, idle');
    expect(SRC).not.toContain('if (typeof s.recipeId !== \'string\' || !s.recipeId) continue;');
  });

  it('self-heals a blocked owner: archives the blocker and retries once instead of failing', () => {
    // After the settle, a FRESH ACTIVE/PAUSED session (a concurrent monitor or
    // voice run inside the 10-min idle window) can still hijack /cook. The
    // guard must NOT fail the run outright: it archives the blocker (so a
    // concurrent-run collision heals THIS run) and retries once, failing only
    // if a blocker survives — always naming it instead of letting the driver
    // report the opaque "starter input not found" cascade.
    expect(SRC).toContain('Pre-stage guard: the UI starter must see a CLEAN owner');
    expect(SRC).toContain('SELF-HEAL');
    expect(SRC).toContain("const findBlocking = async () => {");
    expect(SRC).toContain("db.collection('cooking_sessions').where('userId', '==', OWNER_UID).get()");
    expect(SRC).toContain("return s.status === 'ACTIVE' || s.status === 'PAUSED';");
    expect(SRC).toContain('archiving and retrying once');
    // The archive is transactional and conditional: only a session that is
    // STILL ACTIVE/PAUSED at write time is archived (a resumed session is
    // skipped, never double-fought), and the version bump mirrors
    // updateSession's optimistic check so a racing legitimate update surfaces
    // as a conflict — the same discipline the [3c] leftover settle enforces.
    expect(SRC).toContain('db.runTransaction');
    expect(SRC).toContain("if (cur.status !== 'ACTIVE' && cur.status !== 'PAUSED') return false;");
    expect(SRC).toContain('version: (typeof cur.version === \'number\' ? cur.version : 0) + 1');
    // LIVE_SESSION_GRACE_MS (60s): a session touched within the last minute is
    // a GENUINELY LIVE concurrent run's session — the guard must never archive
    // it (that would yank the other run's /cook session out from under it).
    // Only true leftovers (idle past the grace) are archivable; a live
    // blocker survives the retry and fails THIS run loudly instead.
    expect(SRC).toContain('const LIVE_SESSION_GRACE_MS = 60 * 1000;');
    expect(SRC).toContain("const curLast = typeof cur.lastActivityAt === 'number' ? cur.lastActivityAt : 0;");
    expect(SRC).toContain('if (curLast >= Date.now() - LIVE_SESSION_GRACE_MS) return false;');
    // Retry once: re-query after the archive; clean owner proceeds, a
    // survivor fails loudly named.
    expect(SRC).toContain('archived ${archived} blocking session(s) — retried, owner is clean before the UI starter');
    expect(SRC).toContain('owner still has ${remaining.length} ACTIVE/PAUSED session(s) blocking the UI starter after the archive retry');
    expect(SRC).toContain('could not verify a clean owner before the UI starter');
    // The guard must fire AFTER the [3c] settle and IMMEDIATELY before the
    // [3d] driver spawn — nothing (no new stage label) may sit between the
    // guard and the spawn, so the monitor batch's only collision window is
    // the guard instant itself.
    const guardStart = SRC.indexOf('Pre-stage guard: the UI starter must see a CLEAN owner');
    const settleEnd = SRC.indexOf('leftover settle best-effort');
    const driverSpawn = SRC.indexOf('let driver = runDriver(1);');
    expect(guardStart).toBeGreaterThan(settleEnd);
    expect(driverSpawn).toBeGreaterThan(SRC.indexOf('could not verify a clean owner'));
    expect(SRC.slice(guardStart, driverSpawn)).not.toMatch(/console\.log\(`\n\[/);
  });

  it('names the spared blocker with its idle age in the loud-fail line', () => {
    // The spare path (a genuinely live session inside LIVE_SESSION_GRACE_MS)
    // must fail LOUDLY naming the blocker with its idle age — the exact shape
    // proven live by the guard-spare drill: "✗ FAIL: owner still has 1
    // ACTIVE/PAUSED session(s) blocking the UI starter after the archive
    // retry: drill-li… (COLLECTING_INGREDIENTS, chicken_rice_onion_001, 8s
    // idle)". The describeBlocking output carries id + phase + recipe + idle
    // age, and the fail line must embed those survivors — never a bare count.
    expect(SRC).toContain('const describeBlocking = (d) => {');
    expect(SRC).toContain("const idle = typeof s.lastActivityAt === 'number' ? `${Math.round((Date.now() - s.lastActivityAt) / 1000)}s idle` : 'idle unknown';");
    expect(SRC).toContain("const recipe = typeof s.recipeId === 'string' && s.recipeId ? s.recipeId.slice(0, 30) : 'no recipe';");
    expect(SRC).toContain('return `${d.id.slice(0, 8)}… (${phase}, ${recipe}, ${idle})`;');
    // The survivors embedded in the fail line are describeBlocking output, so
    // the spare line always names the session with its idle age.
    expect(SRC).toContain("const survivors = remaining.map(describeBlocking).join('; ');");
    expect(SRC).toContain('fail(`owner still has ${remaining.length} ACTIVE/PAUSED session(s) blocking the UI starter after the archive retry: ${survivors}`)');
  });

  it('keeps the clean-owner ok line for the unblocked path', () => {
    expect(SRC).toContain('no ACTIVE/PAUSED session before the UI starter (clean owner)');
  });
});
