/* eslint no-bitwise: ["error", { "allow": ["&", "<<"] }] */
import type { AxisValues } from '../../protocol';
import { assignAxes } from './axes';

/**
 * Payload of a `<…>` status report. Only `activeState` and `subState` are always set; the other
 * fields appear only when the report contained the matching field. GrblRunner merges this into
 * GrblStatus (protocol.ts).
 */
export interface GrblStatusPayload {
  /** e.g. 'Idle', 'Run', 'Hold'; '' if the report had no leading word. */
  activeState: string;
  /**
   * `Number()` of the text after the colon: 0 without a suffix (`Number('')`), NaN for a malformed
   * suffix such as 'Hold:1,2' or 'Door:-'.
   */
  subState: number;
  /** MPos (strings as printed). */
  mpos?: AxisValues;
  /** WPos (strings as printed). */
  wpos?: AxisValues;
  /** WCO (strings as printed). */
  wco?: AxisValues;
  /** Buf:/RX: (v0.9) set one each, Bf: (v1.1) sets both. */
  buf?: { planner?: number; rx?: number };
  /** Ln: */
  ln?: number;
  /** F: or FS: */
  feedrate?: number;
  /** FS: */
  spindle?: number;
  /** Lim: (v0.9, decoded to letters) or Pn: (v1.1). */
  pinState?: string;
  /** Ov: as numbers. */
  ov?: number[];
  /** A: */
  accessoryState?: string;
}

export interface GrblStatusResult {
  type: typeof GrblLineParserResultStatus;
  payload: GrblStatusPayload;
}

// Replaces lodash `_.get(result, 'Name[i]', defaultValue)`: the default applies only when the
// element is missing (undefined), as with `_.get`.
const at = <D>(list: readonly string[], i: number, defaultValue: D): string | D => {
  const value = list[i];
  return value === undefined ? defaultValue : value;
};

//https://github.com/grbl/grbl/blob/master/grbl/report.c
class GrblLineParserResultStatus {
  // Type-only brand: makes `typeof GrblLineParserResultStatus` nominal so result unions narrow per class.
  declare private static readonly brand: 'Status';

