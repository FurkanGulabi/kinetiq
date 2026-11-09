/**
 * CNCjs builtin commands (`%msg`, `%wait`) and G-code word helpers used while streaming.
 *
 * Ported from CNCjs 1.11.5:
 * - src/server/cnc/controllers/utils/builtin-command.js -> matchBuiltinCommand (was `match`)
 * - src/server/cnc/controllers/utils/gcode.js           -> isM0, isM1, isM6, isM109, isM190,
 *                                                          replaceCommands, replaceM6
 */
import {
  BUILTIN_COMMAND_MSG,
  BUILTIN_COMMAND_WAIT,
} from '../constants';

/*
 * Builtin commands
 */

/**
 * Matches a builtin command at the start of `line` (case-insensitive, `;` comment stripped).
 * Returns `[command, rest]` with the command lowercased, e.g. `['%msg', 'Hello']`, or null.
 */
export const matchBuiltinCommand = (line: unknown): [string, string] | null => {
  // Strip anything after a semi-colon to the end of the line
  const strippedLine = ((line === undefined || line === null) ? '' : String(line)).replace(/;.*$/, '').trim();
  const cmds = [BUILTIN_COMMAND_MSG, BUILTIN_COMMAND_WAIT];
  const re = new RegExp(`^(${cmds.join('|')})\\b`, 'i');
  const match = strippedLine.match(re);
  if (!match) {
    return null;
  }
  const command = match[1].toLowerCase();
  const rest = strippedLine.slice(match[0].length).trim();
  return [command, rest];
};

/*
 * G-code words
 */

export const isM0 = (x: string): boolean => {
  const pattern = /^M0*0$/i; // matches 'M0', 'M00', 'm0', 'm00', and 'M000' (case-insensitive)
  return pattern.test(x);
};

export const isM1 = (x: string): boolean => {
  const pattern = /^M0*1$/i; // matches 'M1', 'M01', 'm1', 'm01', and 'M001' (case-insensitive)
  return pattern.test(x);
};

export const isM6 = (x: string): boolean => {
  const pattern = /^M0*6$/i; // matches 'M6', 'M06', 'm6', 'm06', and 'M006' (case-insensitive)
  return pattern.test(x);
};

export const isM109 = (x: string): boolean => {
  const pattern = /^M0*109$/i;
  return pattern.test(x);
};

export const isM190 = (x: string): boolean => {
  const pattern = /^M0*190$/i;
  return pattern.test(x);
};

/**
 * Calls `callback` for every occurrence of one of `commands` (regex sources, case-insensitive) and
 * substitutes its return value (`null`/`undefined` keeps the original text).
 */
export const replaceCommands = (
  gcode: string,
  commands: string | string[] | null | undefined,
  callback?: (command: string) => string | null | undefined,
): string => {
  const list = (commands === undefined || commands === null) ? [] : (Array.isArray(commands) ? commands : [commands]);
  if (!list.length) {
    return gcode; // Return original if no commands are provided
  }

  const lines = gcode.split('\n');
  const re = new RegExp(`(\\d|\\b)(${list.join('|')})(\\b|[a-zA-Z])`, 'gi');

  const updatedLines = lines.map(line => {
    return line.replace(re, (match: string, p1: string, p2: string, p3: string) => {
      const replacement = (typeof callback === 'function') ? callback(p2) ?? p2 : p2;
      return `${p1}${replacement}${p3}`;
    });
  });

  return updatedLines.join('\n');
};

export const replaceM6 = (gcode: string, callback?: (command: string) => string | null | undefined): string => {
  // M6, M06, m6, m06, and M006 all refer to the same command "M6"
  return replaceCommands(gcode, ['M0*6'], callback);
};
