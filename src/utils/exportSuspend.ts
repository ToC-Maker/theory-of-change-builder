// An export shows the whole chart as published, so selection and hover
// styling (the black ring, the faded nodes and connections, the connection
// glow) has to be gone from the DOM it captures. That styling is state owned
// by the canvas components; each registers how to clear its own and how to
// put it back, and `suspendForExport` runs them all.
//
// Kept out of `exportChart.ts` because the canvas imports it statically
// while `exportChart.ts` is only loaded when the user exports.
import { useEffect } from 'react';
import { flushSync } from 'react-dom';

/** Clears one component's selection and hover state; returns what puts the selection back. */
type Suspend = () => () => void;

const registered = new Set<Suspend>();

/**
 * Register `suspend` for exports while the calling component is mounted.
 * Re-registers after every render so the closure sees the current state.
 */
export function useSuspendForExport(suspend: Suspend): void {
  useEffect(() => {
    registered.add(suspend);
    return () => {
      registered.delete(suspend);
    };
  }, [suspend]);
}

/**
 * Clear every registered component's selection and hover state and commit it
 * before returning, so the DOM is already clean when the capture reads it.
 * The returned function restores the selection (hover follows the pointer, so
 * it is not restored).
 */
export function suspendForExport(): () => void {
  let restores: (() => void)[] = [];
  flushSync(() => {
    restores = [...registered].map((suspend) => suspend());
  });
  return () => flushSync(() => restores.forEach((restore) => restore()));
}
