'use client';

/**
 * Live 3D machine view, drawn full-window as the page background with a floating view toolbar
 * (ARCHITECTURE §10.3). Positions come straight from the store via an
 * imperative subscription, so 4 Hz status updates never re-render React.
 */
import { Crosshair, Eraser, Maximize2, Route, Spline } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { reportUnits } from '@/lib/cnc/derive';
import { getState, subscribe, type MachineState } from '@/lib/cnc/store';
import { parseToolpath, type Toolpath } from '@/lib/gcode/toolpath';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { EDGE, getWidgetRects, subscribeWidgetRects, TOOLBAR_SPACE, TOP_BAR } from '@/lib/ui/layout';
import { MachineScene, type ScenePosition, type ViewPreset } from './MachineScene';

function readPosition(s: MachineState): ScenePosition | null {
  const status = s.controller.state?.status;
  if (s.connection.phase !== 'open' || !status?.activeState) return null;
  const num = (v: string | undefined) => (v === undefined || v === '' ? NaN : Number(v));
  const scale = reportUnits(s) === 'in' ? 25.4 : 1; // scene is always in mm
  const w = ['x', 'y', 'z'].map((a) => num(status.wpos?.[a as 'x']));
  const m = ['x', 'y', 'z'].map((a) => num(status.mpos?.[a as 'x']));
  if (w.some((v) => !Number.isFinite(v))) return null;
  const wcoReported = ['x', 'y', 'z'].map((a) => num(status.wco?.[a as 'x']));
  const wco = wcoReported.every(Number.isFinite)
    ? wcoReported
    : m.every(Number.isFinite)
      ? m.map((v, i) => v - w[i])
      : [0, 0, 0];
  return {
    work: new THREE.Vector3(w[0], w[1], w[2]).multiplyScalar(scale),
    wco: new THREE.Vector3(wco[0], wco[1], wco[2]).multiplyScalar(scale),
  };
}

/**
 * Screen insets covered by the top bar, the view toolbar and the open widgets. A widget counts
 * towards the side its centre is on; collapsed widgets (header only) are ignored.
 */
function freeAreaInsets() {
  const w = window.innerWidth;
  let left = 0;
  let right = 0;
  for (const r of getWidgetRects()) {
    if (r.height < 100) continue;
    if (r.x + r.width / 2 < w / 2) left = Math.max(left, r.x + r.width);
    else right = Math.max(right, w - r.x);
  }
  return { top: TOP_BAR, bottom: TOOLBAR_SPACE, left, right };
}

/**
 * Horizontal offset that centres the view toolbar in the free part of the bottom band: widgets
 * that reach down into it (and are open) push it towards the other side.
 */
function toolbarShift(): number {
  const w = window.innerWidth;
  const band = window.innerHeight - TOOLBAR_SPACE;
  let left = 0;
  let right = 0;
  for (const r of getWidgetRects()) {
    if (r.y + r.height <= band) continue;
    if (r.x + r.width / 2 < w / 2) left = Math.max(left, r.x + r.width);
    else right = Math.max(right, w - r.x);
  }
  return Math.round((left - right) / 2);
}

function samePosition(a: ScenePosition | null, b: ScenePosition | null): boolean {
  if (!a || !b) return a === b;
  return a.work.equals(b.work) && a.wco.equals(b.wco);
}

