'use client';

/**
 * Z probe with a touch plate (lib/cnc/probe.ts): live probe input, plate/feed settings,
 * Probe Z with step progress, Cancel, and the result. Collapsible; the open state is remembered.
 * Values are always millimetres (the sequence sends G21).
 */
import { CheckCircle2, ChevronDown, ChevronRight, CircleDot, Info, Loader2, OctagonX, Target, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { probeView } from '@/lib/cnc/derive';
import {
  cancelProbe,
  clearProbeResult,
  DEFAULT_PROBE_SETTINGS,
  loadProbeSettings,
  PROBE_LIMITS,
  probeSettingsError,
  runProbe,
  saveProbeSettings,
  type ProbeSettings,
} from '@/lib/cnc/probe';
import { useMachine } from '@/lib/cnc/store';
import { Button } from '@/components/ui/Button';

const OPEN_KEY = 'kinetiq.probe.open';

type FieldKey = keyof ProbeSettings;

const FIELDS: { key: FieldKey; unit: string; help: string }[] = [
  { key: 'thickness', unit: 'mm', help: 'Measured thickness of your touch plate. Z0 is set this far below the point where the bit touches it.' },
  { key: 'maxTravel', unit: 'mm', help: 'How far the first probe may go down before giving up (FluidNC then raises Alarm 5).' },
  { key: 'fastFeed', unit: 'mm/min', help: 'Speed of the first probe. Slow enough that the bit stops safely on contact.' },
  { key: 'slowFeed', unit: 'mm/min', help: 'Speed of the second, more accurate probe.' },
  { key: 'backoff', unit: 'mm', help: 'Lift between the fast and the slow probe.' },
  { key: 'retract', unit: 'mm', help: 'Lift at the end so you can remove the plate.' },
];

function useProbeOpen(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(localStorage.getItem(OPEN_KEY) === '1');
    } catch {
      // optional
    }
  }, []);
  return [
    open,
    (v: boolean) => {
      setOpen(v);
      try {
        localStorage.setItem(OPEN_KEY, v ? '1' : '0');
      } catch {
        // optional
      }
    },
  ];
}

