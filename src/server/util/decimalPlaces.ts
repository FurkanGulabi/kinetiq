/**
 * Number of decimal places of a number or numeric string, scientific notation included
 * (was src/server/cnc/lib/decimal-places.js, CNCjs).
 */
// http://stackoverflow.com/questions/10454518/javascript-how-to-retrieve-the-number-of-decimals-of-a-string-number
const decimalPlaces = (num: number | string): number => {
  const match = ('' + num).match(/(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) {
    return 0;
  }

  // Number of digits right of decimal point.
  const digits = match[1] ? match[1].length : 0;

  // Adjust for scientific notation.
  const E = match[2] ? (+match[2]) : 0;

  return Math.max(0, digits - E);
};

export default decimalPlaces;
