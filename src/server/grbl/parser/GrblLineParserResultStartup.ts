/** Payload of a startup banner line, e.g. "Grbl 3.7 [FluidNC v3.7.8 ...]". */
export interface GrblStartupPayload {
  /** First word, e.g. 'Grbl'. */
  firmware: string;
  /** e.g. '1.1h' or '3.7'. */
  version: string;
  /** The rest of the line from the first `[…]` on, trimmed; '' if absent. */
  message: string;
}

export interface GrblStartupResult {
  type: typeof GrblLineParserResultStartup;
  payload: GrblStartupPayload;
}

const pattern = new RegExp(/^([a-zA-Z0-9]+)\s+((?:\d+\.){1,2}\d+[a-zA-Z0-9\-\.]*)([^\[]*\[[^\]]+\].*)?/);

class GrblLineParserResultStartup {
  // Type-only brand: makes `typeof GrblLineParserResultStartup` nominal so result unions narrow per class.
  declare private static readonly brand: 'Startup';

  // Grbl 0.9j ['$' for help]
  // Grbl 1.1d ['$' for help]
  // Grbl 1.1
  // Grbl 1.1h: LongMill build ['$' for help]
  // Grbl 1.1h ['$' for help] LongMill build Feb 25, 2020
  // gCarvin 2.0.0 ['$' for help]
  static parse(line: string): GrblStartupResult | null {
    const r = line.match(pattern);
    if (!r) {
      return null;
    }

    const firmware = r[1];
    const version = r[2];
    // The optional group is undefined when there is no `[…]`; lodash `_.trim(undefined)` gave ''.
    const message = (r[3] ?? '').trim();

    const payload: GrblStartupPayload = {
      firmware,
      version,
      message,
    };

    return {
      type: GrblLineParserResultStartup,
      payload: payload
    };
  }
}

export default GrblLineParserResultStartup;
