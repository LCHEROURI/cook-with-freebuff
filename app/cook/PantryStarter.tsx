'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import styles from './page.module.css';

export interface PantryStarterItem {
  id: string;
  name: string;
  quantity?: number;
  unit?: string;
  confidence: number;
  stale: boolean;
  expiresSoon: boolean;
  daysUntilExpiration: number | null;
  requiresConfirmation: boolean;
  selectedByDefault: boolean;
}

export interface PantryStarterSnapshot {
  items: PantryStarterItem[];
  profile: {
    allergies: string[];
    dietaryRestrictions: string[];
    dislikedIngredients: string[];
    preferredCuisines: string[];
    defaultServings?: number;
    preferredEquipment: string[];
  };
}

export interface PantryStarterSelection {
  pantryItemIds: string[];
  confirmedPantryItemIds: string[];
  cuisine?: string;
  maxTimeMinutes?: number;
  craving?: string;
  servings?: number;
}

export interface PantryStarterProps {
  snapshot: PantryStarterSnapshot;
  creating: boolean;
  onCreate(selection: PantryStarterSelection): void;
}

export function PantryStarter(_props: PantryStarterProps) {
  const { snapshot, creating, onCreate } = _props;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmedIds, setConfirmedIds] = useState<string[]>([]);
  const [cuisine, setCuisine] = useState('');
  const [maxTime, setMaxTime] = useState('');
  const [craving, setCraving] = useState('');
  const [servings, setServings] = useState(
    snapshot.profile.defaultServings ? String(snapshot.profile.defaultServings) : '',
  );

  useEffect(() => {
    setSelectedIds(snapshot.items.filter((item) => item.selectedByDefault).map((item) => item.id));
    setConfirmedIds([]);
    setServings(snapshot.profile.defaultServings ? String(snapshot.profile.defaultServings) : '');
  }, [snapshot]);

  if (snapshot.items.length === 0) {
    return (
      <section className={styles.pantryStarter} aria-labelledby="pantry-starter-title">
        <h2 id="pantry-starter-title" className={styles.pantryStarterTitle}>Cook from my pantry</h2>
        <p className={styles.pantryStarterHelp}>
          Your usable pantry is empty. You can still type, speak, or scan ingredients below.
        </p>
        <Link href="/kitchen" className={styles.pantryKitchenLink}>
          Add pantry items in My Kitchen
        </Link>
      </section>
    );
  }

  const toggleItem = (item: PantryStarterItem, checked: boolean) => {
    setSelectedIds((current) => checked
      ? [...current, item.id]
      : current.filter((id) => id !== item.id));
    if (item.requiresConfirmation) {
      setConfirmedIds((current) => checked
        ? [...current, item.id]
        : current.filter((id) => id !== item.id));
    }
  };

  const profileLines = [
    snapshot.profile.allergies.length > 0 ? `Allergies: ${snapshot.profile.allergies.join(', ')}` : '',
    snapshot.profile.dietaryRestrictions.length > 0 ? `Diet: ${snapshot.profile.dietaryRestrictions.join(', ')}` : '',
    snapshot.profile.dislikedIngredients.length > 0 ? `Avoid: ${snapshot.profile.dislikedIngredients.join(', ')}` : '',
    snapshot.profile.preferredEquipment.length > 0 ? `Equipment: ${snapshot.profile.preferredEquipment.join(', ')}` : '',
    snapshot.profile.defaultServings ? `Default: ${snapshot.profile.defaultServings} servings` : '',
  ].filter(Boolean);

  return (
    <section className={styles.pantryStarter} aria-labelledby="pantry-starter-title">
      <div className={styles.pantryStarterHeader}>
        <div>
          <p className={styles.pantryStarterEyebrow}>Your kitchen memory</p>
          <h2 id="pantry-starter-title" className={styles.pantryStarterTitle}>Cook from my pantry</h2>
        </div>
        <Link href="/kitchen" className={styles.pantryEditLink}>Edit kitchen</Link>
      </div>
      <p className={styles.pantryStarterHelp}>
        I selected trusted ingredients. Items that may be out of date stay off until you confirm them.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (selectedIds.length === 0 || creating) return;
          const parsedTime = Number(maxTime);
          const parsedServings = Number(servings);
          onCreate({
            pantryItemIds: selectedIds,
            confirmedPantryItemIds: confirmedIds.filter((id) => selectedIds.includes(id)),
            ...(cuisine.trim() ? { cuisine: cuisine.trim() } : {}),
            ...(Number.isInteger(parsedTime) && parsedTime > 0 ? { maxTimeMinutes: parsedTime } : {}),
            ...(craving.trim() ? { craving: craving.trim() } : {}),
            ...(Number.isInteger(parsedServings) && parsedServings > 0 ? { servings: parsedServings } : {}),
          });
        }}
        className={styles.pantryStarterForm}
      >
        <fieldset className={styles.pantryFieldset} disabled={creating}>
          <legend className={styles.pantryLegend}>Choose ingredients</legend>
          <div className={styles.pantryChoices}>
            {snapshot.items.map((item) => {
              const checked = selectedIds.includes(item.id);
              const label = item.requiresConfirmation
                ? `Confirm and use ${item.name}`
                : `Use ${item.name}`;
              return (
                <label key={item.id} className={styles.pantryChoice}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => toggleItem(item, event.target.checked)}
                    aria-label={label}
                  />
                  <span className={styles.pantryChoiceBody}>
                    <span className={styles.pantryChoiceName}>
                      {item.name}
                      {item.quantity != null ? ` · ${item.quantity}${item.unit ? ` ${item.unit}` : ''}` : ''}
                    </span>
                    <span className={styles.pantryChoiceBadges}>
                      {item.expiresSoon && <span className={styles.pantryBadgeSoon}>Expiring soon</span>}
                      {item.confidence < 1 && (
                        <span className={styles.pantryBadgeConfirm}>
                          Confidence {Math.round(item.confidence * 100)}%
                        </span>
                      )}
                      {item.stale && (
                        <span className={styles.pantryBadgeConfirm}>Freshness check</span>
                      )}
                      {item.requiresConfirmation && (
                        <span className={styles.pantryBadgeConfirm}>Confirm first</span>
                      )}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {profileLines.length > 0 && (
          <div className={styles.pantryProfile} aria-label="Applied kitchen profile">
            <p className={styles.pantryProfileTitle}>Applied automatically</p>
            <ul className={styles.pantryProfileList}>
              {profileLines.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </div>
        )}

        <details className={styles.pantryRefinements}>
          <summary>Refine this recipe</summary>
          <div className={styles.pantryRefinementGrid}>
            <label>
              <span>Cuisine</span>
              <input
                className={styles.starterInput}
                value={cuisine}
                onChange={(event) => setCuisine(event.target.value)}
                maxLength={200}
                aria-label="Cuisine for this recipe"
                placeholder="e.g. Thai"
              />
            </label>
            <label>
              <span>Max time</span>
              <input
                className={styles.starterInput}
                type="number"
                min="1"
                max="1440"
                value={maxTime}
                onChange={(event) => setMaxTime(event.target.value)}
                aria-label="Maximum cooking time in minutes"
                placeholder="minutes"
              />
            </label>
            <label>
              <span>Craving</span>
              <input
                className={styles.starterInput}
                value={craving}
                onChange={(event) => setCraving(event.target.value)}
                maxLength={200}
                aria-label="What are you craving?"
                placeholder="e.g. something comforting"
              />
            </label>
            <label>
              <span>Servings</span>
              <input
                className={styles.starterInput}
                type="number"
                min="1"
                max="50"
                value={servings}
                onChange={(event) => setServings(event.target.value)}
                aria-label="Servings for this recipe"
                placeholder="2"
              />
            </label>
          </div>
        </details>

        <button
          type="submit"
          className={styles.starterBtn}
          disabled={creating || selectedIds.length === 0}
        >
          {creating ? 'Creating…' : 'Create from my pantry'}
        </button>
      </form>
    </section>
  );
}
