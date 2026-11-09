/**
 * Turns controller lines into the runner state/settings objects and per-line events
 * (was src/server/cnc/controllers/Grbl/GrblRunner.js, CNCjs 1.11.5).
 *
 * GrblController (src/server/controller/GrblController.ts) feeds every received line to parse().
 * Each non-empty line emits 'raw' and then at most one of:
 *   'status'      `<…>` status report        (state.status updated)
 *   'ok'          ok
 *   'error'       error:N                    (EventEmitter throws if nobody listens, as in CNCjs)
 *   'alarm'       ALARM:N                    (state.status.activeState → 'Alarm')
 *   'parserstate' `$G` reply                 (state.parserstate replaced)
 *   'parameters'  `[G54:…]`, `[TLO:…]`, `[PRB:…]` (settings.parameters[name] set)
 *   'feedback'    `[MSG:…]` / `[…]`
 *   'settings'    `$n=value`                 (settings.settings[name] set)
 *   'startup'     banner, e.g. `Grbl 3.9 [FluidNC v4.0.1 …]` (settings.version set)
 *   'others'      anything else, including `[HLP:]`, `[VER:]`, `[OPT:]` and `[echo:]` results
 * The listener gets the parser payload (with `raw`). `state` and `settings` are replaced with a
 * new object only when their content changed, so the controller can detect changes by identity.
 */
import events from 'events';
import _ from 'lodash';
import type { AxisValues, GrblSettings, GrblStatus } from '../protocol';
import decimalPlaces from '../util/decimalPlaces';
import GrblLineParser, { isGrblLineParserResult } from './parser/GrblLineParser';
import GrblLineParserResultStatus from './parser/GrblLineParserResultStatus';
import GrblLineParserResultOk from './parser/GrblLineParserResultOk';
import GrblLineParserResultError from './parser/GrblLineParserResultError';
import GrblLineParserResultAlarm from './parser/GrblLineParserResultAlarm';
import GrblLineParserResultParserState, { GrblParserStatePayload } from './parser/GrblLineParserResultParserState';
import GrblLineParserResultParameters from './parser/GrblLineParserResultParameters';
import GrblLineParserResultFeedback from './parser/GrblLineParserResultFeedback';
import GrblLineParserResultSettings from './parser/GrblLineParserResultSettings';
import GrblLineParserResultStartup from './parser/GrblLineParserResultStartup';
import {
  GRBL_ACTIVE_STATE_IDLE,
  GRBL_ACTIVE_STATE_ALARM
} from './constants';

/**
 * `state.parserstate`. Starts as the full default below (a GrblParserState from protocol.ts), but
 * every `$G` reply replaces it with exactly what the line contained: a field the line lacked is
 * set to undefined, `modal` holds only the groups present, and any group may be an array when
 * the line repeated it. GRBL and FluidNC always report everything, so in practice it stays a
 * complete GrblParserState.
 */
export interface GrblRunnerParserState {
  modal?: GrblParserStatePayload['modal'];
  tool?: string;
  feedrate?: string;
  spindle?: string;
}

/**
 * `runner.state`. GrblState (protocol.ts) is assignable to it; the controller narrows it to
 * GrblState for the `controller:state` emit (only coolant is ever an array on real firmware).
 */
export interface GrblRunnerState {
  status: GrblStatus;
  parserstate: GrblRunnerParserState;
}

// Same as lodash `_.has(object, key)` for a plain object.
const has = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

class GrblRunner extends events.EventEmitter {
  state: GrblRunnerState = {
    status: {
      activeState: '',
      mpos: {
        x: '0.000',
        y: '0.000',
        z: '0.000'
      },
      wpos: {
        x: '0.000',
        y: '0.000',
        z: '0.000'
      },
      ov: []
    },
    parserstate: {
      modal: {
        motion: 'G0', // G0, G1, G2, G3, G38.2, G38.3, G38.4, G38.5, G80
        wcs: 'G54', // G54, G55, G56, G57, G58, G59
        plane: 'G17', // G17: xy-plane, G18: xz-plane, G19: yz-plane
        units: 'G21', // G20: Inches, G21: Millimeters
        distance: 'G90', // G90: Absolute, G91: Relative
        feedrate: 'G94', // G93: Inverse time mode, G94: Units per minute
        program: 'M0', // M0, M1, M2, M30
        spindle: 'M5', // M3: Spindle (cw), M4: Spindle (ccw), M5: Spindle off
        coolant: 'M9' // M7: Mist coolant, M8: Flood coolant, M9: Coolant off, [M7,M8]: Both on
      },
      tool: '',
      feedrate: '',
      spindle: ''
    }
  };

