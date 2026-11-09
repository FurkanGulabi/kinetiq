/** Payload of a `[VER:…]` line. */
export interface GrblVersionPayload {
  message: string;
}

export interface GrblVersionResult {
  type: typeof GrblLineParserResultVersion;
  payload: GrblVersionPayload;
}

class GrblLineParserResultVersion {
  // Type-only brand: makes `typeof GrblLineParserResultVersion` nominal so result unions narrow per class.
  declare private static readonly brand: 'Version';

  static parse(line: string): GrblVersionResult | null {
    // * Grbl v1.1
    //   [VER:]
    const r = line.match(/^\[(?:VER:)(.+)\]$/);
    if (!r) {
      return null;
    }

    const payload: GrblVersionPayload = {
      message: r[1]
    };

    return {
      type: GrblLineParserResultVersion,
      payload: payload
    };
  }
}

export default GrblLineParserResultVersion;
