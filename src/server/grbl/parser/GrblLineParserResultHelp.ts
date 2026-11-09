/** Payload of a `[HLP:…]` line. */
export interface GrblHelpPayload {
  message: string;
}

export interface GrblHelpResult {
  type: typeof GrblLineParserResultHelp;
  payload: GrblHelpPayload;
}

class GrblLineParserResultHelp {
  // Type-only brand: makes `typeof GrblLineParserResultHelp` nominal so result unions narrow per class.
  declare private static readonly brand: 'Help';

  static parse(line: string): GrblHelpResult | null {
    // * Grbl v1.1
    //   [HLP:]
    const r = line.match(/^\[(?:HLP:)(.+)\]$/);
    if (!r) {
      return null;
    }

    const payload: GrblHelpPayload = {
      message: r[1]
    };

    return {
      type: GrblLineParserResultHelp,
      payload: payload
    };
  }
}

export default GrblLineParserResultHelp;
