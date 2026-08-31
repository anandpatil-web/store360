import * as THREE from 'three';
import type { VRHotspot, VRScene } from '@/types/vr';
import type { TextureManager } from './textureManager';
import { VR_CONFIG } from './config';
import { FloorHotspot } from './floorHotspot';

/** A hotspot's visual(s) plus its resolved label, living in the scene graph. */
interface HotspotObject {
  hotspot: VRHotspot;
  /** Raycast target: the billboard sprite, or a floor pad's hit disc. */
  marker: THREE.Object3D;
  /** Billboard visual (billboard-style hotspots). */
  sprite?: THREE.Sprite;
  /** Floor-projection visual (floor-style hotspots). */
  floor?: FloorHotspot;
  label: THREE.Sprite;
  baseScale: number;
  /** Current hover interpolation 0→1. */
  hover: number;
}

const FLOOR_COLOR = '#9fe4ff';

/**
 * Owns the 3D hotspot markers for the current scene: creation, hover
 * highlight, labels and ray hit-testing. Markers are billboarded sprites so
 * they always face the user, and they sit in world space so they stay pinned
 * to the panorama as the user looks around.
 */
export class HotspotManager {
  readonly group = new THREE.Group();
  private objects: HotspotObject[] = [];
  private labelTextures = new Map<string, THREE.Texture>();
  private hovered: HotspotObject | null = null;
  /** B-button "focus" (no-aim selection). Highlighted like hover; the trigger
   *  activates it when the ray isn't pointing at a pad. */
  private focused: HotspotObject | null = null;

  /** Editor mode (§?edit=true): labels show each hotspot's target scene and
   *  stay visible (not hover-only) so you can tell which pad leads where. */
  private editMode = false;

  constructor(
    private readonly textures: TextureManager,
    /** Resolve a product hotspot's display label (product name). */
    private readonly resolveLabel: (hotspot: VRHotspot) => string,
  ) {
    this.group.name = 'hotspots';
  }

  /** Toggle editor labelling. Rebuild the current scene's markers to relabel. */
  setEditMode(on: boolean): void {
    this.editMode = on;
  }

  /**
   * Label text. A named nav hotspot always shows its name (both modes). An
   * unnamed one (still the default "Explore") shows its destination scene id
   * while editing, so pads remain identifiable before they're named.
   */
  private labelFor(hotspot: VRHotspot): string {
    if (hotspot.type === 'navigation') {
      const name = hotspot.label?.trim();
      if (name && name.toLowerCase() !== 'explore') return name;
      if (this.editMode) return `→ ${hotspot.targetSceneId}`;
      return name || 'Explore';
    }
    if (hotspot.type === 'experience') return hotspot.label;
    return this.resolveLabel(hotspot);
  }

  /** Rebuild markers for a scene. Disposes the previous scene's markers. */
  setScene(scene: VRScene): void {
    this.clear();
    for (const hotspot of scene.hotspots) {
      this.objects.push(this.createObject(hotspot));
    }
    for (const obj of this.objects) {
      this.group.add(obj.floor ? obj.floor.group : obj.sprite!);
      this.group.add(obj.label);
    }
    this.setHovered(null);
  }

  /** Per-frame: subtle idle motion + hover interpolation. */
  update(elapsed: number): void {
    for (const obj of this.objects) {
      const target = obj === this.hovered || obj === this.focused ? 1 : 0;
      obj.hover += (target - obj.hover) * 0.18;

      if (obj.floor) {
        // Floor pad owns its own (flat, slow, architectural) animation.
        obj.floor.update(elapsed, obj.hover);
      } else if (obj.sprite) {
        // Slow, calm breathing (~6s period) — restrained, never bouncy.
        const pulse =
          obj.hotspot.type === 'navigation'
            ? 1 + Math.sin(elapsed * 1.05) * 0.04
            : 1 + Math.sin(elapsed * 1.4 + obj.sprite.position.x) * 0.05;

        const scale =
          obj.baseScale *
          pulse *
          (1 + obj.hover * (VR_CONFIG.hotspot.hoverScale - 1));
        obj.sprite.scale.setScalar(scale);

        const markerMat = obj.sprite.material as THREE.SpriteMaterial;
        markerMat.opacity = 0.72 + obj.hover * 0.28;
      }

      // Labels stay subtly visible at all times (small, low-opacity name under
      // the pad), lifting to full on hover. Edit mode keeps them near-solid so
      // every pad is clearly identifiable while placing.
      const labelMat = obj.label.material as THREE.SpriteMaterial;
      const base = this.editMode ? 0.85 : 0.42;
      labelMat.opacity = Math.max(base, obj.hover);
      obj.label.visible = labelMat.opacity > 0.02;
    }
  }

