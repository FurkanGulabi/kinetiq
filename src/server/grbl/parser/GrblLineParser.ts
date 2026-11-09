import GrblLineParserResultStatus, { GrblStatusResult } from './GrblLineParserResultStatus';
import GrblLineParserResultOk, { GrblOkResult } from './GrblLineParserResultOk';
import GrblLineParserResultError, { GrblErrorResult } from './GrblLineParserResultError';
import GrblLineParserResultAlarm, { GrblAlarmResult } from './GrblLineParserResultAlarm';
import GrblLineParserResultParserState, { GrblParserStateResult } from './GrblLineParserResultParserState';
import GrblLineParserResultParameters, { GrblParametersResult } from './GrblLineParserResultParameters';
import GrblLineParserResultHelp, { GrblHelpResult } from './GrblLineParserResultHelp';
import GrblLineParserResultVersion, { GrblVersionResult } from './GrblLineParserResultVersion';
import GrblLineParserResultOption, { GrblOptionResult } from './GrblLineParserResultOption';
import GrblLineParserResultEcho, { GrblEchoResult } from './GrblLineParserResultEcho';
import GrblLineParserResultFeedback, { GrblFeedbackResult } from './GrblLineParserResultFeedback';
import GrblLineParserResultSettings, { GrblSettingsResult } from './GrblLineParserResultSettings';
import GrblLineParserResultStartup, { GrblStartupResult } from './GrblLineParserResultStartup';

/** A result class's `{ type, payload }` with the `raw` line GrblLineParser adds to every payload. */
type WithRaw<R extends { type: unknown; payload: object }> = R extends unknown
  ? { type: R['type']; payload: R['payload'] & { raw: string } }
  : never;

/** Returned for a line no result class recognised. */
export interface GrblUnknownResult {
  type: null;
  payload: { raw: string };
}

/**
 * Everything GrblLineParser.parse() can return. `type` is the result class itself (CNCjs style,
 * compared with `===`). A class reference is not a literal type, so `result.type === X` does not
 * narrow this union by itself; use `isGrblLineParserResult(result, X)` (or `type === null`) to
 * narrow, e.g.
 *
 *   if (isGrblLineParserResult(result, GrblLineParserResultStatus)) { result.payload.mpos … }
 */
export type GrblLineParserResult =
  | WithRaw<GrblStatusResult>
  | WithRaw<GrblOkResult>
  | WithRaw<GrblErrorResult>
  | WithRaw<GrblAlarmResult>
  | WithRaw<GrblParserStateResult>
  | WithRaw<GrblParametersResult>
  | WithRaw<GrblHelpResult>
  | WithRaw<GrblVersionResult>
  | WithRaw<GrblOptionResult>
  | WithRaw<GrblEchoResult>
  | WithRaw<GrblFeedbackResult>
  | WithRaw<GrblSettingsResult>
  | WithRaw<GrblStartupResult>
  | GrblUnknownResult;

/** The result classes (the possible non-null `type` values). */
export type GrblLineParserResultClass = NonNullable<GrblLineParserResult['type']>;

/** The member of GrblLineParserResult whose `type` is the given class. */
export type GrblLineParserResultOf<C extends GrblLineParserResultClass> = Extract<GrblLineParserResult, { type: C }>;

/** Type guard: `result.type === type`, narrowing the payload to that class's shape. */
export const isGrblLineParserResult = <C extends GrblLineParserResultClass>(
  result: GrblLineParserResult,
  type: C
): result is GrblLineParserResultOf<C> => {
  return result.type === type;
};

// Grbl v1.1
// https://github.com/gnea/grbl/blob/edge/doc/markdown/interface.md

class GrblLineParser {
  parse(line: string): GrblLineParserResult {
    const parsers = [
      // <>
      GrblLineParserResultStatus,

      // ok
      GrblLineParserResultOk,

      // error:x
      GrblLineParserResultError,

      // ALARM:
      GrblLineParserResultAlarm,

      // [G38.2 G54 G17 G21 G91 G94 M0 M5 M9 T0 F20. S0.] (v0.9)
      // [GC:G38.2 G54 G17 G21 G91 G94 M0 M5 M9 T0 F20. S0.] (v1.1)
      GrblLineParserResultParserState,

      // [G54:0.000,0.000,0.000]
      // [G55:0.000,0.000,0.000]
      // [G56:0.000,0.000,0.000]
      // [G57:0.000,0.000,0.000]
      // [G58:0.000,0.000,0.000]
      // [G59:0.000,0.000,0.000]
      // [G28:0.000,0.000,0.000]
      // [G30:0.000,0.000,0.000]
      // [G92:0.000,0.000,0.000]
      // [TLO:0.000]
      // [PRB:0.000,0.000,0.000:0]
      GrblLineParserResultParameters,

      // [HLP:] (v1.1)
      GrblLineParserResultHelp,

      // [VER:] (v1.1)
      GrblLineParserResultVersion,

      // [OPT:] (v1.1)
      GrblLineParserResultOption,

      // [echo:] (v1.1)
      GrblLineParserResultEcho,

      // [] (v0.9)
      // [MSG:] (v1.1)
      GrblLineParserResultFeedback,

      // $xx
      GrblLineParserResultSettings,

      // Grbl X.Xx ['$' for help]
      GrblLineParserResultStartup
    ];

    for (const parser of parsers) {
      const result = parser.parse(line);
      if (result) {
        // Same as CNCjs `_.set(result, 'payload.raw', line)`: mutate the payload so `raw` is its last key.
        Object.assign(result.payload, { raw: line });
        return result as GrblLineParserResult;
      }
    }

    return {
      type: null,
      payload: {
        raw: line
      }
    };
  }
}

export default GrblLineParser;
