'use client';

/**
 * Step-by-step line sequences (Z probe, height-map probing).
 *
 * Each line goes through the Feeder on its own and the next one is sent only after its `ok`.
 * A step fails — and the caller stops the whole sequence — on `error:N`, `ALARM:N`, a probe report
 * without contact, a timeout, a lost connection or a cancel request. Queueing all lines at once would
 * be unsafe: the Feeder keeps sending after an `error:`, so a refused move would not stop the rest.
 */
import { onSerialLine, sendGcode } from './client';
import { getState } from './store';

export interface SequenceStep {
  line: string;
  label: string;
  /** G38.x: a `[PRB:…:1]` report must arrive before the `ok`. */
  probe?: boolean;
  timeoutMs: number;
}

export interface StepResult {
  /** Contact point from `[PRB:x,y,z:1]`, machine coordinates (mm), when the step probed. */
  contact: { x: number; y: number; z: number } | null;
}

export class SequenceError extends Error {
  constructor(
    message: string,
    readonly hint: string | null = null,
    readonly cancelled = false,
  ) {
    super(message);
  }
}

/** Plain-language hint for a controller reply that stopped a sequence. */
export function hintFor(line: string): string | null {
  if (/^ALARM:5/.test(line)) return 'No contact within the allowed travel. Check the clip and the probe wire, or start closer to the surface.';
  if (/^ALARM:4/.test(line)) return 'The probe was already touching when the move started. Check the wiring and that the clip is not touching anything.';
  if (/hom/i.test(line)) return 'FluidNC refuses motion until the machine has been homed (start/must_home). Home first, or turn must_home off in Settings.';
  if (/^error:9\b/.test(line)) return 'The controller is locked (Alarm). Home or Unlock first.';
  if (/^ALARM:/.test(line)) return 'The controller is in Alarm. The position may be lost: check it before continuing.';
  return null;
}

/**
 * Sends one line and resolves on its `ok`. `isCancelled` is polled so a cancel request stops waiting
 * immediately (the caller is responsible for stopping the machine itself).
 */
export function sendStep(step: SequenceStep, isCancelled: () => boolean): Promise<StepResult> {
  return new Promise((resolve, reject) => {
    let contact: StepResult['contact'] = null;
    let touched = false;
    const stop = (err: SequenceError | null) => {
      clearTimeout(timer);
      clearInterval(watch);
      unsubscribe();
      if (err) reject(err);
      else resolve({ contact });
    };
    const unsubscribe = onSerialLine((raw) => {
      const line = raw.trim();
      const prb = /^\[PRB:([^:\]]+):(\d)\]/.exec(line);
      if (prb) {
        touched = prb[2] === '1';
        const [x, y, z] = prb[1].split(',').map(Number);
        contact = [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
        if (!touched) stop(new SequenceError(`${step.label}: the probe did not touch`, hintFor('ALARM:5')));
        return;
      }
      if (line === 'ok') {
        if (step.probe && (!touched || !contact)) stop(new SequenceError(`${step.label}: no contact was reported`, hintFor('ALARM:5')));
        else stop(null);
        return;
      }
      if (/^error:/i.test(line) || /^ALARM:/i.test(line)) {
        stop(new SequenceError(`${step.label} failed: ${line}`, hintFor(line)));
      }
    });
    const timer = setTimeout(
      () => stop(new SequenceError(`${step.label}: no reply from the controller in time`, 'The move may still be running. Use Hold or Reset in the top bar if needed.')),
      step.timeoutMs,
    );
    const watch = setInterval(() => {
      if (getState().connection.phase !== 'open') stop(new SequenceError('The connection to the controller was lost'));
      else if (isCancelled()) stop(new SequenceError('Cancelled', null, true));
    }, 100);
    sendGcode(step.line);
  });
}

/** Time allowance for a feed move of `mm` at `feed` mm/min: 1.5× the nominal time plus 5 s. */
export function moveTimeout(mm: number, feed: number): number {
  return Math.ceil((Math.abs(mm) / feed) * 60000 * 1.5) + 5000;
}

/** G90/G91 + G20/G21 line that restores the modal state captured before a sequence. */
export function restoreModalLine(distance: string | undefined, units: string | undefined): string {
  return `${distance === 'G91' ? 'G91' : 'G90'}${units === 'G20' ? ' G20' : ' G21'}`;
}
