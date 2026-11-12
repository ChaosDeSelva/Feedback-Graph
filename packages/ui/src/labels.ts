/**
 * The entry of `map` (exhaustive over the values this release knows, so a new value is a compile error until it has one)
 * for a value the server sent; a value it does not know, such as a row stored by another release, gets `fallback(raw)`
 * instead of breaking the page. Only the map's own keys count: "constructor" is a value like any other.
 */
export function labelOf<K extends string, V>(map: Record<K, V>, value: K, fallback: (raw: string) => V): V {
  return Object.hasOwn(map, value) ? map[value] : fallback(value);
}

/** The raw value, as the label of one this release does not know. */
export const asIs = (raw: string) => raw;
