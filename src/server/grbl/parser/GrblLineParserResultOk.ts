/** Payload of an `ok` line (empty; GrblLineParser adds `raw`). */
export type GrblOkPayload = Record<never, never>;

export interface GrblOkResult {
  type: typeof GrblLineParserResultOk;
  payload: GrblOkPayload;
}

class GrblLineParserResultOk {
  // Type-only brand: makes `typeof GrblLineParserResultOk` nominal so result unions narrow per class.
  declare private static readonly brand: 'Ok';

  static parse(line: string): GrblOkResult | null {
    const r = line.match(/^ok$/);
    if (!r) {
      return null;
    }

    const payload: GrblOkPayload = {};

    return {
      type: GrblLineParserResultOk,
      payload: payload
    };
  }
}

export default GrblLineParserResultOk;
