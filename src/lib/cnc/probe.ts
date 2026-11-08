'use client';

/**
 * Z probe with a touch plate: find the stock surface and set work Z0 there.
 *
 *   1. G21 G91                     millimetres, relative moves
 *   2. G38.2 Z-<maxTravel> F<fast> probe down until the plate is touched (must report contact)
 *   3. G0 Z<backoff>               lift off the plate
 *   4. G38.2 Z-<backoff+1> F<slow> probe again slowly for accuracy (must report contact)
 *   5. G90                         absolute
 *   6. G10 L20 P<wcs> Z<thickness> work Z = plate thickness here, so Z0 is the stock surface
 *   7. G91 G0 Z<retract>           lift so the plate can be removed
 *   8. <restore distance + units>  back to the modal state from before
 *
 * Lines are sent ONE AT A TIME through the Feeder and the sequence stops at the first problem:
 * `error:N`, `ALARM:N`, a probe report without contact, a timeout, or a lost connection. Queueing
 * all lines at once would be unsafe: the Feeder keeps sending after an `error:`, so a refused probe
 * move (for example "homing required") would still run the G10 and set Z0 at the wrong height.
 */
import { onSerialLine, sendCommand, sendGcode } from './client';
import { WCS_P } from './commands';
import { getState, setState } from './store';

export interface ProbeSettings {
  /** Touch plate thickness in mm. null until the user enters it: a guess would set Z0 wrongly. */
  thickness: number | null;
  /** Furthest the first probe may travel down, mm. */
  maxTravel: number;
  fastFeed: number;
  slowFeed: number;
  /** Lift after the first contact, before the slow probe, mm. */
  backoff: number;
  /** Lift at the end, mm. */
  retract: number;
}

export const DEFAULT_PROBE_SETTINGS: ProbeSettings = {
  thickness: null,
  maxTravel: 25,
  fastFeed: 100,
  slowFeed: 25,
  backoff: 2,
  retract: 5,
};

export const PROBE_LIMITS: Record<keyof ProbeSettings, { min: number; max: number; label: string; unit: string }> = {
  thickness: { min: 0, max: 100, label: 'Plate thickness', unit: 'mm' },
  maxTravel: { min: 1, max: 100, label: 'Max travel', unit: 'mm' },
  fastFeed: { min: 10, max: 500, label: 'Fast feed', unit: 'mm/min' },
  slowFeed: { min: 5, max: 100, label: 'Slow feed', unit: 'mm/min' },
  backoff: { min: 0.5, max: 10, label: 'Back-off', unit: 'mm' },
  retract: { min: 1, max: 50, label: 'Retract', unit: 'mm' },
};

const KEY = 'kinetiq.probe';

export function loadProbeSettings(): ProbeSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Record<keyof ProbeSettings, unknown>>;
    const out = { ...DEFAULT_PROBE_SETTINGS };
    for (const key of Object.keys(DEFAULT_PROBE_SETTINGS) as (keyof ProbeSettings)[]) {
      const v = stored[key];
      if (typeof v === 'number' && Number.isFinite(v)) (out as Record<keyof ProbeSettings, number | null>)[key] = v;
      else if (key === 'thickness' && key in stored) out.thickness = null; // explicitly cleared
    }
    return out;
  } catch {
    return DEFAULT_PROBE_SETTINGS;
  }
}

export function saveProbeSettings(settings: ProbeSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // optional
  }
}

/** First problem with the settings, or null. */
export function probeSettingsError(s: ProbeSettings): string | null {
  if (s.thickness === null || !Number.isFinite(s.thickness)) return 'Enter the touch plate thickness';
  for (const [key, limit] of Object.entries(PROBE_LIMITS) as [keyof ProbeSettings, (typeof PROBE_LIMITS)[keyof ProbeSettings]][]) {
    const v = s[key];
    if (v === null || !Number.isFinite(v) || v < limit.min || v > limit.max) return `${limit.label} must be between ${limit.min} and ${limit.max} ${limit.unit}`;
  }
  if (s.slowFeed > s.fastFeed) return 'Slow feed must not be faster than fast feed';
  return null;
}

/** True when the status report says the probe input is active (Pn: contains P). */
export function probeTouching(pinState: string | undefined): boolean {
  return !!pinState && pinState.includes('P');
}

const n = (v: number) => Number(v.toFixed(3)).toString();

interface Step {
  line: string;
  label: string;
  /** G38.2: must be followed by [PRB:…:1] before its ok. */
  probe?: boolean;
  timeoutMs: number;
}

function buildSteps(s: ProbeSettings, wcs: string, distance: string, units: string): Step[] {
  const travelTime = (mm: number, feed: number) => Math.ceil((mm / feed) * 60000 * 1.5) + 5000;
  const restore = `${distance === 'G91' ? 'G91' : 'G90'}${units === 'G20' ? ' G20' : ''}`;
  return [
    { line: 'G21 G91', label: 'Preparing', timeoutMs: 5000 },
    { line: `G38.2 Z-${n(s.maxTravel)} F${n(s.fastFeed)}`, label: 'Probing down (fast)', probe: true, timeoutMs: travelTime(s.maxTravel, s.fastFeed) },
    { line: `G0 Z${n(s.backoff)}`, label: 'Backing off', timeoutMs: 10000 },
    { line: `G38.2 Z-${n(s.backoff + 1)} F${n(s.slowFeed)}`, label: 'Probing again (slow)', probe: true, timeoutMs: travelTime(s.backoff + 1, s.slowFeed) },
    { line: 'G90', label: 'Setting work Z', timeoutMs: 5000 },
    { line: `G10 L20 P${WCS_P[wcs] ?? 1} Z${n(s.thickness ?? 0)}`, label: 'Setting work Z', timeoutMs: 5000 },
    { line: `G91 G0 Z${n(s.retract)}`, label: 'Lifting', timeoutMs: 10000 },
    { line: restore, label: 'Finishing', timeoutMs: 5000 },
  ];
}

