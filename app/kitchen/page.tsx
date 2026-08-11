'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import styles from './kitchen.module.css';
import { useAuthSession } from '@/lib/auth/useAuthSession';
import type { PantryItemView } from '@/lib/server/pantry-service';
import type { GroceryItemSource, DietaryProfile } from '@/lib/domain/types';

// ─────────────────────────────────────────────────────────────────────────────
// /kitchen — "My Kitchen": inspect and change everything the agent remembers.
//   🧺 Pantry      — see quantities + expiry flags, confirm, remove, add
//   🛒 Grocery     — see open lines + their source, mark bought, remove, add
//   🍲 Leftovers   — see what's stored and for how long, consume, log
//   🥗 Profile     — edit allergies / diet / dislikes / cuisines / servings
// Before this screen the ONLY way to read or change any of this was talking
// to the agent and trusting its reply (K8: "allow users to inspect and change
// remembered information"). Every mutation goes through /api/kitchen, which
// executes the existing backend services — never client-side writes.
// ─────────────────────────────────────────────────────────────────────────────

interface GroceryRow {
  id: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  source: GroceryItemSource;
  createdAt: number;
}

interface LeftoverRow {
  id: string;
  title: string;
  servings: number;
  storedDays: number;
  storedAt: number;
  notes: string | null;
}

interface KitchenSnapshot {
  pantry: PantryItemView[];
  grocery: GroceryRow[];
  leftovers: LeftoverRow[];
  profile: DietaryProfile | null;
}

const GROCERY_SOURCE_LABEL: Record<GroceryItemSource, string> = {
  MANUAL: 'Added by you',
  PANTRY_DEPLETION: 'Pantry ran out',
  EXPIRATION: 'Expired item',
};

function quantityLabel(q: number | null | undefined, u: string | null | undefined): string {
  if (q == null) return '';
  return u ? `${q} ${u}` : `${q}`;
}

function GrocerySourceBadge({ source }: { source: GroceryItemSource }) {
  const cls =
    source === 'PANTRY_DEPLETION'
      ? styles.sourceDepleted
      : source === 'EXPIRATION'
        ? styles.sourceExpired
        : styles.sourceManual;
  return <span className={cls}>{GROCERY_SOURCE_LABEL[source]}</span>;
}

