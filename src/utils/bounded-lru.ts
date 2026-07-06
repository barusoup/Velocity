/** Touch a Set entry and evict the eldest when `maxSize` is exceeded. */
export function touchBoundedSet(set: Set<string>, key: string, maxSize: number): void {
  if (set.has(key)) set.delete(key);
  set.add(key);
  while (set.size > maxSize) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

/** Set a Map entry and evict the eldest key when `maxSize` is exceeded. */
export function setBoundedMapValue(
  map: Map<string, number>,
  key: string,
  value: number,
  maxSize: number,
): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}