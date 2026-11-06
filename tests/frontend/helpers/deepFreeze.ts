// Freezes a fixture so an updater that writes into the state it was
// handed throws instead of silently rewriting App's undo snapshot.
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