  settings: GrblSettings = {
    version: '',
    parameters: {
    },
    settings: {
    }
  };

  parser = new GrblLineParser();

  parse(data: string): void {
    data = ('' + data).replace(/\s+$/, '');
    if (!data) {
      return;
    }

    this.emit('raw', { raw: data });

    // Kinetiq: CNCjs wrote `this.parser.parse(data) || {}`; parse() always returns an object, so the
    // fallback was dead code. A status report without any letter (e.g. '<123>') still makes the
    // Status parser throw a TypeError here, after 'raw' was emitted (CNCjs quirk, kept).
    const result = this.parser.parse(data);

    if (isGrblLineParserResult(result, GrblLineParserResultStatus)) {
      const payload = result.payload;

      // Grbl v1.1
      // WCO:0.000,10.000,2.500
      // A current work coordinate offset is now sent to easily convert
      // between position vectors, where WPos = MPos - WCO for each axis.
      if (has(payload, 'mpos') && !has(payload, 'wpos')) {
        const wpos: AxisValues = payload.wpos = payload.wpos || {};
        // Status lists are capped at 6 values, so every key is an axis letter.
        for (const [axis, mpos] of Object.entries(payload.mpos || {}) as [keyof AxisValues, string][]) {
          const digits = decimalPlaces(mpos);
          const wco = this.axisOffset(payload.wco || this.state.status.wco, axis);
          wpos[axis] = (Number(mpos) - Number(wco)).toFixed(digits);
        }
      } else if (has(payload, 'wpos') && !has(payload, 'mpos')) {
        const mpos: AxisValues = payload.mpos = payload.mpos || {};
        for (const [axis, wpos] of Object.entries(payload.wpos || {}) as [keyof AxisValues, string][]) {
          const digits = decimalPlaces(wpos);
          const wco = this.axisOffset(payload.wco || this.state.status.wco, axis);
          mpos[axis] = (Number(wpos) + Number(wco)).toFixed(digits);
        }
      }

      // Grbl omits Pn: entirely when no pin is active, so a plain merge
      // keeps the previous value and a pin latches on for ever after one
      // trigger. Absence of the field is itself the "all clear", so it has
      // to be cleared explicitly rather than inherited.
      if (!has(payload, 'pinState')) {
        payload.pinState = '';
      }

      // Grbl reports A: only when it emits Ov: and an accessory is active.
      // Reports without Ov: do not contain a new accessory snapshot, so keep
      // the previous state. An Ov: report without A: is the all-off snapshot.
      if (has(payload, 'ov') && !has(payload, 'accessoryState')) {
        payload.accessoryState = '';
      }

      const status: GrblStatus & { raw?: string } = {
        ...this.state.status,
        ...payload
      };
      const nextState: GrblRunnerState = {
        ...this.state,
        status: status
      };

      // Delete the raw key
      delete status.raw;

      if (!_.isEqual(this.state.status, nextState.status)) {
        this.state = nextState; // enforce change
      }
      this.emit('status', payload);
      return;
    }
    if (isGrblLineParserResult(result, GrblLineParserResultOk)) {
      this.emit('ok', result.payload);
      return;
    }
    if (isGrblLineParserResult(result, GrblLineParserResultError)) {
      // https://nodejs.org/api/events.html#events_error_events
      // As a best practice, listeners should always be added for the 'error' events.
      this.emit('error', result.payload);
      return;
    }
    if (isGrblLineParserResult(result, GrblLineParserResultAlarm)) {
      const alarmPayload = {
        activeState: GRBL_ACTIVE_STATE_ALARM
      };
      const nextState: GrblRunnerState = {
        ...this.state,
        status: {
          ...this.state.status,
          ...alarmPayload
        }
      };
      if (!_.isEqual(this.state.status, nextState.status)) {
        this.state = nextState; // enforce change
      }
      this.emit('alarm', result.payload);
      return;
    }
    if (isGrblLineParserResult(result, GrblLineParserResultParserState)) {
      const { modal, tool, feedrate, spindle } = result.payload;
      const nextState: GrblRunnerState = {
        ...this.state,
        parserstate: {
          modal: modal,
          tool: tool,
          feedrate: feedrate,
          spindle: spindle
        }
      };
      if (!_.isEqual(this.state.parserstate, nextState.parserstate)) {
        this.state = nextState; // enforce change
      }
      this.emit('parserstate', result.payload);
      return;
    }
    if (isGrblLineParserResult(result, GrblLineParserResultParameters)) {
      const { name, value } = result.payload;
      const nextSettings: GrblSettings = {
        ...this.settings,
        parameters: {
          ...this.settings.parameters,
          [name]: value
        }
      };
      if (!_.isEqual(this.settings.parameters[name], nextSettings.parameters[name])) {
        this.settings = nextSettings; // enforce change
      }
      this.emit('parameters', result.payload);
      return;
    }
    if (isGrblLineParserResult(result, GrblLineParserResultFeedback)) {
      this.emit('feedback', result.payload);
      return;
    }
    if (isGrblLineParserResult(result, GrblLineParserResultSettings)) {
      const { name, value } = result.payload;
      const nextSettings: GrblSettings = {
        ...this.settings,
        settings: {
          ...this.settings.settings,
          [name]: value
        }
      };
      if (this.settings.settings[name] !== nextSettings.settings[name]) {
        this.settings = nextSettings; // enforce change
      }
      this.emit('settings', result.payload);
      return;
    }
    if (isGrblLineParserResult(result, GrblLineParserResultStartup)) {
      const { version } = result.payload;
      const nextSettings: GrblSettings = { // enforce change
        ...this.settings,
        version: version
      };
      if (!_.isEqual(this.settings.version, nextSettings.version)) {
        this.settings = nextSettings; // enforce change
      }
      this.emit('startup', result.payload);
      return;
    }
    // Unknown lines, and the Help/Version/Option/Echo results, which have no handler of their own.
    // `data` is never empty here (checked above), so this always emits.
    if (data.length > 0) {
      this.emit('others', result.payload);
      return;
    }
  }

