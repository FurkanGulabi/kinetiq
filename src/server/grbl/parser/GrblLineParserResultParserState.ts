import {
  GRBL_MODAL_GROUPS,
  GrblModalGroupName
} from '../constants';

/**
 * Payload of a `$G` reply. Only the fields present in the line are set. A modal group holds one
 * word, or an array when the line contained several words of that group (e.g. 'M7 M8' →
 * coolant: ['M7', 'M8']); this can happen for any group, not only coolant.
 */
export interface GrblParserStatePayload {
  modal?: Partial<Record<GrblModalGroupName, string | string[]>>;
  /** Tool number without the T, e.g. '0'. */
  tool?: string;
  /** Programmed feed without the F, e.g. '500.0'. */
  feedrate?: string;
  /** Programmed spindle speed without the S, e.g. '0.0'. */
  spindle?: string;
}

export interface GrblParserStateResult {
  type: typeof GrblLineParserResultParserState;
  payload: GrblParserStatePayload;
}

class GrblLineParserResultParserState {
  // Type-only brand: makes `typeof GrblLineParserResultParserState` nominal so result unions narrow per class.
  declare private static readonly brand: 'ParserState';

  // * Grbl v0.9 output format:
  //   ```
  //   [G38.2 G54 G17 G21 G91 G94 M0 M5 M9 T0 F20. S0.]
  //   ```
  // * Grbl v1.x output format:
  //   ```
  //   [GC:G0 G54 G17 G21 G90 G94 M0 M5 M9 T0 S0.0 F500.0]
  //   ```
  // * Some Grbl v1.x forks with incorrect parser state output:
  //   ```
  //   [GC:G0 G54 G17 G21 G90 G94 M5 M M9 T0 F0 S0]
  //   [GC:G0 G54 G17 G21 G90 G94 M5 M9 T F0 S0]
  //   ```
  static parse(line: string): GrblParserStateResult | null {
    const parseLine = (line: string): RegExpMatchArray | null => {
      const patterns = [
        // Matches standard output for Grbl v0.9 and v1.x
        /^\[(?:GC:)?((?:[GMTFS]\d+(?:\.\d*)?\s+)+(?:[GMTFS]\d+(?:\.\d*)?))\]$/,
        // Matches some Grbl v1.x forks with incorrect parser state output
        /^\[GC:((?:[GMTFS]\d*(?:\.\d*)?\s+)+(?:[GMTFS]\d+(?:\.\d*)?))\]$/
      ];
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
          return match;
        }
      }
      return null;
    };

    const r = parseLine(line);
    if (!r) {
      return null;
    }

    const payload: GrblParserStatePayload = {};
    // lodash `_.compact` (drops the '' between repeated spaces) + `_.trim`
    const words = r[1].split(' ')
      .filter((word) => word !== '')
      .map((word) => {
        return word.trim();
      });

    for (let i = 0; i < words.length; ++i) {
      const word = words[i];

      if (word.length <= 1) {
        // Skipping invalid fields like "M" or "T" without numeric values
        continue;
      }

      // Gx, Mx
      if (word.indexOf('G') === 0 || word.indexOf('M') === 0) {
        const r = GRBL_MODAL_GROUPS.find((group) => {
          return (group.modes as readonly string[]).includes(word);
        });

        if (!r) {
          continue;
        }

        // `modal` is created on first use, so its key position follows the word order (as `_.set` did).
        const modal = payload.modal || (payload.modal = {});
        const prevWord = modal[r.group] || '';
        if (prevWord) {
          // ensure-type `ensureArray(prevWord).concat(word)`
          modal[r.group] = (Array.isArray(prevWord) ? prevWord : [prevWord]).concat(word);
        } else {
          modal[r.group] = word;
        }

        continue;
      }

      // T: tool number
      if (word.indexOf('T') === 0) {
        payload.tool = word.substring(1);
        continue;
      }

      // F: feed rate
      if (word.indexOf('F') === 0) {
        payload.feedrate = word.substring(1);
        continue;
      }

      // S: spindle speed
      if (word.indexOf('S') === 0) {
        payload.spindle = word.substring(1);
        continue;
      }
    }

    return {
      type: GrblLineParserResultParserState,
      payload: payload
    };
  }
}

export default GrblLineParserResultParserState;
