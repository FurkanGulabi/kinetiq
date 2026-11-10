/**
 * Kinetiq travel limits, backend side (src/lib/machine/travel.ts has the envelope and the rules).
 *
 * The backend keeps jogs inside the work-area envelope itself (the limit switches at both ends
 * of X and Y are the hardware layer):
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
 *   measure   "reverse homing": `travel:measure` sends one slow jog to the far end of a homed axis,
 *             past the envelope, and reads the machine position after the far switch raises the
 *             hard-limit alarm. `travel:apply` saves it as the axis travel (config `kinetiq.travel`)
 *             and rebuilds the envelope. `travel:backoff` then moves the axis off the switch.
 *
 * `KINETIQ_TRAVEL_LIMITS=off` turns all of it off (other machines, the fake controller scenarios).
 */
import {
  AXIS_KEYS,
  backoffJogLine,
  homingAxes,
  limitJog,
  machineEnvelope,
  measureJogLine,
  MEASURE_SEARCH_MM,
  TRAVEL_LIMIT_MM,
  travelFromPosition,
  validTravel,
  type AxisKey,
  type Envelope,
  type Homed,
  type LimitedAxis,
  type MachineLimits,
  type TravelMeasure,
  type TravelMm,
} from '../../lib/machine/travel';
import config from '../config/ConfigStore';
import logger from '../logger';
import { WORKFLOW_STATE_IDLE } from '../streaming/Workflow';
import type GrblController from './GrblController';

const log = logger('controller:TravelGuard');

/** Alarms after which the machine position is still valid: soft limit (2), probe fail (4, 5). */
const POSITION_KEPT_ALARMS = new Set([2, 4, 5]);
/** A banner this soon after our own soft reset is that reset, not a restart of the controller. */
const SOFT_RESET_WINDOW_MS = 5000;
/** With no Jog state seen, a queued jog target is dropped this long after the last jog was sent. */
const JOG_TARGET_STALE_MS = 1000;

const enabled = !/^(off|0|false|no)$/i.test(process.env.KINETIQ_TRAVEL_LIMITS ?? '');

/** Config key of the measured travel, `{ x?: number, y?: number }` in mm. */
const TRAVEL_CONFIG_KEY = 'kinetiq.travel';
/** A measuring jog that has not shown the Jog state this long after it was sent did not start. */
const MEASURE_START_MS = 3000;

/** Saved travel values that pass validation. */
function savedTravel(): Partial<TravelMm> {
  const saved = config.get<Record<string, unknown>>(TRAVEL_CONFIG_KEY, {}) ?? {};
  const out: Partial<TravelMm> = {};
  if (validTravel(saved.x)) out.x = saved.x;
  if (validTravel(saved.y)) out.y = saved.y;
  return out;
}

export default class TravelGuard {
  private saved: Partial<TravelMm> = enabled ? savedTravel() : {};
  private travel: TravelMm = { ...TRAVEL_LIMIT_MM, ...this.saved };
  envelope: Envelope | null = enabled ? machineEnvelope(this.travel) : null;

