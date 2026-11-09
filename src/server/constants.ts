/**
 * Backend-wide constants (was src/server/cnc/controllers/constants.js, CNCjs).
 */

/**
 * Globals the CNCjs macro language may reference inside `[expr]` / `%var=` (streaming expressions).
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects
 */
export const GLOBAL_OBJECTS = {
  // Function properties
  parseFloat,
  parseInt,

  // Fundamental objects
  Object,
  Function,
  Boolean,

  // Numbers and dates
  Number,
  Math,
  Date,

  // Text processing
  String,
  RegExp,

  // Structured data
  JSON,
};

// Builtin Commands
export const BUILTIN_COMMAND_MSG = '%msg';
export const BUILTIN_COMMAND_WAIT = '%wait';

// Units
export const IMPERIAL_UNITS = 'in';
export const METRIC_UNITS = 'mm';

// Write Source: who wrote a line to the serial port (sent along in `serialport:write` contexts).
export const WRITE_SOURCE_CLIENT = 'client';
export const WRITE_SOURCE_SERVER = 'server';
export const WRITE_SOURCE_FEEDER = 'feeder';
export const WRITE_SOURCE_SENDER = 'sender';

export type WriteSource =
  | typeof WRITE_SOURCE_CLIENT
  | typeof WRITE_SOURCE_SERVER
  | typeof WRITE_SOURCE_FEEDER
  | typeof WRITE_SOURCE_SENDER;