  /** Ray hit-test against markers only. Returns the hotspot data + object. */
  raycast(raycaster: THREE.Raycaster): { hotspot: VRHotspot; object: THREE.Object3D } | null {
    const markers = this.objects.map((o) => o.marker);
    const hits = raycaster.intersectObjects(markers, false);
    const first = hits[0];
    if (!first) return null;
    const obj = this.objects.find((o) => o.marker === first.object);
    return obj ? { hotspot: obj.hotspot, object: obj.marker } : null;
  }

  /** Highlight the hotspot backing `object`, or clear when null. */
  setHovered(object: THREE.Object3D | null): boolean {
    const next = object
      ? this.objects.find((o) => o.marker === object) ?? null
      : null;
    const changed = next !== this.hovered;
    this.hovered = next;
    return changed;
  }

  hoveredHotspot(): VRHotspot | null {
    return this.hovered?.hotspot ?? null;
  }

  /** Advance the B-button focus to the next hotspot (wraps). Returns it. */
  focusNext(): VRHotspot | null {
    if (this.objects.length === 0) {
      this.focused = null;
      return null;
    }
    const cur = this.focused ? this.objects.indexOf(this.focused) : -1;
    this.focused = this.objects[(cur + 1) % this.objects.length]!;
    return this.focused.hotspot;
  }

  /** The currently B-focused hotspot, if any. */
  focusedHotspot(): VRHotspot | null {
    return this.focused?.hotspot ?? null;
  }

  /** The FloorHotspot backing a hotspot id (for driving activation energy). */
  floorFor(id: string): FloorHotspot | null {
    return this.objects.find((o) => o.hotspot.id === id)?.floor ?? null;
  }

  /** Set the vertical glow (ray) height for a hotspot's floor pad. */
  setGlowHeightById(id: string, meters: number): void {
    this.floorFor(id)?.setGlowHeight(meters);
  }

  /** World position of a hotspot's marker (for anchoring the experience card). */
  worldPositionOf(id: string): THREE.Vector3 | null {
    const obj = this.objects.find((o) => o.hotspot.id === id);
    if (!obj) return null;
    const src = obj.floor ? obj.floor.group : obj.sprite!;
    return src.getWorldPosition(new THREE.Vector3());
  }

  /**
   * Editor (§?edit=true): move the hotspot backing `marker` to a new world
   * position — updates the visual (floor pad or sprite) + its label and mutates
   * the underlying hotspot data so the change persists across navigation in the
   * session (and is exportable). No-op if the marker isn't found.
   */
  moveHotspotObject(marker: THREE.Object3D, pos: { x: number; y: number; z: number }): void {
    const obj = this.objects.find((o) => o.marker === marker);
    if (!obj) return;
    if (obj.floor) obj.floor.group.position.set(pos.x, pos.y, pos.z);
    else if (obj.sprite) obj.sprite.position.set(pos.x, pos.y, pos.z);

    // Re-place the hover label above the new position (mirrors createLabel).
    const at = new THREE.Vector3(pos.x, pos.y, pos.z);
    const up = obj.floor ? 1.0 : obj.baseScale * 0.9;
    const dir = at.clone().normalize();
    obj.label.position
      .copy(at)
      .add(new THREE.Vector3(0, up, 0))
      .addScaledVector(dir, -0.01);

    // Mutate the shared hotspot data (its position object is per-hotspot).
    obj.hotspot.position.x = pos.x;
    obj.hotspot.position.y = pos.y;
    obj.hotspot.position.z = pos.z;
  }

  /** Move a hotspot by its id (used by the editor's numeric nudge controls). */
  moveHotspotById(id: string, pos: { x: number; y: number; z: number }): void {
    const obj = this.objects.find((o) => o.hotspot.id === id);
    if (obj) this.moveHotspotObject(obj.marker, pos);
  }

  /**
   * Editor: rename a hotspot by id. Updates the underlying data and swaps just
   * that hotspot's label sprite (cheap — no full scene rebuild), keeping its
   * position. No-op if not found.
   */
  setLabelById(id: string, label: string): void {
    const obj = this.objects.find((o) => o.hotspot.id === id);
    if (!obj || obj.hotspot.type !== 'navigation') return;
    obj.hotspot.label = label;

    const oldLabel = obj.label;
    const at = obj.floor
      ? obj.floor.group.position.clone()
      : obj.sprite!.position.clone();
    const up = obj.floor ? 1.0 : obj.baseScale * 0.9;
    const next = this.createLabel(this.labelFor(obj.hotspot), at, up);
    this.group.add(next);
    this.group.remove(oldLabel);
    (oldLabel.material as THREE.SpriteMaterial).dispose();
    obj.label = next;
  }

  clear(): void {
    for (const obj of this.objects) {
      if (obj.floor) {
        this.group.remove(obj.floor.group);
        obj.floor.dispose();
      } else if (obj.sprite) {
        this.group.remove(obj.sprite);
        (obj.sprite.material as THREE.SpriteMaterial).dispose();
      }
      this.group.remove(obj.label);
      (obj.label.material as THREE.SpriteMaterial).dispose();
    }
    this.objects = [];
    this.hovered = null;
    this.focused = null;
  }

