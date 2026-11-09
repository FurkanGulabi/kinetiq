// https://github.com/grbl/grbl/wiki/Interfacing-with-Grbl#alarms
/** Payload of a `ALARM:x` line. */
export interface GrblAlarmPayload {
  message: string;
}

export interface GrblAlarmResult {
  type: typeof GrblLineParserResultAlarm;
  payload: GrblAlarmPayload;
}

class GrblLineParserResultAlarm {
  // Type-only brand: makes `typeof GrblLineParserResultAlarm` nominal so result unions narrow per class.
  declare private static readonly brand: 'Alarm';

  static parse(line: string): GrblAlarmResult | null {
    const r = line.match(/^ALARM:\s*(.+)$/);
    if (!r) {
      return null;
    }

    const payload: GrblAlarmPayload = {
      message: r[1]
    };

    return {
      type: GrblLineParserResultAlarm,
      payload: payload
    };
  }
}

export default GrblLineParserResultAlarm;
