import type { ExperiencePiece, Vec3 } from '@/types/vr';

/**
 * Local persistence for hotspot edits made via the in-app editor (pencil icon
 * / ?edit=true): moving, adding, removing and retargeting navigation pads.
 * Runtime edits mutate the in-memory scene graph but are lost on reload;
 * "Save" writes them here so they survive until baked into data/floors.ts.
 *
 * Keyed by scene id → the full navigation-hotspot list for that scene, so a
 * saved scene fully replaces its config-defined pads on load. This is a
 * convenience cache for placement work — the source of truth stays
 * data/floors.ts; copy the exported snippet and paste it back to make edits
 * permanent for everyone.
 */
const KEY = 'qween:hotspot-overrides';

export interface SavedHotspot {
  targetSceneId: string;
  position: Vec3;
  style: 'floor' | 'billboard';
  /** Custom display name shown on the pad. */
  label?: string;
}

/** sceneId → its navigation hotspots. */
export type HotspotOverrides = Record<string, SavedHotspot[]>;

/** A full experience (persona) hotspot, saved locally for the editor. */
export interface SavedExperience {
  id: string;
  name: string;
  label: string;
  category: string;
  description: string;
  position: Vec3;
  pieces: ExperiencePiece[];
  color?: string;
  glowHeight?: number;
  active?: boolean;
}

/** sceneId → its experience hotspots. Kept under a separate key so the nav
 *  override flow is untouched. */
export type ExperienceOverrides = Record<string, SavedExperience[]>;

const EXP_KEY = 'qween:experience-overrides';

export function loadExperienceOverrides(): ExperienceOverrides {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(EXP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as ExperienceOverrides) : {};
  } catch {
    return {};
  }
}

export function saveExperienceOverrides(overrides: ExperienceOverrides): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(EXP_KEY, JSON.stringify(overrides));
  } catch {
    /* ignore */
  }
}

export function loadHotspotOverrides(): HotspotOverrides {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as HotspotOverrides) : {};
  } catch {
    return {};
  }
}

export function saveHotspotOverrides(overrides: HotspotOverrides): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(overrides));
  } catch {
    /* storage full / blocked — ignore, positions still live in memory */
  }
}

export function clearHotspotOverrides(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(KEY);
    window.localStorage.removeItem(EXP_KEY);
  } catch {
    /* ignore */
  }
}