  // Same as `_.get(offsets, axis, 0)`: 0 when there is no offset object or no value for the axis.
  private axisOffset(offsets: AxisValues | undefined, axis: keyof AxisValues): string | number {
    const value = offsets === undefined ? undefined : offsets[axis];
    return value === undefined ? 0 : value;
  }

  // The getters below take an optional state because GrblController also calls them with its own
  // copy of the last broadcast state, which starts out as `{}`.
  // Each `x === undefined ? default : x` is lodash `_.get(…, default)`: the default applies only
  // when the value is undefined.

  getMachinePosition(state: Partial<GrblRunnerState> = this.state): AxisValues {
    const mpos = state?.status?.mpos;
    return mpos === undefined ? {} : mpos;
  }

  getWorkPosition(state: Partial<GrblRunnerState> = this.state): AxisValues {
    const wpos = state?.status?.wpos;
    return wpos === undefined ? {} : wpos;
  }

  getModalGroup(state: Partial<GrblRunnerState> = this.state): NonNullable<GrblRunnerParserState['modal']> {
    const modal = state?.parserstate?.modal;
    return modal === undefined ? {} : modal;
  }

  getWorkCoordinateSystem(state: Partial<GrblRunnerState> = this.state): string | string[] {
    const defaultWCS = 'G54';
    const wcs = state?.parserstate?.modal?.wcs;
    return wcs === undefined ? defaultWCS : wcs;
  }

  getTool(state: Partial<GrblRunnerState> = this.state): number {
    return Number(state?.parserstate?.tool) || 0;
  }

  getParameters(): GrblSettings['parameters'] {
    const parameters = this.settings.parameters;
    return parameters === undefined ? {} : parameters;
  }

  isAlarm(): boolean {
    const activeState = this.state.status?.activeState;
    return activeState === GRBL_ACTIVE_STATE_ALARM;
  }

  isIdle(): boolean {
    const activeState = this.state.status?.activeState;
    return activeState === GRBL_ACTIVE_STATE_IDLE;
  }
}

export default GrblRunner;
