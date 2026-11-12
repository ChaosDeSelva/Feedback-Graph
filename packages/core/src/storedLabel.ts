/**
 * The entry for a value read back from the store, an import or another release. `map` covers every value this
 * release writes (Record<K, V> makes that a compile-time check); a value it no longer knows, from a row an older or
 * newer release wrote, gets `unknown(value)` instead of undefined.
 */
export function storedLabel<K extends string, V>(map: Record<K, V>, value: string, unknown: (value: string) => V): V {
  return Object.hasOwn(map, value) ? map[value as K] : unknown(value);
}
