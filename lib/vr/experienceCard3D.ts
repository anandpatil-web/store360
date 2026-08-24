import * as THREE from 'three';
import type { ExperienceHotspot, ExperiencePiece } from '@/types/vr';
import { getProductById } from '@/data/products';
import type { TextureManager } from './textureManager';

/** What the ray is pointing at inside the card. */
export type CardAction =
  | { kind: 'close' }
  | { kind: 'explore' }
  | { kind: 'piece'; index: number };

interface Tile {
  mesh: THREE.Mesh; // product image (raycast target)
  glow: THREE.Mesh; // soft fluid glow beneath the piece
  labelMesh: THREE.Mesh; // name + meta
  base: THREE.Vector3;
  hover: number;
}

const CARD_W = 1.5;
const CARD_H = 0.92;

/**
 * ExperienceCard3D — the floating glassmorphism persona card (§3–6). Real 3D
 * geometry so it renders inside the headset (a DOM card never composites into
 * an immersive session). It is spatially anchored at the hotspot, oriented to
 * the user once, and does NOT head-follow.
 *
 * It emerges with a fluidic entrance (glass expands horizontally → text
 * resolves → pieces stagger in) and dismisses in reverse (content fades →
 * glass shrinks). A very slow additive sheen drifts across the surface for the
 * "light through liquid glass" feel — cheap enough for Quest.
 */
export class ExperienceCard3D {
  readonly group = new THREE.Group();
  /** Called once the dismiss animation has fully played out. */
  onClosed: (() => void) | null = null;

  private glass: THREE.Mesh;
  private sheen: THREE.Mesh; // animated additive light gradient
  private closeBtn: THREE.Mesh;
  private exploreBtn: THREE.Mesh;
  private tiles: Tile[] = [];
  private disposables: Array<THREE.Texture | THREE.Material | THREE.BufferGeometry> = [];

  private hotspotId: string | null = null;
  private mode: 'idle' | 'in' | 'out' = 'idle';
  private t = 0; // seconds since the current transition began
  private sheenT = 0;
  private hovered: CardAction | null = null;

