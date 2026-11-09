/**
 * Resolves with `v` after `t` milliseconds (was src/server/cnc/lib/delay.js, CNCjs).
 */
function delay(t: number): Promise<undefined>;
function delay<T>(t: number, v: T): Promise<T>;
function delay<T>(t: number, v?: T): Promise<T | undefined> {
  return new Promise<T | undefined>(resolve => {
    setTimeout(resolve.bind(null, v), t);
  });
}

export default delay;
