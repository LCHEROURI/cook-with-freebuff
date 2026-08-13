import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ============================================================================
// lib/auth/pages-auth-wiring.test.ts — lock the auth architecture across the
// three pages.
//
// The API routes (api/cook, api/agent, api/tools) reject with 401 unless the
// request carries a valid Bearer ID token, and the app now has a real login
// page. If a future edit drops the wiring — a data hook without getToken, a
// protected route that stops redirecting, a login page that stops calling
// signIn — the deployed app silently regresses to the broken "Authentication
// required" state this test exists to prevent.
// ============================================================================

const COOK = readFileSync('app/cook/page.tsx', 'utf8');
const LOGIN = readFileSync('app/login/page.tsx', 'utf8');
const HOME = readFileSync('app/page.tsx', 'utf8');
const KITCHEN = readFileSync('app/kitchen/page.tsx', 'utf8');

describe('app/cook/page.tsx · protected route', () => {
  it('wires getToken into BOTH data hooks', () => {
    expect(COOK).toContain('const auth = useAuthSession();');
    expect(COOK).toContain('useCookingSession({ getToken: auth.getToken });');
    expect(COOK).toContain('useVoiceSession({ getToken: auth.getToken });');
  });

  it('wires real microphone capture while keeping the typed fallback', () => {
    // The mic captures speech → the FINAL transcript goes through the SAME
    // voice.send() → /api/agent path as typed text — the backend flow is
    // untouched. First-party Gemini Live voice is preferred when the browser
    // supports Web Audio; the Web Speech mic and the text input stay as
    // fallbacks. The indicator must show LISTENING while the mic is live.
    expect(COOK).toContain("import { useVoiceInput } from '@/lib/hooks/useVoiceInput'");
    expect(COOK).toContain('const voiceInput = useVoiceInput({');
    expect(COOK).toContain('onFinal: (text) => {');
    expect(COOK).toContain('void voice.send(text);');
    expect(COOK).toContain("import { useGeminiLive, shouldAutoFallbackToWebSpeech } from '@/lib/hooks/useGeminiLive'");
    expect(COOK).toContain('const live = useGeminiLive({');
    expect(COOK).toContain('useLiveMic ? true : voiceInput.supported');
    expect(COOK).toContain('useLiveMic ? live.mode !== \'off\' : voiceInput.listening');
    expect(COOK).toContain('geminiTapRef.current = true;');
    expect(COOK).toContain('void live.toggle();');
    expect(COOK).toContain('shouldAutoFallbackToWebSpeech');
    expect(COOK).toContain("voice.setStatus('LISTENING')");
  });

  it('adds a Live dictation mic to the recipe starter (spoken ingredient brain-dumps)', () => {
    // The STARTER has its own first-party voice entry: a tool-free Gemini Live
    // session whose final transcription fills the starter prompt for review —
    // the model can never act on a spoken prompt before the user confirms.
    // The typed input stays the fallback (the mic renders disabled without
    // Web Audio, exactly like the active-screen mic).
    expect(COOK).toContain("import { useLiveDictation } from '@/lib/hooks/useLiveDictation'");
    expect(COOK).toContain('const dictation = useLiveDictation({');
    expect(COOK).toContain('getToken: auth.getToken');
    // The final transcript lands in the starter prompt (append when the user
    // already typed part of it).
    expect(COOK).toMatch(/onFinal: \(text\) =>[\s\S]{0,120}setStarter\(\(s\) => \(\{/);
    expect(COOK).toContain('prompt: s.prompt.trim() ? `${s.prompt.trim()} ${text.trim()}` : text.trim()');
    expect(COOK).toContain('Speak your ingredients');
    expect(COOK).toContain('dictation.listening');
    expect(COOK).toContain('disabled={!dictation.available || starter.creating || starter.starting}');
    expect(COOK).toContain('dictation.error');
  });

  it('redirects to /login once auth settles with no user', () => {
    expect(COOK).toContain("router.replace('/login')");
    expect(COOK).toContain("if (auth.state === 'ready' && !auth.user)");
  });

  it('never renders cooking UI while signed out', () => {
    // The signed-out branch renders only a "Signing you in…" gate, never the
    // CookScreen or the session empty state.
    expect(COOK).toContain("if (auth.state === 'ready' && !auth.user)");
    expect(COOK).toContain('Signing you in…');
  });

  it('waits for the auth settle before showing the session state', () => {
    expect(COOK).toContain("if (auth.state === 'loading') {");
  });

  it('gives the empty state a working start flow instead of a dead end', () => {
    // The "Start cooking" entry used to dead-end: no session → a static
    // "generate a recipe first" message with no way to do that. The starter
    // turns the empty state into the missing stage: describe what you have →
    // create_recipe (generate + validate) → Start cooking.
    expect(COOK).toContain("action: 'create_recipe'");
    expect(COOK).toContain('What do you have to cook with?');
    expect(COOK).toContain('✨ Create my recipe');
    expect(COOK).toContain('▶ Start cooking');
    expect(COOK).toContain('cook.launch(starter.ready.recipeId)');
  });

  it('shows the first-visit tour on the starter and dismisses it on engagement', () => {
    // New users land on the starter with no idea of the flow — the tour points
    // at the input, the mic, and the create button. It must render ONLY on
    // the starter (no active session), and the page must dismiss it when the
    // user actually engages (types, taps the mic, or submits).
    expect(COOK).toContain("import { StarterTour, dismissStarterTour } from '@/components/StarterTour'");
    expect(COOK).toContain('<StarterTour onDismiss={() => setTourDismissed(true)} />');
    expect(COOK).toContain('tourVisible && !tourDismissed');
    expect(COOK).toContain('dismissStarterTour();');
    expect(COOK).toContain('starter.prompt.trim().length > 0 || dictation.listening');
  });

  it('shows the owner’s reusable “Your recipes” list with one-tap relaunch', () => {
    // Generated recipes must be reusable: the starter lists them (newest
    // first) and each row launches a fresh session pinned to that recipe.
    expect(COOK).toContain("action: 'list_recipes'");
    expect(COOK).toContain('Your recipes');
    expect(COOK).toContain('handleStartSavedRecipe(r.recipeId)');
    expect(COOK).toContain('cook.launch(recipeId)');
  });

  it('renders the extracted RecipeRowMeta on each “Your recipes” row', () => {
    // The meta-line copy (servings · time · ingredients · diet · allergies)
    // lives in app/cook/RecipeRowMeta.tsx and is locked by a RENDERED
    // component test — the page only wires the summary fields in. The inline
    // copy must NOT have drifted back into the page.
    expect(COOK).toContain("import RecipeRowMeta from './RecipeRowMeta'");
    expect(COOK).toContain('<RecipeRowMeta');
    expect(COOK).toContain('servings={r.servings}');
    expect(COOK).toContain('totalMinutes={r.totalMinutes}');
    expect(COOK).toContain('ingredientCount={r.ingredientCount}');
    expect(COOK).toContain('preferences={r.preferences}');
    expect(COOK).not.toContain('r.preferences.dietaryRestrictions.join');
    expect(COOK).not.toContain('r.preferences.allergies.join');
  });

  it('renders the extracted ConstraintDetails component on the ready card', () => {
    // The expand/collapse behavior lives in app/cook/ConstraintDetails.tsx and
    // is locked by a RENDERED component test (jsdom + testing-library) — the
    // page only needs to wire the parsed preferences in. The component is the
    // single source of truth: the page no longer carries the <details> markup.
    expect(COOK).toContain("import ConstraintDetails from './ConstraintDetails'");
    expect(COOK).toContain('<ConstraintDetails preferences={starter.ready.preferences} />');
    // The inline <details> markup must NOT have drifted back into the page.
    expect(COOK).not.toContain('constraintDetails}');
  });
});

describe('app/login/page.tsx · login page', () => {
  it('renders the Google sign-in button wired to auth.signIn', () => {
    expect(LOGIN).toContain('const auth = useAuthSession();');
    expect(LOGIN).toContain('auth.signIn()');
    expect(LOGIN).toContain('Continue with Google');
  });

  it('redirects to /cook when already signed in', () => {
    expect(LOGIN).toContain("router.replace('/cook')");
    expect(LOGIN).toContain("if (auth.state === 'ready' && auth.user)");
  });

  it('displays sign-in errors inline', () => {
    expect(LOGIN).toContain('signInError');
    expect(LOGIN).toContain('role="alert"');
  });
});

describe('app/page.tsx · landing page', () => {
  it('shows Sign in to start when signed out, Start cooking when signed in', () => {
    expect(HOME).toContain('auth.user ?');
    expect(HOME).toContain('href="/login"');
    expect(HOME).toContain('Sign in to start');
    expect(HOME).toContain('Start cooking');
  });

  it('wires the auth session and sign-out', () => {
    expect(HOME).toContain('const auth = useAuthSession();');
    expect(HOME).toContain('auth.signOut()');
  });

  it('links to the kitchen from the signed-in CTA', () => {
    // “My Kitchen” is the inspect-and-change surface for everything the agent
    // remembers — it must stay reachable from the landing page.
    expect(HOME).toContain('href="/kitchen"');
    expect(HOME).toContain('🧺 My kitchen');
  });

  it('links to the saved-recipe browser from the signed-in CTA', () => {
    // “My Recipes” (/recipes) is the searchable saved-recipe surface — it must
    // stay one tap from the landing page alongside Start cooking and My kitchen.
    expect(HOME).toContain('href="/recipes"');
    expect(HOME).toContain('📖 My recipes');
  });

  it('reads the active session on the landing page and shows the resume card', () => {
    // The resume card lets a signed-in user jump back into the current step
    // without opening /cook. Load-bearing: the read goes through the SAME
    // /api/cook 'timers' action /cook's own hook polls (never a client-side
    // Firestore read — it also surfaces finished-timer alerts), it is gated
    // on auth settle like /recipes (no tokenless request from signed-out
    // visitors), and the card links to /cook.
    expect(HOME).toContain("body: JSON.stringify({ action: 'timers' })");
    expect(HOME).toContain("if (auth.state !== 'ready' || !auth.user) return;");
    expect(HOME).toContain('Resume cooking →');
    expect(HOME).toContain('href="/cook"');
    expect(HOME).toContain("import { detectVoiceEngine } from '@/lib/voice/self-check'");
  });

  it('only offers the Pause quick action in phases the server state machine accepts', () => {
    // The server rejects a pause outside PREP_GUIDANCE / COOKING_GUIDANCE /
    // WAITING_FOR_TIMER — the card gates the button on those phases (or being
    // paused, for Resume) so a click can never produce a swallowed error.
    expect(HOME).toContain("const CAN_PAUSE: ReadonlySet<string> = new Set(['PREP_GUIDANCE', 'COOKING_GUIDANCE', 'WAITING_FOR_TIMER']);");
    expect(HOME).toContain('snap.paused || CAN_PAUSE.has(snap.phase)');
    expect(HOME).toContain('canPause && (');
  });

});

describe('app/kitchen/page.tsx · protected kitchen surface', () => {
  it('wires getToken into the data hook and protects the route', () => {
    expect(KITCHEN).toContain('const auth = useAuthSession();');
    expect(KITCHEN).toContain('router.replace(\'/login\')');
    expect(KITCHEN).toContain("if (auth.state === 'ready' && !auth.user)");
    expect(KITCHEN).toContain('Loading your kitchen…');
  });

  it('reads and mutates through /api/kitchen only (never client-side writes)', () => {
    // The screen is a thin client over the backend: every read is the
    // snapshot action and every write is a named mutation — the services
    // execute on the server. Direct Firestore writes from the page would
    // bypass ownership checks and must never appear.
    expect(KITCHEN).toContain("fetch('/api/kitchen'");
    expect(KITCHEN).toContain("{ action: 'snapshot' }");
    for (const action of ['pantry_add', 'pantry_remove', 'pantry_confirm', 'grocery_bought', 'grocery_remove', 'leftover_consume', 'profile_update']) {
      expect(KITCHEN).toContain(`'${action}'`);
    }
  });

  it('renders all four inspect-and-change sections', () => {
    expect(KITCHEN).toContain('🧺 Pantry');
    expect(KITCHEN).toContain('🛒 Grocery list');
    expect(KITCHEN).toContain('🍲 Leftovers');
    expect(KITCHEN).toContain('🥗 Dietary profile');
    expect(KITCHEN).toContain('Save profile');
  });

  it('never renders kitchen UI while signed out', () => {
    expect(KITCHEN).toContain("if (auth.state === 'ready' && !auth.user)");
    expect(KITCHEN).toContain('Signing you in…');
  });
});
