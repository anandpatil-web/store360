import * as THREE from 'three';
import type {
  CameraOrientation,
  ExperienceHotspot,
  ExperiencePiece,
  NavigationHotspot,
  VRHotspot,
  VRScene,
} from '@/types/vr';
import { getProductById } from '@/data/products';
import { DEFAULT_SCENE_ID, getSceneById } from '@/data/scenes';
import { TextureManager } from './textureManager';
import { HotspotManager } from './hotspotManager';
import { SceneManager } from './sceneManager';
import { ProductPanel3D, type PanelAction } from './productPanel';
import { ExperienceCard3D, type CardAction } from './experienceCard3D';
import { ViewControlsPanel3D, type ViewControlAction } from './viewControlsPanel3D';
import { NadirBlur } from './nadirBlur';
import { loadHotspotOverrides, loadExperienceOverrides } from './hotspotOverrides';
import {
  VR_CONFIG,
  DEG2RAD,
  DEBUG_VIEW_DEFAULTS,
  DEBUG_VIEW_RANGES,
  DEBUG_VIEW_VR_STEPS,
  VERTICAL_LOOK_CONFIG,
  VR_PITCH_LOCK,
} from './config';

export interface DebugInfo {
  sceneId: string | null;
  fps: number;
  xr: 'inactive' | 'active';
  cameraPosition: [number, number, number];
  cameraRotationDeg: [number, number, number];
  loadedTextures: string[];
  hotspotIds: string[];
  hovered: string | null;
  /** Live headset pitch (deg from horizon) while presenting, else null. */
  vrPitchDeg: number | null;
  /** Immersive vertical pitch clamp [min, max] (deg). */
  vrPitchLimitDeg: [number, number];
}

/** One navigation hotspot's editable state, surfaced to the desktop
 *  drag editor (§?edit=true). Positions are camera-relative world units. */
export interface EditableHotspot {
  id: string;
  sceneId: string;
  targetSceneId: string;
  label: string;
  style: 'floor' | 'billboard';
  position: { x: number; y: number; z: number };
}

/** One experience (persona) hotspot's editable state, for the Tools section. */
export interface EditableExperience {
  id: string;
  sceneId: string;
  name: string;
  label: string;
  category: string;
  description: string;
  active: boolean;
  color?: string;
  position: { x: number; y: number; z: number };
  pieces: ExperiencePiece[];
}

/** Current values of the live-tunable "View Controls" debug panel (§ViewControlsPanel). */
export interface ViewTuning {
  eyeHeight: number;
  pitchLimitDeg: number;
  panoramaRadius: number;
  initialPitchDeg: number;
  initialYawDeg: number;
}

export interface EngineCallbacks {
  onReady?: () => void;
  onLoadingProgress?: (fraction: number) => void;
  onSceneChange?: (scene: VRScene) => void;
  onTransitionStart?: (from: string | null, to: string) => void;
  onTransitionComplete?: (scene: VRScene) => void;
  onProductOpen?: (productId: string) => void;
  onProductClose?: () => void;
  onVRSessionChange?: (active: boolean) => void;
  onDebugUpdate?: (info: DebugInfo) => void;
  /** Desktop hotspot editor (§?edit=true): current scene's hotspots + live
   *  positions, emitted on scene load and while dragging. */
  onEditableHotspots?: (hotspots: EditableHotspot[]) => void;
  /** Experience (persona) hotspots in the current scene, for the Tools section. */
  onEditableExperiences?: (experiences: EditableExperience[]) => void;
  /** High-level analytics passthrough — engine reports what happened. */
  onEvent?: (event: string, payload?: Record<string, unknown>) => void;
}

const DEFAULT_RAY_LENGTH = 6;
const CLICK_MOVE_THRESHOLD = 6; // px

/**
 * VRSceneEngine — imperative Three.js renderer for the QWEEN VR store.
 *
 * Deliberately framework-free so it is stable across React re-renders and works
 * identically on desktop (drag-look) and in immersive WebXR (controller rays).
 * React only mounts it, feeds it commands, and reflects its callbacks.
 */
