// https://github.com/grbl/grbl/wiki/Interfacing-with-Grbl#feedback-messages

/** Payload of a `[…]` (v0.9) or `[MSG:…]` (v1.1) line. */
export interface GrblFeedbackPayload {
  message: string;
}

export interface GrblFeedbackResult {
  type: typeof GrblLineParserResultFeedback;
  payload: GrblFeedbackPayload;
}

class GrblLineParserResultFeedback {
  // Type-only brand: makes `typeof GrblLineParserResultFeedback` nominal so result unions narrow per class.
  declare private static readonly brand: 'Feedback';

  // * Grbl v0.9
  //   []
  // * Grbl v1.1
  //   [MSG:]
  static parse(line: string): GrblFeedbackResult | null {
    const r = line.match(/^\[(?:MSG:)?(.+)\]$/);
    if (!r) {
      return null;
    }

    const payload: GrblFeedbackPayload = {
      message: r[1]
    };

    return {
      type: GrblLineParserResultFeedback,
      payload: payload
    };
  }
}

export default GrblLineParserResultFeedback;
