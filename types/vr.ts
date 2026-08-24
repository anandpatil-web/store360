/**
 * QWEEN VR Store — core domain types.
 *
 * These types describe *content* (scenes, hotspots, products) and are kept
 * deliberately free of any Three.js / rendering concern so the same data can
 * later be served from a CMS/API without touching the renderer.
 */

/** A point in the scene's local 3D space (metres, right-handed, +Y up). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Yaw/pitch the camera should face when a scene first loads (degrees). */
export interface CameraOrientation {
  /** Rotation around the vertical axis, degrees. 0 looks toward -Z. */
  yaw: number;
  /** Up/down tilt, degrees. Positive looks up. */
  pitch: number;
}

/* ------------------------------------------------------------------ *
 * Environment abstraction (§26 — future-proofing)
 * V1 only implements PanoramaEnvironment. The scene engine must not
 * assume every environment is a panorama forever.
 * ------------------------------------------------------------------ */

export interface PanoramaEnvironment {
  type: 'panorama';
  /**
   * Panorama source. Either a real equirectangular image URL
   * (e.g. "/vr/panoramas/entrance.jpg") or a procedural placeholder
   * descriptor of the form "placeholder://<themeKey>" (V1 ships with these
   * so the experience runs before real photography exists).
   */
  source: string;
}

/** Reserved for a later phase — NOT implemented in V1. */
export interface ThreeDEnvironment {
  type: 'model';
  source: string;
}

export type Environment = PanoramaEnvironment | ThreeDEnvironment;

/* ------------------------------------------------------------------ *
 * Hotspots
 * ------------------------------------------------------------------ */

interface HotspotBase {
  id: string;
  /**
   * World position relative to the user's eye (the camera origin).
   * Convention: the *direction* of this vector decides where on the
   * panorama the marker appears; its length is the comfortable placement
   * distance (3–5 m works well). See docs/HOTSPOTS.md.
   */
  position: Vec3;
}

export interface NavigationHotspot extends HotspotBase {
  type: 'navigation';
  label: string;
  targetSceneId: string;
  /**
   * Visual treatment. `billboard` (default) is the camera-facing diamond
   * marker; `floor` is a flat, floor-anchored luminous projection (a QWEEN
   * "floor pad") that lies parallel to the ground — see lib/vr/floorHotspot.ts.
   */
  style?: 'billboard' | 'floor';
  /** Optional accent colour override (hex). Floor pads default to ice-cyan. */
  color?: string;
}

export interface ProductHotspot extends HotspotBase {
  type: 'product';
  productId: string;
}

/**
 * One featured jewellery piece inside an Experience hotspot's glass card.
 * `productId` optionally links to the existing product catalogue (data/products.ts)
 * / a 3D asset; `image` overrides the catalogue image when provided.
 */
export interface ExperiencePiece {
  /** Optional link to an existing catalogue product (reuses its image / PDP / GLB). */
  productId?: string;
  name?: string;
  /** Image URL or "placeholder://<key>". Falls back to the linked product's image. */
  image?: string;
  /** Very small supporting line, e.g. "1.50 CT · VS". */
  meta?: string;
  /** Optional GLB / 3D asset path for a future product viewer. */
  glb?: string;
}

/**
 * A Persona / Experience discovery point (§Experience Hotspots). Rendered as the
 * same subtle floor pad as navigation hotspots, but activating it raises a
 * fluidic light field and floats a glassmorphism experience card curated around
 * a persona (e.g. "The Diamond Seeker") with 2–4 featured pieces.
 */
export interface ExperienceHotspot extends HotspotBase {
  type: 'experience';
  /** Full display name, e.g. "The Diamond Seeker". */
  name: string;
  /** Short uppercase label shown on the pad / card eyebrow, e.g. "DIAMOND SEEKER". */
  label: string;
  /** Persona / experience category, e.g. "Diamond", "Gemstones", "Persona". */
  category: string;
  /** 2–3 line elegant description (~180 chars). */
  description: string;
  /** 2–4 featured pieces. */
  pieces: ExperiencePiece[];
  /** Optional accent colour override (hex). Defaults to ice-cyan. */
  color?: string;
  /** Optional camera orientation to ease toward when activated (desktop). */
  view?: CameraOrientation;
  /** Inactive hotspots are hidden from the experience (still editable in Tools). */
  active?: boolean;
}

export type VRHotspot = NavigationHotspot | ProductHotspot | ExperienceHotspot;

/* ------------------------------------------------------------------ *
 * Scenes
 * ------------------------------------------------------------------ */

export interface VRScene {
  id: string;
  name: string;
  /** The environment to render. V1 = panorama only. */
  environment: Environment;
  initialCamera?: CameraOrientation;
  hotspots: VRHotspot[];
  /**
   * Optional hint: scene ids likely to be visited next. Used by the texture
   * manager to preload panoramas ahead of navigation.
   */
  preload?: string[];
}

/* ------------------------------------------------------------------ *
 * Products
 * ------------------------------------------------------------------ */

export interface VRProduct {
  id: string;
  name: string;
  /** Price in the smallest sensible unit for display (INR rupees here). */
  price: number;
  currency?: string;
  image: string;
  description?: string;
  /** Short spec line, e.g. "0.50 CT · VS · G". */
  spec?: string;
  category?: string;
  /** External product detail page opened by "View Jewellery". */
  pdpUrl?: string;
}

/* ------------------------------------------------------------------ *
 * Analytics
 * ------------------------------------------------------------------ */

export type AnalyticsEvent =
  | 'session_started'
  | 'vr_entered'
  | 'vr_exited'
  | 'scene_viewed'
  | 'navigation_hotspot_clicked'
  | 'product_hotspot_viewed'
  | 'product_hotspot_clicked'
  | 'product_panel_opened'
  | 'product_panel_closed'
  | 'product_pdp_clicked'
  | 'scene_transition_started'
  | 'scene_transition_completed'
  | 'experience_hotspot_opened'
  | 'experience_hotspot_closed'
  | 'experience_piece_selected';

export interface AnalyticsPayload {
  [key: string]: string | number | boolean | undefined;
}

/** Pluggable analytics sink (§24 — do not couple to a vendor). */
export interface AnalyticsProvider {
  track(event: AnalyticsEvent, payload?: AnalyticsPayload): void;
}
