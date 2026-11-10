/**
 * Kinetiq travel limits, backend side (src/lib/machine/travel.ts has the envelope and the rules).
 *
 * The machine has no switch at the far end of X and Y, so the backend keeps jogs inside the
 * envelope itself:
 *
 *   homed     which axes have a known machine position: set when a homing cycle the backend saw
 *             start (`$H`, `$HX`, …) ends in Idle; cleared when FluidNC restarts or raises an
 *             alarm that loses position.
 *   jogs      every `$J=` line (Feeder: jog pad, Go to, macros; and `writeln`: console) goes
 *             through `filterJog`: passed, shortened to the edge of the envelope, or dropped.
 *
 * Program lines are not rewritten: the UI refuses to start a job that does not fit (derive.ts),
 * and the firmware's own soft limits (`soft_limits: true`, `max_travel_mm`) are the last line.
 *
 * `KINETIQ_TRAVEL_LIMITS=off` turns all of it off (other machines, the fake controller scenarios).
 */
import {
  AXIS_KEYS,
  homingAxes,
  limitJog,
  machineEnvelope,
  type AxisKey,
  type Envelope,
  type Homed,
  type MachineLimits,
} from '../../lib/machine/travel';
import logger from '../logger';
import type GrblController from './GrblController';

const log = logger('controller:TravelGuard');

/** Alarms after which the machine position is still valid: soft limit (2), probe fail (4, 5). */
const POSITION_KEPT_ALARMS = new Set([2, 4, 5]);
/** A banner this soon after our own soft reset is that reset, not a restart of the controller. */
const SOFT_RESET_WINDOW_MS = 5000;
/** With no Jog state seen, a queued jog target is dropped this long after the last jog was sent. */
const JOG_TARGET_STALE_MS = 1000;

const enabled = !/^(off|0|false|no)$/i.test(process.env.KINETIQ_TRAVEL_LIMITS ?? '');

export default class TravelGuard {
  readonly envelope: Envelope | null = enabled ? machineEnvelope() : null;

  private homed: Homed = { x: false, y: false, z: false };
  /** Axes of the homing cycle in progress, and whether the Home state was seen for it. */
  private homing: AxisKey[] | null = null;
  private sawHome = false;
  private lastSoftResetAt = 0;
  /** Where the jogs already sent will end (machine, mm); null when nothing is queued. */
  private jogTarget: Record<AxisKey, number> | null = null;
  private lastJogAt = 0;
  private sawJog = false;

  constructor(private controller: GrblController) {}

  toJSON(): MachineLimits {
    return { envelope: this.envelope, homed: { ...this.homed } };
  }

  private setHomed(axes: readonly AxisKey[], value: boolean): void {
    let changed = false;
    for (const a of axes) {
      if (this.homed[a] !== value) {
        this.homed[a] = value;
        changed = true;
      }
    }
    if (changed) {
      this.controller.emit('machine:limits', this.toJSON());
    }
  }

  /** Every line or real-time byte on its way to the port (SerialConnection writeFilter). */
  onWrite(data: string): void {
    if (!this.envelope) {
      return;
    }
    if (data.includes('\x18')) {
      this.lastSoftResetAt = Date.now();
      this.jogTarget = null;
      return;
    }
    const axes = homingAxes(data, this.envelope);
    if (axes) {
      // The position of these axes is undefined until the cycle has finished.
      this.setHomed(axes, false);
      this.homing = axes;
      this.sawHome = false;
      this.jogTarget = null;
    }
  }

  onStatus(activeState: string | undefined): void {
    if (!this.envelope || !activeState) {
      return;
    }

    if (this.homing) {
      if (activeState === 'Home') {
        this.sawHome = true;
      } else if (activeState === 'Alarm') {
        this.homing = null;
      } else if (activeState === 'Idle' && this.sawHome) {
        const axes = this.homing;
        this.homing = null;
        log.info(`Homed: ${axes.join(', ')}`);
        this.setHomed(axes, true);
      }
    }

    if (this.jogTarget) {
      if (activeState === 'Jog') {
        this.sawJog = true;
      } else if (this.sawJog || Date.now() - this.lastJogAt > JOG_TARGET_STALE_MS) {
        // The queued jogs have finished or were cancelled: the reported position is the truth again.
        this.jogTarget = null;
      }
    }
  }

  onAlarm(code: number | undefined): void {
    this.jogTarget = null;
    if (code !== undefined && POSITION_KEPT_ALARMS.has(code)) {
      return;
    }
    this.homing = null;
    this.setHomed(AXIS_KEYS, false);
  }

  /** The startup banner: after our own soft reset the position is kept, after a restart it is not. */
  onStartup(): void {
    this.jogTarget = null;
    this.homing = null;
    if (Date.now() - this.lastSoftResetAt > SOFT_RESET_WINDOW_MS) {
      this.setHomed(AXIS_KEYS, false);
    }
  }

  /**
   * A line about to be sent. Returns it unchanged when it is not a jog or stays inside the
   * envelope, a shortened jog when it would leave it, or null when it must not be sent (the reason
   * goes to the clients as a `[MSG:…]` line in the console).
   */
  filterJog(line: string): string | null {
    if (!this.envelope) {
      return line;
    }
    const runner = this.controller.runner;
    if (!runner) {
      return line;
    }

    const reportScale = runner.settings.settings?.['$13'] === '1' ? 25.4 : 1;
    const mpos = runner.getMachinePosition();
    const wpos = runner.getWorkPosition();
    const from = {} as Record<AxisKey, number>;
    const wco = {} as Record<AxisKey, number>;
    for (const a of AXIS_KEYS) {
      const m = mpos[a] === undefined || mpos[a] === '' ? NaN : Number(mpos[a]) * reportScale;
      const w = wpos[a] === undefined || wpos[a] === '' ? NaN : Number(wpos[a]) * reportScale;
      from[a] = this.jogTarget ? this.jogTarget[a] : m;
      wco[a] = m - w;
    }
    const modal = runner.getModalGroup();

    const decision = limitJog(line, {
      envelope: this.envelope,
      homed: this.homed,
      from,
      wco,
      modalInches: modal.units === 'G20',
      modalRelative: modal.distance === 'G91',
    });
    if (!decision) {
      return line;
    }
    if (decision.action === 'block') {
      log.warn(`Jog blocked: ${decision.message}: ${line}`);
      this.controller.emit('serialport:read', `[MSG:WARN: Kinetiq: jog not sent. ${decision.message}]`);
      return null;
    }

    this.jogTarget = decision.target;
    this.lastJogAt = Date.now();
    this.sawJog = false;
    if (decision.action === 'shorten') {
      log.info(`${decision.message}: ${line} -> ${decision.line}`);
      this.controller.emit('serialport:read', `[MSG:INFO: Kinetiq: ${decision.message}]`);
      return decision.line;
    }
    return line;
  }
}
