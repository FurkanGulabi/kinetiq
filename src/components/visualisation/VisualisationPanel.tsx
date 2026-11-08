'use client';

/**
 * Live 3D machine view (replaces the Console panel). Positions come straight from the store via an
 * imperative subscription, so 4 Hz status updates never re-render React.
 */
import { Crosshair, Eraser, Maximize2, Route, Spline } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { reportUnits } from '@/lib/cnc/derive';
import { getState, subscribe, type MachineState } from '@/lib/cnc/store';
import { parseToolpath, type Toolpath } from '@/lib/gcode/toolpath';
import { Panel } from '@/components/ui/Panel';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
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
      className={`pressable flex h-7 w-7 items-center justify-center rounded-md border ${
        pressed ? 'border-accent bg-accent-track text-accent' : 'border-line bg-surface-2 text-ink-2 hover-fine:text-ink'
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
      motion.removeEventListener('change', onMotion);
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  const changeView = (preset: ViewPreset) => {
    setView(preset);
    sceneRef.current?.setView(preset);
    sceneRef.current?.fit(); // presets frame the content
  };

  const toggleFollow = () => {
    const next = !follow;
    setFollow(next);
    sceneRef.current?.setFollow(next);
  };

  return (
    <Panel
      title="Visualisation"
      flush
      actions={
        <>
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
          <IconToggle label="Fit to view" onClick={() => sceneRef.current?.fit()}>
            <Maximize2 size={14} aria-hidden />
          </IconToggle>
          <IconToggle label="Clear path" onClick={() => sceneRef.current?.clearTrail()}>
            <Eraser size={14} aria-hidden />
          </IconToggle>
        </>
      }
    >
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={containerRef} className="absolute inset-0" aria-label="3D view of the machine position" role="img" />

        {webglError ? (
          <div className="absolute inset-0 flex items-center justify-center text-[12px] text-ink-3">
            3D view unavailable: {webglError}
          </div>
        ) : !hasPosition ? (
          <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
            <span className="rounded-full border border-line bg-surface/90 px-3 py-1 text-[12px] text-ink-3">
              No position — connect to a controller
            </span>
          </div>
        ) : null}

        {program && showProgram ? (
          <div className="pointer-events-none absolute top-3 left-3 max-w-[60%] rounded-md border border-line bg-surface/90 px-3 py-2 text-[11px] text-ink-3">
            <div className="truncate text-[12px] text-ink" title={program.name}>
              {program.name}
            </div>
            <div className="font-mono tabular-nums">
              {program.size
                ? `${fmtMm(program.size[0])} × ${fmtMm(program.size[1])} × ${fmtMm(program.size[2])} mm (cut extents)`
                : program.segments > 0
                  ? 'Rapid moves only'
                  : 'Nothing to draw'}
              {program.units !== 'mm' ? ` · file in ${program.units === 'in' ? 'inches' : 'mixed units'}` : ''}
            </div>
            {program.warnings.length > 0 ? <div className="mt-0.5">{program.warnings.join(' · ')}</div> : null}
          </div>
        ) : null}

        <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-3 text-[11px] text-ink-3">
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
        <div className="pointer-events-none absolute right-3 bottom-3 text-[11px] text-ink-3">
          Drag to orbit · right-drag to pan · scroll to zoom
        </div>
      </div>
    </Panel>
  );
}
