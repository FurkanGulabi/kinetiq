'use client';

/**
 * Live 3D machine view (replaces the Console panel). Positions come straight from the store via an
 * imperative subscription, so 4 Hz status updates never re-render React.
 */
import { Crosshair, Eraser, Maximize2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { reportUnits } from '@/lib/cnc/derive';
import { getState, subscribe, type MachineState } from '@/lib/cnc/store';
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

export default function VisualisationPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<MachineScene | null>(null);
  const [view, setView] = useState<ViewPreset>('iso');
  const [follow, setFollow] = useState(false);
  const [hasPosition, setHasPosition] = useState(false);
  const [webglError, setWebglError] = useState<string | null>(null);

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
    update();
    const unsubscribe = subscribe(update);

    return () => {
      unsubscribe();
      motion.removeEventListener('change', onMotion);
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  const changeView = (preset: ViewPreset) => {
    setView(preset);
    sceneRef.current?.setView(preset);
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

        <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-3 text-[11px] text-ink-3">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-accent" aria-hidden /> Tool
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-px w-3 bg-[#2f6a94]" aria-hidden /> Path
          </span>
          <span>W0 work origin · M0 machine origin · grid 10 mm</span>
        </div>
        <div className="pointer-events-none absolute right-3 bottom-3 text-[11px] text-ink-3">
          Drag to orbit · right-drag to pan · scroll to zoom
        </div>
      </div>
    </Panel>
  );
}
