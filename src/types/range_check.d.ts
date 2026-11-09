// Minimal typings for range_check@1.4 (CommonJS: `module.exports = { inRange, ... }`), covering the
// inRange() call the socket handshake makes (src/server/session.ts authorizeIPAddress).
declare module 'range_check' {
  const rangeCheck: {
    /**
     * true if `addr` is inside `range` ('10.0.0.0/8', a single address, or a list of either).
     * An unparsable address or range gives false; it never throws.
     */
    inRange(addr: string, range: string | string[]): boolean;
  };

  export = rangeCheck;
}