function IconToggle({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`pressable flex h-8 w-8 items-center justify-center rounded-lg border ${
        pressed ? 'border-accent/50 bg-accent-track/70 text-accent' : 'border-transparent text-ink-2 hover-fine:bg-surface-2 hover-fine:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

interface ProgramInfo {
  name: string;
  size: [number, number, number] | null; // feed extents, mm
  segments: number;
  warnings: string[];
  units: Toolpath['units'];
}

function fmtMm(v: number): string {
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

export default function VisualisationPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<MachineScene | null>(null);
  const [view, setView] = useState<ViewPreset>('iso');
  const [follow, setFollow] = useState(false);
  const [hasPosition, setHasPosition] = useState(false);
  const [webglError, setWebglError] = useState<string | null>(null);
  const [program, setProgram] = useState<ProgramInfo | null>(null);
  const [showProgram, setShowProgram] = useState(true);
  const [showRapids, setShowRapids] = useState(true);
  const [shift, setShift] = useState(0);
  const [topShift, setTopShift] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let scene: MachineScene;
    try {
      scene = new MachineScene(container);
    } catch (err) {
      setWebglError(err instanceof Error ? err.message : 'WebGL is not available');
      return;
    }
    sceneRef.current = scene;
    // Keep the free area current so the scene's own fits (first position, new program) frame
    // the content beside the widgets, not under them.
    scene.setFitInsets(freeAreaInsets());
    // First framing waits for the widgets to report where they are.
    let framed = false;
    const onRects = () => {
      scene.setFitInsets(freeAreaInsets());
      setShift(toolbarShift());
      const free = freeAreaInsets();
      setTopShift(Math.round((free.left - free.right) / 2));
      if (!framed && getWidgetRects().length > 0) {
        framed = true;
        requestAnimationFrame(() => scene.fit(280)); // wide when there is nothing to frame yet
      }
    };
    const unsubscribeRects = subscribeWidgetRects(onRects);
    onRects(); // the widgets may have mounted before this lazily loaded view

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    scene.setReducedMotion(motion.matches);
    const onMotion = () => scene.setReducedMotion(motion.matches);
    motion.addEventListener('change', onMotion);

    let last: ScenePosition | null = null;
    const update = () => {
      const next = readPosition(getState());
      if (samePosition(last, next)) return;
      last = next;
      scene.setPosition(next);
      setHasPosition(next !== null);
    };
    // Loaded program → toolpath. Parsed off the event handler; ~120 ms for a 190k-line file.
    let lastGcode: string | null = null;
    let parseTimer: ReturnType<typeof setTimeout> | undefined;
    const updateProgram = () => {
      const loaded = getState().program;
      const gcode = loaded?.gcode ?? null;
      if (gcode === lastGcode) return;
      lastGcode = gcode;
      clearTimeout(parseTimer);
      scene.clearTrail(); // program loaded, replaced or unloaded
      if (!loaded || !gcode) {
        scene.setToolpath(null);
        setProgram(null);
        return;
      }
      parseTimer = setTimeout(() => {
        const toolpath = parseToolpath(gcode);
        scene.setToolpath(toolpath);
        const fb = toolpath.feedBounds;
        setProgram({
          name: loaded.name,
          size: fb ? [fb.max[0] - fb.min[0], fb.max[1] - fb.min[1], fb.max[2] - fb.min[2]] : null,
          segments: toolpath.segmentCount,
          warnings: toolpath.warnings,
          units: toolpath.units,
        });
      }, 0);
    };

    // Passed lines are greyed out only while a job runs (lines acknowledged so far). When the job
    // completes or is stopped, the whole program is shown as remaining again.
    // The tool trail is cleared when a job starts and when the program is loaded, replaced or
    // unloaded, so a finished or removed job leaves nothing behind.
    let prevWorkflow = getState().workflow;
    const updateProgress = () => {
      const s = getState();
      if (prevWorkflow === 'idle' && s.workflow === 'running') scene.clearTrail();
      prevWorkflow = s.workflow;
      scene.setProgramProgress(s.program && s.sender && s.workflow !== 'idle' ? s.sender.received : null);
    };

    const onStore = () => {
      update();
      updateProgram();
      updateProgress();
    };
    onStore();
    const unsubscribe = subscribe(onStore);

    return () => {
      clearTimeout(parseTimer);
      unsubscribe();
      unsubscribeRects();
      motion.removeEventListener('change', onMotion);
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  /** Frame the content in the area the floating chrome leaves free. */
  const fit = () => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setFitInsets(freeAreaInsets());
    scene.fit();
  };

  const changeView = (preset: ViewPreset) => {
    setView(preset);
    sceneRef.current?.setView(preset);
    fit(); // presets frame the content
  };

  const toggleFollow = () => {
    const next = !follow;
    setFollow(next);
    sceneRef.current?.setFollow(next);
  };

  return (
    <>
      {/* The scene is the page background: fixed, full window, under every other layer. */}
      <div className="kq-scene-bg fixed inset-0 z-0">
        <div ref={containerRef} className="absolute inset-0" aria-label="3D view of the machine position" role="img" />
        {webglError ? (
          <div className="absolute inset-0 flex items-center justify-center text-[12px] text-ink-3">
            3D view unavailable: {webglError}
          </div>
        ) : null}
        <div
          className="pointer-events-none absolute bottom-4 left-4 flex items-center gap-3 text-[11px] text-ink-3"
          style={{ textShadow: '0 1px 2px rgb(0 0 0 / 0.6)' }}
        >
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-accent" aria-hidden /> Tool
          </span>
          {program && showProgram ? (
            <>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-3 bg-accent" aria-hidden /> Program
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-3 bg-[#5c626a]" aria-hidden /> Done
              </span>
              {showRapids ? (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-px w-3 bg-ink-3" aria-hidden /> Rapid
                </span>
              ) : null}
            </>
          ) : (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-px w-3 bg-[#2f6a94]" aria-hidden /> Path
            </span>
          )}
          <span>W0 work origin · M0 machine origin · grid 10 mm</span>
        </div>
      </div>

      {!webglError && !hasPosition ? (
        <div
          className="kq-alert pointer-events-none fixed inset-x-0 z-[5] flex justify-center"
          style={{ top: TOP_BAR + EDGE, translate: `${topShift}px 0` }}
        >
          <span className="glass rounded-full px-3 py-1 text-[12px] text-ink-2">No position — connect to a controller</span>
        </div>
      ) : null}

      {/* View toolbar: floats at the bottom centre, above the scene and below the widgets. */}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-3 z-[5] flex justify-center transition-transform duration-300 ease-[var(--ease-out-strong)] motion-reduce:transition-none"
        style={{ transform: `translateX(${shift}px)` }}
      >
        <div
          role="toolbar"
          aria-label="3D view"
          title="In the view: drag to orbit · right-drag to pan · scroll to zoom"
          className="kq-float-body glass pointer-events-auto flex h-11 items-center gap-1.5 rounded-[14px] px-1.5"
          style={{ ['--kq-stagger' as string]: '150ms' }}
        >
          {program && showProgram ? (
            <>
              <div className="flex max-w-[280px] min-w-0 flex-col justify-center px-2 leading-tight" title={[program.name, ...program.warnings].join('\n')}>
                <span className="truncate text-[12px] text-ink">{program.name}</span>
                <span className="truncate font-mono text-[10.5px] text-ink-3 tabular-nums">
                  {program.size
                    ? `${fmtMm(program.size[0])} × ${fmtMm(program.size[1])} × ${fmtMm(program.size[2])} mm`
                    : program.segments > 0
                      ? 'Rapid moves only'
                      : 'Nothing to draw'}
                  {program.units !== 'mm' ? ` · ${program.units === 'in' ? 'inch file' : 'mixed units'}` : ''}
                  {program.warnings.length > 0 ? ` · ${program.warnings.length} note${program.warnings.length > 1 ? 's' : ''}` : ''}
                </span>
              </div>
              <div className="mx-0.5 h-5 w-px bg-line" aria-hidden />
            </>
          ) : null}
          <div className="w-[168px]">
            <SegmentedControl
              ariaLabel="Camera view"
              segments={[
                { value: 'iso', label: 'Iso' },
                { value: 'top', label: 'Top' },
                { value: 'front', label: 'Front' },
              ]}
              value={view}
              onChange={changeView}
            />
          </div>
          <div className="mx-0.5 h-5 w-px bg-line" aria-hidden />
          <IconToggle
            label={showProgram ? 'Hide program toolpath' : 'Show program toolpath'}
            pressed={showProgram}
            onClick={() => {
              const next = !showProgram;
              setShowProgram(next);
              sceneRef.current?.setProgramVisible(next);
            }}
          >
            <Spline size={14} aria-hidden />
          </IconToggle>
          <IconToggle
            label={showRapids ? 'Hide rapid moves' : 'Show rapid moves'}
            pressed={showRapids}
            onClick={() => {
              const next = !showRapids;
              setShowRapids(next);
              sceneRef.current?.setShowRapids(next);
            }}
          >
            <Route size={14} aria-hidden />
          </IconToggle>
          <div className="mx-0.5 h-5 w-px bg-line" aria-hidden />
          <IconToggle label="Follow tool" pressed={follow} onClick={toggleFollow}>
            <Crosshair size={14} aria-hidden />
          </IconToggle>
          <IconToggle label="Fit to view" onClick={fit}>
            <Maximize2 size={14} aria-hidden />
          </IconToggle>
          <IconToggle label="Clear path" onClick={() => sceneRef.current?.clearTrail()}>
            <Eraser size={14} aria-hidden />
          </IconToggle>
        </div>
      </div>
    </>
  );
}
