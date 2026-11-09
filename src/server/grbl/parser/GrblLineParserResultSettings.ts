/** Payload of a `$n=value (message)` line. */
export interface GrblSettingsPayload {
  /** Setting name including the `$`, e.g. '$13'. */
  name: string;
  /** Value as printed, e.g. '0'. */
  value: string;
  /** Trailing text with surrounding parentheses stripped; '' if none. */
  message: string;
}

export interface GrblSettingsResult {
  type: typeof GrblLineParserResultSettings;
  payload: GrblSettingsPayload;
}

// Same as lodash `_.trim(str, '()')`: strip any run of '(' / ')' from both ends.
const trimParens = (str: string): string => str.replace(/^[()]+/, '').replace(/[()]+$/, '');

class GrblLineParserResultSettings {
  // Type-only brand: makes `typeof GrblLineParserResultSettings` nominal so result unions narrow per class.
  declare private static readonly brand: 'Settings';

  static parse(line: string): GrblSettingsResult | null {
    const r = line.match(/^(\$[^=]+)=([^ ]*)\s*(.*)/);
    if (!r) {
      return null;
    }

    const payload: GrblSettingsPayload = {
      name: r[1],
      value: r[2],
      message: trimParens(r[3])
    };

    return {
      type: GrblLineParserResultSettings,
      payload: payload
    };
  }
}

export default GrblLineParserResultSettings;
