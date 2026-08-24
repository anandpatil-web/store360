import type { CameraOrientation, ExperiencePiece, Vec3 } from '@/types/vr';

/**
 * Centralised floor / node navigation graph for the multi-floor showroom.
 *
 * Pure data — data/scenes.ts turns this into the actual VRScene graph the
 * engine consumes (one VRScene per node, one NavigationHotspot per
 * configured connection). See docs/HOTSPOTS.md for the position
 * convention: a hotspot's world position is relative to the camera origin;
 * its *direction* decides where the marker sits on the panorama and its
 * *length* the comfortable placement distance (3–5m).
 *
 * Positions below are sensible showroom defaults (straight ahead / straight
 * behind, slightly below eye level) — tune per node once the real doorway
 * direction in each photo is known, independently of any other node.
 */

export interface FloorHotspotConfig {
  /** Node id (within the same floor) this hotspot travels to. */
  target: string;
  /** World position, camera-relative — see docs/HOTSPOTS.md. */
  position: Vec3;
  /** Hover / tap label. Defaults to "Explore". */
  label?: string;
  /**
   * Visual treatment. Omit for the default camera-facing diamond marker;
   * `'floor'` renders a flat, floor-anchored luminous projection (a QWEEN
   * "floor pad"). For a floor pad, `position` should sit on the ground —
   * y ≈ −(eye height) and a few metres ahead.
   */
  style?: 'billboard' | 'floor';
  /** Optional accent colour override (hex). Floor pads default to ice-cyan. */
  color?: string;
}

/**
 * A Persona / Experience discovery point placed in a scene (§Experience
 * Hotspots). Managed from the Tools section like navigation pads; not
 * hardcoded into the renderer.
 */
export interface ExperienceHotspotConfig {
  /** Stable id (within the node). Combined with the scene id for uniqueness. */
  id: string;
  name: string;
  label: string;
  category: string;
  description: string;
  pieces: ExperiencePiece[];
  /** Floor-anchored world position (y ≈ −eye height). */
  position: Vec3;
  color?: string;
  view?: CameraOrientation;
  /** Defaults to true; inactive hotspots are hidden but stay editable. */
  active?: boolean;
}

export interface FloorNodeConfig {
  /** Filename under /public/vr/panoramas/. */
  image: string;
  /**
   * Camera orientation on arrival. Omit to preserve the look direction the
   * user already had — hotspot-to-hotspot travel should feel like walking
   * forward, not snapping to a fixed heading. Only a floor's `entry` node
   * (reached via the floor selector or a fresh load) needs a deliberate
   * starting orientation.
   */
  initialCamera?: CameraOrientation;
  hotspots: FloorHotspotConfig[];
  /** Persona / Experience discovery points in this scene. */
  experiences?: ExperienceHotspotConfig[];
}

export interface FloorConfig {
  id: string;
  label: string;
  /** Node id shown when this floor is freshly selected. */
  entry: string;
  nodes: Record<string, FloorNodeConfig>;
}

/**
 * Floor-pad positions sit on the ground (y ≈ −eye height), placed per scene in
 * the open floor area. Every navigation hotspot renders as a flat QWEEN floor
 * projection (style defaults to 'floor' in data/scenes.ts). These values were
 * dialled in with the in-app editor (pencil icon / ?edit=true) — retune there
 * and paste the exported snippet back here.
 */
