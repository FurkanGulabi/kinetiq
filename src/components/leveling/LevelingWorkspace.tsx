'use client';

/**
 * Bed leveling workspace: prepare → probe a grid → inspect the height map → level the loaded job.
 *
 * Left: checklist, probe area, probing settings, Start/Cancel with progress.
 * Centre: the height map (live while probing) or the planned grid, with a table view.
 * Right: surface statistics, map status (does it still line up?), applying it to the loaded job,
 * and map import/export.
 */
import * as Dialog from '@radix-ui/react-dialog';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Crosshair,
  Download,
  Info,
  Layers,
  Loader2,
  OctagonX,
  Play,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { loadProgram } from '@/lib/cnc/client';
import { jobView, levelingView, workOffset } from '@/lib/cnc/derive';
import { useMachine } from '@/lib/cnc/store';
import { parseToolpath } from '@/lib/gcode/toolpath';
import { compensate, type CompensationResult } from '@/lib/leveling/compensate';
import { emptyMap, mapStats, offsetDrift, validateHeightMap, type HeightMap } from '@/lib/leveling/heightmap';
import {
  cancelLeveling,
  clearLevelingResult,
  discardProbing,
  estimateSeconds,
  initLeveling,
  LEVELING_LIMITS,
  levelingSettingsError,
  runLeveling,
  setHeightMap,
  updateLevelingSettings,
  useLeveling,
  type LevelingSettings,
} from '@/lib/leveling/run';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { HeightMapTable, HeightMapView } from './HeightMapView';