export class VRSceneEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  /** Parent of the panorama + hotspots. Held at identity on desktop; in an
   *  immersive session it is counter-rotated to clamp head pitch (§VR pitch
   *  lock) without ever touching the headset-driven camera. */
  private world = new THREE.Group();
  private camera: THREE.PerspectiveCamera;
  /** Carries the camera + controllers as a unit; only its Y offset is ever
   *  touched (eye height, §ViewControlsPanel). Never rotated — the headset's
   *  own tracked quaternion is always authoritative for orientation. */
  private rig = new THREE.Group();
  private raycaster = new THREE.Raycaster();

  private textures = new TextureManager();
  private hotspots: HotspotManager;
  private sceneManager: SceneManager;
  private panel: ProductPanel3D;
  /** Floating glass persona card (§Experience hotspots). */
  private experienceCard: ExperienceCard3D;
  /** Id of the currently-raised experience hotspot, or null. */
  private activeExperienceId: string | null = null;
  /** In-scene (real 3D geometry) counterpart of the 2D debug ViewControlsPanel
   *  — a DOM overlay is never composited into an immersive session, so this
   *  is the only way to see/use it while actually wearing the headset. */
  private viewControlsPanel3D = new ViewControlsPanel3D();

  // Desktop look state.
  private yaw = 0;
  private pitch = 0;
  /** Hard vertical look bounds (deg from horizon) — the "minPolarAngle /
   *  maxPolarAngle equivalent". Camera pitch is clamped to [min, max] on every
   *  look input, so it stops smoothly at −55° down / +90° up. Configurable via
   *  VERTICAL_LOOK_CONFIG. Yaw (horizontal) is never constrained. Headset
   *  rotation is never clamped in an immersive session. */
  private minPitchDeg: number = VERTICAL_LOOK_CONFIG.minPitchDeg;
  private maxPitchDeg: number = VERTICAL_LOOK_CONFIG.maxPitchDeg;

  /** Immersive (WebXR) vertical pitch clamp — applied to the world rig, never
   *  the headset camera. Yaw is never constrained. See applyVRPitchLock. */
  private vrMinPitchDeg: number = VR_PITCH_LOCK.minPitchDeg;
  private vrMaxPitchDeg: number = VR_PITCH_LOCK.maxPitchDeg;
  /** Last measured headset pitch (deg from horizon) — surfaced in debug. */
  private vrPitchDeg = 0;
  private vrTmpQ = new THREE.Quaternion();
  private vrTmpForward = new THREE.Vector3();

  /** World-fixed soft blur over the floor past the downward limit — replaces
   *  the old world counter-rotation so the environment never slides in VR. */
  private nadirBlur = new NadirBlur(VR_CONFIG.panoramaRadius, VR_PITCH_LOCK.minPitchDeg);

  /** Active desktop look tween (Recenter, or the gentle pre-travel turn
   *  toward a clicked navigation hotspot) — eased, never a snap. Cancelled
   *  the moment the user takes manual control (drag). */
  private lookTween: {
    fromYaw: number;
    fromPitch: number;
    toYaw: number;
    toPitch: number;
    elapsed: number;
    duration: number;
  } | null = null;

  // Live-tunable view settings (debug panel). Defaults mirror VR_CONFIG's
  // production values; setDebug(true) reseeds them from DEBUG_VIEW_DEFAULTS.
  private pitchLimitDeg: number = VR_CONFIG.maxPitchDeg;
  private eyeHeightMeters: number = VR_CONFIG.playerHeight;
  private panoramaRadiusUnits: number = VR_CONFIG.panoramaRadius;
  private dragging = false;

  /** Desktop hotspot editor (§?edit=true). While active, dragging a hotspot
   *  repositions it instead of turning the view, and clicks never navigate. */
  private editMode = false;
  private editorDrag: { marker: THREE.Object3D; hotspot: NavigationHotspot } | null = null;
  /** Monotonic counter for generating unique ids for editor-created hotspots. */
  private hotspotSeq = 0;

  private pointerDown = new THREE.Vector2();
  private lastPointer = new THREE.Vector2();
  private pointerMoved = 0;
  private hoverFromPointer = new THREE.Vector2(0, 0); // NDC

  // Controllers.
  private controllers: THREE.Group[] = [];
  private controllerLines: THREE.Line[] = [];
  private activeController: THREE.Group | null = null;
  /** Rising-edge tracking for the right-hand A/B button (hotspot focus hop). */
  private hotspotHopBtnPrev = false;

  // Timing / debug.
  private clock = new THREE.Clock();
  private elapsed = 0;
  private frames = 0;
  private fpsAccum = 0;
  private fps = 0;
  private debug = false;
  /** True once the View Controls debug baseline has been seeded (see setDebug) —
   *  guards against re-seeding (and wiping) a user's own tuning on every
   *  toggle-off/toggle-on via the top-right gear button. */
  private debugSeeded = false;
  private debugGizmos = new THREE.Group();
  private debugTimer = 0;

  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly cb: EngineCallbacks = {},
  ) {
    // --- Renderer ---
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local');
    container.appendChild(this.renderer.domElement);

    // --- Camera ---
    this.camera = new THREE.PerspectiveCamera(
      VR_CONFIG.desktopFov,
      container.clientWidth / container.clientHeight,
      0.1,
      1000,
    );
    this.camera.position.set(0, 0, 0);
    this.rig.name = 'player-rig';
    this.rig.add(this.camera);
    this.scene.add(this.rig);

    // World rig — parents the panorama + hotspots so the immersive pitch clamp
    // can counter-rotate the whole environment as one. Identity on desktop.
    this.world.name = 'world-rig';
    this.scene.add(this.world);

    // --- Managers ---
    this.hotspots = new HotspotManager(this.textures, (h) => this.resolveHotspotLabel(h));
    this.world.add(this.hotspots.group);

    this.panel = new ProductPanel3D(this.textures);
    this.scene.add(this.panel.group);

    this.experienceCard = new ExperienceCard3D(this.textures);
    this.experienceCard.onClosed = () => {
      this.setCursor(false);
    };
    this.world.add(this.experienceCard.group);

    this.scene.add(this.viewControlsPanel3D.group);

    this.debugGizmos.visible = false;
    this.world.add(this.debugGizmos);

    // Nadir blur cap rides the world rig (world-fixed floor blur).
    this.world.add(this.nadirBlur.mesh);

    this.sceneManager = new SceneManager(
      this.world,
      this.camera,
      this.textures,
      this.hotspots,
      {
        onSceneViewed: (s) => {
          // The experience card is anchored to a hotspot in the old scene —
          // instantly clear it (its marker is gone after the rebuild).
          this.experienceCard.forceHide();
          this.activeExperienceId = null;
          // Saved editor overrides are a local scratchpad — apply them ONLY
          // while editing, never to the live/normal experience (which must
          // always reflect data/floors.ts). Otherwise a stale localStorage
          // save silently shadows the shipped config for that visitor.
          if (this.editMode) this.applyHotspotOverrides(s);
          this.cb.onSceneChange?.(s);
          this.cb.onEvent?.('scene_viewed', { sceneId: s.id });
          this.nadirBlur.setTexture(this.sceneManager.currentTexture);
          if (this.debug) this.rebuildDebugGizmos(s);
          if (this.editMode) {
            this.emitEditable();
            this.emitEditableExperiences();
          }
        },
        onTransitionStart: (from, to) => {
          this.cb.onTransitionStart?.(from, to);
          this.cb.onEvent?.('scene_transition_started', { from: from ?? undefined, to });
        },
        onTransitionComplete: (s) => {
          this.cb.onTransitionComplete?.(s);
          this.cb.onEvent?.('scene_transition_completed', { sceneId: s.id });
        },
        onApplyInitialCamera: (o) => this.applyInitialCamera(o),
        onProgress: (f) => this.cb.onLoadingProgress?.(f),
      },
    );

    this.setupControllers();
    this.setupDesktopInput();
    this.setupResize();
  }

  /* ------------------------------- lifecycle ---------------------------- */

  /** Start rendering and load the first scene. */
  async start(sceneId: string): Promise<void> {
    this.renderer.setAnimationLoop(() => this.frame());
    this.cb.onReady?.();
    await this.sceneManager.goTo(sceneId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.teardownDesktopInput();
    this.resizeObserver?.disconnect();
    this.sceneManager.dispose();
    this.hotspots.dispose();
    this.experienceCard.dispose();
    this.panel.dispose();
    this.viewControlsPanel3D.dispose();
    this.nadirBlur.dispose();
    this.textures.disposeAll();
    this.clearDebugGizmos();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /* --------------------------------- API -------------------------------- */

  goToScene(sceneId: string): void {
    void this.sceneManager.goTo(sceneId);
  }

  /** Tester: preview an arbitrary panorama URL (real path or uploaded file). */
  showPanoramaFromURL(url: string, name: string): void {
    if (this.panel.isOpen()) this.closeProductPanel();
    void this.sceneManager.showCustomPanorama(url, name);
  }

  /** Warm a scene's texture ahead of navigation (floor selector hover, §9). */
  preloadScene(sceneId: string): void {
    const scene = getSceneById(sceneId);
    if (scene) void this.textures.preloadPanorama(scene);
  }

  /**
   * Recenter: ease the desktop look back to the current panorama's
   * recommended starting orientation (its `initialCamera`, or straight
   * ahead). Desktop-only — in an active WebXR session the headset's own
   * tracked orientation is always authoritative.
   */
  recenterView(): void {
    if (this.renderer.xr.isPresenting) return;
    const o = this.sceneManager.currentScene?.initialCamera ?? { yaw: 0, pitch: 0 };
    this.animateLookTo(o.yaw, o.pitch, 500);
  }

  closeProductPanel(): void {
    if (this.panel.isOpen()) {
      const p = this.panel.product();
      this.panel.hide();
      this.cb.onProductClose?.();
      this.cb.onEvent?.('product_panel_closed', { productId: p?.id });
    }
  }

  setDebug(on: boolean): void {
    this.debug = on;
    this.debugGizmos.visible = on;
    if (on && this.sceneManager.currentScene) {
      this.rebuildDebugGizmos(this.sceneManager.currentScene);
    }
    if (on) {
      // Seed the View Controls panel's own baseline (independent of the
      // shipped VR_CONFIG defaults) so a tuning session starts from a known,
      // documented state rather than whatever's currently in production —
      // but only the very first time debug is turned on. The gear button
      // lets the user toggle this on/off repeatedly; re-seeding on every
      // reopen would silently discard whatever they'd already tuned.
      if (!this.debugSeeded) {
        this.debugSeeded = true;
        this.setPitchLimit(DEBUG_VIEW_DEFAULTS.pitchLimitDeg);
        this.setPanoramaRadius(DEBUG_VIEW_DEFAULTS.panoramaRadius);
        this.setEyeHeight(DEBUG_VIEW_DEFAULTS.eyeHeight);
      }
      // If a VR session is already active (debug toggled mid-session), show
      // the in-headset panel immediately rather than waiting for the next
      // enterVR() call.
      if (this.renderer.xr.isPresenting) this.showViewControlsPanel3D();
      // Push an immediate snapshot so the overlay populates without waiting
      // for the throttled loop tick (also helps when the tab is backgrounded).
      this.cb.onDebugUpdate?.(this.getDebugInfo());
    } else {
      this.viewControlsPanel3D.hide();
    }
  }

  /* ------------------------- hotspot editor (desktop) --------------------- */

  /**
   * Enable the desktop drag editor (§?edit=true). While on, pressing on a
   * hotspot and dragging repositions it (floor pads slide across the floor
   * plane; billboards swing around the view sphere at fixed distance) instead
   * of turning the camera, and clicks never navigate. Desktop-only; no effect
   * in an immersive session.
   */
  setEditMode(on: boolean): void {
    this.editMode = on;
    this.editorDrag = null;
    this.setCursor(false);
    this.hotspots.setEditMode(on);
    // Entering edit mode: apply the local saved scratchpad so in-progress edits
    // are visible to keep working on. (Not applied in normal viewing — see
    // onSceneViewed — so the live experience always reflects data/floors.ts.)
    if (on && this.sceneManager.currentScene) {
      this.applyHotspotOverrides(this.sceneManager.currentScene);
    }
    // Relabel the current scene's pads with their destinations (or restore the
    // normal labels when leaving edit mode).
    if (this.sceneManager.currentScene) {
      this.hotspots.setScene(this.sceneManager.currentScene);
    }
    if (on) {
      this.emitEditable();
      this.emitEditableExperiences();
    }
  }

  /** Current scene's navigation hotspots with their live (possibly edited)
   *  positions, for the editor overlay. */
  getEditableHotspots(): EditableHotspot[] {
    const scene = this.sceneManager.currentScene;
    if (!scene) return [];
    return scene.hotspots
      .filter((h): h is NavigationHotspot => h.type === 'navigation')
      .map((h) => ({
        id: h.id,
        sceneId: scene.id,
        targetSceneId: h.targetSceneId,
        label: h.label ?? 'Explore',
        style: h.style ?? 'floor',
        position: {
          x: round(h.position.x),
          y: round(h.position.y),
          z: round(h.position.z),
        },
      }));
  }

  private emitEditable(): void {
    this.cb.onEditableHotspots?.(this.getEditableHotspots());
  }

  /** Apply any locally-saved hotspot edits (moves, adds, removes, retargets)
   *  to a freshly-loaded scene, so editor work survives reloads until baked
   *  into data/floors.ts. A saved scene fully replaces its config-defined
   *  navigation pads; product hotspots are left untouched. */
  private applyHotspotOverrides(scene: VRScene): void {
    const savedNav = loadHotspotOverrides()[scene.id];
    const savedExp = loadExperienceOverrides()[scene.id];
    if ((!savedNav || savedNav.length === 0) && !savedExp) return;

    let next = scene.hotspots;

    if (savedNav && savedNav.length > 0) {
      const nonNav = next.filter((h) => h.type !== 'navigation');
      const navs: NavigationHotspot[] = savedNav.map((s) => ({
        id: `${scene.id}-nav-${this.hotspotSeq++}`,
        type: 'navigation',
        label: s.label ?? 'Explore',
        targetSceneId: s.targetSceneId,
        position: { x: s.position.x, y: s.position.y, z: s.position.z },
        style: s.style,
      }));
      next = [...navs, ...nonNav];
    }

    if (savedExp) {
      const nonExp = next.filter((h) => h.type !== 'experience');
      // In edit mode we keep inactive experiences too (so they stay editable);
      // the live build filters them.
      const exps: ExperienceHotspot[] = savedExp.map((e) => ({
        id: e.id,
        type: 'experience',
        name: e.name,
        label: e.label,
        category: e.category,
        description: e.description,
        pieces: e.pieces.map((p) => ({ ...p })),
        position: { x: e.position.x, y: e.position.y, z: e.position.z },
        active: e.active !== false,
        ...(e.color ? { color: e.color } : {}),
      }));
      next = [...nonExp, ...exps];
    }

    scene.hotspots = next;
    this.hotspots.setScene(scene);
  }

  /** Editor: add a new navigation hotspot to the current scene, pointing at
   *  `targetSceneId`. Appears as a floor pad in front of the viewer, ready to
   *  drag / nudge into place. */
  addHotspot(targetSceneId: string): void {
    const scene = this.sceneManager.currentScene;
    if (!scene) return;
    const h: NavigationHotspot = {
      id: `${scene.id}-nav-${this.hotspotSeq++}`,
      type: 'navigation',
      label: 'Explore',
      targetSceneId,
      position: { x: 0, y: -1.5, z: -3 },
      style: 'floor',
    };
    scene.hotspots = [...scene.hotspots, h];
    this.hotspots.setScene(scene);
    this.emitEditable();
  }

  /** Editor: remove a hotspot from the current scene by id. */
  removeHotspot(id: string): void {
    const scene = this.sceneManager.currentScene;
    if (!scene) return;
    scene.hotspots = scene.hotspots.filter((h) => h.id !== id);
    this.hotspots.setScene(scene);
    this.emitEditable();
  }

  /** Editor: reassign a hotspot's destination scene. */
  setHotspotTarget(id: string, targetSceneId: string): void {
    const scene = this.sceneManager.currentScene;
    if (!scene) return;
    const h = scene.hotspots.find((x) => x.id === id);
    if (!h || h.type !== 'navigation') return;
    h.targetSceneId = targetSceneId;
    this.hotspots.setScene(scene); // relabel the pad with its new destination
    this.emitEditable();
  }

  /** Editor: rename a hotspot (the small label shown on the pad). */
  setHotspotLabel(id: string, label: string): void {
    this.hotspots.setLabelById(id, label);
    this.emitEditable();
  }

  /** Editor: set a hotspot's exact position by id (numeric controls). */
  setHotspotPosition(id: string, pos: { x: number; y: number; z: number }): void {
    this.hotspots.moveHotspotById(id, {
      x: round(pos.x),
      y: round(pos.y),
      z: round(pos.z),
    });
    this.emitEditable();
  }

  /** Editor: nudge one axis of a hotspot by `delta` metres. */
  nudgeHotspot(id: string, axis: 'x' | 'y' | 'z', delta: number): void {
    const h = this.getEditableHotspots().find((e) => e.id === id);
    if (!h) return;
    this.setHotspotPosition(id, { ...h.position, [axis]: h.position[axis] + delta });
  }

  /** Reposition the hotspot currently being dragged from the mouse ray. */
  private dragEditorHotspot(): void {
    const drag = this.editorDrag;
    if (!drag) return;
    this.raycaster.setFromCamera(this.hoverFromPointer, this.camera);
    const ray = this.raycaster.ray;
    const h = drag.hotspot;
    const np = new THREE.Vector3();

    if ((h.style ?? 'floor') === 'floor') {
      // Slide across the floor plane (keep its current height y).
      const y = h.position.y;
      if (Math.abs(ray.direction.y) < 1e-5) return; // parallel to floor
      const t = (y - ray.origin.y) / ray.direction.y;
      if (t <= 0) return; // would land behind camera / above horizon
      np.copy(ray.origin).addScaledVector(ray.direction, t);
      np.y = y;
    } else {
      // Billboard: keep its distance, follow the ray direction on the sphere.
      const dist = Math.hypot(h.position.x, h.position.y, h.position.z) || 4;
      np.copy(ray.direction).normalize().multiplyScalar(dist);
    }

    this.hotspots.moveHotspotObject(drag.marker, { x: np.x, y: np.y, z: np.z });
    this.emitEditable();
  }

  /* ---------------------------- view tuning (debug) ----------------------- */

  /**
   * Live eye-height offset (m). Moves the camera + controller rig's Y
   * position only — the headset's own tracked quaternion (or position) is
   * never touched, so this never fights natural headset tracking.
   */
  setEyeHeight(meters: number): void {
    this.eyeHeightMeters = meters;
    this.rig.position.y = meters - VR_CONFIG.playerHeight;
  }

  /**
   * Max look-up/down angle (deg) for desktop drag/keyboard look. Re-clamps
   * the current pitch immediately if it now exceeds a tighter limit. Has no
   * effect on an active WebXR session — the headset's tracked orientation is
   * never clamped (§ safety requirement: don't fight headset tracking).
   */
  setPitchLimit(deg: number): void {
    this.pitchLimitDeg = deg;
    this.pitch = this.clampPitch(this.pitch);
  }

  /**
   * Clamp a desktop pitch (deg) to the hard vertical bounds
   * [minPitchDeg, maxPitchDeg] (−55°..+90° by default). The debug "Vertical
   * View / Pitch" limit can only tighten these symmetrically, never widen
   * them. Horizontal (yaw) is never touched → full 360° look is preserved.
   * MathUtils.clamp gives a smooth stop at the edge (no snap-back / jitter).
   *
   * Clamping the look *direction* alone isn't enough to satisfy "never see
   * below minPitchDeg": the camera has a field of view, so once the crosshair
   * reaches the raw limit, the *bottom edge* of the frame is already looking
   * roughly halfFov further down than that — e.g. at a 70° FOV, a crosshair
   * clamped to −55° still shows the frame's bottom edge at ≈−90°. So the
   * downward bound is tightened by half the camera's (aspect-independent)
   * vertical FOV, guaranteeing the visible frustum's lower edge never passes
   * minPitchDeg. Upward keeps the plain crosshair limit (no complaint about
   * over-seeing above +90, and half of it is past the zenith anyway).
   */
  private clampPitch(deg: number): number {
    const halfFov = this.camera.fov / 2;
    const down = Math.max(this.minPitchDeg + halfFov, -this.pitchLimitDeg);
    const up = Math.min(this.maxPitchDeg, this.pitchLimitDeg);
    return THREE.MathUtils.clamp(deg, down, up);
  }

  /**
   * Ease the desktop look toward an absolute yaw/pitch (deg) over `ms`,
   * taking the shortest yaw direction. Used for Recenter and the gentle
   * "orient toward destination" turn before a hotspot travel (§3) — never a
   * snap. No-op in an active WebXR session (headset tracking is authoritative).
   */
  private animateLookTo(yawDeg: number, pitchDeg: number, ms: number): void {
    if (this.renderer.xr.isPresenting) return;
    const fromNorm = ((this.yaw % 360) + 360) % 360;
    const toNorm = ((yawDeg % 360) + 360) % 360;
    let delta = toNorm - fromNorm;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    this.lookTween = {
      fromYaw: this.yaw,
      fromPitch: this.pitch,
      toYaw: this.yaw + delta,
      toPitch: this.clampPitch(pitchDeg),
      elapsed: 0,
      duration: ms / 1000,
    };
  }

  /** Advance the active look tween, if any. Desktop-only; see animateLookTo. */
  private updateLookTween(dt: number): void {
    const t = this.lookTween;
    if (!t) return;
    t.elapsed += dt;
    const progress = Math.min(1, t.elapsed / t.duration);
    const eased = easeInOutCubic(progress);
    this.yaw = lerp(t.fromYaw, t.toYaw, eased);
    this.pitch = this.clampPitch(lerp(t.fromPitch, t.toPitch, eased));
    if (progress >= 1) this.lookTween = null;
  }

  /** Live-resize the panorama sphere (units) without reloading the scene. */
  setPanoramaRadius(units: number): void {
    this.panoramaRadiusUnits = units;
    this.sceneManager.setRadius(units);
    this.nadirBlur.setRadius(units);
  }

  /**
   * Snap the current desktop look direction to an explicit yaw/pitch (deg).
   * Only meaningful on desktop: while presenting in VR, `applyDesktopLook()`
   * is skipped every frame (see frame()), so this has no visible effect on
   * the headset — it never overrides the Quest's own tracked quaternion.
   */
  setLookOrientation(yawDeg: number, pitchDeg: number): void {
    this.yaw = yawDeg;
    this.pitch = this.clampPitch(pitchDeg);
  }

  /** Current values of the live-tunable view settings, for the debug panel. */
  getViewTuning(): ViewTuning {
    return {
      eyeHeight: this.eyeHeightMeters,
      pitchLimitDeg: this.pitchLimitDeg,
      panoramaRadius: this.panoramaRadiusUnits,
      initialPitchDeg: this.pitch,
      initialYawDeg: this.yaw,
    };
  }

  /** Spawn the in-headset View Controls panel in front of the user's current gaze. */
  private showViewControlsPanel3D(): void {
    const head = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
    const headPos = head.getWorldPosition(new THREE.Vector3());
    const forward = head.getWorldDirection(new THREE.Vector3());
    forward.y = 0;
    if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1);
    forward.normalize();
    const position = headPos.clone().addScaledVector(forward, 1.9);
    position.y = headPos.y - 0.1;
    this.viewControlsPanel3D.show(this.getViewTuning(), position, headPos);
  }

  /** Step one field by its configured VR tap size, clamped to its range. */
  private stepViewTuning(field: keyof ViewTuning, dir: 1 | -1): void {
    const t = this.getViewTuning();
    const range = DEBUG_VIEW_RANGES[field];
    const step = DEBUG_VIEW_VR_STEPS[field];
    const next = THREE.MathUtils.clamp(t[field] + dir * step, range.min, range.max);
    switch (field) {
      case 'eyeHeight':
        this.setEyeHeight(next);
        break;
      case 'pitchLimitDeg':
        this.setPitchLimit(next);
        break;
      case 'panoramaRadius':
        this.setPanoramaRadius(next);
        break;
      case 'initialPitchDeg':
        this.setLookOrientation(t.initialYawDeg, next);
        break;
      case 'initialYawDeg':
        this.setLookOrientation(next, t.initialPitchDeg);
        break;
    }
    this.viewControlsPanel3D.updateValues(this.getViewTuning());
  }

  /** Restore the debug panel's own defaults (Initial Yaw resets to the current scene's configured yaw). */
  private resetViewTuning(): void {
    const yaw = this.sceneManager.currentScene?.initialCamera?.yaw ?? 0;
    this.setEyeHeight(DEBUG_VIEW_DEFAULTS.eyeHeight);
    this.setPitchLimit(DEBUG_VIEW_DEFAULTS.pitchLimitDeg);
    this.setPanoramaRadius(DEBUG_VIEW_DEFAULTS.panoramaRadius);
    this.setLookOrientation(yaw, DEBUG_VIEW_DEFAULTS.initialPitchDeg);
    this.viewControlsPanel3D.updateValues(this.getViewTuning());
  }

  private handleViewControlsAction(action: ViewControlAction): void {
    if (action.kind === 'reset') {
      this.resetViewTuning();
    } else {
      this.stepViewTuning(action.field, action.dir);
    }
  }

  /** Request an immersive-vr session (§8). Rejects if unsupported. */
  async enterVR(): Promise<void> {
    if (!('xr' in navigator) || !navigator.xr) throw new Error('WebXR not available');
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    });
    await this.renderer.xr.setSession(session);
    this.cb.onVRSessionChange?.(true);
    this.cb.onEvent?.('vr_entered');
    // Floor blur only matters in VR (desktop hard-clamps above the limit).
    this.nadirBlur.setTexture(this.sceneManager.currentTexture);
    this.nadirBlur.setVisible(true);
    if (this.debug) this.showViewControlsPanel3D();
    session.addEventListener('end', () => {
      this.cb.onVRSessionChange?.(false);
      this.cb.onEvent?.('vr_exited');
      this.viewControlsPanel3D.hide();
      this.nadirBlur.setVisible(false);
      // Drop any residual pitch-clamp rotation so desktop view is upright.
      this.world.quaternion.identity();
    });
  }

  getDebugInfo(): DebugInfo {
    const rot = this.camera.rotation;
    const pos = this.camera.getWorldPosition(new THREE.Vector3());
    const scene = this.sceneManager.currentScene;
    return {
      sceneId: scene?.id ?? null,
      fps: Math.round(this.fps),
      xr: this.renderer.xr.isPresenting ? 'active' : 'inactive',
      cameraPosition: [round(pos.x), round(pos.y), round(pos.z)],
      cameraRotationDeg: [
        round(rot.x / DEG2RAD),
        round(rot.y / DEG2RAD),
        round(rot.z / DEG2RAD),
      ],
      loadedTextures: this.textures.loadedSceneIds(),
      hotspotIds: scene?.hotspots.map((h) => h.id) ?? [],
      hovered: this.hotspots.hoveredHotspot()?.id ?? null,
      vrPitchDeg: this.renderer.xr.isPresenting ? round(this.vrPitchDeg) : null,
      vrPitchLimitDeg: [this.vrMinPitchDeg, this.vrMaxPitchDeg],
    };
  }

  /* ------------------------------ render loop ---------------------------- */

  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.elapsed += dt;

    this.sceneManager.update(dt);
    this.hotspots.update(this.elapsed);
    this.experienceCard.update(dt);

    if (this.renderer.xr.isPresenting) {
      // Clamp head pitch by counter-rotating the world — after this frame's
      // headset pose is available (three updates the XR camera before this
      // callback) and before render(). Never touches the camera pose.
      this.applyVRPitchLock();
      this.pollControllerButtons();
      this.updateControllerHover();
    } else {
      if (!this.dragging) this.updateLookTween(dt);
      this.applyDesktopLook();
      this.updatePointerHover();
    }

    // FPS.
    this.frames += 1;
    this.fpsAccum += dt;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.frames / this.fpsAccum;
      this.frames = 0;
      this.fpsAccum = 0;
    }

    // Throttled debug push.
    if (this.debug) {
      this.debugTimer += dt;
      if (this.debugTimer >= 0.25) {
        this.debugTimer = 0;
        this.cb.onDebugUpdate?.(this.getDebugInfo());
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  /* ------------------------------- desktop ------------------------------ */

  private applyDesktopLook(): void {
    const euler = new THREE.Euler(this.pitch * DEG2RAD, this.yaw * DEG2RAD, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(euler);
  }

  /**
   * Immersive (WebXR) floor treatment. The headset owns the camera pose and a
   * real head can't be "stopped" from tilting down — the earlier approach
   * counter-rotated the whole world past the limit, which made the entire
   * panorama slide with the head (the "image moves with me" discomfort).
   *
   * Instead the world is left perfectly still and the floor past the downward
   * limit is softly *blurred* (never darkened) by a world-fixed cap
   * (see NadirBlur). This method only measures head pitch for the debug HUD;
   * the blur itself is geometric (the cap covers the sub-limit region) so no
   * per-frame update is needed. The world rig is held at identity so nothing
   * ever slides.
   */
  private applyVRPitchLock(): void {
    this.world.quaternion.identity();

    const xrCam = this.renderer.xr.getCamera();
    xrCam.getWorldQuaternion(this.vrTmpQ);
    this.vrTmpForward.set(0, 0, -1).applyQuaternion(this.vrTmpQ);
    const pitch = Math.asin(THREE.MathUtils.clamp(this.vrTmpForward.y, -1, 1));
    this.vrPitchDeg = pitch / DEG2RAD;
  }

  private applyInitialCamera(o: CameraOrientation): void {
    // Only meaningful on desktop; in VR the headset owns orientation (§23 — no
    // forced camera movement).
    if (this.renderer.xr.isPresenting) return;
    this.yaw = o.yaw;
    this.pitch = this.clampPitch(o.pitch);
  }

  private updatePointerHover(): void {
    if (this.dragging) return;
    this.raycaster.setFromCamera(this.hoverFromPointer, this.camera);
    this.resolveHover();
  }

  private setupDesktopInput(): void {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointerleave', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
  }

  private teardownDesktopInput(): void {
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointerleave', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
  }

  private onPointerDown = (e: PointerEvent) => {
    if (this.renderer.xr.isPresenting) return;
    this.lookTween = null;
    this.pointerMoved = 0;
    this.pointerDown.set(e.clientX, e.clientY);
    this.lastPointer.set(e.clientX, e.clientY);
    // Seed the pick ray from the press location. On touch a tap often fires no
    // pointermove first, so without this a tap would select from a stale point
    // (the last hover / screen centre) and miss — breaking tap-to-navigate.
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.hoverFromPointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );

    // Editor: pressing on a hotspot grabs it for dragging instead of turning
    // the view. Anything else falls through to normal look-drag.
    if (this.editMode) {
      this.raycaster.setFromCamera(this.hoverFromPointer, this.camera);
      const hit = this.hotspots.raycast(this.raycaster);
      if (hit && hit.hotspot.type === 'navigation') {
        this.editorDrag = { marker: hit.object, hotspot: hit.hotspot };
        this.container.style.cursor = 'grabbing';
        return;
      }
    }

    this.dragging = true;
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.renderer.xr.isPresenting) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.hoverFromPointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );

    // Editor: drag the grabbed hotspot to the mouse ray.
    if (this.editorDrag) {
      this.pointerMoved += 10;
      this.dragEditorHotspot();
      return;
    }

    if (this.dragging) {
      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.pointerMoved += Math.abs(dx) + Math.abs(dy);
      this.yaw -= dx * VR_CONFIG.dragSensitivity;
      this.pitch = this.clampPitch(this.pitch - dy * VR_CONFIG.dragSensitivity);
      this.lastPointer.set(e.clientX, e.clientY);
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.renderer.xr.isPresenting) return;

    // Editor: finish a hotspot drag (never navigates).
    if (this.editorDrag) {
      this.editorDrag = null;
      this.container.style.cursor = 'grab';
      this.emitEditable();
      return;
    }

    const wasClick =
      this.dragging &&
      this.pointerMoved < CLICK_MOVE_THRESHOLD &&
      Math.abs(e.clientX - this.pointerDown.x) < CLICK_MOVE_THRESHOLD &&
      Math.abs(e.clientY - this.pointerDown.y) < CLICK_MOVE_THRESHOLD;
    this.dragging = false;
    // In edit mode, clicks never navigate — the panorama is a placement canvas.
    if (wasClick && !this.editMode) {
      this.raycaster.setFromCamera(this.hoverFromPointer, this.camera);
      this.performSelect();
    }
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.renderer.xr.isPresenting) return;
    if (e.key === 'ArrowLeft') this.yaw += VR_CONFIG.keyboardYawStep;
    else if (e.key === 'ArrowRight') this.yaw -= VR_CONFIG.keyboardYawStep;
    else if (e.key === 'ArrowUp')
      this.pitch = this.clampPitch(this.pitch + VR_CONFIG.keyboardYawStep);
    else if (e.key === 'ArrowDown')
      this.pitch = this.clampPitch(this.pitch - VR_CONFIG.keyboardYawStep);
    else if (e.key === 'Escape') {
      if (this.experienceCard.isOpen()) this.closeExperience();
      else this.closeProductPanel();
    } else if (e.key === 'h' || e.key === 'H') this.goHome();
  };

  /* ----------------------------- controllers ---------------------------- */

  private setupControllers(): void {
    const rayGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ]);

    for (let i = 0; i < 2; i++) {
      const controller = this.renderer.xr.getController(i);
      const lineMat = new THREE.LineBasicMaterial({
        color: 0xc9a15a,
        transparent: true,
        opacity: 0.6,
        depthTest: false,
      });
      const line = new THREE.Line(rayGeo.clone(), lineMat);
      line.scale.z = DEFAULT_RAY_LENGTH;
      line.renderOrder = 30;
      controller.add(line);

      controller.addEventListener('selectstart', () => {
        this.activeController = controller;
      });
      controller.addEventListener('select', () => {
        this.setRaycasterFromController(controller);
        this.performSelect();
      });
      // Squeeze / grip ("pinch") on either controller → go home.
      controller.addEventListener('squeeze', () => this.goHome());

      // Part of the rig so a debug eye-height offset moves controllers with
      // the camera as one unit.
      this.rig.add(controller);
      this.controllers.push(controller);
      this.controllerLines.push(line);
    }
  }

  private setRaycasterFromController(controller: THREE.Group): void {
    const m = controller.matrixWorld;
    this.raycaster.ray.origin.setFromMatrixPosition(m);
    this.raycaster.ray.direction.set(0, 0, -1).transformDirection(m);
  }

  private updateControllerHover(): void {
    let hoveredAny = false;
    for (let i = 0; i < this.controllers.length; i++) {
      const controller = this.controllers[i]!;
      const line = this.controllerLines[i]!;
      if (!controller.visible) {
        line.scale.z = DEFAULT_RAY_LENGTH;
        continue;
      }
      this.setRaycasterFromController(controller);

      // Prefer the first controller that hits something interactive.
      const distance = this.resolveHover();
      if (distance !== null && !hoveredAny) {
        hoveredAny = true;
        line.scale.z = distance;
        this.activeController = controller;
      } else {
        line.scale.z = DEFAULT_RAY_LENGTH;
      }
    }
    if (!hoveredAny) {
      // Nothing hovered anywhere — make sure highlights clear.
      this.hotspots.setHovered(null);
      this.panel.setHoveredAction(null);
      this.viewControlsPanel3D.setHovered(null);
    }
  }

  /**
   * Poll the controller face buttons each frame (WebXR has no button event, so
   * we edge-detect `pressed`). Pressing A jumps to the next view — it advances
   * to the next navigation hotspot in the scene and travels there, so a single
   * button changes views without having to aim the ray at a small floor pad.
   *
   * On the standard Touch mapping buttons[4] = A (right) / X (left) and
   * buttons[5] = B / Y. Detection is deliberately broad: any face button
   * (index ≥ 4) on the right controller — and, as a fallback, the left — so it
   * responds regardless of which index a given runtime reports for A.
   */
  private pollControllerButtons(): void {
    const session = this.renderer.xr.getSession();
    if (!session) return;
    let pressed = false;
    for (const src of session.inputSources) {
      if (!src.gamepad) continue;
      const b = src.gamepad.buttons;
      for (let i = 4; i < b.length; i++) {
        if (b[i]?.pressed) {
          pressed = true;
          break;
        }
      }
    }
    if (pressed && !this.hotspotHopBtnPrev) this.hopToNextView();
    this.hotspotHopBtnPrev = pressed;
  }

  /** Advance to the next navigation hotspot in the scene and travel to it. */
  private hopToNextView(): void {
    const next = this.hotspots.focusNext();
    if (!next) return;
    this.cb.onEvent?.('navigation_hotspot_focused', { hotspotId: next.id });
    this.activateHotspot(next);
  }

  /* --------------------------- shared interaction ----------------------- */

  /**
   * Resolve what the current `raycaster` is pointing at (panel buttons take
   * priority when the panel is open), update hover highlights, and return the
   * hit distance (or null if nothing interactive).
   */
  private resolveHover(): number | null {
    // View Controls panel (debug) first — it's a persistent tool while open.
    if (this.viewControlsPanel3D.isOpen()) {
      const hit = this.viewControlsPanel3D.raycast(this.raycaster);
      this.viewControlsPanel3D.setHovered(hit?.object ?? null);
      if (hit) {
        this.panel.setHoveredAction(null);
        this.hotspots.setHovered(null);
        this.setCursor(true);
        return 1.9;
      }
    }

    // Experience card — while open, its close / explore / piece targets win.
    if (this.experienceCard.isOpen()) {
      const action = this.experienceCard.raycast(this.raycaster);
      this.experienceCard.setHovered(action);
      if (action) {
        this.panel.setHoveredAction(null);
        this.hotspots.setHovered(null);
        this.setCursor(true);
        return this.experienceCard.group.getWorldPosition(new THREE.Vector3()).length() || 1.4;
      }
      // Still allow hotspot hover around the card.
    }

    // Panel buttons first.
    if (this.panel.isOpen()) {
      const action = this.panel.raycast(this.raycaster);
      this.panel.setHoveredAction(action);
      this.hotspots.setHovered(null);
      if (action) {
        this.setCursor(true);
        return VR_CONFIG.productPanel.distance;
      }
      // Still allow hotspot hover behind/around the panel.
    }

    const hit = this.hotspots.raycast(this.raycaster);
    if (hit) {
      this.hotspots.setHovered(hit.object);
      this.setCursor(true);
      const d = hit.object.getWorldPosition(new THREE.Vector3()).length();
      return d || DEFAULT_RAY_LENGTH;
    }

    this.hotspots.setHovered(null);
    this.setCursor(false);
    return null;
  }

  /** Act on whatever the current `raycaster` points at. */
  private performSelect(): void {
    // 1) View Controls panel (debug).
    if (this.viewControlsPanel3D.isOpen()) {
      const hit = this.viewControlsPanel3D.raycast(this.raycaster);
      if (hit) {
        this.handleViewControlsAction(hit.action);
        return;
      }
    }

    // 2) Experience card (close / explore / piece).
    if (this.experienceCard.isOpen()) {
      const action = this.experienceCard.raycast(this.raycaster);
      if (action) {
        this.handleCardAction(action);
        return;
      }
    }

    // 3) Product panel buttons.
    if (this.panel.isOpen()) {
      const action = this.panel.raycast(this.raycaster);
      if (action) {
        this.handlePanelAction(action);
        return;
      }
    }

    // 4) Hotspots. Prefer whatever the ray is pointing at; otherwise fall back
    //    to the B-button-focused hotspot (no-aim selection, see cycleHotspotFocus).
    const hit = this.hotspots.raycast(this.raycaster);
    const h = hit?.hotspot ?? this.hotspots.focusedHotspot();
    if (!h) return;
    this.activateHotspot(h);
  }

  /** Handle a click inside the experience card. */
  private handleCardAction(action: CardAction): void {
    if (action.kind === 'close') {
      this.closeExperience();
      return;
    }
    const scene = this.sceneManager.currentScene;
    const exp = scene?.hotspots.find(
      (x): x is Extract<VRHotspot, { type: 'experience' }> =>
        x.type === 'experience' && x.id === this.activeExperienceId,
    );
    if (!exp) return;

    if (action.kind === 'piece') {
      const piece = exp.pieces[action.index];
      if (!piece) return;
      this.cb.onEvent?.('experience_piece_selected', {
        hotspotId: exp.id,
        productId: piece.productId,
        name: piece.name,
      });
      // If the piece links a catalogue product with a PDP, open it.
      const product = piece.productId ? getProductById(piece.productId) : undefined;
      if (product?.pdpUrl && typeof window !== 'undefined') {
        window.open(product.pdpUrl, '_blank', 'noopener,noreferrer');
      }
    } else {
      // Explore experience — open the PDP of the first linked product if any.
      const linked = exp.pieces.find((p) => p.productId);
      const product = linked?.productId ? getProductById(linked.productId) : undefined;
      if (product?.pdpUrl && typeof window !== 'undefined') {
        window.open(product.pdpUrl, '_blank', 'noopener,noreferrer');
      }
    }
  }

  /** Travel to a navigation hotspot, open a product panel, or raise an
   *  experience (persona) card. */
  private activateHotspot(h: VRHotspot): void {
    if (h.type === 'navigation') {
      this.cb.onEvent?.('navigation_hotspot_clicked', {
        hotspotId: h.id,
        targetSceneId: h.targetSceneId,
      });
      // Close any open panel/card before travelling.
      if (this.panel.isOpen()) this.closeProductPanel();
      if (this.experienceCard.isOpen()) this.closeExperience();
      // Gently orient toward the destination (§3) — plays out while the
      // scene fades to black, so it's felt but never blocks the transition.
      // A floor pad sits on the ground, so orient by heading only (level
      // pitch) — "walk forward", never tip the gaze down to the floor.
      const { yaw, pitch } = directionToYawPitch(h.position);
      this.animateLookTo(yaw, h.style === 'floor' ? 0 : pitch, 300);
      this.sceneManager.goTo(h.targetSceneId);
    } else if (h.type === 'experience') {
      this.openExperience(h);
    } else {
      this.openProduct(h);
    }
  }

  /**
   * Raise an experience (persona) hotspot: ignite the floor's fluidic rays,
   * float the glass card anchored above the hotspot (oriented to the user
   * once), and gently orient the desktop look toward it. Activating a second
   * hotspot dismisses the first.
   */
  private openExperience(h: Extract<VRHotspot, { type: 'experience' }>): void {
    if (this.experienceCard.currentHotspotId() === h.id && this.experienceCard.isOpen()) return;

    // Dismiss any other open experience (and its energy) first.
    if (this.activeExperienceId && this.activeExperienceId !== h.id) {
      this.hotspots.floorFor(this.activeExperienceId)?.setEnergy(0);
    }
    if (this.panel.isOpen()) this.closeProductPanel();

    this.activeExperienceId = h.id;
    this.hotspots.floorFor(h.id)?.setEnergy(1);

    // Anchor above + slightly toward the user from the hotspot's world position.
    const head = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
    const headPos = head.getWorldPosition(new THREE.Vector3());
    const hotPos = this.hotspots.worldPositionOf(h.id) ??
      new THREE.Vector3(h.position.x, h.position.y, h.position.z);
    const toUser = headPos.clone().sub(hotPos);
    toUser.y = 0;
    if (toUser.lengthSq() < 1e-4) toUser.set(0, 0, 1);
    toUser.normalize();
    const cardPos = hotPos.clone().addScaledVector(toUser, 0.6);
    cardPos.y = headPos.y - 0.15; // just below eye level, floating above the pad
    const lookAt = new THREE.Vector3(headPos.x, cardPos.y, headPos.z);

    // Rays rise first; the card forms a beat later out of the light field.
    window.setTimeout(() => {
      if (this.activeExperienceId === h.id) this.experienceCard.show(h, cardPos, lookAt);
    }, 160);

    // Gently face the hotspot on desktop (VR keeps head control).
    if (h.view) this.animateLookTo(h.view.yaw, h.view.pitch, 450);
    else {
      const { yaw } = directionToYawPitch(h.position);
      this.animateLookTo(yaw, 0, 450);
    }

    this.cb.onEvent?.('experience_hotspot_opened', { hotspotId: h.id });
  }

  /** Dismiss the active experience card (reverse fluidic animation). */
  closeExperience(): void {
    if (!this.activeExperienceId) return;
    const id = this.activeExperienceId;
    this.experienceCard.startDismiss();
    // Retract the rays a touch after the card starts collapsing.
    window.setTimeout(() => {
      if (this.activeExperienceId === id) this.hotspots.floorFor(id)?.setEnergy(0);
    }, 220);
    this.cb.onEvent?.('experience_hotspot_closed', { hotspotId: id });
    this.activeExperienceId = null;
  }

  /* --------------------- experience editing (Tools) --------------------- */

  private get sceneExperiences(): ExperienceHotspot[] {
    const scene = this.sceneManager.currentScene;
    if (!scene) return [];
    return scene.hotspots.filter((h): h is ExperienceHotspot => h.type === 'experience');
  }

  /** Current scene's experience hotspots for the Tools list/editor. */
  getEditableExperiences(): EditableExperience[] {
    const scene = this.sceneManager.currentScene;
    if (!scene) return [];
    return this.sceneExperiences.map((h) => ({
      id: h.id,
      sceneId: scene.id,
      name: h.name,
      label: h.label,
      category: h.category,
      description: h.description,
      active: h.active !== false,
      color: h.color,
      position: { x: round(h.position.x), y: round(h.position.y), z: round(h.position.z) },
      pieces: h.pieces.map((p) => ({ ...p })),
    }));
  }

  private emitEditableExperiences(): void {
    this.cb.onEditableExperiences?.(this.getEditableExperiences());
  }

  /** Tools: add a new experience hotspot to the current scene. */
  addExperience(): string | null {
    const scene = this.sceneManager.currentScene;
    if (!scene) return null;
    const id = `${scene.id}-exp-${Date.now().toString(36)}`;
    const h: ExperienceHotspot = {
      id,
      type: 'experience',
      name: 'New Experience',
      label: 'EXPERIENCE',
      category: 'Persona',
      description: 'A curated selection — describe this persona in two elegant lines.',
      pieces: [
        { name: 'Piece One', image: 'placeholder://ring' },
        { name: 'Piece Two', image: 'placeholder://necklace' },
      ],
      position: { x: 0, y: -1.5, z: -3 },
      active: true,
    };
    scene.hotspots = [...scene.hotspots, h];
    this.hotspots.setScene(scene);
    this.emitEditableExperiences();
    return id;
  }

  /** Tools: update fields of an experience hotspot. */
  updateExperience(id: string, patch: Partial<Omit<ExperienceHotspot, 'id' | 'type'>>): void {
    const h = this.sceneExperiences.find((x) => x.id === id);
    if (!h) return;
    const movedTo = patch.position;
    Object.assign(h, patch);
    if (movedTo) this.hotspots.moveHotspotById(id, movedTo);
    // Rebuild markers only when a label-affecting field changed (avoid churn on
    // pure position nudges, which moveHotspotById already handled).
    if (patch.label !== undefined || patch.color !== undefined || patch.active !== undefined) {
      const scene = this.sceneManager.currentScene;
      if (scene) this.hotspots.setScene(scene);
    }
    // If its card is open, refresh the content live.
    if (this.activeExperienceId === id && this.experienceCard.isOpen()) {
      this.previewExperience(id);
    }
    this.emitEditableExperiences();
  }

  /** Tools: remove an experience hotspot. */
  removeExperience(id: string): void {
    const scene = this.sceneManager.currentScene;
    if (!scene) return;
    if (this.activeExperienceId === id) this.experienceCard.forceHide();
    scene.hotspots = scene.hotspots.filter((h) => h.id !== id);
    this.hotspots.setScene(scene);
    this.emitEditableExperiences();
  }

  /** Tools: duplicate an experience hotspot (offset slightly). */
  duplicateExperience(id: string): string | null {
    const scene = this.sceneManager.currentScene;
    const src = this.sceneExperiences.find((x) => x.id === id);
    if (!scene || !src) return null;
    const copy: ExperienceHotspot = {
      ...src,
      id: `${scene.id}-exp-${Date.now().toString(36)}`,
      name: `${src.name} Copy`,
      pieces: src.pieces.map((p) => ({ ...p })),
      position: { x: src.position.x + 0.6, y: src.position.y, z: src.position.z + 0.6 },
    };
    scene.hotspots = [...scene.hotspots, copy];
    this.hotspots.setScene(scene);
    this.emitEditableExperiences();
    return copy.id;
  }

  /** Tools: toggle active/inactive. */
  setExperienceActive(id: string, active: boolean): void {
    this.updateExperience(id, { active });
  }

  /** Tools: preview — raise the card for this experience. */
  previewExperience(id: string): void {
    const h = this.sceneExperiences.find((x) => x.id === id);
    if (h) this.openExperience(h);
  }

  private handlePanelAction(action: PanelAction): void {
    if (action === 'close') {
      this.closeProductPanel();
      return;
    }
    // pdp
    const product = this.panel.product();
    if (product) {
      this.cb.onEvent?.('product_pdp_clicked', { productId: product.id });
      if (product.pdpUrl && typeof window !== 'undefined') {
        window.open(product.pdpUrl, '_blank', 'noopener,noreferrer');
      }
    }
  }

  private openProduct(h: Extract<VRHotspot, { type: 'product' }>): void {
    const product = getProductById(h.productId);
    if (!product) return;

    this.cb.onEvent?.('product_hotspot_clicked', { hotspotId: h.id, productId: product.id });

    const { position, lookAt } = this.computePanelPlacement();
    this.panel.show(product, position, lookAt);

    this.cb.onProductOpen?.(product.id);
    this.cb.onEvent?.('product_panel_opened', { productId: product.id });
  }

  /* -------------------------------- home -------------------------------- */

  /**
   * Return to the home (entrance) scene. Triggered by the controller `squeeze`
   * (grip / "pinch") gesture in VR, or the `H` key on desktop.
   */
  private goHome(): void {
    if (this.experienceCard.isOpen()) this.closeExperience();
    if (this.sceneManager.currentScene?.id === DEFAULT_SCENE_ID) return;
    if (this.panel.isOpen()) this.closeProductPanel();
    this.cb.onEvent?.('navigation_hotspot_clicked', {
      hotspotId: 'home-gesture',
      targetSceneId: DEFAULT_SCENE_ID,
    });
    void this.sceneManager.goTo(DEFAULT_SCENE_ID);
  }

  /** Place the panel ~1.85m in front of the user's current horizontal gaze. */
  private computePanelPlacement(): { position: THREE.Vector3; lookAt: THREE.Vector3 } {
    const head = this.renderer.xr.isPresenting
      ? this.renderer.xr.getCamera()
      : this.camera;
    const headPos = head.getWorldPosition(new THREE.Vector3());
    const forward = head.getWorldDirection(new THREE.Vector3());
    forward.y = 0;
    if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1);
    forward.normalize();

    const position = headPos
      .clone()
      .addScaledVector(forward, VR_CONFIG.productPanel.distance);
    position.y = headPos.y; // keep at eye level
    return { position, lookAt: headPos };
  }

  private resolveHotspotLabel(h: VRHotspot): string {
    if (h.type === 'navigation') return h.label;
    if (h.type === 'experience') return h.label;
    return getProductById(h.productId)?.name ?? 'Product';
  }

  private setCursor(interactive: boolean): void {
    if (this.renderer.xr.isPresenting) return;
    this.container.style.cursor = interactive ? 'pointer' : 'grab';
  }

  /* -------------------------------- debug ------------------------------- */

  private rebuildDebugGizmos(scene: VRScene): void {
    this.clearDebugGizmos();
    const geo = new THREE.OctahedronGeometry(0.12);
    for (const h of scene.hotspots) {
      const color = h.type === 'navigation' ? 0xc9a15a : 0xd8e6ef;
      const mesh = new THREE.Mesh(
        geo.clone(),
        new THREE.MeshBasicMaterial({ color, wireframe: true, depthTest: false }),
      );
      mesh.position.set(h.position.x, h.position.y, h.position.z);
      mesh.renderOrder = 40;
      this.debugGizmos.add(mesh);
    }
  }

  private clearDebugGizmos(): void {
    for (const child of [...this.debugGizmos.children]) {
      this.debugGizmos.remove(child);
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }

  /* ------------------------------- resize ------------------------------- */

  private resizeObserver: ResizeObserver | null = null;

  private setupResize(): void {
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.container);
  }

  private onResize(): void {
    if (this.renderer.xr.isPresenting) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Yaw/pitch (deg) the desktop camera should face to look directly at a
 *  camera-relative world position, matching applyDesktopLook's YXZ Euler
 *  convention (yaw 0 / pitch 0 looks toward -Z). */
function directionToYawPitch(position: { x: number; y: number; z: number }): {
  yaw: number;
  pitch: number;
} {
  const dir = new THREE.Vector3(position.x, position.y, position.z).normalize();
  const yaw = Math.atan2(-dir.x, -dir.z) / DEG2RAD;
  const pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) / DEG2RAD;
  return { yaw, pitch };
}
