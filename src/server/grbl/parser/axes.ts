import type { AxisValues } from '../../protocol';

const AXES = ['x', 'y', 'z', 'a', 'b', 'c'];

/**
 * Maps a split coordinate list onto x, y, z, a, b, c in order, keeping the strings as printed.
 * Like the CNCjs loops this replaces, a 7th+ value lands under the key 'undefined'
 * (`obj[axes[6]]`); the status-report regex caps lists at 6, `[Gxx:…]` parameters don't.
 */
export const assignAxes = <T extends object>(target: T, list: readonly string[]): T & AxisValues => {
  const out: Record<string, unknown> = target as Record<string, unknown>;
  for (let i = 0; i < list.length; ++i) {
    out[String(AXES[i])] = list[i];
  }
  return target as T & AxisValues;
};