export const floors: Record<string, FloorConfig> = {
  ground: {
    id: 'ground',
    label: 'Ground Floor',
    entry: 'entry',
    nodes: {
      entry: {
        image: 'groundfloor-entry.jpg',
        initialCamera: { yaw: -128, pitch: 0 },
        hotspots: [{ target: 'middle2', position: { x: 1.61, y: -1.5, z: 2.12 }, label: 'CENTER VIEW' }],
      },
      middle2: {
        image: 'groundfloor-middle2.jpg',
        hotspots: [
          { target: 'entry', position: { x: -4.83, y: -1.5, z: 1.89 }, label: 'GROUND ENTRY VIEW' },
          { target: 'first-entry', position: { x: 4.68, y: -1.5, z: -2.57 }, label: 'GO TO FIRST FLOOR' },
          { target: 'last', position: { x: 4.43, y: -1.5, z: 0.97 }, label: 'QWEEN CAFE VIEW' },
        ],
      },
      last: {
        image: 'groundfloor-last.jpg',
        initialCamera: { yaw: 109, pitch: 0 },
        hotspots: [
          { target: 'first-entry', position: { x: 2.32, y: -1.5, z: 1.07 }, label: 'GO TO FIRST FLOOR' },
          { target: 'middle2', position: { x: -1.41, y: -1.5, z: -4.12 }, label: 'CENTER VIEW' },
        ],
      },
    },
  },
  first: {
    id: 'first',
    label: 'First Floor',
    entry: 'entry',
    nodes: {
      entry: {
        image: 'firstfloor-entry.jpg',
        initialCamera: { yaw: 180, pitch: -3 },
        hotspots: [
          { target: 'middle', position: { x: 0.46, y: -1.5, z: 3.42 }, label: 'CENTER VIEW' },
          { target: 'ground-entry', position: { x: 0.06, y: -1.5, z: -2.16 }, label: 'GO TO GROUND FLOOR' },
        ],
      },
      middle: {
        image: 'firstfloor-middle.jpg',
        initialCamera: { yaw: 105, pitch: 0 },
        hotspots: [
          { target: 'entry', position: { x: 0.82, y: -1.5, z: 4.98 }, label: 'FIRST FLOOR ENTRY' },
          { target: 'last', position: { x: -1.06, y: -1.5, z: -3.03 }, label: 'DIAMOND & GEM EXPERIENCE' },
        ],
        experiences: [
          {
            id: 'diamond-seeker',
            name: 'The Diamond Seeker',
            label: 'DIAMOND SEEKER',
            category: 'Diamond',
            description:
              'Discover diamonds chosen for brilliance, rarity and timeless value — pieces that make every moment feel extraordinary.',
            position: { x: 2.6, y: -1.5, z: 1.4 },
            pieces: [
              { productId: 'qween-solitaire-001', name: 'Solitaire Ring', meta: '0.50 CT · VS · G' },
              { name: 'Diamond Tennis Bracelet', image: 'placeholder://band', meta: '4.20 CT' },
              { name: 'Diamond Pendant', image: 'placeholder://necklace', meta: '1.10 CT' },
            ],
          },
          {
            id: 'gemstone-explorer',
            name: 'The Gemstone Explorer',
            label: 'GEMSTONE EXPLORER',
            category: 'Gemstones',
            description:
              'Step into a world of colour and character. Rare stones selected for their natural beauty and individuality.',
            position: { x: -2.9, y: -1.5, z: 1.1 },
            color: '#8fd0ff',
            pieces: [
              { name: 'Sapphire Ring', image: 'placeholder://ring', meta: 'Ceylon Blue' },
              { name: 'Emerald Necklace', image: 'placeholder://necklace', meta: 'Colombian' },
              { name: 'Ruby Earrings', image: 'placeholder://earrings', meta: 'Pigeon Blood' },
            ],
          },
          {
            id: 'modern-queen',
            name: 'The Modern Queen',
            label: 'MODERN QUEEN',
            category: 'Persona',
            description:
              'Statement pieces designed to become part of your signature — bold silhouettes, refined details, effortless luxury.',
            position: { x: 0.2, y: -1.5, z: -2.4 },
            color: '#e7c6ff',
            pieces: [
              { name: 'Cocktail Ring', image: 'placeholder://ring', meta: 'Statement' },
              { name: 'Statement Earrings', image: 'placeholder://earrings', meta: 'Chandelier' },
              { productId: 'qween-eternity-003', name: 'Diamond Bracelet', meta: '1.50 CT · VS' },
            ],
          },
        ],
      },
      last: {
        image: 'firstfloor-last.jpg',
        initialCamera: { yaw: -164, pitch: 0 },
        hotspots: [
          { target: 'middle', position: { x: -0.33, y: -1.5, z: -2.25 }, label: 'CENTER VIEW' },
          { target: 'ground-entry', position: { x: 2.29, y: -1.5, z: 0.05 }, label: 'GO TO GROUND FLOOR' },
        ],
      },
    },
  },
};

/** Display / iteration order for the floor selector. */
export const floorOrder: readonly string[] = ['ground', 'first'];

export function sceneIdFor(floorId: string, nodeId: string): string {
  return `${floorId}-${nodeId}`;
}

/** Which floor a scene id belongs to, or null if it isn't a floor node. */
export function getFloorIdForScene(sceneId: string): string | null {
  for (const id of floorOrder) {
    if (sceneId.startsWith(`${id}-`)) return id;
  }
  return null;
}

/** The scene id for a floor's entry node (used by the floor selector). */
export function getFloorEntrySceneId(floorId: string): string | null {
  const floor = floors[floorId];
  if (!floor) return null;
  return sceneIdFor(floor.id, floor.entry);
}
