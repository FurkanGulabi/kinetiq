// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects
// SECURITY (Kinetiq): Function and Object (in CNCjs) are left out: Function("...")() runs arbitrary
// code. See lib/evaluate-expression.js.
export const GLOBAL_OBJECTS = {
  // Function properties
  parseFloat,
  parseInt,

  // Fundamental objects
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

// Write Source
export const WRITE_SOURCE_CLIENT = 'client';
export const WRITE_SOURCE_SERVER = 'server';
export const WRITE_SOURCE_FEEDER = 'feeder';
export const WRITE_SOURCE_SENDER = 'sender';
