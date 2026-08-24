'use client';

import { useState } from 'react';
import type { EditableExperience, EditableHotspot } from '@/lib/vr/engine';
import type { ExperienceHotspot, ExperiencePiece } from '@/types/vr';
import { scenes } from '@/data/scenes';
import { getFloorIdForScene } from '@/data/floors';
import { products } from '@/data/products';
import {
  clearHotspotOverrides,
  saveHotspotOverrides,
  saveExperienceOverrides,
  type HotspotOverrides,
  type ExperienceOverrides,
} from '@/lib/vr/hotspotOverrides';

type ExperiencePatch = Partial<Omit<ExperienceHotspot, 'id' | 'type'>>;

/** Catalogue products offered when adding a featured piece. */
const PRODUCT_OPTIONS = products.map((p) => ({ id: p.id, name: p.name }));

/** Every scene as a { id, label } option for target pickers. */
const SCENE_OPTIONS: { id: string; label: string }[] = scenes.map((s) => {
  const floorId = getFloorIdForScene(s.id);
  const node = floorId ? s.id.slice(floorId.length + 1) : s.id;
  return { id: s.id, label: floorId ? `${floorId} · ${node}` : s.id };
});

interface HotspotEditorProps {
  /** Current scene's hotspots (live positions), emitted by the engine. */
  hotspots: EditableHotspot[];
  sceneName: string | null;
  currentSceneId: string | null;
  /** Jump to any scene (so every scene's pads can be edited). */
  onGoToScene: (sceneId: string) => void;
  /** Nudge one axis of a hotspot by ±step (metres). */
  onNudge: (id: string, axis: 'x' | 'y' | 'z', delta: number) => void;
  /** Set an exact position (from a typed value). */
  onSetPosition: (id: string, pos: { x: number; y: number; z: number }) => void;
  /** Add a new hotspot to the current scene, pointing at targetSceneId. */
  onAddHotspot: (targetSceneId: string) => void;
  /** Remove a hotspot from the current scene. */
  onRemoveHotspot: (id: string) => void;
  /** Reassign a hotspot's destination scene. */
  onSetTarget: (id: string, targetSceneId: string) => void;
  /** Rename a hotspot (the small label shown on the pad). */
  onSetLabel: (id: string, label: string) => void;

  /* Experience (persona) hotspots. */
  experiences: EditableExperience[];
  onAddExperience: () => void;
  onUpdateExperience: (id: string, patch: ExperiencePatch) => void;
  onRemoveExperience: (id: string) => void;
  onDuplicateExperience: (id: string) => void;
  onToggleExperienceActive: (id: string, active: boolean) => void;
  onPreviewExperience: (id: string) => void;
}

const STEPS = [0.1, 0.25, 0.5, 1] as const;

/**
 * Desktop hotspot placement editor (§?edit=true).
 *
 * Two ways to place a hotspot:
 *  - Drag it in the 3D view (coarse) — floor pads slide across the floor,
 *    billboards swing around the view sphere.
 *  - Fine-tune each axis with the −/+ nudge buttons or type an exact value.
 *
 * The engine mutates the in-memory scene data live; this panel mirrors the
 * positions and generates a `data/floors.ts`-ready snippet to copy back
 * (runtime edits aren't persisted — paste the snippet to bake them in).
 */