export function ProbeSection() {
  const machine = useMachine((s) => s);
  const view = probeView(machine);
  const run = machine.probe;
  const [open, setOpen] = useProbeOpen();
  const [settings, setSettings] = useState<ProbeSettings>(DEFAULT_PROBE_SETTINGS);
  const [texts, setTexts] = useState<Record<FieldKey, string>>(() => toTexts(DEFAULT_PROBE_SETTINGS));

  useEffect(() => {
    const loaded = loadProbeSettings();
    setSettings(loaded);
    setTexts(toTexts(loaded));
  }, []);

  const update = (key: FieldKey, text: string) => {
    const clean = text.replace(',', '.').replace(/[^\d.]/g, '');
    setTexts((t) => ({ ...t, [key]: clean }));
    const value = clean === '' ? (key === 'thickness' ? null : NaN) : Number(clean);
    const next = { ...settings, [key]: value } as ProbeSettings;
    setSettings(next);
    // Always persist, including an empty thickness: an old value must not come back after a reload.
    saveProbeSettings(next);
  };

  const settingsError = probeSettingsError(settings);
  const running = run.phase === 'running';
  const canStart = view.canProbe.enabled && !settingsError;
  const startReason = !view.canProbe.enabled ? view.canProbe.reason : settingsError ?? undefined;

  const indicator =
    view.touching === null ? (
      <span className="text-ink-3">Probe —</span>
    ) : view.touching ? (
      <span className="flex items-center gap-1 text-warn">
        <CircleDot size={12} aria-hidden />
        Probe touching
      </span>
    ) : (
      <span className="flex items-center gap-1 text-ink-2">
        <CircleDot size={12} className="text-ink-3" aria-hidden />
        Probe open
      </span>
    );

  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="pressable panel-label flex items-center gap-1 hover-fine:text-ink"
        >
          {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          Probe Z
        </button>
        <span className="flex-1" />
        <span role="status" aria-live="polite" className="text-[12px]">
          {indicator}
        </span>
      </div>

      {open ? (
        <div className="mt-3">
          <p className="text-[12px] leading-[17px] text-ink-2">
            Put the touch plate on the stock, jog the bit 5–15 mm above it and attach the clip to the bit. Tap the plate against the bit: the indicator
            should switch to “touching”. Probe Z lowers the bit until it touches the plate, sets work Z0 at the stock surface and lifts the bit.
          </p>

          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
            {FIELDS.map(({ key, unit, help }) => {
              const limit = PROBE_LIMITS[key];
              const value = settings[key];
              const invalid = texts[key] !== '' && (value === null || !Number.isFinite(value) || value < limit.min || value > limit.max);
              const missing = key === 'thickness' && texts[key] === '';
              return (
                <label key={key} className="block" title={help}>
                  <span className="text-[12px] text-ink-2">{limit.label}</span>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <input
                      inputMode="decimal"
                      value={texts[key]}
                      onChange={(e) => update(key, e.target.value)}
                      disabled={running}
                      placeholder={key === 'thickness' ? 'required' : undefined}
                      aria-invalid={invalid || missing || undefined}
                      className={`h-8 w-full rounded-md border bg-surface-2 px-2 text-right font-mono text-[12px] tabular-nums text-ink outline-none focus-visible:border-accent disabled:text-ink-3 ${
                        invalid ? 'border-crit' : missing ? 'border-warn' : 'border-line'
                      }`}
                    />
                    <span className="w-12 shrink-0 text-[11px] text-ink-3">{unit}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {settingsError ? <p className="mt-2 text-[12px] text-warn">{settingsError}</p> : null}

          <div className="mt-3 flex items-center gap-2">
            {running ? (
              <Button variant="danger" onClick={cancelProbe} disabled={run.cancelling} title="Stop probing: Feed hold, then Reset">
                <OctagonX size={14} aria-hidden />
                {run.cancelling ? 'Cancelling…' : 'Cancel'}
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => void runProbe(settings)}
                disabled={!canStart}
                disabledReason={startReason}
                title={`Moves Z down up to ${settings.maxTravel} mm at ${settings.fastFeed} mm/min until the plate is touched`}
              >
                <Target size={14} aria-hidden />
                Probe Z
              </Button>
            )}
            <span className="min-w-0 flex-1 text-[12px]">
              {running ? (
                <span className="flex items-center gap-1.5 text-accent">
                  <Loader2 size={12} className="animate-spin" aria-hidden />
                  Step {run.step} of {run.steps}: {run.label}…
                </span>
              ) : !canStart && startReason ? (
                <span className="text-ink-3">{startReason}</span>
              ) : null}
            </span>
          </div>

          {run.phase === 'done' ? (
            <Result tone="ok" onClose={clearProbeResult}>
              Work Z0 is set at the stock surface (plate {run.thickness} mm)
              {run.contactZ !== null ? <>, contact at machine Z {run.contactZ.toFixed(3)}</> : null}. The bit is {run.retract} mm above the plate: remove the
              plate and the clip.
            </Result>
          ) : run.phase === 'failed' ? (
            <Result tone="crit" onClose={clearProbeResult}>
              {run.message}. Work Z was not changed.
              {run.hint ? <span className="mt-1 block text-ink-2">{run.hint}</span> : null}
            </Result>
          ) : run.phase === 'cancelled' ? (
            <Result tone="warn" onClose={clearProbeResult}>
              Probing cancelled. Work Z was not changed. The reset may leave the controller in Alarm: check the position before continuing.
            </Result>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function toTexts(s: ProbeSettings): Record<FieldKey, string> {
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v === null || !Number.isFinite(v) ? '' : String(v)])) as Record<FieldKey, string>;
}

function Result({ tone, onClose, children }: { tone: 'ok' | 'crit' | 'warn'; onClose: () => void; children: React.ReactNode }) {
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
