import type { ExperienceHotspot, NavigationHotspot, VRHotspot, VRScene } from '@/types/vr';
import { floors, floorOrder, sceneIdFor } from './floors';

/**
 * Resolve a hotspot's `target` to a full scene id. A bare node id (e.g.
 * "entry") resolves within the hotspot's own floor; a fully-qualified id
 * (e.g. "first-entry") is used as-is, enabling cross-floor navigation
 * (e.g. a "Go to first floor" pad on the ground floor → first-entry).
 */
function resolveTargetSceneId(floorId: string, target: string): string {
  for (const fid of floorOrder) {
    if (target.startsWith(`${fid}-`)) return target;
  }
  return sceneIdFor(floorId, target);
}

/**
 * V1 scene graph — generated from the floor/node navigation config in
 * data/floors.ts. Each floor node becomes a VRScene; each configured
 * hotspot becomes a NavigationHotspot pointing at another node's scene id.
 * Same-floor neighbours are preloaded automatically (§9 performance).
 *
 * To ship more photography: add a node (and its hotspots) to data/floors.ts
 * — no rendering code changes needed. Hotspot positioning is documented in
 * docs/HOTSPOTS.md.
 */
function buildScenes(): VRScene[] {
  const scenes: VRScene[] = [];
  for (const floorId of floorOrder) {
    const floor = floors[floorId];
    if (!floor) continue;
    for (const [nodeId, node] of Object.entries(floor.nodes)) {
      const id = sceneIdFor(floorId, nodeId);
      const navHotspots: NavigationHotspot[] = node.hotspots.map((h, i) => ({
        // Index-suffixed so a node with two pads to the same target still has
        // unique hotspot ids (React keys, raycast lookup, position overrides).
        id: `${id}-to-${h.target}-${i}`,
        type: 'navigation',
        label: h.label ?? 'Explore',
        targetSceneId: resolveTargetSceneId(floorId, h.target),
        // Clone so each hotspot owns its position (floors.ts reuses shared
        // FORWARD/BACKWARD constants) — lets the ?edit=true editor move one
        // pad without shifting every other pad that shared the reference.
        position: { x: h.position.x, y: h.position.y, z: h.position.z },
        // Every navigation hotspot renders as a flat floor pad by default;
        // a node may still opt back into the billboard diamond per-hotspot.
        style: h.style ?? 'floor',
        ...(h.color ? { color: h.color } : {}),
      }));

      // Experience (persona) hotspots — only active ones render; each carries a
      // full copy of its curated content so the renderer/editor never mutate
      // the shared config object.
      const experienceHotspots: ExperienceHotspot[] = (node.experiences ?? [])
        .filter((e) => e.active !== false)
        .map((e) => ({
          id: `${id}-exp-${e.id}`,
          type: 'experience',
          name: e.name,
          label: e.label,
          category: e.category,
          description: e.description,
          pieces: e.pieces.map((p) => ({ ...p })),
          position: { x: e.position.x, y: e.position.y, z: e.position.z },
          active: true,
          ...(e.color ? { color: e.color } : {}),
          ...(e.view ? { view: { ...e.view } } : {}),
        }));

      const hotspots: VRHotspot[] = [...navHotspots, ...experienceHotspots];
      scenes.push({
        id,
        name: floor.label,
        environment: { type: 'panorama', source: `/vr/panoramas/${node.image}` },
        initialCamera: node.initialCamera,
        hotspots,
        preload: node.hotspots.map((h) => resolveTargetSceneId(floorId, h.target)),
      });
    }
  }
  return scenes;
}

export const scenes: VRScene[] = buildScenes();

/** The scene shown first when no `?scene=` deep-link is provided. Also "home". */
export const DEFAULT_SCENE_ID = sceneIdFor('ground', floors.ground!.entry);

const sceneIndex = new Map(scenes.map((s) => [s.id, s]));

export function getSceneById(id: string): VRScene | undefined {
  return sceneIndex.get(id);
}

export function sceneExists(id: string): boolean {
  return sceneIndex.has(id);
}