  private measure: TravelMeasure | null = null;
  private measureSentAt = 0;
  private sawMeasureJog = false;
  private backoffAxis: LimitedAxis | null = null;
  /** A jog line the guard sent itself (measure, back off): passes filterJog once, unchecked. */
  private passLine: string | null = null;

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
    return {
      envelope: this.envelope,
      homed: { ...this.homed },
      travel: { ...this.travel },
      measured: { x: this.saved.x !== undefined, y: this.saved.y !== undefined },
      measure: this.measure ? { ...this.measure } : null,
      backoff: this.backoffAxis,
    };
  }

  private emitLimits(): void {
    this.controller.emit('machine:limits', this.toJSON());
  }

  private say(level: 'INFO' | 'WARN', text: string): void {
    this.controller.emit('serialport:read', `[MSG:${level}: Kinetiq: ${text}]`);
  }

  private setMeasure(next: TravelMeasure | null): void {
    this.measure = next;
    if (next?.phase === 'failed') {
      log.warn(`Travel measurement of ${next.axis} failed: ${next.message}`);
      this.say('WARN', `travel measurement of ${next.axis.toUpperCase()} failed. ${next.message}`);
    } else if (next?.phase === 'done') {
      log.info(`Travel measured: ${next.axis} = ${next.travelMm} mm`);
      this.say('INFO', `${next.axis.toUpperCase()} travel measured: ${next.travelMm} mm`);
    }
    this.emitLimits();
  }

  /** Machine position of an axis in mm, from the last status report (NaN when unknown). */
  private machineMm(axis: AxisKey): number {
    const runner = this.controller.runner;
    if (!runner) return NaN;
    const scale = runner.settings.settings?.['$13'] === '1' ? 25.4 : 1;
    const v = runner.getMachinePosition()[axis];
    return v === undefined || v === '' ? NaN : Number(v) * scale;
  }

  /** `travel:measure`: slow jog to the far switch of a homed axis. */
  startMeasure(axis: unknown): void {
    if (axis !== 'x' && axis !== 'y') {
      return;
    }
    const refuse = (why: string) => {
      log.warn(`Travel measurement of ${axis} refused: ${why}`);
      this.say('WARN', `travel measurement not started. ${why}`);
    };
    if (!this.envelope) return refuse('Travel limits are off');
    if (this.measure && (this.measure.phase === 'moving' || this.measure.phase === 'tripped')) return refuse('A measurement is already running');
    if (!this.homed[axis]) return refuse(`${axis.toUpperCase()} is not homed: home the machine first`);
    const runner = this.controller.runner;
    if (!runner?.isIdle() || this.controller.workflow?.state !== WORKFLOW_STATE_IDLE) return refuse('The machine must be idle with no job running');

    const line = measureJogLine(axis);
    this.backoffAxis = null;
    this.jogTarget = null;
    this.measureSentAt = Date.now();
    this.sawMeasureJog = false;
    this.passLine = line;
    log.info(`Measuring ${axis} travel: ${line}`);
    this.setMeasure({ axis, phase: 'moving' });
    this.controller.writeln(line);
  }

  /** `travel:apply`: save the measured travel and use it for the envelope. */
  applyMeasure(): void {
    const m = this.measure;
    if (!this.envelope || !m || m.phase !== 'done' || !validTravel(m.travelMm)) {
      return;
    }
    this.saved = { ...this.saved, [m.axis]: m.travelMm };
    config.set(TRAVEL_CONFIG_KEY, { ...this.saved });
    this.travel = { ...TRAVEL_LIMIT_MM, ...this.saved };
    this.envelope = machineEnvelope(this.travel);
    log.info(`Travel saved: ${m.axis} = ${m.travelMm} mm`);
    this.say('INFO', `${m.axis.toUpperCase()} travel set to ${m.travelMm} mm`);
    this.measure = null;
    this.emitLimits();
  }

  /** `travel:dismiss`: forget a finished or failed measurement. */
  dismissMeasure(): void {
    if (this.measure && (this.measure.phase === 'done' || this.measure.phase === 'failed')) {
      this.measure = null;
      this.emitLimits();
    }
  }

  /** `travel:backoff`: move the axis a few mm off its far switch, toward home (it is not homed after the alarm). */
  backoff(): void {
    const axis = this.backoffAxis;
    if (!this.envelope || !axis) {
      return;
    }
    const runner = this.controller.runner;
    if (!runner?.isIdle() || this.controller.workflow?.state !== WORKFLOW_STATE_IDLE) {
      this.say('WARN', 'back off not sent. Reset and Unlock first, so the machine is Idle');
      return;
    }
    const line = backoffJogLine(axis);
    this.passLine = line;
    log.info(`Backing ${axis} off the far switch: ${line}`);
    this.controller.writeln(line);
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
      if (this.backoffAxis && axes.includes(this.backoffAxis)) {
        this.backoffAxis = null;
        this.emitLimits();
      }
      this.homing = axes;
      this.sawHome = false;
      this.jogTarget = null;
    }
  }

  onStatus(activeState: string | undefined): void {
    if (!this.envelope || !activeState) {
      return;
    }

    const m = this.measure;
    if (m?.phase === 'tripped') {
      // The first report after the hard-limit alarm: where the far switch stopped the axis.
      const pos = this.machineMm(m.axis);
      const travel = Number.isFinite(pos) ? travelFromPosition(m.axis, pos) : NaN;
      if (validTravel(travel)) {
        this.setMeasure({ ...m, phase: 'done', travelMm: travel });
      } else {
        this.setMeasure({ ...m, phase: 'failed', message: `The position after the stop (${pos} mm) is not a plausible travel` });
      }
    } else if (m?.phase === 'moving') {
      if (activeState === 'Jog') {
        this.sawMeasureJog = true;
      } else if (activeState === 'Idle' && (this.sawMeasureJog || Date.now() - this.measureSentAt > MEASURE_START_MS)) {
        this.setMeasure({
          ...m,
          phase: 'failed',
          message: this.sawMeasureJog
            ? `The move ended without hitting a limit switch (stopped, or no switch within ${MEASURE_SEARCH_MM} mm)`
            : 'The controller did not start the move',
        });
      }
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
    if (this.measure?.phase === 'moving') {
      if (code === 1) {
        // The far switch: the position is read from the next status report (onStatus).
        this.backoffAxis = this.measure.axis;
        this.measure = { ...this.measure, phase: 'tripped' };
        this.emitLimits();
      } else {
        this.setMeasure({ ...this.measure, phase: 'failed', message: `ALARM:${code ?? '?'} instead of the hard limit` });
      }
    }
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
    if (this.passLine !== null && line.trim() === this.passLine) {
      this.passLine = null;
      return line;
    }
    if (this.measure?.phase === 'moving' && /^\$J\s*=/i.test(line.trim())) {
      this.say('WARN', 'jog not sent. A travel measurement is running: stop it first');
      return null;
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