  // * Grbl v0.9
  //   <Idle>
  //   <Idle,MPos:5.529,0.560,7.000,WPos:1.529,-5.440,-0.000>
  //   <Idle,MPos:5.529,0.560,7.000,0.000,WPos:1.529,-5.440,-0.000,0.000>
  //   <Idle,MPos:0.000,0.000,0.000,WPos:0.000,0.000,0.000,Buf:0,RX:0,Lim:000>
  //   <Idle,MPos:0.000,0.000,0.000,WPos:0.000,0.000,0.000,Buf:0,RX:0,Ln:0,F:0.>
  // * Grbl v1.1
  //   <Idle|MPos:3.000,2.000,0.000|FS:0,0>
  //   <Hold:0|MPos:5.000,2.000,0.000|FS:0,0>
  //   <Idle|MPos:5.000,2.000,0.000|FS:0,0|Ov:100,100,100>
  //   <Idle|MPos:5.000,2.000,0.000|FS:0,0|WCO:0.000,0.000,0.000>
  //   <Run|MPos:23.036,1.620,0.000|FS:500,0>
  static parse(line: string): GrblStatusResult | null {
    const r = line.match(/^<(.+)>$/);
    if (!r) {
      return null;
    }

    // Pn: and A: are v1.1 pipe-delimited fields with letter values. Keep the
    // legacy numeric branch unchanged so v0.9 comma-separated fields, such as
    // MPos:..,WPos:.., continue to split at their field boundary.
    const pattern = /(?<=\|)(?:Pn|A):[a-zA-Z]+(?=\||$)|[a-zA-Z]+(:[0-9\.\-]+(,[0-9\.\-]+){0,5})?/g;
    // A report without any letter (e.g. '<123>') matches nothing; CNCjs then threw a TypeError on
    // `params.shift()`, and so does this (the cast keeps that crash rather than hiding it).
    const params = r[1].match(pattern) as RegExpMatchArray;
    // Field name → comma-split values. A null-prototype map so `hasOwn` mirrors lodash `_.has`.
    const result: Record<string, string[]> = Object.create(null);

    // Active State (v0.9, v1.1)
    // * Valid states types: Idle, Run, Hold, Jog, Alarm, Door, Check, Home, Sleep
    // * Sub-states may be included via : a colon delimiter and numeric code.
    // * Current sub-states are:
    //   - Hold:0 Hold complete. Ready to resume.
    //   - Hold:1 Hold in-progress. Reset will throw an alarm.
    //   - Door:0 Door closed. Ready to resume.
    //   - Door:1 Machine stopped. Door still ajar. Can't resume until closed.
    //   - Door:2 Door opened. Hold (or parking retract) in-progress. Reset will throw an alarm.
    //   - Door:3 Door closed and resuming. Restoring from park, if applicable. Reset will throw an alarm.
    const states = (params.shift() || '').split(':');
    const payload: GrblStatusPayload = {
      activeState: states[0] || '',
      subState: Number(states[1] || '')
    };

    for (const param of params) {
      const nv = param.match(/^(.+):(.+)/);
      if (nv) {
        const type = nv[1];
        const value = nv[2].split(',');
        result[type] = value;
      }
    }

    const has = (name: string): boolean => Object.prototype.hasOwnProperty.call(result, name);

    // Machine Position (v0.9, v1.1)
    if (has('MPos')) {
      payload.mpos = assignAxes({}, result.MPos);
    }

    // Work Position (v0.9, v1.1)
    if (has('WPos')) {
      payload.wpos = assignAxes({}, result.WPos);
    }

    // Work Coordinate Offset (v1.1)
    if (has('WCO')) {
      payload.wco = assignAxes({}, result.WCO);
    }

    // Planner Buffer (v0.9)
    if (has('Buf')) {
      payload.buf = payload.buf || {};
      payload.buf.planner = Number(at(result.Buf, 0, 0));
    }

    // RX Buffer (v0.9)
    if (has('RX')) {
      payload.buf = payload.buf || {};
      payload.buf.rx = Number(at(result.RX, 0, 0));
    }

    // Buffer State (v1.1)
    // Bf:15,128. The first value is the number of available blocks in the planner buffer and the second is number of available bytes in the serial RX buffer.
    if (has('Bf')) {
      payload.buf = payload.buf || {};
      payload.buf.planner = Number(at(result.Bf, 0, 0));
      payload.buf.rx = Number(at(result.Bf, 1, 0));
    }

    // Line Number (v0.9, v1.1)
    // Ln:99999 indicates line 99999 is currently being executed.
    if (has('Ln')) {
      payload.ln = Number(at(result.Ln, 0, 0));
    }

    // Feed Rate (v0.9, v1.1)
    // F:500 contains real-time feed rate data as the value.
    // This appears only when VARIABLE_SPINDLE is disabled.
    if (has('F')) {
      payload.feedrate = Number(at(result.F, 0, 0));
    }

    // Current Feed and Speed (v1.1)
    // FS:500,8000 contains real-time feed rate, followed by spindle speed, data as the values.
    if (has('FS')) {
      payload.feedrate = Number(at(result.FS, 0, 0));
      payload.spindle = Number(at(result.FS, 1, 0));
    }

    // Limit Pins (v0.9)
    // X_AXIS is (1<<0) or bit 0
    // Y_AXIS is (1<<1) or bit 1
    // Z_AXIS is (1<<2) or bit 2
    if (has('Lim')) {
      const value = Number(at(result.Lim, 0, 0));
      payload.pinState = [
        (value & (1 << 0)) ? 'X' : '',
        (value & (1 << 1)) ? 'Y' : '',
        (value & (1 << 2)) ? 'Z' : '',
        // CNCjs tests bit 2 again for A (so A always follows Z); kept as-is.
        (value & (1 << 2)) ? 'A' : ''
      ].join('');
    }

    // Input Pin State (v1.1)
    // * Pn:XYZPDHRS indicates which input pins Grbl has detected as 'triggered'.
    // * Each letter of XYZPDHRS denotes a particular 'triggered' input pin.
    //   - X Y Z XYZ limit pins, respectively
    //   - P the probe pin.
    //   - D H R S the door, hold, soft-reset, and cycle-start pins, respectively.
    //   - Example: Pn:PZ indicates the probe and z-limit pins are 'triggered'.
    //   - Note: A may be added in later versions for an A-axis limit pin.
    if (has('Pn')) {
      payload.pinState = at(result.Pn, 0, '');
    }

    // Override Values (v1.1)
    // Ov:100,100,100 indicates current override values in percent of programmed values for feed, rapids, and spindle speed, respectively.
    if (has('Ov')) {
      payload.ov = result.Ov.map(v => Number(v));
    }

    // Accessory State (v1.1)
    // * A:SFM indicates the current state of accessory machine components, such as the spindle and coolant.
    // * Each letter after A: denotes a particular state. When it appears, the state is enabled. When it does not appear, the state is disabled.
    //   - S indicates spindle is enabled in the CW direction. This does not appear with C.
    //   - C indicates spindle is enabled in the CCW direction. This does not appear with S.
    //   - F indicates flood coolant is enabled.
    //   - M indicates mist coolant is enabled.
    if (has('A')) {
      payload.accessoryState = at(result.A, 0, '');
    }

    return {
      type: GrblLineParserResultStatus,
      payload: payload
    };
  }
}

export default GrblLineParserResultStatus;
