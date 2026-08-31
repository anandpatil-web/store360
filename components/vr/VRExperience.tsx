'use client';

import { useEffect, useRef, useState } from 'react';
import { useVRStore } from '@/lib/vrStore';
import { VRSceneEngine, type EditableHotspot, type EditableExperience } from '@/lib/vr/engine';
import { detectXRSupport } from '@/lib/vr/webxr';
import { trackEvent, flushSession } from '@/lib/vr/analytics';
import { AmbientAudio } from '@/lib/vr/ambientAudio';
import { DEFAULT_SCENE_ID, getSceneById, sceneExists } from '@/data/scenes';
import {
  floors,
  floorOrder,
  getFloorIdForScene,
  getFloorEntrySceneId,
} from '@/data/floors';
import { LoadingScreen } from './LoadingScreen';
import { VRControls, type FloorOption } from './VRControls';
import { DebugOverlay } from './DebugOverlay';
import { HotspotEditor } from './HotspotEditor';
import { PanoramaTester } from './PanoramaTester';
import { ViewControlsPanel } from './ViewControlsPanel';

/**
 * Top-level VR experience (client component).
 *
 * Responsibilities:
 *  - detect WebXR support (§8)
 *  - own the Three.js engine instance across React re-renders
 *  - route engine callbacks → Zustand store + analytics
 *  - render the 2D chrome (loading, controls, debug)
 *
 * Deep links: `?scene=<id>` opens directly into a scene (§25); `?debug=true`
 * enables the debug overlay + in-scene gizmos (§21).
 */

/** Floor selector options — derived once from the static floor graph (§4/§8). */
const FLOOR_OPTIONS: FloorOption[] = floorOrder
  .map((id) => {
    const floor = floors[id];
    return floor ? { id, label: floor.label } : null;
  })
  .filter((f): f is FloorOption => f !== null);