class ProbeError extends Error {
  constructor(message: string, readonly hint: string | null = null) {
    super(message);
  }
}

let cancelRequested = false;

function hintFor(line: string): string | null {
  if (/^ALARM:5/.test(line)) return 'No contact within the max travel. Check the clip and plate wire, or start closer to the plate.';
  if (/^ALARM:4/.test(line)) return 'The probe was already touching when the move started. Check the wiring and that the clip is not touching the plate.';
  if (/hom/i.test(line)) return 'FluidNC refuses motion until the machine has been homed (start/must_home). Home first, or turn must_home off in Settings.';
  if (/^error:9\b/.test(line)) return 'The controller is locked (Alarm). Home or Unlock first.';
  if (/^ALARM:/.test(line)) return 'The controller is in Alarm. The position may be lost: check it before continuing.';
  return null;
}

/** Sends one line and resolves on its `ok`; rejects on error/alarm/no contact/timeout/disconnect. */
function sendStep(step: Step): Promise<{ contactZ: number | null }> {
  return new Promise((resolve, reject) => {
    let contactZ: number | null = null;
    let contact = false;
    const stop = (err: ProbeError | null) => {
      clearTimeout(timer);
      clearInterval(watch);
      unsubscribe();
      if (err) reject(err);
      else resolve({ contactZ });
    };
    const unsubscribe = onSerialLine((raw) => {
      const line = raw.trim();
      const prb = /^\[PRB:([^:\]]+):(\d)\]/.exec(line);
      if (prb) {
        contact = prb[2] === '1';
        const z = Number(prb[1].split(',')[2]);
        contactZ = Number.isFinite(z) ? z : null;
        if (!contact) stop(new ProbeError('The probe did not touch the plate', hintFor('ALARM:5')));
        return;
      }
      if (line === 'ok') {
        if (step.probe && !contact) stop(new ProbeError(`${step.label}: no contact was reported`, hintFor('ALARM:5')));
        else stop(null);
        return;
      }
      if (/^error:/i.test(line) || /^ALARM:/i.test(line)) {
        stop(new ProbeError(`${step.label} failed: ${line}`, hintFor(line)));
      }
    });
    const timer = setTimeout(() => stop(new ProbeError(`${step.label}: no reply from the controller in time`, 'The move may still be running. Use Hold or Reset in the top bar if needed.')), step.timeoutMs);
    const watch = setInterval(() => {
      if (getState().connection.phase !== 'open') stop(new ProbeError('The connection to the controller was lost'));
      else if (cancelRequested) stop(new ProbeError('Cancelled'));
    }, 100);
    sendGcode(step.line);
  });
}

/** Runs the probe sequence. Callers check derive.probeView() first. */
export async function runProbe(settings: ProbeSettings): Promise<void> {
  const s0 = getState();
  if (s0.probe.phase === 'running' || probeSettingsError(settings)) return;
  const modal = s0.controller.state?.parserstate?.modal;
  const steps = buildSteps(settings, modal?.wcs || 'G54', modal?.distance || 'G90', modal?.units || 'G21');
  cancelRequested = false;

  let contactZ: number | null = null;
  for (let i = 0; i < steps.length; i++) {
    setState((s) => ({ ...s, probe: { phase: 'running', step: i + 1, steps: steps.length, label: steps[i].label, cancelling: cancelRequested } }));
    try {
      const result = await sendStep(steps[i]);
      if (steps[i].probe && result.contactZ !== null) contactZ = result.contactZ;
    } catch (err) {
      const e = err instanceof ProbeError ? err : new ProbeError(err instanceof Error ? err.message : 'Probing failed');
      if (cancelRequested) {
        setState((s) => ({ ...s, probe: { phase: 'cancelled', at: Date.now() } }));
      } else {
        setState((s) => ({ ...s, probe: { phase: 'failed', message: e.message, hint: e.hint, at: Date.now() } }));
      }
      // Best effort: put the modal state back if the controller still accepts lines (not in Alarm).
      if (i > 0 && getState().connection.phase === 'open' && getState().controller.state?.status.activeState !== 'Alarm') {
        sendGcode(steps[steps.length - 1].line);
      }
      return;
    }
  }
  setState((s) => ({
    ...s,
    probe: { phase: 'done', contactZ, thickness: settings.thickness ?? 0, retract: settings.retract, at: Date.now() },
  }));
}

/** Stops the sequence: no further lines, then Feed hold and a soft reset to end the current move. */
export function cancelProbe(): void {
  if (getState().probe.phase !== 'running') return;
  cancelRequested = true;
  setState((s) => (s.probe.phase === 'running' ? { ...s, probe: { ...s.probe, cancelling: true } } : s));
  sendCommand('feedhold');
  setTimeout(() => sendCommand('reset'), 400);
}

export function clearProbeResult(): void {
  setState((s) => (s.probe.phase === 'running' ? s : { ...s, probe: { phase: 'idle' } }));
}