  constructor(private readonly textures: TextureManager) {
    this.group.name = 'experience-card';
    this.group.visible = false;

    // Frosted glass backdrop (content baked per-hotspot).
    this.glass = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W, CARD_H),
      new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false }),
    );
    this.glass.renderOrder = 30;
    this.group.add(this.glass);

    // Slow additive sheen drifting across the glass.
    const sheenTex = new THREE.CanvasTexture(makeSheenCanvas());
    sheenTex.colorSpace = THREE.SRGBColorSpace;
    sheenTex.wrapS = THREE.RepeatWrapping;
    this.disposables.push(sheenTex);
    this.sheen = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W, CARD_H),
      new THREE.MeshBasicMaterial({
        map: sheenTex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0.06,
      }),
    );
    this.sheen.position.z = 0.001;
    this.sheen.renderOrder = 31;
    this.group.add(this.sheen);

    this.closeBtn = this.makeButton('✕', 0.09, 0.09);
    this.closeBtn.position.set(CARD_W / 2 - 0.08, CARD_H / 2 - 0.08, 0.004);
    this.exploreBtn = this.makeButton('EXPLORE  EXPERIENCE', 0.62, 0.09, true);
    this.exploreBtn.position.set(0, -CARD_H / 2 + 0.085, 0.004);
    this.group.add(this.closeBtn, this.exploreBtn);
  }

  isOpen(): boolean {
    return this.group.visible && this.mode !== 'out';
  }

  currentHotspotId(): string | null {
    return this.hotspotId;
  }

  /**
   * Show the card for `hotspot`, anchored at `position` and facing `lookAt`
   * (called once — no continuous billboarding). Rebuilds content + tiles and
   * starts the fluidic entrance.
   */
  show(hotspot: ExperienceHotspot, position: THREE.Vector3, lookAt: THREE.Vector3): void {
    this.hotspotId = hotspot.id;
    const accent = hotspot.color ?? '#9fe4ff';

    // Glass + text.
    const gmat = this.glass.material as THREE.MeshBasicMaterial;
    gmat.map?.dispose();
    gmat.map = new THREE.CanvasTexture(renderGlass(hotspot, accent));
    gmat.map.colorSpace = THREE.SRGBColorSpace;
    gmat.map.anisotropy = 4;
    gmat.needsUpdate = true;

    this.rebuildTiles(hotspot.pieces, accent);

    this.group.position.copy(position);
    this.group.lookAt(lookAt);
    this.group.visible = true;
    this.mode = 'in';
    this.t = 0;
    this.hovered = null;
    this.applyTimeline(0);
  }

  /** Begin the dismiss (content fades → glass shrinks → onClosed). */
  startDismiss(): void {
    if (this.mode === 'out' || !this.group.visible) return;
    this.mode = 'out';
    this.t = 0;
  }

  /** Instantly hide (no animation) — used when the anchoring scene changes. */
  forceHide(): void {
    this.group.visible = false;
    this.mode = 'idle';
    this.hotspotId = null;
    this.hovered = null;
  }

  /** Per-frame; drives entrance/dismiss + the slow sheen. */
  update(dt: number): void {
    if (!this.group.visible) return;
    this.sheenT += dt;
    const smat = this.sheen.material as THREE.MeshBasicMaterial;
    if (smat.map) smat.map.offset.x = (this.sheenT * 0.04) % 1;

    if (this.mode === 'idle') return;
    this.t += dt;
    if (this.mode === 'in') {
      const done = this.applyTimeline(this.t);
      if (done) this.mode = 'idle';
    } else {
      const done = this.applyDismiss(this.t);
      if (done) {
        this.group.visible = false;
        this.mode = 'idle';
        this.hotspotId = null;
        this.onClosed?.();
      }
    }
  }

  /** Hit-test the interactive parts (close, explore, pieces). */
  raycast(raycaster: THREE.Raycaster): CardAction | null {
    if (!this.isOpen()) return null;
    const targets: THREE.Object3D[] = [this.closeBtn, this.exploreBtn, ...this.tiles.map((t) => t.mesh)];
    const hit = raycaster.intersectObjects(targets, false)[0];
    if (!hit) return null;
    return (hit.object.userData.action as CardAction) ?? null;
  }

  setHovered(action: CardAction | null): void {
    this.hovered = action;
    const closeHover = action?.kind === 'close';
    const exploreHover = action?.kind === 'explore';
    (this.closeBtn.material as THREE.MeshBasicMaterial).opacity = closeHover ? 1 : 0.7;
    (this.exploreBtn.material as THREE.MeshBasicMaterial).opacity = exploreHover ? 1 : 0.9;
    for (let i = 0; i < this.tiles.length; i++) {
      this.tiles[i]!.hover = action?.kind === 'piece' && action.index === i ? 1 : 0;
    }
  }

  dispose(): void {
    (this.glass.material as THREE.MeshBasicMaterial).map?.dispose();
    (this.glass.material as THREE.MeshBasicMaterial).dispose();
    this.glass.geometry.dispose();
    (this.sheen.material as THREE.MeshBasicMaterial).dispose();
    this.sheen.geometry.dispose();
    for (const b of [this.closeBtn, this.exploreBtn]) {
      (b.material as THREE.MeshBasicMaterial).map?.dispose();
      (b.material as THREE.MeshBasicMaterial).dispose();
      b.geometry.dispose();
    }
    this.clearTiles();
    for (const d of this.disposables) d.dispose();
  }

  /* ------------------------------ internals ----------------------------- */

  /** Entrance timeline; returns true when complete. */
  private applyTimeline(t: number): boolean {
    // Glass expands horizontally 0.10 → 0.55 (ease-out).
    const g = clamp01((t - 0.1) / 0.45);
    const ge = 1 - Math.pow(1 - g, 3);
    this.group.scale.set(0.12 + 0.88 * ge, 0.4 + 0.6 * ge, 1);
    (this.glass.material as THREE.MeshBasicMaterial).opacity = ge;
    (this.sheen.material as THREE.MeshBasicMaterial).opacity = 0.06 * ge;

    // Buttons fade with the glass, slightly later.
    const btn = clamp01((t - 0.4) / 0.35);
    (this.closeBtn.material as THREE.MeshBasicMaterial).opacity = 0.7 * btn;
    (this.exploreBtn.material as THREE.MeshBasicMaterial).opacity = 0.9 * btn;

    // Pieces stagger in from 0.6, 100ms apart.
    let last = 0.6;
    for (let i = 0; i < this.tiles.length; i++) {
      const start = 0.6 + i * 0.1;
      last = start + 0.35;
      const p = clamp01((t - start) / 0.35);
      const pe = 1 - Math.pow(1 - p, 2);
      this.setTileReveal(this.tiles[i]!, pe);
    }
    return t >= Math.max(0.9, last);
  }

  /** Dismiss timeline; returns true when fully hidden. */
  private applyDismiss(t: number): boolean {
    // Pieces + buttons fade fast.
    const fade = 1 - clamp01(t / 0.22);
    for (const tile of this.tiles) this.setTileReveal(tile, fade);
    (this.closeBtn.material as THREE.MeshBasicMaterial).opacity = 0.7 * fade;
    (this.exploreBtn.material as THREE.MeshBasicMaterial).opacity = 0.9 * fade;
    // Glass liquefies down: shrink Y + horizontal collapse, fade out.
    const g = clamp01((t - 0.12) / 0.4);
    const ge = 1 - Math.pow(1 - g, 3);
    this.group.scale.set(1 - 0.88 * ge, 1 - 0.85 * ge, 1);
    const op = 1 - ge;
    (this.glass.material as THREE.MeshBasicMaterial).opacity = op;
    (this.sheen.material as THREE.MeshBasicMaterial).opacity = 0.06 * op;
    return t >= 0.55;
  }

  private setTileReveal(tile: Tile, reveal: number): void {
    const enlarge = 1 + tile.hover * 0.12;
    const s = (0.6 + 0.4 * reveal) * enlarge;
    tile.mesh.scale.setScalar(s);
    tile.glow.scale.setScalar(s * 1.3);
    (tile.mesh.material as THREE.MeshBasicMaterial).opacity = reveal;
    (tile.labelMesh.material as THREE.MeshBasicMaterial).opacity = reveal * (0.85 + tile.hover * 0.15);
    (tile.glow.material as THREE.MeshBasicMaterial).opacity = reveal * (0.3 + tile.hover * 0.35);
    // Subtle lift on hover (the "ripple/expand" response).
    tile.mesh.position.y = tile.base.y + tile.hover * 0.015;
  }

  private rebuildTiles(pieces: ExperiencePiece[], accent: string): void {
    this.clearTiles();
    const n = Math.min(4, Math.max(0, pieces.length));
    const tileW = 0.28;
    const gap = 0.06;
    const totalW = n * tileW + (n - 1) * gap;
    const startX = -totalW / 2 + tileW / 2;
    const y = -0.03;

    for (let i = 0; i < n; i++) {
      const piece = pieces[i]!;
      const product = piece.productId ? getProductById(piece.productId) : undefined;
      const image = piece.image ?? product?.image ?? 'placeholder://product';
      const name = piece.name ?? product?.name ?? 'Piece';
      const meta = piece.meta ?? product?.spec ?? '';
      const x = startX + i * (tileW + gap);

      // Soft fluid glow beneath the piece.
      const glowTex = new THREE.CanvasTexture(makeGlowCanvas(accent));
      glowTex.colorSpace = THREE.SRGBColorSpace;
      this.disposables.push(glowTex);
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(tileW * 1.1, tileW * 1.1),
        new THREE.MeshBasicMaterial({
          map: glowTex,
          transparent: true,
          depthTest: false,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          opacity: 0,
        }),
      );
      glow.position.set(x, y - 0.02, 0.003);
      glow.renderOrder = 32;

      // Product image — treated as a floating jewellery object (no card chrome).
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(tileW, tileW),
        new THREE.MeshBasicMaterial({
          map: this.textures.getProductTexture(image),
          transparent: true,
          depthTest: false,
          depthWrite: false,
          opacity: 0,
        }),
      );
      mesh.position.set(x, y, 0.005);
      mesh.renderOrder = 33;
      mesh.userData.action = { kind: 'piece', index: i } as CardAction;

      // Name + meta beneath.
      const labelTex = new THREE.CanvasTexture(makeTileLabel(name, meta));
      labelTex.colorSpace = THREE.SRGBColorSpace;
      labelTex.anisotropy = 4;
      this.disposables.push(labelTex);
      const labelMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(tileW * 1.25, tileW * 1.25 * 0.4),
        new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, depthTest: false, depthWrite: false, opacity: 0 }),
      );
      labelMesh.position.set(x, y - tileW * 0.72, 0.005);
      labelMesh.renderOrder = 33;

      this.group.add(glow, mesh, labelMesh);
      this.tiles.push({ mesh, glow, labelMesh, base: mesh.position.clone(), hover: 0 });
    }
  }

  private clearTiles(): void {
    for (const t of this.tiles) {
      for (const m of [t.mesh, t.glow, t.labelMesh]) {
        this.group.remove(m);
        (m.material as THREE.MeshBasicMaterial).map?.dispose();
        (m.material as THREE.MeshBasicMaterial).dispose();
        m.geometry.dispose();
      }
    }
    this.tiles = [];
  }

  private makeButton(text: string, w: number, h: number, primary = false): THREE.Mesh {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = Math.round((512 * h) / w);
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width;
    const H = canvas.height;
    roundRect(ctx, 3, 3, W - 6, H - 6, H / 2);
    if (primary) {
      ctx.fillStyle = 'rgba(159,228,255,0.14)';
      ctx.fill();
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(159,228,255,0.55)';
    ctx.stroke();
    ctx.fillStyle = primary ? '#eaf8ff' : 'rgba(220,240,250,0.9)';
    ctx.font = `500 ${Math.round(H * (primary ? 0.34 : 0.5))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (primary) {
      drawSpaced(ctx, text, W / 2, H / 2 + 2, 3);
    } else {
      ctx.fillText(text, W / 2, H / 2 + 2);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.disposables.push(tex);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, opacity: 0 }),
    );
    mesh.renderOrder = 34;
    mesh.userData.action = (primary ? { kind: 'explore' } : { kind: 'close' }) as CardAction;
    return mesh;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/* ----------------------------- canvas builders ---------------------------- */

/** Frosted glass card with persona eyebrow, name, description. */
function renderGlass(hotspot: ExperienceHotspot, accent: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = Math.round((1024 * CARD_H) / CARD_W);
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  const R = 46;

  // Frosted translucent body — high transparency, soft vertical gradient.
  roundRect(ctx, 8, 8, W - 16, H - 16, R);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(28,34,40,0.42)');
  g.addColorStop(1, 'rgba(14,18,22,0.5)');
  ctx.fillStyle = g;
  ctx.fill();

  // Thin luminous cyan border + very subtle inner top highlight.
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = hexA(accent, 0.5);
  ctx.shadowColor = hexA(accent, 0.5);
  ctx.shadowBlur = 18;
  ctx.stroke();
  ctx.shadowBlur = 0;
  const hi = ctx.createLinearGradient(0, 8, 0, H * 0.4);
  hi.addColorStop(0, 'rgba(255,255,255,0.10)');
  hi.addColorStop(1, 'rgba(255,255,255,0)');
  roundRect(ctx, 10, 10, W - 20, H * 0.4, R);
  ctx.fillStyle = hi;
  ctx.fill();

  const padX = 70;
  ctx.textAlign = 'left';

  // Eyebrow.
  ctx.fillStyle = hexA(accent, 0.85);
  ctx.font = '600 22px system-ui, sans-serif';
  drawSpaced(ctx, `${hotspot.category.toUpperCase()} · EXPERIENCE`, padX, 74, 3);

  // Name.
  ctx.fillStyle = '#f4ecda';
  ctx.font = '300 60px Georgia, serif';
  ctx.fillText(hotspot.name, padX, 150);

  // Description (wrapped, 2–3 lines).
  ctx.fillStyle = 'rgba(214,230,239,0.9)';
  ctx.font = '400 27px system-ui, sans-serif';
  wrapText(ctx, hotspot.description, padX, 200, W - padX * 2, 38, 3);

  return canvas;
}

function makeTileLabel(name: string, meta: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f4ecda';
  ctx.font = '500 30px Georgia, serif';
  ctx.fillText(name, 160, 44, 300);
  if (meta) {
    ctx.fillStyle = 'rgba(159,196,214,0.9)';
    ctx.font = '500 22px system-ui, sans-serif';
    ctx.fillText(meta, 160, 86, 300);
  }
  return canvas;
}

function makeGlowCanvas(color: string): HTMLCanvasElement {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const c = S / 2;
  const g = ctx.createRadialGradient(c, c, 2, c, c, c);
  g.addColorStop(0, hexA(color, 0.55));
  g.addColorStop(0.5, hexA(color, 0.22));
  g.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return canvas;
}

/** A soft diagonal band of light for the drifting sheen. */
function makeSheenCanvas(): HTMLCanvasElement {
  const W = 512;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.45, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(200,240,255,0.5)');
  g.addColorStop(0.55, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  return canvas;
}

/* -------------------------------- 2D helpers ------------------------------ */

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
  lineH: number,
  maxLines: number,
): void {
  const words = text.split(' ');
  let line = '';
  let lines = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i]!;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y + lines * lineH);
      line = words[i]!;
      lines++;
      if (lines >= maxLines - 1) break;
    } else {
      line = test;
    }
  }
  if (lines < maxLines) ctx.fillText(line, x, y + lines * lineH);
}

function drawSpaced(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  spacing: number,
): void {
  const widths = [...text].map((ch) => ctx.measureText(ch).width + spacing);
  const total = widths.reduce((a, b) => a + b, 0) - spacing;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  let x = cx - total / 2;
  for (let i = 0; i < text.length; i++) {
    ctx.fillText(text[i]!, x, cy);
    x += widths[i]!;
  }
  ctx.textAlign = prevAlign;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}