  dispose(): void {
    this.clear();
    for (const t of this.labelTextures.values()) t.dispose();
    this.labelTextures.clear();
  }

  /* ------------------------------ internals ----------------------------- */

  private createObject(hotspot: VRHotspot): HotspotObject {
    const pos = new THREE.Vector3(hotspot.position.x, hotspot.position.y, hotspot.position.z);

    // Floor-projection ("floor pad") variant — a flat, floor-anchored marker.
    // Used by navigation floor pads and every Experience (persona) hotspot.
    const asFloorPad =
      (hotspot.type === 'navigation' && hotspot.style === 'floor') || hotspot.type === 'experience';
    if (asFloorPad) {
      const color =
        (hotspot.type === 'navigation' || hotspot.type === 'experience'
          ? hotspot.color
          : undefined) ?? FLOOR_COLOR;
      const glowHeight = hotspot.type === 'experience' ? hotspot.glowHeight : undefined;
      const floor = new FloorHotspot({ position: pos, color, glowHeight });
      // Label floats above the pad so it stays readable off the ground.
      const label = this.createLabel(this.labelFor(hotspot), pos, 1.0);
      return { hotspot, marker: floor.hitMesh, floor, label, baseScale: 1, hover: 0 };
    }

    // Billboard variant — the camera-facing diamond / sparkle sprite.
    // (Experience hotspots always take the floor-pad path above.)
    const kind: 'navigation' | 'product' = hotspot.type === 'product' ? 'product' : 'navigation';
    const accent = kind === 'navigation' ? '#c9a15a' : '#d8e6ef';
    const markerMat = new THREE.SpriteMaterial({
      map: this.textures.getHotspotTexture(kind, accent),
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(markerMat);
    sprite.position.copy(pos);
    sprite.renderOrder = 10;

    const baseScale =
      hotspot.type === 'navigation'
        ? VR_CONFIG.hotspot.navScale
        : VR_CONFIG.hotspot.productScale;
    sprite.scale.setScalar(baseScale);

    const label = this.createLabel(this.labelFor(hotspot), pos, baseScale * 0.9);
    return { hotspot, marker: sprite, sprite, label, baseScale, hover: 0 };
  }

  /**
   * Build a hover-revealed label sprite floating `up` metres above a world
   * point, pulled a hair toward the camera so it never clips into its marker.
   */
  private createLabel(text: string, at: THREE.Vector3, up: number): THREE.Sprite {
    const labelMat = new THREE.SpriteMaterial({
      map: this.getLabelTexture(text),
      transparent: true,
      depthTest: false,
      depthWrite: false,
      opacity: 0,
    });
    const label = new THREE.Sprite(labelMat);
    const dir = at.clone().normalize();
    label.position
      .copy(at)
      .add(new THREE.Vector3(0, up, 0))
      .addScaledVector(dir, -0.01);
    const img = labelMat.map!.image as HTMLCanvasElement;
    const aspect = img.width / img.height;
    const labelHeight = 0.14; // small, subtle
    label.scale.set(labelHeight * aspect, labelHeight, 1);
    label.renderOrder = 11;
    return label;
  }

  private getLabelTexture(text: string): THREE.Texture {
    const cached = this.labelTextures.get(text);
    if (cached) return cached;

    const pad = 28;
    const fontSize = 40;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = `500 ${fontSize}px system-ui, sans-serif`;
    const metrics = ctx.measureText(text.toUpperCase());
    const w = Math.ceil(metrics.width) + pad * 2;
    const h = fontSize + pad * 1.4;
    canvas.width = w;
    canvas.height = h;

    // Rounded pill background.
    const ctx2 = canvas.getContext('2d')!;
    ctx2.clearRect(0, 0, w, h);
    roundRect(ctx2, 1, 1, w - 2, h - 2, h / 2);
    ctx2.fillStyle = 'rgba(10,10,11,0.72)';
    ctx2.fill();
    ctx2.lineWidth = 1.5;
    ctx2.strokeStyle = 'rgba(201,161,90,0.5)';
    ctx2.stroke();

    ctx2.font = `500 ${fontSize}px system-ui, sans-serif`;
    ctx2.fillStyle = '#e4cd9a';
    ctx2.textAlign = 'center';
    ctx2.textBaseline = 'middle';
    // Letterspacing for the brand feel.
    drawSpacedText(ctx2, text.toUpperCase(), w / 2, h / 2 + 1, 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.labelTextures.set(text, tex);
    return tex;
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawSpacedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  spacing: number,
) {
  const widths = [...text].map((ch) => ctx.measureText(ch).width + spacing);
  const total = widths.reduce((a, b) => a + b, 0) - spacing;
  let x = cx - total / 2;
  ctx.textAlign = 'left';
  for (let i = 0; i < text.length; i++) {
    ctx.fillText(text[i]!, x, cy);
    x += widths[i]!;
  }
}
