import * as THREE from 'three';

/**
 * FloorHotspot — a premium, floor-anchored luminous projection (a QWEEN
 * "floor pad"). Unlike the billboarded diamond markers (HotspotManager's
 * sprites), this lies flat on the ground, parallel to the floor, so it reads
 * as light projected onto the physical showroom floor rather than a UI overlay.
 *
 * Structure (three flat, stacked, GPU-cheap textured planes):
 *   - glow      : soft radial bloom around the ring (additive, expands/fades)
 *   - ring      : thin luminous circle + minimal centre diamond + micro QWEEN
 *   - particles : a few tiny dots around the circumference (subtle opacity drift)
 * plus an invisible, larger hit disc for a comfortable click / touch target.
 *
 * It is deliberately self-contained and configurable ({ position, color, size })
 * so additional floor pads can be dropped into any scene later. Navigation
 * (target / onClick) stays with the existing HotspotManager + engine so this
 * plugs into the one hotspot system rather than forking a parallel one.
 *
 * There is no real floor geometry (the "floor" is the lower hemisphere of the
 * panorama sphere ~500m away), so z-fighting is a non-issue: the pad sits a few
 * metres in front of the camera and always composites over the panorama floor.
 */

export interface FloorHotspotOptions {
  /** World position (camera-relative). Should sit on the ground: y ≈ −eye height. */
  position: THREE.Vector3;
  /** Accent colour (hex). Defaults to ice-cyan. */
  color?: string;
  /** Visual footprint of the ring in metres (glow/particles extend past it). */
  size?: number;
  /** Height (m) the activation rays rise. Default BASE_RAY_H. */
  glowHeight?: number;
}

const DEFAULT_COLOR = '#9fe4ff';
const DEFAULT_SIZE = 0.6;
/** Base modelled ray height (m); the live glow height scales this. */
const BASE_RAY_H = 0.75;
/** Slow, calm breathing period (s). Higher = more languid. */
const PULSE_PERIOD_S = 6.0;

export class FloorHotspot {
  /** Positioned root — add to the scene graph; carries the flat pad + hit disc. */
  readonly group = new THREE.Group();
  /** Invisible disc used as the raycast target (larger than the visible ring). */
  readonly hitMesh: THREE.Mesh;

  private glow: THREE.Mesh;
  private ring: THREE.Mesh;
  private particles: THREE.Mesh;
  private glowMat: THREE.MeshBasicMaterial;
  private ringMat: THREE.MeshBasicMaterial;
  private particlesMat: THREE.MeshBasicMaterial;
  private textures: THREE.Texture[] = [];

  private readonly color: string;
  private readonly size: number;

  /** Fluidic activation energy (0 inactive → 1 fully raised). Only when > 0
   *  are the vertical light rays built/animated — inactive pads stay cheap. */
  private energy = 0;
  private energyTarget = 0;
  private raysGroup: THREE.Group | null = null;
  private rayMats: THREE.MeshBasicMaterial[] = [];
  private rayBaseX: number[] = [];
  private rayBaseZ: number[] = [];
  private volumeMat: THREE.MeshBasicMaterial | null = null;
  /** Live height multiplier for the rays (1 = BASE_RAY_H). */
  private glowScale = 1;