export default function KitchenPage() {
  const router = useRouter();
  const auth = useAuthSession();

  const [data, setData] = useState<KitchenSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The action currently in flight — prevents double-submits on every button.
  const [pending, setPending] = useState<string | null>(null);

  // Pantry add form
  const [pantryName, setPantryName] = useState('');
  const [pantryQty, setPantryQty] = useState('');
  const [pantryUnit, setPantryUnit] = useState('');
  // Grocery add form
  const [groceryName, setGroceryName] = useState('');
  const [groceryQty, setGroceryQty] = useState('');
  const [groceryUnit, setGroceryUnit] = useState('');
  // Leftover log form
  const [leftoverTitle, setLeftoverTitle] = useState('');
  const [leftoverServings, setLeftoverServings] = useState('');
  // Profile form
  const [profileAllergies, setProfileAllergies] = useState('');
  const [profileRestrictions, setProfileRestrictions] = useState('');
  const [profileDisliked, setProfileDisliked] = useState('');
  const [profileCuisines, setProfileCuisines] = useState('');
  const [profileServings, setProfileServings] = useState('');

  const refresh = useCallback(async () => {
    try {
      const token = await auth.getToken();
      const res = await fetch('/api/kitchen', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ action: 'snapshot' }),
      });
      const body = (await res.json()) as { success: boolean; data?: KitchenSnapshot; error?: { message?: string } };
      if (!res.ok || !body.success || !body.data) {
        setError(body.error?.message ?? `Could not load your kitchen (${res.status})`);
        return;
      }
      setData(body.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your kitchen.');
    } finally {
      setLoading(false);
    }
  }, [auth]);

  // Seed the profile form from the loaded profile (only until the user edits).
  useEffect(() => {
    if (!data?.profile) return;
    setProfileAllergies((prev) => (prev === '' ? data.profile!.allergies.join(', ') : prev));
    setProfileRestrictions((prev) => (prev === '' ? data.profile!.dietaryRestrictions.join(', ') : prev));
    setProfileDisliked((prev) => (prev === '' ? data.profile!.dislikedIngredients.join(', ') : prev));
    setProfileCuisines((prev) => (prev === '' ? data.profile!.preferredCuisines.join(', ') : prev));
    setProfileServings((prev) => (prev === '' ? String(data.profile!.defaultServings ?? '') : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.profile]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mutate = useCallback(
    async (action: string, payload: Record<string, unknown> = {}) => {
      setPending(action);
      try {
        const token = await auth.getToken();
        const res = await fetch('/api/kitchen', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ action, ...payload }),
        });
        const body = (await res.json()) as { success: boolean; error?: { message?: string } };
        if (!res.ok || !body.success) {
          setError(body.error?.message ?? `That action failed (${res.status})`);
          return;
        }
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That action failed.');
      } finally {
        setPending(null);
      }
    },
    [auth, refresh],
  );

  const qtyNum = (v: string): number | undefined => {
    const n = Number(v);
    return v.trim() === '' || !Number.isFinite(n) || n <= 0 ? undefined : n;
  };

  const unitStr = (v: string): string | undefined => {
    const t = v.trim();
    return t === '' ? undefined : t.slice(0, 50);
  };

  // Protect the route: once auth settles with no user, go sign in.
  useEffect(() => {
    if (auth.state === 'ready' && !auth.user) {
      router.replace('/login');
    }
  }, [auth.state, auth.user, router]);

  if (auth.state === 'loading') {
    return (
      <main className={styles.main}>
        <p className={styles.centered}>Loading your kitchen…</p>
      </main>
    );
  }

  if (auth.state === 'ready' && !auth.user) {
    return (
      <main className={styles.main}>
        <p className={styles.centered}>Signing you in…</p>
      </main>
    );
  }

  if (auth.error) {
    return (
      <main className={styles.main}>
        <section className={styles.empty}>
          <h1 className={styles.title}>My Kitchen</h1>
          <p className={styles.emptyText}>{auth.error}</p>
          <Link href="/" className={styles.backLink}>
            ← Back to start
          </Link>
        </section>
      </main>
    );
  }

  if (loading && !data) {
    return (
      <main className={styles.main}>
        <p className={styles.centered}>Loading your kitchen…</p>
      </main>
    );
  }

  const pantry = data?.pantry ?? [];
  const grocery = data?.grocery ?? [];
  const leftovers = data?.leftovers ?? [];
  const profile = data?.profile ?? null;

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <Link href="/" className={styles.backLink} aria-label="Back to start">
          ←
        </Link>
        <h1 className={styles.title}>My Kitchen</h1>
      </header>
      <p className={styles.subtitle}>
        Everything I remember about your kitchen — you can read it and change it here, no need to ask.
      </p>

      {error && (
        <div className={styles.errorNote} role="alert">
          {error}
        </div>
      )}

      {/* 🧺 Pantry */}
      <section className={styles.card} aria-label="Pantry">
        <h2 className={styles.cardTitle}>🧺 Pantry</h2>
        {pantry.length === 0 ? (
          <p className={styles.emptyText}>
            Nothing in your pantry yet — add an item below or just tell the agent what you have.
          </p>
        ) : (
          <ul className={styles.list}>
            {pantry.map((item) => (
              <li key={item.id} className={styles.row}>
                <div className={styles.rowInfo}>
                  <span className={styles.rowName}>{item.name}</span>
                  {quantityLabel(item.quantity, item.unit) && (
                    <span className={styles.rowMeta}>{quantityLabel(item.quantity, item.unit)}</span>
                  )}
                  <span className={styles.badges}>
                    {item.expired && <span className={styles.badgeDanger}>Expired</span>}
                    {!item.expired && item.expiresSoon && <span className={styles.badgeWarn}>Expiring soon</span>}
                    {item.stale && <span className={styles.badgeNeutral}>Needs confirming</span>}
                  </span>
                </div>
                <div className={styles.rowActions}>
                  {item.stale && (
                    <button
                      type="button"
                      className={styles.smallBtn}
                      onClick={() => void mutate('pantry_confirm', { itemId: item.id })}
                      disabled={pending !== null}
                      aria-label={`Confirm I still have ${item.name}`}
                    >
                      ✓ Have it
                    </button>
                  )}
                  <button
                    type="button"
                    className={`${styles.smallBtn} ${styles.dangerBtn}`}
                    onClick={() => void mutate('pantry_remove', { itemId: item.id })}
                    disabled={pending !== null}
                    aria-label={`Remove ${item.name} from pantry`}
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form
          className={styles.addForm}
          onSubmit={(e) => {
            e.preventDefault();
            if (!pantryName.trim() || pending) return;
            void mutate('pantry_add', {
              name: pantryName.trim(),
              quantity: qtyNum(pantryQty),
              unit: unitStr(pantryUnit),
            }).then(() => {
              setPantryName('');
              setPantryQty('');
              setPantryUnit('');
            });
          }}
        >
          <input
            className={styles.input}
            value={pantryName}
            onChange={(e) => setPantryName(e.target.value)}
            placeholder="e.g. olive oil"
            aria-label="Pantry item name"
            disabled={pending !== null}
          />
          <input
            className={`${styles.input} ${styles.inputSmall}`}
            value={pantryQty}
            onChange={(e) => setPantryQty(e.target.value)}
            placeholder="Qty"
            aria-label="Pantry item quantity"
            disabled={pending !== null}
          />
          <input
            className={`${styles.input} ${styles.inputSmall}`}
            value={pantryUnit}
            onChange={(e) => setPantryUnit(e.target.value)}
            placeholder="Unit"
            aria-label="Pantry item unit"
            disabled={pending !== null}
          />
          <button
            type="submit"
            className={styles.addBtn}
            disabled={pending !== null || pantryName.trim().length === 0}
          >
            + Add
          </button>
        </form>
      </section>

      {/* 🛒 Grocery list */}
      <section className={styles.card} aria-label="Grocery list">
        <h2 className={styles.cardTitle}>🛒 Grocery list</h2>
        {grocery.length === 0 ? (
          <p className={styles.emptyText}>
            Nothing to buy — depleted or expired pantry items land here automatically.
          </p>
        ) : (
          <ul className={styles.list}>
            {grocery.map((item) => (
              <li key={item.id} className={styles.row}>
                <div className={styles.rowInfo}>
                  <span className={styles.rowName}>
                    {item.name}
                    {quantityLabel(item.quantity, item.unit) && (
                      <span className={styles.rowMeta}> {quantityLabel(item.quantity, item.unit)}</span>
                    )}
                  </span>
                  <GrocerySourceBadge source={item.source} />
                </div>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.smallBtn}
                    onClick={() => void mutate('grocery_bought', { itemId: item.id })}
                    disabled={pending !== null}
                    aria-label={`Mark ${item.name} as bought`}
                  >
                    ✓ Bought
                  </button>
                  <button
                    type="button"
                    className={`${styles.smallBtn} ${styles.dangerBtn}`}
                    onClick={() => void mutate('grocery_remove', { itemId: item.id })}
                    disabled={pending !== null}
                    aria-label={`Remove ${item.name} from the grocery list`}
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form
          className={styles.addForm}
          onSubmit={(e) => {
            e.preventDefault();
            if (!groceryName.trim() || pending) return;
            void mutate('grocery_add', {
              name: groceryName.trim(),
              quantity: qtyNum(groceryQty),
              unit: unitStr(groceryUnit),
            }).then(() => {
              setGroceryName('');
              setGroceryQty('');
              setGroceryUnit('');
            });
          }}
        >
          <input
            className={styles.input}
            value={groceryName}
            onChange={(e) => setGroceryName(e.target.value)}
            placeholder="e.g. eggs"
            aria-label="Grocery item name"
            disabled={pending !== null}
          />
          <input
            className={`${styles.input} ${styles.inputSmall}`}
            value={groceryQty}
            onChange={(e) => setGroceryQty(e.target.value)}
            placeholder="Qty"
            aria-label="Grocery item quantity"
            disabled={pending !== null}
          />
          <input
            className={`${styles.input} ${styles.inputSmall}`}
            value={groceryUnit}
            onChange={(e) => setGroceryUnit(e.target.value)}
            placeholder="Unit"
            aria-label="Grocery item unit"
            disabled={pending !== null}
          />
          <button
            type="submit"
            className={styles.addBtn}
            disabled={pending !== null || groceryName.trim().length === 0}
          >
            + Add
          </button>
        </form>
      </section>

      {/* 🍲 Leftovers */}
      <section className={styles.card} aria-label="Leftovers">
        <h2 className={styles.cardTitle}>🍲 Leftovers</h2>
        {leftovers.length === 0 ? (
          <p className={styles.emptyText}>
            Nothing stored — finished meals and anything you log land here.
          </p>
        ) : (
          <ul className={styles.list}>
            {leftovers.map((item) => (
              <li key={item.id} className={styles.row}>
                <div className={styles.rowInfo}>
                  <span className={styles.rowName}>{item.title}</span>
                  <span className={styles.rowMeta}>
                    {item.servings} {item.servings === 1 ? 'serving' : 'servings'}
                    {item.storedDays > 0 ? ` · stored ${item.storedDays}d ago` : ' · stored today'}
                  </span>
                  {item.notes && <span className={styles.rowMeta}>{item.notes}</span>}
                </div>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.smallBtn}
                    onClick={() => void mutate('leftover_consume', { leftoverId: item.id })}
                    disabled={pending !== null}
                    aria-label={`Mark ${item.title} as eaten`}
                  >
                    ✓ Eaten
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form
          className={styles.addForm}
          onSubmit={(e) => {
            e.preventDefault();
            if (!leftoverTitle.trim() || pending) return;
            const servings = Number(leftoverServings);
            void mutate('leftover_log', {
              title: leftoverTitle.trim(),
              servings: Number.isFinite(servings) && servings > 0 ? Math.floor(servings) : 1,
            }).then(() => {
              setLeftoverTitle('');
              setLeftoverServings('');
            });
          }}
        >
          <input
            className={styles.input}
            value={leftoverTitle}
            onChange={(e) => setLeftoverTitle(e.target.value)}
            placeholder="e.g. beef stew"
            aria-label="Leftover title"
            disabled={pending !== null}
          />
          <input
            className={`${styles.input} ${styles.inputSmall}`}
            value={leftoverServings}
            onChange={(e) => setLeftoverServings(e.target.value)}
            placeholder="Servings"
            aria-label="Leftover servings"
            disabled={pending !== null}
          />
          <button
            type="submit"
            className={styles.addBtn}
            disabled={pending !== null || leftoverTitle.trim().length === 0}
          >
            + Log
          </button>
        </form>
      </section>

      {/* 🥗 Dietary profile */}
      <section className={styles.card} aria-label="Dietary profile">
        <h2 className={styles.cardTitle}>🥗 Dietary profile</h2>
        <p className={styles.emptyText}>
          These are applied to every recipe I create for you — allergies and safety first.
        </p>
        <div className={styles.profileGrid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Allergies</span>
            <input
              className={styles.input}
              value={profileAllergies}
              onChange={(e) => setProfileAllergies(e.target.value)}
              placeholder="peanuts, shellfish"
              aria-label="Allergies, comma separated"
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Dietary restrictions</span>
            <input
              className={styles.input}
              value={profileRestrictions}
              onChange={(e) => setProfileRestrictions(e.target.value)}
              placeholder="vegetarian, dairy-free"
              aria-label="Dietary restrictions, comma separated"
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Disliked ingredients</span>
            <input
              className={styles.input}
              value={profileDisliked}
              onChange={(e) => setProfileDisliked(e.target.value)}
              placeholder="cilantro"
              aria-label="Disliked ingredients, comma separated"
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Preferred cuisines</span>
            <input
              className={styles.input}
              value={profileCuisines}
              onChange={(e) => setProfileCuisines(e.target.value)}
              placeholder="italian, mexican"
              aria-label="Preferred cuisines, comma separated"
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Default servings</span>
            <input
              className={styles.input}
              value={profileServings}
              onChange={(e) => setProfileServings(e.target.value)}
              placeholder="2"
              aria-label="Default servings"
            />
          </label>
        </div>
        <button
          type="button"
          className={styles.saveBtn}
          disabled={pending !== null}
          onClick={() => {
            const servings = Number(profileServings);
            void mutate('profile_update', {
              allergies: profileAllergies,
              dietaryRestrictions: profileRestrictions,
              dislikedIngredients: profileDisliked,
              preferredCuisines: profileCuisines,
              defaultServings: Number.isFinite(servings) && servings > 0 ? Math.floor(servings) : undefined,
            });
          }}
        >
          Save profile
        </button>
      </section>

      <Link href="/" className={styles.backLink}>
        ← Back to start
      </Link>
    </main>
  );
}
