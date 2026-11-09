/**
 * JSON.stringify() that returns undefined instead of throwing
 * (was src/server/cnc/lib/json-stringify.js, CNCjs; imported as `x` in log lines).
 */
type Replacer = ((this: unknown, key: string, value: unknown) => unknown) | (number | string)[] | null;

const jsonStringify = (...args: [value?: unknown, replacer?: Replacer, space?: string | number]): string | undefined => {
  let x: string | undefined;
  try {
    x = (JSON.stringify as (...a: typeof args) => string | undefined)(...args);
  } catch (e) {
    // JSON.stringify() throws an error when it detects a cyclical object. In other words, if an object obj has a property whose value is obj, JSON.stringify() will throw an erro
  }
  return x;
};

export default jsonStringify;