  constructor(opts: FloorHotspotOptions) {
    const color = opts.color ?? DEFAULT_COLOR;
    const size = opts.size ?? DEFAULT_SIZE;
    this.color = color;
    this.size = size;
    if (opts.glowHeight != null) this.glowScale = opts.glowHeight / BASE_RAY_H;

    this.group.name = 'floor-hotspot';
    this.group.position.copy(opts.position);

    const glowTex = new THREE.CanvasTexture(createGlowCanvas(color));
    const ringTex = new THREE.CanvasTexture(createRingCanvas(color));
    const partTex = new THREE.CanvasTexture(createParticlesCanvas(color));
    for (const t of [glowTex, ringTex, partTex]) {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      this.textures.push(t);
    }

    // Ring + particles read cleanly on a light showroom floor with normal
    // blending (a semi-transparent cyan line stays cyan over grey). The glow is
    // additive for a soft bloom lift without a hard edge.
    this.glowMat = new THREE.MeshBasicMaterial({
      map: glowTex,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.35,
    });
    this.ringMat = new THREE.MeshBasicMaterial({
      map: ringTex,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      opacity: 0.9,
    });
    this.particlesMat = new THREE.MeshBasicMaterial({
      map: partTex,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      opacity: 0.55,
    });

    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(size * 1.9, size * 1.9), this.glowMat);
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(size, size), this.ringMat);
    this.particles = new THREE.Mesh(
      new THREE.PlaneGeometry(size * 1.24, size * 1.24),
      this.particlesMat,
    );

    // Lie flat on the floor (texture-up points away from the viewer, so any
    // centre lettering reads like a floor decal you walk toward).
    for (const m of [this.glow, this.ring, this.particles]) m.rotation.x = -Math.PI / 2;
    this.glow.renderOrder = 8;
    this.ring.renderOrder = 9;
    this.particles.renderOrder = 10;

    // Invisible, generous hit disc (kept visible:true with opacity 0 so the
    // raycaster still considers it) — guarantees a comfortable touch target.
    this.hitMesh = new THREE.Mesh(
      new THREE.CircleGeometry(size * 0.72, 24),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.hitMesh.rotation.x = -Math.PI / 2;
    this.hitMesh.renderOrder = 7;
    this.hitMesh.name = 'floor-hotspot-hit';

    this.group.add(this.glow, this.ring, this.particles, this.hitMesh);
  }

  /**
   * Per-frame animation. `hover` is a 0→1 highlight amount owned by the caller.
   * A slow (~3.2s) sine gives an ease-in-out pulse with no spin or bounce; the
   * centre icon is baked into the ring texture so it stays perfectly stable.
   */
  update(elapsed: number, hover: number): void {
    const ph = ((elapsed % PULSE_PERIOD_S) / PULSE_PERIOD_S) * Math.PI * 2;
    const wave = 0.5 + 0.5 * Math.sin(ph); // 0..1, eased
    const partWave = 0.5 + 0.5 * Math.sin(ph + 1.2); // out of phase
    const h = THREE.MathUtils.clamp(hover, 0, 1);

    // Ring: bright, gentle ~85%→100% opacity pulse, small extra lift on hover.
    this.ringMat.opacity = Math.min(1, 0.86 + 0.14 * wave + 0.14 * h);
    // Glow: expands slightly and fades back; strong bloom, brighter on hover.
    this.glowMat.opacity = 0.55 + 0.25 * wave + 0.3 * h;
    this.glow.scale.setScalar(1 + 0.07 * wave + 0.1 * h);
    // Particles: bright dots with a subtle opacity drift.
    this.particlesMat.opacity = 0.7 + 0.25 * partWave + 0.15 * h;
    // Whole pad scales ~1.05 on hover.
    this.group.scale.setScalar(1 + 0.05 * h);

    // Fluidic activation energy — ease toward target, drive the rays.
    if (this.energy !== this.energyTarget) {
      // Rays rise a touch faster than they retract (organic, never snappy).
      const rate = this.energyTarget > this.energy ? 3.2 : 2.4;
      const step = Math.min(1, rate * (1 / 60));
      this.energy += (this.energyTarget - this.energy) * step * 3;
      if (Math.abs(this.energy - this.energyTarget) < 0.002) this.energy = this.energyTarget;
    }
    if (this.raysGroup) {
      const e = this.energy;
      this.raysGroup.visible = e > 0.002;
      if (this.raysGroup.visible) {
        const eased = e * e * (3 - 2 * e); // smoothstep
        // Ring energises further as the rays rise.
        this.ringMat.opacity = Math.min(1, this.ringMat.opacity + 0.3 * eased);
        for (let i = 0; i < this.rayMats.length; i++) {
          // Organic sway — each ray drifts on its own slow phase.
          const sway = Math.sin(elapsed * 1.6 + i * 1.7) * 0.02 * eased;
          const child = this.raysGroup.children[i] as THREE.Mesh;
          child.scale.y = eased;
          child.position.x = this.rayBaseX[i]! + sway;
          child.position.z = this.rayBaseZ[i]! + Math.cos(elapsed * 1.3 + i) * 0.02 * eased;
          this.rayMats[i]!.opacity = (0.28 + 0.12 * Math.sin(elapsed * 2 + i)) * eased;
        }
        if (this.volumeMat) this.volumeMat.opacity = 0.14 * eased;
      }
    }
  }

  /**
   * Set the fluidic activation level (0 = calm inactive marker, 1 = rays fully
   * raised). Lazily builds the ray geometry the first time it's raised, so
   * inactive pads never pay for it (§VR performance).
   */
  setEnergy(target: number): void {
    this.energyTarget = THREE.MathUtils.clamp(target, 0, 1);
    if (this.energyTarget > 0 && !this.raysGroup) this.buildRays();
  }

  /** Set the vertical glow (ray) height in metres. Applies live. */
  setGlowHeight(meters: number): void {
    this.glowScale = Math.max(0.05, meters) / BASE_RAY_H;
    if (this.raysGroup) this.raysGroup.scale.y = this.glowScale;
  }

  dispose(): void {
    for (const m of [
      this.glowMat,
      this.ringMat,
      this.particlesMat,
      this.hitMesh.material as THREE.Material,
    ]) {
      m.dispose();
    }
    this.glow.geometry.dispose();
    this.ring.geometry.dispose();
    this.particles.geometry.dispose();
    this.hitMesh.geometry.dispose();
    for (const t of this.textures) t.dispose();
    this.disposeRays();
  }

  /* ------------------------------ fluidic rays --------------------------- */

  /**
   * Thin vertical light rays (~0.75m / 2.5ft) rising from the ring, plus a soft
   * translucent volumetric column between them. Additive, camera-billboarded in
   * yaw so they always read edge-on. Built once, on first activation.
   */
  private buildRays(): void {
    const group = new THREE.Group();
    group.name = 'floor-hotspot-rays';
    const rayTex = new THREE.CanvasTexture(createRayCanvas(this.color));
    rayTex.colorSpace = THREE.SRGBColorSpace;
    this.textures.push(rayTex);

    const RAY_H = BASE_RAY_H; // modelled height; glowScale scales it live
    const count = 7;
    const radius = this.size * 0.34;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const mat = new THREE.MeshBasicMaterial({
        map: rayTex,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
        side: THREE.DoubleSide,
      });
      const w = this.size * (0.05 + (i % 2) * 0.015);
      const ray = new THREE.Mesh(new THREE.PlaneGeometry(w, RAY_H), mat);
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      ray.position.set(x, RAY_H / 2, z);
      ray.rotation.y = -a; // face roughly outward; sway handles life
      ray.scale.y = 0; // rise from the floor
      ray.renderOrder = 11;
      this.rayMats.push(mat);
      this.rayBaseX.push(x);
      this.rayBaseZ.push(z);
      group.add(ray);
    }

    // Soft translucent volumetric column between the rays.
    this.volumeMat = new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(createColumnCanvas(this.color)),
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
      side: THREE.DoubleSide,
    });
    this.volumeMat.map!.colorSpace = THREE.SRGBColorSpace;
    this.textures.push(this.volumeMat.map!);
    const vol = new THREE.Mesh(new THREE.PlaneGeometry(this.size * 0.9, RAY_H), this.volumeMat);
    vol.position.y = RAY_H / 2;
    vol.renderOrder = 10;
    // Keep the volume plane roughly facing the origin/user via yaw billboard in
    // update? A fixed cross of two planes reads well from any angle and is cheap.
    const vol2 = vol.clone();
    vol2.rotation.y = Math.PI / 2;
    group.add(vol, vol2);

    group.visible = false;
    group.scale.y = this.glowScale;
    this.raysGroup = group;
    this.group.add(group);
  }

  private disposeRays(): void {
    if (!this.raysGroup) return;
    for (const m of this.rayMats) m.dispose();
    this.volumeMat?.dispose();
    this.raysGroup.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.raysGroup.removeFromParent();
    this.raysGroup = null;
    this.rayMats = [];
    this.volumeMat = null;
  }
}