export function VRExperience() {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<VRSceneEngine | null>(null);
  const audioRef = useRef<AmbientAudio | null>(null);
  const [testMode, setTestMode] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editableHotspots, setEditableHotspots] = useState<EditableHotspot[]>([]);
  const [editableExperiences, setEditableExperiences] = useState<EditableExperience[]>([]);

  const {
    isReady,
    isLoading,
    loadingProgress,
    xrSupport,
    isVRMode,
    isProductPanelOpen,
    currentScene,
    debugEnabled,
    debugInfo,
    isMuted,
  } = useVRStore();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const store = useVRStore.getState();
    let cancelled = false;

    // Read deep-link params.
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('scene');
    const initialScene =
      requested && sceneExists(requested) ? requested : DEFAULT_SCENE_ID;
    const debug = params.get('debug') === 'true';
    store.setDebugEnabled(debug);
    setTestMode(params.get('test') === 'true');
    const edit = params.get('edit') === 'true';
    setEditMode(edit);

    trackEvent('session_started', { initialScene });

    const engine = new VRSceneEngine(container, {
      onReady: () => store.setReady(true),
      onLoadingProgress: (f) => store.setLoadingProgress(f),
      onSceneChange: (scene) => {
        const prev = store.currentScene;
        store.setScene(scene.id, prev);
        store.setLoading(false);
        // Keep the URL's ?scene= in sync for shareable deep links (skip ad-hoc
        // tester panoramas, which aren't part of the scene graph).
        if (!scene.id.startsWith('custom:')) syncSceneParam(scene.id);
      },
      onTransitionStart: () => store.setTransitioning(true),
      onTransitionComplete: () => store.setTransitioning(false),
      onProductOpen: (productId) => store.setProduct(productId),
      onProductClose: () => store.setProduct(null),
      onVRSessionChange: (active) => store.setVRMode(active),
      onDebugUpdate: (info) => store.setDebugInfo(info),
      onEditableHotspots: (list) => setEditableHotspots(list),
      onEditableExperiences: (list) => setEditableExperiences(list),
      onEvent: (event, payload) => trackEvent(event as never, payload as never),
    });
    engineRef.current = engine;
    engine.setDebug(debug);
    engine.setEditMode(edit);
    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as { __vrEngine?: VRSceneEngine }).__vrEngine = engine;
    }

    // Detect XR support in parallel with the first scene load.
    void detectXRSupport().then((support) => {
      if (!cancelled) store.setXRSupport(support);
    });

    void engine.start(initialScene);

    // Ambient background music — starts muted-by-policy until a user gesture;
    // AmbientAudio retries automatically on the first click/keypress.
    const audio = new AmbientAudio('/vr/audio/ambient.mp3');
    audio.setMuted(store.isMuted);
    audio.start();
    audioRef.current = audio;
    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as { __vrAudio?: AmbientAudio }).__vrAudio = audio;
    }

    const onUnload = () => flushSession();
    window.addEventListener('beforeunload', onUnload);

    return () => {
      cancelled = true;
      window.removeEventListener('beforeunload', onUnload);
      flushSession();
      engine.dispose();
      engineRef.current = null;
      audio.dispose();
      audioRef.current = null;
    };
  }, []);

  const handleEnterVR = () => {
    engineRef.current?.enterVR().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Failed to enter VR:', err);
    });
  };

  const handleCloseProduct = () => {
    engineRef.current?.closeProductPanel();
  };

  const handleToggleMute = () => {
    const next = !useVRStore.getState().isMuted;
    audioRef.current?.setMuted(next);
    useVRStore.getState().setMuted(next);
  };

  const handleToggleDebug = () => {
    const next = !useVRStore.getState().debugEnabled;
    engineRef.current?.setDebug(next);
    useVRStore.getState().setDebugEnabled(next);
  };

  /** Floor selector (§4): switch to a floor's Entry panorama — a smooth
   *  in-scene transition, never a reload. No-op if already on that floor. */
  const handleSelectFloor = (floorId: string) => {
    if (getFloorIdForScene(currentScene ?? '') === floorId) return;
    const target = getFloorEntrySceneId(floorId);
    if (target) engineRef.current?.goToScene(target);
  };

  /** Warm a floor's Entry panorama on hover/touch of its selector label (§9). */
  const handlePreloadFloor = (floorId: string) => {
    const target = getFloorEntrySceneId(floorId);
    if (target) engineRef.current?.preloadScene(target);
  };

  const handleRecenter = () => {
    engineRef.current?.recenterView();
  };

  /** Toggle the hotspot placement editor from the chrome (no ?edit=true needed). */
  const handleToggleEdit = () => {
    const next = !editMode;
    setEditMode(next);
    engineRef.current?.setEditMode(next);
  };

  const sceneName = currentScene
    ? currentScene.startsWith('custom:')
      ? currentScene.slice('custom:'.length)
      : getSceneById(currentScene)?.name ?? null
    : null;

  return (
    <div className="relative h-full w-full overflow-hidden bg-qween-void">
      {/* Three.js mounts its canvas here. */}
      <div ref={containerRef} className="absolute inset-0" style={{ cursor: 'grab' }} />

      <LoadingScreen visible={!isReady || isLoading} progress={loadingProgress} />

      <VRControls
        xrSupport={xrSupport}
        isVRMode={isVRMode}
        sceneName={sceneName}
        isProductPanelOpen={isProductPanelOpen}
        isMuted={isMuted}
        debugEnabled={debugEnabled}
        editEnabled={editMode}
        floors={FLOOR_OPTIONS}
        activeFloorId={currentScene ? getFloorIdForScene(currentScene) : null}
        onEnterVR={handleEnterVR}
        onCloseProduct={handleCloseProduct}
        onToggleMute={handleToggleMute}
        onToggleDebug={handleToggleDebug}
        onToggleEdit={handleToggleEdit}
        onSelectFloor={handleSelectFloor}
        onPreloadFloor={handlePreloadFloor}
        onRecenter={handleRecenter}
      />

      {testMode && !isVRMode && (
        <PanoramaTester
          activeSceneId={currentScene}
          onLoad={(url, name) => engineRef.current?.showPanoramaFromURL(url, name)}
        />
      )}

      {editMode && !isVRMode && (
        <HotspotEditor
          hotspots={editableHotspots}
          sceneName={sceneName}
          currentSceneId={currentScene}
          onGoToScene={(id) => engineRef.current?.goToScene(id)}
          onNudge={(id, axis, delta) => engineRef.current?.nudgeHotspot(id, axis, delta)}
          onSetPosition={(id, pos) => engineRef.current?.setHotspotPosition(id, pos)}
          onAddHotspot={(targetSceneId) => engineRef.current?.addHotspot(targetSceneId)}
          onRemoveHotspot={(id) => engineRef.current?.removeHotspot(id)}
          onSetTarget={(id, targetSceneId) => engineRef.current?.setHotspotTarget(id, targetSceneId)}
          onSetLabel={(id, label) => engineRef.current?.setHotspotLabel(id, label)}
          experiences={editableExperiences}
          onAddExperience={() => engineRef.current?.addExperience()}
          onUpdateExperience={(id, patch) => engineRef.current?.updateExperience(id, patch)}
          onRemoveExperience={(id) => engineRef.current?.removeExperience(id)}
          onDuplicateExperience={(id) => engineRef.current?.duplicateExperience(id)}
          onToggleExperienceActive={(id, active) => engineRef.current?.setExperienceActive(id, active)}
          onPreviewExperience={(id) => engineRef.current?.previewExperience(id)}
        />
      )}

      {debugEnabled && <DebugOverlay info={debugInfo} />}

      {debugEnabled && !isVRMode && (
        <ViewControlsPanel engine={engineRef.current} currentSceneId={currentScene} />
      )}
    </div>
  );
}

/** Reflect the active scene in the URL without adding history entries. */
function syncSceneParam(sceneId: string) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('scene', sceneId);
    window.history.replaceState({}, '', url.toString());
  } catch {
    /* ignore */
  }
}
