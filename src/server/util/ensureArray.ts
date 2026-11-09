/**
 * Plain-TS copy of ensure-type's `ensureArray(value)` with its default value `[]`, as CNCjs used it:
 * null/undefined become [], an array is returned as is, anything else is wrapped by [].concat(value).
 */
const ensureArray = <T>(value: T | T[] | null | undefined): T[] => {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : ([] as T[]).concat(value);
};

export default ensureArray;
