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

describe('app/cook/page.tsx · protected route', () => {
  it('wires getToken into BOTH data hooks', () => {
    expect(COOK).toContain('const auth = useAuthSession();');
    expect(COOK).toContain('useCookingSession({ getToken: auth.getToken });');
    expect(COOK).toContain('useVoiceSession({ getToken: auth.getToken });');
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

  it('shows the owner’s reusable “Your recipes” list with one-tap relaunch', () => {
    // Generated recipes must be reusable: the starter lists them (newest
    // first) and each row launches a fresh session pinned to that recipe.
    expect(COOK).toContain("action: 'list_recipes'");
    expect(COOK).toContain('Your recipes');
    expect(COOK).toContain('handleStartSavedRecipe(r.recipeId)');
    expect(COOK).toContain('cook.launch(recipeId)');
  });

  it('surfaces the build preferences on each “Your recipes” row', () => {
    // A saved recipe shows what it was built for: the row meta appends the
    // dietary restrictions and allergy line (same copy style as the ready
    // card — “· vegetarian · no peanuts”). The API summary carries them as
    // `preferences` (old recipes get an empty shape, never undefined).
    expect(COOK).toContain('r.preferences?.dietaryRestrictions?.length');
    expect(COOK).toContain('r.preferences?.allergies?.length');
    expect(COOK).toContain("` · ${r.preferences.dietaryRestrictions.join(', ')}`");
    expect(COOK).toContain("` · no ${r.preferences.allergies.join(', no ')}`");
  });

  it('shows an expandable constraint list on the ready card before Start cooking', () => {
    // Transparency: the ready card can expand into a details view listing the
    // generation constraints that were applied (servings, diet, allergens
    // avoided). Only rendered when the prompt carried at least one constraint.
    expect(COOK).toContain('<details className={styles.constraintDetails}>');
    expect(COOK).toContain('Generation constraints applied');
    expect(COOK).toContain("Servings: <strong>{starter.ready.preferences.servings}</strong>");
    expect(COOK).toContain('Diet: {starter.ready.preferences.dietaryRestrictions.join(\', \')}');
    expect(COOK).toContain('Allergens avoided: no {starter.ready.preferences.allergies.join(\', no \')}');
    // The card stays minimal when no constraints were parsed.
    expect(COOK).toContain("starter.ready.preferences.dietaryRestrictions.length > 0 ||");
    expect(COOK).toContain("starter.ready.preferences.allergies.length > 0");
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
});