const duration = (s: number) => (s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);
const mm = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)} mm`;

/* ------------------------------------------------------------------------------------------------
 * Inputs
 * ---------------------------------------------------------------------------------------------- */

function NumberField({
  label,
  value,
  onChange,
  unit,
  disabled,
  integer,
  title,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  disabled?: boolean;
  integer?: boolean;
  title?: string;
}) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(Number.isFinite(value) ? String(value) : '');
  }, [value]);
  return (
    <label className="block" title={title}>
      <span className="text-[12px] text-ink-2">{label}</span>
      <span className="mt-0.5 flex items-center gap-1.5">
        <input
          inputMode="decimal"
          value={text}
          disabled={disabled}
          onFocus={() => (focused.current = true)}
          onBlur={() => {
            focused.current = false;
            setText(Number.isFinite(value) ? String(value) : '');
          }}
          onChange={(e) => {
            const t = e.target.value.replace(',', '.').replace(integer ? /[^\d]/g : /[^\d.-]/g, '');
            setText(t);
            onChange(t === '' || t === '-' ? NaN : Number(t));
          }}
          className="h-8 w-full rounded-md border border-line bg-surface-2 px-2 text-right font-mono text-[12px] tabular-nums text-ink outline-none focus-visible:border-accent disabled:text-ink-3"
        />
        {unit ? <span className="w-12 shrink-0 text-[11px] text-ink-3">{unit}</span> : null}
      </span>
    </label>
  );
}

function Check({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-[12px] leading-[17px] text-ink-2">
      {ok === null ? (
        <CircleDot size={13} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
      ) : ok ? (
        <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-ok" aria-label="OK" />
      ) : (
        <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn" aria-label="Check" />
      )}
      <span>{children}</span>
    </li>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Workspace
 * ---------------------------------------------------------------------------------------------- */

export default function LevelingWorkspace() {
  const machine = useMachine((s) => s);
  const leveling = useLeveling();
  const view = levelingView(machine);
  const run = machine.leveling;
  const running = run.phase === 'running';
  const s = leveling.settings;
  const [centre, setCentre] = useState<'map' | 'plan' | 'table'>('map');
  const [apply, setApply] = useState<{ result: CompensationResult; source: string; busy: boolean } | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => initLeveling(), []);

  const update = (patch: Partial<LevelingSettings>) => updateLevelingSettings(patch);
  const settingsError = levelingSettingsError(s);

  // Job area: what the loaded program actually cuts (feed moves).
  const program = machine.program;
  const jobArea = useMemo(() => {
    if (!program?.gcode) return null;
    const b = parseToolpath(program.gcode).feedBounds;
    return b ? { xMin: b.min[0], xMax: b.max[0], yMin: b.min[1], yMax: b.max[1] } : null;
  }, [program?.gcode]);

  const useJobArea = () => {
    if (!jobArea) return;
    const r = (v: number) => Math.round(v * 10) / 10;
    update({ xMin: r(jobArea.xMin - s.margin), xMax: r(jobArea.xMax + s.margin), yMin: r(jobArea.yMin - s.margin), yMax: r(jobArea.yMax + s.margin) });
  };

  const rapid = useMemo(() => {
    const st = machine.controller.settings?.settings;
    const rates = [Number(st?.['$110']), Number(st?.['$111'])].filter((v) => Number.isFinite(v) && v > 0);
    return rates.length ? Math.min(...rates) : 500;
  }, [machine.controller.settings]);

  const plan: HeightMap | null = useMemo(
    () => (settingsError ? null : emptyMap(s, 'G54', { x: 0, y: 0, z: 0 }, { clearance: s.clearance, depth: s.depth, feed: s.feed })),
    [s, settingsError],
  );
  const map = leveling.map;
  const displayed = leveling.probing ?? (centre === 'plan' ? plan : map ?? plan);
  const stats = map ? mapStats(map) : null;
  const probingStats = leveling.probing ? mapStats(leveling.probing) : null;

  const wco = workOffset(machine);
  const wcs = machine.controller.state?.parserstate?.modal?.wcs || 'G54';
  const drift = map && wco ? offsetDrift(map, wco, wcs) : null;
  const touching = view.touching;
  const active = machine.controller.state?.status.activeState ?? '';
  const job = jobView(machine, Date.now());

  const canStart = view.canProbe.enabled && !settingsError;
  const startReason = !view.canProbe.enabled ? view.canProbe.reason : settingsError ?? undefined;
  const estimate = settingsError ? null : estimateSeconds(s, rapid);
  const spacingX = s.nx > 1 ? (s.xMax - s.xMin) / (s.nx - 1) : NaN;
  const spacingY = s.ny > 1 ? (s.yMax - s.yMin) / (s.ny - 1) : NaN;
  const outsideJob = jobArea && !settingsError && (jobArea.xMin < s.xMin || jobArea.xMax > s.xMax || jobArea.yMin < s.yMin || jobArea.yMax > s.yMax);

  // Live elapsed time while probing.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);

  /* ---------------------------- apply to job ---------------------------- */
  const canApply = (() => {
    if (!map) return { ok: false, reason: 'Probe a height map first' };
    if (!program) return { ok: false, reason: 'Load a job first' };
    if (program.leveling) return { ok: false, reason: 'This program is already leveled. Open the original job to level it again.' };
    if (!job.canLoad.enabled) return { ok: false, reason: job.canLoad.reason ?? 'Not available now' };
    if (!drift) return { ok: false, reason: 'Waiting for the work position' };
    if (!drift.ok) return { ok: false, reason: drift.message ?? 'The map no longer lines up' };
    return { ok: true, reason: undefined };
  })();

  const onLevel = () => {
    if (!map || !program) return;
    setApplyBusy(true);
    setLoadError(null);
    // Let the button show its busy state before the (synchronous) compensation runs.
    setTimeout(() => {
      const result = compensate(program.gcode, map);
      setApply({ result, source: program.name, busy: false });
      setApplyBusy(false);
    }, 30);
  };

  const onLoadLeveled = async () => {
    if (!apply?.result.ok || !map || !wco) return;
    setApply({ ...apply, busy: true });
    try {
      const name = apply.source.replace(/(\.[^.]+)?$/, (ext) => ` (leveled)${ext}`);
      await loadProgram(name, apply.result.gcode, null, { mapId: map.id, wcs: map.wcs, wco: map.wco, sourceName: apply.source });
      setApply(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load the leveled program');
      setApply({ ...apply, busy: false });
    }
  };

  /* ---------------------------- import / export ---------------------------- */
  const onExport = () => {
    if (!map) return;
    const blob = new Blob([JSON.stringify(map, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date(map.createdAt);
    const pad = (v: number) => String(v).padStart(2, '0');
    a.href = URL.createObjectURL(blob);
    a.download = `heightmap-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onImport = async (file: File) => {
    setImportError(null);
    try {
      const parsed = validateHeightMap(JSON.parse(await file.text()));
      if (!parsed) throw new Error('This file is not a complete Kinetiq height map');
      setHeightMap(parsed);
      setCentre('map');
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Could not read the file');
    }
  };

  /* ---------------------------- render ---------------------------- */
  const verdict = (range: number) =>
    range <= 0.05
      ? 'Very flat. Leveling will make little difference.'
      : range <= 0.5
        ? 'Normal variation for a spoilboard or PCB blank. Leveling is worthwhile for shallow cuts.'
        : range <= 2
          ? 'Uneven. Leveling corrects it, but check the stock is clamped flat.'
          : 'Very uneven. Check the stock and the probe wiring before leveling a job.';

  return (
    <>
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Layers size={16} className="text-ink-3" aria-hidden />
        <div className="min-w-0 flex-1">
          <Dialog.Title className="text-[15px] font-semibold text-ink">Bed leveling</Dialog.Title>
          <p className="truncate text-[12px] text-ink-3">Probe the stock surface on a grid, then bend the job’s Z to follow it.</p>
        </div>
        <Dialog.Close asChild>
          <button type="button" className="pressable rounded p-1.5 text-ink-3 hover-fine:text-ink" aria-label="Close bed leveling">
            <X size={16} aria-hidden />
          </button>
        </Dialog.Close>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[340px_1fr_300px] gap-px bg-line">
        {/* ---------------- Left: prepare + probe ---------------- */}
        <div className="min-h-0 overflow-y-auto bg-surface p-4">
          <h3 className="panel-label mb-2">1 · Prepare</h3>
          <ul className="space-y-1.5">
            <Check ok={active ? active === 'Idle' : null}>
              Machine homed and <span className="text-ink">Idle</span>
              {active && active !== 'Idle' ? <> (now {active})</> : null}.
            </Check>
            <Check ok={null}>
              Work X/Y zero at the job origin, and <span className="text-ink">Z0 on the stock surface</span> (use Probe Z in the Position panel).
            </Check>
            <Check ok={touching === null ? null : !touching}>
              Probe clip on the bit and the probe wire on the stock (for PCBs: on the copper). Tap them together: the indicator should change.{' '}
              <span className={touching ? 'text-warn' : 'text-ink'}>{touching === null ? 'Probe —' : touching ? 'Probe touching' : 'Probe open'}</span>
            </Check>
            <Check ok={null}>
              Clearance must be above every clamp and screw in the area: the moves between points do not stop on contact.
            </Check>
          </ul>

          <h3 className="panel-label mt-5 mb-2">2 · Probe area (work coordinates)</h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <NumberField label="X from" value={s.xMin} onChange={(v) => update({ xMin: v })} unit="mm" disabled={running} />
            <NumberField label="X to" value={s.xMax} onChange={(v) => update({ xMax: v })} unit="mm" disabled={running} />
            <NumberField label="Y from" value={s.yMin} onChange={(v) => update({ yMin: v })} unit="mm" disabled={running} />
            <NumberField label="Y to" value={s.yMax} onChange={(v) => update({ yMax: v })} unit="mm" disabled={running} />
          </div>
          <div className="mt-2 flex items-end gap-3">
            <Button
              variant="secondary"
              onClick={useJobArea}
              disabled={!jobArea || running}
              disabledReason={running ? 'Probing in progress' : 'Load a job to use its area'}
              title={jobArea ? `Cutting area of the loaded job plus the margin` : undefined}
            >
              <Crosshair size={14} aria-hidden />
              Use job area
            </Button>
            <div className="w-28">
              <NumberField label="Margin" value={s.margin} onChange={(v) => update({ margin: v })} unit="mm" disabled={running} />
            </div>
          </div>
          {outsideJob ? (
            <p className="mt-2 flex items-start gap-1.5 text-[12px] text-warn">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
              The job cuts outside this area. Leveling refuses cuts outside the probed area.
            </p>
          ) : null}

          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
            <NumberField label="Points along X" value={s.nx} onChange={(v) => update({ nx: v })} integer disabled={running} />
            <NumberField label="Points along Y" value={s.ny} onChange={(v) => update({ ny: v })} integer disabled={running} />
          </div>
          <p className="mt-1 text-[12px] text-ink-3">
            {Number.isFinite(spacingX) && Number.isFinite(spacingY) ? `Spacing ${spacingX.toFixed(1)} × ${spacingY.toFixed(1)} mm. ` : ''}
            Closer points follow the surface better but take longer. 10–20 mm suits most PCBs.
          </p>

          <h3 className="panel-label mt-5 mb-2">3 · Probing</h3>
          <div className="grid grid-cols-3 gap-x-3 gap-y-2">
            {(['clearance', 'depth', 'feed'] as const).map((key) => (
              <NumberField
                key={key}
                label={LEVELING_LIMITS[key].label}
                value={s[key]}
                onChange={(v) => update({ [key]: v })}
                unit={LEVELING_LIMITS[key].unit}
                disabled={running}
                title={
                  key === 'clearance'
                    ? 'Work Z for moving between points'
                    : key === 'depth'
                      ? 'How far below Z0 a probe may go before giving up (Alarm 5)'
                      : 'Probing speed'
                }
              />
            ))}
          </div>

          <div className="mt-4 rounded-md border border-line bg-surface-2/50 px-3 py-2 text-[12px] text-ink-2">
            {settingsError ? (
              <span className="text-warn">{settingsError}</span>
            ) : (
              <>
                {s.nx * s.ny} points · about {duration(estimate ?? 0)}. Each point: move over it at Z{s.clearance}, probe down to at most Z−{s.depth} at {s.feed} mm/min,
                lift.
              </>
            )}
          </div>

          <div className="mt-3 flex items-center gap-2">
            {running ? (
              <Button variant="danger" onClick={cancelLeveling} disabled={run.cancelling} title="Stop probing: Feed hold, then Reset">
                <OctagonX size={14} aria-hidden />
                {run.cancelling ? 'Cancelling…' : 'Cancel'}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void runLeveling(s, rapid)} disabled={!canStart} disabledReason={startReason}>
                <Play size={14} aria-hidden />
                Probe height map
              </Button>
            )}
            {!running && !canStart && startReason ? <span className="min-w-0 flex-1 text-[12px] text-ink-3">{startReason}</span> : null}
          </div>

          {running ? (
            <div className="mt-3" role="status" aria-live="polite">
              <div className="flex items-center justify-between text-[12px]">
                <span className="flex items-center gap-1.5 text-accent">
                  <Loader2 size={12} className="animate-spin" aria-hidden />
                  {run.label}…
                </span>
                <span className="font-mono text-ink-3 tabular-nums">
                  {run.done}/{run.total} · {duration((now - run.startedAt) / 1000)}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-accent-track" role="progressbar" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.done}>
                <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${(run.done / run.total) * 100}%` }} />
              </div>
            </div>
          ) : null}

          {run.phase === 'done' ? (
            <Note tone="ok" onClose={clearLevelingResult}>
              Height map complete. Review it, then level the loaded job on the right.
            </Note>
          ) : run.phase === 'failed' ? (
            <Note tone="crit" onClose={clearLevelingResult}>
              {run.message}. The previous height map was kept.
              {run.hint ? <span className="mt-1 block text-ink-2">{run.hint}</span> : null}
            </Note>
          ) : run.phase === 'cancelled' ? (
            <Note tone="warn" onClose={clearLevelingResult}>
              Probing cancelled. The reset may leave the controller in Alarm: check the position before continuing.
            </Note>
          ) : null}
          {!running && leveling.probing ? (
            <button type="button" onClick={discardProbing} className="pressable mt-2 text-[12px] text-ink-3 hover-fine:text-ink">
              Discard the partial map
            </button>
          ) : null}
        </div>

        {/* ---------------- Centre: map ---------------- */}
        <div className="flex min-h-0 flex-col bg-surface p-4">
          <div className="mb-2 flex items-center gap-3">
            <h3 className="panel-label flex-1">
              {leveling.probing
                ? `Probing · ${probingStats?.probed ?? 0} of ${leveling.probing.xs.length * leveling.probing.ys.length} points`
                : centre === 'plan' || !map
                  ? 'Planned points'
                  : `Height map · probed ${new Date(map.createdAt).toLocaleString()}`}
            </h3>
            {!leveling.probing ? (
              <SegmentedControl
                ariaLabel="Map view"
                segments={[
                  { value: 'map', label: 'Map' },
                  { value: 'table', label: 'Table' },
                  { value: 'plan', label: 'Plan' },
                ]}
                value={centre}
                onChange={setCentre}
              />
            ) : null}
          </div>
          {displayed ? (
            centre === 'table' && !leveling.probing && map ? (
              <HeightMapTable map={map} />
            ) : (
              <HeightMapView map={displayed} current={leveling.current} jobArea={jobArea} />
            )
          ) : (
            <div className="flex flex-1 items-center justify-center text-[13px] text-ink-3">{settingsError}</div>
          )}
          {!map && !leveling.probing ? (
            <p className="mt-2 text-[12px] text-ink-3">
              The rings are where the probe will touch. Probe heights appear here as colors: blue below work Z0, red above.
            </p>
          ) : null}
        </div>

        {/* ---------------- Right: results + apply ---------------- */}
        <div className="min-h-0 overflow-y-auto bg-surface p-4">
          <h3 className="panel-label mb-2">Surface</h3>
          {stats ? (
            <>
              <div className="text-[24px] leading-tight font-semibold text-ink tabular-nums">{stats.range.toFixed(3)} mm</div>
              <div className="text-[12px] text-ink-3">height range across the map</div>
              <dl className="mt-3 grid grid-cols-2 gap-y-1 text-[12px]">
                <dt className="text-ink-3">Lowest</dt>
                <dd className="text-right font-mono text-ink">{mm(stats.min)}</dd>
                <dt className="text-ink-3">Highest</dt>
                <dd className="text-right font-mono text-ink">{mm(stats.max)}</dd>
                <dt className="text-ink-3">Largest step</dt>
                <dd className="text-right font-mono text-ink">{stats.maxStep.toFixed(3)} mm</dd>
                <dt className="text-ink-3">Points</dt>
                <dd className="text-right font-mono text-ink">
                  {map!.xs.length} × {map!.ys.length}
                </dd>
              </dl>
              <p className="mt-2 text-[12px] text-ink-2">{verdict(stats.range)}</p>
              {drift ? (
                drift.ok ? (
                  <p className="mt-2 flex items-start gap-1.5 text-[12px] text-ink-2">
                    <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-ok" aria-hidden />
                    Lines up with the current work zero ({map!.wcs}).
                  </p>
                ) : (
                  <p className="mt-2 flex items-start gap-1.5 text-[12px] text-warn">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
                    {drift.message}
                  </p>
                )
              ) : null}
            </>
          ) : (
            <p className="text-[12px] text-ink-2">No height map yet.</p>
          )}

          <h3 className="panel-label mt-6 mb-2">4 · Level the job</h3>
          {program ? (
            <p className="truncate text-[13px] text-ink" title={program.name}>
              {program.name}
            </p>
          ) : null}
          {program?.leveling ? (
            <p className="mt-1 flex items-start gap-1.5 text-[12px] text-ink-2">
              <Layers size={12} className="mt-0.5 shrink-0 text-accent" aria-hidden />
              Loaded program is leveled (from {program.leveling.sourceName}).
            </p>
          ) : null}
          <div className="mt-2">
            <Button variant="secondary" onClick={onLevel} disabled={!canApply.ok || applyBusy || running} disabledReason={canApply.reason}>
              {applyBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Layers size={14} aria-hidden />}
              Level this job
            </Button>
          </div>
          {!canApply.ok && canApply.reason ? <p className="mt-1 text-[12px] text-ink-3">{canApply.reason}</p> : null}

          {apply ? (
            apply.result.ok ? (
              <div className="mt-3 rounded-md border border-line px-3 py-2 text-[12px] text-ink-2">
                <p className="flex items-center gap-1.5 text-ink">
                  <CheckCircle2 size={13} className="text-ok" aria-hidden />
                  Ready to load
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-y-1">
                  <dt className="text-ink-3">Lines</dt>
                  <dd className="text-right font-mono tabular-nums">
                    {apply.result.stats.inputLines.toLocaleString()} → {apply.result.stats.outputLines.toLocaleString()}
                  </dd>
                  <dt className="text-ink-3">Z corrections</dt>
                  <dd className="text-right font-mono">
                    {mm(apply.result.stats.minCorrection)} … {mm(apply.result.stats.maxCorrection)}
                  </dd>
                  <dt className="text-ink-3">Arcs turned into lines</dt>
                  <dd className="text-right font-mono">{apply.result.stats.arcsConverted.toLocaleString()}</dd>
                  <dt className="text-ink-3">Split every</dt>
                  <dd className="text-right font-mono">{apply.result.stats.segmentLength.toFixed(2)} mm</dd>
                </dl>
                {apply.result.warnings.map((w, k) => (
                  <p key={k} className="mt-2 flex items-start gap-1.5 text-warn">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
                    {w}
                  </p>
                ))}
                <p className="mt-2 text-ink-3">
                  The leveled program replaces the loaded one. Do not change work X, Y or Z zero before running it: Start is blocked if they change.
                </p>
                <div className="mt-2 flex gap-2">
                  <Button variant="primary" onClick={() => void onLoadLeveled()} disabled={apply.busy || !job.canLoad.enabled} disabledReason={job.canLoad.reason}>
                    {apply.busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Upload size={14} aria-hidden />}
                    Load leveled program
                  </Button>
                  <Button variant="ghost" onClick={() => setApply(null)}>
                    Cancel
                  </Button>
                </div>
                {loadError ? <p className="mt-2 text-crit">{loadError}</p> : null}
              </div>
            ) : (
              <div className="mt-3 rounded-md border border-crit/40 bg-crit/5 px-3 py-2 text-[12px]">
                <p className="flex items-center gap-1.5 text-crit">
                  <OctagonX size={13} aria-hidden />
                  This job cannot be leveled safely
                </p>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-ink-2">
                  {apply.result.errors.map((e, k) => (
                    <li key={k}>{e}</li>
                  ))}
                </ul>
                <button type="button" onClick={() => setApply(null)} className="pressable mt-2 text-ink-3 hover-fine:text-ink">
                  Dismiss
                </button>
              </div>
            )
          ) : null}

          <h3 className="panel-label mt-6 mb-2">Map file</h3>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={onExport} disabled={!map} disabledReason="No height map yet">
              <Download size={14} aria-hidden />
              Export
            </Button>
            <Button variant="ghost" onClick={() => fileInput.current?.click()} disabled={running} disabledReason="Probing in progress">
              <Upload size={14} aria-hidden />
              Import
            </Button>
            {confirmDiscard ? (
              <Button
                variant="danger"
                onClick={() => {
                  setHeightMap(null);
                  setConfirmDiscard(false);
                  setApply(null);
                }}
              >
                <Trash2 size={14} aria-hidden />
                Confirm discard
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDiscard(true)} disabled={!map || running} disabledReason={!map ? 'No height map yet' : 'Probing in progress'}>
                <Trash2 size={14} aria-hidden />
                Discard
              </Button>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImport(f);
              e.target.value = '';
            }}
          />
          {importError ? <p className="mt-2 text-[12px] text-crit">{importError}</p> : null}
          <p className="mt-2 text-[11px] text-ink-3">
            An imported map is only valid if work X/Y/Z zero are exactly where they were when it was probed. Kinetiq checks this before leveling a job.
          </p>
        </div>
      </div>
    </>
  );
}

function Note({ tone, onClose, children }: { tone: 'ok' | 'crit' | 'warn'; onClose: () => void; children: React.ReactNode }) {
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'crit' ? OctagonX : Info;
  const color = tone === 'ok' ? 'border-ok/40 bg-ok/10 text-ok' : tone === 'crit' ? 'border-crit/40 bg-crit/10 text-crit' : 'border-warn/40 bg-warn/10 text-warn';
  return (
    <div role="status" className={`mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-[12px] ${color}`}>
      <Icon size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span className="flex-1 text-ink">{children}</span>
      <button type="button" onClick={onClose} className="pressable rounded p-0.5 text-ink-3 hover-fine:text-ink" aria-label="Dismiss">
        <X size={12} aria-hidden />
      </button>
    </div>
  );
}
