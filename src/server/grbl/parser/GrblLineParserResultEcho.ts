/** Payload of a `[echo:…]` line. */
export interface GrblEchoPayload {
  message: string;
}

export interface GrblEchoResult {
  type: typeof GrblLineParserResultEcho;
  payload: GrblEchoPayload;
}

class GrblLineParserResultEcho {
  // Type-only brand: makes `typeof GrblLineParserResultEcho` nominal so result unions narrow per class.
  declare private static readonly brand: 'Echo';

  static parse(line: string): GrblEchoResult | null {
    // * Grbl v1.1
    //   [echo:]
    const r = line.match(/^\[(?:echo:)(.+)\]$/);
    if (!r) {
      return null;
    }

    const payload: GrblEchoPayload = {
      message: r[1]
    };

    return {
      type: GrblLineParserResultEcho,
      payload: payload
    };
  }
}

export default GrblLineParserResultEcho;