/* ----------------------------- texture canvases ---------------------------- */

const TEX = 512;

/** Thin luminous ring + a faint inner ring + minimal centre diamond + micro QWEEN. */
function createRingCanvas(color: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = TEX;
  canvas.height = TEX;
  const ctx = canvas.getContext('2d')!;
  const c = TEX / 2;
  const R = TEX * 0.38;

  ctx.lineCap = 'round';

  // Outer ring with a strong bloom — drawn twice (bright core over a wide
  // halo) so it reads luminous on a light showroom floor.
  ctx.shadowColor = hexA(color, 1);
  ctx.shadowBlur = 22;
  ctx.strokeStyle = hexA(color, 0.85);
  ctx.lineWidth = 8;
  circle(ctx, c, c, R);
  ctx.stroke();
  ctx.shadowBlur = 10;
  ctx.strokeStyle = hexA('#ffffff', 0.95);
  ctx.lineWidth = 3;
  circle(ctx, c, c, R);
  ctx.stroke();

  // Concentric inner ring — quiet refinement, a touch brighter now.
  ctx.shadowBlur = 8;
  ctx.strokeStyle = hexA(color, 0.5);
  ctx.lineWidth = 2;
  circle(ctx, c, c, R * 0.8);
  ctx.stroke();

  // Minimal centre diamond (brand motif), small and stable.
  ctx.shadowBlur = 10;
  const dr = TEX * 0.062;
  ctx.strokeStyle = hexA('#ffffff', 0.9);
  ctx.lineWidth = 3;
  diamond(ctx, c, c - TEX * 0.012, dr);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = hexA(color, 0.5);
  diamond(ctx, c, c - TEX * 0.012, dr * 0.5);
  ctx.fill();

  // Micro QWEEN wordmark below the diamond — present but never shouting.
  ctx.shadowBlur = 0;
  ctx.fillStyle = hexA('#ffffff', 0.55);
  ctx.font = `600 ${Math.round(TEX * 0.05)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  drawSpaced(ctx, 'QWEEN', c, c + TEX * 0.09, TEX * 0.02);

  return canvas;
}

/** A few tiny dots around the circumference, softly glowing. */
function createParticlesCanvas(color: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = TEX;
  canvas.height = TEX;
  const ctx = canvas.getContext('2d')!;
  const c = TEX / 2;
  const R = TEX * 0.44;
  const count = 10;

  ctx.shadowColor = hexA(color, 0.9);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + (i % 2 ? 0.12 : -0.08);
    const rr = R + (i % 3) * TEX * 0.012;
    const x = c + Math.cos(a) * rr;
    const y = c + Math.sin(a) * rr;
    const size = 2.2 + (i % 3) * 1.1;
    ctx.shadowBlur = 8;
    ctx.fillStyle = hexA(i % 2 ? '#ffffff' : color, 0.85);
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

/** Annular radial glow — concentrated around the ring, clear at the centre. */
function createGlowCanvas(color: string): HTMLCanvasElement {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const c = S / 2;
  const g = ctx.createRadialGradient(c, c, S * 0.06, c, c, S * 0.5);
  g.addColorStop(0, hexA(color, 0.18));
  g.addColorStop(0.42, hexA(color, 0.7));
  g.addColorStop(0.72, hexA(color, 0.22));
  g.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return canvas;
}

/** A single vertical light ray — bright, soft base fading to nothing at the top. */
function createRayCanvas(color: string): HTMLCanvasElement {
  const W = 64;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  // Vertical gradient: bright near the floor (bottom), fading up.
  const g = ctx.createLinearGradient(0, H, 0, 0);
  g.addColorStop(0, hexA('#ffffff', 0.85));
  g.addColorStop(0.15, hexA(color, 0.8));
  g.addColorStop(0.6, hexA(color, 0.28));
  g.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = g;
  // Soft-edged column (horizontal falloff) via a second multiply pass.
  const h = ctx.createLinearGradient(0, 0, W, 0);
  h.addColorStop(0, 'rgba(0,0,0,0)');
  h.addColorStop(0.5, 'rgba(0,0,0,1)');
  h.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = h;
  ctx.fillRect(0, 0, W, H);
  return canvas;
}

/** Soft translucent volumetric column that fills between the rays. */
function createColumnCanvas(color: string): HTMLCanvasElement {
  const W = 128;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, H, 0, 0);
  g.addColorStop(0, hexA(color, 0.5));
  g.addColorStop(0.5, hexA(color, 0.16));
  g.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const h = ctx.createLinearGradient(0, 0, W, 0);
  h.addColorStop(0, 'rgba(0,0,0,0)');
  h.addColorStop(0.5, 'rgba(0,0,0,1)');
  h.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = h;
  ctx.fillRect(0, 0, W, H);
  return canvas;
}

/* -------------------------------- 2D helpers ------------------------------- */

function circle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
}

function diamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
}

function drawSpaced(
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
  ctx.textAlign = 'center';
}

function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((ch) => ch + ch).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