export function HotspotEditor({
  hotspots,
  sceneName,
  currentSceneId,
  onGoToScene,
  onNudge,
  onSetPosition,
  onAddHotspot,
  onRemoveHotspot,
  onSetTarget,
  onSetLabel,
  experiences,
  onAddExperience,
  onUpdateExperience,
  onRemoveExperience,
  onDuplicateExperience,
  onToggleExperienceActive,
  onPreviewExperience,
}: HotspotEditorProps) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [step, setStep] = useState<number>(0.25);
  const [selected, setSelected] = useState<string | null>(null);
  // Default the "add" target to the first scene that isn't the current one.
  const [addTarget, setAddTarget] = useState<string>(
    () => SCENE_OPTIONS.find((o) => o.id !== currentSceneId)?.id ?? SCENE_OPTIONS[0]?.id ?? '',
  );
  const [expandedExp, setExpandedExp] = useState<string | null>(null);

  const exportText = generateFloorsSnippet(experiences, currentSceneId);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(exportText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the <pre> below is selectable as a fallback */
    }
  };

  /** Persist every scene's current positions locally so edits survive reload
   *  (until baked into data/floors.ts via the copied snippet). */
  const save = () => {
    const map: HotspotOverrides = {};
    for (const s of scenes) {
      const navs = s.hotspots.filter((h) => h.type === 'navigation');
      if (navs.length === 0) continue;
      map[s.id] = navs.map((h) => ({
        targetSceneId: h.type === 'navigation' ? h.targetSceneId : '',
        position: { x: r(h.position.x), y: r(h.position.y), z: r(h.position.z) },
        style: (h.type === 'navigation' && h.style) || 'floor',
        label: (h.type === 'navigation' && h.label) || 'Explore',
      }));
    }
    saveHotspotOverrides(map);

    // Persist experience hotspots (all scenes) under their own key.
    const expMap: ExperienceOverrides = {};
    for (const s of scenes) {
      const exps = s.hotspots.filter(
        (h): h is ExperienceHotspot => h.type === 'experience',
      );
      if (exps.length === 0) continue;
      expMap[s.id] = exps.map((e) => ({
        id: e.id,
        name: e.name,
        label: e.label,
        category: e.category,
        description: e.description,
        position: { x: r(e.position.x), y: r(e.position.y), z: r(e.position.z) },
        pieces: e.pieces.map((p) => ({ ...p })),
        active: e.active !== false,
        ...(e.color ? { color: e.color } : {}),
      }));
    }
    saveExperienceOverrides(expMap);

    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  };

  const clearSaved = () => {
    clearHotspotOverrides();
    setSaved(false);
  };

  return (
    <div className="pointer-events-auto absolute left-3 top-3 z-50 flex max-h-[94vh] w-[340px] flex-col rounded-md border border-white/10 bg-black/80 p-3 font-mono text-[11px] leading-relaxed text-qween-diamond backdrop-blur">
      <div className="mb-1 font-sans text-[10px] uppercase tracking-brand text-qween-gold-soft">
        Hotspot Editor
      </div>
      <div className="mb-2 text-qween-mist">
        Drag a pad in the view for coarse placement, or use −/+ (or type) below
        for precise nudges. Clicks don’t navigate in edit mode.
      </div>

      <div className="text-qween-mist">
        scene: <span className="text-qween-diamond">{sceneName ?? currentSceneId ?? '—'}</span>
      </div>

      {/* Step size selector — shared by all nudge buttons. */}
      <div className="mt-2 flex items-center gap-2">
        <span className="text-qween-mist">step</span>
        <div className="flex gap-1">
          {STEPS.map((s) => (
            <button
              key={s}
              onClick={() => setStep(s)}
              className={`rounded border px-1.5 py-0.5 text-[10px] transition ${
                s === step
                  ? 'border-qween-gold bg-qween-gold/80 text-qween-void'
                  : 'border-qween-line text-qween-diamond hover:bg-white/10'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <span className="text-qween-mist">m</span>
      </div>

      {/* Per-hotspot precise controls. */}
      <div className="mt-2 border-t border-white/10 pt-2">
        {hotspots.length === 0 && (
          <div className="text-qween-mist">no hotspots in this scene</div>
        )}
        {hotspots.map((h) => {
          const isSel = selected === h.id;
          return (
            <div
              key={h.id}
              className={`mb-2 rounded border p-2 transition ${
                isSel ? 'border-qween-gold/60 bg-white/[0.03]' : 'border-white/10'
              }`}
              onMouseEnter={() => setSelected(h.id)}
            >
              <div className="mb-1 flex items-center gap-1.5">
                <span className="text-qween-mist">→</span>
                <select
                  value={h.targetSceneId}
                  onChange={(e) => onSetTarget(h.id, e.target.value)}
                  title="Destination scene"
                  className="min-w-0 flex-1 rounded border border-white/10 bg-black/60 px-1.5 py-0.5 text-qween-diamond outline-none focus:border-qween-gold/60"
                >
                  {SCENE_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => onGoToScene(h.targetSceneId)}
                  title={`Open ${h.targetSceneId}`}
                  className="rounded border border-qween-line px-1.5 py-0.5 text-[10px] text-qween-gold-soft transition hover:bg-white/10"
                >
                  open
                </button>
                <button
                  onClick={() => onRemoveHotspot(h.id)}
                  title="Delete this hotspot"
                  className="rounded border border-qween-line px-1.5 py-0.5 text-[10px] text-qween-mist transition hover:bg-white/10 hover:text-qween-diamond"
                >
                  ✕
                </button>
              </div>

              {/* Name — shown subtly on the pad in-scene. */}
              <NameRow
                value={h.label}
                onSet={(v) => onSetLabel(h.id, v)}
              />

              {(['x', 'y', 'z'] as const).map((axis) => (
                <AxisRow
                  key={axis}
                  axis={axis}
                  value={h.position[axis]}
                  onDec={() => onNudge(h.id, axis, -step)}
                  onInc={() => onNudge(h.id, axis, step)}
                  onSet={(v) => onSetPosition(h.id, { ...h.position, [axis]: v })}
                />
              ))}
            </div>
          );
        })}

        {/* Add a new hotspot to this scene. */}
        <div className="mt-1 flex items-center gap-1.5">
          <select
            value={addTarget}
            onChange={(e) => setAddTarget(e.target.value)}
            title="Destination for the new hotspot"
            className="min-w-0 flex-1 rounded border border-white/10 bg-black/60 px-1.5 py-1 text-qween-diamond outline-none focus:border-qween-gold/60"
          >
            {SCENE_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => addTarget && onAddHotspot(addTarget)}
            className="rounded border border-qween-line bg-qween-gold/90 px-3 py-1 font-sans text-[10px] uppercase tracking-widest text-qween-void transition hover:bg-qween-gold"
          >
            + Add
          </button>
        </div>
        <div className="mt-1 text-[10px] text-qween-mist">
          New pad drops in front of you — drag or nudge it into place.
        </div>
      </div>

      {/* Jump to any scene so every scene's pads can be edited. */}
      <div className="mt-1 border-t border-white/10 pt-1">
        <div className="mb-1 text-qween-mist">go to scene:</div>
        {sceneGroups.map(({ floorId, ids }) => (
          <div key={floorId} className="mb-1">
            <div className="text-[10px] uppercase tracking-widest text-qween-mist">{floorId}</div>
            <div className="flex flex-wrap gap-1">
              {ids.map((id) => (
                <button
                  key={id}
                  onClick={() => onGoToScene(id)}
                  className={`rounded border px-1.5 py-0.5 text-[10px] transition ${
                    id === currentSceneId
                      ? 'border-qween-gold bg-qween-gold/80 text-qween-void'
                      : 'border-qween-line text-qween-diamond hover:bg-white/10'
                  }`}
                >
                  {nodeOf(id, floorId)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Experience (persona) hotspots. */}
      <div className="mt-2 border-t border-white/10 pt-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-widest text-qween-gold-soft">
            Experience Hotspots
          </span>
          <button
            onClick={onAddExperience}
            className="rounded border border-qween-line bg-qween-gold/90 px-2 py-0.5 text-[10px] uppercase tracking-widest text-qween-void transition hover:bg-qween-gold"
          >
            + New
          </button>
        </div>
        {experiences.length === 0 && (
          <div className="text-qween-mist">no experience hotspots in this scene</div>
        )}
        {experiences.map((e) => (
          <ExperienceRow
            key={e.id}
            exp={e}
            step={step}
            expanded={expandedExp === e.id}
            onToggleExpand={() => setExpandedExp(expandedExp === e.id ? null : e.id)}
            onUpdate={onUpdateExperience}
            onRemove={onRemoveExperience}
            onDuplicate={onDuplicateExperience}
            onToggleActive={onToggleExperienceActive}
            onPreview={onPreviewExperience}
          />
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/10 pt-2">
        <button
          onClick={save}
          title="Persist positions locally so they survive a reload"
          className="rounded border border-qween-line bg-black/50 px-3 py-1 font-sans text-[10px] uppercase tracking-widest text-qween-diamond transition hover:bg-black/70"
        >
          {saved ? 'Saved ✓' : 'Save'}
        </button>
        <button
          onClick={copy}
          className="rounded border border-qween-line bg-qween-gold/90 px-3 py-1 font-sans text-[10px] uppercase tracking-widest text-qween-void transition hover:bg-qween-gold"
        >
          {copied ? 'Copied ✓' : 'Copy all positions'}
        </button>
        <button
          onClick={clearSaved}
          title="Forget locally-saved positions (data/floors.ts still applies)"
          className="rounded border border-qween-line px-2 py-1 font-sans text-[10px] uppercase tracking-widest text-qween-mist transition hover:bg-white/10"
        >
          Clear
        </button>
      </div>
      <div className="mt-1 font-sans text-[10px] text-qween-mist">
        Save keeps edits across reloads · Copy → paste to Claude / data/floors.ts to make permanent
      </div>

      <pre className="mt-2 max-h-[32vh] select-text overflow-auto rounded border border-white/10 bg-black/60 p-2 text-[10px] leading-snug text-qween-mist">
        {exportText}
      </pre>
    </div>
  );
}

/** Name row: a text field committing on blur / Enter. */
/** One experience hotspot row: summary + expandable editor. */
function ExperienceRow({
  exp,
  step,
  expanded,
  onToggleExpand,
  onUpdate,
  onRemove,
  onDuplicate,
  onToggleActive,
  onPreview,
}: {
  exp: EditableExperience;
  step: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onUpdate: (id: string, patch: ExperiencePatch) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onToggleActive: (id: string, active: boolean) => void;
  onPreview: (id: string) => void;
}) {
  const setPiece = (i: number, patch: Partial<ExperiencePiece>) => {
    const pieces = exp.pieces.map((p, idx) => (idx === i ? { ...p, ...patch } : p));
    onUpdate(exp.id, { pieces });
  };
  const addPiece = () => {
    if (exp.pieces.length >= 4) return;
    onUpdate(exp.id, { pieces: [...exp.pieces, { name: 'New Piece', image: 'placeholder://ring' }] });
  };
  const removePiece = (i: number) => {
    if (exp.pieces.length <= 1) return;
    onUpdate(exp.id, { pieces: exp.pieces.filter((_, idx) => idx !== i) });
  };

  return (
    <div className="mb-2 rounded border border-white/10 p-2">
      <div className="flex items-center gap-1.5">
        <button
          onClick={onToggleExpand}
          className="min-w-0 flex-1 text-left"
          title="Edit"
        >
          <span className="text-qween-gold-soft">{expanded ? '▾' : '▸'} </span>
          <span className="text-qween-diamond">{exp.name || '(unnamed)'}</span>
          <span className="ml-1 text-qween-mist">
            · {exp.category} / {exp.pieces.length} pieces
          </span>
        </button>
        <span className={`text-[9px] uppercase ${exp.active ? 'text-emerald-400' : 'text-qween-mist'}`}>
          {exp.active ? 'Active' : 'Off'}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap gap-1">
        <MiniBtn label="Preview" onClick={() => onPreview(exp.id)} />
        <MiniBtn label={exp.active ? 'Disable' : 'Enable'} onClick={() => onToggleActive(exp.id, !exp.active)} />
        <MiniBtn label="Duplicate" onClick={() => onDuplicate(exp.id)} />
        <MiniBtn label="Delete" onClick={() => onRemove(exp.id)} />
      </div>

      {expanded && (
        <div className="mt-2 border-t border-white/10 pt-2">
          <TextField label="Name" value={exp.name} onSet={(v) => onUpdate(exp.id, { name: v })} />
          <TextField label="Label" value={exp.label} onSet={(v) => onUpdate(exp.id, { label: v.toUpperCase() })} />
          <TextField label="Category" value={exp.category} onSet={(v) => onUpdate(exp.id, { category: v })} />
          <TextField
            label="Desc"
            value={exp.description}
            multiline
            onSet={(v) => onUpdate(exp.id, { description: v.slice(0, 180) })}
          />

          <div className="mt-2 mb-1 text-qween-mist">featured pieces ({exp.pieces.length}/4):</div>
          {exp.pieces.map((p, i) => (
            <div key={i} className="mb-1 rounded border border-white/10 p-1.5">
              <div className="flex items-center gap-1.5">
                <select
                  value={p.productId ?? ''}
                  onChange={(ev) => {
                    const id = ev.target.value || undefined;
                    const prod = PRODUCT_OPTIONS.find((o) => o.id === id);
                    setPiece(i, { productId: id, name: p.name || prod?.name });
                  }}
                  title="Link a catalogue product (image / 3D / PDP)"
                  className="min-w-0 flex-1 rounded border border-white/10 bg-black/60 px-1 py-0.5 text-qween-diamond outline-none focus:border-qween-gold/60"
                >
                  <option value="">— custom —</option>
                  {PRODUCT_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
                <button
                  onClick={() => removePiece(i)}
                  className="rounded border border-qween-line px-1.5 text-[10px] text-qween-mist hover:bg-white/10"
                >
                  ✕
                </button>
              </div>
              <TextField label="Name" value={p.name ?? ''} onSet={(v) => setPiece(i, { name: v })} />
              <TextField label="Meta" value={p.meta ?? ''} onSet={(v) => setPiece(i, { meta: v })} />
              {!p.productId && (
                <TextField label="Image" value={p.image ?? ''} onSet={(v) => setPiece(i, { image: v })} />
              )}
            </div>
          ))}
          {exp.pieces.length < 4 && <MiniBtn label="+ Piece" onClick={addPiece} />}

          <div className="mt-2 mb-1 text-qween-mist">position:</div>
          {(['x', 'y', 'z'] as const).map((axis) => (
            <AxisRow
              key={axis}
              axis={axis}
              value={exp.position[axis]}
              onDec={() => onUpdate(exp.id, { position: { ...exp.position, [axis]: r(exp.position[axis] - step) } })}
              onInc={() => onUpdate(exp.id, { position: { ...exp.position, [axis]: r(exp.position[axis] + step) } })}
              onSet={(v) => onUpdate(exp.id, { position: { ...exp.position, [axis]: v } })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MiniBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded border border-qween-line px-1.5 py-0.5 text-[10px] text-qween-diamond transition hover:bg-white/10"
    >
      {label}
    </button>
  );
}

/** A labelled text field committing on blur / Enter (single or multi-line). */
function TextField({
  label,
  value,
  onSet,
  multiline,
}: {
  label: string;
  value: string;
  onSet: (v: string) => void;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    onSet(draft);
    setDraft(null);
  };
  const common = {
    value: draft ?? value,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onFocus: () => setDraft(value),
    onBlur: commit,
    className:
      'min-w-0 flex-1 rounded border border-white/10 bg-black/60 px-1.5 py-0.5 text-qween-diamond outline-none focus:border-qween-gold/60',
  };
  return (
    <div className="mt-1 flex items-start gap-1.5">
      <span className="mt-0.5 w-10 shrink-0 text-qween-mist">{label}</span>
      {multiline ? (
        <textarea
          {...common}
          rows={2}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setDraft(null);
          }}
        />
      ) : (
        <input
          {...common}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setDraft(null);
          }}
        />
      )}
    </div>
  );
}

function NameRow({ value, onSet }: { value: string; onSet: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = draft.trim();
    if (v) onSet(v);
    setDraft(null);
  };
  return (
    <div className="mb-1 flex items-center gap-1.5">
      <span className="w-8 shrink-0 text-qween-mist">name</span>
      <input
        value={draft ?? value}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          setDraft(value);
          e.currentTarget.select();
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(null);
        }}
        placeholder="Explore"
        className="min-w-0 flex-1 rounded border border-white/10 bg-black/60 px-1.5 py-0.5 text-qween-diamond outline-none focus:border-qween-gold/60"
      />
    </div>
  );
}

/** One X/Y/Z row: −  [editable value]  + */
function AxisRow({
  axis,
  value,
  onDec,
  onInc,
  onSet,
}: {
  axis: 'x' | 'y' | 'z';
  value: number;
  onDec: () => void;
  onInc: () => void;
  onSet: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = parseFloat(draft);
    if (!Number.isNaN(v)) onSet(Math.round(v * 100) / 100);
    setDraft(null);
  };
  return (
    <div className="flex items-center gap-1.5 py-0.5">
      <span className="w-3 text-qween-mist">{axis}</span>
      <button
        onClick={onDec}
        className="h-5 w-5 rounded border border-qween-line text-qween-diamond transition hover:bg-white/10"
      >
        −
      </button>
      <input
        value={draft ?? value.toFixed(2)}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          setDraft(value.toFixed(2));
          e.currentTarget.select();
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(null);
        }}
        inputMode="decimal"
        className="w-16 rounded border border-white/10 bg-black/60 px-1.5 py-0.5 text-center text-qween-diamond outline-none focus:border-qween-gold/60"
      />
      <button
        onClick={onInc}
        className="h-5 w-5 rounded border border-qween-line text-qween-diamond transition hover:bg-white/10"
      >
        +
      </button>
    </div>
  );
}

/** All scenes grouped by floor, in graph order — for the "go to scene" list. */
const sceneGroups: { floorId: string; ids: string[] }[] = (() => {
  const groups: { floorId: string; ids: string[] }[] = [];
  for (const s of scenes) {
    const floorId = getFloorIdForScene(s.id) ?? 'other';
    let g = groups.find((x) => x.floorId === floorId);
    if (!g) {
      g = { floorId, ids: [] };
      groups.push(g);
    }
    g.ids.push(s.id);
  }
  return groups;
})();

/** Bare node name of a scene id within its floor (e.g. "ground-middle2" → "middle2"). */
function nodeOf(sceneId: string, floorId: string): string {
  return sceneId.startsWith(`${floorId}-`) ? sceneId.slice(floorId.length + 1) : sceneId;
}

/** Strip the floor prefix from a scene id → the bare node name. */
function targetNode(sceneId: string): string {
  const floor = getFloorIdForScene(sceneId);
  return floor ? sceneId.slice(floor.length + 1) : sceneId;
}

/**
 * Build a `data/floors.ts`-ready snippet from the live (edited) scene graph.
 * Grouped by scene; one line per hotspot. `style` is emitted only when it
 * isn't the default `'floor'`.
 */
function generateFloorsSnippet(
  experiences: EditableExperience[],
  currentSceneId: string | null,
): string {
  const out: string[] = ['// QWEEN hotspot positions — paste into data/floors.ts'];
  for (const s of scenes) {
    const floorId = getFloorIdForScene(s.id);
    const nodeId = floorId ? s.id.slice(floorId.length + 1) : s.id;
    const navs = s.hotspots.filter((h) => h.type === 'navigation');
    if (navs.length === 0) continue;
    out.push('', `// ${floorId} · ${nodeId}`);
    for (const h of navs) {
      if (h.type !== 'navigation') continue;
      const p = h.position;
      const style = h.style && h.style !== 'floor' ? `, style: '${h.style}'` : '';
      const name = h.label?.trim();
      const label = name && name !== 'Explore' ? `, label: '${name.replace(/'/g, "\\'")}'` : '';
      // Keep the full "floor-node" id for cross-floor targets so the floor
      // isn't lost on paste; use the bare node for same-floor targets.
      const targetFloor = getFloorIdForScene(h.targetSceneId);
      const target =
        targetFloor && targetFloor !== floorId ? h.targetSceneId : targetNode(h.targetSceneId);
      out.push(
        `{ target: '${target}', position: { x: ${r(p.x)}, y: ${r(p.y)}, z: ${r(p.z)} }${label}${style} },`,
      );
    }
  }

  // Experience hotspots for the current scene → an `experiences:` block.
  if (experiences.length > 0 && currentSceneId) {
    const floorId = getFloorIdForScene(currentSceneId);
    const nodeId = floorId ? currentSceneId.slice(floorId.length + 1) : currentSceneId;
    out.push('', `// experiences for ${floorId} · ${nodeId} — into that node's config`, 'experiences: [');
    for (const e of experiences) {
      const shortId = e.id.replace(`${currentSceneId}-exp-`, '');
      const pieces = e.pieces
        .map((p) => {
          const parts: string[] = [];
          if (p.productId) parts.push(`productId: '${p.productId}'`);
          if (p.name) parts.push(`name: '${esc(p.name)}'`);
          if (p.image) parts.push(`image: '${esc(p.image)}'`);
          if (p.meta) parts.push(`meta: '${esc(p.meta)}'`);
          return `        { ${parts.join(', ')} }`;
        })
        .join(',\n');
      const color = e.color ? `\n    color: '${e.color}',` : '';
      const active = e.active ? '' : '\n    active: false,';
      out.push(
        `  {
    id: '${shortId}',
    name: '${esc(e.name)}',
    label: '${esc(e.label)}',
    category: '${esc(e.category)}',
    description:
      '${esc(e.description)}',
    position: { x: ${r(e.position.x)}, y: ${r(e.position.y)}, z: ${r(e.position.z)} },${color}${active}
    pieces: [
${pieces}
    ],
  },`,
      );
    }
    out.push('],');
  }

  return out.join('\n');
}

function esc(s: string): string {
  return s.replace(/'/g, "\\'");
}

function r(n: number): number {
  return Math.round(n * 100) / 100;
}
