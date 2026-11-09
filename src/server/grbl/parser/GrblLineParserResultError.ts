// https://github.com/grbl/grbl/wiki/Interfacing-with-Grbl#grbl-response-meanings
/** Payload of a `error:x` line. */
export interface GrblErrorPayload {
  message: string;
}

export interface GrblErrorResult {
  type: typeof GrblLineParserResultError;
  payload: GrblErrorPayload;
}

class GrblLineParserResultError {
  // Type-only brand: makes `typeof GrblLineParserResultError` nominal so result unions narrow per class.
  declare private static readonly brand: 'Error';

  static parse(line: string): GrblErrorResult | null {
    const r = line.match(/^error:\s*(.+)$/);
    if (!r) {
      return null;
    }

    const payload: GrblErrorPayload = {
      message: r[1]
    };

    return {
      type: GrblLineParserResultError,
      payload: payload
    };
  }
}

export default GrblLineParserResultError;
