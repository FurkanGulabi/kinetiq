import type { AxisValues, ProbeParameter } from '../../protocol';
import { assignAxes } from './axes';

export type GrblCoordinateParameterName = 'G54' | 'G55' | 'G56' | 'G57' | 'G58' | 'G59' | 'G28' | 'G30' | 'G92';

/** Payload of a `[NAME:…]` line from `$#` or a probe cycle; see GrblParameters in protocol.ts. */
export type GrblParametersPayload =
  // [G54:0.000,0.000,0.000] → { x: '0.000', y: '0.000', z: '0.000' }
  | { name: GrblCoordinateParameterName; value: AxisValues }
  // [TLO:0.000] → '0.000'
  | { name: 'TLO'; value: string }
  // [PRB:0.000,0.000,1.492:1] → { result: 1, x: '0.000', y: '0.000', z: '1.492' }
  // `result` is NaN when the `:n` suffix is missing.
  | { name: 'PRB'; value: ProbeParameter };

export type GrblParameterName = GrblParametersPayload['name'];

export interface GrblParametersResult {
  type: typeof GrblLineParserResultParameters;
  payload: GrblParametersPayload;
}

class GrblLineParserResultParameters {
  // Type-only brand: makes `typeof GrblLineParserResultParameters` nominal so result unions narrow per class.
  declare private static readonly brand: 'Parameters';

  static parse(line: string): GrblParametersResult | null {
    const r = line.match(/^\[(G54|G55|G56|G57|G58|G59|G28|G30|G92|TLO|PRB):(.+)\]$/);
    if (!r) {
      return null;
    }

    // The regex alternation guarantees the name.
    const name = r[1] as GrblParameterName;
    const value = r[2];

    // CNCjs built `{ name, value: '' }` and then overwrote `value` in the branch matching the name.
    // Every name matches exactly one branch, so the '' placeholder was never returned.

    // [Gxx:0.000]
    const re = /^G\d+$/i;
    if (re.test(name)) {
      const list = value.split(',');
      return {
        type: GrblLineParserResultParameters,
        payload: {
          name: name as GrblCoordinateParameterName,
          value: assignAxes({}, list)
        }
      };
    }

    // [TLO:0.000]
    if (name === 'TLO') {
      return {
        type: GrblLineParserResultParameters,
        payload: {
          name: name,
          value: value
        }
      };
    }

    // [PRB:0.000,0.000,1.492:1]
    const [str, result] = value.split(':');
    const list = str.split(',');
    // `result` is set first so it stays the first key, as in CNCjs.
    const probe = assignAxes({ result: Number(result) }, list);

    return {
      type: GrblLineParserResultParameters,
      payload: {
        name: 'PRB',
        value: probe
      }
    };
  }
}

export default GrblLineParserResultParameters;
