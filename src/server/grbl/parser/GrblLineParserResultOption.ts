/** Payload of a `[OPT:…]` line. */
export interface GrblOptionPayload {
  message: string;
}

export interface GrblOptionResult {
  type: typeof GrblLineParserResultOption;
  payload: GrblOptionPayload;
}

class GrblLineParserResultOption {
  // Type-only brand: makes `typeof GrblLineParserResultOption` nominal so result unions narrow per class.
  declare private static readonly brand: 'Option';

  static parse(line: string): GrblOptionResult | null {
    // * Grbl v1.1
    //   [OPT:]
    const r = line.match(/^\[(?:OPT:)(.+)\]$/);
    if (!r) {
      return null;
    }

    const payload: GrblOptionPayload = {
      message: r[1]
    };

    return {
      type: GrblLineParserResultOption,
      payload: payload
    };
  }
}

export default GrblLineParserResultOption;
